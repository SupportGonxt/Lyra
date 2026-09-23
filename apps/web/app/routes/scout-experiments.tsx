import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, Card, DateTime, EmptyState, Field, Ref, Select, Table, type Column } from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  DECISIONS,
  PERM,
  emptyPage,
  explain,
  labelsIn,
  mintKey,
  planOf,
  refuse,
  resultsOf,
  safe,
  verdictKey,
  type Decision,
  type ExperimentRow,
  type Label,
  type Page,
  type Problemish,
  type WhitespaceRow
} from "./scout.shared";

// The board of bounded bets. A promoted whitespace does not become a product; it
// becomes an experiment with a written stop rule and a daily cap, and this is
// where the answer gets recorded.
//
// Concluding one is a decision about what the business builds, so it is a write
// against `scout:experiments:decide` with an idempotency key and it lands in the
// audit log under a name. There is no numeric gate on the row — the stop rule is
// prose a person wrote — so nothing here renders a running experiment as "on
// track": it renders it as running, and the verdict comes from the results blob
// once somebody concludes it.
//
// The whitespace list is loaded beside the experiments only to name them: a
// board whose rows read `sws_01K…` is a board nobody can decide from.

const LIMIT = 200;

/** The one sentence the board opens with — the state already on every row, no
 *  ✦ (arithmetic, not an agent's finding, CLAUDE.md §11). */
export function experimentsHeadline(rows: ExperimentRow[], l: Label): string {
  if (rows.length === 0) return l("xp.empty");
  const running = rows.filter((row) => row.state === "running").length;
  if (running > 0) return l("xp.headlineRunning", { n: String(running), total: String(rows.length) });
  return l("xp.headlineCount", { n: String(rows.length) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;

  const [experiments, whitespaces] = await Promise.all([
    safe(
      () =>
        api<Page<ExperimentRow>>(`/v1/scout/scout-experiments?sort=createdAt&order=desc&limit=${LIMIT}`, {
          env,
          request
        }),
      emptyPage<ExperimentRow>()
    ),
    safe(
      () => api<Page<WhitespaceRow>>(`/v1/scout/whitespaces?limit=${LIMIT}`, { env, request }),
      emptyPage<WhitespaceRow>()
    )
  ]);

  const described = Object.fromEntries(whitespaces.data.map((row) => [row.id, row.description]));
  return {
    rows: experiments.data,
    described,
    // One key per load: a double-submitted decision is one decision.
    key: mintKey("scout-xp")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: { id: string; state: Decision } | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const key = String(form.get("key") ?? "") || mintKey("scout-xp");

  if (String(form.get("intent") ?? "") !== "decide") return refuse("bad_intent");

  const id = String(form.get("id") ?? "");
  if (id === "") return refuse("experiment_required");

  const state = String(form.get("state") ?? "");
  // The picker only offers three, so anything else is a hand-built request.
  if (!DECISIONS.some((allowed) => allowed === state)) return refuse("state_required");

  try {
    await api<ExperimentRow>(`/v1/scout/scout-experiments/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      body: { state },
      headers: { "idempotency-key": key }
    });
    return { problem: null, done: { id, state: state as Decision } };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function ScoutExperiments() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{experimentsHeadline(loaded.rows, l)}</h1>
          <p className="font-ui text-13 text-muted">{l("xp.lede")}</p>
        </div>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}

      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("xp.decided")}
        </p>
      ) : null}

      <Card>
        {loaded.rows.length === 0 ? (
          <EmptyState title={l("xp.empty")} body={l("xp.empty.body")} />
        ) : (
          <Table
            caption={l("xp.title")}
            captionHidden
            rowKey={(row) => row.id}
            rows={loaded.rows}
            columns={experimentColumns(l, locale, loaded.described)}
          />
        )}
      </Card>

      <p className="max-w-prose font-ui text-12 text-subtle">{l("xp.footnote")}</p>

      {may.has(PERM.experimentsDecide) && loaded.rows.length > 0 ? (
        <Card title={l("xp.decide")} description={l("xp.decideHint")}>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="decide" />
            <input type="hidden" name="key" value={loaded.key} />
            <Field label={l("xp.pick")} required>
              <Select
                name="id"
                defaultValue={loaded.rows[0]?.id ?? ""}
                options={loaded.rows.map((row) => ({
                  value: row.id,
                  label: nameOf(row, loaded.described)
                }))}
              />
            </Field>
            <Field label={l("xp.newState")} required>
              <Select
                name="state"
                defaultValue="concluded"
                options={DECISIONS.map((state) => ({ value: state, label: l(`xp.${stateKey(state)}`) }))}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {l("xp.decide")}
            </Button>
          </Form>
        </Card>
      ) : null}

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/radar" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("xp.openRadar")}
        </Link>
      </footer>
    </div>
  );
}

/** `abandoned` is shown as "Parked" — the copy the rest of SCOUT uses, because
 *  stopping an experiment is not a failure (docs/07 §SCOUT). */
const stateKey = (state: Decision): string => (state === "abandoned" ? "parked" : state);

/** The whitespace this experiment tests, or the id when it is not on the page. */
const nameOf = (row: ExperimentRow, described: Record<string, string>): string =>
  described[row.whitespaceId] ?? row.whitespaceId;

export function experimentColumns(
  l: Label,
  locale: string,
  described: Record<string, string> = {}
): Array<Column<ExperimentRow>> {
  const count = (value: number | undefined) => (value === undefined ? l("none") : value.toLocaleString(locale));
  return [
    {
      key: "experiment",
      header: l("xp.experiment"),
      render: (row) => (
        <span className="flex flex-col gap-1">
          <span className="font-ui text-13 text-text">{nameOf(row, described)}</span>
          <Ref value={row.id} />
        </span>
      )
    },
    {
      key: "since",
      header: l("xp.since"),
      render: (row) => (row.startedAt === null ? l("none") : <DateTime value={row.startedAt} locale={locale} />)
    },
    {
      key: "gate",
      header: l("xp.gate"),
      render: (row) => {
        const plan = planOf(row);
        if (!plan.stopRule && plan.dailyCapMinor === undefined) return l("xp.noPlan");
        return (
          <span className="flex flex-col gap-1">
            <span className="font-ui text-13 text-text">{plan.stopRule ?? l("xp.noPlan")}</span>
            {plan.dailyCapMinor === undefined ? null : (
              <span className="font-ui text-12 text-subtle">
                {l("xp.cap", {
                  amount: (plan.dailyCapMinor / 100).toLocaleString(locale, { minimumFractionDigits: 2 }),
                  currency: plan.currency ?? "ZAR",
                  days: String(plan.maxDays ?? 0)
                })}
              </span>
            )}
          </span>
        );
      }
    },
    {
      key: "quotes",
      header: l("xp.quotes"),
      numeric: true,
      render: (row) => count(resultsOf(row).quoteStarts)
    },
    {
      key: "waitlist",
      header: l("xp.waitlist"),
      numeric: true,
      render: (row) => count(resultsOf(row).waitlist)
    },
    {
      key: "verdict",
      header: l("xp.verdict"),
      render: (row) => {
        const verdict = verdictKey(row);
        return (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={verdict.tone} size="sm">
              {l(verdict.key)}
            </Badge>
            {resultsOf(row).interim ? (
              <span className="font-ui text-12 text-subtle">{l("xp.interim")}</span>
            ) : null}
          </span>
        );
      }
    }
  ];
}
