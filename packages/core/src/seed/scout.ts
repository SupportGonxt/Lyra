import { id, schema } from "@lyra/db";
import { coverageTerms, encodeCoverage, type CoverageTerm } from "../coverage.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { monthKey, monthName } from "./period.js";

// SCOUT is the only workspace whose rows are all inferences, so the seed has to
// show its working: every number below is something GONXT computed from its own
// quote book or its own harvester, never a figure attributed to an outside
// authority. Where a row would otherwise read as market fact it carries the
// method and the confidence that produced it, because the screens (radar,
// whitespace dossier, negotiation pack) exist to be argued with.

export async function seedScout(ctx: SeedContext): Promise<void> {
  const { db, now, tenantId } = ctx;

  /* --------------------------------------------------------------- clusters */
  // Clustering runs weekly, so `trailJson` is one point per run and momentum is
  // volume × growth × novelty on a 0-100 scale. A theme that stopped growing
  // keeps its size and loses its momentum — that is how the radar empties a
  // quadrant without anybody deleting evidence.
  const clusterIds = {
    evMotor: id("clu", now),
    agencyRepair: id("clu", now + 1),
    domesticHelper: id("clu", now + 2),
    deliveryRiders: id("clu", now + 3),
    visaTravel: id("clu", now + 4),
    maternityWait: id("clu", now + 5),
    brandAds: id("clu", now + 6)
  };
  const trail = (...points: ReadonlyArray<readonly [number, number]>): string =>
    JSON.stringify(points.map(([weeksAgo, momentum]) => ({ at: now - weeksAgo * 7 * DAY, momentum })));

  await db.insert(schema.scoutClusters).values([
    {
      id: clusterIds.evMotor,
      tenantId,
      theme: "EV motor cover",
      summary:
        "Battery damage, home-charger damage and range-related towing come up in EV motor searches and in call-centre questions. None of the four motor rows on the panel prices them, so the comparison answers a question the shopper did not ask.",
      momentumScore: 88,
      size: 412,
      firstSeen: now - 84 * DAY,
      lastSeen: now - 2 * HOUR,
      trailJson: trail([12, 24], [8, 41], [4, 63], [1, 82], [0, 88]),
      updatedAt: now - 2 * HOUR
    },
    {
      id: clusterIds.agencyRepair,
      tenantId,
      theme: "Agency repair lost at renewal",
      summary:
        "Renewal quotes drop agency repair once a vehicle passes its third year and the customer finds out at the comparison, not before it. The same sentence appears in reviews, in abandonment reasons and in the cheapest row of live quote requests.",
      momentumScore: 71,
      size: 305,
      firstSeen: now - 140 * DAY,
      lastSeen: now - 5 * HOUR,
      trailJson: trail([12, 52], [8, 58], [4, 66], [1, 70], [0, 71]),
      updatedAt: now - 5 * HOUR
    },
    {
      id: clusterIds.domesticHelper,
      tenantId,
      theme: "Domestic helper cover",
      summary:
        "Motor and home shoppers ask whether the household staff are covered. GONXT has nothing to sell them, so the agents answer by hand and the demand leaves no trace anywhere except the conversation summaries.",
      momentumScore: 64,
      size: 218,
      firstSeen: now - 112 * DAY,
      lastSeen: now - DAY,
      trailJson: trail([12, 38], [8, 44], [4, 55], [1, 61], [0, 64]),
      updatedAt: now - DAY
    },
    {
      id: clusterIds.deliveryRiders,
      tenantId,
      theme: "Delivery rider motor cover",
      summary:
        "Riders and their fleet operators look for cover priced by the shift rather than by the year. Every panel row treats commercial use as a decline, so the whole segment shows up as declined eligibility rather than as demand.",
      momentumScore: 57,
      size: 164,
      firstSeen: now - 63 * DAY,
      lastSeen: now - 2 * DAY,
      trailJson: trail([8, 22], [4, 39], [1, 53], [0, 57]),
      updatedAt: now - 2 * DAY
    },
    {
      id: clusterIds.visaTravel,
      tenantId,
      theme: "Visa-application travel cover",
      summary:
        "Single-trip travel cover bought to satisfy a visa application, days before departure. The annual travel row is the only thing GONXT offers and it is the wrong shape, so the search traffic converts somewhere else.",
      momentumScore: 43,
      size: 189,
      firstSeen: now - 196 * DAY,
      lastSeen: now - 4 * DAY,
      trailJson: trail([12, 68], [8, 61], [4, 52], [1, 46], [0, 43]),
      updatedAt: now - 4 * DAY
    },
    {
      id: clusterIds.maternityWait,
      tenantId,
      theme: "Maternity waiting periods",
      summary:
        "Health shoppers want the waiting period before the price. The panel's one health row quotes by email, so the answer arrives after the shopper has already compared on price alone.",
      momentumScore: 36,
      size: 96,
      firstSeen: now - 91 * DAY,
      lastSeen: now - 3 * DAY,
      trailJson: trail([8, 29], [4, 33], [1, 35], [0, 36]),
      updatedAt: now - 3 * DAY
    },
    {
      id: clusterIds.brandAds,
      tenantId,
      // A cluster that went quiet is worth keeping: it is the reason the low-
      // momentum quadrant of the radar is not empty, and it stops the same
      // theme being re-drafted as a whitespace every quarter.
      theme: "Competitor brand advertising",
      summary:
        `A ${monthName(now, -1)} spike in competitor brand terms that has not recurred. Kept as a closed theme so the next spike is compared against it instead of being read as new.`,
      momentumScore: 9,
      size: 41,
      firstSeen: now - 45 * DAY,
      lastSeen: now - 26 * DAY,
      trailJson: trail([6, 47], [4, 31], [2, 14], [0, 9]),
      updatedAt: now - 26 * DAY
    }
  ]);

  /* ---------------------------------------------------------------- signals */
  // Signals are append-only (the tab buys `ingest` and nothing else), so a bad
  // observation is not deleted or edited: it is unclustered and its weight goes
  // to zero, with the person who made that call recorded in the payload. The
  // row stays because the next harvester run has to be able to see that this
  // pattern was already looked at and rejected.
  const signal = (
    n: number,
    source: string,
    sourceRef: string | null,
    clusterId: string | null,
    weight: number,
    observedAt: number,
    payload: Record<string, unknown>
  ): typeof schema.scoutSignals.$inferInsert => ({
    id: id("sig", now + n),
    tenantId,
    source,
    sourceRef,
    payloadJson: JSON.stringify(payload),
    // Embeddings live in Vectorize; the seed records the id the harvester would
    // have written so the search playground has something to resolve.
    embeddingRef: `vec:scout-${source}-${n}`,
    clusterId,
    weight,
    observedAt,
    createdAt: observedAt + 12 * MINUTE // the harvester batches every quarter hour
  });

  await db.insert(schema.scoutSignals).values([
    signal(0, "search", "search-trends:ae/ev-car-insurance", clusterIds.evMotor, 9, now - 2 * HOUR, {
      terms: ["ev car insurance dubai", "tesla insurance uae", "battery cover motor"],
      monthlyVolume: 4_820,
      growthBps: 6_400,
      method: "connector index, not an absolute market volume",
      window: "trailing_90_day"
    }),
    signal(1, "quotes", "dist_offering:GNX-MOT-STD", clusterIds.evMotor, 7, now - 9 * HOUR, {
      observation: "Quote inputs carrying an electric vehicle make rose to 6.1% of motor requests from 2.4% a quarter ago.",
      requests: 148,
      ofMotorRequestsBps: 610,
      note: "The rating table has no EV factor, so all 148 were priced as if petrol."
    }),
    signal(2, "quotes", `dist_quote_request:${ctx.quoteRequestId}`, clusterIds.agencyRepair, 8, now - 5 * HOUR, {
      observation: "The cheapest row returned on this request is the only one without agency repair, and it is the row the customer took.",
      cheapestOfferingCode: "CDR-MOT-ESS",
      agencyRepair: false,
      spreadToNextMinor: 35_500
    }),
    signal(3, "abandonment", "funnel:gonxt-web/renewal-compare", clusterIds.agencyRepair, 6, now - 26 * HOUR, {
      step: "compare",
      reasonKey: "cover_worse_than_expiring",
      sessions: 214,
      medianSecondsOnStep: 41
    }),
    signal(4, "reviews", "app-store:ae/gonxt-app/2026-01", clusterIds.agencyRepair, 4, now - 3 * DAY, {
      rating: 2,
      excerpt: "Renewal price was fine but the garage cover changed and nobody said so.",
      matchedReviews: 11,
      sentiment: "negative"
    }),
    signal(5, "reviews", "app-store:ae/gonxt-app/2025-12", clusterIds.domesticHelper, 3, now - 8 * DAY, {
      rating: 4,
      excerpt: "Wanted to add cover for our helper at the same time and had to call.",
      matchedReviews: 6,
      sentiment: "mixed"
    }),
    signal(6, "quotes", "orbit_theme:household-staff", clusterIds.domesticHelper, 6, now - DAY, {
      observation: "Conversation summaries tagged household staff on 37 motor and home calls this month.",
      conversations: 37,
      resolution: "answered by hand, nothing quoted"
    }),
    signal(7, "search", "search-trends:ae/delivery-rider-insurance", clusterIds.deliveryRiders, 7, now - 2 * DAY, {
      terms: ["delivery bike insurance dubai", "rider insurance per day", "fleet rider cover"],
      monthlyVolume: 1_940,
      growthBps: 3_100,
      method: "connector index, not an absolute market volume",
      window: "trailing_90_day"
    }),
    signal(8, "news", "rss:gulf-logistics-weekly/2025-12-18", clusterIds.deliveryRiders, 5, now - 19 * DAY, {
      headline: "Two national delivery platforms say they are moving riders onto shift contracts",
      publisher: "Gulf Logistics Weekly",
      relevance: "A shift contract is the unit a motor policy would have to be priced in.",
      verified: false
    }),
    signal(9, "search", "search-trends:ae/schengen-travel-insurance", clusterIds.visaTravel, 5, now - 4 * DAY, {
      terms: ["travel insurance for visa", "single trip travel cover uae"],
      monthlyVolume: 3_260,
      growthBps: -800,
      seasonality: "peaks 6-8 weeks before summer and winter school holidays",
      method: "connector index, not an absolute market volume"
    }),
    signal(10, "regulatory", "rss:insurance-circulars/2025-12-29", clusterIds.maternityWait, 2, now - 8 * DAY, {
      // The harvester records that an item appeared and who has to read it. It
      // does not summarise the item and it never states what the item requires —
      // compliance copy comes from docs/12 and from counsel, never from SCOUT.
      title: "New item on the circular feed, health line",
      state: "unread",
      routedTo: "khalid.rashed",
      note: "Flagged for counsel. This row asserts nothing about what the item says or whether anything is compliant."
    }),
    signal(11, "search", "search-trends:ae/brand-terms", null, 0, now - 26 * DAY, {
      terms: ["gonxt", "gonxt insurance"],
      monthlyVolume: 9_100,
      growthBps: 11_200,
      dismissed: {
        by: "tariq.mansour",
        at: now - 25 * DAY,
        reason:
          `The spike is GONXT's own ${monthName(now, -1)} brand campaign showing up in its own harvester. It is our spend, not market demand, so the weight is zero and the signal is unclustered.`
      }
    })
  ]);

  /* ------------------------------------------------------------ whitespaces */
  // `demandEstimate` is policies per year, triangulated from GONXT's own quote
  // book and its own connector indices — there is no purchased market study
  // behind any of these numbers and the evidence blob says so, with the method
  // and a confidence, because promoting one of these commits a build team.
  const whitespaceIds = {
    evBattery: id("wsp", now),
    agencyRenewal: id("wsp", now + 1),
    domesticHelper: id("wsp", now + 2),
    riderShift: id("wsp", now + 3),
    visaTrip: id("wsp", now + 4),
    maternityUpfront: id("wsp", now + 5),
    mortgageHome: id("wsp", now + 6)
  };
  const evidence = (
    refs: readonly string[],
    method: string,
    confidence: "low" | "medium" | "high",
    note: string
  ): string => JSON.stringify({ refs, demandEstimate: { unit: "policies_per_year", method, confidence, note } });

  // `category` is the product line the gap sits in — the same key the sweep
  // writes (apps/api/src/engines/scout-whitespace.ts) and the same key
  // `coveragePerLine` joins "on the book" against. It is not decoration: a row
  // without one reads "On the book 0" on the Radar whatever the book says, and
  // `promoteWhitespace` refuses it outright ("no category to brief against"),
  // so the handover to the campaign studio is unreachable.
  await db.insert(schema.scoutWhitespaces).values([
    {
      id: whitespaceIds.agencyRenewal,
      tenantId,
      category: "motor",
      description: "A motor renewal that keeps agency repair instead of quietly dropping it at year three",
      clusterId: clusterIds.agencyRepair,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.agencyRepair}`, "funnel:gonxt-web/renewal-compare", "app-store:ae/gonxt-app/2026-01"],
        "own renewal book × observed abandonment rate at the compare step",
        "high",
        "The base is GONXT's own expiring motor policies, so the estimate cannot be larger than the book it came from."
      ),
      demandEstimate: 6_200,
      competitionScore: 62,
      status: "validated",
      owner: "tariq.mansour",
      promotedAt: now - 30 * DAY,
      createdAt: now - 74 * DAY,
      updatedAt: now - 24 * DAY
    },
    {
      id: whitespaceIds.visaTrip,
      tenantId,
      category: "travel",
      description: "Single-trip travel cover sold at the moment the visa application is filled in",
      clusterId: clusterIds.visaTravel,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.visaTravel}`, "search-trends:ae/schengen-travel-insurance"],
        "search index × the annual travel row's observed quote-to-bind rate",
        "low",
        "Parked, not disproved: two aggregators already sell this shape, so the competition score is what stopped it rather than the demand."
      ),
      demandEstimate: 5_400,
      competitionScore: 84,
      status: "parked",
      owner: "tariq.mansour",
      promotedAt: null,
      createdAt: now - 120 * DAY,
      updatedAt: now - 16 * DAY
    },
    {
      id: whitespaceIds.evBattery,
      tenantId,
      category: "motor",
      description: "Motor cover that prices battery, home charger and range-related towing for electric vehicles",
      clusterId: clusterIds.evMotor,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.evMotor}`, "search-trends:ae/ev-car-insurance", "dist_offering:GNX-MOT-STD"],
        "EV share of GONXT's own motor requests × the motor book's bind rate, held flat",
        "medium",
        "The EV share is measured on 148 requests, which is a thin base — the experiment exists to widen it before anything is built."
      ),
      demandEstimate: 3_400,
      competitionScore: 38,
      status: "validating",
      owner: "tariq.mansour",
      promotedAt: now - 12 * DAY,
      createdAt: now - 58 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: whitespaceIds.domesticHelper,
      tenantId,
      category: "home",
      description: "Domestic helper package offered beside the motor and home renewal",
      clusterId: clusterIds.domesticHelper,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.domesticHelper}`, "orbit_theme:household-staff"],
        "call themes per month × twelve, discounted for the ones already served by a competitor",
        "low",
        "37 calls in one month is the whole base. Treat the number as an order of magnitude, not a forecast."
      ),
      demandEstimate: 2_100,
      competitionScore: 45,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: now - 21 * DAY,
      updatedAt: now - 21 * DAY
    },
    {
      id: whitespaceIds.mortgageHome,
      tenantId,
      category: "home",
      // The gap is a hole in the product × channel matrix rather than a product
      // nobody sells: Cedar Home Contents exists, and the Meridian embed only
      // ever offers motor.
      description: "Cedar Home Contents offered at the Meridian mortgage step, where the embed sells motor only",
      clusterId: null,
      evidenceRefsJson: evidence(
        ["dist_channel:meridian-embed", "dist_offering:CDR-HOM-CONT"],
        "embed sessions that reached the motor quote × the web channel's home attach rate",
        "medium",
        "The attach rate is borrowed from a different channel, which is the weakest assumption in the estimate."
      ),
      demandEstimate: 1_900,
      competitionScore: 22,
      status: "validating",
      owner: "dana.aziz",
      promotedAt: now - 5 * DAY,
      createdAt: now - 11 * DAY,
      updatedAt: now - 5 * DAY
    },
    {
      id: whitespaceIds.riderShift,
      tenantId,
      category: "motor",
      description: "Motor cover for delivery riders priced by the shift rather than by the year",
      clusterId: clusterIds.deliveryRiders,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.deliveryRiders}`, "rss:gulf-logistics-weekly/2025-12-18"],
        "declined commercial-use requests × an assumed shift count, no book to check it against",
        "low",
        "Every panel row declines commercial use today, so there is no observed conversion anywhere in GONXT to calibrate this."
      ),
      demandEstimate: 1_800,
      competitionScore: 29,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: now - 14 * DAY,
      updatedAt: now - 14 * DAY
    },
    {
      id: whitespaceIds.maternityUpfront,
      tenantId,
      category: "health",
      description: "A health row that states its maternity waiting period before the price is shown",
      clusterId: clusterIds.maternityWait,
      evidenceRefsJson: evidence(
        [`scout_cluster:${clusterIds.maternityWait}`, "rss:insurance-circulars/2025-12-29"],
        "health quote requests that never returned after the email quote",
        "low",
        "Gulf Health quotes by email, so the funnel ends before the waiting period is ever shown. Counsel has the circular; nothing here assumes what it requires."
      ),
      demandEstimate: 900,
      competitionScore: 51,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: now - 7 * DAY,
      updatedAt: now - 7 * DAY
    }
  ]);

  /* ----------------------------------------------------------- panel bench */
  // Both indices are basis points against the panel median for the same risk
  // (10000 = the median), and that median is GONXT's own quote responses, not
  // an industry price survey — a negotiation pack that claimed otherwise would
  // be claiming something GONXT cannot show. `winRate` is share of requests the
  // provider was quoted into and won, so it only means anything alongside
  // `volume`: Gulf Health's 34% is 41 requests.
  // ADR-0127: the column holds two facts in one union. The seed writes the
  // *terms* half — where our wording differs from the panel median — and every
  // position below is a `CoverPosition` (`present`, `minor` for money, `note`
  // for a figure the type has no field for) rather than the four shapes this
  // one function used to write.
  const bench = (
    n: number,
    providerId: string,
    line: string,
    period: string,
    ourPriceIdx: number | null,
    marketPriceIdx: number | null,
    winRate: number | null,
    volume: number,
    terms: readonly CoverageTerm[],
    updatedAt: number
  ): typeof schema.scoutPanelBench.$inferInsert => ({
    id: id("pnb", now + n),
    tenantId,
    providerId,
    line,
    period,
    ourPriceIdx,
    marketPriceIdx,
    winRate,
    volume,
    coverageGapsJson: encodeCoverage(coverageTerms(terms)),
    updatedAt
  });

  await db.insert(schema.scoutPanelBench).values([
    // Two periods for the motor rows so the trend the negotiation packs quote
    // is actually in the table rather than asserted in prose.
    bench(0, ctx.providers.cedar, "motor", monthKey(now), 9_420, 10_000, 44, 1_812, [
      { term: "agency_repair", ours: { present: false }, panelMedian: { present: true }, note: "The cheapest row is cheapest partly because of this." },
      { term: "roadside", ours: { present: false }, panelMedian: { present: true } }
    ], now - 6 * HOUR),
    bench(1, ctx.providers.falcon, "motor", monthKey(now), 10_380, 10_000, 27, 1_640, [
      { term: "excess", ours: { present: true, minor: 50_000 }, panelMedian: { present: true, minor: 100_000 }, note: "Better cover at a higher index — the value score, not the price rank, is what sells it." }
    ], now - 6 * HOUR),
    bench(2, ctx.providers.gonxt, "motor", monthKey(now), 10_110, 10_000, 19, 1_704, [
      { term: "agency_repair", ours: { present: false }, panelMedian: { present: true }, note: "Own paper is mid-price without agency repair, which is where the 19% comes from." }
    ], now - 6 * HOUR),
    bench(3, ctx.providers.oryx, "motor", monthKey(now), 10_640, 10_000, 6, 388, [
      // A latency has no `minor`: the figure both sides are compared on lives in
      // the note, which is where the old `oursSeconds` shape put the unit.
      { term: "quote_latency", ours: { present: true, note: "118 seconds" }, panelMedian: { present: true, note: "3 seconds" }, note: "Priced by hand against a 120s SLA, so most requests are decided before the row arrives." }
    ], now - 6 * HOUR),
    bench(4, ctx.providers.cedar, "motor", monthKey(now, -1), 9_510, 10_000, 47, 1_996, [
      { term: "agency_repair", ours: { present: false }, panelMedian: { present: true } }
    ], now - 5 * DAY),
    bench(5, ctx.providers.falcon, "motor", monthKey(now, -1), 10_220, 10_000, 31, 1_733, [
      { term: "excess", ours: { present: true, minor: 50_000 }, panelMedian: { present: true, minor: 100_000 } }
    ], now - 5 * DAY),
    bench(6, ctx.providers.oryx, "motor", monthKey(now, -1), 10_450, 10_000, 11, 502, [
      { term: "quote_latency", ours: { present: true, note: "96 seconds" }, panelMedian: { present: true, note: "3 seconds" } }
    ], now - 5 * DAY),
    bench(7, ctx.providers.gulfHealth, "health", monthKey(now), 9_880, 10_000, 34, 41, [
      { term: "maternity_waiting_days", ours: { present: true, note: "365 days" }, panelMedian: { present: false }, note: "Nothing to compare against: Gulf Health is the only health row on the panel." }
    ], now - 6 * HOUR),
    bench(8, ctx.providers.gonxt, "travel", monthKey(now), 9_240, 10_000, 61, 623, [
      { term: "trip_basis", ours: { present: true, note: "annual only" }, panelMedian: { present: true, note: "single trip" }, note: "Feeds the visa-trip whitespace." }
    ], now - 6 * HOUR),
    bench(9, ctx.providers.cedar, "home", monthKey(now), 10_050, 10_000, 52, 214, [], now - 6 * HOUR),
    bench(10, ctx.providers.oryx, "life", monthKey(now), null, null, 38, 76, [
      { term: "pricing_mode", ours: { present: true, note: "manual" }, panelMedian: { present: false }, note: "Manual pricing with no second life row means there is no median to index against." }
    ], now - 6 * HOUR),
    // Meridian is a financier, not an underwriter: the referral has no premium,
    // so the price columns stay empty and only the funnel numbers are readable.
    bench(11, ctx.providers.meridian, "loan", monthKey(now), null, null, 71, 132, [
      { term: "index", ours: { present: false }, panelMedian: { present: false }, note: "A loan referral has no premium to index. Win rate here is referrals accepted, not price competitiveness." }
    ], now - 6 * HOUR)
  ]);

  /* ------------------------------------------------------------ experiments */
  // Every plan carries the honesty banner and a spend cap: a landing page that
  // measures demand for something GONXT cannot yet sell must say so on the page
  // (docs/modules/scout §2.4), and an uncapped test is an unbudgeted one.
  const experimentIds = {
    agencyFirst: id("sxp", now),
    agencyRepeat: id("sxp", now + 1),
    evWaitlist: id("sxp", now + 2),
    helperInterest: id("sxp", now + 3),
    riderDraft: id("sxp", now + 4),
    visaStopped: id("sxp", now + 5)
  };
  const plan = (channels: readonly string[], dailyCapMinor: number, days: number): string =>
    JSON.stringify({
      channels,
      dailyCapMinor,
      currency: "AED",
      maxDays: days,
      bannerKey: "scout.experiment.not_yet_available",
      stopRule: "halt at the cap or at maxDays, whichever comes first"
    });

  await db.insert(schema.scoutExperiments).values([
    {
      id: experimentIds.agencyFirst,
      tenantId,
      whitespaceId: whitespaceIds.agencyRenewal,
      landingRef: "x/agency-repair-renewal",
      trafficPlanJson: plan(["gonxt-web", "gonxt-app"], 120_000, 21),
      resultsJson: JSON.stringify({
        visits: 4_212,
        quoteStarts: 706,
        waitlist: 289,
        qualifiedDemandBps: 686,
        verdict: "supported",
        note: "Enough to promote the whitespace to validated, on web and app traffic only."
      }),
      state: "concluded",
      startedAt: now - 52 * DAY,
      concludedAt: now - 31 * DAY,
      createdAt: now - 56 * DAY
    },
    {
      id: experimentIds.agencyRepeat,
      tenantId,
      whitespaceId: whitespaceIds.agencyRenewal,
      landingRef: "x/agency-repair-renewal",
      // Same page, same whitespace, different traffic: the repeat exists because
      // the first result was strong enough to build on, and a result that only
      // holds on the channel that produced it is not a result.
      trafficPlanJson: plan(["gonxt-call", "alpha-brokers"], 90_000, 21),
      resultsJson: JSON.stringify({
        replicationOf: experimentIds.agencyFirst,
        visits: 2_960,
        quoteStarts: 214,
        waitlist: 47,
        qualifiedDemandBps: 159,
        verdict: "did_not_replicate",
        note: "A quarter of the first run's qualified demand off broker and call-centre traffic. The whitespace stays validated on the strength of the web result, and the build is scoped to web and app until this is understood."
      }),
      state: "concluded",
      startedAt: now - 24 * DAY,
      concludedAt: now - 3 * DAY,
      createdAt: now - 26 * DAY
    },
    {
      id: experimentIds.evWaitlist,
      tenantId,
      whitespaceId: whitespaceIds.evBattery,
      landingRef: "x/ev-battery-cover",
      trafficPlanJson: plan(["gonxt-web", "gonxt-app"], 150_000, 28),
      // Running, so the numbers are the analyst's interim read and carry no
      // verdict — concluding is a decision and it has not been taken.
      resultsJson: JSON.stringify({
        interim: true,
        asOf: now - 6 * HOUR,
        visits: 1_884,
        quoteStarts: 342,
        waitlist: 121,
        qualifiedDemandBps: 642,
        spentMinor: 810_000
      }),
      state: "running",
      startedAt: now - 9 * DAY,
      concludedAt: null,
      createdAt: now - 10 * DAY
    },
    {
      id: experimentIds.helperInterest,
      tenantId,
      whitespaceId: whitespaceIds.domesticHelper,
      landingRef: "x/domestic-helper-cover",
      trafficPlanJson: plan(["gonxt-web"], 60_000, 14),
      resultsJson: JSON.stringify({ interim: true, asOf: now - HOUR, visits: 402, quoteStarts: 38, waitlist: 14, spentMinor: 96_000 }),
      state: "running",
      startedAt: now - 2 * DAY,
      concludedAt: null,
      createdAt: now - 4 * DAY
    },
    {
      id: experimentIds.riderDraft,
      tenantId,
      whitespaceId: whitespaceIds.riderShift,
      landingRef: null,
      // Drafted with no page and no traffic: the fleet operators have to be
      // approached before a public page tests a product for commercial use.
      trafficPlanJson: plan(["gonxt-web"], 50_000, 14),
      resultsJson: null,
      state: "draft",
      startedAt: null,
      concludedAt: null,
      createdAt: now - 12 * DAY
    },
    {
      id: experimentIds.visaStopped,
      tenantId,
      whitespaceId: whitespaceIds.visaTrip,
      landingRef: "x/single-trip-travel",
      trafficPlanJson: plan(["gonxt-web"], 80_000, 21),
      resultsJson: JSON.stringify({
        visits: 611,
        quoteStarts: 52,
        waitlist: 9,
        stoppedReason: "The whitespace was parked on competition four days in, so the remaining spend was not worth the answer.",
        spentMinor: 240_000
      }),
      state: "abandoned",
      startedAt: now - 20 * DAY,
      concludedAt: now - 16 * DAY,
      createdAt: now - 22 * DAY
    }
  ]);

  /* ---------------------------------------------------------- data products */
  // Selling insight back to the panel is only defensible if two things are on
  // the row: what licenses the data (`consentBasis`, and it points at GONXT's
  // own recorded consent flags, never at a legal conclusion) and the cell floor
  // below which the aggregate is suppressed. docs/modules/scout §2.5 sets that
  // floor at 20; a product cut on health or on a single provider gets a higher
  // one, because those cells identify people and counterparties sooner.
  const definition = (body: Record<string, unknown>): string => JSON.stringify(body);

  await db.insert(schema.scoutDataProducts).values([
    {
      id: id("dtp", now),
      tenantId,
      name: "Motor demand curve by emirate and age band",
      definitionJson: definition({
        source: "dist_quote_requests",
        dimensions: ["emirate", "ageBand", "sumInsuredBand"],
        measures: ["requests", "medianQuotedPremiumMinor", "bindRateBps"],
        window: "trailing_12_month",
        refresh: { cadence: "weekly", lastRunAt: now - 2 * DAY, state: "fresh" },
        suppression: "cells under the aggregation floor are dropped, not rounded"
      }),
      consentBasis: "consent:dataSharing",
      aggregationMin: 20,
      subscribersJson: JSON.stringify([
        { providerId: ctx.providers.falcon, since: now - 180 * DAY },
        { providerId: ctx.providers.cedar, since: now - 92 * DAY }
      ]),
      delivery: "api",
      status: "published",
      createdAt: now - 210 * DAY,
      updatedAt: now - 2 * DAY
    },
    {
      id: id("dtp", now + 1),
      tenantId,
      name: "Motor coverage-gap map",
      definitionJson: definition({
        source: "scout_panel_bench",
        dimensions: ["line", "coverageTerm"],
        measures: ["rowsOffering", "rowsWithout"],
        window: "trailing_6_month",
        refresh: { cadence: "monthly", lastRunAt: now - 6 * DAY, state: "fresh" },
        note: "Built from wording diffs across panel rows, so it contains no customer data at all."
      }),
      // No customer is in this cut, so no customer consent is what licenses it —
      // the panel agreements are, and saying so is more honest than borrowing a
      // consent flag that never applied.
      consentBasis: "provider_agreement:panel_wordings",
      aggregationMin: 20,
      subscribersJson: JSON.stringify([{ providerId: ctx.providers.falcon, since: now - 61 * DAY }]),
      delivery: "report",
      status: "published",
      createdAt: now - 74 * DAY,
      updatedAt: now - 6 * DAY
    },
    {
      id: id("dtp", now + 2),
      tenantId,
      name: "Travel demand seasonality",
      definitionJson: definition({
        source: "dist_quote_requests",
        dimensions: ["isoWeek", "tripDaysBand", "destinationRegion"],
        measures: ["requests", "bindRateBps"],
        window: "trailing_24_month",
        // The subscriber is reading a report that is three weeks behind its own
        // cadence. It stays published rather than being quietly patched, because
        // the catalogue screen is meant to surface exactly this.
        refresh: { cadence: "weekly", lastRunAt: now - 23 * DAY, state: "stale", failure: "the travel connector run has errored since the last successful build" }
      }),
      consentBasis: "consent:dataSharing",
      aggregationMin: 20,
      subscribersJson: JSON.stringify([{ providerId: ctx.providers.cedar, since: now - 40 * DAY }]),
      delivery: "report",
      status: "published",
      createdAt: now - 120 * DAY,
      updatedAt: now - 23 * DAY
    },
    {
      id: id("dtp", now + 3),
      tenantId,
      name: "Health quote-to-bind elasticity",
      definitionJson: definition({
        source: "dist_quote_responses",
        dimensions: ["ageBand", "familySize"],
        measures: ["priceIndexBps", "bindRateBps"],
        window: "trailing_12_month",
        refresh: { cadence: "monthly", lastRunAt: null, state: "never_run" }
      }),
      consentBasis: "consent:dataSharing",
      // Health cuts identify a household faster than motor cuts do, so this one
      // is floored well above the module default and still will not publish:
      // there is one health row on the panel and 41 requests behind it.
      aggregationMin: 50,
      subscribersJson: null,
      delivery: "report",
      status: "draft",
      createdAt: now - 18 * DAY,
      updatedAt: now - 18 * DAY
    },
    {
      id: id("dtp", now + 4),
      tenantId,
      name: "Panel response-time benchmark",
      definitionJson: definition({
        source: "scout_panel_bench",
        dimensions: ["providerId", "line", "period"],
        measures: ["p50LatencyMs", "p95LatencyMs", "responseRateBps"],
        window: "trailing_3_month",
        refresh: { cadence: "nightly", lastRunAt: now - 31 * DAY, state: "halted" }
      }),
      consentBasis: "provider_agreement:panel_wordings",
      aggregationMin: 20,
      subscribersJson: JSON.stringify([{ providerId: ctx.providers.falcon, since: now - 88 * DAY, suspendedAt: now - 31 * DAY }]),
      delivery: "api",
      // Suspended by the k-anonymity monitor: a cut keyed on providerId is a cut
      // where every cell names one counterparty, so a subscriber could read a
      // competitor's latency straight off it. Withdrawn until it is re-cut on
      // the panel median.
      status: "suspended",
      createdAt: now - 96 * DAY,
      updatedAt: now - 31 * DAY
    },
    {
      id: id("dtp", now + 5),
      tenantId,
      name: "Home contents sum-insured distribution",
      definitionJson: definition({
        source: "dist_quote_requests",
        dimensions: ["emirate", "sumInsuredBand"],
        measures: ["requests"],
        window: "trailing_12_month",
        refresh: { cadence: "monthly", lastRunAt: null, state: "never_run" }
      }),
      consentBasis: "consent:dataSharing",
      aggregationMin: 20,
      subscribersJson: null,
      delivery: "api",
      status: "draft",
      createdAt: now - 9 * DAY,
      updatedAt: now - 9 * DAY
    }
  ]);
}
