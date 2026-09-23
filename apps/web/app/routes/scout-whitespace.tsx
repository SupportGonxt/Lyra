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
  AGENT_MARK,
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  GuardrailNotice,
  Input,
  Ref,
  Select
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { jsonOf } from "../json.js";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  PERM,
  emptyPage,
  evidenceOf,
  explain,
  labelsIn,
  mintKey,
  planOf,
  refuse,
  resultsOf,
  safe,
  verdictKey,
  type ClusterRow,
  type ExperimentRow,
  type Label,
  type Page,
  type Problemish,
  type WhitespaceRow
} from "./scout.shared";

// The card behind a dot on the radar (docs/modules/scout.md §4 screen 2): one
// whitespace, everything that argues for it, and the only place its state is
// moved. Nothing here is computed for display — the evidence, the estimate and
// the regulatory flags are stored columns, the experiment results are the
// experiment's own JSON, and the decision log is the audit log filtered to this
// row's id. A regulatory flag says an item appeared and who has to read it; it
// never says what the item requires (compliance copy comes from docs/12).

const SIGNALS = 25;
const EXPERIMENTS = 20;
const DECISIONS = 25;

/** The states a card is stored in. Not a DB enum — scout_whitespaces.status is
 *  text, and `promoted` is written by the promote journey (apps/api journeys
 *  test) alongside the four the schema comment lists. */
export const WHITESPACE_STATES = ["candidate", "validating", "validated", "promoted", "parked"] as const;

/**
 * Where a card may go from where it is. One way down the funnel, park from
 * anywhere, and a parked card comes back as a candidate rather than jumping
 * straight back to the state it was parked from — the evidence has aged.
 */
export function nextWhitespaceStates(from: string): string[] {
  switch (from) {
    case "candidate":
      return ["validating", "parked"];
    case "validating":
      return ["validated", "parked"];
    case "validated":
      return ["promoted", "parked"];
    case "promoted":
      return ["parked"];
    case "parked":
      return ["candidate"];
    default:
      return [];
  }
}

/** scout_signals, the columns this screen reads, as generic CRUD returns them
 *  — see `r("signals", …)` in apps/api/src/resources.ts. */
export interface SignalRow {
  id: string;
  source: string;
  sourceRef: string | null;
  /** Already parsed on the wire — see `jsonOf`. */
  payloadJson: unknown;
  weight: number;
  observedAt: number;
}

/** core_audit_log — crud.ts writes the row's own id as `subjectRef`. */
export interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

export interface Flag {
  id: string;
  title: string;
  state: string | null;
  routedTo: string | null;
  note: string | null;
  ref: string | null;
  observedAt: number;
}

/**
 * A regulatory signal's readable line. The harvester's payload is free JSON, so
 * a row with nothing readable in it falls back to its source reference rather
 * than being dropped — a flag nobody can render is still a flag.
 */
export function flagOf(row: SignalRow): Flag {
  const parsed = jsonOf(row.payloadJson);
  const payload: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const text = (key: string): string | null => (typeof payload[key] === "string" ? (payload[key] as string) : null);
  return {
    id: row.id,
    title: text("title") ?? row.sourceRef ?? row.id,
    state: text("state"),
    routedTo: text("routedTo"),
    note: text("note"),
    ref: row.sourceRef,
    observedAt: row.observedAt
  };
}

/** The card's own lede — flag and experiment counts already on the loader, no
 *  ✦ (arithmetic, not an agent's finding, CLAUDE.md §11). */
export function wspLede(flagCount: number, experimentCount: number, l: Label): string {
  if (flagCount > 0 && experimentCount > 0)
    return l("wsp.ledeBoth", { flags: String(flagCount), experiments: String(experimentCount) });
  if (flagCount > 0) return l("wsp.ledeFlags", { flags: String(flagCount) });
  if (experimentCount > 0) return l("wsp.ledeExperiments", { experiments: String(experimentCount) });
  return l("wsp.lede");
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  const options = { env, request };
  const path = `/v1/scout/whitespaces/${encodeURIComponent(id)}`;

  const card = await safe(() => api<WhitespaceRow>(path, options), null);

  const [cluster, signals, experiments, decisions] = await Promise.all([
    card?.clusterId
      ? safe(() => api<ClusterRow>(`/v1/scout/clusters/${encodeURIComponent(card.clusterId!)}`, options), null)
      : null,
    card?.clusterId
      ? safe(
          () =>
            api<Page<SignalRow>>(
              `/v1/scout/signals?clusterId=${encodeURIComponent(card.clusterId!)}&source=regulatory&sort=observedAt&order=desc&limit=${SIGNALS}`,
              options
            ),
          emptyPage<SignalRow>()
        )
      : emptyPage<SignalRow>(),
    card
      ? safe(
          () =>
            api<Page<ExperimentRow>>(
              `/v1/scout/scout-experiments?whitespaceId=${encodeURIComponent(id)}&sort=createdAt&order=desc&limit=${EXPERIMENTS}`,
              options
            ),
          emptyPage<ExperimentRow>()
        )
      : emptyPage<ExperimentRow>(),
    // A withheld audit read costs the decision log, not the page.
    card
      ? safe(
          () =>
            api<Page<AuditRow>>(
              `/v1/core/audit-log?subjectRef=${encodeURIComponent(id)}&sort=ts&order=desc&limit=${DECISIONS}`,
              options
            ),
          null
        )
      : null
  ]);

  return {
    card,
    cluster,
    evidence: card ? evidenceOf(card) : null,
    flags: signals.data.map(flagOf),
    experiments: experiments.data,
    decisions: decisions === null ? null : decisions.data,
    moves: card ? nextWhitespaceStates(card.status) : [],
    key: mintKey("scout-whitespace")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: { intent: "move"; status: string } | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("key") ?? "") || mintKey("scout-whitespace");

  if (intent !== "move") return refuse("bad_intent");

  const id = String(form.get("whitespaceId") ?? "");
  if (id === "") return refuse("whitespace_required");

  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  if (!nextWhitespaceStates(from).includes(to)) return refuse("transition_required");

  const owner = String(form.get("owner") ?? "").trim();

  try {
    await api<WhitespaceRow>(`/v1/scout/whitespaces/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      // `promotedAt` is the client's to set — apps/api/src/journeys.test.ts
      // promotes with the stamp in the same body — and only a promote sets it.
      body: {
        status: to,
        ...(to === "promoted" ? { promotedAt: Date.now() } : {}),
        ...(owner === "" ? {} : { owner })
      },
      headers: { "idempotency-key": key }
    });
    return { problem: null, done: { intent: "move", status: to } };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function ScoutWhitespace() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const number = (value: number) => value.toLocaleString(locale);
  const card = loaded.card;

  if (card === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="page-title">{l("wsp.title")}</h1>
        <EmptyState title={l("wsp.missing")} body={l("wsp.missing.body")} />
        <Link to="/scout/radar" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("wsp.openRadar")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="eyebrow">{l("wsp.title")}</p>
          <h1 className="page-title">{loaded.cluster?.theme ?? card.description}</h1>
          <p className="font-ui text-13 text-muted">{wspLede(loaded.flags.length, loaded.experiments.length, l)}</p>
        </div>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("wsp.moved", { status: l(`status.${result.done.status}`) })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card title={l("wsp.case")}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" size="sm">
                  {l(`status.${card.status}`)}
                </Badge>
                {card.category ? <span className="font-ui text-12 text-subtle">{card.category}</span> : null}
                {card.owner ? (
                  <span className="font-ui text-12 text-subtle">
                    {l("owner")}: {card.owner}
                  </span>
                ) : null}
                {card.promotedAt === null ? null : (
                  <span className="font-ui text-12 text-subtle">
                    {l("wsp.promotedOn")} <DateTime value={card.promotedAt} locale={locale} />
                  </span>
                )}
              </div>

              <p className="font-ui text-13 leading-relaxed text-text">{card.description}</p>

              {loaded.cluster?.summary ? (
                <p className="font-ui text-13 leading-relaxed text-muted">
                  <EvidenceLink
                    source={l("radar.summaryWhy", { n: number(loaded.cluster.size) })}
                    sourceLabel={l("why")}
                    className="me-2"
                  >
                    <span aria-hidden="true">{AGENT_MARK}</span>
                  </EvidenceLink>
                  {loaded.cluster.summary}
                </p>
              ) : null}

              <dl className="grid grid-cols-2 gap-2">
                <Metric
                  label={l("radar.demand")}
                  value={card.demandEstimate === null ? l("none") : number(card.demandEstimate)}
                />
                <Metric
                  label={l("radar.competition")}
                  value={card.competitionScore === null ? l("none") : `${number(card.competitionScore)}%`}
                />
                <Metric
                  label={l("radar.momentum")}
                  value={loaded.cluster === null ? l("none") : `${number(loaded.cluster.momentumScore)}%`}
                  tone="text-success"
                />
                <Metric
                  label={l("radar.signals")}
                  value={loaded.cluster === null ? l("none") : number(loaded.cluster.size)}
                />
              </dl>

              {loaded.evidence?.demandEstimate ? (
                <dl className="flex flex-col gap-1 border-t border-line pt-3 font-ui text-12 text-muted">
                  <Line label={l("method")} value={loaded.evidence.demandEstimate.method ?? l("none")} />
                  <Line label={l("confidence")} value={loaded.evidence.demandEstimate.confidence ?? l("none")} />
                  {loaded.evidence.demandEstimate.note ? (
                    <dd className="text-subtle">{loaded.evidence.demandEstimate.note}</dd>
                  ) : null}
                </dl>
              ) : null}

              {loaded.evidence?.refs?.length ? (
                <div className="flex flex-col gap-2 border-t border-line pt-3">
                  <span className="font-ui text-12 text-subtle">{l("evidence")}</span>
                  <ul className="flex flex-wrap gap-2">
                    {loaded.evidence.refs.map((ref) => (
                      <li key={ref} className="rounded-sm border border-line px-2 py-1 font-mono text-12 text-subtle">
                        <Ref value={ref} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title={l("wsp.experiments")} description={l("wsp.experimentsHint")}>
            {loaded.experiments.length === 0 ? (
              <EmptyState title={l("wsp.noExperiments")} body={l("wsp.noExperiments.body")} />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {loaded.experiments.map((row) => {
                  const verdict = verdictKey(row);
                  const results = resultsOf(row);
                  const plan = planOf(row);
                  return (
                    <li key={row.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={verdict.tone} size="sm">
                          {l(verdict.key)}
                        </Badge>
                        <span className="font-mono text-12 text-subtle">
                          <Ref value={row.id} />
                        </span>
                        {row.startedAt === null ? null : (
                          <span className="font-ui text-12 text-subtle">
                            {l("xp.since")} <DateTime value={row.startedAt} locale={locale} />
                          </span>
                        )}
                      </div>
                      <dl className="flex flex-wrap gap-4 font-ui text-12 text-muted">
                        <Line
                          label={l("xp.quotes")}
                          value={results.quoteStarts === undefined ? l("none") : number(results.quoteStarts)}
                        />
                        <Line
                          label={l("xp.waitlist")}
                          value={results.waitlist === undefined ? l("none") : number(results.waitlist)}
                        />
                        <Line label={l("xp.gate")} value={plan.stopRule ?? l("xp.noPlan")} />
                      </dl>
                      {results.note ? <p className="font-ui text-12 text-subtle">{results.note}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <Link
              to="/scout/experiments"
              className="mt-3 inline-block font-ui text-13 text-accent underline-offset-2 hover:underline"
            >
              {l("radar.openBoard")}
            </Link>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title={l("wsp.flags")} description={l("wsp.flagsHint")}>
            {loaded.flags.length === 0 ? (
              <EmptyState title={l("wsp.noFlags")} body={l("wsp.noFlags.body")} />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {loaded.flags.map((flag) => (
                  <li key={flag.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <span className="font-ui text-13 text-text">{flag.title}</span>
                    <span className="font-ui text-12 text-subtle">
                      <DateTime value={flag.observedAt} locale={locale} />
                      {flag.state ? ` · ${flag.state}` : ""}
                      {flag.routedTo ? ` · ${flag.routedTo}` : ""}
                    </span>
                    {flag.note ? <p className="font-ui text-12 text-muted">{flag.note}</p> : null}
                    {flag.ref ? (
                      <span className="font-mono text-12 text-subtle">
                        <Ref value={flag.ref} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={l("wsp.decisions")} description={l("wsp.decisionsHint")}>
            {loaded.decisions === null ? (
              <EmptyState title={l("wsp.decisionsWithheld")} body={l("wsp.decisionsWithheld.body")} />
            ) : loaded.decisions.length === 0 ? (
              <EmptyState title={l("wsp.noDecisions")} body={l("wsp.noDecisions.body")} />
            ) : (
              <ul className="flex flex-col gap-2">
                {loaded.decisions.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-2 font-ui text-12">
                    <span className="text-text">{row.action}</span>
                    <span className="text-subtle">{row.actorRef}</span>
                    <span className="text-subtle">
                      <DateTime value={row.ts} locale={locale} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {may.has(PERM.whitespacesPromote) ? (
        <Card title={l("wsp.move")} description={l("wsp.moveHint")}>
          {loaded.moves.length === 0 ? (
            <EmptyState title={l("wsp.noMoves")} body={l("wsp.noMoves.body")} />
          ) : (
            <Form method="post" className="mt-2 flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="move" />
              <input type="hidden" name="key" value={loaded.key} />
              <input type="hidden" name="whitespaceId" value={card.id} />
              <input type="hidden" name="from" value={card.status} />
              <Field label={l("wsp.target")} id="to">
                <Select
                  name="to"
                  defaultValue={loaded.moves[0] ?? ""}
                  options={loaded.moves.map((state) => ({ value: state, label: l(`status.${state}`) }))}
                />
              </Field>
              <Field label={l("owner")} id="owner" hint={l("wsp.ownerHint")}>
                <Input name="owner" defaultValue={card.owner ?? ""} />
              </Field>
              <Button type="submit" disabled={busy}>
                {l("wsp.move")}
              </Button>
            </Form>
          )}
        </Card>
      ) : (
        <GuardrailNotice tone="info" title={l("wsp.move")} reason={l("wsp.moveDenied")} />
      )}

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/radar" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("wsp.openRadar")}
        </Link>
        <Link to="/scout/panel" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("panel.title")}
        </Link>
        {/* The finding was retyped into a brief by hand; this carries it over.
            SIGNAL is its own shell post-fork (ADR-0061) — a scout-only actor
            has no availableShells entry for it and would 403 on click, so the
            link only renders when the current actor can actually land there. */}
        {shell?.availableShells.includes("signal") ? (
          <Link
            to={`/signal/studio?opportunityId=${encodeURIComponent(card.id)}`}
            className="font-ui text-13 text-accent underline-offset-2 hover:underline"
          >
            {l("wsp.draftCreative")}
          </Link>
        ) : null}
      </footer>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <dt className="font-ui text-12 text-subtle">{label}</dt>
      <dd className={`mt-1 font-mono text-16 ${tone ?? "text-text"}`}>{value}</dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="text-subtle">{label}</dt>
      <dd className="text-muted">{value}</dd>
    </div>
  );
}
