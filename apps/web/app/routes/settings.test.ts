import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS, SECTIONS, sectionsOn, settingsLede } from "./settings";

// Role adoption flagged /settings as a page with its first field 764px down.
// Measured, the first field is at 274px; 764px is the notifications list, the
// first thing the probe counts as data — but the account tab does run 4.4
// screens tall, and the tab strip only moves between tabs. The sections of
// the tab in front of the reader are now one jump away too.
describe("on this page", () => {
  const source = readFileSync(join(import.meta.dirname, "settings.tsx"), "utf8");
  const all = { keysRead: true };

  it("lists a tab's sections in the order they render", () => {
    expect(sectionsOn("account", all).map((one) => one.id)).toEqual([
      "settings-profile",
      "settings-lens",
      "settings-notifications"
    ]);
  });

  it("leaves out a section the reader is not shown", () => {
    expect(sectionsOn("security", { keysRead: false }).map((one) => one.id)).not.toContain("settings-keys");
    expect(sectionsOn("security", all).map((one) => one.id)).toContain("settings-keys");
  });

  it("offers no jump list for a tab with one section", () => {
    expect(sectionsOn("brand", all)).toEqual([]);
  });

  it("points every jump at a section id the screen renders, titled in both languages", () => {
    const listed = Object.values(SECTIONS).flat();
    expect(listed.length).toBeGreaterThan(0);
    for (const one of listed) {
      expect(source, one.id).toContain(`id="${one.id}"`);
      for (const locale of ["en", "ar"]) expect(LABELS[locale]?.[one.titleKey], `${locale} ${one.titleKey}`).toBeTruthy();
    }
    for (const locale of ["en", "ar"]) expect(LABELS[locale]?.["onPage.label"]).toBeTruthy();
  });
});

// The settings hero is shared by every tab, not only the one where the inbox
// itself lives, so the only thing worth narrating there is a real unread
// count — never a fabricated summary of a tab the actor isn't looking at.
const label = (key: string): string =>
  key === "settings.introUnread" ? "{count} unread notification(s) below." : key;

describe("settingsLede", () => {
  it("falls back to the static intro when nothing is unread", () => {
    expect(settingsLede(0, label)).toBe("settings.intro");
  });

  it("counts unread notifications into the template", () => {
    expect(settingsLede(3, label)).toBe("3 unread notification(s) below.");
  });
});

/* ------------------- the six markets that cannot price are visible */

/**
 * The 2026-10-01 sweep's MONEY work left `marketsAwaitingRulepack()` and
 * `taxDraftsFor()` read by **nothing but their own test** — a dead seam of mine, and
 * the one that matters most for a broker operating in nine markets: the only thing in
 * the platform that said which six could not be priced was a function nobody called,
 * and **no screen mentioned the tenant's market at all.**
 *
 * A draft rulepack refuses rather than applying a remembered rate, which is correct
 * (CLAUDE.md: never invent a regulatory claim) — but a refusal nobody can see coming
 * is indistinguishable from a broken product. This asserts the panel's data, and the
 * count, because *"nine markets"* is the claim the whole objective rests on.
 */
describe("the markets panel", () => {
  it("splits the client's nine markets into pricing and waiting, without overlap", async () => {
    const { TAX_MARKETS, marketsAwaitingRulepack } = await import("@lyra/db/tax-rulepack");
    const canPrice = [...TAX_MARKETS];
    const awaiting = marketsAwaitingRulepack();

    // The number the objective names. If the client's footprint changes this is the
    // assertion that should be revisited deliberately rather than drift.
    expect(canPrice.length + awaiting.length).toBe(9);
    expect(awaiting).toHaveLength(6);
    // A market in both lists would render twice and mean neither.
    expect(canPrice.filter((m) => awaiting.includes(m))).toEqual([]);
    // And the three governed markets are the ones the rulepack actually covers. The
    // **set**, not the order: I asserted a sequence first and it was wrong (`AE, SA,
    // EG`), which is a fact about the source array that nothing depends on — the panel
    // renders badges, and badge order is not a claim.
    expect([...canPrice].sort()).toEqual(["AE", "EG", "SA"]);
  });

  it("shows the tenant's own market, which no screen did before", () => {
    // `taxMarket` is the tenant's statement of where it is established (ADR-0075/0121)
    // and it decided every tax treatment in the platform while being invisible.
    expect(LABELS.en!["markets.yours"]).toBeTruthy();
    expect(LABELS.ar!["markets.yours"]).toBeTruthy();
    expect(LABELS.en!["markets.awaiting"]).toContain("confirmed");
  });

  it("shows both gates, because a priced market is not automatically tradeable", async () => {
    // The panel showed only the **tax** gate, which would let an operator conclude that
    // confirming Qatar's VAT unlocks Qatar. It does not: a placement also needs a licence
    // on file, and §55 established that *"no licence"* is eight markets while *"no rate"*
    // is six — **both called ungoverned in English, neither the other.**
    const { MARKETS } = await import("@lyra/core/operating-model");
    const { TAX_MARKETS } = await import("@lyra/db/tax-rulepack");

    const rows = MARKETS.map((m) => ({
      code: m.code,
      licensed: m.regulators.length > 0,
      priced: TAX_MARKETS.includes(m.code)
    }));

    // Nine rows, one per market.
    expect(rows).toHaveLength(9);
    // Exactly one market clears both gates — the launch market.
    expect(rows.filter((r) => r.licensed && r.priced).map((r) => r.code)).toEqual(["AE"]);
    // Two are priced and not licensed: they can compute tax and still cannot bind.
    expect(rows.filter((r) => r.priced && !r.licensed).map((r) => r.code).sort()).toEqual(["EG", "SA"]);
    // And six clear neither.
    expect(rows.filter((r) => !r.priced && !r.licensed)).toHaveLength(6);

    // Both verdicts have words, so the panel never renders a bare boolean.
    for (const key of ["markets.tradeable", "markets.notTradeable", "markets.licensed", "markets.notLicensed"]) {
      expect(LABELS.en![key], key).toBeTruthy();
      expect(LABELS.ar![key], key).toBeTruthy();
    }
  });
});
