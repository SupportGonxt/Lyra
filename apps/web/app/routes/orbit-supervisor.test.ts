import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { lensOf } from "../components/hero";
import {
  LABELS,
  NoAlerts,
  alertOf,
  alertsFrom,
  labelsIn,
  lensesAt,
  staffing,
  supervisorHeadline,
  type Presence,
  type SupervisedConversation
} from "./orbit-supervisor";

// docs/modules/orbit.md §4 screen 2. The wall's own logic is the triage: which
// open conversations have missed something, and in what order a supervisor
// should look at them.

const NOW = 1_760_000_000_000;

const conv = (over: Partial<SupervisedConversation> = {}): SupervisedConversation => ({
  id: `cnv_${Math.round(Math.random() * 1e9)}`,
  customerId: null,
  channel: "whatsapp",
  state: "human",
  assigneeRef: null,
  teamId: null,
  intent: null,
  sentiment: null,
  summary: null,
  lang: null,
  firstResponseMs: null,
  lastMessageAt: null,
  createdAt: NOW - 60_000,
  priority: 2,
  queuedAt: NOW - 60_000,
  firstResponseDueAt: null,
  resolutionDueAt: null,
  frtBreachedAt: null,
  resolutionBreachedAt: null,
  ...over
});

describe("alertOf", () => {
  it("says nothing about a conversation inside every deadline", () => {
    expect(alertOf(conv({ firstResponseDueAt: NOW + 60_000, resolutionDueAt: NOW + 600_000 }), NOW)).toBeNull();
  });

  it("reads a missed resolution as worse than a missed first reply", () => {
    const both = conv({ frtBreachedAt: NOW - 1000, resolutionBreachedAt: NOW - 10 });
    expect(alertOf(both, NOW)).toBe("resolution");
  });

  it("reads a first-reply breach stamp", () => {
    expect(alertOf(conv({ frtBreachedAt: NOW - 1000 }), NOW)).toBe("frt");
  });

  it("sees a deadline that has passed before the sweep has stamped it", () => {
    // sweepRouting stamps on the cron tick, so the board is ahead of the row.
    expect(alertOf(conv({ firstResponseDueAt: NOW - 1 }), NOW)).toBe("due");
    expect(alertOf(conv({ resolutionDueAt: NOW - 1 }), NOW)).toBe("due");
  });

  it("does not treat a deadline still ahead as passed", () => {
    expect(alertOf(conv({ firstResponseDueAt: NOW + 1 }), NOW)).toBeNull();
  });
});

describe("alertsFrom", () => {
  it("drops the healthy rows and orders the rest worst first, oldest first within a kind", () => {
    const resolution = conv({ id: "a", resolutionBreachedAt: NOW - 1 });
    const frtNew = conv({ id: "b", frtBreachedAt: NOW - 1, queuedAt: NOW - 1000 });
    const frtOld = conv({ id: "c", frtBreachedAt: NOW - 1, queuedAt: NOW - 90_000 });
    const due = conv({ id: "d", firstResponseDueAt: NOW - 1 });
    const healthy = conv({ id: "e" });

    expect(alertsFrom([healthy, due, frtNew, frtOld, resolution], NOW).map((alert) => alert.row.id)).toEqual([
      "a",
      "c",
      "b",
      "d"
    ]);
  });

  it("falls back to when the conversation was created if it never queued", () => {
    const older = conv({ id: "old", queuedAt: null, createdAt: NOW - 90_000, frtBreachedAt: NOW - 1 });
    const newer = conv({ id: "new", queuedAt: null, createdAt: NOW - 10_000, frtBreachedAt: NOW - 1 });
    expect(alertsFrom([newer, older], NOW).map((alert) => alert.row.id)).toEqual(["old", "new"]);
  });

  it("returns nothing when the room is healthy", () => {
    expect(alertsFrom([conv(), conv()], NOW)).toEqual([]);
  });
});

describe("staffing", () => {
  const presence = (status: string, activeCount: number | null): Presence => ({
    id: `ap_${status}_${activeCount}`,
    userId: "usr_1",
    status,
    activeCount,
    updatedAt: NOW
  });

  it("counts the roster by presence and sums what they are holding", () => {
    expect(
      staffing([presence("available", 3), presence("available", 1), presence("away", 0), presence("offline", null)])
    ).toEqual({ available: 2, away: 1, offline: 1, holding: 4 });
  });

  it("survives an empty roster", () => {
    expect(staffing([])).toEqual({ available: 0, away: 0, offline: 0, holding: 0 });
  });
});

describe("supervisorHeadline", () => {
  it("leads with a breach over a long wait over a plain open count", () => {
    const l = labelsIn("en");
    expect(supervisorHeadline(5, 2, 3, l)).toBe(l("headlineBreach", { n: "2" }));
    expect(supervisorHeadline(5, 0, 3, l)).toBe(l("headlineWaiting", { n: "3" }));
    expect(supervisorHeadline(5, 0, 0, l)).toBe(l("headlineOpen", { n: "5" }));
    expect(supervisorHeadline(0, 0, 0, l)).toBe(l("headlineClear"));
  });
});

// A hero figure with a drill-down promises the rows it counted
// (components/hero.tsx); the breached figure and the alerts table have to agree
// on what "breached" means or the wall lies about its own triage.
describe("the wall's breached door", () => {
  it("counts exactly the rows the alerts table lists", () => {
    const rows = [
      conv({ id: "cnv_res", resolutionBreachedAt: NOW - 1 }),
      conv({ id: "cnv_ok" }),
      conv({ id: "cnv_due", firstResponseDueAt: NOW - 1 })
    ];
    const shown = lensOf(rows, lensesAt(NOW), "breached");

    expect(shown.map((row) => row.id).sort()).toEqual(["cnv_due", "cnv_res"]);
    expect(shown).toHaveLength(alertsFrom(rows, NOW).length);
  });
});

describe("the supervisor wall speaks both locales", () => {
  it("has the same keys in en and ar, none left empty or untranslated", () => {
    expect(Object.keys(LABELS.ar ?? {}).sort()).toEqual(Object.keys(LABELS.en ?? {}).sort());
    for (const [key, english] of Object.entries(LABELS.en ?? {})) {
      const arabic = LABELS.ar?.[key] ?? "";
      expect(arabic.trim(), key).not.toBe("");
      expect(arabic, key).not.toBe(english);
    }
  });
});

describe("a wall with nothing overdue", () => {
  // Role adoption: with every chat held by the agent, the wall's lead card
  // was an empty "Nothing has missed a deadline" telling the supervisor to
  // refresh. What a supervisor does then is check how the agent handled it.
  const l = labelsIn("en");
  const html = (props: { bot: number; door: boolean }) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NoAlerts, { l, ...props })));

  it("says how much the agent is holding and points at quality", () => {
    const out = html({ bot: 12, door: true });
    expect(out).toContain(l("noAlerts.bot", { n: "12" }));
    expect(out).toContain('href="/orbit/quality"');
  });

  it("keeps the plain sentence when the agent holds nothing", () => {
    expect(html({ bot: 0, door: true })).toContain(l("noAlertsBody"));
  });

  it("offers no door to a seat that cannot read quality", () => {
    expect(html({ bot: 12, door: false })).not.toContain("/orbit/quality");
  });
});
