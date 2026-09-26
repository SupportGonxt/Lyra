import { prospectCounts } from "../engines/signal-prospects.js";
import { responseRollup } from "../engines/signal-responses.js";
import { Hono, type Context } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { require_, audit, badRequest, emit, notFound, type Ctx } from "@lyra/core";
import { schema, PolicyJson, toJson, parseJson, id as newId } from "@lyra/db";
import { z } from "zod";
import { body } from "../http.js";
import { must } from "../rows.js";
import { meterEgress } from "../engines/egress.js";
import { generateCreativeImage, generateCreatives } from "../engines/signal-creative.js";
import { attributeCounts, suggestTargeting } from "../engines/signal-audience.js";
import { creativeContextFor, planAudience, planCampaign } from "../engines/signal-campaign-plan.js";
import { runBudgetAutopilot } from "../engines/signal-autopilot.js";
import { funnelByCampaign } from "../engines/signal-attribution.js";
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
  return c.json({ adjusted: await runBudgetAutopilot(ctx) });
});

// The acquisition outreach sweep (engines/signal-outreach.ts): draft, consent-
// gate, approval-gate, send, and record the lead touch that closes the loop.
// Manual trigger for the same sweep the nightly tick runs — a growth lead
// pressing this sees the outcome counts immediately, not tomorrow.
signalRoutes.post("/outreach/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "signal:outreach:send", { tenantId: ctx.tenantId, module: "signal" });
  const { runAcquisitionSweep } = await import("../engines/signal-outreach.js");
  return c.json(await runAcquisitionSweep(ctx, c.get("gateway")));
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
      await ctx.db.insert(schema.signalSpend).values({
        id: newId("spd", ctx.now + channelIndex),
        tenantId: ctx.tenantId,
        campaignId: campaign.id,
        channel,
        day: today,
        amountMinor: Math.round(e.amountMinor / e.n),
        currency: e.currency,
        conversions,
        source: "manual",
        ts: ctx.now
      });
      inserted++;
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
