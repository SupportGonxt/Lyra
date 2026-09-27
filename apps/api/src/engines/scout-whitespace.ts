import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import {
  checkKAnonymity,
  clusterSignals,
  computeWhitespaceCandidates,
  kAnonymityFloor,
  moduleOn,
  notFound,
  verifyGroundedness,
  type CoverageInput
} from "@lyra/core";
import type { RawSignal } from "@lyra/core";
import { promptNouns, whitespaceEvidenceLines, type Gateway, type WhitespaceEvidence } from "@lyra/model-gateway";

// docs/modules/scout.md §8 clause 1: "from tenant's 12-month quote export
// alone, produce a first Radar with >= 5 evidenced whitespace candidates."
// This sweep is the cold-start Clusterer run against real AXIS data instead
// of the 7 hand-written seed/scout.ts rows — same idiom as orbit.ts's
// /renewals/sweep (a computed batch, not one-row CRUD, so no create
// permission is exposed on the resource — see resources.ts's scoutWhitespaces
// entry).

/** Half the 12-month export docs/8 clause 1 names — splits it into a recent
 *  and prior window for clusterSignals' growth comparison. */
const COLD_START_WINDOW_MS = 182 * 86_400_000;
const LOOKBACK_MS = 2 * COLD_START_WINDOW_MS;

/** Active policy count per core_products.line — the real coverage source
 *  whitespace.ts's header comment names. Shared with the negotiation-pack
 *  route so `coverage` there is a live number, not a stale persisted one. */
export async function coveragePerLine(ctx: Ctx): Promise<Map<string, number>> {
  // @accept:SA: without AXIS there is no policy book to read, and reading it
  // anyway said zero for every line. The platform records a sale as a
  // converted quote request, so that is what a SCOUT-only tenant already sells.
  if (!moduleOn(ctx, "axis")) {
    const sold = await ctx.db
      .select({ line: schema.products.line })
      .from(schema.distQuoteRequests)
      .innerJoin(schema.products, eq(schema.products.id, schema.distQuoteRequests.productId))
      .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.state, "converted")));
    const byLine = new Map<string, number>();
    for (const r of sold) byLine.set(r.line, (byLine.get(r.line) ?? 0) + 1);
    return byLine;
  }
  const policyRows = await ctx.db
    .select({ line: schema.products.line })
    .from(schema.axisPolicies)
    .innerJoin(schema.products, eq(schema.products.id, schema.axisPolicies.productId))
    .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.status, "active")));
  const byLine = new Map<string, number>();
  for (const p of policyRows) byLine.set(p.line, (byLine.get(p.line) ?? 0) + 1);
  return byLine;
}

/** docs/modules/scout.md §3 "Whitespace Drafter | cluster momentum > θ |
 *  reasoning | no (drafts)" — the dossier's headline sentence, drafted from
 *  the same momentum/coverage numbers a human analyst would read off the
 *  Radar, module "scout" (CLAUDE.md rule 3). Drafts only, never blocks the
 *  sweep: `sweepWhitespace` still persists on a gateway failure would abort
 *  the whole batch, so the caller catches per-candidate and falls back to the
 *  plain figures (ponytail: no retry/backoff — a bad draft this run gets a
 *  fresh candidate row next sweep, same idempotency guard as the rest).
 *
 *  The user turn is `whitespaceEvidenceLines`, not a second hand-rolled list:
 *  the same lines the brief prompt sends and the same lines `verifyGroundedness`
 *  scores the sentence against, so the prompt, the hover's "why" and the
 *  groundedness pool cannot drift apart. CLAUDE.md rule 14 — every industry noun
 *  in here comes from the tenant's domain pack. */
export function buildDescriptionPrompt(
  ev: WhitespaceEvidence,
  pack: string | undefined
): { system: string; user: string; lines: string[] } {
  const nouns = promptNouns(pack);
  const lines = whitespaceEvidenceLines(ev, nouns);
  return {
    system:
      `You write one short, factual sentence about an unserved market for a ${nouns.domain} business. ` +
      "State the demand signal and current coverage plainly. Never state a number the evidence below " +
      "did not give you. No preamble, no quotes.",
    user: lines.join("\n"),
    lines
  };
}

/** Insert a `candidate` row for every category flagged whitespace by real
 *  quote demand vs. this tenant's own policy coverage. Not visible (below the
 *  k-anonymity floor) candidates are never persisted — scout_whitespaces has
 *  no suppression column, so the only safe place to hide one is here.
 *  Idempotent per category: re-running skips a category that already has a
 *  live (candidate|validating|validated) row. */
export async function sweepWhitespace(ctx: Ctx, gateway: Gateway): Promise<number> {
  // docs/27 F13: demand is every answer the panel gave, plus the ones the desk
  // keyed by hand — one table. The grouping key is the product's line, read
  // through the request rather than off the case, so a shop that never opened
  // a case still counts as demand.
  const quotes = await ctx.db
    .select({
      id: schema.distQuoteResponses.id,
      category: schema.products.line,
      customerId: schema.distQuoteRequests.customerId,
      requestId: schema.distQuoteResponses.requestId,
      providerId: schema.distQuoteResponses.providerId,
      state: schema.distQuoteResponses.state,
      createdAt: schema.distQuoteResponses.createdAt
    })
    .from(schema.distQuoteResponses)
    .innerJoin(schema.distQuoteRequests, eq(schema.distQuoteRequests.id, schema.distQuoteResponses.requestId))
    .innerJoin(schema.products, eq(schema.products.id, schema.distQuoteRequests.productId))
    .where(
      and(
        eq(schema.distQuoteResponses.tenantId, ctx.tenantId),
        gte(schema.distQuoteResponses.createdAt, ctx.now - LOOKBACK_MS)
      )
    );

  const signals: RawSignal[] = quotes.map((q) => ({
    id: q.id,
    category: q.category,
    sourceRef: q.customerId,
    weight: 1,
    observedAt: q.createdAt
  }));
  if (!signals.length) return 0;

  // Re-scored every sweep, before any early return: the cluster's momentum is
  // the Radar's vertical axis, so a tenant whose candidates are all still live
  // would otherwise read last quarter's demand forever.
  const clusterIdByCategory = await persistClusters(ctx, signals);

  const coverageByLine = await coveragePerLine(ctx);
  const coverage: CoverageInput[] = [...coverageByLine].map(([category, policyCount]) => ({ category, policyCount }));

  const candidates = computeWhitespaceCandidates(
    signals,
    coverage,
    ctx.now,
    COLD_START_WINDOW_MS,
    kAnonymityFloor(ctx.policy, "scout")
  ).filter((c) => c.visible);
  if (!candidates.length) return 0;

  const live = await ctx.db
    .select({ category: schema.scoutWhitespaces.category })
    .from(schema.scoutWhitespaces)
    .where(
      and(
        eq(schema.scoutWhitespaces.tenantId, ctx.tenantId),
        inArray(schema.scoutWhitespaces.status, ["candidate", "validating", "validated"])
      )
    );
  const liveCategories = new Set(live.map((r) => r.category));

  const fresh = candidates.filter((c) => !liveCategories.has(c.category));
  if (!fresh.length) return 0;

  const evidenceByCategory = new Map<string, string[]>();
  for (const s of signals) {
    const bucket = evidenceByCategory.get(s.category);
    if (bucket) bucket.push(s.id);
    else evidenceByCategory.set(s.category, [s.id]);
  }

  const competition = competitionByCategory(quotes);

  const rows = await Promise.all(
    fresh.map(async (c) => {
      const ev: WhitespaceEvidence = {
        category: c.category,
        momentum: c.momentum,
        coverage: c.coverage,
        competitionScore: competition.get(c.category) ?? null,
        signalCount: c.cellCount
      };
      const description = await draftDescription(ctx, gateway, ev).catch(() => fallbackDescription(ctx, ev));
      return {
        id: newId("wsp", ctx.now),
        tenantId: ctx.tenantId,
        description,
        category: c.category,
        clusterId: clusterIdByCategory.get(c.category) ?? null,
        evidenceRefsJson: JSON.stringify((evidenceByCategory.get(c.category) ?? []).slice(0, 50)),
        demandEstimate: c.momentum,
        competitionScore: competition.get(c.category) ?? null,
        status: "candidate",
        owner: null,
        promotedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now
      };
    })
  );

  await ctx.db.insert(schema.scoutWhitespaces).values(rows as never);
  return rows.length;
}

/**
 * The Clusterer's persisted output: one `scout_clusters` row per category the
 * window saw, re-scored in place on every sweep. Both SCOUT surfaces read it —
 * the Clusters tab directly, and the Radar through `scout_whitespaces.cluster_id`,
 * which is the vertical axis of the quadrant (docs/27 F11: a whitespace row
 * with no cluster cannot be plotted at a momentum nobody measured).
 */
async function persistClusters(ctx: Ctx, signals: readonly RawSignal[]): Promise<Map<string, string>> {
  const clusters = clusterSignals(signals, ctx.now, COLD_START_WINDOW_MS);
  if (!clusters.length) return new Map();

  const seen = await ctx.db
    .select({ id: schema.scoutClusters.id, theme: schema.scoutClusters.theme })
    .from(schema.scoutClusters)
    .where(eq(schema.scoutClusters.tenantId, ctx.tenantId));
  const existing = new Map(seen.map((r) => [r.theme, r.id]));

  const seenAt = new Map<string, { first: number; last: number }>();
  for (const s of signals) {
    const span = seenAt.get(s.category);
    if (!span) seenAt.set(s.category, { first: s.observedAt, last: s.observedAt });
    else {
      span.first = Math.min(span.first, s.observedAt);
      span.last = Math.max(span.last, s.observedAt);
    }
  }

  const out = new Map<string, string>();
  for (const c of clusters) {
    const span = seenAt.get(c.category) ?? { first: ctx.now, last: ctx.now };
    const known = existing.get(c.category);
    if (known) {
      out.set(c.category, known);
      await ctx.db
        .update(schema.scoutClusters)
        .set({ momentumScore: c.momentum, size: c.signalIds.length, lastSeen: span.last, updatedAt: ctx.now })
        .where(and(eq(schema.scoutClusters.tenantId, ctx.tenantId), eq(schema.scoutClusters.id, known)));
      continue;
    }
    const id = newId("clu", ctx.now);
    out.set(c.category, id);
    await ctx.db.insert(schema.scoutClusters).values({
      id,
      tenantId: ctx.tenantId,
      theme: c.category,
      summary: null,
      momentumScore: c.momentum,
      size: c.signalIds.length,
      firstSeen: span.first,
      lastSeen: span.last,
      trailJson: null,
      updatedAt: ctx.now
    } as never);
  }
  return out;
}

/**
 * How contested a line is, 0-100, as the share of the panel that actually
 * competes for one of its requests: average distinct insurers quoting a request
 * on this line, over the whole panel that quoted anything in the window. A line
 * every insurer bids on scores 100; a line one insurer of eight bothers with
 * scores 12.
 *
 * ponytail: panel breadth is a proxy for market competition, not a measurement
 * of it — the tenant's own panel is the only competitive evidence LYRA holds
 * (docs §2.5). A real market-share feed replaces this function and nothing else.
 */
function competitionByCategory(
  quotes: readonly { category: string; requestId: string; providerId: string; state: string }[]
): Map<string, number> {
  const quoted = quotes.filter((q) => q.state === "quoted");
  const panel = new Set(quoted.map((q) => q.providerId)).size;
  if (panel === 0) return new Map();

  // category -> request -> the insurers that bid on it. Nested rather than one
  // joined string key: a product line may contain whatever separator we picked.
  const byCategory = new Map<string, Map<string, Set<string>>>();
  for (const q of quoted) {
    const requests = byCategory.get(q.category) ?? new Map<string, Set<string>>();
    const bidders = requests.get(q.requestId) ?? new Set<string>();
    bidders.add(q.providerId);
    requests.set(q.requestId, bidders);
    byCategory.set(q.category, requests);
  }

  const out = new Map<string, number>();
  for (const [category, requests] of byCategory) {
    let bids = 0;
    for (const bidders of requests.values()) bids += bidders.size;
    const avgBidders = bids / requests.size;
    out.set(category, Math.max(0, Math.min(100, Math.round((avgBidders / panel) * 100))));
  }
  return out;
}

/* ------------------------------------------------------- hover commentary */

export interface WhitespaceCommentary {
  whitespaceId: string;
  category: string | null;
  status: string;
  /** The sentence itself, or null when the row is suppressed. */
  commentary: string | null;
  /** Non-null only when `commentary` is. */
  evidence: WhitespaceEvidence | null;
  /** The inspectable "why" (docs/15 §4): the exact lines the sentence was
   *  grounded against, ready to render as the hover's evidence list. */
  why: string[];
  /** Null when the sentence is the deterministic fallback — no ✦ in that case. */
  ai: { marker: "✦"; auditId: string; model: string; provider: string; tier: string; at: number } | null;
  /** True when k-anonymity hides the detail. Then commentary/evidence are null. */
  suppressed: boolean;
}

/**
 * The commentary a Radar hover shows. A read, not a generation: the sentence was
 * drafted once at sweep time and persisted to `scout_whitespaces.description`
 * (the repo's existing cache for AI prose — there is no separate artifact table),
 * so a hover costs one indexed row read and never a model call. Prefetch is
 * therefore the sweep itself, plus whatever the client warms on hover intent.
 *
 * Provenance is read back off `ai_audit_log` (module scout / purpose
 * whitespace.describe / subjectRef = category). No audit row means the sentence
 * came from `fallbackDescription`, so `ai` is null and the caller must not draw a
 * ✦ — a deterministic sentence is not an AI artifact and must not be dressed as one.
 *
 * k-anonymity (docs/modules/scout.md §2.5): `sweepWhitespace` never persists a
 * suppressed candidate, so this is the second gate rather than the first — a row
 * whose evidence has since thinned below the floor stops describing itself
 * instead of naming the handful of quotes behind it.
 */
export async function whitespaceCommentary(ctx: Ctx, whitespaceId: string): Promise<WhitespaceCommentary> {
  const rows = await ctx.db
    .select(COMMENTARY_COLUMNS)
    .from(schema.scoutWhitespaces)
    .where(and(eq(schema.scoutWhitespaces.tenantId, ctx.tenantId), eq(schema.scoutWhitespaces.id, whitespaceId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("whitespace");
  return (await commentaryFor(ctx, [row]))[0]!;
}

/** How many rows one prefetch may read. The Radar plots tens of dots, not
 *  thousands, and a bigger page would only buy a slower hover. */
const COMMENTARY_MAX = 200;
const COMMENTARY_DEFAULT = 50;

/**
 * Every live candidate's commentary in one read — this is the prefetch. The
 * Radar loads it beside the dots it plots, so hovering a dot renders from state
 * the page already holds and costs neither a request nor a model call. Ordered
 * by demand so a clamped page keeps the dots a reader actually looks at.
 *
 * A suppressed row is listed, not omitted: the dot exists on the Radar either
 * way, and a UI that must say "no reading on this one" needs the row to say it
 * about. Its detail is still null — see `commentaryFor`.
 */
export async function whitespaceCommentaries(ctx: Ctx, limit?: number): Promise<WhitespaceCommentary[]> {
  const rows = await ctx.db
    .select(COMMENTARY_COLUMNS)
    .from(schema.scoutWhitespaces)
    .where(
      and(
        eq(schema.scoutWhitespaces.tenantId, ctx.tenantId),
        inArray(schema.scoutWhitespaces.status, ["candidate", "validating", "validated"])
      )
    )
    .orderBy(desc(schema.scoutWhitespaces.demandEstimate))
    .limit(Math.min(Math.max(limit ?? COMMENTARY_DEFAULT, 1), COMMENTARY_MAX));
  return commentaryFor(ctx, rows);
}

const COMMENTARY_COLUMNS = {
  id: schema.scoutWhitespaces.id,
  description: schema.scoutWhitespaces.description,
  category: schema.scoutWhitespaces.category,
  status: schema.scoutWhitespaces.status,
  demandEstimate: schema.scoutWhitespaces.demandEstimate,
  competitionScore: schema.scoutWhitespaces.competitionScore,
  clusterId: schema.scoutWhitespaces.clusterId,
  evidenceRefsJson: schema.scoutWhitespaces.evidenceRefsJson
} as const;

type CommentaryRow = {
  id: string;
  description: string;
  category: string | null;
  status: string;
  demandEstimate: number | null;
  competitionScore: number | null;
  clusterId: string | null;
  evidenceRefsJson: string | null;
};

/** Shared by the single read and the prefetch, so one row cannot describe itself
 *  differently depending on which route asked. Coverage and provenance are each
 *  one query for the whole page rather than one per row. */
async function commentaryFor(ctx: Ctx, rows: readonly CommentaryRow[]): Promise<WhitespaceCommentary[]> {
  const coverageByLine = await coveragePerLine(ctx);
  const nouns = promptNouns(ctx.policy.domainPack);
  const sizes = await clusterSizes(ctx, rows.map((r) => r.clusterId));
  const floor = kAnonymityFloor(ctx.policy, "scout");

  const evidenceOf = (row: CommentaryRow): WhitespaceEvidence => ({
    category: row.category ?? "",
    momentum: row.demandEstimate ?? 0,
    coverage: row.category ? coverageByLine.get(row.category) ?? 0 : 0,
    competitionScore: row.competitionScore,
    signalCount: cellSize(row, sizes)
  });

  // Only the rows that will actually show a ✦ are looked up: a suppressed or
  // fallback row must not carry provenance, so asking for it would be a query
  // whose answer we are obliged to throw away.
  const wantProvenance = rows.filter((row) => {
    const ev = evidenceOf(row);
    return (
      checkKAnonymity(ev.signalCount, floor).allowed &&
      row.category !== null &&
      !isFallbackDescription(row.description, ev)
    );
  });
  const provenance = await describeProvenance(ctx, [...new Set(wantProvenance.map((r) => r.category!))]);

  return rows.map((row) => {
    const ev = evidenceOf(row);
    const base = { whitespaceId: row.id, category: row.category, status: row.status };
    // k-anonymity (docs/modules/scout.md §2.5): below the floor nothing about the
    // cell leaves — not the sentence, not the counts, not the evidence lines the
    // sentence was grounded against.
    if (!checkKAnonymity(ev.signalCount, floor).allowed) {
      return { ...base, commentary: null, evidence: null, why: [], ai: null, suppressed: true };
    }
    return {
      ...base,
      commentary: row.description,
      evidence: ev,
      why: whitespaceEvidenceLines(ev, nouns),
      ai: row.category ? provenance.get(row.category) ?? null : null,
      suppressed: false
    };
  });
}

/** The sizes of the named clusters, in one read. Rows without a cluster ask
 *  nothing. Shared with the promote engine so both gates measure the same cell. */
export async function clusterSizes(ctx: Ctx, ids: readonly (string | null)[]): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db
    .select({ id: schema.scoutClusters.id, size: schema.scoutClusters.size })
    .from(schema.scoutClusters)
    .where(and(eq(schema.scoutClusters.tenantId, ctx.tenantId), inArray(schema.scoutClusters.id, wanted)));
  return new Map(rows.map((r) => [r.id, r.size]));
}

/**
 * How many people the k-anonymity floor is counting.
 *
 * The cell is the cluster's signal count — `sweepWhitespace` derives a candidate
 * from a cluster and writes `size: signalIds.length`, and that is the number the
 * dossier prints. `evidence_refs_json` is the *sources* cited for the estimate
 * (a funnel, an app-store page, the cluster itself): three of them can stand
 * behind three hundred signals, so counting refs suppressed every seeded row
 * while its own dossier said "Cluster size 305" beside it.
 *
 * The refs are the fallback for a row with no cluster, and for a row whose
 * cluster has been deleted — a dangling link is "we do not know how many", and
 * the safe reading of that is to publish nothing we cannot count.
 */
export function cellSize(
  row: { clusterId: string | null; evidenceRefsJson: string | null },
  sizes: Map<string, number>
): number {
  const clustered = row.clusterId === null ? undefined : sizes.get(row.clusterId);
  return clustered ?? evidenceRefCount(row.evidenceRefsJson);
}

/** How many demand signals a persisted candidate cites. The sweep writes a bare
 *  array; the seed writes `{refs, demandEstimate}`. A malformed, absent or
 *  unknown blob counts as zero, which suppresses rather than exposes the row. */
export function evidenceRefCount(json: string | null): number {
  if (!json) return 0;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.length;
    const refs = (parsed as { refs?: unknown } | null)?.refs;
    return Array.isArray(refs) ? refs.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Was this sentence the deterministic fallback rather than a draft?
 *
 * The audit row alone cannot answer it: the gateway audits the call, and a draft
 * this engine then rejected as ungrounded still left a row behind, so "an audit
 * row exists for this category" would put a ✦ on a sentence no model wrote.
 * The fallback's own prefix is the discriminator.
 *
 * ponytail: prefix match, because scout_whitespaces has no generated_by column.
 * Upgrade path is that column (signal_creatives already has one) — then this
 * function and its caller both collapse into reading it.
 */
function isFallbackDescription(description: string, ev: WhitespaceEvidence): boolean {
  return description.startsWith(`${ev.category}: demand momentum `);
}

/** The newest successful describe call per category, one query for the page.
 *  Descending `ts` plus first-writer-wins gives the latest row per category
 *  without a window function libSQL and D1 would have to agree on. */
async function describeProvenance(
  ctx: Ctx,
  categories: readonly string[]
): Promise<Map<string, WhitespaceCommentary["ai"]>> {
  const out = new Map<string, WhitespaceCommentary["ai"]>();
  if (!categories.length) return out;

  const rows = await ctx.db
    .select({
      id: schema.aiAuditLog.id,
      subjectRef: schema.aiAuditLog.subjectRef,
      model: schema.aiAuditLog.model,
      provider: schema.aiAuditLog.provider,
      tier: schema.aiAuditLog.tier,
      ts: schema.aiAuditLog.ts
    })
    .from(schema.aiAuditLog)
    .where(
      and(
        eq(schema.aiAuditLog.tenantId, ctx.tenantId),
        eq(schema.aiAuditLog.module, "scout"),
        eq(schema.aiAuditLog.purpose, "whitespace.describe"),
        inArray(schema.aiAuditLog.subjectRef, [...categories]),
        eq(schema.aiAuditLog.outcome, "ok")
      )
    )
    .orderBy(desc(schema.aiAuditLog.ts));

  for (const row of rows) {
    if (!row.subjectRef || out.has(row.subjectRef)) continue;
    out.set(row.subjectRef, {
      marker: "✦",
      auditId: row.id,
      model: row.model,
      provider: row.provider,
      tier: row.tier,
      at: row.ts
    });
  }
  return out;
}

/** The plain-figures sentence a candidate falls back to: the two numbers it was
 *  flagged on and nothing else, in the tenant's own vocabulary. */
export function fallbackDescription(ctx: Ctx, ev: WhitespaceEvidence): string {
  const nouns = promptNouns(ctx.policy.domainPack);
  return `${ev.category}: demand momentum ${ev.momentum} vs. ${ev.coverage} ${nouns.contracts} on the book`;
}

async function draftDescription(ctx: Ctx, gateway: Gateway, ev: WhitespaceEvidence): Promise<string> {
  const { system, user, lines } = buildDescriptionPrompt(ev, ctx.policy.domainPack);
  const res = await gateway.complete(ctx, {
    module: "scout",
    purpose: "whitespace.describe",
    tier: "reasoning",
    subjectRef: ev.category,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  const text = res.text.trim();
  if (!text) throw new Error("empty draft");
  // A sentence citing a figure the evidence never gave would be persisted, shown
  // on hover with a ✦, and read as measured. Reject it here and take the
  // deterministic sentence instead — same gate axis-copilot and orbit-draft use.
  if (!verifyGroundedness(text, lines).ok) throw new Error("ungrounded draft");
  return text;
}
