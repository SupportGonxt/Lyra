import { id, schema } from "@lyra/db";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { dayName, monthKey, monthName } from "./period.js";

// SIGNAL is the demand side of the same story the core seed already tells. The
// motor search campaign below is what Rania Haddad clicked, the quote request
// she started is the `lead` touch, and the case that bound is the one
// conversion in here that a finance person would recognise. Everything else is
// the machinery around that single sale: the audiences the campaigns aim at,
// the creatives compliance cleared or refused, the experiments that settled and
// the one that could not, and the autopilot's ledger of every dirham it moved.
//
// Two product rules decide what is deliberately absent. There is no engagement
// farming, no unsolicited bulk messaging and no multi-account behaviour here,
// so nothing in this seed teaches an operator that the platform does that. And
// no creative depicts a real person: the one video script carries an explicit
// "no likeness" note rather than leaving the question unanswered, because a
// synthetic likeness needs a stored consent record and this tenant has none.
// The ad networks appear as channels a campaign buys — never as a third-party
// management suite sitting between the operator and the work.

/**
 * The words of each seeded creative, keyed by the file key the seed used to
 * write in their place. contentRef holds the copy inline — what every
 * generated creative holds and what the studio renders — and the keys pointed
 * at a bucket that never existed. The keys stay only so the resync seam
 * (seed.ts syncSeedCreativeCopy) can find and repair a tenant seeded before.
 */
export const SEED_CREATIVE_COPY: Readonly<Record<string, string>> = {
  "signal/creatives/motor-search/en-a.json": "Compare 12 insurers in one go.\nMotor cover quoted in minutes, and bound before your coffee cools.",
  "signal/creatives/motor-search/ar-a.json": "قارن بين ١٢ شركة تأمين دفعة واحدة.\nعروض تأمين المركبات خلال دقائق، والإصدار قبل أن تبرد قهوتك.",
  "signal/creatives/motor-search/en-b.json": "Get the cheapest motor cover in the UAE.\nQuotes from our panel in minutes.",
  "signal/creatives/december-brand/ar-guarantee.json": "قبول مضمون مهما كان سجلك.\nتأمين مركبتك يبدأ اليوم.",
  "signal/creatives/december-brand/en-social.json": "December on the road, covered.\nRenew or switch your motor cover before the holidays in three taps.",
  "signal/creatives/motor-lp/en.mdx": "Motor cover, compared properly.\nTwelve insurers, one form, and a real person when you need one.",
  "signal/creatives/motor-lp/ar.mdx": "تأمين المركبات، بمقارنة حقيقية.\nاثنتا عشرة شركة، نموذج واحد، وشخص حقيقي حين تحتاجه.",
  "signal/creatives/renewal-nudge/ar-email.mjml": "تنتهي وثيقتك خلال ٤٥ يومًا.\nراجع تغطيتك الآن وجدّدها بنقرة واحدة دون أي انقطاع.",
  "signal/creatives/summer-travel/en-script.md": "Summer, sorted.\nA suitcase zips shut. Travel cover that meets your Schengen visa, in minutes.",
};

export async function seedSignal(ctx: SeedContext): Promise<void> {
  const { db, tenantId, now } = ctx;

  // Noor Jamal owns growth (she is also the owner of `cac_per_policy` in NORTH)
  // and Khalid Al Rashed is the compliance reviewer whose name goes on a block.
  // Campaign names and the autopilot's reasons name their month in prose; a
  // demo seeded in July must not have a campaign called "December brand".
  const thisMonthName = monthName(now);
  const lastMonthName = monthName(now, -1);
  const growthLead = `user:${ctx.users["signal.lead"]!}`;
  const complianceOfficer = `user:${ctx.users["tenant.compliance"]!}`;
  // The autopilot acts under its own actor ref so an operator reading the
  // approvals queue can tell a machine request from a human one at a glance.
  const autopilot = "system:signal.budget_autopilot";

  /** `signal_spend.day` is a calendar day, so it is derived from the seed clock rather than typed twice. */
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  /** Network spend lands at 03:00 the morning after the day it reports, which is what `ts` records. */
  const landed = (t: number): number => t + DAY - 5 * HOUR;

  /* --------------------------------------------------------------- audiences */

  // Audience definitions point at real product and consent rows so the size
  // numbers are not the only thing a reader can check.
  const audiences = {
    motorNoHealth: id("aud", now),
    renewals45: id("aud", now + 1),
    quoteAbandoners: id("aud", now + 2),
    travelLapsed: id("aud", now + 3),
    newToBank: id("aud", now + 4),
    suppression: id("aud", now + 5)
  };

  await db.insert(schema.signalAudiences).values([
    {
      id: audiences.motorNoHealth,
      tenantId,
      name: "Motor policyholders with no health cover",
      definitionJson: JSON.stringify({
        all: [
          { field: "policy.productId", op: "eq", value: ctx.products.motor },
          { field: "policy.status", op: "eq", value: "active" },
          { field: "policy.productId", op: "not_in_any_policy", value: ctx.products.health }
        ],
        excludeAudienceId: audiences.suppression
      }),
      sizeCached: 4_182,
      refreshPolicy: "daily",
      lastRefreshedAt: now - 8 * HOUR,
      consentPurposes: "marketing",
      createdBy: growthLead,
      createdAt: now - 96 * DAY,
      updatedAt: now - 8 * HOUR
    },
    {
      id: audiences.renewals45,
      tenantId,
      // ORBIT raises renewals 45 days out, so the audience that nudges them
      // uses the same window; a different number here would put marketing and
      // operations on two clocks.
      name: "Renewals due in 45 days",
      definitionJson: JSON.stringify({
        all: [
          { field: "policy.status", op: "eq", value: "active" },
          { field: "policy.daysToExpiry", op: "between", value: [30, 45] }
        ],
        excludeAudienceId: audiences.suppression
      }),
      sizeCached: 1_247,
      refreshPolicy: "daily",
      lastRefreshedAt: now - 8 * HOUR,
      consentPurposes: "marketing",
      createdBy: growthLead,
      createdAt: now - 96 * DAY,
      updatedAt: now - 8 * HOUR
    },
    {
      id: audiences.quoteAbandoners,
      tenantId,
      // Hourly because the whole value of this audience is reaching someone
      // while they are still shopping; a daily refresh would miss the window.
      name: "Quote started, no bind, last 7 days",
      definitionJson: JSON.stringify({
        all: [
          { field: "quote_request.createdAt", op: "within_days", value: 7 },
          { field: "quote_request.hasBind", op: "eq", value: false },
          { field: "consent.marketing", op: "eq", value: true }
        ],
        excludeAudienceId: audiences.suppression
      }),
      sizeCached: 386,
      refreshPolicy: "hourly",
      lastRefreshedAt: now - 40 * MINUTE,
      consentPurposes: "marketing,profiling",
      createdBy: growthLead,
      createdAt: now - 61 * DAY,
      updatedAt: now - 40 * MINUTE
    },
    {
      id: audiences.travelLapsed,
      tenantId,
      name: "Travel cover lapsed over 12 months ago",
      definitionJson: JSON.stringify({
        all: [
          { field: "policy.productId", op: "eq", value: ctx.products.travel },
          { field: "policy.status", op: "eq", value: "lapsed" },
          { field: "policy.endedDaysAgo", op: "gte", value: 365 }
        ],
        excludeAudienceId: audiences.suppression
      }),
      sizeCached: 2_910,
      refreshPolicy: "manual",
      lastRefreshedAt: now - 34 * DAY,
      consentPurposes: "marketing",
      createdBy: growthLead,
      createdAt: now - 34 * DAY,
      updatedAt: now - 34 * DAY
    },
    {
      id: audiences.newToBank,
      tenantId,
      // Sized but never refreshed: the embedded bank partner has not returned a
      // segment file yet, which is why `sizeCached` is null rather than zero.
      // Zero would read as "we looked and found nobody".
      name: "Bank-embedded customers, first policy under 30 days",
      definitionJson: JSON.stringify({
        all: [
          { field: "policy.channelId", op: "eq", value: ctx.channels.bankEmbed },
          { field: "customer.policyCount", op: "eq", value: 1 },
          { field: "policy.issuedDaysAgo", op: "lte", value: 30 }
        ],
        consentSource: "partner_pass_through_pending"
      }),
      sizeCached: null,
      refreshPolicy: "manual",
      lastRefreshedAt: null,
      consentPurposes: "marketing",
      createdBy: growthLead,
      createdAt: now - 12 * DAY,
      updatedAt: now - 12 * DAY
    },
    {
      id: audiences.suppression,
      tenantId,
      // Every other audience subtracts this one. It exists as a row rather than
      // a hard-coded filter so that a withdrawn consent removes a person from
      // all campaigns at once, which is the only way suppression stays true.
      name: "Do not contact — withdrawn consent, complaints, open claims",
      definitionJson: JSON.stringify({
        any: [
          { field: "consent.marketing", op: "eq", value: false },
          { field: "consent.withdrawnAt", op: "is_not_null" },
          { field: "case.type", op: "eq", value: "complaint" },
          { field: "claim.status", op: "in", value: ["open", "assessing"] }
        ]
      }),
      sizeCached: 213,
      refreshPolicy: "hourly",
      lastRefreshedAt: now - 40 * MINUTE,
      consentPurposes: "none",
      createdBy: growthLead,
      createdAt: now - 96 * DAY,
      updatedAt: now - 40 * MINUTE
    }
  ]);

  /* --------------------------------------------------------------- campaigns */

  const campaigns = {
    motorSearch: id("cmp", now + 10),
    brandDec: id("cmp", now + 11),
    healthXsell: id("cmp", now + 12),
    renewalNudge: id("cmp", now + 13),
    homeBundle: id("cmp", now + 14),
    travelWinter: id("cmp", now + 15),
    travelSummer: id("cmp", now + 16)
  };

  // Guardrails are recorded as the checks that actually ran before a campaign
  // went live, not as a boolean "approved". A frequency cap and quiet hours are
  // in every set because unbounded contact is how a legitimate campaign turns
  // into the thing this platform refuses to do.
  const guardrails = (checkedAt: number, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      suppressionAudienceApplied: true,
      frequencyCapPerWeek: 2,
      quietHours: { from: "20:00", to: "08:00", tz: "Asia/Dubai" },
      brandKit: "pass",
      bannedClaims: "pass",
      checkedAt,
      ...extra
    });

  await db.insert(schema.signalCampaigns).values([
    {
      id: campaigns.motorSearch,
      tenantId,
      name: "Motor — always-on search",
      objective: "acq",
      audienceId: audiences.quoteAbandoners,
      channelsJson: JSON.stringify(["google_search", "bing_search"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now),
        dailyMinor: 350_000,
        capMinor: 10_850_000,
        // The uplift is the December brand money the growth lead approved into
        // January; it is inside `capMinor`, not on top of it.
        upliftMinor: 1_500_000,
        autopilotBoundMinor: 1_000_000
      }),
      state: "live",
      guardrailChecksJson: guardrails(now - 96 * DAY),
      // `act` and not `act_with_approval`: this is the one campaign whose
      // budget the autopilot may move inside its bound without asking, which is
      // exactly what the ledger below shows it doing.
      autonomyLevel: "act",
      startAt: now - 96 * DAY,
      endAt: null,
      ownerRef: growthLead,
      createdAt: now - 97 * DAY,
      updatedAt: now - 2 * DAY - 2 * HOUR
    },
    {
      id: campaigns.brandDec,
      tenantId,
      // Paused, not ended: NORTH's December decision was to stop spending here
      // and move the money to search, and the campaign stays paused so the
      // decision can be reversed if January's cost per policy climbs back.
      name: `${lastMonthName} brand — social`,
      objective: "acq",
      audienceId: audiences.motorNoHealth,
      channelsJson: JSON.stringify(["meta", "instagram"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now, -1),
        dailyMinor: 420_000,
        capMinor: 13_020_000,
        // What the moves below have already taken out. The 2,400,000 still
        // awaiting approval is not counted here, because a requested move is
        // not a released one.
        releasedMinor: 2_300_000,
        autopilotBoundMinor: 1_000_000
      }),
      state: "paused",
      guardrailChecksJson: guardrails(now - 62 * DAY),
      autonomyLevel: "act_with_approval",
      startAt: now - 62 * DAY,
      endAt: now - 6 * DAY,
      ownerRef: growthLead,
      createdAt: now - 68 * DAY,
      updatedAt: now - 32 * DAY - 2 * HOUR
    },
    {
      id: campaigns.healthXsell,
      tenantId,
      name: "Health cross-sell to motor holders",
      objective: "xsell",
      audienceId: audiences.motorNoHealth,
      channelsJson: JSON.stringify(["email"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now),
        dailyMinor: 20_000,
        capMinor: 620_000,
        autopilotBoundMinor: 100_000
      }),
      state: "live",
      guardrailChecksJson: guardrails(now - 21 * DAY, { consentPurposeChecked: "marketing" }),
      autonomyLevel: "act_with_approval",
      startAt: now - 21 * DAY,
      endAt: now + 25 * DAY,
      ownerRef: growthLead,
      createdAt: now - 24 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: campaigns.renewalNudge,
      tenantId,
      name: "Renewal nudge — 45 days out",
      objective: "renewal",
      audienceId: audiences.renewals45,
      channelsJson: JSON.stringify(["email", "push"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now),
        dailyMinor: 15_000,
        capMinor: 465_000,
        autopilotBoundMinor: 100_000
      }),
      // Scheduled rather than live: the Arabic email creative has not cleared
      // review yet, and a renewal campaign that goes out in one language only
      // is not the campaign that was signed off.
      state: "scheduled",
      guardrailChecksJson: guardrails(now - DAY, { localesRequired: ["en", "ar"] }),
      autonomyLevel: "act_with_approval",
      startAt: now + 4 * DAY,
      endAt: now + 88 * DAY,
      ownerRef: growthLead,
      createdAt: now - 9 * DAY,
      updatedAt: now - DAY
    },
    {
      id: campaigns.homeBundle,
      tenantId,
      // In review, so it has no guardrail record yet — the checks run as part
      // of launch, and pretending they had already passed would be the lie that
      // makes a review queue useless.
      name: "Home + motor bundle",
      objective: "xsell",
      audienceId: audiences.motorNoHealth,
      channelsJson: JSON.stringify(["email", "google_search"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now, 1),
        dailyMinor: 12_000,
        capMinor: 372_000,
        autopilotBoundMinor: 100_000
      }),
      state: "review",
      guardrailChecksJson: null,
      autonomyLevel: "draft",
      startAt: now + 26 * DAY,
      endAt: now + 54 * DAY,
      ownerRef: growthLead,
      createdAt: now - 5 * DAY,
      updatedAt: now - 5 * DAY
    },
    {
      id: campaigns.travelWinter,
      tenantId,
      // Ended on its own end date with budget left over, which is where the
      // 250,000 in the second budget move comes from.
      name: "Winter travel — school holidays",
      objective: "acq",
      audienceId: audiences.travelLapsed,
      channelsJson: JSON.stringify(["google_search", "meta"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now, -1),
        dailyMinor: 180_000,
        capMinor: 7_200_000,
        unspentMinor: 250_000
      }),
      state: "ended",
      guardrailChecksJson: guardrails(now - 52 * DAY),
      autonomyLevel: "act_with_approval",
      startAt: now - 52 * DAY,
      endAt: now - 13 * DAY,
      ownerRef: growthLead,
      createdAt: now - 58 * DAY,
      updatedAt: now - 13 * DAY
    },
    {
      id: campaigns.travelSummer,
      tenantId,
      // A draft with no audience attached yet: the summer plan starts as a
      // brief, and forcing an audience on it now would only be a guess.
      name: "Summer travel — early planning",
      objective: "acq",
      audienceId: null,
      channelsJson: JSON.stringify(["meta", "youtube"]),
      budgetJson: JSON.stringify({
        currency: "AED",
        period: monthKey(now, 5),
        dailyMinor: 200_000,
        capMinor: 6_000_000,
        autopilotBoundMinor: 1_000_000
      }),
      state: "draft",
      guardrailChecksJson: null,
      autonomyLevel: "suggest",
      startAt: null,
      endAt: null,
      ownerRef: growthLead,
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY
    }
  ]);

  /* --------------------------------------------------------------- creatives */

  const creatives = {
    searchEnA: id("crv", now + 20),
    searchArA: id("crv", now + 21),
    searchEnB: id("crv", now + 22),
    brandArBlocked: id("crv", now + 23),
    brandSocialEn: id("crv", now + 24),
    lpEn: id("crv", now + 25),
    lpAr: id("crv", now + 26),
    renewalEmailAr: id("crv", now + 27),
    summerScriptEn: id("crv", now + 28)
  };

  // `aiAuditId` is null on every row for the same reason `modelRunRef` is null
  // in the core seed: this seed writes no ai_audit_log entries, and a dangling
  // run id would be worse than an empty column. `generatedBy` still records
  // honestly which rows a model drafted.
  await db.insert(schema.signalCreatives).values([
    {
      id: creatives.searchEnA,
      tenantId,
      campaignId: campaigns.motorSearch,
      kind: "ad",
      locale: "en",
      contentRef: SEED_CREATIVE_COPY["signal/creatives/motor-search/en-a.json"]!,
      variantGroup: "motor-search-headline",
      complianceStatus: "passed",
      complianceNotesJson: JSON.stringify({
        checkedAt: now - 92 * DAY,
        checkedBy: complianceOfficer,
        claims: [{ text: "compare 12 insurers", basis: "panel size, verified against the provider list" }]
      }),
      performanceJson: JSON.stringify({ impressions: 24_310, clicks: 1_042, ctrBps: 429, binds: 61 }),
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - 93 * DAY,
      updatedAt: now - DAY
    },
    {
      id: creatives.searchArA,
      tenantId,
      campaignId: campaigns.motorSearch,
      kind: "ad",
      locale: "ar",
      // Arabic outperforms English here, which is the finding the concluded
      // landing-page experiment below acted on.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/motor-search/ar-a.json"]!,
      variantGroup: "motor-search-headline",
      complianceStatus: "passed",
      complianceNotesJson: JSON.stringify({
        checkedAt: now - 92 * DAY,
        checkedBy: complianceOfficer,
        claims: [{ text: "قارن بين ١٢ شركة تأمين", basis: "panel size, verified against the provider list" }]
      }),
      performanceJson: JSON.stringify({ impressions: 18_640, clicks: 906, ctrBps: 486, binds: 54 }),
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - 93 * DAY,
      updatedAt: now - DAY
    },
    {
      id: creatives.searchEnB,
      tenantId,
      campaignId: campaigns.motorSearch,
      kind: "ad",
      locale: "en",
      // Flagged, so it never served: `performanceJson` is null and no
      // attribution touch names it. A comparison claim like "cheapest" needs a
      // source, and the draft had none.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/motor-search/en-b.json"]!,
      variantGroup: "motor-search-headline",
      complianceStatus: "flagged",
      complianceNotesJson: JSON.stringify({
        checkedAt: now - 7 * DAY,
        lane: "soft_flag",
        findings: [
          {
            rule: "comparison_claim_requires_source",
            excerpt: "the cheapest motor cover in the UAE",
            note: "Superlative against the whole market with nothing behind it. Rewrite as a claim about the panel or drop it."
          }
        ]
      }),
      performanceJson: null,
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - 7 * DAY,
      updatedAt: now - 7 * DAY
    },
    {
      id: creatives.brandArBlocked,
      tenantId,
      campaignId: campaigns.brandDec,
      kind: "ad",
      locale: "ar",
      // Blocked in the hard lane: a promise of acceptance is a cover
      // guarantee, which no aggregator can make on an underwriter's behalf.
      // The row stays so the demo shows a refusal, not just a clean queue.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/december-brand/ar-guarantee.json"]!,
      variantGroup: "december-brand",
      complianceStatus: "blocked",
      complianceNotesJson: JSON.stringify({
        checkedAt: now - 47 * DAY,
        lane: "hard_block",
        decidedBy: complianceOfficer,
        findings: [
          {
            rule: "no_guarantee_of_cover",
            excerpt: "قبول مضمون مهما كان سجلك",
            note: "Acceptance is the underwriter's decision, not ours. Never publishable in this form."
          }
        ]
      }),
      performanceJson: null,
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - 47 * DAY,
      updatedAt: now - 47 * DAY
    },
    {
      id: creatives.brandSocialEn,
      tenantId,
      campaignId: campaigns.brandDec,
      kind: "social",
      locale: "en",
      // The social post whose weak numbers are the reason the brand campaign
      // lost its budget to search.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/december-brand/en-social.json"]!,
      variantGroup: "december-brand",
      complianceStatus: "passed",
      complianceNotesJson: JSON.stringify({ checkedAt: now - 61 * DAY, checkedBy: complianceOfficer, claims: [] }),
      performanceJson: JSON.stringify({ impressions: 236_460, clicks: 2_521, ctrBps: 107, binds: 15 }),
      generatedBy: "human",
      aiAuditId: null,
      createdAt: now - 62 * DAY,
      updatedAt: now - 17 * DAY
    },
    {
      id: creatives.lpEn,
      tenantId,
      campaignId: campaigns.motorSearch,
      kind: "lp",
      locale: "en",
      contentRef: SEED_CREATIVE_COPY["signal/creatives/motor-lp/en.mdx"]!,
      variantGroup: "motor-lp-arabic-first",
      complianceStatus: "passed",
      complianceNotesJson: JSON.stringify({ checkedAt: now - 96 * DAY, checkedBy: complianceOfficer, claims: [] }),
      performanceJson: JSON.stringify({ visits: 9_204, quoteStarts: 1_086, quoteStartRateBps: 1_180 }),
      generatedBy: "human",
      aiAuditId: null,
      createdAt: now - 97 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: creatives.lpAr,
      tenantId,
      campaignId: campaigns.motorSearch,
      kind: "lp",
      locale: "ar",
      // Written in Arabic rather than translated from the English page, which
      // is the whole point of the experiment it belongs to.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/motor-lp/ar.mdx"]!,
      variantGroup: "motor-lp-arabic-first",
      complianceStatus: "passed",
      complianceNotesJson: JSON.stringify({
        checkedAt: now - 31 * DAY,
        checkedBy: complianceOfficer,
        claims: [],
        note: "Authored in Arabic, reviewed by a native reader; not a machine translation of the English page."
      }),
      performanceJson: JSON.stringify({ visits: 7_918, quoteStarts: 1_156, quoteStartRateBps: 1_460 }),
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - 32 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: creatives.renewalEmailAr,
      tenantId,
      campaignId: campaigns.renewalNudge,
      kind: "email",
      locale: "ar",
      // Pending review is why the renewal campaign is scheduled and not live.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/renewal-nudge/ar-email.mjml"]!,
      variantGroup: "renewal-45",
      complianceStatus: "pending",
      complianceNotesJson: null,
      performanceJson: null,
      generatedBy: "ai",
      aiAuditId: null,
      createdAt: now - DAY,
      updatedAt: now - DAY
    },
    {
      id: creatives.summerScriptEn,
      tenantId,
      campaignId: campaigns.travelSummer,
      kind: "video_script",
      locale: "en",
      // The likeness declaration is recorded up front. A synthetic likeness of
      // a real person would need a stored consent record; this tenant holds
      // none, so the script uses an illustrated character and says so.
      contentRef: SEED_CREATIVE_COPY["signal/creatives/summer-travel/en-script.md"]!,
      variantGroup: "summer-travel",
      complianceStatus: "pending",
      complianceNotesJson: JSON.stringify({
        likeness: "none — illustrated brand character, no real person depicted or voiced",
        submittedBy: growthLead,
        submittedAt: now - 2 * DAY
      }),
      performanceJson: null,
      generatedBy: "human",
      aiAuditId: null,
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY
    }
  ]);

  /* ------------------------------------------------------------- experiments */

  await db.insert(schema.signalExperiments).values([
    {
      id: id("exp", now + 30),
      tenantId,
      campaignId: campaigns.motorSearch,
      hypothesis: "A landing page written in Arabic, rather than translated from the English one, lifts quote starts for Arabic traffic.",
      variantsJson: JSON.stringify([
        { key: "control", label: "English page with Arabic translation", creativeId: creatives.lpEn, splitBps: 5_000 },
        { key: "arabic_first", label: "Arabic-authored page", creativeId: creatives.lpAr, splitBps: 5_000 }
      ]),
      metric: "quote_start_rate",
      minSample: 3_000,
      state: "concluded",
      resultJson: JSON.stringify({
        verdict: "won",
        winner: "arabic_first",
        samples: { control: 9_204, arabic_first: 7_918 },
        rateBps: { control: 1_180, arabic_first: 1_460 },
        upliftBps: 280,
        probabilityToBeatControlBps: 9_870,
        stoppedBy: "sequential_boundary",
        note: "The Arabic-authored page won and shipped; the translated page is retired."
      }),
      concludedAt: now - 9 * DAY,
      createdAt: now - 32 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: id("exp", now + 31),
      tenantId,
      campaignId: campaigns.motorSearch,
      // A test that lost. Keeping it is the point: an experiment log with only
      // winners in it is a marketing deck, not a record.
      hypothesis: "A discount-led headline binds more people than a cover-led headline.",
      variantsJson: JSON.stringify([
        { key: "control", label: "Cover-led headline", creativeId: creatives.searchEnA, splitBps: 5_000 },
        { key: "discount", label: "Discount-led headline", creativeId: creatives.searchArA, splitBps: 5_000 }
      ]),
      metric: "click_to_bind_rate",
      minSample: 2_000,
      state: "concluded",
      resultJson: JSON.stringify({
        verdict: "lost",
        winner: null,
        samples: { control: 2_140, discount: 2_088 },
        rateBps: { control: 640, discount: 590 },
        upliftBps: -50,
        probabilityToBeatControlBps: 2_140,
        stoppedBy: "sequential_boundary",
        note: "The discount arm crossed the stopping boundary in the wrong direction. Control stays; the discount headline was withdrawn."
      }),
      concludedAt: now - 16 * DAY,
      createdAt: now - 38 * DAY,
      updatedAt: now - 16 * DAY
    },
    {
      id: id("exp", now + 32),
      tenantId,
      campaignId: campaigns.renewalNudge,
      hypothesis: "Nudging at 45 days rather than 30 days raises renewal acceptance without raising unsubscribes.",
      variantsJson: JSON.stringify([
        { key: "control", label: "Nudge at 30 days", splitBps: 5_000 },
        { key: "early", label: "Nudge at 45 days", splitBps: 5_000 }
      ]),
      metric: "renewal_accept_rate",
      minSample: 800,
      // Running with no result yet: reading a result off 4 days of a 800-person
      // sample is how teams talk themselves into noise.
      state: "running",
      resultJson: null,
      concludedAt: null,
      createdAt: now - 4 * DAY,
      updatedAt: now - 4 * DAY
    },
    {
      id: id("exp", now + 33),
      tenantId,
      campaignId: campaigns.healthXsell,
      hypothesis: "WhatsApp beats email for the health cross-sell.",
      variantsJson: JSON.stringify([
        { key: "control", label: "Email", splitBps: 5_000 },
        { key: "whatsapp", label: "WhatsApp", splitBps: 5_000 }
      ]),
      metric: "quote_start_rate",
      minSample: 1_200,
      // Abandoned for the right reason, and the reason is recorded: reaching
      // the sample would have meant messaging people who never opted in to
      // WhatsApp. The consent bound decided the test, not the other way round.
      state: "abandoned",
      resultJson: JSON.stringify({
        verdict: "abandoned",
        reason: "Only 38% of the audience holds a WhatsApp opt-in, so the arm could not reach minimum sample without contacting people who had not consented to that channel.",
        reachableShareBps: 3_800,
        abandonedBy: growthLead
      }),
      concludedAt: now - 11 * DAY,
      createdAt: now - 19 * DAY,
      updatedAt: now - 11 * DAY
    },
    {
      id: id("exp", now + 34),
      tenantId,
      // No campaign: answer-engine pages are earned, not bought, so this test
      // belongs to the AEO surface rather than to any budget line.
      campaignId: null,
      hypothesis: "Answer pages that close with a quote call to action are cited as often as ones that close with a plain summary.",
      variantsJson: JSON.stringify([
        { key: "control", label: "Summary close", splitBps: 5_000 },
        { key: "cta", label: "Quote call to action close", splitBps: 5_000 }
      ]),
      metric: "aeo_citation_share",
      minSample: 20,
      state: "draft",
      resultJson: null,
      concludedAt: null,
      createdAt: now - DAY,
      updatedAt: now - DAY
    }
  ]);

  /* ------------------------------------------------------------ budget moves */

  // Every move names where the money came from, where it went and what evidence
  // justified it, and stays reversible for seven days. The `#channel` suffix on
  // a ref is the line item inside the campaign, because a move between two
  // channels of the same campaign is still a move someone has to be able to
  // audit. Amounts are AED minor units and they reconcile with the spend rows:
  // the two applied moves out of the brand campaign are the 2,300,000 it
  // reports as released.
  const moves = {
    brandToSearch: id("bmv", now + 40),
    pixelArtefact: id("bmv", now + 41),
    travelRemainder: id("bmv", now + 42),
    januaryUplift: id("bmv", now + 43),
    bingToGoogle: id("bmv", now + 44),
    pendingRelease: id("bmv", now + 45)
  };
  const brandMeta = `signal_campaign:${campaigns.brandDec}#meta`;
  const searchGoogle = `signal_campaign:${campaigns.motorSearch}#google_search`;
  const searchBing = `signal_campaign:${campaigns.motorSearch}#bing_search`;

  await db.insert(schema.signalBudgetMoves).values([
    {
      id: moves.brandToSearch,
      tenantId,
      fromRef: brandMeta,
      toRef: searchGoogle,
      amountMinor: 800_000,
      currency: "AED",
      reason: `Marginal cost per policy on search ran AED 174 below social for six days straight, so the rest of the ${lastMonthName} brand budget followed the cheaper policies.`,
      evidenceJson: JSON.stringify({
        window: { from: day(now - 38 * DAY), to: day(now - 33 * DAY) },
        marginalCacMinor: { google_search: 16_800, meta: 34_200 },
        dailyCapBeforeMinor: 240_000,
        dailyCapAfterMinor: 350_000,
        boundMinor: 1_000_000
      }),
      // Inside the campaign's 1,000,000 autopilot bound, so the agent applied it
      // and logged its reasoning instead of queueing a decision no human needed
      // to make.
      approvedBy: "auto",
      reversedBy: null,
      reversedAt: null,
      reversibleUntil: now - 32 * DAY - 2 * HOUR + 7 * DAY,
      ts: now - 32 * DAY - 2 * HOUR
    },
    {
      id: moves.pixelArtefact,
      tenantId,
      fromRef: searchGoogle,
      toRef: `signal_campaign:${campaigns.travelWinter}#meta`,
      amountMinor: 320_000,
      currency: "AED",
      reason: "Travel's reported conversions doubled overnight and the autopilot followed them.",
      // The move was reversed because the signal was a tracking artefact, not a
      // real change in demand. The reversal is recorded on the same row rather
      // than as a second, opposite move, so the ledger shows one decision that
      // was undone instead of two that look independent.
      evidenceJson: JSON.stringify({
        window: { from: day(now - 21 * DAY), to: day(now - 20 * DAY) },
        trigger: "conversion_rate_step_change",
        observedUpliftBps: 9_800,
        reversal: {
          reason: "A duplicated conversion pixel counted every travel bind twice. Once deduplicated the uplift was 0.",
          detectedBy: "anomaly guard",
          at: now - 18 * DAY
        }
      }),
      approvedBy: "auto",
      reversedBy: growthLead,
      reversedAt: now - 18 * DAY,
      reversibleUntil: now - 20 * DAY + 7 * DAY,
      ts: now - 20 * DAY
    },
    {
      id: moves.travelRemainder,
      tenantId,
      fromRef: `signal_campaign:${campaigns.travelWinter}#google_search`,
      toRef: searchGoogle,
      amountMinor: 250_000,
      currency: "AED",
      reason: `The winter travel flight closed on ${dayName(now - 13 * DAY)} with this much unspent, and budget sitting in an ended campaign buys nothing.`,
      evidenceJson: JSON.stringify({
        campaignEndedAt: day(now - 13 * DAY),
        capMinor: 7_200_000,
        spentMinor: 6_950_000,
        boundMinor: 1_000_000
      }),
      approvedBy: "auto",
      reversedBy: null,
      reversedAt: null,
      reversibleUntil: now - 12 * DAY + 7 * DAY,
      ts: now - 12 * DAY
    },
    {
      id: moves.januaryUplift,
      tenantId,
      fromRef: brandMeta,
      toRef: searchGoogle,
      amountMinor: 1_500_000,
      currency: "AED",
      reason: `Search closed ${lastMonthName} at AED 189 per policy against brand's AED 342, so ${thisMonthName} opened with the brand budget behind search.`,
      evidenceJson: JSON.stringify({
        window: { from: day(now - 36 * DAY), to: day(now - 6 * DAY) },
        cacPerPolicyMinor: { google_search: 18_900, meta: 34_200 },
        boundMinor: 1_000_000,
        // Over the autopilot bound, which is why this one went to a person.
        decisionRef: `north: pause the ${lastMonthName} brand campaign and move the budget to search`
      }),
      // A human ref, not "auto": the amount cleared the bound, so the move
      // waited for the growth lead's approval before any money shifted.
      approvedBy: growthLead,
      reversedBy: null,
      reversedAt: null,
      reversibleUntil: now - 6 * DAY + 7 * DAY,
      ts: now - 6 * DAY
    },
    {
      id: moves.bingToGoogle,
      tenantId,
      fromRef: searchBing,
      toRef: searchGoogle,
      amountMinor: 180_000,
      currency: "AED",
      reason: `Bing's cost per policy sat a fifth above Google's across the first four days of ${thisMonthName}.`,
      evidenceJson: JSON.stringify({
        window: { from: day(now - 5 * DAY), to: day(now - 2 * DAY) },
        cacPerPolicyMinor: { google_search: 20_700, bing_search: 22_800 },
        boundMinor: 1_000_000
      }),
      approvedBy: "auto",
      reversedBy: null,
      reversedAt: null,
      reversibleUntil: now - 2 * DAY - 2 * HOUR + 7 * DAY,
      ts: now - 2 * DAY - 2 * HOUR
    },
    {
      id: moves.pendingRelease,
      tenantId,
      fromRef: brandMeta,
      toRef: searchGoogle,
      amountMinor: 2_400_000,
      currency: "AED",
      reason: "The paused brand campaign is still holding AED 24,000 of unspent budget while search hits its daily cap four days out of five.",
      evidenceJson: JSON.stringify({
        window: { from: day(now - 5 * DAY), to: day(now - DAY) },
        cappedDays: 4,
        boundMinor: 1_000_000,
        requiresApproval: true
      }),
      // `approvedBy` is not nullable and this move has not been approved, so it
      // carries the marker "pending" rather than a name that would imply
      // somebody signed it off. The money has not moved: the campaign's
      // released total excludes this amount, and the approval row written below
      // is what a decision-maker acts on. A budget move above the autopilot's
      // bound is a consequential action, so it queues rather than writing
      // itself through.
      approvedBy: "pending",
      reversedBy: null,
      reversedAt: null,
      reversibleUntil: now - 2 * HOUR + 7 * DAY,
      ts: now - 2 * HOUR
    }
  ]);

  // The approvals mirror what the CRUD gate writes for `signal.budget_move`:
  // the subject is the resource path and row id, so the queue links straight
  // back to the move. One is decided and one is waiting, which is the pair an
  // operator needs to see to trust the queue.
  await db.insert(schema.approvals).values([
    {
      id: id("apr", now + 50),
      tenantId,
      subjectRef: `budget-moves:${moves.januaryUplift}`,
      policyKey: "signal.budget_move",
      module: "signal",
      requestedBy: autopilot,
      requestedAt: now - 6 * DAY - 2 * HOUR,
      decidedBy: growthLead,
      decision: "approved",
      reason: `${lastMonthName}'s numbers make the case. Approved for ${thisMonthName} only — revisit if cost per policy goes back above AED 220.`,
      contextJson: JSON.stringify({
        amountMinor: 1_500_000,
        currency: "AED",
        dualControl: false,
        fromRef: brandMeta,
        toRef: searchGoogle,
        boundMinor: 1_000_000
      }),
      decidedAt: now - 6 * DAY
    },
    {
      id: id("apr", now + 51),
      tenantId,
      subjectRef: `budget-moves:${moves.pendingRelease}`,
      policyKey: "signal.budget_move",
      module: "signal",
      requestedBy: autopilot,
      requestedAt: now - 2 * HOUR,
      decidedBy: null,
      decision: "pending",
      reason: null,
      contextJson: JSON.stringify({
        amountMinor: 2_400_000,
        currency: "AED",
        dualControl: false,
        fromRef: brandMeta,
        toRef: searchGoogle,
        boundMinor: 1_000_000
      }),
      decidedAt: null
    }
  ]);

  /* --------------------------------------------------------------- AEO pages */

  const aeoMotorEn = id("aeo", now + 60);

  // Answer-engine pages are the earned half of acquisition: they are written to
  // be quoted by an assistant, so `citationsCheckJson` tracks whether every
  // claim on the page still has a source and `freshness` is when that was last
  // true. A page whose sources have drifted goes stale rather than staying
  // published, because a confidently wrong citation is worse than no page.
  await db.insert(schema.signalAeoPages).values([
    {
      id: aeoMotorEn,
      tenantId,
      queryCluster: "best car insurance dubai",
      locale: "en",
      contentRef: "signal/aeo/en/best-car-insurance-dubai.mdx",
      citationsCheckJson: JSON.stringify({
        checkedAt: now - 2 * DAY,
        claims: 9,
        sourced: 9,
        unverified: 0,
        sources: ["provider panel", "published policy wordings"]
      }),
      freshness: now - 2 * DAY,
      citedByJson: JSON.stringify([
        { engine: "chatgpt", firstSeen: now - 26 * DAY, lastSeen: now - 2 * DAY },
        { engine: "perplexity", firstSeen: now - 19 * DAY, lastSeen: now - 3 * DAY }
      ]),
      status: "published",
      createdAt: now - 88 * DAY,
      updatedAt: now - 2 * DAY
    },
    {
      id: id("aeo", now + 61),
      tenantId,
      queryCluster: "تأمين السيارات في دبي",
      locale: "ar",
      contentRef: "signal/aeo/ar/car-insurance-dubai.mdx",
      citationsCheckJson: JSON.stringify({
        checkedAt: now - 2 * DAY,
        claims: 9,
        sourced: 9,
        unverified: 0,
        sources: ["provider panel", "published policy wordings"]
      }),
      freshness: now - 2 * DAY,
      citedByJson: JSON.stringify([{ engine: "perplexity", firstSeen: now - 14 * DAY, lastSeen: now - 4 * DAY }]),
      status: "published",
      createdAt: now - 88 * DAY,
      updatedAt: now - 2 * DAY
    },
    {
      id: id("aeo", now + 62),
      tenantId,
      queryCluster: "travel insurance schengen visa",
      locale: "en",
      contentRef: "signal/aeo/en/travel-insurance-schengen-visa.mdx",
      citationsCheckJson: JSON.stringify({
        checkedAt: now - 12 * DAY,
        claims: 6,
        sourced: 6,
        unverified: 0,
        sources: ["published policy wordings"]
      }),
      freshness: now - 12 * DAY,
      citedByJson: JSON.stringify([{ engine: "chatgpt", firstSeen: now - 40 * DAY, lastSeen: now - 5 * DAY }]),
      status: "published",
      createdAt: now - 55 * DAY,
      updatedAt: now - 12 * DAY
    },
    {
      id: id("aeo", now + 63),
      tenantId,
      // Stale rather than published: one claim no longer has a source it can
      // stand on, and the page stays down until somebody re-checks the wording
      // with each underwriter. Nothing here invents a rule.
      queryCluster: "car insurance renewal grace period uae",
      locale: "en",
      contentRef: "signal/aeo/en/renewal-grace-period.mdx",
      citationsCheckJson: JSON.stringify({
        checkedAt: now - 9 * DAY,
        claims: 7,
        sourced: 6,
        unverified: 1,
        note: "The grace-period sentence is written as if it were the same everywhere. It has to be re-checked against each underwriter's current wording before this goes back up."
      }),
      freshness: now - 96 * DAY,
      citedByJson: JSON.stringify([]),
      status: "stale",
      createdAt: now - 96 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: id("aeo", now + 64),
      tenantId,
      queryCluster: "health insurance for domestic workers uae",
      locale: "en",
      contentRef: "signal/aeo/en/domestic-worker-health-cover.mdx",
      citationsCheckJson: null,
      freshness: null,
      citedByJson: null,
      status: "draft",
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: id("aeo", now + 65),
      tenantId,
      // Retired because it was folded into the motor cluster above; two pages
      // competing for the same question split the citations between them.
      queryCluster: "third party vs comprehensive cover",
      locale: "ar",
      contentRef: "signal/aeo/ar/third-party-vs-comprehensive.mdx",
      citationsCheckJson: JSON.stringify({
        checkedAt: now - 44 * DAY,
        claims: 5,
        sourced: 5,
        unverified: 0,
        note: "Merged into the Dubai motor cluster; kept for its inbound links."
      }),
      freshness: now - 140 * DAY,
      citedByJson: JSON.stringify([]),
      status: "retired",
      createdAt: now - 140 * DAY,
      updatedAt: now - 44 * DAY
    }
  ]);

  /* ------------------------------------------------------- attribution events */

  // One journey, told touch by touch, ending in the quote request and the case
  // the rest of the demo already knows about. Touches before Rania identified
  // herself carry the anonymous id; the click that took her into the form
  // carries both, because that is where the stitch happened. `subjectRef` on the
  // last two touches is what makes this a claim anyone can check: the lead
  // points at the real quote request, the bind at the real case, and the value
  // is the premium that was actually written.
  const anonRania = "an_2f7c91b4";
  const anonBrandDropoff = "an_84b0d2e1";

  await db.insert(schema.signalAttributionEvents).values([
    {
      id: id("atr", now + 70),
      tenantId,
      customerId: null,
      anonId: anonRania,
      touchType: "impression",
      channel: "google_search",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.searchEnA,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 5 * DAY
    },
    {
      id: id("atr", now + 71),
      tenantId,
      customerId: null,
      anonId: anonRania,
      touchType: "click",
      channel: "google_search",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.searchEnA,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 5 * DAY + 4 * MINUTE
    },
    {
      id: id("atr", now + 72),
      tenantId,
      customerId: null,
      anonId: anonRania,
      touchType: "visit",
      channel: "web",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.lpEn,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 5 * DAY + 5 * MINUTE
    },
    {
      id: id("atr", now + 73),
      tenantId,
      customerId: null,
      anonId: anonRania,
      // An organic visit from an answer engine, with no campaign and no
      // creative attached — the AEO page earned this one, and pinning it to a
      // campaign would quietly credit paid media for work it did not do.
      touchType: "visit",
      channel: "answer_engine",
      campaignId: null,
      creativeId: null,
      valueMinor: null,
      currency: null,
      subjectRef: `signal_aeo_page:${aeoMotorEn}`,
      ts: now - 3 * DAY + 6 * HOUR
    },
    {
      id: id("atr", now + 74),
      tenantId,
      // Both ids: the click was anonymous when it happened and was stitched to
      // Rania the moment she started the quote forty minutes later.
      customerId: ctx.customerId,
      anonId: anonRania,
      touchType: "click",
      channel: "google_search",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.searchEnA,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 40 * MINUTE
    },
    {
      id: id("atr", now + 75),
      tenantId,
      customerId: ctx.customerId,
      anonId: anonRania,
      // The lead is the real quote request the core seed wrote, not a
      // marketing-side copy of it.
      touchType: "lead",
      channel: "web",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.lpEn,
      valueMinor: null,
      currency: null,
      subjectRef: `quote_request:${ctx.quoteRequestId}`,
      ts: now
    },
    {
      id: id("atr", now + 76),
      tenantId,
      customerId: ctx.customerId,
      anonId: anonRania,
      // The bind carries the premium that was actually written on the case, so
      // the CAC/LTV view divides real spend by real revenue.
      touchType: "bind",
      channel: "web",
      campaignId: campaigns.motorSearch,
      creativeId: creatives.lpEn,
      valueMinor: 448_000,
      currency: "AED",
      subjectRef: `axis_case:${ctx.caseId}`,
      ts: ctx.issuedAt
    },
    {
      id: id("atr", now + 77),
      tenantId,
      customerId: null,
      anonId: anonBrandDropoff,
      // A brand journey that stops at the click. Funnels that only contain
      // completed journeys teach the wrong lesson about what media buys.
      touchType: "impression",
      channel: "meta",
      campaignId: campaigns.brandDec,
      creativeId: creatives.brandSocialEn,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 17 * DAY + 3 * HOUR
    },
    {
      id: id("atr", now + 78),
      tenantId,
      customerId: null,
      anonId: anonBrandDropoff,
      touchType: "click",
      channel: "meta",
      campaignId: campaigns.brandDec,
      creativeId: creatives.brandSocialEn,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 17 * DAY + 3 * HOUR + 11 * MINUTE
    },
    {
      id: id("atr", now + 79),
      tenantId,
      customerId: null,
      anonId: anonBrandDropoff,
      touchType: "visit",
      channel: "web",
      campaignId: campaigns.brandDec,
      creativeId: creatives.brandSocialEn,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: now - 17 * DAY + 3 * HOUR + 12 * MINUTE
    }
  ]);

  /* ------------------------------------------------------------------- spend */

  // Spend is one row per campaign, channel and day, which is what the CAC view
  // groups by. Two things are worth reading carefully here. Every January day on
  // search sits under the campaign's 350,000 daily cap, including the days after
  // the approved uplift raised the line. And the conversions are what each
  // network claims for itself, which is why they add up to more binds than the
  // business actually wrote that day — the attribution table above holds the one
  // journey that was stitched end to end, and it is the arbiter when the two
  // disagree.
  const spend: Array<{
    campaignId: string;
    channel: string;
    at: number;
    amountMinor: number;
    impressions: number;
    clicks: number;
    conversions: number;
    source: "manual" | "api" | "import";
    ts?: number;
  }> = [
    // Before and after the first budget move: the December cost per policy
    // falls from about AED 211 to AED 181, which is the improvement NORTH's
    // decision review records.
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 32 * DAY, amountMinor: 231_600, impressions: 4_310, clicks: 183, conversions: 11, source: "api" },
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 31 * DAY, amountMinor: 344_800, impressions: 6_290, clicks: 271, conversions: 19, source: "api" },
    // Social at AED 344 a policy on the same day is what made the move obvious.
    { campaignId: campaigns.brandDec, channel: "meta", at: now - 32 * DAY, amountMinor: 412_300, impressions: 184_020, clicks: 1_960, conversions: 12, source: "api" },
    { campaignId: campaigns.brandDec, channel: "meta", at: now - 17 * DAY, amountMinor: 118_700, impressions: 52_440, clicks: 561, conversions: 3, source: "api" },
    { campaignId: campaigns.travelWinter, channel: "google_search", at: now - 17 * DAY, amountMinor: 148_900, impressions: 3_120, clicks: 142, conversions: 6, source: "api" },
    // New Year's Day was restated from the network invoice after the fact,
    // which is why its source is an import and its `ts` is days after its
    // `day` — the pair is how you tell a corrected row from a stale one.
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 5 * DAY, amountMinor: 289_500, impressions: 5_240, clicks: 218, conversions: 13, source: "import", ts: now - 12 * HOUR },
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 4 * DAY, amountMinor: 312_400, impressions: 5_820, clicks: 246, conversions: 15, source: "api" },
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 3 * DAY, amountMinor: 298_700, impressions: 5_410, clicks: 231, conversions: 14, source: "api" },
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - 2 * DAY, amountMinor: 341_100, impressions: 6_240, clicks: 268, conversions: 17, source: "api" },
    { campaignId: campaigns.motorSearch, channel: "google_search", at: now - DAY, amountMinor: 349_200, impressions: 6_380, clicks: 279, conversions: 18, source: "api" },
    // Bing, the line the last autopilot move took 180,000 out of.
    { campaignId: campaigns.motorSearch, channel: "bing_search", at: now - DAY, amountMinor: 68_400, impressions: 1_640, clicks: 54, conversions: 3, source: "api" },
    // Email costs a send fee rather than media, and it is keyed in by hand
    // because no network reports it.
    { campaignId: campaigns.healthXsell, channel: "email", at: now - 3 * DAY, amountMinor: 12_400, impressions: 8_940, clicks: 612, conversions: 7, source: "manual" }
  ];

  await db.insert(schema.signalSpend).values(
    spend.map((s, i) => ({
      id: id("spd", now + 80 + i),
      tenantId,
      campaignId: s.campaignId,
      channel: s.channel,
      day: day(s.at),
      amountMinor: s.amountMinor,
      currency: "AED",
      impressions: s.impressions,
      clicks: s.clicks,
      conversions: s.conversions,
      source: s.source,
      ts: s.ts ?? landed(s.at)
    }))
  );
}
