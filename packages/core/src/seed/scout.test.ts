import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { coverageOf } from "../coverage.js";
import { seed } from "../seed.js";
import { DAY, HOUR, MINUTE } from "./context.js";
import type { CoreDb } from "../context.js";

// Same DB harness as ../seed.test.ts and ./axis.test.ts: an in-memory libSQL db
// with the real migrations replayed.
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// The seed clock, pinned so every relative offset in scout.ts (`now - 84 * DAY`
// etc.) resolves to an exact, assertable number instead of a moving target.
const T0 = Date.UTC(2026, 0, 6, 8, 0, 0);

let db: CoreDb;
let tenantId: string;
let quoteRequestId: string;
let providerIds: {
  gonxt: string;
  falcon: string;
  cedar: string;
  oryx: string;
  gulfHealth: string;
  meridian: string;
};

beforeEach(async () => {
  const client: Client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  const r = await seed(db, { password: "scout-test-password-2026", now: T0 });
  tenantId = r.tenantId;

  const [axisCase] = await db.select().from(schema.axisCases).where(eq(schema.axisCases.ref, "GNX-2601-0001"));
  quoteRequestId = axisCase!.quoteRequestId!;

  const providers = await db.select().from(schema.providers).where(eq(schema.providers.tenantId, tenantId));
  const byName = (name: string) => providers.find((p) => p.name === name)!.id;
  providerIds = {
    gonxt: byName("GONXT Underwriting"),
    falcon: byName("Falcon Insurance"),
    cedar: byName("Cedar General Insurance"),
    oryx: byName("Oryx Takaful"),
    gulfHealth: byName("Gulf Health Assurance"),
    meridian: byName("Meridian Bank")
  };
});

describe("seedScout: clusters", () => {
  it("seeds the seven radar clusters with exact momentum, size and trail points", async () => {
    const clusters = await db.select().from(schema.scoutClusters).where(eq(schema.scoutClusters.tenantId, tenantId));
    expect(clusters).toHaveLength(7);
    for (const c of clusters) expect(c.tenantId).toBe(tenantId);

    const byTheme = (theme: string) => clusters.find((c) => c.theme === theme)!;
    const trailPoints = (json: string | null) => JSON.parse(json!) as Array<{ at: number; momentum: number }>;
    const trail = (...points: ReadonlyArray<readonly [number, number]>) =>
      points.map(([weeksAgo, momentum]) => ({ at: T0 - weeksAgo * 7 * DAY, momentum }));

    const evMotor = byTheme("EV motor cover");
    expect(evMotor.momentumScore).toBe(88);
    expect(evMotor.size).toBe(412);
    expect(evMotor.firstSeen).toBe(T0 - 84 * DAY);
    expect(evMotor.lastSeen).toBe(T0 - 2 * HOUR);
    expect(evMotor.updatedAt).toBe(T0 - 2 * HOUR);
    expect(trailPoints(evMotor.trailJson)).toEqual(trail([12, 24], [8, 41], [4, 63], [1, 82], [0, 88]));

    const agencyRepair = byTheme("Agency repair lost at renewal");
    expect(agencyRepair.momentumScore).toBe(71);
    expect(agencyRepair.size).toBe(305);
    expect(agencyRepair.firstSeen).toBe(T0 - 140 * DAY);
    expect(agencyRepair.lastSeen).toBe(T0 - 5 * HOUR);
    expect(trailPoints(agencyRepair.trailJson)).toEqual(trail([12, 52], [8, 58], [4, 66], [1, 70], [0, 71]));

    const domesticHelper = byTheme("Domestic helper cover");
    expect(domesticHelper.momentumScore).toBe(64);
    expect(domesticHelper.size).toBe(218);
    expect(domesticHelper.firstSeen).toBe(T0 - 112 * DAY);
    expect(domesticHelper.lastSeen).toBe(T0 - DAY);
    expect(trailPoints(domesticHelper.trailJson)).toEqual(trail([12, 38], [8, 44], [4, 55], [1, 61], [0, 64]));

    const deliveryRiders = byTheme("Delivery rider motor cover");
    expect(deliveryRiders.momentumScore).toBe(57);
    expect(deliveryRiders.size).toBe(164);
    expect(deliveryRiders.firstSeen).toBe(T0 - 63 * DAY);
    expect(deliveryRiders.lastSeen).toBe(T0 - 2 * DAY);
    expect(trailPoints(deliveryRiders.trailJson)).toEqual(trail([8, 22], [4, 39], [1, 53], [0, 57]));

    const visaTravel = byTheme("Visa-application travel cover");
    expect(visaTravel.momentumScore).toBe(43);
    expect(visaTravel.size).toBe(189);
    expect(visaTravel.firstSeen).toBe(T0 - 196 * DAY);
    expect(visaTravel.lastSeen).toBe(T0 - 4 * DAY);
    expect(trailPoints(visaTravel.trailJson)).toEqual(trail([12, 68], [8, 61], [4, 52], [1, 46], [0, 43]));

    const maternityWait = byTheme("Maternity waiting periods");
    expect(maternityWait.momentumScore).toBe(36);
    expect(maternityWait.size).toBe(96);
    expect(maternityWait.firstSeen).toBe(T0 - 91 * DAY);
    expect(maternityWait.lastSeen).toBe(T0 - 3 * DAY);
    expect(trailPoints(maternityWait.trailJson)).toEqual(trail([8, 29], [4, 33], [1, 35], [0, 36]));

    // Gone quiet, kept as a closed theme so the next spike is compared against it.
    const brandAds = byTheme("Competitor brand advertising");
    expect(brandAds.momentumScore).toBe(9);
    expect(brandAds.size).toBe(41);
    expect(brandAds.firstSeen).toBe(T0 - 45 * DAY);
    expect(brandAds.lastSeen).toBe(T0 - 26 * DAY);
    expect(brandAds.updatedAt).toBe(T0 - 26 * DAY);
    expect(trailPoints(brandAds.trailJson)).toEqual(trail([6, 47], [4, 31], [2, 14], [0, 9]));

    // The radar's high-to-low ordering depends on momentumScore, not insertion order.
    const byScore = [...clusters].sort((a, b) => b.momentumScore - a.momentumScore).map((c) => c.theme);
    expect(byScore[0]).toBe("EV motor cover");
    expect(byScore[byScore.length - 1]).toBe("Competitor brand advertising");
  });
});

describe("seedScout: signals", () => {
  it("seeds twelve append-only signals, weighted and clustered, plus the zero-weight dismissal", async () => {
    const signals = await db.select().from(schema.scoutSignals).where(eq(schema.scoutSignals.tenantId, tenantId));
    expect(signals).toHaveLength(12);
    for (const s of signals) {
      expect(s.tenantId).toBe(tenantId);
      // The harvester batches every quarter hour: createdAt trails observedAt by exactly that.
      expect(s.createdAt).toBe(s.observedAt + 12 * MINUTE);
    }

    const clusters = await db.select().from(schema.scoutClusters).where(eq(schema.scoutClusters.tenantId, tenantId));
    const clusterIdByTheme = (theme: string) => clusters.find((c) => c.theme === theme)!.id;
    const bySourceRef = (ref: string) => signals.find((s) => s.sourceRef === ref)!;

    const evSearch = bySourceRef("search-trends:ae/ev-car-insurance");
    expect(evSearch.source).toBe("search");
    expect(evSearch.weight).toBe(9);
    expect(evSearch.clusterId).toBe(clusterIdByTheme("EV motor cover"));
    expect(evSearch.observedAt).toBe(T0 - 2 * HOUR);
    expect(evSearch.embeddingRef).toBe("vec:scout-search-0");
    const evPayload = JSON.parse(evSearch.payloadJson);
    expect(evPayload.monthlyVolume).toBe(4_820);
    expect(evPayload.growthBps).toBe(6_400);

    const evQuotes = bySourceRef("dist_offering:GNX-MOT-STD");
    expect(evQuotes.weight).toBe(7);
    expect(evQuotes.clusterId).toBe(clusterIdByTheme("EV motor cover"));
    expect(evQuotes.observedAt).toBe(T0 - 9 * HOUR);
    const evQuotesPayload = JSON.parse(evQuotes.payloadJson);
    expect(evQuotesPayload.requests).toBe(148);
    expect(evQuotesPayload.ofMotorRequestsBps).toBe(610);

    // Ties the signal back to the same quote request the AXIS bind case ran on.
    const cheapestRow = bySourceRef(`dist_quote_request:${quoteRequestId}`);
    expect(cheapestRow.weight).toBe(8);
    expect(cheapestRow.clusterId).toBe(clusterIdByTheme("Agency repair lost at renewal"));
    expect(cheapestRow.observedAt).toBe(T0 - 5 * HOUR);
    const cheapestPayload = JSON.parse(cheapestRow.payloadJson);
    expect(cheapestPayload.cheapestOfferingCode).toBe("CDR-MOT-ESS");
    expect(cheapestPayload.agencyRepair).toBe(false);
    expect(cheapestPayload.spreadToNextMinor).toBe(35_500);

    const abandonment = bySourceRef("funnel:gonxt-web/renewal-compare");
    expect(abandonment.source).toBe("abandonment");
    expect(abandonment.weight).toBe(6);
    expect(abandonment.clusterId).toBe(clusterIdByTheme("Agency repair lost at renewal"));
    expect(abandonment.observedAt).toBe(T0 - 26 * HOUR);
    const abandonmentPayload = JSON.parse(abandonment.payloadJson);
    expect(abandonmentPayload.sessions).toBe(214);
    expect(abandonmentPayload.medianSecondsOnStep).toBe(41);

    const review2601 = bySourceRef("app-store:ae/gonxt-app/2026-01");
    expect(review2601.source).toBe("reviews");
    expect(review2601.weight).toBe(4);
    expect(review2601.clusterId).toBe(clusterIdByTheme("Agency repair lost at renewal"));
    expect(review2601.observedAt).toBe(T0 - 3 * DAY);

    const review2512 = bySourceRef("app-store:ae/gonxt-app/2025-12");
    expect(review2512.weight).toBe(3);
    expect(review2512.clusterId).toBe(clusterIdByTheme("Domestic helper cover"));
    expect(review2512.observedAt).toBe(T0 - 8 * DAY);

    const helperCalls = bySourceRef("orbit_theme:household-staff");
    expect(helperCalls.source).toBe("quotes");
    expect(helperCalls.weight).toBe(6);
    expect(helperCalls.clusterId).toBe(clusterIdByTheme("Domestic helper cover"));
    expect(helperCalls.observedAt).toBe(T0 - DAY);
    const helperPayload = JSON.parse(helperCalls.payloadJson);
    expect(helperPayload.conversations).toBe(37);
    expect(helperPayload.resolution).toBe("answered by hand, nothing quoted");

    const riderSearch = bySourceRef("search-trends:ae/delivery-rider-insurance");
    expect(riderSearch.weight).toBe(7);
    expect(riderSearch.clusterId).toBe(clusterIdByTheme("Delivery rider motor cover"));
    expect(riderSearch.observedAt).toBe(T0 - 2 * DAY);

    const riderNews = bySourceRef("rss:gulf-logistics-weekly/2025-12-18");
    expect(riderNews.source).toBe("news");
    expect(riderNews.weight).toBe(5);
    expect(riderNews.clusterId).toBe(clusterIdByTheme("Delivery rider motor cover"));
    expect(riderNews.observedAt).toBe(T0 - 19 * DAY);
    const riderPayload = JSON.parse(riderNews.payloadJson);
    expect(riderPayload.verified).toBe(false);

    const visaSearch = bySourceRef("search-trends:ae/schengen-travel-insurance");
    expect(visaSearch.weight).toBe(5);
    expect(visaSearch.clusterId).toBe(clusterIdByTheme("Visa-application travel cover"));
    expect(visaSearch.observedAt).toBe(T0 - 4 * DAY);
    const visaPayload = JSON.parse(visaSearch.payloadJson);
    expect(visaPayload.monthlyVolume).toBe(3_260);
    expect(visaPayload.growthBps).toBe(-800);

    const regulatory = bySourceRef("rss:insurance-circulars/2025-12-29");
    expect(regulatory.source).toBe("regulatory");
    expect(regulatory.weight).toBe(2);
    expect(regulatory.clusterId).toBe(clusterIdByTheme("Maternity waiting periods"));
    expect(regulatory.observedAt).toBe(T0 - 8 * DAY);
    const regulatoryPayload = JSON.parse(regulatory.payloadJson);
    expect(regulatoryPayload.state).toBe("unread");
    expect(regulatoryPayload.routedTo).toBe("khalid.rashed");

    // The dismissed brand-terms spike: unclustered and weighted to zero, never deleted.
    const brandTerms = bySourceRef("search-trends:ae/brand-terms");
    expect(brandTerms.source).toBe("search");
    expect(brandTerms.weight).toBe(0);
    expect(brandTerms.clusterId).toBeNull();
    expect(brandTerms.observedAt).toBe(T0 - 26 * DAY);
    const brandPayload = JSON.parse(brandTerms.payloadJson);
    expect(brandPayload.monthlyVolume).toBe(9_100);
    expect(brandPayload.growthBps).toBe(11_200);
    expect(brandPayload.dismissed.by).toBe("tariq.mansour");
    expect(brandPayload.dismissed.at).toBe(T0 - 25 * DAY);
  });
});

describe("seedScout: whitespaces", () => {
  it("seeds seven whitespaces with exact demand, competition and evidence, one per status", async () => {
    const whitespaces = await db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.tenantId, tenantId));
    expect(whitespaces).toHaveLength(7);
    for (const w of whitespaces) expect(w.tenantId).toBe(tenantId);

    const clusters = await db.select().from(schema.scoutClusters).where(eq(schema.scoutClusters.tenantId, tenantId));
    const clusterIdByTheme = (theme: string) => clusters.find((c) => c.theme === theme)!.id;
    const byDescription = (d: string) => whitespaces.find((w) => w.description === d)!;

    // `category` is the product line the gap sits in, and it is load-bearing in
    // two places: `coveragePerLine` keys "on the book" by it, and
    // `promoteWhitespace` 409s outright on a row without one. Seeded null, the
    // radar read "On the book 0" for every theme and the handover to the
    // campaign studio was unreachable from the demo.
    expect(Object.fromEntries(whitespaces.map((w) => [w.description, w.category]))).toEqual({
      "A motor renewal that keeps agency repair instead of quietly dropping it at year three": "motor",
      "Single-trip travel cover sold at the moment the visa application is filled in": "travel",
      "Motor cover that prices battery, home charger and range-related towing for electric vehicles": "motor",
      "Domestic helper package offered beside the motor and home renewal": "home",
      "Cedar Home Contents offered at the Meridian mortgage step, where the embed sells motor only": "home",
      "Motor cover for delivery riders priced by the shift rather than by the year": "motor",
      "A health row that states its maternity waiting period before the price is shown": "health"
    });

    const agencyRenewal = byDescription("A motor renewal that keeps agency repair instead of quietly dropping it at year three");
    expect(agencyRenewal.clusterId).toBe(clusterIdByTheme("Agency repair lost at renewal"));
    expect(agencyRenewal.demandEstimate).toBe(6_200);
    expect(agencyRenewal.competitionScore).toBe(62);
    expect(agencyRenewal.status).toBe("validated");
    expect(agencyRenewal.owner).toBe("tariq.mansour");
    expect(agencyRenewal.promotedAt).toBe(T0 - 30 * DAY);
    expect(agencyRenewal.createdAt).toBe(T0 - 74 * DAY);
    expect(agencyRenewal.updatedAt).toBe(T0 - 24 * DAY);
    const agencyEvidence = JSON.parse(agencyRenewal.evidenceRefsJson!);
    expect(agencyEvidence.refs).toContain(`scout_cluster:${clusterIdByTheme("Agency repair lost at renewal")}`);
    expect(agencyEvidence.demandEstimate.unit).toBe("policies_per_year");
    expect(agencyEvidence.demandEstimate.confidence).toBe("high");

    const visaTrip = byDescription("Single-trip travel cover sold at the moment the visa application is filled in");
    expect(visaTrip.clusterId).toBe(clusterIdByTheme("Visa-application travel cover"));
    expect(visaTrip.demandEstimate).toBe(5_400);
    expect(visaTrip.competitionScore).toBe(84);
    expect(visaTrip.status).toBe("parked");
    expect(visaTrip.promotedAt).toBeNull();
    expect(visaTrip.createdAt).toBe(T0 - 120 * DAY);
    expect(visaTrip.updatedAt).toBe(T0 - 16 * DAY);
    const visaEvidence = JSON.parse(visaTrip.evidenceRefsJson!);
    expect(visaEvidence.demandEstimate.confidence).toBe("low");

    const evBattery = byDescription("Motor cover that prices battery, home charger and range-related towing for electric vehicles");
    expect(evBattery.clusterId).toBe(clusterIdByTheme("EV motor cover"));
    expect(evBattery.demandEstimate).toBe(3_400);
    expect(evBattery.competitionScore).toBe(38);
    expect(evBattery.status).toBe("validating");
    expect(evBattery.promotedAt).toBe(T0 - 12 * DAY);
    expect(evBattery.createdAt).toBe(T0 - 58 * DAY);
    expect(evBattery.updatedAt).toBe(T0 - 9 * DAY);

    const domesticHelper = byDescription("Domestic helper package offered beside the motor and home renewal");
    expect(domesticHelper.clusterId).toBe(clusterIdByTheme("Domestic helper cover"));
    expect(domesticHelper.demandEstimate).toBe(2_100);
    expect(domesticHelper.competitionScore).toBe(45);
    expect(domesticHelper.status).toBe("candidate");
    expect(domesticHelper.owner).toBeNull();
    expect(domesticHelper.promotedAt).toBeNull();
    expect(domesticHelper.createdAt).toBe(T0 - 21 * DAY);
    expect(domesticHelper.updatedAt).toBe(T0 - 21 * DAY);

    // Not tied to a cluster: a gap in the product x channel matrix, not a demand cluster.
    const mortgageHome = byDescription("Cedar Home Contents offered at the Meridian mortgage step, where the embed sells motor only");
    expect(mortgageHome.clusterId).toBeNull();
    expect(mortgageHome.demandEstimate).toBe(1_900);
    expect(mortgageHome.competitionScore).toBe(22);
    expect(mortgageHome.status).toBe("validating");
    expect(mortgageHome.owner).toBe("dana.aziz");
    expect(mortgageHome.promotedAt).toBe(T0 - 5 * DAY);
    expect(mortgageHome.createdAt).toBe(T0 - 11 * DAY);
    expect(mortgageHome.updatedAt).toBe(T0 - 5 * DAY);

    const riderShift = byDescription("Motor cover for delivery riders priced by the shift rather than by the year");
    expect(riderShift.clusterId).toBe(clusterIdByTheme("Delivery rider motor cover"));
    expect(riderShift.demandEstimate).toBe(1_800);
    expect(riderShift.competitionScore).toBe(29);
    expect(riderShift.status).toBe("candidate");
    expect(riderShift.owner).toBeNull();
    expect(riderShift.createdAt).toBe(T0 - 14 * DAY);

    const maternityUpfront = byDescription("A health row that states its maternity waiting period before the price is shown");
    expect(maternityUpfront.clusterId).toBe(clusterIdByTheme("Maternity waiting periods"));
    expect(maternityUpfront.demandEstimate).toBe(900);
    expect(maternityUpfront.competitionScore).toBe(51);
    expect(maternityUpfront.status).toBe("candidate");
    expect(maternityUpfront.createdAt).toBe(T0 - 7 * DAY);

    // The demand rail's ordering, largest gap first, has to come from the data.
    const byDemand = [...whitespaces].sort((a, b) => b.demandEstimate! - a.demandEstimate!).map((w) => w.demandEstimate);
    expect(byDemand).toEqual([6_200, 5_400, 3_400, 2_100, 1_900, 1_800, 900]);

    // Exactly one whitespace per lifecycle status is asserted above; confirm the
    // full set matches, not a superset or subset of it.
    expect([...whitespaces].map((w) => w.status).sort()).toEqual(
      ["candidate", "candidate", "candidate", "parked", "validated", "validating", "validating"].sort()
    );
  });
});

describe("seedScout: panel bench", () => {
  it("benches every provider row, two motor periods deep, with ppm-style index math intact", async () => {
    const bench = await db.select().from(schema.scoutPanelBench).where(eq(schema.scoutPanelBench.tenantId, tenantId));
    expect(bench).toHaveLength(12);
    for (const b of bench) expect(b.tenantId).toBe(tenantId);

    const row = (providerId: string, line: string, period: string) =>
      bench.find((b) => b.providerId === providerId && b.line === line && b.period === period)!;

    const cedarMotorJan = row(providerIds.cedar, "motor", "2026-01");
    expect(cedarMotorJan.ourPriceIdx).toBe(9_420);
    expect(cedarMotorJan.marketPriceIdx).toBe(10_000);
    expect(cedarMotorJan.winRate).toBe(44);
    expect(cedarMotorJan.volume).toBe(1_812);
    expect(cedarMotorJan.updatedAt).toBe(T0 - 6 * HOUR);
    // ADR-0127: the seed writes the `terms` half of the coverage union, and a
    // reader reaches it through the one accessor rather than parsing a shape.
    const cedarGaps = coverageOf(cedarMotorJan.coverageGapsJson);
    expect(cedarGaps).toMatchObject({ kind: "terms" });
    expect(cedarGaps?.kind === "terms" ? cedarGaps.terms.map((one) => one.term) : []).toEqual(["agency_repair", "roadside"]);
    expect(cedarGaps?.kind === "terms" ? cedarGaps.terms[0]!.ours : null).toEqual({ present: false });
    expect(cedarGaps?.kind === "terms" ? cedarGaps.terms[0]!.panelMedian : null).toEqual({ present: true });

    const falconMotorJan = row(providerIds.falcon, "motor", "2026-01");
    expect(falconMotorJan.ourPriceIdx).toBe(10_380);
    expect(falconMotorJan.winRate).toBe(27);
    expect(falconMotorJan.volume).toBe(1_640);

    const gonxtMotorJan = row(providerIds.gonxt, "motor", "2026-01");
    expect(gonxtMotorJan.ourPriceIdx).toBe(10_110);
    expect(gonxtMotorJan.winRate).toBe(19);
    expect(gonxtMotorJan.volume).toBe(1_704);

    const oryxMotorJan = row(providerIds.oryx, "motor", "2026-01");
    expect(oryxMotorJan.ourPriceIdx).toBe(10_640);
    expect(oryxMotorJan.winRate).toBe(6);
    expect(oryxMotorJan.volume).toBe(388);

    const cedarMotorDec = row(providerIds.cedar, "motor", "2025-12");
    expect(cedarMotorDec.ourPriceIdx).toBe(9_510);
    expect(cedarMotorDec.winRate).toBe(47);
    expect(cedarMotorDec.volume).toBe(1_996);
    expect(cedarMotorDec.updatedAt).toBe(T0 - 5 * DAY);
    // The trend the negotiation pack quotes: Cedar's win rate slipped month over month.
    expect(cedarMotorJan.winRate!).toBeLessThan(cedarMotorDec.winRate!);

    const falconMotorDec = row(providerIds.falcon, "motor", "2025-12");
    expect(falconMotorDec.ourPriceIdx).toBe(10_220);
    expect(falconMotorDec.winRate).toBe(31);
    expect(falconMotorDec.volume).toBe(1_733);

    const oryxMotorDec = row(providerIds.oryx, "motor", "2025-12");
    expect(oryxMotorDec.ourPriceIdx).toBe(10_450);
    expect(oryxMotorDec.winRate).toBe(11);
    expect(oryxMotorDec.volume).toBe(502);

    const gulfHealthJan = row(providerIds.gulfHealth, "health", "2026-01");
    expect(gulfHealthJan.ourPriceIdx).toBe(9_880);
    expect(gulfHealthJan.winRate).toBe(34);
    expect(gulfHealthJan.volume).toBe(41);
    const gulfGaps = coverageOf(gulfHealthJan.coverageGapsJson);
    expect(gulfGaps?.kind === "terms" ? gulfGaps.terms[0]!.ours : null).toEqual({ present: true, note: "365 days" });
    expect(gulfGaps?.kind === "terms" ? gulfGaps.terms[0]!.panelMedian : null).toEqual({ present: false });

    const gonxtTravelJan = row(providerIds.gonxt, "travel", "2026-01");
    expect(gonxtTravelJan.ourPriceIdx).toBe(9_240);
    expect(gonxtTravelJan.winRate).toBe(61);
    expect(gonxtTravelJan.volume).toBe(623);

    const cedarHomeJan = row(providerIds.cedar, "home", "2026-01");
    expect(cedarHomeJan.ourPriceIdx).toBe(10_050);
    expect(cedarHomeJan.winRate).toBe(52);
    expect(cedarHomeJan.volume).toBe(214);
    // A row with no gaps is a *terms* fact with an empty list, not a null
    // column: the two are different claims (ADR-0127).
    expect(coverageOf(cedarHomeJan.coverageGapsJson)).toEqual({ kind: "terms", terms: [] });

    // No second life row on the panel: price columns stay null, not zero.
    const oryxLifeJan = row(providerIds.oryx, "life", "2026-01");
    expect(oryxLifeJan.ourPriceIdx).toBeNull();
    expect(oryxLifeJan.marketPriceIdx).toBeNull();
    expect(oryxLifeJan.winRate).toBe(38);
    expect(oryxLifeJan.volume).toBe(76);

    // A loan referral has no premium: price columns null, funnel numbers readable.
    const meridianLoanJan = row(providerIds.meridian, "loan", "2026-01");
    expect(meridianLoanJan.ourPriceIdx).toBeNull();
    expect(meridianLoanJan.marketPriceIdx).toBeNull();
    expect(meridianLoanJan.winRate).toBe(71);
    expect(meridianLoanJan.volume).toBe(132);
  });
});

describe("seedScout: experiments", () => {
  it("caps every traffic plan's spend and states each experiment's result truthfully", async () => {
    const experiments = await db.select().from(schema.scoutExperiments).where(eq(schema.scoutExperiments.tenantId, tenantId));
    expect(experiments).toHaveLength(6);
    for (const e of experiments) expect(e.tenantId).toBe(tenantId);

    const whitespaces = await db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.tenantId, tenantId));
    const whitespaceIdByDescription = (d: string) => whitespaces.find((w) => w.description === d)!.id;
    const byLandingRef = (ref: string | null) => experiments.find((e) => e.landingRef === ref)!;

    const agencyWhitespaceId = whitespaceIdByDescription(
      "A motor renewal that keeps agency repair instead of quietly dropping it at year three"
    );
    const agencyRuns = experiments.filter((e) => e.whitespaceId === agencyWhitespaceId);
    expect(agencyRuns).toHaveLength(2);

    const agencyFirst = agencyRuns.find((e) => e.startedAt === T0 - 52 * DAY)!;
    expect(agencyFirst.landingRef).toBe("x/agency-repair-renewal");
    expect(agencyFirst.state).toBe("concluded");
    expect(agencyFirst.concludedAt).toBe(T0 - 31 * DAY);
    expect(agencyFirst.createdAt).toBe(T0 - 56 * DAY);
    const firstPlan = JSON.parse(agencyFirst.trafficPlanJson!);
    expect(firstPlan.channels).toEqual(["gonxt-web", "gonxt-app"]);
    expect(firstPlan.dailyCapMinor).toBe(120_000);
    expect(firstPlan.maxDays).toBe(21);
    const firstResults = JSON.parse(agencyFirst.resultsJson!);
    expect(firstResults.visits).toBe(4_212);
    expect(firstResults.qualifiedDemandBps).toBe(686);
    expect(firstResults.verdict).toBe("supported");

    const agencyRepeat = agencyRuns.find((e) => e.id !== agencyFirst.id)!;
    expect(agencyRepeat.startedAt).toBe(T0 - 24 * DAY);
    expect(agencyRepeat.concludedAt).toBe(T0 - 3 * DAY);
    const repeatPlan = JSON.parse(agencyRepeat.trafficPlanJson!);
    expect(repeatPlan.channels).toEqual(["gonxt-call", "alpha-brokers"]);
    expect(repeatPlan.dailyCapMinor).toBe(90_000);
    const repeatResults = JSON.parse(agencyRepeat.resultsJson!);
    expect(repeatResults.replicationOf).toBe(agencyFirst.id);
    expect(repeatResults.qualifiedDemandBps).toBe(159);
    expect(repeatResults.verdict).toBe("did_not_replicate");
    // The repeat's qualified demand came in a quarter of the first run's, off different traffic.
    expect(repeatResults.qualifiedDemandBps).toBeLessThan(firstResults.qualifiedDemandBps);

    const evWaitlist = byLandingRef("x/ev-battery-cover");
    expect(evWaitlist.whitespaceId).toBe(whitespaceIdByDescription(
      "Motor cover that prices battery, home charger and range-related towing for electric vehicles"
    ));
    expect(evWaitlist.state).toBe("running");
    expect(evWaitlist.concludedAt).toBeNull();
    expect(evWaitlist.startedAt).toBe(T0 - 9 * DAY);
    const evPlan = JSON.parse(evWaitlist.trafficPlanJson!);
    expect(evPlan.dailyCapMinor).toBe(150_000);
    expect(evPlan.maxDays).toBe(28);
    const evResults = JSON.parse(evWaitlist.resultsJson!);
    expect(evResults.interim).toBe(true);
    expect(evResults.spentMinor).toBe(810_000);

    const helperInterest = byLandingRef("x/domestic-helper-cover");
    expect(helperInterest.state).toBe("running");
    expect(helperInterest.startedAt).toBe(T0 - 2 * DAY);
    expect(helperInterest.createdAt).toBe(T0 - 4 * DAY);
    const helperResults = JSON.parse(helperInterest.resultsJson!);
    expect(helperResults.spentMinor).toBe(96_000);

    // Drafted with no landing page and no traffic yet.
    const riderDraft = byLandingRef(null);
    expect(riderDraft.state).toBe("draft");
    expect(riderDraft.startedAt).toBeNull();
    expect(riderDraft.concludedAt).toBeNull();
    expect(riderDraft.resultsJson).toBeNull();
    expect(riderDraft.whitespaceId).toBe(
      whitespaceIdByDescription("Motor cover for delivery riders priced by the shift rather than by the year")
    );

    const visaStopped = byLandingRef("x/single-trip-travel");
    expect(visaStopped.state).toBe("abandoned");
    expect(visaStopped.startedAt).toBe(T0 - 20 * DAY);
    expect(visaStopped.concludedAt).toBe(T0 - 16 * DAY);
    const visaResults = JSON.parse(visaStopped.resultsJson!);
    expect(visaResults.spentMinor).toBe(240_000);
    expect(visaResults.stoppedReason).toContain("parked on competition");

    // Every plan carries the honesty banner and a stop rule; the spend cap is the budget line.
    for (const e of experiments) {
      const p = JSON.parse(e.trafficPlanJson!);
      expect(p.bannerKey).toBe("scout.experiment.not_yet_available");
      expect(p.currency).toBe("AED");
      expect(p.stopRule).toBe("halt at the cap or at maxDays, whichever comes first");
    }
  });
});

describe("seedScout: data products", () => {
  it("floors every published cut at its aggregation minimum and suspends the one that could re-identify a competitor", async () => {
    const products = await db.select().from(schema.scoutDataProducts).where(eq(schema.scoutDataProducts.tenantId, tenantId));
    expect(products).toHaveLength(6);
    for (const p of products) expect(p.tenantId).toBe(tenantId);

    const byName = (n: string) => products.find((p) => p.name === n)!;

    const demandCurve = byName("Motor demand curve by emirate and age band");
    expect(demandCurve.consentBasis).toBe("consent:dataSharing");
    expect(demandCurve.aggregationMin).toBe(20);
    expect(demandCurve.delivery).toBe("api");
    expect(demandCurve.status).toBe("published");
    expect(demandCurve.createdAt).toBe(T0 - 210 * DAY);
    expect(demandCurve.updatedAt).toBe(T0 - 2 * DAY);
    const demandSubs = JSON.parse(demandCurve.subscribersJson!);
    expect(demandSubs).toHaveLength(2);
    expect(demandSubs[0].providerId).toBe(providerIds.falcon);
    expect(demandSubs[0].since).toBe(T0 - 180 * DAY);
    expect(demandSubs[1].providerId).toBe(providerIds.cedar);
    expect(demandSubs[1].since).toBe(T0 - 92 * DAY);
    const demandDef = JSON.parse(demandCurve.definitionJson);
    expect(demandDef.refresh.lastRunAt).toBe(T0 - 2 * DAY);
    expect(demandDef.refresh.state).toBe("fresh");

    const gapMap = byName("Motor coverage-gap map");
    expect(gapMap.consentBasis).toBe("provider_agreement:panel_wordings");
    expect(gapMap.aggregationMin).toBe(20);
    expect(gapMap.delivery).toBe("report");
    expect(gapMap.status).toBe("published");
    expect(gapMap.createdAt).toBe(T0 - 74 * DAY);
    expect(gapMap.updatedAt).toBe(T0 - 6 * DAY);

    const seasonality = byName("Travel demand seasonality");
    expect(seasonality.status).toBe("published");
    expect(seasonality.createdAt).toBe(T0 - 120 * DAY);
    expect(seasonality.updatedAt).toBe(T0 - 23 * DAY);
    const seasonalityDef = JSON.parse(seasonality.definitionJson);
    // Stale by design: this is exactly what the catalogue screen is meant to surface.
    expect(seasonalityDef.refresh.state).toBe("stale");
    expect(seasonalityDef.refresh.lastRunAt).toBe(T0 - 23 * DAY);

    const healthElasticity = byName("Health quote-to-bind elasticity");
    expect(healthElasticity.status).toBe("draft");
    // Floored above the module default because a health cut identifies a household sooner.
    expect(healthElasticity.aggregationMin).toBe(50);
    expect(healthElasticity.aggregationMin).toBeGreaterThan(demandCurve.aggregationMin);
    expect(healthElasticity.subscribersJson).toBeNull();
    expect(healthElasticity.createdAt).toBe(T0 - 18 * DAY);
    expect(healthElasticity.updatedAt).toBe(T0 - 18 * DAY);
    const healthDef = JSON.parse(healthElasticity.definitionJson);
    expect(healthDef.refresh.lastRunAt).toBeNull();
    expect(healthDef.refresh.state).toBe("never_run");

    const latencyBench = byName("Panel response-time benchmark");
    expect(latencyBench.status).toBe("suspended");
    expect(latencyBench.consentBasis).toBe("provider_agreement:panel_wordings");
    expect(latencyBench.aggregationMin).toBe(20);
    const latencySubs = JSON.parse(latencyBench.subscribersJson!);
    expect(latencySubs[0].providerId).toBe(providerIds.falcon);
    expect(latencySubs[0].since).toBe(T0 - 88 * DAY);
    expect(latencySubs[0].suspendedAt).toBe(T0 - 31 * DAY);
    expect(latencyBench.createdAt).toBe(T0 - 96 * DAY);
    expect(latencyBench.updatedAt).toBe(T0 - 31 * DAY);

    const homeDistribution = byName("Home contents sum-insured distribution");
    expect(homeDistribution.status).toBe("draft");
    expect(homeDistribution.aggregationMin).toBe(20);
    expect(homeDistribution.subscribersJson).toBeNull();
    expect(homeDistribution.createdAt).toBe(T0 - 9 * DAY);
    expect(homeDistribution.updatedAt).toBe(T0 - 9 * DAY);
  });
});
