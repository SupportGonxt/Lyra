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
