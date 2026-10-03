import { prospectCounts } from "../engines/signal-prospects.js";
import { responseRollup } from "../engines/signal-responses.js";
import { importSpend, realDay, recordSpend, type SpendLine } from "../engines/signal-spend-import.js";
import { pullAdSpend, spendPullWindow, SPEND_PULL_MAX_DAYS } from "../engines/signal-ad-platforms.js";
import { exportConversions, listConversionExports } from "../engines/signal-conversions.js";
import { Hono, type Context } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { require_, audit, badRequest, emit, holdoutReadout, notFound, withIdempotency, LOOKALIKE_MAX_SIZE, type Ctx } from "@lyra/core";
import { schema, DesignJson, PolicyJson, toJson, parseJson } from "@lyra/db";
import { z } from "zod";
import { body, csvBody, parse } from "../http.js";
import { must } from "../rows.js";
import { meterEgress } from "../engines/egress.js";
import { generateCreativeImage, generateCreatives } from "../engines/signal-creative.js";
import { attributeCounts, suggestTargeting } from "../engines/signal-audience.js";
import { expandAudience } from "../engines/signal-lookalike.js";
import { creativeContextFor, planAudience, planCampaign } from "../engines/signal-campaign-plan.js";
import { runBudgetAutopilot } from "../engines/signal-autopilot.js";
import { acquisitionCostRange, funnelByCampaign } from "../engines/signal-attribution.js";
import { experimentReadout } from "../engines/signal-experiment.js";
import { demoOnly } from "../auth.js";
import type { App } from "../env.js";

// docs/modules/signal.md §8 clause 1: brief -> N compliant ar/en variants.
// Not generic CRUD (creatives get generated in a batch from a brief, never
// submitted one row at a time) so it is a bespoke route, same idiom as
// orbit.ts's `/renewals/sweep`. The Meta/Google publish half of clause 1 is
// credential-blocked and out of scope (see signal-creative.ts header) —
// this route stops at "review-ready", same as the engine it calls.

export const signalRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

const GenerateBody = z.object({
  campaignId: z.string().optional(),
  kind: z.enum(["ad", "lp", "email", "social", "video_script"]),
  brief: z.string().min(1).max(4_000),
  variantGroup: z.string().optional(),
  /** ADR-0108: the product line whose mandatory disclosure every variant carries. */
  productLine: z.string().min(1).max(64).optional(),
  locales: z.array(z.enum(["en", "ar"])).min(1).optional(),
  count: z.number().int().min(1).max(100).optional()
});

signalRoutes.post("/creatives/generate", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:creatives:generate", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, GenerateBody);

  // Copy written against the campaign's own plan and pool, not against the
  // brief alone: the recommended option's angle and offer, and the bands the
  // audience is made of. Until now only the promote path did this, so
  // regenerating from the studio quietly lost the argument the campaign was
  // funded on. Empty for a campaign nobody planned, which is the old behaviour.
  const campaign = input.campaignId
    ? await must(ctx, schema.signalCampaigns, input.campaignId, "campaign")
    : null;
  const context = campaign ? await creativeContextFor(ctx, campaign) : [];

  const result = await generateCreatives(ctx, c.get("gateway"), {
    kind: input.kind,
    brief: input.brief,
    campaignId: input.campaignId ?? null,
    ...(context.length > 0 ? { context } : {}),
    variantGroup: input.variantGroup ?? null,
    productLine: input.productLine ?? null,
    ...(input.locales !== undefined ? { locales: input.locales } : {}),
    ...(input.count !== undefined ? { count: input.count } : {})
  });
  return c.json(result, 201);
});

const SuggestAudienceBody = z.object({
  /** A whitespace category the studio arrived with, or a scenario somebody typed. */
  subject: z.string().min(1).max(200)
});

// docs/17 §SIG-025 ("audience estimate"). The permission has existed since the
// RBAC matrix was written and until now nothing enforced it.
//
// Demand evidence (momentum, signal count) is deliberately not in the body: a
// figure a client supplies would land in the prompt evidence and become
// something the model could legitimately cite back at the human approving the
// spend. The promote path reads those off the whitespace row and passes them;
// here they stay null and the pool is argued from attribute counts alone.
signalRoutes.post("/audiences/suggest", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:audiences:estimate", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, SuggestAudienceBody);
  const result = await suggestTargeting(ctx, c.get("gateway"), {
    subject: input.subject,
    momentum: null,
    signalCount: null
  });
  return c.json(result, 201);
});

const LookalikeBody = z.object({
  size: z.number().int().min(1).max(LOOKALIKE_MAX_SIZE),
  name: z.string().trim().min(1).max(200).optional()
});

// docs/17 §SIG-028, ADR-0113: grow a seed audience into the customers most like
// it, over the pack's targetable axes only, among people who consented to be
// profiled and marketed to. Not consequential (CLAUDE.md rule 4): the result is
// an audience — a definition — and anything sent to it still runs consent at
// send time and its own approval. The permission is the one that writes an
// audience at all.
signalRoutes.post("/audiences/:id/lookalike", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:audiences:create", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, LookalikeBody);
  const result = await expandAudience(ctx, c.req.param("id"), {
    size: input.size,
    ...(input.name !== undefined ? { name: input.name } : {})
  });
  return c.json(result, 201);
});

const PlanBody = z.object({
  /** What the campaign is about — a whitespace category, or a scenario a
   *  marketer typed. It is the subject the plan is argued at. */
  subject: z.string().min(1).max(200)
});

// The other half of docs/modules/signal.md §2.1: a promoted whitespace arrives
// planned (scout-promote.ts), and until now a campaign somebody started by hand
// could never be. Same three ranked options, same probability and reasons, same
// deterministic fallback at confidence 0 when the model does not answer.
//
// Not consequential (CLAUDE.md rule 4): a plan is an argument, not a spend. It
// changes no money and no contractual state — a human still funds an option and
// the copy still passes its own approval. The permission is
// signal:campaigns:update because the plan lands on the campaign row.
signalRoutes.post("/campaigns/:id/plan", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:campaigns:update", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, PlanBody);
  const campaign = await must(ctx, schema.signalCampaigns, c.req.param("id"), "campaign");
  const gateway = c.get("gateway");

  // A campaign typed by hand starts with no pool, and a plan argued at
  // "customers" is the thing this whole path exists to stop. So suggest one and
  // link it — the copy generated afterwards then reads the same bands. Same
  // doctrine as the promote path: a book with nothing above the k-anonymity
  // floor, or a model failure, leaves the plan unaudienced rather than 500ing
  // at the marketer.
  const audienceId =
    campaign.audienceId ??
    (await suggestTargeting(ctx, gateway, { subject: input.subject, momentum: null, signalCount: null })
      .then((s) => s.audienceId)
      .catch(() => null));

  const { bookSize } = await attributeCounts(ctx);
  const planned = await planCampaign(ctx, gateway, {
    subject: input.subject,
    objective: campaign.objective,
    // Nothing measured stands behind a scenario: no whitespace row, so no
    // momentum, coverage or competition. They stay null rather than zero —
    // zero is a measurement, and the planner would argue from it.
    proposition: null,
    momentum: null,
    signalCount: null,
    coverage: null,
    competitionScore: null,
    bookSize,
    audience: await planAudience(ctx, audienceId),
    prospects: await prospectCounts(ctx)
  });

  await ctx.db
    .update(schema.signalCampaigns)
    .set({ planJson: JSON.stringify(planned.plan), audienceId, updatedAt: ctx.now })
    .where(and(eq(schema.signalCampaigns.tenantId, ctx.tenantId), eq(schema.signalCampaigns.id, campaign.id)));

  await audit(ctx, {
    action: "signal.campaign.planned",
    subjectRef: `signal_campaign:${campaign.id}`,
    before: { audienceId: campaign.audienceId, planned: campaign.planJson !== null },
    after: {
      subject: input.subject,
      audienceId,
      source: planned.source,
      recommended: planned.plan.recommended,
      confidence: planned.plan.confidence,
      options: planned.plan.options.map((o) => `${o.name}=${o.probability}`)
    }
  });

  await emit(ctx, {
    module: "signal",
    type: "signal.campaign.planned",
    subject: campaign.id,
    data: {
      subject: input.subject,
      audienceId,
      source: planned.source,
      recommended: planned.plan.recommended,
      confidence: planned.plan.confidence
    }
  });

  return c.json(
    { campaignId: campaign.id, audienceId, plan: planned.plan, source: planned.source, aiAuditId: planned.auditId },
    201
  );
});

/** Chunk-safe bytes->base64 — a spread into String.fromCharCode blows the call
 *  stack on a real image; same loop as axis-document-render.ts's toBase64. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

const ImageBody = z.object({
  campaignId: z.string().optional(),
  prompt: z.string().min(1).max(2_000),
  locale: z.enum(["en", "ar"]).optional()
});

// ADR-0060: AI hero/post imagery, alongside the SVG post-card PostArt already
// renders client-side (apps/web's signal-studio.tsx). Bytes come back inline
// as a data URL for immediate preview; the R2 write inside generateCreativeImage
// is the durable copy the signal_creatives row actually points at.
signalRoutes.post("/creatives/image", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:creatives:generate", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, ImageBody);

  // Same context-loading idiom as /creatives/generate above: a campaign that
  // has been planned hands the image the plan's angle/offer and the
  // audience's bands, so the hero image targets the same group the copy does.
  const campaign = input.campaignId
    ? await must(ctx, schema.signalCampaigns, input.campaignId, "campaign")
    : null;
  const context = campaign ? await creativeContextFor(ctx, campaign) : [];

  const result = await generateCreativeImage(ctx, c.get("gateway"), c.env.FILES, {
    campaignId: input.campaignId ?? null,
    prompt: input.prompt,
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(context.length > 0 ? { context } : {})
  });
  return c.json(
    {
      id: result.id,
      fileId: result.fileId,
      contentType: result.contentType,
      dataUrl: `data:${result.contentType};base64,${toBase64(result.bytes)}`,
      aiAuditId: result.aiAuditId
    },
    201
  );
});

// Re-fetch after a reload — the POST above only hands back bytes at the
// moment of generation. Same idiom as north.ts's /boardpacks/:id/file:
// resolve the creative's file row inside the tenant, meter egress, stream it.
// docs/30 SIGNAL 4: where an experiment stands now, read from attribution —
// the same readout the nightly sweep concludes on.
signalRoutes.get("/experiments/:id/readout", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "signal:experiments:read", { tenantId: ctx.tenantId, module: "signal" });
  return c.json(await experimentReadout(ctx, c.req.param("id")));
});

signalRoutes.get("/creatives/:id/image", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:creatives:read", { tenantId: ctx.tenantId, module: "signal" });
  const creative = await must(ctx, schema.signalCreatives, c.req.param("id"), "creative");
  if (creative.kind !== "image") throw notFound("creative image");

  const file = await must(ctx, schema.files, creative.contentRef, "creative image");
  const object = await c.env.FILES?.get(file.r2Key);
  if (!object) throw notFound("creative image");

  await meterEgress(ctx, file.sizeBytes ?? object.size);
  return new Response(object.body, {
    headers: { "content-type": file.contentType ?? "application/octet-stream", "cache-control": "no-store" }
  });
});

// docs/modules/signal.md §8 clause 2: "one-click global pause" — a tenant-wide
// kill switch for the budget autopilot (packages/db/src/json.ts
// signalAutopilotPaused), checked by runBudgetAutopilot before touching any
// campaign. Distinct from a single campaign's own state=paused.
async function setAutopilotPaused(c: Context<App>, paused: boolean) {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:autopilot:pause", { tenantId: ctx.tenantId, module: "signal" });

  const [row] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  if (!row) throw new Error("tenant not found");
  const before = parseJson(PolicyJson, row.policyJson);
  const after = { ...before, signalAutopilotPaused: paused };

  await ctx.db
    .update(schema.tenants)
    .set({ policyJson: toJson(PolicyJson, after), updatedAt: ctx.now })
    .where(eq(schema.tenants.id, ctx.tenantId));

  await audit(ctx, {
    action: paused ? "signal.autopilot.paused" : "signal.autopilot.resumed",
    subjectRef: `tenants:${ctx.tenantId}`,
    before: { signalAutopilotPaused: before.signalAutopilotPaused },
    after: { signalAutopilotPaused: paused }
  });
  await emit(ctx, {
    module: "signal",
    type: paused ? "signal.autopilot.paused" : "signal.autopilot.resumed",
    subject: `tenants:${ctx.tenantId}`,
    data: { signalAutopilotPaused: paused }
  });

  return c.json({ signalAutopilotPaused: paused }, 200);
}

signalRoutes.post("/autopilot/pause", (c) => setAutopilotPaused(c, true));
signalRoutes.post("/autopilot/resume", (c) => setAutopilotPaused(c, false));

// Manual trigger, same idiom as orbit.ts's /renewals/sweep — RBAC-gated
// rather than environment-gated, so it also serves the 30-day compressed
// simulation (docs/24 sim plan) to see a budget decision's effect same-day.
signalRoutes.post("/autopilot/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:autopilot:run", { tenantId: ctx.tenantId, module: "signal" });
  return c.json({ adjusted: await runBudgetAutopilot(ctx, { fieldKey: c.env.FIELD_KEY }) });
});

// The acquisition outreach sweep (engines/signal-outreach.ts): draft, consent-
// gate, approval-gate, send, and record the lead touch that closes the loop.
// Manual trigger for the same sweep the nightly tick runs — a growth lead
// pressing this sees the outcome counts immediately, not tomorrow.
signalRoutes.post("/outreach/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:outreach:send", { tenantId: ctx.tenantId, module: "signal" });
  const { runAcquisitionSweep } = await import("../engines/signal-outreach.js");
  return c.json(await runAcquisitionSweep(ctx, c.get("gateway"), { env: c.env }));
});

const DAY_MS = 86_400_000;

// The acquisition funnel, aggregated per campaign and channel for a window.
// This is what the measurement screen reads — it was a dead seam until
// engines/signal-attribution.ts started writing touches (the portal tracking
// pixel and the axis.policy.issued consumer).
signalRoutes.get("/attribution/funnel", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:attribution:read", { tenantId: ctx.tenantId, module: "signal" });
  const since = Number(c.req.query("since") ?? ctx.now - 30 * DAY_MS);
  const until = Number(c.req.query("until") ?? ctx.now);
  return c.json({ data: await funnelByCampaign(ctx, since, until) });
});

// docs/17 SIG-057, ADR-0109: cost per acquisition as a range with its method
// named, never a bare point. A success fee references the lower bound, so the
// window has to be a real one — a bad number is refused, not defaulted.
signalRoutes.get("/attribution/range", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:attribution:read", { tenantId: ctx.tenantId, module: "signal" });
  const since = Number(c.req.query("since") ?? ctx.now - 30 * DAY_MS);
  const until = Number(c.req.query("until") ?? ctx.now);
  if (!Number.isFinite(since)) throw badRequest("since must be epoch milliseconds", { since: "not a number" });
  if (!Number.isFinite(until)) throw badRequest("until must be epoch milliseconds", { until: "not a number" });
  if (since >= until) throw badRequest("since must be before until", { since: "not before until" });
  return c.json(
    await acquisitionCostRange(ctx, { since, until, channel: c.req.query("channel") || null, currency: c.req.query("currency") || null })
  );
});

// docs/17 SIG-046, ADR-0110: autopilot uplift against the frozen-budget
// holdout. A measurement over spend and attributed binds, so it reads under
// the same scope as the funnel beside it.
signalRoutes.get("/holdout/readout", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:attribution:read", { tenantId: ctx.tenantId, module: "signal" });
  const since = Number(c.req.query("since") ?? ctx.now - 30 * DAY_MS);
  const until = Number(c.req.query("until") ?? ctx.now);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
    throw badRequest("since and until are epoch milliseconds, since before until", { since: "not a window" });
  }
  return c.json(await holdoutReadout(ctx, since, until));
});

// docs/30 SIGNAL gap 1: spend actuals from an ad-platform export. Per-line
// honest like the case import; a day already held is corrected, not doubled.
// ST2: the designer's layout and canvas edits. Moving a headline changes how an
// ad looks, not what it says, so it is not a publish and raises no approval;
// the copy itself still changes only through the approval-gated update.
signalRoutes.put("/creatives/:id/design", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:creatives:generate", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, DesignJson);
  const creative = await must(ctx, schema.signalCreatives, c.req.param("id"), "creative");
  await ctx.db
    .update(schema.signalCreatives)
    .set({ designJson: JSON.stringify(input), updatedAt: ctx.now })
    .where(and(eq(schema.signalCreatives.tenantId, ctx.tenantId), eq(schema.signalCreatives.id, creative.id)));
  await audit(ctx, {
    action: "signal.creative.designed",
    subjectRef: creative.id,
    before: { design: creative.designJson ? JSON.parse(creative.designJson) : null },
    after: { design: input }
  });
  return c.json({ id: creative.id, design: input });
});

signalRoutes.post("/spend/import", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:spend:write", { tenantId: ctx.tenantId, module: "signal" });
  const csv = await csvBody(c);
  return c.json(await importSpend(ctx, csv), 201);
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD day");
const SpendPullBody = z
  .object({ since: Day.optional(), until: Day.optional() })
  .refine((b) => !b.since || !b.until || b.since <= b.until, { message: "since must not be after until", path: ["since"] });

// docs/30 SIGNAL 5, ADR-0100: the same pull the nightly tick runs, on demand —
// every connected ad account's daily spend through the import's write path.
// A tenant with no ad connector gets `connectors: 0` and nothing changes.
signalRoutes.post("/spend/pull", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:spend:write", { tenantId: ctx.tenantId, module: "signal" });
  const raw = c.req.header("content-type")?.includes("application/json") ? await body(c, SpendPullBody) : {};
  const window = spendPullWindow(ctx.now, raw);
  if (Date.parse(window.until) - Date.parse(window.since) > SPEND_PULL_MAX_DAYS * DAY_MS) {
    throw badRequest(`a pull covers at most ${SPEND_PULL_MAX_DAYS} days`, { since: "window too long" });
  }
  return c.json(await pullAdSpend(ctx, c.env.FIELD_KEY, window));
});

// Hand-keyed spend (an email send fee no network reports). These shadow the
// generated CRUD writes on the same paths — hand-written routes mount first
// (index.ts) — because generated CRUD writes the row and nothing else, and a
// spend row that never reaches the ledger is the dead seam docs/19 §4.8 names:
// MEDIA-SPEND accrues in `recordSpend`, the one spend write. The shapes are
// the CRUD ones, so the OpenAPI contract is unchanged.
const Count = z.number().int().min(0);
const SpendCreateBody = z.object({
  day: Day.refine(realDay, "a real YYYY-MM-DD day"),
  campaignId: z.string().min(1).nullable().optional(),
  channel: z.string().min(1).max(64),
  amountMinor: Count,
  currency: z.string().regex(/^[A-Z]{3}$/, "a 3-letter ISO code"),
  impressions: Count.optional(),
  clicks: Count.optional(),
  conversions: Count.optional()
});
const SpendUpdateBody = SpendCreateBody.partial();

async function spendRow(ctx: Ctx, key: { campaignId: string | null; channel: string; day: string }) {
  const [row] = await ctx.db
    .select()
    .from(schema.signalSpend)
    .where(
      and(
        eq(schema.signalSpend.tenantId, ctx.tenantId),
        key.campaignId ? eq(schema.signalSpend.campaignId, key.campaignId) : isNull(schema.signalSpend.campaignId),
        eq(schema.signalSpend.channel, key.channel),
        eq(schema.signalSpend.day, key.day)
      )
    )
    .limit(1);
  if (!row) throw notFound("spend");
  return row;
}

signalRoutes.post("/spend", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:spend:write", { tenantId: ctx.tenantId, module: "signal" });
  const input = await body(c, SpendCreateBody);
  const row = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    const campaignId = input.campaignId ?? null;
    if (campaignId) await must(ctx, schema.signalCampaigns, campaignId, "campaign");
    const line: SpendLine = {
      campaignId,
      channel: input.channel,
      day: input.day,
      amountMinor: input.amountMinor,
      currency: input.currency,
      impressions: input.impressions ?? 0,
      clicks: input.clicks ?? 0,
      conversions: input.conversions ?? 0
    };
    await recordSpend(ctx, line, "manual", "create");
    const written = await spendRow(ctx, line);
    await audit(ctx, { action: "signal.spend.create", subjectRef: written.id, after: written });
    return written;
  });
  return c.json(row, 201);
});

const updateSpend = async (c: Context<App>) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:spend:write", { tenantId: ctx.tenantId, module: "signal" });
  const before = await must(ctx, schema.signalSpend, c.req.param("id") as string, "spend");
  const input = await body(c, SpendUpdateBody);
  const after = await withIdempotency(ctx, c.req.header("idempotency-key"), `PATCH ${c.req.path}`, input, async () => {
    // A row is its (campaign, channel, day). Moving one is recording another
    // day's spend, and would leave this row's accrual behind on the old key.
    for (const k of ["day", "channel", "campaignId"] as const) {
      if (input[k] !== undefined && (input[k] ?? null) !== before[k]) {
        throw badRequest(`${k} is part of a spend row's identity and cannot change; record the other row instead`, { [k]: "immutable" });
      }
    }
    await recordSpend(
      ctx,
      {
        campaignId: before.campaignId,
        channel: before.channel,
        day: before.day,
        amountMinor: input.amountMinor ?? before.amountMinor,
        currency: input.currency ?? before.currency,
        impressions: input.impressions ?? before.impressions,
        clicks: input.clicks ?? before.clicks,
        conversions: input.conversions ?? before.conversions
      },
      "manual"
    );
    const written = await spendRow(ctx, before);
    await audit(ctx, { action: "signal.spend.update", subjectRef: written.id, before, after: written });
    return written;
  });
  return c.json(after);
};
signalRoutes.patch("/spend/:id", updateSpend);
signalRoutes.put("/spend/:id", updateSpend);

// docs/17 SIG-032, ADR-0112: value-based bidding signals, the same run the
// nightly tick makes. Stands down until a conversion value is configured.
signalRoutes.post("/conversions/export", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:spend:write", { tenantId: ctx.tenantId, module: "signal" });
  return c.json(await exportConversions(ctx, c.env.FIELD_KEY));
});

const ExportsQuery = z.object({
  status: z.enum(["sent", "skipped", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

signalRoutes.get("/conversions/exports", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:attribution:read", { tenantId: ctx.tenantId, module: "signal" });
  return c.json({ data: await listConversionExports(ctx, parse(ExportsQuery, c.req.query())) });
});

// ADR-0091: what came back from sends, per campaign (broad), audience (niche)
// or person (individual) — one table, three groupings.
signalRoutes.get("/responses/rollup", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:campaigns:read", { tenantId: ctx.tenantId, module: "signal" });
  const level = c.req.query("level") ?? "campaign";
  if (level !== "campaign" && level !== "audience" && level !== "customer") {
    throw badRequest("level must be campaign, audience or customer", { level: "unknown level" });
  }
  const since = Number(c.req.query("since") ?? ctx.now - 30 * DAY_MS);
  return c.json({ data: await responseRollup(ctx, level, since) });
});

/**
 * Demo-only, temporary (same idiom as auth.ts's demoOnly() routes — remove
 * once the 30-day sim exercise is done). No production spend-ingestion API
 * exists yet (a real one is its own feature); the sim's day-driver needs
 * *some* way to keep signal_spend inside signal-autopilot.ts's trailing
 * 7-day CAC window as the virtual clock advances, or every campaign's window
 * goes empty and the autopilot can only ever decide "no_action". This ticks
 * one new spend row per existing channel per live campaign, each virtual
 * day, so the autopilot actually gets exercised with real decision variety.
 */
async function tickDemoSpend(ctx: Ctx): Promise<{ inserted: number }> {
  const campaigns = await ctx.db
    .select({ id: schema.signalCampaigns.id })
    .from(schema.signalCampaigns)
    .where(
      and(
        eq(schema.signalCampaigns.tenantId, ctx.tenantId),
        eq(schema.signalCampaigns.state, "live"),
        inArray(schema.signalCampaigns.autonomyLevel, ["act", "act_with_approval"]),
        isNull(schema.signalCampaigns.deletedAt)
      )
    );

  const dayIndex = Math.floor(ctx.now / DAY_MS);
  const today = new Date(ctx.now).toISOString().slice(0, 10);
  let inserted = 0;

  for (const campaign of campaigns) {
    const history = await ctx.db
      .select({
        channel: schema.signalSpend.channel,
        amountMinor: schema.signalSpend.amountMinor,
        conversions: schema.signalSpend.conversions,
        currency: schema.signalSpend.currency
      })
      .from(schema.signalSpend)
      .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), eq(schema.signalSpend.campaignId, campaign.id)));
    if (!history.length) continue;

    const byChannel = new Map<string, { amountMinor: number; conversions: number; currency: string; n: number }>();
    for (const row of history) {
      const e = byChannel.get(row.channel) ?? { amountMinor: 0, conversions: 0, currency: row.currency, n: 0 };
      e.amountMinor += row.amountMinor;
      e.conversions += row.conversions;
      e.n++;
      byChannel.set(row.channel, e);
    }

    let channelIndex = 0;
    for (const [channel, e] of byChannel) {
      // ponytail: deterministic wobble keyed off virtual day + channel order —
      // not a real efficiency model, just enough CAC swing across channels
      // that the autopilot's act/anomaly paths get exercised on some ticks
      // instead of the gap always landing under MIN_GAP_BPS.
      const wobble = (dayIndex + channelIndex) % 3 === 0 ? 0.7 : 1.15;
      const conversions = Math.max(1, Math.round((e.conversions / e.n) * wobble));
      // Through the one spend write, so the tick's spend reaches the ledger as
      // MEDIA-SPEND like any other. `ifAbsent`: a second tick on the same day
      // finds the row already there and leaves it.
      const outcome = await recordSpend(
        ctx,
        {
          campaignId: campaign.id,
          channel,
          day: today,
          amountMinor: Math.round(e.amountMinor / e.n),
          currency: e.currency,
          impressions: 0,
          clicks: 0,
          conversions
        },
        "manual",
        "ifAbsent"
      );
      if (outcome === "created") inserted++;
      channelIndex++;
    }
  }
  return { inserted };
}

signalRoutes.post("/demo/spend-tick", async (c) => {
  demoOnly(c.env);
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:autopilot:run", { tenantId: ctx.tenantId, module: "signal" });
  return c.json(await tickDemoSpend(ctx));
});
