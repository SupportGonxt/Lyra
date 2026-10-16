import { describe, expect, it } from "vitest";
import {
  AEO_LOSING_MIN_SAMPLES,
  AEO_STALE_DAYS,
  UNBOUNDED_GRACE_DAYS,
  suggestNext,
  type NextInput,
  type Suggestion
} from "./signal-next.js";

// docs/modules/signal.md §4.1. SIGNAL is meant to be *aware* and to *suggest*.
// The rules are a pure function of a snapshot precisely so each rule can be
// pinned against a fixture: what is asserted here is that a suggestion appears
// when the evidence is there, does not when it is not, and always carries the
// figures that produced it.

const NOW = Date.parse("2026-10-01T09:00:00Z");
const DAY = 86_400_000;

const base = (over: Partial<NextInput> = {}): NextInput => ({
  now: NOW,
  campaigns: [],
  creatives: [],
  publishes: [],
  whitespaces: [],
  aeoPages: [],
  citations: [],
  audiences: [],
  experiments: [],
  spendDaysWithData: 0,
  assistants: 0,
  kitConfigured: true,
  ...over
});

const campaign = (over: Partial<NextInput["campaigns"][number]> = {}) => ({
  id: "cmp_1",
  name: "Motor search",
  state: "live",
  budgetJson: JSON.stringify({ autopilotBoundMinor: 500_000 }),
  audienceId: null,
  holdout: false,
  startAt: NOW - 40 * DAY,
  ...over
});

const keys = (s: readonly Suggestion[]) => s.map((x) => x.key);
const find = (s: readonly Suggestion[], key: string) => s.find((x) => x.key === key);

describe("suggestNext", () => {
  it("says nothing when there is nothing to say", () => {
    expect(suggestNext(base())).toEqual([]);
  });

  describe("whitespace (the SCOUT link)", () => {
    it("proposes a campaign for a validated opportunity nobody has planned", () => {
      const out = suggestNext(
        base({ whitespaces: [{ id: "wsp_1", description: "Pet cover, unserved", status: "validated", demandEstimate: 820 }] })
      );
      const [first] = out;
      expect(first).toMatchObject({ kind: "whitespace", urgency: "now", action: { href: "/signal/studio" } });
      expect(first!.why).toContain("820");
      expect(first!.title).toContain("Pet cover, unserved");
    });

    it("does not nag about one already planned, and ignores unvalidated candidates", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign({ name: "Pet cover, unserved" })],
          whitespaces: [
            { id: "wsp_1", description: "Pet cover, unserved", status: "validated", demandEstimate: 820 },
            { id: "wsp_2", description: "Still a candidate", status: "candidate", demandEstimate: 300 }
          ]
        })
      );
      expect(keys(out).filter((k) => k.startsWith("whitespace:"))).toEqual([]);
    });
  });

  describe("creatives", () => {
    it("says a live campaign has nothing it can publish", () => {
      const out = suggestNext(base({ campaigns: [campaign()] }));
      const found = find(out, "creative:unpublishable:cmp_1");
      expect(found).toMatchObject({ urgency: "now", kind: "creative" });
      expect(found!.why).toContain("no creative at all");
    });

    it("says so when every variant is blocked rather than passed", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign()],
          creatives: [{ id: "crv_1", campaignId: "cmp_1", locale: "en", complianceStatus: "blocked" }]
        })
      );
      const found = find(out, "creative:unpublishable:cmp_1");
      expect(found!.why).toContain("blocked");
      expect(found!.evidence).toMatchObject({ creatives: 1, passed: 0 });
    });

    it("counts flagged variants as work waiting on a person", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign()],
          creatives: [
            { id: "crv_1", campaignId: "cmp_1", locale: "en", complianceStatus: "flagged" },
            { id: "crv_2", campaignId: "cmp_1", locale: "ar", complianceStatus: "passed" }
          ]
        })
      );
      expect(find(out, "creative:flagged")!.evidence).toMatchObject({ flagged: 1 });
      // One passed variant is enough to publish, so that rule stays quiet.
      expect(find(out, "creative:unpublishable:cmp_1")).toBeUndefined();
    });
  });

  describe("publishing", () => {
    it("proposes a cleared variant that is on no platform", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign()],
          creatives: [{ id: "crv_1", campaignId: "cmp_1", locale: "en", complianceStatus: "passed" }]
        })
      );
      expect(find(out, "publish:ready")).toMatchObject({ kind: "publish", urgency: "soon" });
    });

    it("stops proposing it once a platform has taken it", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign()],
          creatives: [{ id: "crv_1", campaignId: "cmp_1", locale: "en", complianceStatus: "passed" }],
          publishes: [{ creativeId: "crv_1", status: "published" }]
        })
      );
      expect(find(out, "publish:ready")).toBeUndefined();
    });

    it("ignores a failed placement, because a failure is exactly what to retry", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign()],
          creatives: [{ id: "crv_1", campaignId: "cmp_1", locale: "en", complianceStatus: "passed" }],
          publishes: [{ creativeId: "crv_1", status: "failed" }]
        })
      );
      expect(find(out, "publish:ready")).toBeDefined();
    });
  });

  describe("budget", () => {
    it("proposes a bound once a campaign has run past the grace period without one", () => {
      const out = suggestNext(base({ campaigns: [campaign({ budgetJson: JSON.stringify({}) })] }));
      const found = find(out, "budget:unbounded:cmp_1");
      expect(found).toMatchObject({ kind: "budget", urgency: "soon" });
      // It names the default the autopilot silently falls back to.
      expect(found!.why).toContain("1 000 AED default");
    });

    it("leaves a young campaign alone", () => {
      const young = campaign({ budgetJson: JSON.stringify({}), startAt: NOW - (UNBOUNDED_GRACE_DAYS - 1) * DAY });
      expect(find(suggestNext(base({ campaigns: [young] })), "budget:unbounded:cmp_1")).toBeUndefined();
    });

    it("never proposes a bound on a holdout, which the autopilot does not touch", () => {
      const holdout = campaign({ budgetJson: JSON.stringify({}), holdout: true });
      expect(find(suggestNext(base({ campaigns: [holdout] })), "budget:unbounded:cmp_1")).toBeUndefined();
    });
  });

  describe("audience consent", () => {
    it("raises a live campaign whose audience excludes marketing consent", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign({ audienceId: "aud_1" })],
          audiences: [{ id: "aud_1", name: "Quote abandoners", consentPurposes: "profiling", sizeCached: 400 }]
        })
      );
      const found = find(out, "audience:consent:cmp_1");
      expect(found).toMatchObject({ urgency: "now", action: { href: "/signal/audiences" } });
      expect(found!.why).toContain("profiling");
    });

    it("stays quiet when marketing is among the purposes", () => {
      const out = suggestNext(
        base({
          campaigns: [campaign({ audienceId: "aud_1" })],
          audiences: [{ id: "aud_1", name: "A", consentPurposes: "marketing,profiling", sizeCached: 400 }]
        })
      );
      expect(find(out, "audience:consent:cmp_1")).toBeUndefined();
    });
  });

  describe("governance and insight", () => {
    it("notes a missing brand kit only once something is live", () => {
      expect(find(suggestNext(base({ kitConfigured: false })), "governance:no-kit")).toBeUndefined();
      const out = suggestNext(base({ campaigns: [campaign()], kitConfigured: false }));
      expect(find(out, "governance:no-kit")).toMatchObject({ urgency: "when-you-can" });
    });

    it("notes that CAC has no denominator when no spend is on file", () => {
      expect(find(suggestNext(base({ campaigns: [campaign()], spendDaysWithData: 0 })), "spend:missing")).toBeDefined();
      expect(find(suggestNext(base({ campaigns: [campaign()], spendDaysWithData: 3 })), "spend:missing")).toBeUndefined();
    });

    it("names an experiment that can never conclude on its metric", () => {
      const out = suggestNext(
        base({
          experiments: [
            { id: "exp_1", hypothesis: "AEO copy lifts citation", metric: "aeo_citation_share", state: "running" },
            { id: "exp_2", hypothesis: "Copy lifts clicks", metric: "click_through_rate", state: "running" }
          ]
        })
      );
      expect(keys(out).filter((k) => k.startsWith("experiment:"))).toEqual(["experiment:uncountable:exp_1"]);
      expect(find(out, "experiment:uncountable:exp_1")!.why).toContain("click_through_rate");
    });
  });

  describe("AEO", () => {
    const page = (over: Partial<NextInput["aeoPages"][number]> = {}) => ({
      id: "aep_1",
      queryCluster: "how much is car insurance in dubai",
      status: "published",
      freshness: NOW - 2 * DAY,
      ...over
    });

    it("says the share is unmeasured rather than zero when no assistant is connected", () => {
      const out = suggestNext(base({ aeoPages: [page()], assistants: 0 }));
      const found = find(out, "aeo:no-assistant");
      expect(found!.why).toContain("nobody asked");
      expect(found!.why).toContain("different fact from being uncited");
    });

    it("calls a page past the window stale, including one never stamped", () => {
      const old = page({ id: "aep_old", freshness: NOW - (AEO_STALE_DAYS + 1) * DAY });
      const unstamped = page({ id: "aep_none", freshness: null });
      const out = suggestNext(base({ aeoPages: [old, unstamped], assistants: 1 }));
      expect(find(out, "aeo:stale")!.evidence).toMatchObject({ stalePages: 2 });
    });

    it("raises a query that has been sampled and never cited", () => {
      const citations = Array.from({ length: AEO_LOSING_MIN_SAMPLES }, () => ({ pageId: "aep_1", cited: false }));
      const out = suggestNext(base({ aeoPages: [page()], citations, assistants: 1 }));
      const found = find(out, "aeo:losing:aep_1");
      expect(found).toMatchObject({ urgency: "soon" });
      expect(found!.why).toContain(`Sampled ${AEO_LOSING_MIN_SAMPLES} times and cited none`);
    });

    it("does not call two misses a finding", () => {
      const citations = Array.from({ length: AEO_LOSING_MIN_SAMPLES - 1 }, () => ({ pageId: "aep_1", cited: false }));
      expect(find(suggestNext(base({ aeoPages: [page()], citations, assistants: 1 })), "aeo:losing:aep_1")).toBeUndefined();
    });

    it("does not raise a query that was cited at least once", () => {
      const citations = [
        { pageId: "aep_1", cited: true },
        { pageId: "aep_1", cited: false },
        { pageId: "aep_1", cited: false }
      ];
      expect(find(suggestNext(base({ aeoPages: [page()], citations, assistants: 1 })), "aeo:losing:aep_1")).toBeUndefined();
    });

    it("leaves draft pages out of the stale and losing rules", () => {
      const draft = page({ status: "draft", freshness: NOW - 100 * DAY, id: "aep_draft" });
      const out = suggestNext(base({ aeoPages: [draft], assistants: 1 }));
      expect(find(out, "aeo:stale")).toBeUndefined();
      expect(keys(out).some((k) => k.startsWith("aeo:losing"))).toBe(false);
    });
  });

  describe("ordering", () => {
    it("puts what needs a person now above what can wait, and is stable", () => {
      const input = base({
        campaigns: [campaign({ budgetJson: JSON.stringify({}), audienceId: "aud_1" })],
        audiences: [{ id: "aud_1", name: "Quote abandoners", consentPurposes: "profiling", sizeCached: 10 }],
        whitespaces: [{ id: "wsp_1", description: "Pet cover", status: "validated", demandEstimate: 500 }],
        kitConfigured: false,
        spendDaysWithData: 0
      });
      const out = suggestNext(input);
      const urgencies = out.map((s) => s.urgency);
      expect(urgencies).toEqual([...urgencies].sort((a, b) => (a === "now" ? -1 : b === "now" ? 1 : 0)));
      // Two reads of the same data give the same list in the same order.
      expect(keys(suggestNext(input))).toEqual(keys(out));
    });
  });

  it("carries the figures behind every suggestion", () => {
    const out = suggestNext(
      base({
        campaigns: [campaign({ budgetJson: JSON.stringify({}) })],
        whitespaces: [{ id: "wsp_1", description: "Pet cover", status: "validated", demandEstimate: 500 }],
        kitConfigured: false
      })
    );
    expect(out.length).toBeGreaterThan(2);
    for (const s of out) {
      expect(s.why.length, s.key).toBeGreaterThan(30);
      expect(Object.keys(s.evidence).length, s.key).toBeGreaterThan(0);
    }
  });
});
