import { and, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, emit, notFound, type AdCreativePush, type Ctx } from "@lyra/core";
import { AD_PLATFORMS, adAccounts, secretsOf, type AdPlatforms } from "./signal-ad-platforms.js";

// docs/modules/signal.md §2.1 and §4.2 ("one-click to channels"), and the §8
// acceptance criterion "brief -> 20 compliant ar/en variants -> publish to
// Meta+Google in under an hour". Until this file existed the module could
// argue, plan, draft, clear and mark a campaign live while nothing reached an
// ad account: the studio's Launch button set a state and stopped.
//
// What this does NOT do: decide whether the copy may run. It refuses anything
// the pre-flight has not passed, and then it is transport. That line matters —
// a publisher that could publish a flagged creative would make the guardrail
// advisory.

export type PublishStatus = "published" | "failed" | "skipped";

export interface PublishOutcome {
  provider: string;
  status: PublishStatus;
  externalId: string | null;
  /** Why it failed, or why it was skipped (no publish path, already placed). */
  reason: string | null;
}

export interface PublishResult {
  creativeId: string;
  outcomes: PublishOutcome[];
}

/** The platform provider keys this publisher can address. */
export function publishableProviders(platforms: AdPlatforms): string[] {
  return Object.keys(platforms);
}

/**
 * Places one cleared creative on every configured ad platform, or on the ones
 * named.
 *
 * Idempotent by (creative, provider): a creative that already landed somewhere
 * is skipped there rather than placed twice, because the platform's object is
 * real and a second one would bill behind the same row. A previous *failure* is
 * retried — that is the whole point of recording it.
 */
export async function publishCreative(
  ctx: Ctx,
  env: { FIELD_KEY?: string | undefined },
  input: { creativeId: string; providers?: readonly string[] | undefined },
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<PublishResult> {
  const [creative] = await ctx.db
    .select()
    .from(schema.signalCreatives)
    .where(and(eq(schema.signalCreatives.tenantId, ctx.tenantId), eq(schema.signalCreatives.id, input.creativeId)))
    .limit(1);
  if (!creative) throw notFound("creative");

  // Nothing publishes unchecked (spec §2.1). `flagged` is a soft lane a human
  // clears; `pending` has not been looked at; `blocked` is a hard no.
  if (creative.complianceStatus !== "passed") {
    throw Object.assign(new Error(`creative ${creative.id} is ${creative.complianceStatus}, not passed`), {
      code: "bad_request",
      status: 400
    });
  }

  // A search ad is built from a pool, so the adapter needs the campaign's other
  // cleared variants in this locale. Same campaign, same language, passed only.
  const siblings = creative.campaignId
    ? await ctx.db
        .select({ contentRef: schema.signalCreatives.contentRef, kind: schema.signalCreatives.kind })
        .from(schema.signalCreatives)
        .where(
          and(
            eq(schema.signalCreatives.tenantId, ctx.tenantId),
            eq(schema.signalCreatives.campaignId, creative.campaignId),
            eq(schema.signalCreatives.locale, creative.locale),
            eq(schema.signalCreatives.complianceStatus, "passed")
          )
        )
    : [];
  const texts = siblings.map((s) => s.contentRef).filter((t) => t !== creative.contentRef);
  // A variant's stored text is "headline\nbody" where the studio wrote both.
  const headlineOf = (t: string) => t.split("\n")[0] ?? t;
  const bodyOf = (t: string) => (t.includes("\n") ? t.slice(t.indexOf("\n") + 1) : "");

  const accounts = await adAccounts(ctx, platforms);
  const wanted = input.providers ? new Set(input.providers) : null;
  const targets = accounts.filter((a) => (wanted ? wanted.has(a.platform.provider) : true));

  const existing = await ctx.db
    .select()
    .from(schema.signalCreativePublishes)
    .where(
      and(
        eq(schema.signalCreativePublishes.tenantId, ctx.tenantId),
        eq(schema.signalCreativePublishes.creativeId, creative.id)
      )
    );
  const placed = new Map(existing.map((r) => [r.provider, r]));

  const outcomes: PublishOutcome[] = [];
  for (const account of targets) {
    const provider = account.platform.provider;
    const prior = placed.get(provider);
    if (prior?.status === "published") {
      outcomes.push({ provider, status: "skipped", externalId: prior.externalId, reason: "already placed" });
      continue;
    }
    if (!account.platform.publishCreative) {
      outcomes.push({ provider, status: "skipped", externalId: null, reason: `${provider} has no publish path` });
      continue;
    }

    const push: AdCreativePush = {
      creativeId: creative.id,
      kind: creative.kind,
      locale: creative.locale,
      headline: headlineOf(creative.contentRef),
      body: bodyOf(creative.contentRef),
      callToAction: null,
      landingUrl: landingUrlOf(account.config),
      externalCampaignId: externalCampaignOf(account.config, creative.campaignId),
      disclosure: null,
      pool: { headlines: texts.map(headlineOf), descriptions: texts.map(bodyOf).filter(Boolean) }
    };

    let outcome: PublishOutcome;
    try {
      const result = await account.platform.publishCreative(push, await secretsOf(env.FIELD_KEY, account.row), account.config);
      outcome =
        result.status === "published"
          ? { provider, status: "published", externalId: result.externalId ?? null, reason: null }
          : { provider, status: "failed", externalId: null, reason: result.error ?? "the platform refused it" };
    } catch (error) {
      // One platform's refusal is that platform's outcome, not a crash of the
      // push: the others still get their copy and the operator sees which leg
      // failed and why.
      outcome = { provider, status: "failed", externalId: null, reason: error instanceof Error ? error.message : String(error) };
    }
    outcomes.push(outcome);

    const row = {
      id: prior?.id ?? newId("scp", ctx.now),
      tenantId: ctx.tenantId,
      creativeId: creative.id,
      provider,
      externalId: outcome.externalId,
      status: outcome.status === "published" ? "published" : "failed",
      error: outcome.reason,
      publishedAt: ctx.now
    };
    await ctx.db
      .insert(schema.signalCreativePublishes)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.signalCreativePublishes.tenantId, schema.signalCreativePublishes.creativeId, schema.signalCreativePublishes.provider],
        set: { externalId: row.externalId, status: row.status, error: row.error, publishedAt: row.publishedAt }
      });

    await audit(ctx, {
      action: `signal.creative.${outcome.status}`,
      subjectRef: creative.id,
      after: { provider, externalId: outcome.externalId, reason: outcome.reason, status: outcome.status }
    });
  }

  if (outcomes.some((o) => o.status === "published")) {
    await emit(ctx, {
      module: "signal",
      type: "signal.creative.published",
      subject: creative.id,
      data: {
        creativeId: creative.id,
        campaignId: creative.campaignId ?? null,
        providers: outcomes.filter((o) => o.status === "published").map((o) => o.provider)
      }
    });
  }

  return { creativeId: creative.id, outcomes };
}

/** The landing page the connector is configured to send a click to. */
function landingUrlOf(config: Record<string, unknown>): string {
  const raw = config.landingUrl;
  return typeof raw === "string" && /^https:\/\//.test(raw) ? raw : "";
}

/**
 * The platform campaign to hang the ad on. The connector's `campaigns` map is
 * the same one the budget autopilot reads (`adCampaignMap`), so an ad and a
 * budget move can never disagree about which campaign is which.
 */
function externalCampaignOf(config: Record<string, unknown>, campaignId: string | null): string | null {
  if (!campaignId) return null;
  const raw = config.campaigns;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const hits = Object.entries(raw as Record<string, unknown>).filter(([, id]) => id === campaignId);
  return hits.length === 1 ? hits[0]![0] : null;
}

/** The placements recorded for a creative, for the studio to render. */
export async function placementsFor(ctx: Ctx, creativeIds: readonly string[]) {
  if (!creativeIds.length) return [];
  return ctx.db
    .select()
    .from(schema.signalCreativePublishes)
    .where(
      and(
        eq(schema.signalCreativePublishes.tenantId, ctx.tenantId),
        inArray(schema.signalCreativePublishes.creativeId, [...creativeIds])
      )
    );
}
