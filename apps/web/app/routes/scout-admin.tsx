import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, DateTime, EmptyState, GuardrailNotice } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { jsonOf } from "../json.js";
import { useScoutSessionData } from "./scout-shell";
import {
  K_FLOOR,
  emptyPage,
  labelsIn,
  safe,
  type Label,
  type Page
} from "./scout.shared";

// SCOUT's own settings (docs/modules/scout.md §4 screen 6). The screen shows
// what actually governs the module and where each number lives, which for
// several of them is source rather than a tenant setting.
//
// What is configurable, and shown as such: the per-product suppression floor
// (scout_data_products.aggregation_min) and any versioned `scout.*` row in the
// compliance threshold store. What is compiled and named as compiled: the
// module's default k-anonymity floor. What has no store at all: the connector
// registry, crawl politeness, robots compliance and the template-hypothesis
// library — the screen says so rather than rendering an editor over nothing.
//
// Source health is derived, not configured: every source the module ingests is
// counted straight out of scout_signals with its latest observation, so a
// connector that has gone quiet is visible without a connector table existing.

/** docs/modules/scout.md §2 — the sources the harvester ingests. */
export const SIGNAL_SOURCES = ["search", "quotes", "abandonment", "reviews", "news", "regulatory"] as const;

/** A source silent this long is quiet, whatever its lifetime volume says. */
export const QUIET_AFTER_DAYS = 14;

const DAY = 86_400_000;

export interface SignalRow {
  id: string;
  source: string;
  observedAt: number;
}

export interface ProductRow {
  id: string;
  name: string;
  aggregationMin: number;
  status: string;
}

/** `compliance_policy_thresholds` as generic CRUD returns it — see
 *  `r("policy-thresholds", …)` in apps/api/src/resources.ts. */
export interface ThresholdRow {
  id: string;
  key: string;
  version: number;
  /** Already parsed on the wire — see `jsonOf`. */
  valueJson: unknown;
  dualControl: boolean;
  effectiveFrom: number;
  effectiveTo: number | null;
  setBy: string;
}

export interface ApprovalRow {
  id: string;
  subjectRef: string;
  policyKey: string;
  decision: string;
  requestedAt: number;
}

export interface SourceHealth {
  source: string;
  count: number;
  lastAt: number | null;
  quiet: boolean;
}

/** `GET /v1/scout/sources` — mirrors `describeSources`
 *  (apps/api/src/engines/scout-ingest.ts), which is the registry itself. */
export interface AdapterRow {
  id: string;
  kind: string;
  external: boolean;
}

/** `GET /v1/scout/watch` — mirrors `WatchReport` (apps/api/src/engines/scout-watch.ts). */
export interface WatchFindingRow {
  kind: "competitor" | "regulatory";
  key: string;
  source: string;
  subject: string | null;
  count: number;
  priorCount: number;
  deltaPct: number | null;
  severity: "urgent" | "attention" | "info";
  firstSeen: number;
  lastSeen: number;
}

export interface WatchReport {
  windowMs: number;
  findings: WatchFindingRow[];
  counts: { urgent: number; attention: number; info: number };
}

/** Days of the watch window, for the sentence that explains what is compared. */
export const watchDays = (windowMs: number): number => Math.max(1, Math.round(windowMs / DAY));

const SEVERITY_TONE: Record<WatchFindingRow["severity"], "warning" | "info" | "neutral"> = {
  urgent: "warning",
  attention: "info",
  info: "neutral"
};

export function healthOf(source: string, page: Page<SignalRow>, now: number): SourceHealth {
  const lastAt = page.data[0]?.observedAt ?? null;
  return {
    source,
    count: page.total ?? page.data.length,
    lastAt,
    // Never ingested and long since silent are different facts, and both are
    // quiet: a source with no row at all has nothing to be fresh.
    quiet: lastAt === null || now - lastAt > QUIET_AFTER_DAYS * DAY
  };
}

/**
 * The live version of each `scout.*` threshold. A change is a new version with
 * the old one closed off (seed/compliance.ts), so "current" means the highest
 * version that has not been superseded — never the newest row by id.
 */
export function currentThresholds(rows: ThresholdRow[]): ThresholdRow[] {
  const live = rows.filter((row) => row.key.startsWith("scout.") && row.effectiveTo === null);
  const byKey = new Map<string, ThresholdRow>();
  for (const row of live) {
    const held = byKey.get(row.key);
    if (!held || row.version > held.version) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A threshold's value, as an admin can read it. The screen used to render the
 * column straight into a span, which throws once `hydrate()` sends the object:
 * governance numbers are the point of the card, so they are serialised back
 * rather than dropped.
 */
export function thresholdValue(row: Pick<ThresholdRow, "valueJson">): string {
  const value = jsonOf(row.valueJson);
  if (value === null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Products whose own floor differs from the module default — the rest inherit. */
export const floorOverrides = (rows: ProductRow[], floor: number = K_FLOOR): ProductRow[] =>
  rows.filter((row) => row.aggregationMin !== floor).sort((a, b) => a.aggregationMin - b.aggregationMin);

/** The one sentence admin opens with — pending approvals and quiet sources
 *  already on the loader, no ✦ (arithmetic, not an agent's finding, CLAUDE.md
 *  §11). */
export function adminHeadline(pending: number, sources: SourceHealth[], l: Label): string {
  if (pending > 0) return l("adm.headlinePending", { n: String(pending) });
  const quiet = sources.filter((source) => source.quiet).length;
  if (quiet > 0) return l("adm.headlineQuiet", { n: String(quiet) });
  return l("adm.title");
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const now = Date.now();

  const [sources, adapters, watch, products, thresholds, approvals, kFloor] = await Promise.all([
    Promise.all(
      SIGNAL_SOURCES.map(async (source) => {
        const page = await safe(
          () =>
            api<Page<SignalRow>>(
              `/v1/scout/signals?source=${source}&sort=observedAt&order=desc&limit=1&count=true`,
              { env, request }
            ),
          emptyPage<SignalRow>()
        );
        return healthOf(source, page, now);
      })
    ),
    // The registry and the watch are both reads the SCOUT admin owns: what can
    // arrive, and what the arrivals say. `safe` because a reader without
    // `scout:signals:read` still has a settings screen to look at.
    safe(() => api<{ data: AdapterRow[] }>("/v1/scout/sources", { env, request }), { data: [] as AdapterRow[] }),
    safe(() => api<WatchReport>("/v1/scout/watch", { env, request }), {
      windowMs: 30 * DAY,
      findings: [] as WatchFindingRow[],
      counts: { urgent: 0, attention: 0, info: 0 }
    }),
    safe(
      () => api<Page<ProductRow>>("/v1/scout/data-products?limit=100", { env, request }),
      emptyPage<ProductRow>()
    ),
    safe(
      () => api<Page<ThresholdRow>>("/v1/compliance/policy-thresholds?limit=200", { env, request }),
      emptyPage<ThresholdRow>()
    ),
    safe(
      () =>
        api<Page<ApprovalRow>>("/v1/core/approvals?module=scout&sort=requestedAt&order=desc&limit=20&count=true", {
          env,
          request
        }),
      emptyPage<ApprovalRow>()
    ),
    // docs/27 P2 K_FLOOR follow-up: the resolved tenant value, not the
    // compiled default — falls back to it on a permission or network failure,
    // same as every other best-effort read on this loader.
    safe(() => api<{ kFloor: number }>("/v1/scout/config", { env, request }).then((r) => r.kFloor), K_FLOOR)
  ]);

  return {
    sources,
    adapters: adapters.data,
    watch,
    overrides: floorOverrides(products.data, kFloor),
    thresholds: currentThresholds(thresholds.data),
    approvals: approvals.data,
    pending: approvals.data.filter((row) => row.decision === "pending").length,
    kFloor
  };
}

export default function ScoutAdmin() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useScoutSessionData();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const ingested = loaded.sources.reduce((sum, one) => sum + one.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {adminHeadline(loaded.pending, loaded.sources, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("adm.lede")}</p>
        </div>
      </header>

      <Card title={l("adm.sources")} description={l("adm.sourcesHint", { days: String(QUIET_AFTER_DAYS) })}>
        <ul className="mt-3 flex flex-col gap-3">
          {loaded.sources.map((one) => (
            <li key={one.source} className="flex flex-wrap items-baseline gap-3 border-b border-line pb-3 last:border-0">
              {/* `adm.source.*` is what the catalogue holds: `source.*` fell
                  through `labelsIn` and printed its own key on this row. */}
              <span className="min-w-40 font-ui text-13 text-text">{l(`adm.source.${one.source}`)}</span>
              <span className="font-ui text-13 tabular-nums text-muted">{one.count.toLocaleString(locale)}</span>
              <span className="font-ui text-12 text-subtle">
                {ingested === 0 ? l("none") : `${Math.round((one.count / ingested) * 100)}%`}
              </span>
              <span className="font-ui text-12 text-subtle">
                {one.lastAt === null ? l("adm.neverIngested") : <DateTime value={one.lastAt} locale={locale} />}
              </span>
              <Badge tone={one.quiet ? "warning" : "success"} size="sm">
                {one.quiet ? l("adm.quiet") : l("adm.live")}
              </Badge>
            </li>
          ))}
        </ul>
        <h3 className="mt-5 font-ui text-13 font-medium text-text">{l("adm.registry")}</h3>
        <p className="mt-1 max-w-prose font-ui text-12 text-subtle">{l("adm.registryHint")}</p>
        <ul className="mt-2 flex flex-col gap-2">
          {loaded.adapters.map((one) => (
            <li key={one.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-ui text-13 text-text">{one.id}</span>
              <span className="font-ui text-12 text-subtle">{l(`adm.source.${one.kind}`)}</span>
              <Badge tone={one.external ? "warning" : "neutral"} size="sm">
                {one.external ? l("adm.adapterExternal") : l("adm.adapterInternal")}
              </Badge>
            </li>
          ))}
        </ul>
        <GuardrailNotice tone="info" title={l("adm.noConnectors")} reason={l("adm.noConnectorsWhy")} />
      </Card>

      <Card title={l("adm.watch")} description={l("adm.watchHint", { days: String(watchDays(loaded.watch.windowMs)) })}>
        {loaded.watch.findings.length === 0 ? (
          <EmptyState title={l("adm.watchNone")} body={l("adm.watchNone.body")} />
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {loaded.watch.findings.map((one) => (
              <li key={one.key} className="flex flex-col gap-1 border-b border-line pb-3 last:border-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[one.severity]} size="sm">
                    {l(`watch.severity.${one.severity}`)}
                  </Badge>
                  <span className="font-ui text-13 text-text">{one.subject ?? l(`adm.source.${one.source}`)}</span>
                  <span className="font-ui text-12 text-subtle">{l(`watch.kind.${one.kind}`)}</span>
                </span>
                <span className="flex flex-wrap items-baseline gap-3">
                  <span className="font-ui text-12 tabular-nums text-muted">
                    {l("adm.watchCount", { n: one.count.toLocaleString(locale) })}
                  </span>
                  <span className="font-ui text-12 text-subtle">
                    {one.deltaPct === null
                      ? l("adm.watchNew")
                      : l("adm.watchDelta", { pct: one.deltaPct.toLocaleString(locale) })}
                  </span>
                  <DateTime value={one.lastSeen} locale={locale} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={l("adm.floors")} description={l("adm.floorsHint")}>
          <dl className="mt-3 flex flex-col gap-1">
            <dt className="font-ui text-12 text-subtle">{l("adm.defaultFloor")}</dt>
            <dd className="font-serif text-22 text-text">{loaded.kFloor}</dd>
          </dl>
          <p className="mt-2 max-w-prose font-ui text-12 text-subtle">{l("adm.defaultFloorWhy")}</p>
          <h3 className="mt-4 font-ui text-13 font-medium text-text">{l("adm.overrides")}</h3>
          {loaded.overrides.length === 0 ? (
            <p className="mt-2 font-ui text-12 text-subtle">{l("adm.noOverrides")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {loaded.overrides.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-ui text-13 text-text">{row.name}</span>
                  <Badge tone={row.aggregationMin < loaded.kFloor ? "warning" : "neutral"} size="sm">
                    {l("dtp.k", { floor: String(row.aggregationMin) })}
                  </Badge>
                  <span className="font-ui text-12 text-subtle">{l(`dtp.status.${row.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={l("adm.thresholds")} description={l("adm.thresholdsHint")}>
          {loaded.thresholds.length === 0 ? (
            <EmptyState title={l("adm.noThresholds")} body={l("adm.noThresholdsWhy")} />
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {loaded.thresholds.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 border-b border-line pb-3 last:border-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-ui text-13 text-text">{row.key}</span>
                    <Badge size="sm">{l("adm.version", { version: String(row.version) })}</Badge>
                    {row.dualControl ? (
                      <Badge tone="info" size="sm">
                        {l("adm.dualControl")}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="font-ui text-12 text-subtle">{thresholdValue(row)}</span>
                  <span className="font-ui text-12 text-subtle">
                    {l("adm.setBy", { who: row.setBy })} <DateTime value={row.effectiveFrom} locale={locale} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={l("adm.approvals")} description={l("adm.approvalsHint")}>
        <p className="mt-2 font-ui text-13 text-muted">{l("adm.pending", { count: String(loaded.pending) })}</p>
        {loaded.approvals.length === 0 ? (
          <EmptyState title={l("adm.noApprovals")} body={l("adm.noApprovals.body")} />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {loaded.approvals.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2">
                <Badge tone={row.decision === "pending" ? "warning" : "neutral"} size="sm">
                  {row.decision}
                </Badge>
                <span className="font-ui text-13 text-text">{row.policyKey}</span>
                <span className="font-ui text-12 text-subtle">{row.subjectRef}</span>
                <DateTime value={row.requestedAt} locale={locale} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <GuardrailNotice tone="info" title={l("adm.noLibrary")} reason={l("adm.noLibraryWhy")} />

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/data-products" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("adm.openProducts")}
        </Link>
        <Link to="/approvals" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("approvalLink")}
        </Link>
      </footer>
    </div>
  );
}
