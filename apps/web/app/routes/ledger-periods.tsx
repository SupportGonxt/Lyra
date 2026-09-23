import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
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
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import { cloudflare } from "../context";
import { who } from "../names";
import { translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { PERM, checkName, labelIn, periodHeadline, periodTone } from "./ledger.shared";

// Closing a period is the moment a month stops being editable, so the checks
// that block it are the screen — not a message that appears after the press.
// The API runs them again on close and refuses; this only means nobody has to
// discover that by trying.

interface Period {
  id: string;
  code: string;
  state: string;
  startAt: number;
  endAt: number;
  closedBy: string | null;
  closedAt: number | null;
}

interface CloseCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface RebuildResult {
  accountCode: string;
  currency: string;
  storedDebitMinor: number;
  storedCreditMinor: number;
  rebuiltDebitMinor: number;
  rebuiltCreditMinor: number;
  drifted: boolean;
}

async function soft<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

/** `2026-07`. The month a controller is most likely to be closing. */
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const MONTH = /^\d{4}-\d{2}$/;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);

  if (!held.has(PERM.periodsRead)) {
    return { denied: true as const, permission: PERM.periodsRead };
  }

  const asked = new URL(request.url).searchParams.get("period") ?? "";
  const code = MONTH.test(asked) ? asked : thisMonth();

  const [view, recent] = await Promise.all([
    // The enriched view — `/period/:code` singular, so the CRUD record handler
    // keeps `/periods/:id`. It creates the period row if the month has none.
    soft(api<{ period: Period; checks: CloseCheck[] }>(`/v1/ledger/period/${code}`, { env, request })),
    soft(
      api<{ data: Period[] }>("/v1/ledger/periods?sort=code&order=desc&limit=12", { env, request })
    )
  ]);

  const rows = recent?.data ?? [];

  // A period says who closed it as `user:us_01KE…XK2`. The close screen prints
  // that twice — in the period's own header and down the CLOSED BY column of
  // the last twelve months — and a controller checking who signed off a month
  // cannot read a ULID.
  const resolved = await names([view?.period?.closedBy, ...rows.map((row) => row.closedBy)], {
    env,
    request
  });

  return {
    denied: false as const,
    code,
    period: view?.period ?? null,
    checks: view?.checks ?? [],
    recent: rows,
    names: resolved,
    canClose: held.has(PERM.periodsClose),
    canRebuild: held.has(PERM.journalsPost)
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const code = String(form.get("code") ?? "");
  const empty = { problem: null, closed: null, reopened: null, rebuild: null };

  try {
    if (intent === "soft_closed" || intent === "hard_closed") {
      const row = await api<Period>(`/v1/ledger/periods/${encodeURIComponent(code)}/close`, {
        env,
        request,
        method: "POST",
        // `force` is deliberately not offered: the checks are the gate, and a
        // screen that hands out an override turns them into a formality.
        body: { to: intent, force: false }
      });
      return { ...empty, closed: { code: row.code, state: row.state } };
    }

    if (intent === "reopen") {
      const row = await api<Period>(`/v1/ledger/periods/${encodeURIComponent(code)}/reopen`, {
        env,
        request,
        method: "POST",
        body: {}
      });
      return { ...empty, reopened: row.code };
    }

    if (intent === "rebuild") {
      // Read-only: the API calls rebuildBalances without `apply`, so this
      // compares the cache against the journal and changes nothing.
      const rows = await api<RebuildResult[]>("/v1/ledger/balances/rebuild", {
        env,
        request,
        method: "POST",
        body: {}
      });
      return {
        ...empty,
        rebuild: { total: rows.length, drifted: rows.filter((row) => row.drifted) }
      };
    }

    return { ...empty, problem: { title: "unknown intent", status: 400 } };
  } catch (error) {
    if (error instanceof ApiError) return { ...empty, problem: error.problem };
    throw error;
  }
}

export default function LedgerPeriods() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (loaded.denied) {
    return (
      <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />
    );
  }

  const { period, checks } = loaded;
  const failed = checks.filter((check) => !check.ok);
  const state = period?.state ?? "open";
  const drifted = result?.rebuild?.drifted ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {periodHeadline(period, failed.length, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("period.intro")}</p>
        </div>
      </header>

      <Form method="get" aria-label={l("period.lookup")} className="flex flex-wrap items-end gap-3">
        <Field label={l("period.code")} hint="2026-07" className="w-40">
          <Input name="period" defaultValue={loaded.code} pattern="\d{4}-\d{2}" />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
        {searchParams.get("period") ? (
          <Button asChild variant="ghost">
            <Link to="/ledger/period-close">{t("common.clear")}</Link>
          </Button>
        ) : null}
      </Form>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.closed
          ? l("period.closedNow", {
              code: result.closed.code,
              state: l(`state.${result.closed.state}`)
            })
          : result?.reopened
            ? l("period.reopened", { code: result.reopened })
            : result?.rebuild && drifted.length === 0
              ? l("period.checked", { count: result.rebuild.total })
              : ""}
      </p>

      {result?.problem ? <Problem problem={result.problem} /> : null}

      {period ? (
        <Card
          title={period.code}
          description={l("period.checks")}
          elevation="flat"
          actions={<Badge tone={periodTone(state)}>{l(`state.${state}`)}</Badge>}
        >
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("account.from")}</dt>
                <dd className="font-ui text-13 text-text">
                  <DateTime value={period.startAt} locale={locale} precision="day" />
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("account.to")}</dt>
                <dd className="font-ui text-13 text-text">
                  <DateTime value={period.endAt} locale={locale} precision="day" />
                </dd>
              </div>
              {period.closedBy ? (
                <div className="flex flex-col gap-1">
                  <dt className="font-ui text-12 text-subtle">{l("period.closedBy")}</dt>
                  <dd className="font-ui text-13 text-text">
                    {who(period.closedBy, loaded.names)}
                    {period.closedAt ? (
                      <>
                        {" · "}
                        <DateTime value={period.closedAt} locale={locale} precision="minute" />
                      </>
                    ) : null}
                  </dd>
                </div>
              ) : null}
            </dl>

            {/* What blocks the close, before anyone presses it. */}
            {failed.length > 0 ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-5"
              >
                <p className="section-title">{l("period.blocked")}</p>
                <p className="max-w-prose font-ui text-13 text-muted">{l("period.blockedBody")}</p>
                <ul className="flex flex-col gap-1">
                  {failed.map((check) => (
                    <li key={check.name} className="font-ui text-13 text-text">
                      <span className="font-ui text-13">{checkName(check.name, l)}</span>
                      {check.detail ? <span className="text-muted"> — {check.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Table<CloseCheck>
              caption={l("period.checksCaption")}
              captionHidden
              density="compact"
              rows={checks}
              rowKey={(row) => row.name}
              empty={<EmptyState title={l("period.checks")} body={l("period.blockedBody")} />}
              columns={[
                {
                  key: "name",
                  header: l("period.check"),
                  render: (row) => checkName(row.name, l)
                },
                {
                  key: "ok",
                  header: l("state"),
                  render: (row) => (
                    <Badge size="sm" tone={row.ok ? "success" : "danger"}>
                      {row.ok ? l("period.ok") : l("period.fail")}
                    </Badge>
                  )
                },
                { key: "detail", header: l("period.detail"), render: (row) => row.detail ?? l("none") }
              ]}
            />

            {loaded.canClose ? (
              <Form method="post" className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="code" value={period.code} />
                {/* Which close is legal is the period's own state machine:
                    a hard close follows a soft one, and neither follows itself. */}
                {state === "open" ? (
                  <ConfirmButton
                    type="submit"
                    name="intent"
                    value="soft_closed"
                    variant="secondary"
                    loading={busy}
                    message={l("period.closeSoftConfirm")}
                  >
                    {l("period.closeSoft")}
                  </ConfirmButton>
                ) : null}
                {state === "soft_closed" ? (
                  <ConfirmButton
                    type="submit"
                    name="intent"
                    value="hard_closed"
                    variant="danger"
                    loading={busy}
                    message={l("period.closeHardConfirm")}
                  >
                    {l("period.closeHard")}
                  </ConfirmButton>
                ) : null}
                {state !== "open" ? (
                  <ConfirmButton
                    type="submit"
                    name="intent"
                    value="reopen"
                    variant="ghost"
                    loading={busy}
                    message={l("period.reopenConfirm")}
                  >
                    {l("period.reopen")}
                  </ConfirmButton>
                ) : null}
              </Form>
            ) : null}
          </div>
        </Card>
      ) : (
        // No ?period= is a controller who has not picked one yet, not a
        // controller without the permission — the loader already answered that
        // above, and saying it twice tells a permitted user they are locked out.
        <EmptyState title={l("period.noneSelected")} body={l("period.noneSelectedBody")} />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{l("period.recent")}</h2>
        <Table<Period>
          caption={l("period.recentCaption")}
          captionHidden
          density="compact"
          rows={loaded.recent}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("period.noneRecent")} body={l("period.noneRecent.body")} />}
          columns={[
              {
                key: "code",
                header: l("period.code"),
                render: (row) => (
                  <Link
                    to={`/ledger/period-close?period=${row.code}`}
                    className="rounded-sm font-mono text-12 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                  >
                    {row.code}
                  </Link>
                )
              },
              {
                key: "state",
                header: l("state"),
                render: (row) => (
                  <Badge size="sm" tone={periodTone(row.state)}>
                    {l(`state.${row.state}`)}
                  </Badge>
                )
              },
              {
                key: "closedBy",
                header: l("period.closedBy"),
                render: (row) => who(row.closedBy, loaded.names) ?? l("none")
              },
              {
                key: "closedAt",
                header: l("when"),
                render: (row) =>
                  row.closedAt ? (
                    <DateTime value={row.closedAt} locale={locale} precision="minute" />
                  ) : (
                    l("none")
                  )
              }
            ]}
        />
      </section>

      {/* Maintenance, not money: the journal is the truth and this only reports
          where the cache disagrees with it. Gated on ledger:journals:post
          because that is what the API requires. */}
      {loaded.canRebuild ? (
        <Card title={l("period.rebuild")} elevation="flat">
          <div className="flex flex-col gap-3">
            <p className="max-w-prose font-ui text-13 text-muted">{l("period.rebuildBody")}</p>
            <Form method="post">
              <ConfirmButton
                type="submit"
                name="intent"
                value="rebuild"
                variant="secondary"
                loading={busy}
                message={l("period.rebuildConfirm")}
              >
                {l("period.rebuildSubmit")}
              </ConfirmButton>
            </Form>

            {drifted.length > 0 ? (
              <div className="flex flex-col gap-3">
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-5"
                >
                  <p className="section-title">
                    {l("period.driftedTitle", {
                      count: drifted.length,
                      total: result?.rebuild?.total ?? drifted.length
                    })}
                  </p>
                  <p className="max-w-prose font-ui text-13 text-muted">{l("period.driftedBody")}</p>
                </div>
                <DriftTable rows={drifted} locale={locale} l={l} />
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function DriftTable({
  rows,
  locale,
  l
}: {
  rows: RebuildResult[];
  locale: string;
  l: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const columns: Array<Column<RebuildResult>> = [
    {
      key: "account",
      header: l("account.code"),
      render: (row) => <span className="font-mono text-12">{row.accountCode}</span>
    },
    { key: "currency", header: l("currency"), render: (row) => row.currency },
    {
      key: "storedDebit",
      header: `${l("period.stored")} · ${l("txn.debit")}`,
      numeric: true,
      render: (row) => (
        <Money amountMinor={row.storedDebitMinor} currency={row.currency} locale={locale} />
      )
    },
    {
      key: "rebuiltDebit",
      header: `${l("period.rebuiltCol")} · ${l("txn.debit")}`,
      numeric: true,
      render: (row) => (
        <Money amountMinor={row.rebuiltDebitMinor} currency={row.currency} locale={locale} />
      )
    },
    {
      key: "storedCredit",
      header: `${l("period.stored")} · ${l("txn.credit")}`,
      numeric: true,
      render: (row) => (
        <Money amountMinor={row.storedCreditMinor} currency={row.currency} locale={locale} />
      )
    },
    {
      key: "rebuiltCredit",
      header: `${l("period.rebuiltCol")} · ${l("txn.credit")}`,
      numeric: true,
      render: (row) => (
        <Money amountMinor={row.rebuiltCreditMinor} currency={row.currency} locale={locale} />
      )
    }
  ];
  return (
    <div className="flex flex-col gap-2">
      <Table<RebuildResult>
        caption={l("period.driftCaption")}
        density="compact"
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.accountCode}|${row.currency}`}
      />
      <p className="font-ui text-12 text-subtle">{l("period.driftOnly")}</p>
    </div>
  );
}
