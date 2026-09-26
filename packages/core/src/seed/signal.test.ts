import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { SEED_CREATIVE_COPY, seedSignal } from "./signal.js";

// Same DB harness as ../seed.test.ts and analytics.test.ts: an in-memory
// libSQL db with the real migrations replayed, one extra ".." because this
// file sits one directory deeper (packages/core/src/seed/ rather than
// packages/core/src/).
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// The seed clock, pinned so every relative offset in signal.ts (`now - 96 *
// DAY` etc.) resolves to an exact, assertable number instead of a moving
// target.
const NOW = Date.UTC(2026, 0, 6, 8, 0, 0);
const TENANT = "tn_test";

// Mirrors of the private helpers signal.ts defines inline, so the day/landed
// arithmetic is pinned by an assertion rather than trusted on faith: a mutant
// that changes `DAY` or the `5 * HOUR` offset in the source produces a `ts` or
// `day` that no longer matches what these compute from the same seed clock.
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
const landed = (t: number): number => t + DAY - 5 * HOUR;

let db: CoreDb;
let ctx: SeedContext;

beforeEach(async () => {
  const client: Client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  ctx = {
    db,
    now: NOW,
    tenantId: TENANT,
    users: { "signal.lead": "usr_signal_lead", "tenant.compliance": "usr_tenant_compliance" },
    teams: { motor: "team_motor", health: "team_health", retention: "team_retention" },
    providers: {
      gonxt: "prov_gonxt",
      falcon: "prov_falcon",
      cedar: "prov_cedar",
      oryx: "prov_oryx",
      gulfHealth: "prov_gulf_health",
      meridian: "prov_meridian"
    },
    products: { motor: "prod_motor", health: "prod_health", travel: "prod_travel", home: "prod_home", life: "prod_life" },
    offerings: {
      gonxtMotor: "off_gonxt_motor",
      falconMotor: "off_falcon_motor",
      cedarMotor: "off_cedar_motor",
      oryxMotor: "off_oryx_motor",
      cedarMotorPlus: "off_cedar_motor_plus",
      gulfHealth: "off_gulf_health",
      gonxtTravel: "off_gonxt_travel",
      cedarHome: "off_cedar_home",
      oryxLife: "off_oryx_life"
    },
    channels: {
      web: "chn_web",
      app: "chn_app",
      callCentre: "chn_call_centre",
      brokerAlpha: "chn_broker_alpha",
      bankEmbed: "chn_bank_embed"
    },
    customerId: "cu_test",
    consentId: "cn_test",
    quoteRequestId: "qr_test",
    caseId: "cs_test",
    policyId: "pol_test",
    renewalPolicyId: "pol_renew_test",
    issuedAt: NOW + 2 * DAY
  };

  await seedSignal(ctx);
});

const growthLead = "user:usr_signal_lead";
const complianceOfficer = "user:usr_tenant_compliance";
const autopilot = "system:signal.budget_autopilot";

describe("seedSignal: audiences", () => {
  it("seeds the six audiences, every one but the suppression list excluding it", async () => {
    const rows = await db.select().from(schema.signalAudiences);
    expect(rows).toHaveLength(6);
    for (const a of rows) {
      expect(a.tenantId).toBe(TENANT);
      expect(a.createdBy).toBe(growthLead);
      expect(a.consentPurposes).not.toBe("");
    }

    const byName = new Map(rows.map((a) => [a.name, a]));

    const suppression = byName.get("Do not contact — withdrawn consent, complaints, open claims")!;
    expect(suppression.sizeCached).toBe(213);
    expect(suppression.refreshPolicy).toBe("hourly");
    expect(suppression.lastRefreshedAt).toBe(NOW - 40 * MINUTE);
    expect(suppression.consentPurposes).toBe("none");
    expect(suppression.createdAt).toBe(NOW - 96 * DAY);
    expect(suppression.updatedAt).toBe(NOW - 40 * MINUTE);
    expect(JSON.parse(suppression.definitionJson)).toEqual({
      any: [
        { field: "consent.marketing", op: "eq", value: false },
        { field: "consent.withdrawnAt", op: "is_not_null" },
        { field: "case.type", op: "eq", value: "complaint" },
        { field: "claim.status", op: "in", value: ["open", "assessing"] }
      ]
    });

    const motorNoHealth = byName.get("Motor policyholders with no health cover")!;
    expect(motorNoHealth.sizeCached).toBe(4_182);
    expect(motorNoHealth.refreshPolicy).toBe("daily");
    expect(motorNoHealth.lastRefreshedAt).toBe(NOW - 8 * HOUR);
    expect(motorNoHealth.createdAt).toBe(NOW - 96 * DAY);
    const motorDef = JSON.parse(motorNoHealth.definitionJson);
    expect(motorDef.all).toEqual([
      { field: "policy.productId", op: "eq", value: "prod_motor" },
      { field: "policy.status", op: "eq", value: "active" },
      { field: "policy.productId", op: "not_in_any_policy", value: "prod_health" }
    ]);
    // Every non-suppression audience excludes the suppression audience by id,
    // never by re-deriving the same criteria — that's the whole point of it
    // being a row.
    expect(motorDef.excludeAudienceId).toBe(suppression.id);

    const renewals45 = byName.get("Renewals due in 45 days")!;
    expect(renewals45.sizeCached).toBe(1_247);
    expect(renewals45.lastRefreshedAt).toBe(NOW - 8 * HOUR);
    const renewalsDef = JSON.parse(renewals45.definitionJson);
    expect(renewalsDef.all[1]).toEqual({ field: "policy.daysToExpiry", op: "between", value: [30, 45] });
    expect(renewalsDef.excludeAudienceId).toBe(suppression.id);

    const quoteAbandoners = byName.get("Quote started, no bind, last 7 days")!;
    expect(quoteAbandoners.sizeCached).toBe(386);
    expect(quoteAbandoners.refreshPolicy).toBe("hourly");
    expect(quoteAbandoners.lastRefreshedAt).toBe(NOW - 40 * MINUTE);
    expect(quoteAbandoners.consentPurposes).toBe("marketing,profiling");
    expect(quoteAbandoners.createdAt).toBe(NOW - 61 * DAY);
    const abandonersDef = JSON.parse(quoteAbandoners.definitionJson);
    expect(abandonersDef.all[0]).toEqual({ field: "quote_request.createdAt", op: "within_days", value: 7 });

    const travelLapsed = byName.get("Travel cover lapsed over 12 months ago")!;
    expect(travelLapsed.sizeCached).toBe(2_910);
    expect(travelLapsed.refreshPolicy).toBe("manual");
    expect(travelLapsed.lastRefreshedAt).toBe(NOW - 34 * DAY);
    expect(travelLapsed.createdAt).toBe(NOW - 34 * DAY);
    expect(travelLapsed.updatedAt).toBe(NOW - 34 * DAY);
    const travelDef = JSON.parse(travelLapsed.definitionJson);
    expect(travelDef.all).toEqual([
      { field: "policy.productId", op: "eq", value: "prod_travel" },
      { field: "policy.status", op: "eq", value: "lapsed" },
      { field: "policy.endedDaysAgo", op: "gte", value: 365 }
    ]);

    // Sized but never refreshed: cached is null, not zero — the bank partner
    // has not returned a segment file, and zero would read as "found nobody".
    const newToBank = byName.get("Bank-embedded customers, first policy under 30 days")!;
    expect(newToBank.sizeCached).toBeNull();
    expect(newToBank.lastRefreshedAt).toBeNull();
    expect(newToBank.refreshPolicy).toBe("manual");
    expect(newToBank.createdAt).toBe(NOW - 12 * DAY);
    expect(newToBank.updatedAt).toBe(NOW - 12 * DAY);
    const bankDef = JSON.parse(newToBank.definitionJson);
    expect(bankDef.all).toEqual([
      { field: "policy.channelId", op: "eq", value: "chn_bank_embed" },
      { field: "customer.policyCount", op: "eq", value: 1 },
      { field: "policy.issuedDaysAgo", op: "lte", value: 30 }
    ]);
    expect(bankDef.consentSource).toBe("partner_pass_through_pending");
    // No suppression exclusion recorded on this one — a partner-sourced
    // audience with pending consent status is not folded into the same rule.
    expect(bankDef.excludeAudienceId).toBeUndefined();
  });
});

describe("seedSignal: campaigns", () => {
  it("seeds the seven campaigns across every state and autonomy level", async () => {
    const rows = await db.select().from(schema.signalCampaigns);
    expect(rows).toHaveLength(7);
    for (const c of rows) {
      expect(c.tenantId).toBe(TENANT);
      expect(c.ownerRef).toBe(growthLead);
      expect(c.deletedAt).toBeNull();
    }

    const audiences = await db.select().from(schema.signalAudiences);
    const audienceIdByName = new Map(audiences.map((a) => [a.name, a.id]));
    const byName = new Map(rows.map((c) => [c.name, c]));

    const motorSearch = byName.get("Motor — always-on search")!;
    expect(motorSearch.objective).toBe("acq");
    expect(motorSearch.audienceId).toBe(audienceIdByName.get("Quote started, no bind, last 7 days"));
    expect(JSON.parse(motorSearch.channelsJson)).toEqual(["google_search", "bing_search"]);
    expect(JSON.parse(motorSearch.budgetJson)).toEqual({
      currency: "AED",
      period: "2026-01",
      dailyMinor: 350_000,
      capMinor: 10_850_000,
      upliftMinor: 1_500_000,
      autopilotBoundMinor: 1_000_000
    });
    expect(motorSearch.state).toBe("live");
    expect(motorSearch.autonomyLevel).toBe("act");
    expect(motorSearch.startAt).toBe(NOW - 96 * DAY);
    expect(motorSearch.endAt).toBeNull();
    expect(motorSearch.createdAt).toBe(NOW - 97 * DAY);
    expect(motorSearch.updatedAt).toBe(NOW - 2 * DAY - 2 * HOUR);
    expect(JSON.parse(motorSearch.guardrailChecksJson!)).toEqual({
      suppressionAudienceApplied: true,
      frequencyCapPerWeek: 2,
      quietHours: { from: "20:00", to: "08:00", tz: "Asia/Dubai" },
      brandKit: "pass",
      bannedClaims: "pass",
      checkedAt: NOW - 96 * DAY
    });

    const brandDec = byName.get("December brand — social")!;
    expect(brandDec.objective).toBe("acq");
    expect(brandDec.audienceId).toBe(audienceIdByName.get("Motor policyholders with no health cover"));
    expect(JSON.parse(brandDec.channelsJson)).toEqual(["meta", "instagram"]);
    expect(JSON.parse(brandDec.budgetJson)).toEqual({
      currency: "AED",
      period: "2025-12",
      dailyMinor: 420_000,
      capMinor: 13_020_000,
      releasedMinor: 2_300_000,
      autopilotBoundMinor: 1_000_000
    });
    expect(brandDec.state).toBe("paused");
    expect(brandDec.autonomyLevel).toBe("act_with_approval");
    expect(brandDec.startAt).toBe(NOW - 62 * DAY);
    expect(brandDec.endAt).toBe(NOW - 6 * DAY);
    expect(brandDec.createdAt).toBe(NOW - 68 * DAY);
    expect(brandDec.updatedAt).toBe(NOW - 32 * DAY - 2 * HOUR);
    expect(JSON.parse(brandDec.guardrailChecksJson!).checkedAt).toBe(NOW - 62 * DAY);

    const healthXsell = byName.get("Health cross-sell to motor holders")!;
    expect(healthXsell.objective).toBe("xsell");
    expect(healthXsell.audienceId).toBe(audienceIdByName.get("Motor policyholders with no health cover"));
    expect(JSON.parse(healthXsell.channelsJson)).toEqual(["email"]);
    expect(JSON.parse(healthXsell.budgetJson)).toEqual({
      currency: "AED",
      period: "2026-01",
      dailyMinor: 20_000,
      capMinor: 620_000,
      autopilotBoundMinor: 100_000
    });
    expect(healthXsell.state).toBe("live");
    expect(healthXsell.autonomyLevel).toBe("act_with_approval");
    expect(healthXsell.startAt).toBe(NOW - 21 * DAY);
    expect(healthXsell.endAt).toBe(NOW + 25 * DAY);
    expect(healthXsell.createdAt).toBe(NOW - 24 * DAY);
    expect(healthXsell.updatedAt).toBe(NOW - 3 * DAY);
    const healthGuardrails = JSON.parse(healthXsell.guardrailChecksJson!);
    expect(healthGuardrails.checkedAt).toBe(NOW - 21 * DAY);
    expect(healthGuardrails.consentPurposeChecked).toBe("marketing");

    // Scheduled, not live: the Arabic email creative has not cleared review.
    const renewalNudge = byName.get("Renewal nudge — 45 days out")!;
    expect(renewalNudge.objective).toBe("renewal");
    expect(renewalNudge.audienceId).toBe(audienceIdByName.get("Renewals due in 45 days"));
    expect(JSON.parse(renewalNudge.channelsJson)).toEqual(["email", "push"]);
    expect(JSON.parse(renewalNudge.budgetJson)).toEqual({
      currency: "AED",
      period: "2026-01",
      dailyMinor: 15_000,
      capMinor: 465_000,
      autopilotBoundMinor: 100_000
    });
    expect(renewalNudge.state).toBe("scheduled");
    expect(renewalNudge.autonomyLevel).toBe("act_with_approval");
    expect(renewalNudge.startAt).toBe(NOW + 4 * DAY);
    expect(renewalNudge.endAt).toBe(NOW + 88 * DAY);
    expect(renewalNudge.createdAt).toBe(NOW - 9 * DAY);
    expect(renewalNudge.updatedAt).toBe(NOW - DAY);
    const renewalGuardrails = JSON.parse(renewalNudge.guardrailChecksJson!);
    expect(renewalGuardrails.checkedAt).toBe(NOW - DAY);
    expect(renewalGuardrails.localesRequired).toEqual(["en", "ar"]);

    // In review: no guardrail record until launch runs the checks.
    const homeBundle = byName.get("Home + motor bundle")!;
    expect(homeBundle.objective).toBe("xsell");
    expect(homeBundle.audienceId).toBe(audienceIdByName.get("Motor policyholders with no health cover"));
    expect(JSON.parse(homeBundle.channelsJson)).toEqual(["email", "google_search"]);
    expect(JSON.parse(homeBundle.budgetJson)).toEqual({
      currency: "AED",
      period: "2026-02",
      dailyMinor: 12_000,
      capMinor: 372_000,
      autopilotBoundMinor: 100_000
    });
    expect(homeBundle.state).toBe("review");
    expect(homeBundle.autonomyLevel).toBe("draft");
    expect(homeBundle.guardrailChecksJson).toBeNull();
    expect(homeBundle.startAt).toBe(NOW + 26 * DAY);
    expect(homeBundle.endAt).toBe(NOW + 54 * DAY);
    expect(homeBundle.createdAt).toBe(NOW - 5 * DAY);
    expect(homeBundle.updatedAt).toBe(NOW - 5 * DAY);

    // Ended with unspent budget, which the second budget move takes out.
    const travelWinter = byName.get("Winter travel — school holidays")!;
    expect(travelWinter.objective).toBe("acq");
    expect(travelWinter.audienceId).toBe(audienceIdByName.get("Travel cover lapsed over 12 months ago"));
    expect(JSON.parse(travelWinter.channelsJson)).toEqual(["google_search", "meta"]);
    expect(JSON.parse(travelWinter.budgetJson)).toEqual({
      currency: "AED",
      period: "2025-12",
      dailyMinor: 180_000,
      capMinor: 7_200_000,
      unspentMinor: 250_000
    });
    expect(travelWinter.state).toBe("ended");
    expect(travelWinter.autonomyLevel).toBe("act_with_approval");
    expect(travelWinter.startAt).toBe(NOW - 52 * DAY);
    expect(travelWinter.endAt).toBe(NOW - 13 * DAY);
    expect(travelWinter.createdAt).toBe(NOW - 58 * DAY);
    expect(travelWinter.updatedAt).toBe(NOW - 13 * DAY);
    expect(JSON.parse(travelWinter.guardrailChecksJson!).checkedAt).toBe(NOW - 52 * DAY);

    // A draft with no audience attached yet — forcing one now would be a guess.
    const travelSummer = byName.get("Summer travel — early planning")!;
    expect(travelSummer.objective).toBe("acq");
    expect(travelSummer.audienceId).toBeNull();
    expect(JSON.parse(travelSummer.channelsJson)).toEqual(["meta", "youtube"]);
    expect(JSON.parse(travelSummer.budgetJson)).toEqual({
      currency: "AED",
      period: "2026-06",
      dailyMinor: 200_000,
      capMinor: 6_000_000,
      autopilotBoundMinor: 1_000_000
    });
    expect(travelSummer.state).toBe("draft");
    expect(travelSummer.autonomyLevel).toBe("suggest");
    expect(travelSummer.guardrailChecksJson).toBeNull();
    expect(travelSummer.startAt).toBeNull();
    expect(travelSummer.endAt).toBeNull();
    expect(travelSummer.createdAt).toBe(NOW - 2 * DAY);
    expect(travelSummer.updatedAt).toBe(NOW - 2 * DAY);
  });
});

describe("seedSignal: creatives", () => {
  it("seeds the nine creatives across every compliance lane", async () => {
    const rows = await db.select().from(schema.signalCreatives);
    expect(rows).toHaveLength(9);
    for (const c of rows) {
      expect(c.tenantId).toBe(TENANT);
      // No AI audit log entries are written by this seed, so a dangling run
      // id would be worse than an empty column.
      expect(c.aiAuditId).toBeNull();
    }

    const campaigns = await db.select().from(schema.signalCampaigns);
    const campaignIdByName = new Map(campaigns.map((c) => [c.name, c.id]));
    const byRef = new Map(rows.map((c) => [c.contentRef, c]));

    const searchEnA = byRef.get(SEED_CREATIVE_COPY["signal/creatives/motor-search/en-a.json"]!)!;
    expect(searchEnA.campaignId).toBe(campaignIdByName.get("Motor — always-on search"));
    expect(searchEnA.kind).toBe("ad");
    expect(searchEnA.locale).toBe("en");
    expect(searchEnA.variantGroup).toBe("motor-search-headline");
    expect(searchEnA.complianceStatus).toBe("passed");
    expect(searchEnA.generatedBy).toBe("ai");
    expect(searchEnA.createdAt).toBe(NOW - 93 * DAY);
    expect(searchEnA.updatedAt).toBe(NOW - DAY);
    expect(JSON.parse(searchEnA.complianceNotesJson!)).toEqual({
      checkedAt: NOW - 92 * DAY,
      checkedBy: complianceOfficer,
      claims: [{ text: "compare 12 insurers", basis: "panel size, verified against the provider list" }]
    });
    expect(JSON.parse(searchEnA.performanceJson!)).toEqual({ impressions: 24_310, clicks: 1_042, ctrBps: 429, binds: 61 });

    // Arabic outperforms English here — the finding the concluded landing-page
    // experiment acted on.
    const searchArA = byRef.get(SEED_CREATIVE_COPY["signal/creatives/motor-search/ar-a.json"]!)!;
    expect(searchArA.locale).toBe("ar");
    expect(searchArA.complianceStatus).toBe("passed");
    expect(JSON.parse(searchArA.performanceJson!)).toEqual({ impressions: 18_640, clicks: 906, ctrBps: 486, binds: 54 });

    // Flagged: never served, no performance and no attribution touch names it.
    const searchEnB = byRef.get(SEED_CREATIVE_COPY["signal/creatives/motor-search/en-b.json"]!)!;
    expect(searchEnB.complianceStatus).toBe("flagged");
    expect(searchEnB.performanceJson).toBeNull();
    expect(searchEnB.createdAt).toBe(NOW - 7 * DAY);
    expect(searchEnB.updatedAt).toBe(NOW - 7 * DAY);
    const enBNotes = JSON.parse(searchEnB.complianceNotesJson!);
    expect(enBNotes.lane).toBe("soft_flag");
    expect(enBNotes.findings).toHaveLength(1);
    expect(enBNotes.findings[0].rule).toBe("comparison_claim_requires_source");

    // Blocked in the hard lane — a promise of acceptance no aggregator can make.
    const brandArBlocked = byRef.get(SEED_CREATIVE_COPY["signal/creatives/december-brand/ar-guarantee.json"]!)!;
    expect(brandArBlocked.campaignId).toBe(campaignIdByName.get("December brand — social"));
    expect(brandArBlocked.complianceStatus).toBe("blocked");
    expect(brandArBlocked.performanceJson).toBeNull();
    expect(brandArBlocked.createdAt).toBe(NOW - 47 * DAY);
    const blockedNotes = JSON.parse(brandArBlocked.complianceNotesJson!);
    expect(blockedNotes.lane).toBe("hard_block");
    expect(blockedNotes.decidedBy).toBe(complianceOfficer);
    expect(blockedNotes.findings[0].rule).toBe("no_guarantee_of_cover");

    // The social post whose weak numbers cost the brand campaign its budget.
    const brandSocialEn = byRef.get(SEED_CREATIVE_COPY["signal/creatives/december-brand/en-social.json"]!)!;
    expect(brandSocialEn.kind).toBe("social");
    expect(brandSocialEn.complianceStatus).toBe("passed");
    expect(brandSocialEn.generatedBy).toBe("human");
    expect(brandSocialEn.createdAt).toBe(NOW - 62 * DAY);
    expect(brandSocialEn.updatedAt).toBe(NOW - 17 * DAY);
    expect(JSON.parse(brandSocialEn.performanceJson!)).toEqual({
      impressions: 236_460,
      clicks: 2_521,
      ctrBps: 107,
      binds: 15
    });

    const lpEn = byRef.get(SEED_CREATIVE_COPY["signal/creatives/motor-lp/en.mdx"]!)!;
    expect(lpEn.kind).toBe("lp");
    expect(lpEn.variantGroup).toBe("motor-lp-arabic-first");
    expect(lpEn.generatedBy).toBe("human");
    expect(lpEn.createdAt).toBe(NOW - 97 * DAY);
    expect(JSON.parse(lpEn.performanceJson!)).toEqual({ visits: 9_204, quoteStarts: 1_086, quoteStartRateBps: 1_180 });

    // Authored in Arabic, not translated — the whole point of the experiment
    // it belongs to.
    const lpAr = byRef.get(SEED_CREATIVE_COPY["signal/creatives/motor-lp/ar.mdx"]!)!;
    expect(lpAr.locale).toBe("ar");
    expect(lpAr.generatedBy).toBe("ai");
    expect(lpAr.createdAt).toBe(NOW - 32 * DAY);
    expect(JSON.parse(lpAr.performanceJson!)).toEqual({ visits: 7_918, quoteStarts: 1_156, quoteStartRateBps: 1_460 });
    // The rate difference the experiment measured, computed the same way the
    // seed's own comment describes it.
    expect(JSON.parse(lpAr.performanceJson!).quoteStartRateBps - JSON.parse(lpEn.performanceJson!).quoteStartRateBps).toBe(
      280
    );

    // Pending review — why the renewal campaign is scheduled, not live.
    const renewalEmailAr = byRef.get(SEED_CREATIVE_COPY["signal/creatives/renewal-nudge/ar-email.mjml"]!)!;
    expect(renewalEmailAr.campaignId).toBe(campaignIdByName.get("Renewal nudge — 45 days out"));
    expect(renewalEmailAr.kind).toBe("email");
    expect(renewalEmailAr.complianceStatus).toBe("pending");
    expect(renewalEmailAr.complianceNotesJson).toBeNull();
    expect(renewalEmailAr.performanceJson).toBeNull();
    expect(renewalEmailAr.createdAt).toBe(NOW - DAY);

    // No stored consent record, so the script declares "no likeness" rather
    // than leaving the question open.
    const summerScriptEn = byRef.get(SEED_CREATIVE_COPY["signal/creatives/summer-travel/en-script.md"]!)!;
    expect(summerScriptEn.campaignId).toBe(campaignIdByName.get("Summer travel — early planning"));
    expect(summerScriptEn.kind).toBe("video_script");
    expect(summerScriptEn.complianceStatus).toBe("pending");
    expect(summerScriptEn.generatedBy).toBe("human");
    expect(summerScriptEn.createdAt).toBe(NOW - 2 * DAY);
    const scriptNotes = JSON.parse(summerScriptEn.complianceNotesJson!);
    expect(scriptNotes.likeness).toBe("none — illustrated brand character, no real person depicted or voiced");
    expect(scriptNotes.submittedBy).toBe(growthLead);
    expect(scriptNotes.submittedAt).toBe(NOW - 2 * DAY);
  });
});

describe("seedSignal: experiments", () => {
  it("seeds one won, one lost, one running, one abandoned and one draft test", async () => {
    const rows = await db.select().from(schema.signalExperiments);
    expect(rows).toHaveLength(5);
    for (const e of rows) expect(e.tenantId).toBe(TENANT);

    const campaigns = await db.select().from(schema.signalCampaigns);
    const campaignIdByName = new Map(campaigns.map((c) => [c.name, c.id]));
    const byHypothesis = new Map(rows.map((e) => [e.hypothesis, e]));

    const won = byHypothesis.get(
      "A landing page written in Arabic, rather than translated from the English one, lifts quote starts for Arabic traffic."
    )!;
    expect(won.campaignId).toBe(campaignIdByName.get("Motor — always-on search"));
    expect(won.metric).toBe("quote_start_rate");
    expect(won.minSample).toBe(3_000);
    expect(won.state).toBe("concluded");
    expect(won.concludedAt).toBe(NOW - 9 * DAY);
    expect(won.createdAt).toBe(NOW - 32 * DAY);
    const wonResult = JSON.parse(won.resultJson!);
    expect(wonResult.verdict).toBe("won");
    expect(wonResult.winner).toBe("arabic_first");
    expect(wonResult.samples).toEqual({ control: 9_204, arabic_first: 7_918 });
    expect(wonResult.rateBps).toEqual({ control: 1_180, arabic_first: 1_460 });
    expect(wonResult.upliftBps).toBe(280);
    // The uplift is exactly the arm-to-arm rate difference, not an invented
    // round number.
    expect(wonResult.rateBps.arabic_first - wonResult.rateBps.control).toBe(wonResult.upliftBps);
    expect(wonResult.probabilityToBeatControlBps).toBe(9_870);
    expect(wonResult.stoppedBy).toBe("sequential_boundary");

    const lost = byHypothesis.get("A discount-led headline binds more people than a cover-led headline.")!;
    expect(lost.campaignId).toBe(campaignIdByName.get("Motor — always-on search"));
    expect(lost.metric).toBe("click_to_bind_rate");
    expect(lost.minSample).toBe(2_000);
    expect(lost.state).toBe("concluded");
    expect(lost.concludedAt).toBe(NOW - 16 * DAY);
    expect(lost.createdAt).toBe(NOW - 38 * DAY);
    const lostResult = JSON.parse(lost.resultJson!);
    expect(lostResult.verdict).toBe("lost");
    expect(lostResult.winner).toBeNull();
    expect(lostResult.rateBps).toEqual({ control: 640, discount: 590 });
    expect(lostResult.upliftBps).toBe(-50);
    expect(lostResult.rateBps.discount - lostResult.rateBps.control).toBe(lostResult.upliftBps);
    expect(lostResult.probabilityToBeatControlBps).toBe(2_140);

    // Running, no result yet — 4 days of an 800-person sample is noise.
    const running = byHypothesis.get(
      "Nudging at 45 days rather than 30 days raises renewal acceptance without raising unsubscribes."
    )!;
    expect(running.campaignId).toBe(campaignIdByName.get("Renewal nudge — 45 days out"));
    expect(running.metric).toBe("renewal_accept_rate");
    expect(running.minSample).toBe(800);
    expect(running.state).toBe("running");
    expect(running.resultJson).toBeNull();
    expect(running.concludedAt).toBeNull();
    expect(running.createdAt).toBe(NOW - 4 * DAY);

    // Abandoned for the right reason: reaching sample would mean messaging
    // people who never opted in to that channel.
    const abandoned = byHypothesis.get("WhatsApp beats email for the health cross-sell.")!;
    expect(abandoned.campaignId).toBe(campaignIdByName.get("Health cross-sell to motor holders"));
    expect(abandoned.minSample).toBe(1_200);
    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.concludedAt).toBe(NOW - 11 * DAY);
    expect(abandoned.createdAt).toBe(NOW - 19 * DAY);
    const abandonedResult = JSON.parse(abandoned.resultJson!);
    expect(abandonedResult.verdict).toBe("abandoned");
    expect(abandonedResult.reachableShareBps).toBe(3_800);
    expect(abandonedResult.abandonedBy).toBe(growthLead);

    // No campaign: an AEO test belongs to the earned surface, not a budget line.
    const draft = byHypothesis.get(
      "Answer pages that close with a quote call to action are cited as often as ones that close with a plain summary."
    )!;
    expect(draft.campaignId).toBeNull();
    expect(draft.metric).toBe("aeo_citation_share");
    expect(draft.minSample).toBe(20);
    expect(draft.state).toBe("draft");
    expect(draft.resultJson).toBeNull();
    expect(draft.concludedAt).toBeNull();
    expect(draft.createdAt).toBe(NOW - DAY);
  });
});

describe("seedSignal: budget moves and their approvals", () => {
  it("seeds six moves that reconcile with the brand campaign's released total, and two approvals", async () => {
    const moves = await db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(6);
    for (const m of moves) {
      expect(m.tenantId).toBe(TENANT);
      expect(m.currency).toBe("AED");
      // Every move is reversible for exactly seven days from when it landed.
      expect(m.reversibleUntil - m.ts).toBe(7 * DAY);
    }

    const campaigns = await db.select().from(schema.signalCampaigns);
    const brandDecId = campaigns.find((c) => c.name === "December brand — social")!.id;
    const motorSearchId = campaigns.find((c) => c.name === "Motor — always-on search")!.id;
    const travelWinterId = campaigns.find((c) => c.name === "Winter travel — school holidays")!.id;
    const brandMeta = `signal_campaign:${brandDecId}#meta`;
    const searchGoogle = `signal_campaign:${motorSearchId}#google_search`;
    const searchBing = `signal_campaign:${motorSearchId}#bing_search`;

    const byAmount = new Map(moves.map((m) => [m.amountMinor, m]));

    const brandToSearch = byAmount.get(800_000)!;
    expect(brandToSearch.fromRef).toBe(brandMeta);
    expect(brandToSearch.toRef).toBe(searchGoogle);
    expect(brandToSearch.reason).toBe(
      "Marginal cost per policy on search ran AED 174 below social for six days straight, so the rest of the December brand budget followed the cheaper policies."
    );
    expect(brandToSearch.approvedBy).toBe("auto");
    expect(brandToSearch.reversedBy).toBeNull();
    expect(brandToSearch.reversedAt).toBeNull();
    expect(brandToSearch.ts).toBe(NOW - 32 * DAY - 2 * HOUR);
    expect(JSON.parse(brandToSearch.evidenceJson!)).toEqual({
      window: { from: day(NOW - 38 * DAY), to: day(NOW - 33 * DAY) },
      marginalCacMinor: { google_search: 16_800, meta: 34_200 },
      dailyCapBeforeMinor: 240_000,
      dailyCapAfterMinor: 350_000,
      boundMinor: 1_000_000
    });

    // Reversed on the same row rather than as a second, opposite move — the
    // ledger shows one decision that was undone, not two independent ones.
    const pixelArtefact = byAmount.get(320_000)!;
    expect(pixelArtefact.fromRef).toBe(searchGoogle);
    expect(pixelArtefact.toRef).toBe(`signal_campaign:${travelWinterId}#meta`);
    expect(pixelArtefact.approvedBy).toBe("auto");
    expect(pixelArtefact.reversedBy).toBe(growthLead);
    expect(pixelArtefact.reversedAt).toBe(NOW - 18 * DAY);
    expect(pixelArtefact.ts).toBe(NOW - 20 * DAY);
    const pixelEvidence = JSON.parse(pixelArtefact.evidenceJson!);
    expect(pixelEvidence.window).toEqual({ from: day(NOW - 21 * DAY), to: day(NOW - 20 * DAY) });
    expect(pixelEvidence.observedUpliftBps).toBe(9_800);
    expect(pixelEvidence.reversal).toEqual({
      reason: "A duplicated conversion pixel counted every travel bind twice. Once deduplicated the uplift was 0.",
      detectedBy: "anomaly guard",
      at: NOW - 18 * DAY
    });

    const travelRemainder = byAmount.get(250_000)!;
    expect(travelRemainder.fromRef).toBe(`signal_campaign:${travelWinterId}#google_search`);
    expect(travelRemainder.toRef).toBe(searchGoogle);
    expect(travelRemainder.approvedBy).toBe("auto");
    expect(travelRemainder.ts).toBe(NOW - 12 * DAY);
    expect(JSON.parse(travelRemainder.evidenceJson!)).toEqual({
      campaignEndedAt: day(NOW - 13 * DAY),
      capMinor: 7_200_000,
      spentMinor: 6_950_000,
      boundMinor: 1_000_000
    });

    // Over the autopilot bound, so this one went to a person, not the ledger.
    const januaryUplift = byAmount.get(1_500_000)!;
    expect(januaryUplift.fromRef).toBe(brandMeta);
    expect(januaryUplift.toRef).toBe(searchGoogle);
    expect(januaryUplift.reason).toBe(
      "Search closed December at AED 189 per policy against brand's AED 342, so January opened with the brand budget behind search."
    );
    expect(januaryUplift.approvedBy).toBe(growthLead);
    expect(januaryUplift.ts).toBe(NOW - 6 * DAY);
    expect(JSON.parse(januaryUplift.evidenceJson!)).toEqual({
      window: { from: day(NOW - 36 * DAY), to: day(NOW - 6 * DAY) },
      cacPerPolicyMinor: { google_search: 18_900, meta: 34_200 },
      boundMinor: 1_000_000,
      decisionRef: "north: pause the December brand campaign and move the budget to search"
    });

    const bingToGoogle = byAmount.get(180_000)!;
    expect(bingToGoogle.fromRef).toBe(searchBing);
    expect(bingToGoogle.toRef).toBe(searchGoogle);
    expect(bingToGoogle.approvedBy).toBe("auto");
    expect(bingToGoogle.ts).toBe(NOW - 2 * DAY - 2 * HOUR);
    expect(JSON.parse(bingToGoogle.evidenceJson!)).toEqual({
      window: { from: day(NOW - 5 * DAY), to: day(NOW - 2 * DAY) },
      cacPerPolicyMinor: { google_search: 20_700, bing_search: 22_800 },
      boundMinor: 1_000_000
    });

    // Above the bound and not yet decided: the money has not moved, so the
    // campaign's `releasedMinor` excludes it.
    const pendingRelease = byAmount.get(2_400_000)!;
    expect(pendingRelease.fromRef).toBe(brandMeta);
    expect(pendingRelease.toRef).toBe(searchGoogle);
    expect(pendingRelease.approvedBy).toBe("pending");
    expect(pendingRelease.reversedBy).toBeNull();
    expect(pendingRelease.ts).toBe(NOW - 2 * HOUR);
    expect(JSON.parse(pendingRelease.evidenceJson!)).toEqual({
      window: { from: day(NOW - 5 * DAY), to: day(NOW - DAY) },
      cappedDays: 4,
      boundMinor: 1_000_000,
      requiresApproval: true
    });

    // The reconciliation the seed's own comment claims: the two applied moves
    // out of the brand campaign sum to exactly its reported released total.
    const brandBudget = JSON.parse(campaigns.find((c) => c.id === brandDecId)!.budgetJson);
    expect(brandToSearch.amountMinor + januaryUplift.amountMinor).toBe(brandBudget.releasedMinor);

    const approvals = await db.select().from(schema.approvals);
    expect(approvals).toHaveLength(2);
    for (const a of approvals) {
      expect(a.tenantId).toBe(TENANT);
      expect(a.policyKey).toBe("signal.budget_move");
      expect(a.module).toBe("signal");
      expect(a.requestedBy).toBe(autopilot);
    }
    const byDecision = new Map(approvals.map((a) => [a.decision, a]));

    const approved = byDecision.get("approved")!;
    expect(approved.subjectRef).toBe(`budget-moves:${januaryUplift.id}`);
    expect(approved.decidedBy).toBe(growthLead);
    expect(approved.decidedAt).toBe(NOW - 6 * DAY);
    expect(approved.requestedAt).toBe(NOW - 6 * DAY - 2 * HOUR);
    expect(approved.reason).toBe(
      "December's numbers make the case. Approved for January only — revisit if cost per policy goes back above AED 220."
    );

    const pending = byDecision.get("pending")!;
    expect(pending.subjectRef).toBe(`budget-moves:${pendingRelease.id}`);
    expect(pending.decidedBy).toBeNull();
    expect(pending.decidedAt).toBeNull();
    expect(pending.requestedAt).toBe(NOW - 2 * HOUR);
  });
});

describe("seedSignal: AEO pages", () => {
  it("seeds six answer-engine pages across published, stale, draft and retired", async () => {
    const rows = await db.select().from(schema.signalAeoPages);
    expect(rows).toHaveLength(6);
    for (const p of rows) expect(p.tenantId).toBe(TENANT);

    const byCluster = new Map(rows.map((p) => [`${p.queryCluster}::${p.locale}`, p]));

    const motorEn = byCluster.get("best car insurance dubai::en")!;
    expect(motorEn.status).toBe("published");
    expect(motorEn.freshness).toBe(NOW - 2 * DAY);
    expect(motorEn.createdAt).toBe(NOW - 88 * DAY);
    expect(motorEn.updatedAt).toBe(NOW - 2 * DAY);
    expect(JSON.parse(motorEn.citationsCheckJson!)).toEqual({
      checkedAt: NOW - 2 * DAY,
      claims: 9,
      sourced: 9,
      unverified: 0,
      sources: ["provider panel", "published policy wordings"]
    });
    const citedBy = JSON.parse(motorEn.citedByJson!);
    expect(Array.isArray(citedBy)).toBe(true);
    const engines = citedBy.map((c: { engine: string }) => c.engine);
    expect(engines).toContain("chatgpt");
    expect(engines).toContain("perplexity");

    const motorAr = byCluster.get("تأمين السيارات في دبي::ar")!;
    expect(motorAr.status).toBe("published");
    expect(motorAr.locale).toBe("ar");
    expect(JSON.parse(motorAr.citedByJson!)).toHaveLength(1);

    const travel = byCluster.get("travel insurance schengen visa::en")!;
    expect(travel.status).toBe("published");
    expect(travel.freshness).toBe(NOW - 12 * DAY);

    // Stale despite a check nine days ago: content freshness is a separate
    // clock from "did we look at it" — one unsourced claim is enough to pull
    // the page down until an underwriter re-confirms the wording.
    const stale = byCluster.get("car insurance renewal grace period uae::en")!;
    expect(stale.status).toBe("stale");
    expect(stale.updatedAt).toBe(NOW - 9 * DAY);
    expect(stale.freshness).toBe(NOW - 96 * DAY);
    expect(stale.createdAt).toBe(stale.freshness);
    const staleCheck = JSON.parse(stale.citationsCheckJson!);
    expect(staleCheck.checkedAt).toBe(NOW - 9 * DAY);
    expect(staleCheck.claims).toBe(7);
    expect(staleCheck.sourced).toBe(6);
    expect(staleCheck.unverified).toBe(1);
    expect(JSON.parse(stale.citedByJson!)).toEqual([]);

    const draft = byCluster.get("health insurance for domestic workers uae::en")!;
    expect(draft.status).toBe("draft");
    expect(draft.citationsCheckJson).toBeNull();
    expect(draft.freshness).toBeNull();
    expect(draft.citedByJson).toBeNull();
    expect(draft.contentRef).toBe("signal/aeo/en/domestic-worker-health-cover.mdx");
    expect(draft.createdAt).toBe(NOW - 3 * DAY);

    // Retired: merged into the motor cluster, kept around only for its
    // inbound links, so its freshness clock is the oldest of any page.
    const retired = byCluster.get("third party vs comprehensive cover::ar")!;
    expect(retired.status).toBe("retired");
    expect(retired.locale).toBe("ar");
    expect(retired.freshness).toBe(NOW - 140 * DAY);
    expect(retired.createdAt).toBe(NOW - 140 * DAY);
    expect(retired.updatedAt).toBe(NOW - 44 * DAY);
  });
});

describe("seedSignal: attribution events", () => {
  it("seeds a ten-touch journey across two anonymous ids, one converting and one dropping off", async () => {
    const rows = await db.select().from(schema.signalAttributionEvents);
    expect(rows).toHaveLength(10);
    for (const e of rows) expect(e.tenantId).toBe(TENANT);

    const rania = rows
      .filter((e) => e.anonId === "an_2f7c91b4")
      .sort((a, b) => a.ts - b.ts);
    expect(rania).toHaveLength(7);
    expect(rania.map((e) => e.touchType)).toEqual([
      "impression",
      "click",
      "visit",
      "visit",
      "click",
      "lead",
      "bind"
    ]);

    const impression = rania[0]!;
    expect(impression.ts).toBe(NOW - 5 * DAY);
    expect(impression.customerId).toBeNull();

    const firstClick = rania[1]!;
    expect(firstClick.ts).toBe(NOW - 5 * DAY + 4 * MINUTE);

    const firstVisit = rania[2]!;
    expect(firstVisit.ts).toBe(NOW - 5 * DAY + 5 * MINUTE);

    // The AEO visit, tied to the answer page rather than a campaign/creative.
    const aeoVisit = rania[3]!;
    expect(aeoVisit.ts).toBe(NOW - 3 * DAY + 6 * HOUR);
    expect(aeoVisit.campaignId).toBeNull();
    const aeoPages = await db.select().from(schema.signalAeoPages);
    const motorEnPage = aeoPages.find((p) => p.queryCluster === "best car insurance dubai" && p.locale === "en")!;
    expect(aeoVisit.subjectRef).toBe(`signal_aeo_page:${motorEnPage.id}`);

    // The stitched click, the moment anonymous becomes identified.
    const stitchedClick = rania[4]!;
    expect(stitchedClick.ts).toBe(NOW - 40 * MINUTE);
    expect(stitchedClick.customerId).toBe(ctx.customerId);

    const lead = rania[5]!;
    expect(lead.ts).toBe(NOW);
    expect(lead.subjectRef).toBe(`quote_request:${ctx.quoteRequestId}`);
    expect(lead.customerId).toBe(ctx.customerId);

    const bind = rania[6]!;
    expect(bind.ts).toBe(ctx.issuedAt);
    expect(bind.valueMinor).toBe(448_000);
    expect(bind.currency).toBe("AED");
    expect(bind.subjectRef).toBe(`axis_case:${ctx.caseId}`);
    expect(bind.customerId).toBe(ctx.customerId);

    // The brand drop-off: three touches, never converts, never stitched to a
    // customer id.
    const dropoff = rows
      .filter((e) => e.anonId === "an_84b0d2e1")
      .sort((a, b) => a.ts - b.ts);
    expect(dropoff).toHaveLength(3);
    expect(dropoff.map((e) => e.touchType)).toEqual(["impression", "click", "visit"]);
    for (const touch of dropoff) {
      expect(touch.customerId).toBeNull();
      expect(touch.valueMinor).toBeNull();
    }
    const campaigns = await db.select().from(schema.signalCampaigns);
    const creatives = await db.select().from(schema.signalCreatives);
    const brandDecId = campaigns.find((c) => c.name === "December brand — social")!.id;
    const brandSocialEnId = creatives.find((c) => c.contentRef === SEED_CREATIVE_COPY["signal/creatives/december-brand/en-social.json"])!.id;
    for (const touch of dropoff) {
      expect(touch.campaignId).toBe(brandDecId);
      expect(touch.creativeId).toBe(brandSocialEnId);
    }
    expect(dropoff[0]!.ts).toBe(NOW - 17 * DAY + 3 * HOUR);
    expect(dropoff[1]!.ts - dropoff[0]!.ts).toBe(11 * MINUTE);
    expect(dropoff[2]!.ts - dropoff[0]!.ts).toBe(12 * MINUTE);
    expect(dropoff[2]!.ts - dropoff[1]!.ts).toBe(MINUTE);
  });
});

describe("seedSignal: spend", () => {
  it("seeds twelve rows whose ts defaults to a landed offset, except one explicit import", async () => {
    const rows = await db.select().from(schema.signalSpend);
    expect(rows).toHaveLength(12);
    for (const s of rows) {
      expect(s.tenantId).toBe(TENANT);
      expect(s.currency).toBe("AED");
      expect(s.day).toBe(day(s.ts === NOW - 12 * HOUR ? NOW - 5 * DAY : s.ts - DAY + 5 * HOUR));
    }

    const campaigns = await db.select().from(schema.signalCampaigns);
    const motorSearchId = campaigns.find((c) => c.name === "Motor — always-on search")!.id;
    const brandDecId = campaigns.find((c) => c.name === "December brand — social")!.id;

    // The one explicit override: an imported row, landed at a fixed hour
    // rather than the default next-day-minus-five-hours offset.
    const newYearsRow = rows.find((s) => s.source === "import")!;
    expect(newYearsRow.channel).toBe("google_search");
    expect(newYearsRow.campaignId).toBe(motorSearchId);
    expect(newYearsRow.ts).toBe(NOW - 12 * HOUR);
    expect(newYearsRow.day).toBe(day(NOW - 5 * DAY));

    // The two rows the seed's own comment ties together: December cost per
    // policy fell from about AED 211 to AED 181 day over day.
    const day32 = rows.find((s) => s.campaignId === motorSearchId && s.channel === "google_search" && s.amountMinor === 231_600)!;
    expect(day32.conversions).toBe(11);
    expect(Math.round(day32.amountMinor / day32.conversions / 100)).toBe(211);
    expect(day32.ts).toBe(landed(NOW - 32 * DAY));

    const day31 = rows.find((s) => s.campaignId === motorSearchId && s.channel === "google_search" && s.amountMinor === 344_800)!;
    expect(day31.conversions).toBe(19);
    expect(Math.round(day31.amountMinor / day31.conversions / 100)).toBe(181);

    // The social spend on the same day the seed's comment says made the
    // brand-to-search move "obvious": AED 344 a policy.
    const brandDay32 = rows.find((s) => s.campaignId === brandDecId && s.channel === "meta" && s.amountMinor === 412_300)!;
    expect(brandDay32.conversions).toBe(12);
    expect(Math.round(brandDay32.amountMinor / brandDay32.conversions / 100)).toBe(344);
  });
});
