import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  Input,
  Money,
  MoneyField,
  Ref,
  Select,
  shortRef,
  Table,
  Textarea,
  formatInstant,
  formatDate,
  hueVar,
  renderSection,
  type Column,
  type Section
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { PERM, labelIn, reconHeadline, statementFromCsv, type StatementLine } from "./ledger.shared";

// A reconciliation run is arithmetic; deciding a match is a judgement. The
// judgement carries a name and a reason onto the record, so the decide control
// asks for the reason in the same breath as the decision.

const PROCESSES = ["insurer", "psp", "client_money", "partner", "media"] as const;

interface ReconRun {
  id: string;
  process: string;
  period: string;
  currency: string;
  state: string;
  matchedCount: number;
  varianceCount: number;
  varianceMinor: number;
  counterpartyRef: string | null;
  createdAt: number;
}

interface ReconSummary {
  runId: string;
  process: string;
  period: string;
  state: string;
  matchedCount: number;
  varianceCount: number;
  varianceMinor: number;
  currency: string;
  open: number;
}

interface ReconMatch {
  id: string;
  runId: string;
  statementLineRef: string | null;
  txnId: string | null;
  amountMinor: number;
  currency: string;
  deltaMinor: number;
  method: string;
  confidence: number | null;
  state: string;
  reasonCode: string | null;
  confirmedBy: string | null;
  confirmedAt: number | null;
}

/**
 * Mirrors `POST /recon/runs/:id/evidence-bundle` in
 * apps/api/src/routes/ledger.ts — read that route, not this comment, before
 * changing the shape. `scopeJson`/`manifestJson` are the stored raw strings;
 * this screen only ever reads the already-parsed `manifest`.
 */
interface EvidenceManifestFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface EvidenceManifest {
  version: number;
  tenantId: string;
  generatedAt: number;
  requestedBy: string;
  scope: { runId: string; process: string; period: string; purpose: string };
  files: EvidenceManifestFile[];
}

interface EvidenceBundle {
  id: string;
  purpose: string;
  bundleHash: string;
  fileId: string | null;
  requestedBy: string;
  state: string;
  deliveredTo: string | null;
  createdAt: number;
  manifest: EvidenceManifest;
}

async function soft<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);

  if (!held.has(PERM.reconRead) && !held.has(PERM.reconRun)) {
    return { denied: true as const, permission: PERM.reconRead };
  }

  const runId = new URL(request.url).searchParams.get("run") ?? "";
  const currency = typeof me.policy.currency === "string" ? me.policy.currency : "";

  const [summary, matches, runs] = await Promise.all([
    runId && held.has(PERM.reconRead)
      ? soft(api<ReconSummary>(`/v1/ledger/recon/runs/${encodeURIComponent(runId)}`, { env, request }))
      : Promise.resolve(null),
    runId && held.has(PERM.reconRead)
      ? soft(
          api<{ data: ReconMatch[] }>(
            `/v1/ledger/recon-matches?runId=${encodeURIComponent(runId)}&sort=createdAt&order=asc&limit=200`,
            { env, request }
          )
        )
      : Promise.resolve(null),
    held.has(PERM.reconRead)
      ? soft(
          api<{ data: ReconRun[] }>("/v1/ledger/recon-runs?sort=createdAt&order=desc&limit=10", {
            env,
            request
          })
        )
      : Promise.resolve(null)
  ]);

  return {
    denied: false as const,
    runId,
    currency,
    summary,
    matches: matches?.data ?? [],
    runs: runs?.data ?? [],
    canRun: held.has(PERM.reconRun),
    canDecide: held.has(PERM.reconConfirm),
    // A write-off is an ordinary transaction, so it is the transaction
    // endpoint's gate that decides: `ledger:txns:create`, or `journals:draft`
    // alone, which may originate a type that cannot settle without a second
    // seat — and RECON-WRITEOFF is dual control always (apps/api routes/ledger.ts).
    canWriteOff: held.has(PERM.txnsCreate) || held.has(PERM.journalsDraft),
    canExport: held.has(PERM.reconExport),
    apiOrigin: env.API_ORIGIN
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const empty = {
    problem: null,
    started: null,
    decided: null,
    closed: null as ReconSummary | null,
    wroteOff: null as { id: string; state: string } | null,
    /** The policy key a write-off is waiting on, when the gate held it. */
    approval: null as string | null,
    rejected: [] as Array<{ row: number; text: string }>,
    bundle: null as EvidenceBundle | null
  };

  try {
    if (intent === "close-run") {
      const runId = String(form.get("runId") ?? "").trim();
      if (!runId) return { ...empty, problem: { title: "runId", status: 400 } };
      // The run id in the path is the whole request. A run with anything still
      // open comes back 409 and lands in `problem` — the screen never claims a
      // close the engine refused.
      const closed = await api<ReconSummary>(
        `/v1/ledger/recon/runs/${encodeURIComponent(runId)}/close`,
        { env, request, method: "POST" }
      );
      return { ...empty, closed };
    }

    if (intent === "generate-evidence-bundle") {
      const runId = String(form.get("runId") ?? "").trim();
      if (!runId) return { ...empty, problem: { title: "runId", status: 400 } };
      // No body: the run id in the path is the whole request, same as the
      // API route it calls.
      const bundle = await api<EvidenceBundle>(
        `/v1/ledger/recon/runs/${encodeURIComponent(runId)}/evidence-bundle`,
        { env, request, method: "POST" }
      );
      return { ...empty, bundle };
    }

    if (intent === "write-off") {
      const runId = String(form.get("runId") ?? "").trim();
      const amountMinor = Number(String(form.get("amountMinor") ?? "").trim());
      const direction = String(form.get("direction") ?? "");
      const reason = String(form.get("reason") ?? "").trim();
      if (!runId) return { ...empty, problem: { title: "runId", status: 400 } };
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        return { ...empty, problem: { title: "amount", status: 400 } };
      }
      if (!reason) return { ...empty, problem: { title: "reason", status: 400 } };

      const clearingAccount = String(form.get("clearingAccount") ?? "").trim();
      // The key is the write-off, not the press: the same residual written off
      // twice is one transaction (the unique index answers the second call with
      // the first row), while a different amount or direction is a different
      // write-off and gets its own. Nothing here is validated beyond the number
      // — the recipe owns the schema and names the argument it refused.
      const key = `writeoff:${runId}:${direction}:${amountMinor}`;
      const result = await api<{ txn: { id: string; state: string } }>("/v1/ledger/txn/RECON-WRITEOFF", {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": key },
        body: {
          idempotencyKey: key,
          grossMinor: amountMinor,
          ...(String(form.get("currency") ?? "").trim()
            ? { currency: String(form.get("currency")).trim() }
            : {}),
          reason,
          subjectRefs: { recon: `recon:${runId}` },
          args: {
            amountMinor,
            direction,
            reason,
            ...(clearingAccount ? { clearingAccount } : {})
          }
        }
      });
      return { ...empty, wroteOff: result.txn };
    }

    if (intent === "decide") {
      const reasonCode = String(form.get("reasonCode") ?? "").trim();
      const decision = String(form.get("decision") ?? "");
      if (!reasonCode) return { ...empty, problem: { title: "reason", status: 400 } };
      await api(`/v1/ledger/recon/matches/${encodeURIComponent(String(form.get("matchId") ?? ""))}/decide`, {
        env,
        request,
        method: "POST",
        // Who is the session; why is this, and the API writes both onto the match.
        body: { decision, reasonCode: reasonCode.slice(0, 64) }
      });
      return { ...empty, decided: decision };
    }

    const currency = String(form.get("currency") ?? "");

    // docs/27 F16. An uploaded CAMT.053 / MT940 / OFX file goes to the API as
    // text and is parsed there, beside the CSV parser and for the same reason:
    // the run reconciles what the *server* read, so nothing a browser did to a
    // preview can change what posts. Nothing is parsed here.
    const upload = form.get("statementFile");
    const statementText =
      upload instanceof File && upload.size > 0 ? (await upload.text()).trim() : "";

    // A pasted statement is only read when no file was given: two sources for
    // one run is a question with no right answer, so the file wins and the
    // paste is ignored rather than merged.
    const pasted = statementText ? { lines: [], rejected: [] } : statementFromCsv(String(form.get("lines") ?? ""), currency);
    if (!statementText) {
      if (!pasted.lines.length) return { ...empty, problem: { title: "lines", status: 400 } };
      if (pasted.rejected.length) return { ...empty, rejected: pasted.rejected };
    }

    const counterparty = String(form.get("counterpartyRef") ?? "").trim();
    const tolerance = String(form.get("toleranceMinor") ?? "").trim();
    const result = await api<{
      runId: string;
      matched: number;
      variances: number;
    }>("/v1/ledger/recon/runs", {
      env,
      request,
      method: "POST",
      body: {
        process: String(form.get("process") ?? ""),
        period: String(form.get("period") ?? ""),
        currency,
        ...(counterparty ? { counterpartyRef: counterparty } : {}),
        ...(tolerance ? { toleranceMinor: Number(tolerance) } : {}),
        propose: form.get("propose") === "on",
        ...(statementText ? { statementText } : { lines: pasted.lines })
      }
    });
    return { ...empty, started: result };
  } catch (error) {
    if (error instanceof ApiError) {
      // An approval gate is a pause, not a failure: the transaction is waiting
      // in the queue, so the screen says where it went rather than showing the
      // 403 as a refusal (same reading as ledger-open-txn.tsx).
      const p = error.problem as { code?: string; policy_key?: string };
      if (p.code === "approval_required") return { ...empty, approval: p.policy_key ?? "" };
      return { ...empty, problem: error.problem };
    }
    throw error;
  }
}

export default function LedgerRecon() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale, shell?.domainPack);
  // The money field's precision follows the currency beside it: 500 in JPY is
  // 500 minor units, in ZAR it is 50000.
  const [currency, setCurrency] = useState(loaded.currency);
  // The pasted statement lives in state so the screen can show what it read
  // back — the operator checks the rows, not the paste.
  const [statement, setStatement] = useState("");

  const busy = navigation.state !== "idle";

  if (loaded.denied) {
    return (
      <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />
    );
  }

  const summary = loaded.summary;

  const matchColumns: Array<Column<ReconMatch>> = [
    {
      key: "statementLineRef",
      header: l("recon.statementRef"),
      render: (row) => <Ref value={row.statementLineRef} className="text-12" fallback={l("none")} />
    },
    {
      key: "txnId",
      header: l("recon.txn"),
      render: (row) =>
        row.txnId ? (
          <Link
            to={`/ledger/transactions/${encodeURIComponent(row.txnId)}`}
            className="rounded-sm font-mono text-12 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {shortRef(row.txnId)}
          </Link>
        ) : (
          l("none")
        )
    },
    {
      key: "amountMinor",
      header: l("amount"),
      numeric: true,
      render: (row) => <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "deltaMinor",
      header: l("recon.delta"),
      numeric: true,
      render: (row) => (
        <Money
          amountMinor={row.deltaMinor}
          currency={row.currency}
          locale={locale}
          signed
          toned={row.deltaMinor !== 0}
        />
      )
    },
    {
      key: "method",
      header: l("recon.method"),
      render: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge size="sm" tone={row.method === "ai_proposed" ? "info" : "neutral"}>
            {l(`method.${row.method}`)}
          </Badge>
          {row.confidence === null ? null : (
            <span className="font-ui text-12 text-subtle">{row.confidence}%</span>
          )}
        </span>
      )
    },
    {
      key: "state",
      header: l("state"),
      render: (row) => (
        <Badge
          size="sm"
          tone={row.state === "confirmed" ? "success" : row.state === "rejected" ? "danger" : "warning"}
        >
          {l(`match.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "decided",
      header: l("recon.decidedBy"),
      render: (row) =>
        row.confirmedBy ? (
          <span className="flex flex-col">
            <span className="font-ui text-13 text-text">{row.confirmedBy}</span>
            {row.reasonCode ? (
              <span className="font-ui text-12 text-subtle">{row.reasonCode}</span>
            ) : null}
          </span>
        ) : (
          l("none")
        )
    },
    {
      key: "decide",
      header: l("recon.decide"),
      // A decision is offered only where one is still owed, and only to the
      // permission the API enforces. Otherwise the column is empty, not disabled.
      //
      // `unmatched` is owed a decision too, and that is what makes closing a run
      // reachable: `closeRun` counts `proposed` *and* `unmatched` as open and
      // has no force flag, so a run with a straggler no screen could reject
      // could never be closed by anyone (recon.ts, "reject the stragglers with
      // a reason instead"). `decideMatch` takes either state.
      render: (row) =>
        loaded.canDecide && (row.state === "proposed" || row.state === "unmatched") ? (
          <Form method="post" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="decide" />
            <input type="hidden" name="matchId" value={row.id} />
            <Field label={l("recon.reasonCode")} labelHidden className="w-48">
              <Input name="reasonCode" maxLength={64} required placeholder={l("recon.reasonCode")} />
            </Field>
            <ConfirmButton
              type="submit"
              name="decision"
              value="confirmed"
              size="sm"
              loading={busy}
              message={l("recon.confirmConfirm")}
            >
              {l("recon.confirm")}
            </ConfirmButton>
            <ConfirmButton
              type="submit"
              name="decision"
              value="rejected"
              size="sm"
              variant="ghost"
              loading={busy}
              message={l("recon.rejectConfirm")}
            >
              {l("recon.reject")}
            </ConfirmButton>
          </Form>
        ) : null
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {reconHeadline(summary, loaded.runs.length, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("recon.intro")}</p>
        </div>
      </header>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.started
          ? l("recon.started", {
              id: result.started.runId,
              matched: result.started.matched,
              variances: result.started.variances
            })
          : result?.decided
            ? l("recon.decided", { decision: l(`match.${result.decided}`) })
            : result?.closed
              ? l("recon.closed", { id: result.closed.runId })
              : result?.wroteOff
                ? l("recon.wroteOff", { id: result.wroteOff.id })
                : result?.bundle
                  ? result.bundle.state === "ready"
                    ? l("recon.evidenceReady", { count: String(result.bundle.manifest.files.length) })
                    : l("recon.evidenceFailed")
                  : ""}
      </p>

      {result?.problem ? (
        <Problem
          problem={
            result.problem.title === "lines"
              ? { title: l("recon.linesInvalid") }
              : result.problem.title === "reason"
                ? { title: l("reasonRequired") }
                : result.problem.title === "runId"
                  ? { title: l("recon.evidenceRunIdInvalid") }
                  : result.problem.title === "amount"
                    ? { title: l("recon.writeOffAmountInvalid") }
                    : result.problem
          }
        />
      ) : null}

      {result?.approval !== null && result?.approval !== undefined ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/10 p-5"
        >
          <p className="font-serif text-18 leading-[1.3] text-text">{l("recon.writeOffApproval")}</p>
          <p className="max-w-prose font-ui text-13 text-muted">{l("recon.writeOffApprovalBody")}</p>
          <div>
            <Button asChild variant="secondary">
              <Link to="/approvals">{l("recon.approvalsInbox")}</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {result?.rejected?.length ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{l("recon.linesRejected")}</p>
          <ul className="flex flex-col gap-1">
            {result.rejected.map((row) => (
              <li key={row.row} className="font-mono text-12 text-muted">
                {l("recon.linesRow", { row: String(row.row) })} — {row.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result?.started ? (
        <div>
          <Button asChild variant="secondary">
            <Link to={`/ledger/recon?run=${encodeURIComponent(result.started.runId)}`}>
              {l("recon.run")}
            </Link>
          </Button>
        </div>
      ) : null}

      <Form method="get" aria-label={l("recon.lookup")} className="flex flex-wrap items-end gap-3">
        <Field label={l("recon.runId")} className="w-80">
          <Input name="run" defaultValue={loaded.runId} />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
      </Form>

      {summary ? (
        <Card
          title={`${l(`process.${summary.process}`)} · ${summary.period}`}
          description={summary.runId}
          elevation="flat"
          actions={
            <span className="flex flex-wrap items-center gap-3">
              <Badge tone={summary.state === "closed" ? "success" : "warning"}>
                {l(`state.${summary.state}`)}
              </Badge>
              {/* Offered only while something is still open to close and only to
                  the permission the API enforces. A run with matches still
                  awaiting a decision comes back 409 — the count beside it says
                  how many, so the refusal is never a surprise. */}
              {loaded.canDecide && summary.state !== "closed" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="close-run" />
                  <input type="hidden" name="runId" value={summary.runId} />
                  <ConfirmButton
                    type="submit"
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    message={l("recon.closeConfirm")}
                  >
                    {l("recon.close")}
                  </ConfirmButton>
                </Form>
              ) : null}
            </span>
          }
        >
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-5">
            <div className="flex flex-col gap-1">
              <dt className="font-ui text-12 text-subtle">{l("recon.matched")}</dt>
              <dd className="font-mono text-22 tabular-nums text-text">{summary.matchedCount}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-ui text-12 text-subtle">{l("recon.variance")}</dt>
              <dd className="font-mono text-22 tabular-nums text-text">{summary.varianceCount}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-ui text-12 text-subtle">{l("recon.varianceMinor")}</dt>
              <dd className="font-mono text-22 tabular-nums text-text">
                <Money
                  amountMinor={summary.varianceMinor}
                  currency={summary.currency}
                  locale={locale}
                  signed
                  toned={summary.varianceMinor !== 0}
                />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-ui text-12 text-subtle">{l("recon.open")}</dt>
              <dd className="font-mono text-22 tabular-nums text-text">{summary.open}</dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {loaded.runId ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-ui text-12 font-medium uppercase tracking-[0.14em] text-subtle">{l("recon.matches")}</h2>
          <Table<ReconMatch>
            caption={l("recon.matchesCaption")}
            captionHidden
            density="compact"
            columns={matchColumns}
            rows={loaded.matches}
            rowKey={(row) => row.id}
            empty={<EmptyState title={l("recon.noMatches")} body={l("recon.noMatchesBody")} />}
          />
        </section>
      ) : (
        <EmptyState title={l("recon.pick")} body={l("recon.pickBody")} />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-ui text-12 font-medium uppercase tracking-[0.14em] text-subtle">{l("recon.runs")}</h2>
        <Table<ReconRun>
          caption={l("recon.runsCaption")}
          captionHidden
          density="compact"
          rows={loaded.runs}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("recon.noRuns")} body={l("recon.noRuns.body")} />}
          columns={[
              {
                key: "process",
                header: l("recon.process"),
                render: (row) => (
                  <Link
                    to={`/ledger/recon?run=${encodeURIComponent(row.id)}`}
                    className="rounded-sm font-ui text-13 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                  >
                    {l(`process.${row.process}`)}
                  </Link>
                )
              },
              { key: "period", header: l("recon.period"), render: (row) => row.period },
              {
                key: "state",
                header: l("state"),
                render: (row) => (
                  <Badge size="sm" tone={row.state === "closed" ? "success" : "warning"}>
                    {l(`state.${row.state}`)}
                  </Badge>
                )
              },
              {
                key: "matchedCount",
                header: l("recon.matched"),
                numeric: true,
                render: (row) => row.matchedCount
              },
              {
                key: "varianceMinor",
                header: l("recon.varianceMinor"),
                numeric: true,
                render: (row) => (
                  <Money
                    amountMinor={row.varianceMinor}
                    currency={row.currency}
                    locale={locale}
                    signed
                    toned={row.varianceMinor !== 0}
                  />
                )
              },
              {
                key: "createdAt",
                header: l("when"),
                render: (row) => <DateTime value={row.createdAt} locale={locale} precision="minute" />
              }
          ]}
        />
      </section>

      {/* The residual a reconciliation leaves behind — rounded premium tax, a
          PSP fee booked to the cent — needs an instrument, or the difference
          sits on a clearing account forever. It is a transaction like any
          other: idempotency key, dual control always, two balanced lines
          (docs/19 §5, CLAUDE.md §12). Offered only on an open run: a closed one
          is a period a controller has already signed. */}
      {loaded.canWriteOff && summary && summary.state !== "closed" ? (
        <Card title={l("recon.writeOff")} description={l("recon.writeOffIntro")} elevation="flat">
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="write-off" />
            <input type="hidden" name="runId" value={summary.runId} />
            <input type="hidden" name="currency" value={summary.currency} />
            <div className="flex flex-wrap items-end gap-3">
              <Field label={l("recon.writeOffAmount")} hint={l("recon.writeOffAmountHint")} required className="w-52">
                <MoneyField
                  name="amountMinor"
                  currency={summary.currency}
                  locale={locale}
                  min={0}
                  defaultMinor={Math.abs(summary.varianceMinor)}
                  required
                />
              </Field>
              <Field label={l("recon.writeOffDirection")} required className="w-56">
                <Select
                  name="direction"
                  defaultValue="shortfall"
                  options={[
                    { value: "shortfall", label: l("recon.writeOffShortfall") },
                    { value: "surplus", label: l("recon.writeOffSurplus") }
                  ]}
                />
              </Field>
              <Field
                label={l("recon.writeOffAccount")}
                hint={l("recon.writeOffAccountHint")}
                className="w-44"
              >
                <Input name="clearingAccount" defaultValue="1100" maxLength={4} />
              </Field>
            </div>
            <Field label={l("recon.writeOffReason")} hint={l("recon.writeOffReasonHint")} required>
              <Textarea name="reason" rows={2} minLength={10} maxLength={500} required />
            </Field>
            <div>
              <ConfirmButton type="submit" loading={busy} message={l("recon.writeOffConfirm")}>
                {l("recon.writeOff")}
              </ConfirmButton>
            </div>
          </Form>
        </Card>
      ) : null}

      {loaded.canExport && loaded.runId ? (
        <Card title={l("recon.evidence")} description={l("recon.evidenceIntro")} elevation="flat">
          <div className="flex flex-col gap-4">
            <Form method="post">
              <input type="hidden" name="intent" value="generate-evidence-bundle" />
              <input type="hidden" name="runId" value={loaded.runId} />
              <ConfirmButton type="submit" loading={busy} message={l("recon.evidenceBuildConfirm")}>
                {l("recon.evidenceBuild")}
              </ConfirmButton>
            </Form>

            {result?.bundle ? (
              <EvidenceResult bundle={result.bundle} apiOrigin={loaded.apiOrigin} locale={locale} l={l} />
            ) : null}
          </div>
        </Card>
      ) : null}

      {loaded.canRun ? (
        <Card title={l("recon.start")} elevation="flat">
          {/* multipart: a file input in a urlencoded form posts its *name*,
              not its contents, and the action would read an empty statement. */}
          <Form method="post" encType="multipart/form-data" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field label={l("recon.process")} required className="w-52">
                <Select
                  name="process"
                  defaultValue="insurer"
                  options={PROCESSES.map((process) => ({
                    value: process,
                    label: l(`process.${process}`)
                  }))}
                />
              </Field>
              <Field label={l("recon.period")} required className="w-40">
                <Input name="period" defaultValue={new Date().toISOString().slice(0, 7)} required />
              </Field>
              <Field label={l("currency")} required className="w-28">
                <Input
                  name="currency"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  required
                />
              </Field>
              {/* ponytail: a free text id, not a picker — finance roles hold
                  `dist:channels:read` but no `core:providers:read`, so half the
                  counterparties cannot be listed to them. The hint says what to
                  paste; widening the grant is an ADR, not a form change. */}
              <Field
                label={l("recon.counterparty")}
                hint={l("recon.counterpartyHint")}
                className="w-56"
              >
                <Input name="counterpartyRef" />
              </Field>
              <Field label={l("recon.tolerance")} className="w-44">
                <MoneyField name="toleranceMinor" currency={currency || "ZAR"} locale={locale} min={0} />
              </Field>
            </div>

            {/* docs/27 F16: the counterparty's own export, in the format it
                came in. The paste below stays for the statement that arrived as
                a spreadsheet, which is most of them today. */}
            <Field label={l("recon.file")} hint={l("recon.fileHint")}>
              <input
                type="file"
                name="statementFile"
                accept=".xml,.txt,.sta,.940,.ofx,.qfx,text/xml,application/xml,text/plain"
                className="block w-full rounded-sm border border-line bg-surface px-3 py-2 font-ui text-13 text-text file:me-3 file:rounded-sm file:border-0 file:bg-accent/10 file:px-3 file:py-1 file:font-ui file:text-13 file:text-accent"
              />
            </Field>

            <Field label={l("recon.lines")} hint={l("recon.linesHint")}>
              {/* The statement as the counterparty exported it. No defaultValue:
                  an empty paste must fail `required` rather than post a run
                  against nothing. */}
              <Textarea
                name="lines"
                rows={8}
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                placeholder={l("recon.linesPlaceholder")}
                className="font-mono text-12"
              />
            </Field>

            <StatementPreview
              text={statement}
              currency={currency || "ZAR"}
              locale={locale}
              l={l}
            />

            <Checkbox name="propose" label={l("recon.propose")} />
            <p className="font-ui text-12 text-subtle">{l("recon.proposeHint")}</p>

            <div>
              <ConfirmButton type="submit" loading={busy} message={l("recon.startConfirm")}>
                {l("recon.start")}
              </ConfirmButton>
            </div>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}

/** ponytail: file sizes only ever come from this one manifest, so a decimal
 *  KB/MB split is plenty — no need for the full binary-prefix table. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const EVIDENCE_STEP_LABEL: Record<string, string> = {
  "run.json": "recon.evidenceStepRun",
  "matches.jsonl": "recon.evidenceStepMatches",
  "summary.pdf": "recon.evidenceStepSummary"
};

/**
 * The bundle the API just built: how it was assembled (one step per file it
 * wrote, in the order apps/api/src/routes/ledger.ts writes them) and what
 * ended up inside (one card per file, carrying the hash a reader would check
 * it against). Neither section recomputes anything — every figure here is a
 * field the manifest already carried.
 */
function EvidenceResult({
  bundle,
  apiOrigin,
  locale,
  l
}: {
  bundle: EvidenceBundle;
  apiOrigin: string;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const pipeline: Section = {
    kind: "steps",
    title: l("recon.evidencePipeline"),
    items: bundle.manifest.files.map((file, index) => ({
      code: String(index + 1).padStart(2, "0"),
      dot: hueVar(),
      title: l(EVIDENCE_STEP_LABEL[file.path] ?? file.path),
      money: formatBytes(file.sizeBytes),
      note: file.path,
      hue: hueVar()
    }))
  };

  const documents: Section = {
    kind: "board",
    title: l("recon.evidenceDocuments"),
    items: [
      {
        name: `${l(`process.${bundle.manifest.scope.process}`)} · ${bundle.manifest.scope.period}`,
        hue: hueVar(),
        count: String(bundle.manifest.files.length),
        cards: bundle.manifest.files.map((file) => ({
          title: file.path,
          clock: formatInstant(bundle.createdAt, (date) => formatDate(date, { locale, precision: "minute" })),
          note: file.sha256,
          who: bundle.requestedBy,
          value: formatBytes(file.sizeBytes),
          ai: false,
          line: hueVar()
        }))
      }
    ]
  };

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-5">
        <div className="flex flex-col gap-1">
          <dt className="font-ui text-12 text-subtle">{l("state")}</dt>
          <dd>
            <Badge tone={bundle.state === "ready" ? "success" : "danger"} dot>
              {bundle.state === "ready" ? l("recon.evidenceStateReady") : l("recon.evidenceStateFailed")}
            </Badge>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-ui text-12 text-subtle">{l("recon.evidenceHash")}</dt>
          <dd className="break-all font-mono text-12 text-text">{bundle.bundleHash}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-ui text-12 text-subtle">{l("recon.evidenceRequestedBy")}</dt>
          <dd className="font-ui text-14 text-text">{bundle.requestedBy}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-ui text-12 text-subtle">{l("when")}</dt>
          <dd className="font-ui text-14 text-text">
            <DateTime value={bundle.createdAt} locale={locale} precision="minute" />
          </dd>
        </div>
      </dl>

      {bundle.state === "ready" ? (
        <>
          <div>{renderSection(pipeline, "ledger")}</div>
          <div>{renderSection(documents, "ledger")}</div>
          <div>
            <Button asChild variant="secondary">
              {/* Straight to the API, same trade as the finance reports'
                  export links: the archive is the evidence, and it does not
                  get copied through a second process on the way out. */}
              <a
                href={`${apiOrigin}/v1/ledger/recon/runs/${encodeURIComponent(bundle.manifest.scope.runId)}/evidence-bundle/download`}
                rel="noopener"
                download
              >
                {l("recon.evidenceDownload")}
              </a>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * What the server will read out of the paste, shown before the run starts. It
 * reconciles nothing and posts nothing — it is the statement said back in
 * words, so a mis-shaped column is caught by eye rather than by a wrong match.
 */
function StatementPreview({
  text,
  currency,
  locale,
  l
}: {
  text: string;
  currency: string;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const { lines, rejected } = statementFromCsv(text, currency);
  if (!text.trim()) return null;

  return (
    <div className="flex flex-col gap-2">
      <p role="status" aria-live="polite" className="font-ui text-12 text-subtle">
        {l("recon.linesRead", { count: String(lines.length), rejected: String(rejected.length) })}
      </p>
      {lines.length ? (
        <Table<StatementLine & { row: number }>
          caption={l("recon.linesCaption")}
          captionHidden
          density="compact"
          columns={[
            {
              key: "ref",
              header: l("recon.statementRef"),
              render: (row) => <Ref value={row.ref} className="text-12" />
            },
            {
              key: "amountMinor",
              header: l("recon.lineAmount"),
              numeric: true,
              render: (row) => (
                <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
              )
            },
            {
              key: "ourRef",
              header: l("recon.lineOurRef"),
              render: (row) => <Ref value={row.ourRef ?? null} className="text-12" fallback={l("none")} />
            },
            {
              key: "postedAt",
              header: l("recon.linePostedAt"),
              render: (row) =>
                row.postedAt === undefined ? (
                  l("none")
                ) : (
                  <DateTime value={row.postedAt} locale={locale} precision="day" />
                )
            },
            {
              key: "description",
              header: l("recon.lineDescription"),
              render: (row) => row.description ?? l("none")
            }
          ]}
          rows={lines.slice(0, 20).map((line, index) => ({ ...line, row: index }))}
          rowKey={(row) => `${row.ref}.${row.row}`}
        />
      ) : null}
      {lines.length > 20 ? (
        <p className="font-ui text-12 text-subtle">
          {l("recon.linesMore", { count: String(lines.length - 20) })}
        </p>
      ) : null}
    </div>
  );
}
