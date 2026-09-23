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
  GuardrailNotice,
  Ref
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { promoteToSignal, readCommentary } from "../components/whitespace-api.server";
import {
  CommentaryChip,
  CommentaryGhost,
  commentaryLabels,
  type WhitespaceCommentary
} from "../components/whitespace-commentary";
import { DraftTray, PromoteToSignal, type PromotedToSignal } from "../components/signal-handover";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  PERM,
  dotSize,
  dots,
  emptyPage,
  evidenceOf,
  explain,
  mintKey,
  refuse,
  safe,
  unplotted,
  type ClusterRow,
  type Dot,
  type Label,
  type Page,
  type Problemish,
  type WhitespaceRow
} from "./scout.shared";

// The quadrant the product decisions are argued over: openness of the market on
// the horizontal, the cluster's demand momentum on the vertical, weight of
// evidence as the dot's area. Both axes are stored columns — competition score
// on the whitespace, momentum on its cluster — so no dot is placed anywhere the
// database does not already say it belongs, and an unclustered whitespace is
// counted beside the chart rather than parked at a momentum nobody measured.
//
// Selection is a query parameter, not client state: the dossier is rendered by
// the loader, so a link to a theme is a link somebody can send.

const LIMIT = 200;

/** The one sentence the radar opens with — arithmetic over the plotted dots
 *  already on the page, no ✦ (this is not an agent's finding, CLAUDE.md §11). */
export function radarHeadline(plotted: Dot[], unplottedCount: number, l: Label): string {
  const pursue = plotted.filter((dot) => dot.fit > 50 && dot.momentum > 50).length;
  if (pursue > 0) return l("radar.headlinePursue", { n: String(pursue) });
  if (plotted.length > 0) return l("radar.headlinePlotted", { n: String(plotted.length) });
  if (unplottedCount > 0) return l("radar.headlineUnplotted", { n: String(unplottedCount) });
  return l("radar.empty");
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const selected = new URL(request.url).searchParams.get("w");

  // The commentary is read here, beside the dots, not when a pointer arrives:
  // hovering a dot must cost nothing. It is one batch keyed by the same limit
  // rather than a lookup per id, so it adds no round trip to the page.
  const [clusters, whitespaces, commentary] = await Promise.all([
    safe(
      () =>
        api<Page<ClusterRow>>(`/v1/scout/clusters?sort=momentumScore&order=desc&limit=${LIMIT}`, { env, request }),
      emptyPage<ClusterRow>()
    ),
    safe(
      () =>
        api<Page<WhitespaceRow>>(`/v1/scout/whitespaces?sort=demandEstimate&order=desc&limit=${LIMIT}`, {
          env,
          request
        }),
      emptyPage<WhitespaceRow>()
    ),
    safe(() => readCommentary({ env, request, limit: LIMIT }), emptyPage<WhitespaceCommentary>())
  ]);

  const said = new Map(commentary.data.map((row) => [row.whitespaceId, row]));
  const plotted = dots(whitespaces.data, clusters.data, selected);
  const chosen =
    whitespaces.data.find((row) => row.id === selected) ??
    whitespaces.data.find((row) => row.id === plotted[0]?.id) ??
    null;
  const cluster = chosen?.clusterId ? (clusters.data.find((row) => row.id === chosen.clusterId) ?? null) : null;

  return {
    dots: plotted.map((dot) => ({
      ...dot,
      selected: dot.id === (chosen?.id ?? null),
      commentary: said.get(dot.id) ?? null
    })),
    unplotted: unplotted(whitespaces.data, clusters.data),
    chosen,
    cluster,
    commentary: chosen ? (said.get(chosen.id) ?? null) : null,
    evidence: chosen ? evidenceOf(chosen) : null,
    // One key per load: a double-submitted sweep is one sweep.
    key: mintKey("scout-radar")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done:
    | { intent: "sweep"; candidates: number }
    | { intent: "experiment"; id: string }
    | ({ intent: "promote-signal" } & PromotedToSignal)
    | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("key") ?? "") || mintKey("scout-radar");

  try {
    if (intent === "sweep") {
      const swept = await api<{ candidates: number }>("/v1/scout/whitespaces/compute", {
        env,
        request,
        method: "POST",
        body: {},
        headers: { "idempotency-key": key }
      });
      return { problem: null, done: { intent: "sweep", candidates: swept.candidates } };
    }

    if (intent === "experiment") {
      const whitespaceId = String(form.get("whitespaceId") ?? "");
      if (whitespaceId === "") return refuse("whitespace_required");
      const created = await api<{ id: string }>("/v1/scout/scout-experiments", {
        env,
        request,
        method: "POST",
        // Draft is the schema default and it is the point: creating the
        // experiment commits nothing, starting it does.
        body: { whitespaceId },
        headers: { "idempotency-key": key }
      });
      return { problem: null, done: { intent: "experiment", id: created.id } };
    }

    if (intent === "promote-signal") {
      const whitespaceId = String(form.get("whitespaceId") ?? "");
      if (whitespaceId === "") return refuse("whitespace_required");
      // Consequential: the answer may be "queued", and the UI says so rather
      // than claiming the campaign exists (CLAUDE.md §4).
      const handed = await promoteToSignal({ env, request, whitespaceId, key });
      return { problem: null, done: { intent: "promote-signal", ...handed } };
    }

    return refuse("bad_intent");
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function ScoutRadar() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = commentaryLabels(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const chosen = loaded.chosen;
  const number = (value: number) => value.toLocaleString(locale);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {radarHeadline(loaded.dots, loaded.unplotted, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("radar.lede")}</p>
        </div>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done?.intent === "sweep" ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("radar.swept", { n: number(result.done.candidates) })}
        </p>
      ) : null}
      {result?.done?.intent === "experiment" ? (
        <p role="status" className="flex flex-wrap items-center gap-3 font-ui text-13 text-success">
          {l("radar.created")}
          <Link to="/scout/experiments" className="text-accent underline underline-offset-2">
            {l("radar.openBoard")}
          </Link>
        </p>
      ) : null}
      {result?.done?.intent === "promote-signal" ? (
        <DraftTray
          promoted={result.done}
          mayOpen={shell?.availableShells.includes("signal") ?? false}
          l={l}
          locale={locale}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          {loaded.dots.length === 0 ? (
            <EmptyState title={l("radar.empty")} body={l("radar.empty.body")} />
          ) : (
            <Quadrant dots={loaded.dots} l={l} locale={locale} />
          )}
          <p className="mt-8 font-ui text-12 text-subtle">{l("radar.axisY")}</p>
          {loaded.unplotted > 0 ? (
            <p className="mt-2 font-ui text-12 text-subtle">
              <EvidenceLink source={l("radar.unplottedWhy")} sourceLabel={l("why")}>
                {l("radar.unplotted", { n: number(loaded.unplotted) })}
              </EvidenceLink>
            </p>
          ) : null}
        </Card>

        <Card title={l("radar.dossier")}>
          {chosen === null ? (
            <EmptyState title={l("radar.pick")} body={l("radar.pick.body")} />
          ) : (
            <div className="flex flex-col gap-3">
              <h2 className="eyebrow">
                {loaded.cluster?.theme ?? chosen.description}
              </h2>

              {loaded.cluster?.summary ? (
                // The summary is written by the clusterer, so it carries the mark
                // and its own count of what it read (CLAUDE.md §11).
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

              {/* A commentary that only restates the description says it once. */}
              {loaded.commentary?.commentary?.trim() === chosen.description.trim() ? null : (
                <p className="font-ui text-13 leading-relaxed text-text">{chosen.description}</p>
              )}

              <CommentaryChip commentary={loaded.commentary} l={l} locale={locale} />

              <dl className="grid grid-cols-2 gap-2">
                <Metric label={l("radar.demand")} value={chosen.demandEstimate === null ? l("none") : number(chosen.demandEstimate)} />
                <Metric
                  label={l("radar.competition")}
                  value={chosen.competitionScore === null ? l("none") : `${number(chosen.competitionScore)}%`}
                />
                <Metric
                  label={l("radar.momentum")}
                  value={loaded.cluster === null ? l("none") : `${number(loaded.cluster.momentumScore)}%`}
                  tone="text-success"
                />
                <Metric label={l("radar.signals")} value={loaded.cluster === null ? l("none") : number(loaded.cluster.size)} />
              </dl>

              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" size="sm">
                  {l(`status.${chosen.status}`)}
                </Badge>
                {chosen.promotedAt === null ? null : (
                  <span className="font-ui text-12 text-subtle">
                    <DateTime value={chosen.promotedAt} locale={locale} />
                  </span>
                )}
              </div>

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
                <ul className="flex flex-wrap gap-2">
                  {loaded.evidence.refs.map((ref) => (
                    <li key={ref} className="rounded-sm border border-line px-2 py-1 font-mono text-12 text-subtle">
                      <Ref value={ref} />
                    </li>
                  ))}
                </ul>
              ) : null}

              <Link
                to={`/scout/whitespace/${encodeURIComponent(chosen.id)}`}
                className="font-ui text-13 text-accent underline-offset-2 hover:underline"
              >
                {l("radar.openCard")}
              </Link>

              {may.has(PERM.experimentsCreate) ? (
                <Form method="post" className="flex flex-col gap-2 border-t border-line pt-3">
                  <input type="hidden" name="intent" value="experiment" />
                  <input type="hidden" name="key" value={loaded.key} />
                  <input type="hidden" name="whitespaceId" value={chosen.id} />
                  <Button type="submit" disabled={busy}>
                    {l("radar.experiment")}
                  </Button>
                  <span className="font-ui text-12 text-subtle">{l("radar.experimentHint")}</span>
                </Form>
              ) : null}

              <PromoteToSignal
                whitespaceId={chosen.id}
                formKey={loaded.key}
                may={may.has(PERM.whitespacesPromote)}
                busy={busy}
                l={l}
              />
            </div>
          )}
        </Card>
      </div>

      {may.has(PERM.whitespacesPromote) ? (
        <Card title={l("radar.sweep")} description={l("radar.sweepHint")}>
          <Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="sweep" />
            <input type="hidden" name="key" value={loaded.key} />
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("radar.sweep")}
            </Button>
          </Form>
        </Card>
      ) : (
        <GuardrailNotice tone="info" title={l("radar.sweep")} reason={l("radar.sweepHint")} />
      )}

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/panel" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("panel.title")}
        </Link>
        <Link to="/scout/experiments" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("xp.title")}
        </Link>
      </footer>
    </div>
  );
}

/**
 * A 2×2 read of the pipeline. Dots are links so the dossier survives a reload
 * and keyboard order follows the list order; the theme name is inside the link,
 * which is what gives each dot its accessible name.
 */
function Quadrant({
  dots: plotted,
  l,
  locale
}: {
  dots: (Dot & { commentary: WhitespaceCommentary | null })[];
  l: Label;
  locale: string;
}) {
  return (
    <div className="pb-10">
      <div className="relative h-[370px] border-b border-s border-line">
        <div className="absolute end-0 start-0 top-1/2 border-t border-dashed border-line" />
        <div className="absolute bottom-0 start-1/2 top-0 border-s border-dashed border-line" />
        <span className="absolute end-2 top-2 font-ui text-12 uppercase tracking-widest text-subtle">
          {l("radar.pursue")}
        </span>
        <span className="absolute bottom-2 start-2 font-ui text-12 uppercase tracking-widest text-subtle">
          {l("radar.park")}
        </span>
        {/* A list because it is one — the themes, in the order a keyboard
            walks them — laid over the quadrant rather than beside it. */}
        <ul className="absolute inset-0">
          {plotted.map((dot) => (
            // The `group` is the wrapper, not the link, so pointer and keyboard
            // reveal the same commentary: hover on the group, focus-within for
            // the link inside it. The wrapper is the zero-width anchor and centres
            // its children on the point in both writing directions, which a
            // -translate-x-1/2 would not; the link itself carries the label's
            // width, because a zero-width box reads as `hidden` to a pointer and
            // to Playwright even while its overflowing children paint and click.
            <li
              key={dot.id}
              className="group absolute flex w-0 flex-col items-center"
              style={{ insetInlineStart: `${dot.fit}%`, bottom: `${dot.momentum}%` }}
            >
              <Link
                to={`/scout/radar?w=${encodeURIComponent(dot.id)}`}
                aria-current={dot.selected ? "true" : undefined}
                // The commentary is the dot's description, so a screen reader
                // reads it on focus — a hover-only reveal would be information
                // only a mouse can reach.
                aria-describedby={dot.selected || dot.commentary === null ? undefined : `wc-${dot.id}`}
                className="flex w-28 flex-col items-center gap-1"
              >
                <span
                  aria-hidden="true"
                  className={`block rounded-full border-2 border-module-scout ${dot.selected ? "bg-module-scout" : ""}`}
                  style={{ width: dotSize(dot.evidence), height: dotSize(dot.evidence) }}
                />
                {/* Bounded and wrapped, not `whitespace-nowrap`: a theme called
                    "Agency repair lost at renewal" ran a single line straight
                    across its neighbours' dots. Two lines, then the title. */}
                <span
                  title={dot.label}
                  className={`line-clamp-2 w-28 text-center font-ui text-12 ${dot.selected ? "text-text" : "text-subtle"}`}
                >
                  {dot.label}
                </span>
              </Link>
              {/* The selected dot's reading is already the dossier beside the
                  chart, chip and evidence both; a hover card over the dot would
                  print the same sentence a second time on one screen. */}
              {dot.selected ? null : (
                <CommentaryGhost
                  id={`wc-${dot.id}`}
                  commentary={dot.commentary}
                  side={dot.momentum > 65 ? "below" : "above"}
                  l={l}
                  locale={locale}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-center font-ui text-12 text-subtle">{l("radar.axisX")}</p>
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
