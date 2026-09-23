import { afterEach, describe, expect, it, vi } from "vitest";
import { lensOf } from "../components/hero";
import type { Env } from "../env";
import {
  LABELS as consoleLabels,
  SLOW_MS,
  action as takeOver,
  lensesAt as consoleLenses,
  consoleHeadline,
  labelsIn as consoleLabelsIn,
  loader as consoleLoader,
  moodKey,
  moodTone,
  mostUrgent,
  waitLabel,
  waitingMs,
  type LiveConversation
} from "./orbit-console";
import {
  HIGH_RISK_FLOOR,
  LABELS as saveLabels,
  LENSES as saveLenses,
  action as saveAction,
  atRisk,
  canOffer,
  canResolve,
  labelsIn as saveLabelsIn,
  loader as saveLoader,
  riskTone,
  saveHeadline,
  type Renewal
} from "./orbit-save";
import {
  LABELS as pipelineLabels,
  STAGES,
  lensesAt as pipelineLenses,
  action as sweepAction,
  labelsIn as pipelineLabelsIn,
  loader as pipelineLoader,
  pipelineHeadline,
  urgency
} from "./orbit-pipeline";
import {
  LABELS as journeyLabels,
  action as journeyAction,
  blockers,
  journeyLede,
  labelsIn as journeyLabelsIn,
  loader as journeyLoader,
  mutate,
  nameOf,
  readGraph,
  startsAt,
  type Journey,
  type JourneyGraph
} from "./orbit-journey";
import {
  LABELS as qualityLabels,
  LENSES as qualityLenses,
  action as scoreAction,
  breakdownOf,
  checkScore,
  flagsOf,
  isAgentScored,
  labelsIn as qualityLabelsIn,
  loader as qualityLoader,
  mean,
  qualityHeadline,
  type QaScore
} from "./orbit-quality";
import {
  LABELS as analyticsLabels,
  action as analyticsAction,
  analyticsHeadline,
  containment,
  definitionOf,
  labelsIn as analyticsLabelsIn,
  loader as analyticsLoader,
  meanOf,
  ratio,
  windowDays
} from "./orbit-analytics";
import { ApiError } from "../api-error";
import { ORBIT, daysUntil, orbitPortals, safe } from "./orbit-shared";

// The six bespoke ORBIT screens. Everything below is either a rule an operator
// leans on (who is waiting, what may be offered, what stops a journey going
// live, what a score means) or a gate (a control the actor cannot use is absent,
// a refusal is a notice, and no locale is missing a word).

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubApi(replies: Array<[string, Response]>) {
  const calls: Array<{ url: string; method: string; body: string | null; headers: Headers }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      headers: new Headers(init.headers)
    });
    const hit = replies.find(([fragment]) => url.includes(fragment));
    if (!hit) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(hit[1].clone());
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** /v1/me as the shell reads it: locale, an actor id, and the held permissions. */
function me(...permissions: string[]): Response {
  return json({
    actor: { kind: "user", id: "usr_01" },
    profile: null,
    tenant: { id: "t1", slug: "t", name: "T", plan: "pro", region: "af", status: "active", brand: null },
    locale: "en",
    roles: [],
    permissions,
    entitlements: {},
    policy: {},
    nav: [],
    overrides: {}
  });
}

function problem(title: string, status: number): Response {
  return new Response(JSON.stringify({ title, status }), {
    status,
    headers: { "content-type": "application/problem+json" }
  });
}

function args(url: string, init?: RequestInit, params: Record<string, string> = {}): any {
  return {
    request: new Request(url, init),
    params,
    context: { get: () => ({ env, ctx: {} }) }
  };
}

function form(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams(fields);
  return { method: "POST", body };
}

/* ------------------------------------------------------------------- labels */

const TABLES: Array<[string, typeof consoleLabels]> = [
  ["console", consoleLabels],
  ["save", saveLabels],
  ["pipeline", pipelineLabels],
  ["journey", journeyLabels],
  ["quality", qualityLabels],
  ["analytics", analyticsLabels]
];

describe("every ORBIT screen speaks both locales", () => {
  it.each(TABLES)("%s has the same keys in en and ar", (_name, table) => {
    expect(Object.keys(table.ar ?? {}).sort()).toEqual(Object.keys(table.en ?? {}).sort());
  });

  it.each(TABLES)("%s never leaves an Arabic string empty or English", (_name, table) => {
    for (const [key, english] of Object.entries(table.en ?? {})) {
      const arabic = table.ar?.[key] ?? "";
      expect(arabic.trim(), key).not.toBe("");
      expect(arabic, key).not.toBe(english);
    }
  });

  it("falls back to English for a locale nobody translated", () => {
    expect(consoleLabelsIn("fr")("title")).toBe(consoleLabels.en?.title);
    expect(analyticsLabelsIn("fr")("title")).toBe(analyticsLabels.en?.title);
  });

  it("fills slots in both locales", () => {
    expect(analyticsLabelsIn("en")("days", { n: "30" })).toContain("30");
    expect(analyticsLabelsIn("ar")("days", { n: "30" })).toContain("30");
    expect(saveLabelsIn("ar")("approvalBody", { policy: "orbit.save_offer" })).toContain("orbit.save_offer");
  });

  it("names every pipeline stage and every journey refusal in both locales", () => {
    for (const stage of STAGES) {
      expect(pipelineLabelsIn("ar")(stage)).not.toBe(stage);
    }
    for (const code of ["bad_key", "bad_type", "duplicate_key", "second_trigger", "self_link", "bad_cooldown"]) {
      expect(journeyLabelsIn("ar")(code), code).not.toBe(code);
    }
    for (const code of ["needConversation", "needRubric", "needScore"]) {
      expect(qualityLabelsIn("ar")(code), code).not.toBe(code);
    }
  });
});

/* ------------------------------------------------------------------ console */

const live: LiveConversation = {
  id: "cnv_01",
  customerId: "cus_01",
  channel: "whatsapp",
  state: "bot",
  assigneeRef: null,
  teamId: null,
  intent: "renewal",
  sentiment: -40,
  summary: "wants a cheaper premium",
  lang: "en",
  firstResponseMs: 900,
  lastMessageAt: 1_000_000,
  createdAt: 900_000
};

describe("who is waiting", () => {
  it("measures from the last message, falling back to when it opened", () => {
    expect(waitingMs(live, 1_060_000)).toBe(60_000);
    expect(waitingMs({ ...live, lastMessageAt: null }, 1_000_000)).toBe(100_000);
  });

  it("never reads negative when a clock runs ahead", () => {
    expect(waitingMs(live, 900_000)).toBe(0);
  });

  it("steps minutes up to hours up to days", () => {
    const l = consoleLabelsIn("en");
    expect(waitLabel(5 * 60_000, l)).toContain("5");
    expect(waitLabel(90 * 60_000, l)).toBe(l("waitHours", { n: "1" }));
    expect(waitLabel(50 * 3_600_000, l)).toBe(l("waitDays", { n: "2" }));
  });

  it("treats a quarter hour of silence as the thing to look at", () => {
    expect(SLOW_MS).toBe(900_000);
    expect(waitingMs(live, 1_000_000 + SLOW_MS + 1)).toBeGreaterThan(SLOW_MS);
  });

  it("buckets sentiment into three moods with matching tones", () => {
    expect([moodKey(null), moodTone(null)]).toEqual(["moodUnknown", "neutral"]);
    expect([moodKey(-40), moodTone(-40)]).toEqual(["moodNegative", "danger"]);
    expect([moodKey(0), moodTone(0)]).toEqual(["moodNeutral", "neutral"]);
    expect([moodKey(60), moodTone(60)]).toEqual(["moodPositive", "success"]);
  });

  it("picks whoever has waited longest as the one to open first", () => {
    const older = { ...live, id: "cnv_02", lastMessageAt: 500_000 };
    expect(mostUrgent([live, older], 1_000_000)?.id).toBe("cnv_02");
    expect(mostUrgent([], 1_000_000)).toBeNull();
  });

  it("opens the console with whichever queue state is most urgent, not static copy", () => {
    const l = consoleLabelsIn("en");
    expect(consoleHeadline(3, 0, 2, l)).toBe(l("headlineOverdue", { n: "2" }));
    expect(consoleHeadline(3, 1, 0, l)).toBe(l("headlineAgent", { n: "3" }));
    expect(consoleHeadline(0, 4, 0, l)).toBe(l("headlineHuman", { n: "4" }));
    expect(consoleHeadline(0, 0, 0, l)).toBe(l("headlineClear"));
  });
});

describe("the live console loader", () => {
  it("reads both queues plus the handover notes when the actor may", async () => {
    const calls = stubApi([
      ["/v1/me", me(ORBIT.conversations, ORBIT.handovers, ORBIT.assign)],
      ["state=bot", json({ data: [live], total: 1 })],
      ["state=human", json({ data: [], total: 0 })],
      ["handover-notes", json({ data: [{ id: "hno_01", ts: 1 }] })]
    ]);
    const loaded = await consoleLoader(args("https://web.test/orbit/console"));

    expect(loaded.may).toEqual({ read: true, take: true });
    expect(loaded.bot.data).toHaveLength(1);
    expect(loaded.handovers).toHaveLength(1);
    expect(loaded.tenantSlug).toBe("t");
    expect(calls.filter((call) => call.url.includes("conversations"))).toHaveLength(2);
  });

  it("asks for nothing it cannot read and offers no handover control", async () => {
    const calls = stubApi([["/v1/me", me()]]);
    const loaded = await consoleLoader(args("https://web.test/orbit/console"));

    expect(loaded.may).toEqual({ read: false, take: false });
    expect(loaded.bot.data).toEqual([]);
    expect(calls.filter((call) => call.url.includes("/v1/orbit/"))).toHaveLength(0);
  });

  it("keeps the screen up when one panel is withheld mid-flight", async () => {
    stubApi([
      ["/v1/me", me(ORBIT.conversations, ORBIT.handovers)],
      ["state=bot", json({ data: [live], total: 1 })],
      ["state=human", json({ data: [], total: 0 })],
      ["handover-notes", problem("forbidden", 403)]
    ]);
    const loaded = await consoleLoader(args("https://web.test/orbit/console"));

    expect(loaded.handovers).toEqual([]);
    expect(loaded.bot.data).toHaveLength(1);
  });
});

describe("taking a conversation over", () => {
  it("assigns the actor, switches to human, and carries the idempotency key", async () => {
    const calls = stubApi([
      ["/v1/me", me(ORBIT.assign)],
      ["/v1/orbit/conversations/cnv_01", json({ id: "cnv_01" })]
    ]);
    const out = await takeOver(args("https://web.test/orbit/console", form({ intent: "take", id: "cnv_01", nonce: "n1" })));

    expect(out).toEqual({ problem: null, took: "cnv_01" });
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.headers.get("idempotency-key")).toBe("n1");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ assigneeRef: "usr_01", state: "human" });
  });

  it("refuses an unknown intent and a missing conversation without a round trip", async () => {
    const calls = stubApi([["/v1/me", me(ORBIT.assign)]]);

    expect((await takeOver(args("https://web.test/orbit/console", form({ intent: "delete" })))).problem?.title).toBe(
      "unknown_intent"
    );
    expect((await takeOver(args("https://web.test/orbit/console", form({ intent: "take" })))).problem?.title).toBe(
      "missing_conversation"
    );
    expect(calls).toHaveLength(0);
  });

  it("turns the API's no into a notice rather than a crash", async () => {
    stubApi([
      ["/v1/me", me(ORBIT.assign)],
      ["/v1/orbit/conversations/cnv_01", problem("forbidden", 403)]
    ]);
    const out = await takeOver(args("https://web.test/orbit/console", form({ intent: "take", id: "cnv_01" })));

    expect(out.took).toBeNull();
    expect(out.problem?.status).toBe(403);
  });
});

/* --------------------------------------------------------------- save desk */

const renewal: Renewal = {
  id: "ren_01",
  policyRef: "pol_01",
  customerId: "cus_01",
  expiryAt: 2_000_000_000_000,
  churnScore: 82,
  strategy: "human",
  state: "scheduled",
  outcomeReason: null,
  ownerRef: null,
  offeredAt: null,
  decidedAt: null,
  requotesJson: null,
  createdAt: 1_700_000_000
};

describe("the save queue's rules", () => {
  it("counts the high-risk head at the documented floor", () => {
    const rows = [renewal, { ...renewal, id: "ren_02", churnScore: 40 }, { ...renewal, id: "ren_03", churnScore: null }];
    expect(atRisk(rows).map((row) => row.id)).toEqual(["ren_01"]);
    expect(atRisk(rows, 30).map((row) => row.id)).toEqual(["ren_01", "ren_02"]);
    expect(HIGH_RISK_FLOOR).toBe(65);
  });

  it("colours risk in three bands and leaves an unscored renewal plain", () => {
    expect([riskTone(null), riskTone(50), riskTone(70), riskTone(90)]).toEqual([
      "neutral",
      "success",
      "warning",
      "danger"
    ]);
  });

  it("hides the offer on a do-not-contact renewal and on anything already decided", () => {
    expect(canOffer(renewal)).toBe(true);
    expect(canOffer({ ...renewal, strategy: "do_not_contact" })).toBe(false);
    expect(canOffer({ ...renewal, state: "offered" })).toBe(false);
    expect(canResolve({ ...renewal, state: "offered" })).toBe(true);
    expect(canResolve({ ...renewal, state: "accepted" })).toBe(false);
  });

  it("leads with the risky head of the queue over a plain queue count", () => {
    const l = saveLabelsIn("en");
    expect(saveHeadline(2, 5, l)).toBe(l("headlineRisk", { n: "2" }));
    expect(saveHeadline(0, 5, l)).toBe(l("headlineQueue", { n: "5" }));
    expect(saveHeadline(0, 0, l)).toBe(l("headlineClear"));
  });
});

describe("the save desk loader", () => {
  it("splits the queue by state and folds the settled column together", async () => {
    stubApi([
      ["/v1/me", me(ORBIT.renewals, ORBIT.renewalsWrite)],
      ["state=scheduled", json({ data: [renewal], total: 3 })],
      ["state=offered", json({ data: [{ ...renewal, id: "ren_02", state: "offered" }], total: 1 })],
      ["state=accepted", json({ data: [{ ...renewal, id: "ren_03", state: "accepted", decidedAt: 20 }] })],
      ["state=lost", json({ data: [{ ...renewal, id: "ren_04", state: "lost", decidedAt: 99 }] })]
    ]);
    const loaded = await saveLoader(args("https://web.test/orbit/save"));

    expect(loaded.may).toEqual({ read: true, write: true });
    expect(loaded.queue.total).toBe(3);
    expect(loaded.settled.map((row) => row.id)).toEqual(["ren_04", "ren_03"]);
    expect([loaded.savedCount, loaded.lostCount]).toEqual([1, 1]);
  });

  it("shows an empty desk with no write control when the reads are withheld", async () => {
    const calls = stubApi([["/v1/me", me()]]);
    const loaded = await saveLoader(args("https://web.test/orbit/save"));

    expect(loaded.may).toEqual({ read: false, write: false });
    expect(calls.filter((call) => call.url.includes("renewals"))).toHaveLength(0);
  });
});

describe("the save offer is consequential", () => {
  it("will not send an offer without the explicit confirmation", async () => {
    const calls = stubApi([["/v1/orbit/renewals/ren_01", json({ id: "ren_01" })]]);
    const out = await saveAction(args("https://web.test/orbit/save", form({ intent: "offer", id: "ren_01" })));

    expect(out.problem?.title).toBe("confirm_missing");
    expect(calls).toHaveLength(0);
  });

  it("sends the offer once confirmed, keyed so a double submit is one offer", async () => {
    const calls = stubApi([["/v1/orbit/renewals/ren_01", json({ id: "ren_01" })]]);
    const out = await saveAction(
      args("https://web.test/orbit/save", form({ intent: "offer", id: "ren_01", confirm: "on", nonce: "n2" }))
    );

    expect(out.saved).toBe("ren_01");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("n2");
    expect(JSON.parse(calls[0]?.body ?? "{}").state).toBe("offered");
  });

  it("surfaces the approval hold rather than pretending the offer went out", async () => {
    stubApi([["/v1/orbit/renewals/ren_01", problem("approval_required", 403)]]);
    const out = await saveAction(
      args("https://web.test/orbit/save", form({ intent: "offer", id: "ren_01", confirm: "on" }))
    );

    expect(out.saved).toBeNull();
    expect(out.problem?.title).toBe("approval_required");
  });

  it("only accepts the outcomes and strategies the API's transition table allows", async () => {
    const calls = stubApi([["/v1/orbit/renewals/ren_01", json({ id: "ren_01" })]]);

    expect((await saveAction(args("https://web.test/orbit/save", form({ intent: "nope", id: "ren_01" })))).problem?.title).toBe(
      "unknown_intent"
    );
    expect((await saveAction(args("https://web.test/orbit/save", form({ intent: "offer" })))).problem?.title).toBe(
      "missing_renewal"
    );
    expect(
      (await saveAction(args("https://web.test/orbit/save", form({ intent: "resolve", id: "ren_01", state: "offered" }))))
        .problem?.title
    ).toBe("bad_resolution");
    expect(
      (await saveAction(args("https://web.test/orbit/save", form({ intent: "strategy", id: "ren_01", strategy: "guess" }))))
        .problem?.title
    ).toBe("bad_strategy");
    expect(calls).toHaveLength(0);
  });

  it("records the outcome reason with the decision", async () => {
    const calls = stubApi([["/v1/orbit/renewals/ren_01", json({ id: "ren_01" })]]);
    await saveAction(
      args("https://web.test/orbit/save", form({ intent: "resolve", id: "ren_01", state: "lost", reason: "competitor" }))
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");

    expect(body.state).toBe("lost");
    expect(body.outcomeReason).toBe("competitor");
    expect(body.decidedAt).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- pipeline */

describe("days to expiry", () => {
  const now = 1_700_000_000_000;

  it("counts whole days and goes negative once expired", () => {
    expect(daysUntil(now + 3 * 86_400_000, now)).toBe(3);
    expect(daysUntil(now - 86_400_000, now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
  });

  it("sorts a renewal into gone, now, soon or later", () => {
    expect(urgency(null)).toBe("later");
    expect(urgency(-1)).toBe("gone");
    expect(urgency(0)).toBe("now");
    expect(urgency(40)).toBe("later");
  });

  it("leads with what is overdue over what is soon over a plain open count", () => {
    const l = pipelineLabelsIn("en");
    expect(pipelineHeadline(2, 3, 10, l)).toBe(l("headlineOverdue", { n: "2" }));
    expect(pipelineHeadline(0, 3, 10, l)).toBe(l("headlineSoon", { n: "3" }));
    expect(pipelineHeadline(0, 0, 10, l)).toBe(l("headlineOpen", { n: "10" }));
    expect(pipelineHeadline(0, 0, 0, l)).toBe(l("headlineClear"));
  });
});

describe("the pipeline board", () => {
  it("asks for one column per stage, oldest expiry first", async () => {
    const calls = stubApi([
      ["/v1/me", me(ORBIT.renewals, ORBIT.renewalsWrite)],
      ["/v1/orbit/renewals?state=", json({ data: [renewal], total: 1 })]
    ]);
    const loaded = await pipelineLoader(args("https://web.test/orbit/pipeline"));

    expect(Object.keys(loaded.board)).toEqual([...STAGES]);
    expect(calls.filter((call) => call.url.includes("sort=expiryAt&order=asc"))).toHaveLength(STAGES.length);
    expect(loaded.may.sweep).toBe(true);
  });

  it("hides the sweep from an actor who cannot write", async () => {
    stubApi([
      ["/v1/me", me(ORBIT.renewals)],
      ["/v1/orbit/renewals?state=", json({ data: [], total: 0 })]
    ]);
    const loaded = await pipelineLoader(args("https://web.test/orbit/pipeline"));

    expect(loaded.may).toEqual({ read: true, sweep: false });
  });

  it("reports how many renewals a sweep raised, and refuses any other intent", async () => {
    const calls = stubApi([["/v1/orbit/renewals/sweep", json({ raised: 7 })]]);

    expect(await sweepAction(args("https://web.test/orbit/pipeline", form({ intent: "sweep", nonce: "n3" })))).toEqual({
      problem: null,
      raised: 7
    });
    expect(calls[0]?.headers.get("idempotency-key")).toBe("n3");
    expect((await sweepAction(args("https://web.test/orbit/pipeline", form({ intent: "wipe" })))).problem?.title).toBe(
      "unknown_intent"
    );
    expect(calls).toHaveLength(1);
  });
});

/* --------------------------------------------------------- journey builder */

const graph: JourneyGraph = {
  nodes: [
    { key: "start", type: "trigger" },
    { key: "nudge", type: "send" }
  ],
  edges: [{ from: "start", to: "nudge" }],
  cooldownDays: 7
};

const journey: Journey = {
  id: "jny_01",
  key: "winback",
  version: 1,
  nameJson: '{"en":"Win back","ar":"استعادة"}',
  graphJson: graph,
  status: "draft",
  createdBy: "usr_01",
  createdAt: 1
};

describe("the journey builder loader", () => {
  it("returns the journey, its graph and the tenant slug for the portal links", async () => {
    stubApi([
      ["/v1/me", me(ORBIT.journeysWrite, ORBIT.runs)],
      ["/v1/orbit/journeys/jny_01", json(journey)],
      ["journey-runs", json({ data: [] })]
    ]);
    const loaded = await journeyLoader(args("https://web.test/orbit/journeys/jny_01", undefined, { id: "jny_01" }));

    expect(loaded.journey).toEqual(journey);
    expect(loaded.graph.nodes).toHaveLength(2);
    expect(loaded.tenantSlug).toBe("t");
  });
});

describe("orbitPortals", () => {
  it("builds the three general-purpose portal paths for a tenant slug", () => {
    expect(orbitPortals("acme")).toEqual([
      { key: "storefront", path: "/portal/acme" },
      { key: "register", path: "/portal/acme/register" },
      { key: "partners", path: "/portal/acme/partners" }
    ]);
  });
});

describe("editing a journey graph", () => {
  it("reads a graph whether the column came back as an object or a string", () => {
    expect(readGraph(graph).nodes).toHaveLength(2);
    expect(readGraph(JSON.stringify(graph)).cooldownDays).toBe(7);
    expect(readGraph("not json")).toEqual({ nodes: [], edges: [] });
    expect(readGraph(null)).toEqual({ nodes: [], edges: [] });
  });

  it("adds a step only with a usable key and a known type", () => {
    expect(mutate(graph, "add-step", { key: "Bad Key", type: "send" })).toEqual({ code: "bad_key" });
    expect(mutate(graph, "add-step", { key: "ok", type: "teleport" })).toEqual({ code: "bad_type" });
    expect(mutate(graph, "add-step", { key: "nudge", type: "send" })).toEqual({ code: "duplicate_key" });
    const out = mutate(graph, "add-step", { key: "wait2", type: "wait" });
    expect("graph" in out && out.graph.nodes).toHaveLength(3);
  });

  it("keeps one trigger so where a run starts is never arbitrary", () => {
    expect(mutate(graph, "add-step", { key: "other", type: "trigger" })).toEqual({ code: "second_trigger" });
    expect(startsAt(graph)).toBe("nudge");
    expect(startsAt({ nodes: [{ key: "solo", type: "send" }], edges: [] })).toBe("solo");
    expect(startsAt({ nodes: [], edges: [] })).toBeNull();
  });

  it("takes a removed step's edges with it", () => {
    const out = mutate(graph, "remove-step", { key: "nudge" });
    expect("graph" in out && out.graph.edges).toEqual([]);
    expect(mutate(graph, "remove-step", { key: "ghost" })).toEqual({ code: "no_such_step" });
  });

  it("refuses a self link, a repeat link and a link to a step that is not there", () => {
    expect(mutate(graph, "link", { from: "start", to: "start" })).toEqual({ code: "self_link" });
    expect(mutate(graph, "link", { from: "start", to: "nudge" })).toEqual({ code: "duplicate_edge" });
    expect(mutate(graph, "link", { from: "start", to: "ghost" })).toEqual({ code: "no_such_step" });
    const out = mutate(graph, "unlink", { from: "start", to: "nudge" });
    expect("graph" in out && out.graph.edges).toEqual([]);
  });

  it("holds the cooldown to whole days inside a year", () => {
    for (const days of ["0", "-3", "366", "1.5", ""]) {
      expect(mutate(graph, "cooldown", { cooldownDays: days }), days).toEqual({ code: "bad_cooldown" });
    }
    const out = mutate(graph, "cooldown", { cooldownDays: "14" });
    expect("graph" in out && out.graph.cooldownDays).toBe(14);
  });

  it("names an unknown intent rather than guessing", () => {
    expect(mutate(graph, "reticulate", {})).toEqual({ code: "unknown_intent" });
  });

  it("lists what stops a journey going live", () => {
    expect(blockers(graph)).toEqual([]);
    expect(blockers({ ...graph, cooldownDays: 0 })).toContain("needsCooldown");
    expect(blockers({ nodes: [], edges: [], cooldownDays: 7 })).toEqual(["needsSteps", "needsTrigger"]);
    expect(
      blockers({
        nodes: [...graph.nodes, { key: "orphan", type: "send" }],
        edges: graph.edges,
        cooldownDays: 7
      })
    ).toEqual(["hasOrphan"]);
  });

  it("names a journey in the reader's locale, falling back to the key", () => {
    expect(nameOf(journey, "ar")).toBe("استعادة");
    expect(nameOf(journey, "fr")).toBe("Win back");
    expect(nameOf({ ...journey, nameJson: null } as Journey, "en")).toBe("winback");
  });

  it("says a journey has no start before it says it is blocked before the generic lede", () => {
    const l = journeyLabelsIn("en");
    expect(journeyLede(2, false, l)).toBe(l("startsNowhere"));
    expect(journeyLede(2, true, l)).toBe(l("ledeBlocked", { n: "2" }));
    expect(journeyLede(0, true, l)).toBe(l("lede"));
  });
});

describe("the journey builder action", () => {
  it("re-reads the graph before writing so two operators do not overwrite each other", async () => {
    const calls = stubApi([["/v1/orbit/journeys/jny_01", json(journey)]]);
    const out = await journeyAction(
      args("https://web.test/orbit/journeys/jny_01/builder", form({ intent: "add-step", key: "wait2", type: "wait", nonce: "n4" }), {
        id: "jny_01"
      })
    );

    expect(out.saved).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    const written = JSON.parse(calls[1]?.body ?? "{}");
    expect(written.graphJson.nodes).toHaveLength(3);
    expect(calls[1]?.headers.get("idempotency-key")).toBe("n4");
  });

  it("hands a mutate refusal back as a label key without writing", async () => {
    const calls = stubApi([["/v1/orbit/journeys/jny_01", json(journey)]]);
    const out = await journeyAction(
      args("https://web.test/orbit/journeys/jny_01/builder", form({ intent: "add-step", key: "nudge", type: "send" }), {
        id: "jny_01"
      })
    );

    expect(out).toMatchObject({ error: "duplicate_key", saved: false });
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("will not activate a journey that is not ready", async () => {
    const half = { ...journey, graphJson: { nodes: [], edges: [] } };
    const calls = stubApi([["/v1/orbit/journeys/jny_01", json(half)]]);
    const out = await journeyAction(
      args("https://web.test/orbit/journeys/jny_01/builder", form({ intent: "status", status: "active" }), { id: "jny_01" })
    );

    expect(out.error).toBe("cannot_activate");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("activates a ready journey and pauses one without re-checking", async () => {
    const calls = stubApi([["/v1/orbit/journeys/jny_01", json(journey)]]);

    expect((await journeyAction(args("https://web.test/orbit/j", form({ intent: "status", status: "active" }), { id: "jny_01" }))).saved).toBe(
      true
    );
    expect((await journeyAction(args("https://web.test/orbit/j", form({ intent: "status", status: "paused" }), { id: "jny_01" }))).saved).toBe(
      true
    );
    expect((await journeyAction(args("https://web.test/orbit/j", form({ intent: "status", status: "sideways" }), { id: "jny_01" }))).error).toBe(
      "bad_status"
    );
    expect((await journeyAction(args("https://web.test/orbit/j", form({ intent: "explode" }), { id: "jny_01" }))).error).toBe(
      "unknown_intent"
    );
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
  });

  it("turns a withheld write into a notice", async () => {
    stubApi([["/v1/orbit/journeys/jny_01", problem("forbidden", 403)]]);
    const out = await journeyAction(
      args("https://web.test/orbit/j", form({ intent: "status", status: "paused" }), { id: "jny_01" })
    );

    expect(out.problem?.status).toBe(403);
    expect(out.saved).toBe(false);
  });
});

/* ----------------------------------------------------------------- quality */

const score: QaScore = {
  id: "qa_01",
  conversationId: "cnv_01",
  rubricKey: "orbit.default",
  score: 74,
  breakdownJson: { tone: 9, accuracy: 7 },
  flagsJson: ["missed_disclosure"],
  scoredBy: "agent:orbit-qa",
  disputedBy: null,
  ts: 1_700_000_000
};

describe("reading an AI score", () => {
  it("tells an agent's score from a reviewer's, which is what earns the ✦ marker", () => {
    expect(isAgentScored(score)).toBe(true);
    expect(isAgentScored({ ...score, scoredBy: "user:usr_01" })).toBe(false);
    expect(isAgentScored({ ...score, scoredBy: null })).toBe(false);
  });

  it("unpacks the why whether the column arrived hydrated or as text", () => {
    expect(breakdownOf(score.breakdownJson)).toEqual([
      ["tone", "9"],
      ["accuracy", "7"]
    ]);
    expect(breakdownOf('{"tone":9}')).toEqual([["tone", "9"]]);
    expect(breakdownOf("not json")).toEqual([]);
    expect(breakdownOf(null)).toEqual([]);
  });

  it("reads flags from a list or from a map of switches", () => {
    expect(flagsOf(["a", "b"])).toEqual(["a", "b"]);
    expect(flagsOf({ pii: true, rude: false })).toEqual(["pii"]);
    expect(flagsOf('["x"]')).toEqual(["x"]);
    expect(flagsOf(42)).toEqual([]);
  });

  it("averages the sampled scores", () => {
    expect(mean([score, { ...score, score: 76 }])).toBe(75);
    expect(mean([])).toBe(0);
  });

  it("leads with what is flagged, else the running average, else nothing scored yet", () => {
    const l = qualityLabelsIn("en");
    expect(qualityHeadline(2, 70, 10, l)).toBe(l("headlineFlagged", { n: "2" }));
    expect(qualityHeadline(0, 70, 10, l)).toBe(l("headlineClean", { n: "70" }));
    expect(qualityHeadline(0, 0, 0, l)).toBe(l("headlineNone"));
  });
});

describe("a reviewer's correction", () => {
  it("names exactly what is missing before spending a round trip", () => {
    expect(checkScore({ conversationId: "", rubricKey: "a", score: "1" })).toBe("needConversation");
    expect(checkScore({ conversationId: "c", rubricKey: "Bad Key", score: "1" })).toBe("needRubric");
    expect(checkScore({ conversationId: "c", rubricKey: "orbit.default", score: "101" })).toBe("needScore");
    expect(checkScore({ conversationId: "c", rubricKey: "orbit.default", score: "7.5" })).toBe("needScore");
    expect(checkScore({ conversationId: "c", rubricKey: "orbit.default", score: "-1" })).toBe("needScore");
    expect(checkScore({ conversationId: "c", rubricKey: "orbit.default", score: "0" })).toBeNull();
  });

  it("posts a new score row that points at the one it disagrees with", async () => {
    const calls = stubApi([["/v1/orbit/qa-scores", json({ id: "qa_02" })]]);
    const out = await scoreAction(
      args(
        "https://web.test/orbit/quality",
        form({
          intent: "score",
          conversationId: "cnv_01",
          rubricKey: "orbit.default",
          score: "88",
          correctionOf: "qa_01",
          reason: "agent misread the tone",
          nonce: "n5"
        })
      )
    );

    expect(out.saved).toBe(true);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.score).toBe(88);
    expect(body.breakdownJson).toEqual({
      source: "reviewer",
      correctionOf: "qa_01",
      note: "agent misread the tone"
    });
    // scoredBy is an actor column — the screen must never try to set it.
    expect(body.scoredBy).toBeUndefined();
    expect(calls[0]?.headers.get("idempotency-key")).toBe("n5");
  });

  it("refuses an unknown intent and a bad score without posting", async () => {
    const calls = stubApi([["/v1/orbit/qa-scores", json({ id: "qa_02" })]]);

    expect((await scoreAction(args("https://web.test/orbit/quality", form({ intent: "delete" })))).error).toBe(
      "unknownIntent"
    );
    expect(
      (await scoreAction(args("https://web.test/orbit/quality", form({ intent: "score", conversationId: "c", rubricKey: "r", score: "999" }))))
        .error
    ).toBe("needScore");
    expect(calls).toHaveLength(0);
  });

  it("turns a withheld scoring permission into a notice", async () => {
    stubApi([["/v1/orbit/qa-scores", problem("forbidden", 403)]]);
    const out = await scoreAction(
      args("https://web.test/orbit/quality", form({ intent: "score", conversationId: "c", rubricKey: "r", score: "50" }))
    );

    expect(out.problem?.status).toBe(403);
    expect(out.saved).toBe(false);
  });
});

describe("the quality loader", () => {
  it("reads the latest scores plus a closed sample, and passes a rubric filter through", async () => {
    const calls = stubApi([
      ["/v1/me", me(ORBIT.qa, ORBIT.qaScore, ORBIT.conversations)],
      ["qa-scores", json({ data: [score], total: 1 })],
      ["state=closed", json({ data: [{ id: "cnv_02" }] })]
    ]);
    const loaded = await qualityLoader(args("https://web.test/orbit/quality?rubric=orbit.default"));

    expect(loaded.may).toEqual({ read: true, score: true });
    expect(loaded.rubric).toBe("orbit.default");
    expect(loaded.sample).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("rubricKey=orbit.default"))).toBe(true);
  });

  it("shows nothing and hides the scoring form when both reads are withheld", async () => {
    const calls = stubApi([["/v1/me", me()]]);
    const loaded = await qualityLoader(args("https://web.test/orbit/quality"));

    expect(loaded.may).toEqual({ read: false, score: false });
    expect(loaded.scores.data).toEqual([]);
    expect(calls.filter((call) => call.url.includes("/v1/orbit/"))).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- analytics */

describe("the derived analytics figures", () => {
  it("reads containment as everything the agent did not hand over", () => {
    expect(containment(100, 20)).toBeCloseTo(0.8);
    expect(containment(0, 0)).toBeNull();
    // More handovers than conversations (one conversation handed over twice)
    // floors at zero rather than reading as a negative share.
    expect(containment(10, 25)).toBe(0);
  });

  it("returns nothing rather than zero when there is nothing to divide", () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(0, 0)).toBeNull();
    expect(meanOf([])).toBeNull();
    expect(meanOf([4, null, undefined, 6])).toBe(5);
  });

  it("only accepts the windows the screen offers", () => {
    expect(windowDays("7")).toBe(7);
    expect(windowDays("90")).toBe(90);
    expect(windowDays("4000")).toBe(30);
    expect(windowDays(null)).toBe(30);
  });

  it("leads with the containment rate for the window, or says there is no data", () => {
    const l = analyticsLabelsIn("en");
    expect(analyticsHeadline(0.8, 30, l)).toBe(l("headlineContainment", { n: "80", days: "30" }));
    expect(analyticsHeadline(null, 7, l)).toBe(l("headlineNoData", { n: "7" }));
  });

  it("builds one definition the run and the export both use", () => {
    const both = definitionOf({ dimension: "channel", grain: "month", from: 1, to: 2 });
    expect(both).toMatchObject({
      dataset: "conversations",
      metrics: ["conversations"],
      dimensions: ["channel"],
      grain: "month",
      from: 1,
      to: 2
    });
    expect(definitionOf({ dimension: "state", grain: "none", from: 1, to: 2 })).not.toHaveProperty("grain");
  });
});

describe("the analytics loader", () => {
  it("counts each figure over the chosen window and derives the rates", async () => {
    const calls = stubApi([
      ["/v1/me", me(ORBIT.conversations, ORBIT.handovers, ORBIT.renewals, ORBIT.qa, ORBIT.reportRun, ORBIT.exportCreate)],
      ["conversations?state=closed", json({ data: [{ csat: 4 }, { csat: null }, { csat: 5 }] })],
      ["conversations?sort=createdAt", json({ data: [], total: 100 })],
      ["handover-notes", json({ data: [], total: 25 })],
      ["renewals?state=accepted", json({ data: [], total: 30 })],
      ["renewals?state=lost", json({ data: [], total: 10 })],
      ["qa-scores", json({ data: [{ score: 70 }, { score: 90 }] })]
    ]);
    const loaded = await analyticsLoader(args("https://web.test/orbit/analytics?days=7"));

    expect(loaded.days).toBe(7);
    expect(loaded.containment).toBeCloseTo(0.75);
    expect(loaded.handoverRate).toBeCloseTo(0.25);
    expect(loaded.retention).toBeCloseTo(0.75);
    expect(loaded.csat).toBe(4.5);
    expect(loaded.quality).toBe(80);
    expect(loaded.may).toEqual({ run: true, export: true });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("leaves every figure blank rather than zero when the reads are withheld", async () => {
    stubApi([["/v1/me", me()]]);
    const loaded = await analyticsLoader(args("https://web.test/orbit/analytics"));

    expect(loaded.containment).toBeNull();
    expect(loaded.csat).toBeNull();
    expect(loaded.retention).toBeNull();
    expect(loaded.may).toEqual({ run: false, export: false });
  });
});

describe("running and exporting a report", () => {
  it("runs the shared definition through the reporting engine", async () => {
    const calls = stubApi([["/v1/analytics/run", json({ runId: "rr_01", columns: [], rows: [] })]]);
    const out = await analyticsAction(
      args("https://web.test/orbit/analytics", form({ intent: "run", dimension: "channel", grain: "day", days: "7" }))
    );

    expect(out.table?.runId).toBe("rr_01");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ dimensions: ["channel"], grain: "day" });
  });

  it("exports through the platform renderer with totals and an idempotency key", async () => {
    const calls = stubApi([["/v1/analytics/exports", json({ id: "exp_01", format: "xlsx" })]]);
    const out = await analyticsAction(
      args(
        "https://web.test/orbit/analytics",
        form({ intent: "export", dimension: "state", grain: "none", format: "xlsx", days: "30", nonce: "n6" })
      )
    );

    expect(out.exported?.id).toBe("exp_01");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toMatchObject({ format: "xlsx", totals: true });
    expect(body.definition.dataset).toBe("conversations");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("n6");
  });

  it("refuses an unknown intent, dimension, grain or format without a round trip", async () => {
    const calls = stubApi([
      ["/v1/analytics/run", json({ runId: "rr_01" })],
      ["/v1/analytics/exports", json({ id: "exp_01" })]
    ]);
    const bad = (fields: Record<string, string>) => analyticsAction(args("https://web.test/orbit/analytics", form(fields)));

    expect((await bad({ intent: "drop" })).error).toBe("unknownIntent");
    expect((await bad({ intent: "run", dimension: "premium" })).error).toBe("badDimension");
    expect((await bad({ intent: "run", dimension: "channel", grain: "fortnight" })).error).toBe("badGrain");
    expect((await bad({ intent: "export", dimension: "channel", grain: "none", format: "docx" })).error).toBe("badFormat");
    expect(calls).toHaveLength(0);
  });

  it("turns a withheld run permission into a notice", async () => {
    stubApi([["/v1/analytics/run", problem("forbidden", 403)]]);
    const out = await analyticsAction(
      args("https://web.test/orbit/analytics", form({ intent: "run", dimension: "channel", grain: "none" }))
    );

    expect(out.problem?.status).toBe(403);
    expect(out.table).toBeNull();
  });
});

/* ------------------------------------------------------------- hero figures */

// A hero figure with a drill-down promises that clicking it shows the rows it
// counted — so the figure and the list have to come out of one predicate over
// one array (components/hero.tsx). These pin each screen's lens against the
// rule its label states, and against the split lists the screen actually
// renders: a lens that drifts from the label is a hero that lies.

describe("the console's waiting door", () => {
  it("counts across both queues exactly what the two tables then list", () => {
    const now = live.lastMessageAt! + SLOW_MS;
    const bot = [live, { ...live, id: "cnv_02", lastMessageAt: now }];
    const human = [{ ...live, id: "cnv_03", state: "human" as const, lastMessageAt: null }];
    const lenses = consoleLenses(now);

    const figure = lensOf([...bot, ...human], lenses, "waiting").length;
    expect(figure).toBe([...bot, ...human].filter((row) => waitingMs(row, now) >= SLOW_MS).length);
    expect(lensOf(bot, lenses, "waiting").length + lensOf(human, lenses, "waiting").length).toBe(figure);
  });
});

describe("the pipeline's expiry doors", () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  const scheduled = [
    { ...renewal, id: "ren_soon", expiryAt: now + 3 * day },
    { ...renewal, id: "ren_far", expiryAt: now + 60 * day }
  ];
  const offered = [{ ...renewal, id: "ren_gone", state: "offered" as const, expiryAt: now - day }];
  const lenses = pipelineLenses(now);

  it("counts each urgency exactly as the two open columns then list it", () => {
    for (const [lens, band] of [
      ["soon", "now"],
      ["overdue", "gone"]
    ] as const) {
      const open = [...scheduled, ...offered];
      const figure = lensOf(open, lenses, lens).length;
      expect(figure).toBe(open.filter((row) => urgency(daysUntil(row.expiryAt, now)) === band).length);
      expect(figure).toBe(1);
      expect(lensOf(scheduled, lenses, lens).length + lensOf(offered, lenses, lens).length).toBe(figure);
    }
  });
});

describe("the quality desk's doors", () => {
  const rows = [score, { ...score, id: "qa_02", score: 41 }, { ...score, id: "qa_03", scoredBy: "user:usr_01" }];

  it("counts flagged scores exactly as the table then lists them", () => {
    const shown = lensOf(rows, qualityLenses, "flagged");
    expect(shown.map((row) => row.id)).toEqual(["qa_02"]);
    expect(shown.length).toBe(rows.filter((row) => row.score < 60).length);
  });

  it("counts reviewer corrections exactly as the table then lists them", () => {
    const shown = lensOf(rows, qualityLenses, "corrections");
    expect(shown.map((row) => row.id)).toEqual(["qa_03"]);
    expect(shown.length).toBe(rows.filter((row) => !isAgentScored(row)).length);
  });
});

describe("the save desk's risk door", () => {
  it("counts the high-risk head exactly as the queue then lists it", () => {
    const rows = [
      renewal,
      { ...renewal, id: "ren_02", churnScore: HIGH_RISK_FLOOR - 1 },
      { ...renewal, id: "ren_03", churnScore: null }
    ];

    expect(lensOf(rows, saveLenses, "risk")).toEqual(atRisk(rows));
    expect(lensOf(rows, saveLenses, "risk").map((row) => row.id)).toEqual(["ren_01"]);
  });
});

/**
 * `safe()` decides which API refusals become an empty panel and which become a
 * crash, and the allowlist form of that decision is dead seam 8 (a 400 reaching
 * React Router as an HTTP 500 on every /north/explorer request). It swallowed
 * 403 alone while crud.ts:83 states "A hidden row is 404, never 403", so every
 * by-id read behind it crashed on the status the API deliberately sends.
 */
describe("what safe() swallows", () => {
  const refuse = <T,>(status: number, fallback: T) =>
    safe<T>(() => Promise.reject(new ApiError({ title: "no", status }, null)), fallback);

  it("renders the fallback for a row that is missing or not this tenant's", async () => {
    await expect(refuse(404, null)).resolves.toBeNull();
  });

  it("renders the fallback for a refused read and a rejected query alike", async () => {
    await expect(refuse(403, null)).resolves.toBeNull();
    await expect(refuse(400, null)).resolves.toBeNull();
    await expect(refuse(422, null)).resolves.toBeNull();
  });

  it("rethrows 401 so a signed-out reader still gets the login redirect", async () => {
    await expect(refuse(401, null)).rejects.toBeInstanceOf(ApiError);
  });

  it("rethrows a server fault — the server failing is not the server saying no", async () => {
    await expect(refuse(500, null)).rejects.toBeInstanceOf(ApiError);
  });

  it("leaves a non-ApiError alone", async () => {
    await expect(safe(() => Promise.reject(new TypeError("boom")), null)).rejects.toBeInstanceOf(TypeError);
  });
});
