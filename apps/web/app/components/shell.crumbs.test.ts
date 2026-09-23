import { describe, expect, it } from "vitest";
import { crumbsFor } from "./shell";
import type { NavItem } from "../api.server";

// On a three-level path — /ledger/journal-lines/jl_01KE… — nothing on screen
// said where you were beyond the nav highlight, and the highlight cannot say
// which record you opened. docs/ui.md §7.4, docs/07 §3 (below module level
// only). The nav carries workspace destinations and nothing deeper
// (routing.ts WORKSPACE_PATHS), so everything under one is path-derived.

const nav: NavItem[] = [
  { href: "/", labelKey: "nav.home" },
  { href: "/ledger", labelKey: "nav.ledger" },
  { href: "/admin", labelKey: "nav.admin" }
] as NavItem[];

const t = (key: string) => key;

describe("crumbsFor", () => {
  it("says nothing at module level — the nav highlight already does", () => {
    expect(crumbsFor("/", nav, t)).toEqual([]);
    expect(crumbsFor("/ledger", nav, t)).toEqual([]);
  });

  it("leaves a list tab to its own eyebrow and heading", () => {
    expect(crumbsFor("/ledger/journal-lines", nav, t)).toEqual([]);
  });

  it("walks down to the record, linking back to its list, and shortens its id", () => {
    const crumbs = crumbsFor("/ledger/journal-lines/jl_01KE953T02K8D0NXM37R35MW1H", nav, t);
    expect(crumbs.map((c) => c.href)).toEqual(["/ledger", "/ledger/journal-lines", undefined]);
    expect(crumbs.map((c) => c.label)).toEqual(["nav.ledger", "Journal lines", "jl_01KE…MW1H"]);
  });

  it("says a trailing screen name as a word rather than a slug", () => {
    // /distribution/quote-requests/:id/compare — the tail is a screen, not a
    // record, and it is minted in code, so it is said as words.
    const crumbs = crumbsFor(
      "/ledger/journal-lines/jl_01KE953T02K8D0NXM37R35MW1H/audit-trail",
      nav,
      t
    );
    expect(crumbs.at(-1)?.label).toBe("Audit trail");
  });

  // A crumb printed `humanise(segment)` — English in an Arabic session — for
  // every screen the catalogue already names.
  it("names a screen from the catalogue, in the reader's language", () => {
    const ar = (key: string) => (key === "nav.axis/quote-desk" ? "مكتب التسعير" : key);
    const crumbs = crumbsFor("/axis/quote-desk", [{ href: "/axis", labelKey: "nav.axis" }] as NavItem[], ar, "ar");
    expect(crumbs.at(-1)).toEqual({ label: "مكتب التسعير", href: "/axis/quote-desk" });
  });

  it("stays quiet under a workspace this actor's nav does not carry", () => {
    expect(crumbsFor("/mystery/thing", nav, t)).toEqual([]);
  });
});

describe("pausedHere (J-A3 degraded mode)", () => {
  it("shows on every screen when the whole tenant is paused", async () => {
    const { pausedHere } = await import("./shell");
    expect(pausedHere({ all: true, modules: [] }, "/ledger")).toBe(true);
  });
  it("shows only inside a paused module", async () => {
    const { pausedHere } = await import("./shell");
    const pause = { all: false, modules: ["signal"] };
    expect(pausedHere(pause, "/signal/cockpit")).toBe(true);
    expect(pausedHere(pause, "/axis/board")).toBe(false);
    expect(pausedHere(undefined, "/signal/cockpit")).toBe(false);
  });
});
