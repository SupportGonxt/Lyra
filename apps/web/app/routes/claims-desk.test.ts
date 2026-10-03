import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  ADVERSE_HOPS,
  OPEN_CLAIM_STATES,
  PERM,
  WEIGHTS,
  action,
  byPriority,
  headlineFor,
  hopsFor,
  incurredOf,
  isAdverseHop,
  labelsIn,
  loader,
  nextUnassigned,
  phrase,
  priorityScore,
  reserveOf,
  type ClaimRow
} from "./claims-desk";

// The desk is a prioritised queue, not a kanban board — claims (unlike cases)
// already have a real transition endpoint, so this file pins the one thing a
// queue can get wrong twice: sorting the wrong claim to the top, and offering
// a hop the API will reject. `settling`/`settled` are reached by requesting a
// payment, never by this screen's transition form (mirrors claim-detail.tsx).

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
const NOW = 1_770_000_000_000;
const DAY = 24 * 3_600_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null; key: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      key: new Headers(init.headers).get("idempotency-key")
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/axis/claims/desk", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

function loadArgs(): LoaderFunctionArgs {
  return {
    request: new Request("https://web.test/axis/claims/desk"),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as LoaderFunctionArgs;
}

const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  id: "clm_1",
  claimNo: "CLM-0001",
  customerId: "cus_1",
  status: "assessing",
  perilCode: "fire",
  amountMinor: 100_000,
  currency: "AED",
  reserveMinor: 200_000,
  paidMinor: 0,
  recoveredMinor: 0,
  handlerRef: null,
  fraudScore: null,
  siuState: null,
  slaDueAt: NOW + 2 * DAY,
  reportedAt: NOW - DAY,
  ...over
});

describe("PERM", () => {
  it("gates both writes on the same coarse permission", () => {
    expect(PERM.read).toBe("axis:claims:read");
    expect(PERM.update).toBe("axis:claims:update");
  });
});

describe("labelsIn", () => {
  it("translates every key into Arabic, lane counts and chips included", () => {
    const en = labelsIn("en");
    const ar = labelsIn("ar");
    const keys = [
      "title",
      "intro",
      "col.ref",
      "col.holder",
      "col.peril",
      "col.incurred",
      "col.reserve",
      "col.daysOpen",
      "col.fraud",
      "col.siu",
      "col.handler",
      "reserve.unpriced",
      "count.reported",
      "count.triage",
      "count.assessing",
      "count.awaiting_docs",
      "count.approved",
      "count.rejected",
      "count.settling",
      "count.recovering",
      "count.reopened",
      "unassigned",
      "sev.breach",
      "sev.due",
      "siu.referred",
      "siu.clearing",
      "siu.substantiated",
      "empty.title",
      "empty.body",
      "empty.action",
      "assign.title",
      "assign.claim",
      "assign.handler",
      "assign.submit",
      "done.assign",
      "done.transition",
      "hop.confirm",
      "hop.title",
      "hop.outcome",
      "hop.reasonCode",
      "hop.reason",
      "hop.submit",
      "hop.none",
      "approvalTitle",
      "approvalBody",
      "approvalLink",
      "problem.missing_claim",
      "problem.missing_handler",
      "problem.bad_transition",
      "problem.bad_intent",
      "headline.clear",
      "headline.breached",
      "headline.moving",
      "headline.open"
    ];

    for (const key of keys) {
      expect(en(key), key).not.toBe(key);
      expect(ar(key), key).not.toBe(key);
      expect(ar(key), key).not.toBe(en(key));
    }
  });

  it("falls back to English rather than showing a raw key", () => {
    expect(labelsIn("de")("title")).toBe(labelsIn("en")("title"));
  });
});

describe("hopsFor", () => {
  it("never offers settling or settled — those come from a payment, not this form", () => {
    expect(hopsFor("approved")).toEqual([]);
    expect(hopsFor("settling")).toEqual(["approved"]);
  });

  it("offers the ordinary hops unchanged", () => {
    expect(hopsFor("triage")).toEqual(["assessing", "rejected", "withdrawn"]);
  });

  it("is empty for a state with no legal hop", () => {
    expect(hopsFor("withdrawn")).toEqual([]);
  });
});

describe("incurredOf", () => {
  it("is reserve plus paid minus recovered", () => {
    expect(incurredOf(claim({ reserveMinor: 200_000, paidMinor: 50_000, recoveredMinor: 30_000 }))).toBe(220_000);
  });

  it("falls back to the FNOL estimate before a reserve has been set", () => {
    expect(incurredOf(claim({ reserveMinor: null, amountMinor: 75_000 }))).toBe(75_000);
  });

  it("is what has moved when nobody has priced the claim at all", () => {
    // `axis_claims.amount_minor` is nullable: a claim can be notified before
    // anyone puts a number on it. Counting that as zero incurred is honest —
    // claiming a zero *reserve* is not, which is what `reserveOf` guards.
    expect(incurredOf(claim({ reserveMinor: null, amountMinor: null, paidMinor: 40_000, recoveredMinor: 10_000 }))).toBe(
      30_000
    );
  });
});

describe("reserveOf", () => {
  it("prefers the posted reserve over the notified figure", () => {
    expect(reserveOf(claim({ reserveMinor: 200_000, amountMinor: 100_000 }))).toBe(200_000);
  });

  it("stands the notified figure in until a reserve is posted", () => {
    expect(reserveOf(claim({ reserveMinor: null, amountMinor: 100_000 }))).toBe(100_000);
  });

  it("is null — not zero — for a claim nobody has priced", () => {
    expect(reserveOf(claim({ reserveMinor: null, amountMinor: null }))).toBeNull();
  });
});

describe("isAdverseHop", () => {
  it("marks the outcomes that end a claim against the claimant", () => {
    for (const to of ADVERSE_HOPS) expect(isAdverseHop(to)).toBe(true);
  });

  it("leaves ordinary progress unmarked", () => {
    expect(isAdverseHop("assessing")).toBe(false);
    expect(isAdverseHop("triage")).toBe(false);
    expect(isAdverseHop("reopened")).toBe(false);
  });

  it("only ever marks outcomes this desk actually offers", () => {
    const offered = new Set(OPEN_CLAIM_STATES.flatMap((state) => [...hopsFor(state)]));
    for (const to of ADVERSE_HOPS) expect(offered.has(to), to).toBe(true);
  });
});

describe("priorityScore", () => {
  it("weighs a costlier, riskier, more-overdue claim higher", () => {
    const cheap = claim({ reserveMinor: 10_000, fraudScore: null, slaDueAt: NOW + 30 * DAY });
    const expensive = claim({ reserveMinor: 4_000_000, fraudScore: 90, slaDueAt: NOW - DAY });
    expect(priorityScore(expensive, NOW, WEIGHTS)).toBeGreaterThan(priorityScore(cheap, NOW, WEIGHTS));
  });

  it("treats a missing SLA date as mid-urgency, not lowest", () => {
    const noSla = claim({ slaDueAt: null });
    const farOut = claim({ slaDueAt: NOW + 60 * DAY });
    expect(priorityScore(noSla, NOW, WEIGHTS)).toBeGreaterThan(priorityScore(farOut, NOW, WEIGHTS));
  });
});

describe("byPriority", () => {
  it("sorts highest priority first, breaking ties on SLA due date then age", () => {
    const a = claim({ id: "a", reserveMinor: 100_000, slaDueAt: NOW + DAY, reportedAt: NOW - DAY });
    const b = claim({ id: "b", reserveMinor: 100_000, slaDueAt: NOW - DAY, reportedAt: NOW - 2 * DAY });
    const c = claim({ id: "c", reserveMinor: 5_000_000, fraudScore: 95, slaDueAt: NOW - DAY });
    const sorted = [a, b, c].sort(byPriority(NOW));
    expect(sorted.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });
});

describe("headlineFor", () => {
  const l = labelsIn("en");

  it("says the desk is empty when there is no open claim", () => {
    expect(headlineFor({ total: 0, breached: 0 }, l)).toBe(l("headline.clear"));
  });

  it("leads with a breach over a plain count", () => {
    expect(headlineFor({ total: 5, breached: 2 }, l)).toBe(l("headline.breached", { count: "2" }));
  });

  it("falls back to a plain count when nothing has breached", () => {
    expect(headlineFor({ total: 5, breached: 0 }, l)).toBe(l("headline.moving", { count: "5" }));
  });
});

describe("loader", () => {
  it("fetches one open page and a count per open lane, terminal states excluded", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: URL | string) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("count=true")) return Promise.resolve(new Response(JSON.stringify({ total: 3 })));
      return Promise.resolve(new Response(JSON.stringify({ data: [claim()] })));
    });

    const loaded = await loader(loadArgs());

    const listCall = calls.find((url) => !url.includes("count=true"));
    expect(listCall).toContain(`status=${OPEN_CLAIM_STATES.join(",")}`);
    expect(OPEN_CLAIM_STATES).not.toContain("settled");
    expect(OPEN_CLAIM_STATES).not.toContain("closed");
    expect(OPEN_CLAIM_STATES).not.toContain("withdrawn");
    expect(loaded.claims).toEqual([claim()]);
    expect(loaded.counts["triage"]).toBe(3);
  });

  it("degrades to an empty desk rather than failing the page on a 403", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ title: "forbidden", status: 403 }), { status: 403 }))
    );

    const loaded = await loader(loadArgs());

    expect(loaded.claims).toEqual([]);
  });
});

describe("assign", () => {
  it("patches only handlerRef, with an idempotency key, never touching settledMinor", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "assign");
    form.set("claimId", "clm_1");
    form.set("handlerRef", "staff_9");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/claims/clm_1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ handlerRef: "staff_9" });
    expect(result).toEqual({ problem: null, done: "assign" });
  });

  it("refuses without calling the API when either field is missing", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const noHandler = new FormData();
    noHandler.set("intent", "assign");
    noHandler.set("claimId", "clm_1");
    expect((await action(args(noHandler))).problem?.code).toBe("missing_handler");

    expect(calls).toHaveLength(0);
  });
});

describe("take the next unassigned claim", () => {
  // Role adoption: an agent's desk listed 34 open claims and none was hers.
  // The desk already lists unassigned claims beside everyone else's (the API
  // filters on status only), so the gap was not the list but the move: taking
  // one meant reading the handler column and typing herself into a picker.
  it("picks the highest-priority claim nobody holds", () => {
    const rows = [
      claim({ id: "held", handlerRef: "user:us_2", fraudScore: 99 }),
      claim({ id: "calm", fraudScore: 0 }),
      claim({ id: "hot", fraudScore: 90 })
    ];
    expect(nextUnassigned(rows, NOW)?.id).toBe("hot");
    expect(nextUnassigned([claim({ handlerRef: "user:us_2" })], NOW)).toBeNull();
  });

  it("assigns it to whoever is signed in, resolved on the server, not from the form", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
      if (String(input).endsWith("/v1/me")) {
        return Promise.resolve(new Response(JSON.stringify({ actor: { kind: "user", id: "us_7" }, permissions: [] })));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const form = new FormData();
    form.set("intent", "take");
    form.set("claimId", "clm_1");
    form.set("handlerRef", "user:someone_else");

    const result = await action(args(form));

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("https://api.test/v1/axis/claims/clm_1");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ handlerRef: "user:us_7" });
    expect(result).toEqual({ problem: null, done: "take" });
  });

  it("refuses without a claim", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "take");
    expect((await action(args(form))).problem?.code).toBe("missing_claim");
    expect(calls).toHaveLength(0);
  });

  it("words the move and its outcome in both languages", () => {
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      for (const key of ["take", "done.take", "count.unassigned"]) expect(l(key), `${locale} ${key}`).not.toBe(key);
    }
  });
});

describe("transition", () => {
  it("posts the hop with an idempotency key", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "transition");
    form.set("claimId", "clm_1");
    form.set("from", "triage");
    form.set("to", "assessing");
    form.set("reasonCode", "docs_received");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/claims/clm_1/transition");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ to: "assessing", reasonCode: "docs_received" });
    expect(result).toEqual({ problem: null, done: "transition" });
  });

  it("refuses a hop this screen must never offer, without calling the API", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "transition");
    form.set("claimId", "clm_1");
    form.set("from", "approved");
    form.set("to", "settling");

    const result = await action(args(form));

    expect(result.problem?.code).toBe("bad_transition");
    expect(calls).toHaveLength(0);
  });

  it("surfaces an approval gate instead of claiming the hop went through", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ title: "approval required", status: 403, code: "approval_required", policy_key: "axis.claim_approve" }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );
    const form = new FormData();
    form.set("intent", "transition");
    form.set("claimId", "clm_1");
    form.set("from", "assessing");
    form.set("to", "approved");

    const result = await action(args(form));

    expect(result.done).toBeNull();
    expect(result.problem?.code).toBe("approval_required");
  });
});

describe("unknown intent", () => {
  it("is a 400 and touches nothing — bulk-chase is not offered, the Chaser agent does not exist yet", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "bulk-chase");

    const result = await action(args(form));

    expect(result.problem?.status).toBe(400);
    expect(result.problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });
});

describe("phrase", () => {
  it("swaps a known code for this screen's sentence and leaves others alone", () => {
    const l = labelsIn("en");
    expect(phrase({ title: "missing_handler", status: 400, code: "missing_handler" }, l).title).toBe(
      l("problem.missing_handler")
    );
    expect(phrase({ title: "duplicate", status: 409, code: "conflict" }, l).title).toBe("duplicate");
  });
});
