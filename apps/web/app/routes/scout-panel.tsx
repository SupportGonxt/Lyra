import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, Card, EmptyState, GuardrailNotice, Table, type Column } from "@lyra/ui";
import { ApiError, apiFetch, api, names } from "../api.server";
import { cloudflare } from "../context";
import { who } from "../names";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  K_FLOOR,
  PERM,
  deltaPct,
  emptyPage,
  explain,
  indexText,
  inPeriod,
  labelsIn,
  latestPeriod,
  positionOf,
  rollByProvider,
  refuse,
  safe,
  type Label,
  type Page,
  type PanelRow,
  type Problemish,
  type ProviderRoll
} from "./scout.shared";

// Where each counterparty sits on price and conversion, for the newest period on
// the bench. Every figure is a volume weighting of scout_panel_bench — share of
// the period's volume, weighted win rate, weighted index against the panel
// median — so a provider with one thin line does not read like a market.
//
// The negotiation pack is proxied through this action rather than linked at the
// API origin: it is an audited PDF export of counterparty numbers, and proxying
// keeps the session cookie server-only the way the rest of this app does.
//
// Commission is deliberately absent. The mockup asks for it beside price and win
// rate, but scout_panel_bench has no commission column and distribution's
// commission ledger is another module's data — inventing the number here would
// be worse than the gap.

const LIMIT = 200;

/** The one sentence the bench opens with — volume-weighted index already on
 *  every roll, no ✦ (arithmetic, not an agent's finding, CLAUDE.md §11). */
export function panelHeadline(rolls: ProviderRoll[], l: Label): string {
  if (rolls.length === 0) return l("panel.title");
  const cheaper = rolls.filter(
    (roll) => positionOf(deltaPct(roll.ourIdx, roll.marketIdx)).key === "panel.cheaper"
  ).length;
  if (cheaper > 0) return l("panel.headlineCheaper", { n: String(cheaper), total: String(rolls.length) });
  return l("panel.headlineCount", { n: String(rolls.length) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const bench = await safe(
    () => api<Page<PanelRow>>(`/v1/scout/panel-bench?sort=period&order=desc&limit=${LIMIT}`, { env, request }),
    emptyPage<PanelRow>()
  );
  // docs/27 P2 K_FLOOR follow-up: the resolved tenant value, not the compiled
  // default — falls back to it on a permission or network failure, same as
  // every other best-effort read on this loader.
  const kFloor = await safe(
    () => api<{ kFloor: number }>("/v1/scout/config", { env, request }).then((r) => r.kFloor),
    K_FLOOR
  );

  const period = latestPeriod(bench.data);
  const rows = inPeriod(bench.data, period);
  const rolls = rollByProvider(rows);
  // A bench row carries a provider id and no carrier name, so the column
  // headed CARRIER was six ULIDs (ADR-0048).
  const resolved = await names(
    rolls.map((roll) => roll.providerId),
    { env, request }
  );
  return { period, rolls, resolved, thin: bench.data.length === 0, kFloor };
}

export interface ActionResult {
  problem: Problemish | null;
  done: { intent: "rebuild"; cells: number; created: number; updated: number } | null;
}

/** The pack is a stream, so success is the file and failure is a problem. The
 *  rebuild answers in the ordinary shape. */
export async function action({ request, context }: ActionFunctionArgs): Promise<Response | ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "pack" && intent !== "rebuild") return refuse("bad_intent");

  if (intent === "rebuild") {
    try {
      // The Bench Builder (docs/modules/scout.md §3) runs nightly; this is the
      // same sweep on demand. Idempotent at the engine — a cell is keyed
      // (provider, line, period) and updated in place — so a second press
      // rewrites the same numbers rather than doubling anything.
      const report = await api<{ cells: number; created: number; updated: number }>("/v1/scout/panel-bench/sweep", {
        env,
        request,
        method: "POST",
        body: {}
      });
      // Named rather than spread: the engine's report carries more than this
      // screen renders, and a `done` that quietly widens with the wire is how a
      // component ends up reading a field nobody declared.
      return {
        problem: null,
        done: { intent: "rebuild", cells: report.cells, created: report.created, updated: report.updated }
      };
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }
  }

  try {
    const upstream = await apiFetch("/v1/scout/panel-bench/negotiation-pack", { env, request });
    // Relay the API's own disposition and no-store: it decided the filename and
    // that this document must not be cached.
    const headers = new Headers();
    for (const name of ["content-type", "content-disposition", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function ScoutPanel() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const problem = result && "problem" in result ? result.problem : null;
  const done = result && "done" in result ? result.done : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{panelHeadline(loaded.rolls, l)}</h1>
          <p className="font-ui text-13 text-muted">{l("panel.lede", { period: loaded.period ?? l("none") })}</p>
        </div>
      </header>

      {problem ? <Gate problem={explain(problem, l)} l={l} /> : null}

      <Card>
        {loaded.rolls.length === 0 ? (
          <EmptyState title={l("panel.empty")} body={l("panel.empty.body")} />
        ) : (
          <Table
            caption={l("panel.title")}
            captionHidden
            rowKey={(roll) => roll.providerId}
            rows={loaded.rolls}
            columns={panelColumns(l, locale, loaded.resolved)}
          />
        )}
      </Card>

      <GuardrailNotice
        tone="info"
        title={l("kFloor")}
        reason={l("kFloorWhy", { k: String(loaded.kFloor) })}
      />

      {may.has(PERM.panelBuild) ? (
        <Card title={l("panel.rebuild")} description={l("panel.rebuildHint")}>
          {done ? (
            <p className="mt-2 font-ui text-13 text-muted">
              {l("panel.rebuilt", { cells: String(done.cells), created: String(done.created) })}
            </p>
          ) : null}
          <Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="rebuild" />
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("panel.rebuild")}
            </Button>
          </Form>
        </Card>
      ) : (
        <GuardrailNotice tone="info" title={l("panel.rebuild")} reason={l("panel.rebuildDenied")} />
      )}

      {may.has(PERM.whitespacesPromote) ? (
        <Card title={l("panel.pack")} description={l("panel.packHint")}>
          <Form method="post" reloadDocument className="mt-2">
            <input type="hidden" name="intent" value="pack" />
            <Button type="submit" disabled={busy}>
              {l("panel.pack")}
            </Button>
          </Form>
        </Card>
      ) : (
        <GuardrailNotice tone="info" title={l("panel.pack")} reason={l("panel.packDenied")} />
      )}

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/pricing" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("panel.openPricing")}
        </Link>
        <Link to="/scout/analytics" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("an.title")}
        </Link>
        {/* J-P2 ends with the delta logged: the rate table the negotiation
            changes, proposed here and approved by finance. */}
        <Link to="/distribution/commission-rates" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("panel.logRate")}
        </Link>
      </footer>
    </div>
  );
}

export function panelColumns(
  l: Label,
  locale: string,
  resolved: Record<string, string> = {}
): Array<Column<ProviderRoll>> {
  const percent = (value: number | null) => (value === null ? l("none") : `${value.toLocaleString(locale)}%`);
  return [
    { key: "providerId", header: l("insurer"), render: (roll) => who(roll.providerId, resolved) },
    {
      key: "share",
      header: l("share"),
      numeric: true,
      render: (roll) => `${Math.round(roll.share * 100).toLocaleString(locale)}%`
    },
    { key: "volume", header: l("volume"), numeric: true, render: (roll) => roll.volume.toLocaleString(locale) },
    { key: "winRate", header: l("winRate"), numeric: true, render: (roll) => percent(roll.winRate) },
    {
      key: "index",
      header: l("priceIndex"),
      numeric: true,
      render: (roll) => {
        const pct = deltaPct(roll.ourIdx, roll.marketIdx);
        const tone = positionOf(pct);
        const text = indexText(roll.ourIdx, locale);
        if (text === null) return l("none");
        return (
          <span className={tone.tone === "success" ? "text-success" : tone.tone === "danger" ? "text-danger" : undefined}>
            {text}
          </span>
        );
      }
    },
    {
      key: "position",
      header: l("position"),
      render: (roll) => {
        const tone = positionOf(deltaPct(roll.ourIdx, roll.marketIdx));
        return (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={tone.tone === "neutral" ? "neutral" : tone.tone} size="sm">
              {l(tone.key)}
            </Badge>
            <span className="font-mono text-12 text-subtle">{roll.lines.join(" · ")}</span>
          </span>
        );
      }
    },
    {
      key: "gaps",
      header: l("panel.gaps"),
      numeric: true,
      render: (roll) => roll.gaps.toLocaleString(locale)
    }
  ];
}
