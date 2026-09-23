import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { loader as approvalsLoader } from "./approvals";
import { activeCampaignCount, isOwnWork, loader, openWhitespaceCount } from "./home";

// The activity panel is headed "Your recent activity", which is a promise: it
// lists what this person changed. Signing in is not a change, and the audit log
// records far more of it than of anything else — 179 logins against 2 real
// changes in a seeded tenant.

describe("what counts as your recent activity", () => {
  it("keeps the changes a person made", () => {
    expect(isOwnWork({ action: "compliance.legal-holds.create", subjectRef: "lgh_1" })).toBe(true);
    expect(isOwnWork({ action: "axis.cases.update", subjectRef: "cas_1" })).toBe(true);
  });

  it("leaves session history to Settings › security", () => {
    // Filtering on the action prefix alone missed `core.mfa.verified`, which
    // carries a session id too — so the panel printed `ses_01KE…` at a person
    // who cannot act on it. The subject is the honest test: an event about a
    // session is session history whatever the code is called.
    expect(isOwnWork({ action: "core.session.login", subjectRef: "ses_1" })).toBe(false);
    expect(isOwnWork({ action: "core.session.revoke", subjectRef: "ses_1" })).toBe(false);
    expect(isOwnWork({ action: "core.mfa.verified", subjectRef: "ses_1" })).toBe(false);
  });

  it("keeps an event with no subject at all", () => {
    expect(isOwnWork({ action: "core.settings.update", subjectRef: null })).toBe(true);
  });
});

describe("openWhitespaceCount", () => {
  it("counts everything that is not parked", () => {
    expect(
      openWhitespaceCount([
        { id: "wsp_1", status: "candidate" },
        { id: "wsp_2", status: "validating" },
        { id: "wsp_3", status: "validated" },
        { id: "wsp_4", status: "parked" }
      ])
    ).toBe(3);
  });

  it("is zero once every whitespace item is parked", () => {
    expect(openWhitespaceCount([{ id: "wsp_1", status: "parked" }])).toBe(0);
  });

  it("is zero for an empty list", () => {
    expect(openWhitespaceCount([])).toBe(0);
  });
});

describe("activeCampaignCount", () => {
  it("counts only campaigns actually live", () => {
    expect(
      activeCampaignCount([
        { id: "cmp_1", state: "draft" },
        { id: "cmp_2", state: "live" },
        { id: "cmp_3", state: "live" },
        { id: "cmp_4", state: "paused" },
        { id: "cmp_5", state: "ended" }
      ])
    ).toBe(2);
  });

  it("is zero when nothing is live", () => {
    expect(activeCampaignCount([{ id: "cmp_1", state: "scheduled" }])).toBe(0);
  });
});


describe("the hero figure and what clicking it shows", () => {
  const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
  const context = { get: () => ({ env, ctx: null }) };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts exactly the rows /approvals lists, because both read one inbox", () => {
    // The tile links to /approvals, so the promise is that the queue holds the
    // number the tile printed. Both screens go through /v1/me/inbox — the only
    // endpoint scoped to THIS actor — and this pins that they still do: the CRUD
    // list would hand /approvals every pending row in the tenant instead.
    const approvals = ["cas_1", "cas_2", "cas_3"].map((subjectRef, i) => ({
      id: `apr_${i}`,
      subjectRef,
      policyKey: "axis.claims.pay",
      module: "axis",
      requestedBy: "user:usr_2",
      requestedAt: i,
      decidedBy: null,
      decision: "pending",
      reason: null,
      contextJson: null,
      decidedAt: null
    }));
    vi.stubGlobal("fetch", (input: URL | string) => {
      const url = String(input);
      const body = url.endsWith("/v1/me")
        ? { permissions: [], policy: { currency: "AED" }, actor: { kind: "user", id: "usr_1" } }
        : url.endsWith("/v1/me/inbox")
          ? { approvals, notifications: [], counts: { approvals: approvals.length, notifications: 0 } }
          : { data: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      );
    });

    return Promise.all([
      loader({ request: new Request("https://web.test/"), context, params: {} } as unknown as LoaderFunctionArgs),
      approvalsLoader({
        request: new Request("https://web.test/approvals"),
        context,
        params: {}
      } as unknown as LoaderFunctionArgs)
    ]).then(([home, queue]) => {
      expect(home.counts?.approvals).toBe(approvals.length);
      expect(queue.items).toHaveLength(home.counts!.approvals);
    });
  });
});

describe("the flagship journey's door", () => {
  // A module lead clicked it and met a 403 at step two (docs/28 §1).
  it("opens only for a reader who can walk all four steps", async () => {
    const { JOURNEY_NEEDS, walksJourney } = await import("./home");
    expect(walksJourney([...JOURNEY_NEEDS])).toBe(true);
    expect(walksJourney(["axis:cases:read"])).toBe(false);
    expect(walksJourney([])).toBe(false);
  });
});
