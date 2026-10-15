import { describe, expect, it } from "vitest";
import { TAX_MARKETS, marketsAwaitingRulepack } from "@lyra/db";
import {
  CATALOGUE_PRODUCT_LINES,
  LIFECYCLES,
  MARKETS,
  PRODUCT_LINES,
  REGULATORS,
  REGULATOR_SCOPES,
  lifecycleFor,
  marketFor,
  productLineOf,
  regulatorFor,
  regulatorsForProductLine,
  supportedProductLines,
  ungovernedMarkets,
  type ProductLineKey
} from "./operating-model.js";

// The operating model the platform has to answer for: where we trade, under whose
// licence, and through what process. Written after reading the client's own site,
// so the numbers here are quoted rather than invented.

describe("markets", () => {
  it("refuses to guess a market nobody declared, rather than defaulting to the launch one", () => {
    // The defect this module closes: `taxMarketOf` answered AE for a tenant that
    // had stated nothing, so six of the client's nine countries would have had UAE
    // treatment applied silently.
    // **Qatar used to be the example here, and that was the inconsistency.** `MARKETS`
    // listed three markets while `TAX_RULEPACK_DRAFTS` knew nine, so a broker in Qatar
    // could be named in a tax draft while this function called its market `unknown`.
    // Qatar is declared now; the assertion needs a market the client genuinely does not
    // operate in, which is what "nobody declared" should have meant all along.
    const elsewhere = marketFor("US");
    expect(elsewhere.status).toBe("unknown");
    expect(elsewhere.currency).toBe("");
    expect(elsewhere.regulators).toEqual([]);
    // And a client market is no longer unknown.
    expect(marketFor("QA").status).toBe("ungoverned");
    expect(marketFor("QA").currency).toBe("QAR");
  });

  it("names all nine markets the client operates in, and governs one", () => {
    // The objective is a broker operating across **nine** MENA markets. `MARKETS` held
    // three — the launch market and the two next in an expansion order — while the tax
    // file already knew nine. Two footprints, and the smaller one decided who could hold
    // an authorisation.
    expect(MARKETS.map((m) => m.code).sort()).toEqual(["AE", "BH", "EG", "JO", "KW", "LB", "OM", "QA", "SA"]);
    // One licence on file. Every other market is named without a regulatory claim.
    expect(MARKETS.filter((m) => m.status === "licensed")).toHaveLength(1);
    expect(marketFor("AE").status).toBe("licensed");
    expect(MARKETS.filter((m) => m.regulators.length > 0).map((m) => m.code)).toEqual(["AE"]);
  });

  it("agrees with the tax rulepacks about how many markets are actually governed", () => {
    // The two lists answer different questions — one is "markets we know", the
    // other "markets whose tax we can compute" — and a test is where the
    // difference stays visible instead of drifting.
    const governed = MARKETS.filter((m) => TAX_MARKETS.includes(m.code)).map((m) => m.code).sort();
    expect(governed).toEqual([...TAX_MARKETS].filter((m) => MARKETS.some((x) => x.code === m)).sort());
  });

  it("covers the same nine markets the tax file does — two lists, one footprint", () => {
    // The drift this closes: `MARKETS` knew three markets and `TAX_RULEPACK_DRAFTS` knew
    // nine, so a broker could be named in a **tax draft** for a country where
    // `marketFor()` answered `status: "unknown"` and no authorisation could ever cover
    // it. The two lists answer different questions and must not answer different
    // *footprints* — every market the client operates in is priced or awaiting a price,
    // and vice versa.
    const known = new Set(MARKETS.map((m) => m.code));
    const priced = new Set<string>([...TAX_MARKETS]);
    const awaiting = new Set<string>(marketsAwaitingRulepack());

    // A market the platform prices but does not know is a market it cannot place a risk in.
    expect([...priced].filter((m) => !known.has(m))).toEqual([]);
    expect([...awaiting].filter((m) => !known.has(m))).toEqual([]);
    // And a market it knows but neither prices nor has a proposal for is one it cannot
    // trade in at all — which is the state the six were in before this change.
    expect([...known].filter((m) => !priced.has(m) && !awaiting.has(m))).toEqual([]);
    expect(known.size).toBe(9);
  });

  it("derives the expansion list rather than hand-listing it", () => {
    // A list typed by hand goes stale the first time one is added. This asserted
    // `["SA","EG"]` while its own comment said "six" — **the assertion and the comment
    // disagreed**, which is what sent me looking. It is the **no-licence** question:
    // eight markets, because the six the client operates in with no licence and the two
    // awaiting expansion are all ungoverned the same way.
    expect(ungovernedMarkets().map((m) => m.code).sort()).toEqual(["BH", "EG", "JO", "KW", "LB", "OM", "QA", "SA"]);
  });
});

describe("regulators", () => {
  it("quotes the licences the client publishes, and invents none", () => {
    const centralBank = regulatorFor("ae_central_bank");
    expect(centralBank?.licenceNumber).toBe("20");
    expect(regulatorFor("dha")?.licenceNumber).toBe("BRK-00045");
    // Every other regulator is absent rather than plausible-looking: a made-up
    // broker number in a compliance register is worse than a blank.
    expect(REGULATORS).toHaveLength(2);
    expect(REGULATORS.every((r) => r.licenceNumber === null || /^[A-Za-z0-9-]+$/.test(r.licenceNumber))).toBe(true);
  });

  it("joins a product line to the licence that carries it", () => {
    // Two regulators in one country is the client's actual situation, and health
    // is the reason: the DHA licenses health intermediation, the Central Bank the
    // rest of the broking.
    expect(regulatorsForProductLine("health_insurance").map((r) => r.key)).toEqual(["dha"]);
    expect(regulatorsForProductLine("car_insurance").map((r) => r.key)).toEqual(["ae_central_bank"]);
    // Banking lines have no regulator on file — stated, not assumed.
    expect(regulatorsForProductLine("credit_cards")).toEqual([]);
  });
});

describe("product lines and process", () => {
  it("covers all eleven of the client's lines, seven insurance and four banking", () => {
    // Eleven, not twelve: their navigation lists four finance products (personal
    // loans, credit cards, home loans, car loans), not five. This test is what
    // caught the miscount — the figure had been written into two documents as
    // "twelve" without anyone counting the nav.
    const lines = Object.keys(PRODUCT_LINES) as ProductLineKey[];
    expect(lines).toHaveLength(11);
    const insurance = lines.filter((l) => lifecycleFor(l).key === "insurance_policy");
    const banking = lines.filter((l) => lifecycleFor(l).key === "lending_application");
    expect(insurance).toHaveLength(7);
    expect(banking).toHaveLength(4);
  });

  it("gives a loan a process rather than a policy", () => {
    // The gap the domain-pack seam could not close: it swaps nouns, not a
    // lifecycle. A credit card is not bound.
    const lending = lifecycleFor("credit_cards");
    expect(lending.key).toBe("lending_application");
    expect(lending.stages).not.toContain("bind");
    expect(lending.stages).toContain("disbursement");
    expect(lending.artefact).toBe("facility");
    expect(lending.placesRisk).toBe(false);
  });

  it("keeps the insurance process intact for the lines that already work", () => {
    expect(lifecycleFor("car_insurance").stages).toEqual(["quote", "bind", "policy", "renew"]);
    expect(LIFECYCLES.insurance_policy.placesRisk).toBe(true);
  });

  it("says out loud how many lines the platform can carry today", () => {
    // "Seven of eleven" is a fact about coverage, and a test is where it stays one.
    expect(supportedProductLines()).toHaveLength(7);
  });
});

// ADR-0125. The register of tenant-held authorisations needs both of these as
// data, and neither existed: a union cannot validate a write door, and no
// function joined the tenant's catalogue vocabulary to the model's classes.
describe("the catalogue and the operating model", () => {
  it("lists the scope union at runtime, with the type derived from it", () => {
    // `RegulatorDef["scope"]` is `RegulatorScope`, which is this list. A scope a
    // regulator uses that the list does not hold is drift a write door would
    // then refuse.
    for (const regulator of REGULATORS) expect(REGULATOR_SCOPES).toContain(regulator.scope);
    expect([...REGULATOR_SCOPES].sort()).toEqual(["banking", "health_intermediary", "insurance_broking", "securities"]);
  });

  it("reads a catalogue line as a class of business, and says null where it has none", () => {
    // `core_products.line` (docs/03) is the tenant's vocabulary; these five
    // readings are the unambiguous half of it.
    expect(productLineOf("motor")).toBe("car_insurance");
    expect(productLineOf("health")).toBe("health_insurance");
    expect(productLineOf("travel")).toBe("travel_insurance");
    expect(productLineOf("home")).toBe("home_insurance");
    expect(productLineOf("life")).toBe("life_insurance");

    // Absent with a status, never guessed: `sme` is a segment, and the three
    // lending lines have no class of business on file.
    for (const line of ["sme", "card", "loan", "account", "nonsense"]) {
      expect(productLineOf(line), line).toBeNull();
    }
  });

  it("only ever maps to a line the model knows, and every mapping has a licence", () => {
    for (const [catalogue, line] of Object.entries(CATALOGUE_PRODUCT_LINES)) {
      expect(PRODUCT_LINES[line], `${catalogue} -> ${line}`).toBeDefined();
      // Every mapped line is one a regulator is on file for, which is what makes
      // the bridge worth having: the register is populated from it.
      expect(regulatorsForProductLine(line).length, `${catalogue} -> ${line}`).toBeGreaterThan(0);
    }
  });
});
