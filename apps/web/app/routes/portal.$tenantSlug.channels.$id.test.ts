import { describe, expect, it } from "vitest";
import { LABELS, channelName, labelsIn, ladderShares } from "./portal.$tenantSlug.channels.$id";
import { MONEY_STATES } from "@lyra/core/portal";

// docs: PORTALS-DESIGN-AND-AUDIT.md §2. The logic on the channel's page is the
// name resolution (a b2b channel seeded en-only still names itself to an Arabic
// reader), the money-ladder proportions, and the copy.

describe("channelName", () => {
  it("takes the reader's language when the tenant stored it", () => {
    expect(channelName({ en: "Alpha Brokers", ar: "ألفا" }, "ar")).toBe("ألفا");
  });

  it("falls back rather than printing nothing", () => {
    expect(channelName({ en: "Alpha Brokers" }, "ar")).toBe("Alpha Brokers");
    expect(channelName({}, "en")).toBe("");
    expect(channelName(null, "en")).toBe("");
  });
});

describe("ladderShares", () => {
  it("measures each stage against the money the ladder accounts for", () => {
    const { total, shares } = ladderShares({ accrued: 12_000, paid: 6_000, payable: 2_000 });
    expect(total).toBe(20_000);
    expect(shares.accrued).toBe(60);
    expect(shares.paid).toBe(30);
    expect(shares.payable).toBe(10);
  });

  it("answers zero rather than dividing by nothing on an empty book", () => {
    const { total, shares } = ladderShares({});
    expect(total).toBe(0);
    expect(shares.accrued).toBe(0);
  });

  it("does not let a negative reversal shrink the whole ladder below a stage", () => {
    const { total, shares } = ladderShares({ accrued: 10_000, clawed_back: -4_000 });
    expect(total).toBe(10_000);
    expect(shares.accrued).toBe(100);
    expect(shares.clawed_back).toBe(0);
  });
});

describe("channel labels", () => {
  it("has the same keys in every language", () => {
    const en = Object.keys(LABELS.en!).sort();
    for (const [locale, table] of Object.entries(LABELS)) {
      expect(Object.keys(table).sort(), `locale ${locale}`).toEqual(en);
    }
  });

  /**
   * **This list is the population, and that is the defect the 2026-10-01 sweep
   * found.** The test was named "names every money state the view can carry" and
   * hand-listed **six of the eight** `MONEY_STATES` the engine carries
   * (`apps/api/src/engines/party-portals.ts:183`) — so `disputed` and `written_off`
   * could print their raw keys to an external partner while a test claiming full
   * coverage passed. **A guard whose population is a hand-written list cannot notice
   * a missing member of the real one.**
   *
   * **The list is derived now**, which is the fix this test needed all along: the
   * vocabulary moved to `@lyra/core/portal`, so the assertion is about the engine's
   * states rather than about a copy of them. Adding a ninth state to `MONEY_STATES`
   * and forgetting to name it fails **here** — which is what the test's own name has
   * claimed since it was written.
   */
  it("names every money state the view can carry", () => {
    for (const state of MONEY_STATES) {
      expect(LABELS.en![`channel.money.${state}`]).toBeTruthy();
      expect(LABELS.ar![`channel.money.${state}`]).toBeTruthy();
    }
  });

  it("falls back to English rather than printing a raw key", () => {
    expect(labelsIn("fr")("channel.book.title")).toBe(LABELS.en!["channel.book.title"]);
  });

  it("has words for a link that no longer works, in both languages", () => {
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      expect(l("channel.denied.title")).not.toBe("channel.denied.title");
      expect(l("channel.denied.body")).not.toBe("channel.denied.body");
    }
  });
});
