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
  DateTime,
  EmptyState,
  Field,
  Input,
  Money,
  PostingFlow,
  Ref,
  Select,
  StateFlow,
  Table,
  Textarea,
  type Column,
  type FlowMachine,
  type FlowVisit
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { humanise } from "../modules/spec";
import { policyTitle } from "./approvals";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import {
  PERM,
  TRANSITIONS,
  balanceCheck,
  labelIn,
  mintKey,
  txnActions,
  txnHeadline,
  txnTone,
  type Label
} from "./ledger.shared";

/**
 * The flow the diagram draws: docs/19 §3, by reference rather than by copy.
 * `TRANSITIONS` mirrors @lyra/ledger's own machine (pinned by
 * ledger.shared.test.ts), the spine is its happy path, and `flowPlan` refuses a
 * spine whose steps are not documented edges of it — so no screen can invent a
 * state, or a step the ledger would not take.
 */
export const TXN_FLOW: FlowMachine = {
  transitions: TRANSITIONS,
  spine: ["initiated", "validated", "authorized", "executing", "settled"],
  exits: ["failed", "rejected", "expired"]
};

// One transaction, end to end: what it is, what it posted, what was decided
// about it, and the two things a person may still do to it.
//
// Nothing here writes money. Every action posts to the endpoint that owns the
// state machine (apps/api/src/routes/ledger.ts), and the screen reports only
// what came back — including "an approval was raised and nothing happened yet",
// which is a refusal the API expresses as a 403 and a person must not read as
// success (CLAUDE.md §4, §12).

/* -------------------------------------------------------------- the contract */

// Shapes as the API returns them. Local because the web app does not depend on
// @lyra/ledger; the API's own tests are what should fail if these drift.

interface Txn {
  id: string;
  type: string;
  state: string;
  idempotencyKey: string;
  correlationId: string | null;
  parentTxnId: string | null;
  reversalOf: string | null;
  currency: string;
  baseCurrency: string;
  grossMinor: number;
  baseGrossMinor: number;
  ledgerBatchId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  actorKind?: string | null;
  actorId?: string | null;
  createdAt?: number | null;
  settledAt?: number | null;
}

interface JournalLine {
  id: string;
  seq: number;
  accountCode: string;
  side: string;
  amountMinor: number;
  currency: string;
  memo: string | null;
  postedAt: number;
}

interface TransitionRow {
  id: string;
  fromState: string | null;
  toState: string;
  actorRef: string;
  reason: string | null;
  ts: number;
}

interface ApprovalRow {
  id: string;
  policyKey: string;
  requestedBy: string;
  requestedAt: number;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
}

interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

/** A panel this actor may not read is absent, not fatal. 401 stays thrown so
 *  the layout can send them to sign in. */
async function soft<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

/* -------------------------------------------------------------------- loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);

  if (!held.has(PERM.txnsRead)) {
    return { denied: true as const, permission: PERM.txnsRead };
  }

  const txn = await api<Txn>(`/v1/ledger/txn/${encodeURIComponent(id)}`, { env, request });
  const q = `txnId=${encodeURIComponent(id)}`;

  const [lines, transitions, approvals, audit, reversedBy] = await Promise.all([
    held.has(PERM.journalsRead)
      ? soft(
          api<{ data: JournalLine[] }>(`/v1/ledger/journal-lines?${q}&sort=seq&order=asc&limit=200`, {
            env,
            request
          })
        )
      : null,
    soft(
      api<{ data: TransitionRow[] }>(`/v1/ledger/txn-transitions?${q}&sort=ts&order=asc&limit=100`, {
        env,
        request
      })
    ),
    held.has(PERM.approvalsRead)
      ? soft(
          api<{ data: ApprovalRow[] }>(
            `/v1/core/approvals?subjectRef=txn:${encodeURIComponent(id)}&sort=requestedAt&order=desc&limit=25`,
            { env, request }
          )
        )
      : null,
    held.has(PERM.auditRead)
      ? soft(
          api<{ data: AuditRow[] }>(
            `/v1/core/audit-log?subjectRef=txn:${encodeURIComponent(id)}&sort=ts&order=desc&limit=50`,
            { env, request }
          )
        )
      : null,
    // A reversal points back at its original; the original holds no forward
    // link, so the counter-entry is found by asking who reverses this one.
    soft(
      api<{ data: Array<{ id: string }> }>(
        `/v1/ledger/txns?reversalOf=${encodeURIComponent(id)}&limit=1`,
        { env, request }
      )
    )
  ]);

  return {
    denied: false as const,
    txn,
    lines: lines?.data ?? [],
    linesReadable: lines !== null,
    transitions: transitions?.data ?? [],
    approvals: approvals?.data ?? [],
    audit: audit?.data ?? [],
    reversedBy: reversedBy?.data?.[0]?.id ?? null,
    actions: txnActions(held, txn.state),
    /**
     * Minted here, once per render of this screen, and carried in the reversal
     * form as a hidden field. Generated in the browser at submit time it would
     * be a fresh key per press — precisely the double-post it exists to stop.
     */
    reverseKey: mintKey(`ledger.reverse.${txn.id}`)
  };
}

/* -------------------------------------------------------------------- action */

/** `approval_required` is a 403 carrying the policy the gate raised. The web
 *  Problem type has no `code`, so it is read off the wire shape. */
function approvalPolicy(problem: unknown): string | null {
  const p = problem as { code?: string; policy_key?: string } | null;
  return p?.code === "approval_required" ? (p.policy_key ?? "") : null;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  const empty = { problem: null, moved: null, reversal: null, approval: null };

  try {
    if (intent === "transition") {
      const to = String(form.get("to") ?? "");
      const failureCode = String(form.get("failureCode") ?? "").trim();
      const row = await api<Txn>(`/v1/ledger/txn/${encodeURIComponent(id)}/transition`, {
        env,
        request,
        method: "POST",
        body: {
          to,
          ...(reason ? { reason } : {}),
          ...(failureCode ? { failureCode } : {})
        }
      });
      return { ...empty, intent, moved: row.state };
    }

    if (intent === "reverse") {
      if (!reason) return { ...empty, intent, problem: { title: "reason", status: 400 } };
      const result = await api<{ reversal: Txn }>(
        `/v1/ledger/txn/${encodeURIComponent(id)}/reverse`,
        {
          env,
          request,
          method: "POST",
          // The key the loader minted travels with the form, so a double press
          // reuses it and the ledger returns the same reversal rather than
          // posting a second counter-entry.
          body: { reason, idempotencyKey: String(form.get("idempotencyKey") ?? "") }
        }
      );
      return { ...empty, intent, reversal: result.reversal.id };
    }

    return { ...empty, intent, problem: { title: "unknown intent", status: 400 } };
  } catch (error) {
    if (error instanceof ApiError) {
      const policy = approvalPolicy(error.problem);
      return policy === null
        ? { ...empty, intent, problem: error.problem }
        : { ...empty, intent, approval: policy };
    }
    throw error;
  }
}

/* ---------------------------------------------------------------------- view */

function Entry({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="font-ui text-13 text-text">{children}</dd>
    </div>
  );
}

function TxnLink({ id, label }: { id: string; label: string }) {
  return (
    <Link
      to={`/ledger/transactions/${encodeURIComponent(id)}`}
      className="rounded-sm font-mono text-12 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </Link>
  );
}

export default function LedgerTransaction() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (loaded.denied) {
    return (
      <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />
    );
  }

  const { txn, lines, actions } = loaded;
  const balance = balanceCheck(lines);

  const lineColumns: Array<Column<JournalLine>> = [
    { key: "seq", header: "#", render: (row) => <span className="font-mono text-12">{row.seq}</span> },
    {
      key: "account",
      header: l("txn.account"),
      render: (row) => <span className="font-mono text-12">{row.accountCode}</span>
    },
    {
      key: "side",
      header: l("txn.side"),
      render: (row) => <Badge size="sm">{l(`side.${row.side}`)}</Badge>
    },
    {
      key: "debit",
      header: l("txn.debit"),
      numeric: true,
      render: (row) =>
        row.side === "debit" ? (
          <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
        ) : null
    },
    {
      key: "credit",
      header: l("txn.credit"),
      numeric: true,
      render: (row) =>
        row.side === "credit" ? (
          <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
        ) : null
    },
    { key: "memo", header: l("txn.memo"), render: (row) => row.memo ?? l("none") }
  ];

  // What the machine did, in the order it did it. A step's `fromState` is the
  // step before it, so only `toState` is a visit.
  const visits: FlowVisit[] = loaded.transitions.map((row) => ({
    state: row.toState,
    at: row.ts,
    actor: row.actorRef,
    tone: txnTone(row.toState),
    ...(row.reason ? { detail: row.reason } : {})
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{txnHeadline(txn, l, locale)}</h1>
          <p className="font-ui text-13 text-muted">{l("txn.intro")}</p>
        </div>
      </header>

      <Announcement result={result} l={l} />

      {/* A `reason` refusal is already shown on the field it belongs to, further
          down — repeating it up here says the same thing twice in two wordings. */}
      {result?.problem && result.problem.title !== "reason" ? (
        <Problem problem={result.problem} />
      ) : null}

      <Card title={t("common.details")} elevation="flat">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
          <Entry term={t("common.id")}>
            <Ref value={txn.id} className="text-12" />
          </Entry>
          <Entry term={l("txn.gross")}>
            <Money
              amountMinor={txn.grossMinor}
              currency={txn.currency}
              locale={locale}
              baseMinor={txn.baseGrossMinor}
              baseCurrency={txn.baseCurrency}
            />
          </Entry>
          <Entry term={l("txn.key")}>
            <span className="font-mono text-12 break-all">{txn.idempotencyKey}</span>
          </Entry>
          {txn.createdAt ? (
            <Entry term={t("common.createdAt")}>
              <DateTime value={txn.createdAt} locale={locale} precision="minute" />
            </Entry>
          ) : null}
          {txn.settledAt ? (
            <Entry term={l("state.settled")}>
              <DateTime value={txn.settledAt} locale={locale} precision="minute" />
            </Entry>
          ) : null}
          {txn.actorKind ? (
            <Entry term={l("actor")}>
              {txn.actorKind}
              {txn.actorId ? `:${txn.actorId}` : ""}
            </Entry>
          ) : null}
          {txn.correlationId ? (
            <Entry term={l("txn.correlation")}>
              <Ref value={txn.correlationId} className="text-12" />
            </Entry>
          ) : null}
          {txn.parentTxnId ? (
            <Entry term={l("txn.parent")}>
              <TxnLink id={txn.parentTxnId} label={txn.parentTxnId} />
            </Entry>
          ) : null}
          {/* Which entry reverses which, from either end of the pair. */}
          {txn.reversalOf ? (
            <Entry term={l("txn.reversalOf")}>
              <TxnLink id={txn.reversalOf} label={txn.reversalOf} />
            </Entry>
          ) : null}
          {loaded.reversedBy ? (
            <Entry term={l("txn.reversedBy")}>
              <TxnLink id={loaded.reversedBy} label={loaded.reversedBy} />
            </Entry>
          ) : null}
          {txn.ledgerBatchId ? (
            <Entry term={l("txn.batch")}>
              <Ref value={txn.ledgerBatchId} className="text-12" />
            </Entry>
          ) : null}
          {txn.failureCode ? (
            <Entry term={l("txn.failure")}>
              <span className="text-danger">{txn.failureCode}</span>
              {txn.failureDetail ? <span className="text-muted"> — {txn.failureDetail}</span> : null}
            </Entry>
          ) : null}
        </dl>
      </Card>

      {/* The invariant, said out loud. An imbalance is an alert, not a footnote. */}
      {loaded.linesReadable ? (
        lines.length === 0 ? (
          <EmptyState title={l("txn.noLines")} body={l("txn.noLinesBody")} />
        ) : (
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">{l("txn.lines")}</h2>
            {/* The value moving: what each side gave up, what it received, and
                the amount on the wire. Every figure is a posted line or a sum of
                them — `PostingFlow` re-adds the legs it draws and refuses to
                call the batch balanced if they disagree with `balance`.
                ponytail: one currency, because a batch posts in one; per-leg
                currency the day a cross-currency txn exists. */}
            <PostingFlow
              legs={lines.map((row) => ({
                id: row.id,
                account: row.accountCode,
                side: row.side,
                amountMinor: row.amountMinor,
                memo: row.memo,
                sealed: true
              }))}
              currency={txn.currency}
              balance={balance}
              fromLabel={l("txn.totalDebit")}
              toLabel={l("txn.totalCredit")}
              label={l("txn.linesCaption")}
              note={l("txn.imbalanceBody")}
              locale={locale}
            />
            {/* The record behind the flow: sequence, side and memo per line. */}
            <Table<JournalLine>
              caption={l("txn.linesCaption")}
              captionHidden
              columns={lineColumns}
              rows={lines}
              rowKey={(row) => row.id}
              rowState={() => "sealed"}
              density="compact"
            />
          </section>
        )
      ) : null}

      {/* Actions. Absent when the actor may not take them, or the machine
          forbids them — never a disabled button with an explanation. */}
      {actions.transitions.length > 0 ? (
        <Card title={l("txn.transition")} elevation="flat">
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="transition" />
            <Field label={l("txn.transitionTo")} className="w-56">
              <Select
                name="to"
                {...(actions.transitions[0] ? { defaultValue: actions.transitions[0] } : {})}
                options={actions.transitions.map((state) => ({
                  value: state,
                  label: l(`state.${state}`)
                }))}
              />
            </Field>
            <Field label={l("reason")} className="w-64">
              <Input name="reason" maxLength={500} />
            </Field>
            <Field label={l("txn.failureCode")} className="w-40">
              <Input name="failureCode" maxLength={64} />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("txn.transitionSubmit")}
            </Button>
          </Form>
        </Card>
      ) : null}

      {actions.canReverse ? (
        <Card title={l("txn.reverse")} elevation="flat">
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="reverse" />
            <input type="hidden" name="idempotencyKey" value={loaded.reverseKey} />
            <p className="max-w-prose font-ui text-13 text-muted">{l("txn.reverseBody")}</p>
            <Field label={l("reason")} required error={result?.problem?.title === "reason" ? l("reasonRequired") : undefined}>
              <Textarea name="reason" required minLength={3} maxLength={500} rows={3} />
            </Field>
            <p className="font-ui text-12 text-subtle">{l("idempotencyNote")}</p>
            <div>
              <ConfirmButton
                type="submit"
                variant="danger"
                loading={busy}
                message={l("txn.reverseConfirm")}
              >
                {l("txn.reverseSubmit")}
              </ConfirmButton>
            </div>
          </Form>
        </Card>
      ) : null}

      {/* Where this transaction is in its machine: what happened with its
          timestamps, what it is doing now, and what the machine still owes. */}
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{l("txn.history")}</h2>
        <StateFlow
          machine={TXN_FLOW}
          visits={visits}
          current={txn.state}
          label={l("txn.historyLabel")}
          labelFor={(state) => l(`state.${state}`)}
          locale={locale}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="eyebrow">{l("txn.approvals")}</h2>
          {/* The queue lives at /approvals and is not rebuilt here. */}
          <Button asChild variant="ghost">
            <Link to="/approvals">{l("txn.approvalsInbox")}</Link>
          </Button>
        </div>
        {loaded.approvals.length === 0 ? (
          <EmptyState title={l("txn.approvalsEmpty")} body={l("txn.approvalsEmpty.body")} />
        ) : (
          <Table<ApprovalRow>
            caption={l("txn.approvals")}
            captionHidden
            density="compact"
            rows={loaded.approvals}
            rowKey={(row) => row.id}
            columns={[
              {
                key: "policy",
                header: l("txn.approvals"),
                // The gate's own name for itself ("ledger.txn_authorize") is not
                // a sentence. Same helper the approvals inbox reads it with.
                render: (row) => policyTitle(row.policyKey, "ledger")
              },
              {
                key: "decision",
                header: l("state"),
                render: (row) => (
                  <Badge
                    size="sm"
                    tone={
                      row.decision === "approved"
                        ? "success"
                        : row.decision === "rejected"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {l(`match.${row.decision ?? "proposed"}`)}
                  </Badge>
                )
              },
              { key: "by", header: l("actor"), render: (row) => row.decidedBy ?? row.requestedBy },
              {
                key: "at",
                header: l("when"),
                render: (row) => (
                  <DateTime value={row.decidedAt ?? row.requestedAt} locale={locale} precision="minute" />
                )
              },
              { key: "reason", header: l("reason"), render: (row) => row.reason ?? l("none") }
            ]}
          />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{l("txn.audit")}</h2>
        {loaded.audit.length > 0 ? (
          <Table<AuditRow>
            caption={l("txn.audit")}
            captionHidden
            density="compact"
            rows={loaded.audit}
            rowKey={(row) => row.id}
            rowState={() => "sealed"}
            columns={[
              {
                key: "ts",
                header: l("when"),
                render: (row) => <DateTime value={row.ts} locale={locale} precision="second" />
              },
              { key: "actor", header: l("actor"), render: (row) => row.actorRef },
              {
                key: "action",
                header: t("common.actions"),
                render: (row) => humanise(row.action)
              }
            ]}
          />
        ) : (
          <EmptyState title={l("txn.auditEmpty")} body={l("txn.auditEmpty.body")} />
        )}
      </section>
    </div>
  );
}

/**
 * What the API actually confirmed. An approval request is reported as a
 * request: the money did not move, and a screen that said otherwise would be
 * lying about a consequential action.
 */
function Announcement({
  result,
  l
}: {
  result: { moved: string | null; reversal: string | null; approval: string | null } | undefined;
  l: Label;
}) {
  if (result?.approval !== null && result?.approval !== undefined) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-5"
      >
        <p className="section-title">{l("txn.approvalRaised")}</p>
        <p className="max-w-prose font-ui text-13 text-muted">{l("txn.approvalRaisedBody")}</p>
        {result.approval ? (
          <p className="font-mono text-12 text-subtle">{result.approval}</p>
        ) : null}
        <div>
          <Button asChild variant="secondary">
            <Link to="/approvals">{l("txn.approvalsInbox")}</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <p role="status" aria-live="polite" className="font-ui text-13 text-success">
      {result?.moved
        ? l("txn.moved", { state: l(`state.${result.moved}`) })
        : result?.reversal
          ? l("txn.reversedAs", { id: result.reversal })
          : ""}
    </p>
  );
}
