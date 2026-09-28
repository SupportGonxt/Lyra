import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  LABEL_KEYS,
  aeoCoverage,
  audienceValue,
  cacMinor,
  canLaunch,
  cohorts,
  explain,
  isReversible,
  labelsIn,
  ltvToCac,
  channelLabel,
  windowDays,
  type AeoRow,
  type AudienceRow,
  type CampaignRow,
  type CreativeRow,
  type MoveRow,
  type SpendRow,
  type TouchRow
} from "./signal.shared";
import { action as cockpitAction, loader as cockpitLoader } from "./signal-cockpit";
import { cacRange } from "@lyra/core/attribution-range";
import { action as studioAction } from "./signal-studio";
import { action as budgetAction } from "./signal-budget";
import { action as analyticsAction } from "./signal-analytics";
import { action as aeoAction } from "./signal-answer-engines";

// The six bespoke SIGNAL screens. Three of them spend money — launching a
// campaign, widening what the autopilot may move, undoing a move — so what is
// asserted here is that each refusal happens before the API is called, that the
// consequential writes carry an idempotency key, and that a 403 asking for an
// approver arrives as a Problem the screen can render rather than an exception.
// The derivations are checked separately because CAC, LTV and cohorts have no
// endpoint: these screens are the only place those numbers exist.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...replies: Response[]) {
  const calls: Array<{ url: string; method: string; body: string | null; key: string | null }> = [];
  let at = 0;
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      key: headers.get("idempotency-key")
    });
    const reply = replies[Math.min(at, replies.length - 1)] ?? new Response(null, { status: 204 });
    at += 1;
    return Promise.resolve(reply.clone());
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An action call without a worker: only `context.get(cloudflare)` is read. */
function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/signal", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};

/* ------------------------------------------------------------------ fixtures */

const spendRow = (over: Partial<SpendRow> = {}): SpendRow => ({
  id: "sp_1",
  campaignId: "cmp_1",
  channel: "meta",
  day: "2026-07-01",
  amountMinor: 100_000,
  currency: "ZAR",
  impressions: 10_000,
  clicks: 500,
  conversions: 10,
  source: "api",
  ts: 1_770_000_000_000,
  ...over
});

const touchRow = (over: Partial<TouchRow> = {}): TouchRow => ({
  id: "tp_1",
  customerId: "cus_1",
  anonId: null,
  touchType: "bind",
  channel: "meta",
  campaignId: "cmp_1",
  creativeId: null,
  valueMinor: 500_000,
  currency: "ZAR",
  subjectRef: null,
  ts: 1_770_000_000_000,
  ...over
});

const campaignRow = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: "cmp_1",
  name: "Winter push",
  objective: "acq",
  audienceId: "aud_1",
  channelsJson: ["meta"],
  budgetJson: { dailyMinor: 100_000, currency: "ZAR", capMinor: 3_000_000 },
  state: "draft",
  autonomyLevel: "act_with_approval",
  startAt: null,
  endAt: null,
  ownerRef: "usr_1",
  ...over
});

const creativeRow = (over: Partial<CreativeRow> = {}): CreativeRow => ({
  id: "crv_1",
  campaignId: "cmp_1",
  kind: "ad",
  locale: "en",
  contentRef: "Two weeks left.",
  variantGroup: "vg_1",
  complianceStatus: "passed",
  complianceNotesJson: null,
  performanceJson: null,
  generatedBy: "ai",
  aiAuditId: "aud_9",
  createdAt: 1_770_000_000_000,
  ...over
});

const moveRow = (over: Partial<MoveRow> = {}): MoveRow => ({
  id: "mv_1",
  fromRef: "cmp_1:google",
  toRef: "cmp_1:meta",
  amountMinor: 25_000,
  currency: "ZAR",
  reason: "cheaper acquisition on meta",
  evidenceJson: null,
  approvedBy: null,
  reversedBy: null,
  reversedAt: null,
  reversibleUntil: 1_770_100_000_000,
  ts: 1_770_000_000_000,
  ...over
});

const aeoRow = (over: Partial<AeoRow> = {}): AeoRow => ({
  id: "aeo_1",
  queryCluster: "what does cover cost",
  locale: "en",
  contentRef: "page-1",
  citationsCheckJson: null,
  freshness: 1_770_000_000_000,
  citedByJson: ["perplexity"],
  status: "published",
  updatedAt: 1_770_000_000_000,
  ...over
});

const audienceRow = (over: Partial<AudienceRow> = {}): AudienceRow => ({
  id: "aud_1",
  name: "Renewals due",
  definitionJson: {},
  sizeCached: 1_000,
  refreshPolicy: "daily",
  consentPurposes: null,
  lastRefreshedAt: null,
  ...over
});

/* -------------------------------------------------------------------- labels */

describe("labelsIn", () => {
  it("answers every key in both languages, so no screen falls back to a key", () => {
    const en = Object.keys(LABEL_KEYS.en!);
    const ar = Object.keys(LABEL_KEYS.ar!);

    expect(new Set(ar)).toEqual(new Set(en));
  });

  it("translates rather than copying — an untranslated string is a bug, not a label", () => {
    const l = labelsIn("ar");
    const copied = Object.keys(LABEL_KEYS.en!).filter((key) => LABEL_KEYS.ar![key] === LABEL_KEYS.en![key]);

    expect(copied).toEqual([]);
    expect(l("cockpit.title")).not.toBe(LABEL_KEYS.en!["cockpit.title"]);
  });

  it("interpolates, and renders an unknown key as itself rather than as nothing", () => {
    const l = labelsIn("en");

    expect(l("days", { n: "7" })).toBe("7 days");
    expect(l("no.such.key")).toBe("no.such.key");
  });
});

describe("explain", () => {
  it("puts a sentence in front of a code this screen owns, keeping the code for the log", () => {
    const l = labelsIn("en");
    const explained = explain({ title: "bound_over_daily", status: 400, code: "bound_over_daily" }, l);

    expect(explained.title).toBe("The per-move ceiling cannot exceed the daily budget.");
    expect(explained.code).toBe("bound_over_daily");
  });

  it("leaves an API problem's own title alone", () => {
    const problem = { title: "Approval required", status: 403, code: "approval_required" };

    expect(explain(problem, labelsIn("en"))).toEqual(problem);
  });
});

/* --------------------------------------------------------------- derivations */

describe("cost and value", () => {
  it("withholds a CAC when nothing converted, because zero would read as free", () => {
    expect(cacMinor(500_000, 0)).toBeNull();
    expect(cacMinor(500_000, 4)).toBe(125_000);
  });

  it("withholds the multiple when either side is missing or the cost is zero", () => {
    expect(ltvToCac(500_000, null)).toBeNull();
    expect(ltvToCac(null, 100_000)).toBeNull();
    expect(ltvToCac(500_000, 0)).toBeNull();
    expect(ltvToCac(500_000, 125_000)).toBe(4);
  });

  it("reads an unoffered window as a month", () => {
    expect(windowDays("7")).toBe(7);
    expect(windowDays("365")).toBe(30);
    expect(windowDays(null)).toBe(30);
  });
});

describe("cohorts", () => {
  it("dates a customer from their first bind and counts a later touch as a return", () => {
    const june = Date.UTC(2026, 5, 10);
    const july = Date.UTC(2026, 6, 10);
    const rolls = cohorts([
      touchRow({ id: "t1", customerId: "cus_1", ts: june }),
      touchRow({ id: "t2", customerId: "cus_1", touchType: "visit", ts: july }),
      touchRow({ id: "t3", customerId: "cus_2", ts: june }),
      // No customer, so no cohort: an anonymous bind cannot be followed.
      touchRow({ id: "t4", customerId: null, anonId: "anon_1", ts: june })
    ]);

    expect(rolls).toEqual([{ month: "2026-06", size: 2, retained: 1 }]);
  });

  // `monthOf` degrades an instant no `Date` can hold to an em dash so the growth
  // screen renders at all. An em dash sorts above every `YYYY-MM`, so comparing
  // it against a cohort start silently marked the customer retained — a wrong
  // number that looks right, which is worse than the crash it replaced. The
  // dash is for display; an unreadable touch is not evidence of anything.
  it("does not count a touch it cannot date as a return", () => {
    const june = Date.UTC(2026, 5, 10);
    const rolls = cohorts([
      touchRow({ id: "t1", customerId: "cus_1", ts: june }),
      touchRow({ id: "t2", customerId: "cus_1", touchType: "visit", ts: 9e15 })
    ]);

    expect(rolls).toEqual([{ month: "2026-06", size: 1, retained: 0 }]);
  });

  it("does not date a cohort from a bind it cannot read", () => {
    const june = Date.UTC(2026, 5, 10);
    const rolls = cohorts([
      touchRow({ id: "t1", customerId: "cus_1", ts: 9e15 }),
      touchRow({ id: "t2", customerId: "cus_1", ts: june })
    ]);

    expect(rolls).toEqual([{ month: "2026-06", size: 1, retained: 0 }]);
  });
});

describe("aeoCoverage", () => {
  it("counts citation share against published pages, not against every draft", () => {
    const roll = aeoCoverage([
      aeoRow({ id: "a1", citedByJson: ["perplexity"] }),
      aeoRow({ id: "a2", queryCluster: "how do i claim", citedByJson: [] }),
      aeoRow({ id: "a3", queryCluster: "how do i claim", status: "draft", citedByJson: [] })
    ]);

    expect(roll).toEqual({ total: 3, published: 2, stale: 0, cited: 1, clusters: 2, citationSharePct: 50 });
  });

  it("reads a share of nothing as zero rather than dividing by it", () => {
    expect(aeoCoverage([]).citationSharePct).toBe(0);
  });
});

describe("audienceValue", () => {
  it("joins value and cost through the campaigns aimed at the audience", () => {
    const rows = audienceValue(
      [audienceRow(), audienceRow({ id: "aud_2", name: "Cold traffic", sizeCached: 0 })],
      [campaignRow()],
      [spendRow({ amountMinor: 250_000 })],
      [touchRow({ id: "t1" }), touchRow({ id: "t2", customerId: "cus_2" })]
    );

    expect(rows[0]).toMatchObject({
      binds: 2,
      spendMinor: 250_000,
      valueMinor: 1_000_000,
      cacMinor: 125_000,
      ltvMinor: 500_000,
      multiple: 4,
      conversionPct: 0.2
    });
    // An audience no campaign has aimed at is unmeasured, not worthless.
    expect(rows[1]).toMatchObject({ campaigns: 0, multiple: null, cacMinor: null, conversionPct: 0 });
  });
});

describe("canLaunch", () => {
  it("refuses a campaign with nothing compliance has cleared", () => {
    const campaign = campaignRow();

    expect(canLaunch(campaign, [creativeRow({ complianceStatus: "blocked" })])).toBe(false);
    expect(canLaunch(campaign, [creativeRow()])).toBe(true);
  });

  it("refuses a state the API would refuse anyway", () => {
    expect(canLaunch(campaignRow({ state: "ended" }), [creativeRow()])).toBe(false);
  });
});

describe("isReversible", () => {
  it("closes the window once it has passed or the move was already undone", () => {
    const now = 1_770_050_000_000;

    expect(isReversible(moveRow(), now)).toBe(true);
    expect(isReversible(moveRow({ reversibleUntil: now - 1 }), now)).toBe(false);
    expect(isReversible(moveRow({ reversedAt: now - 1 }), now)).toBe(false);
  });
});

/* ------------------------------------------------------------------- cockpit */

describe("cockpit action", () => {
  it("pauses the autopilot with an idempotency key, so a double click is one pause", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await cockpitAction(args(form({ intent: "pause", key: "signal-cockpit:k1" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/signal/autopilot/pause");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.key).toBe("signal-cockpit:k1");
    expect(result).toEqual({ problem: null, done: "pause", adjusted: null });
  });

  it("reports how many moves a manual pass made", async () => {
    stubFetch(json({ adjusted: [{ id: "mv_1" }, { id: "mv_2" }] }));

    expect(await cockpitAction(args(form({ intent: "run" })))).toEqual({
      problem: null,
      done: "run",
      adjusted: 2
    });
  });

  it("refuses an intent it does not have, without calling the API", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await cockpitAction(args(form({ intent: "delete-everything" })));

    expect(result.problem).toEqual({ title: "bad_intent", status: 400, code: "bad_intent" });
    expect(calls).toHaveLength(0);
  });
});

// docs/17 SIG-057, ADR-0109: the cockpit's CPA is the API's range, asked for
// the window and headline currency the screen shows — not a point the screen
// divided out of a 200-row page of touches.
describe("cockpit loader", () => {
  it("reads the acquisition range for the window, in the headline currency", async () => {
    const range = cacRange({ spendMinor: 100_000, conversions: 10 });
    const campaign = campaignRow({ state: "live" });
    const calls = stubFetch(json({ data: [campaign], spendMinor: 100_000, binds: 10, range }));
    const before = Date.now();

    const loaded = await cockpitLoader({
      request: new Request("https://web.test/signal/cockpit?days=30"),
      context: { get: () => ({ env, ctx: null }) },
      params: {}
    } as unknown as LoaderFunctionArgs);

    const asked = calls.find((call) => call.url.startsWith("https://api.test/v1/signal/attribution/range?"));
    expect(asked).toBeTruthy();
    const query = new URL(asked!.url).searchParams;
    expect(Number(query.get("since"))).toBeGreaterThanOrEqual(before - 30 * 86_400_000);
    expect(Number(query.get("since"))).toBeLessThanOrEqual(Date.now() - 30 * 86_400_000);
    expect(query.get("currency")).toBe(loaded.currency);
    expect(loaded.acquisition).toEqual(range);
  });

  it("shows no range, rather than crashing, when the reader may not see attribution", async () => {
    stubFetch(json({ title: "forbidden", status: 403 }, 403));
    const loaded = await cockpitLoader({
      request: new Request("https://web.test/signal/cockpit"),
      context: { get: () => ({ env, ctx: null }) },
      params: {}
    } as unknown as LoaderFunctionArgs);
    expect(loaded.acquisition).toBeNull();
  });
});

/* -------------------------------------------------------------------- studio */

describe("studio action", () => {
  it("refuses an incomplete campaign field by field, before any write", async () => {
    const calls = stubFetch(json(campaignRow()));
    const base = { intent: "create-campaign", name: "Winter push", objective: "acq", ownerRef: "usr_1" };

    expect((await studioAction(args(form({ ...base, name: "" })))).problem?.code).toBe("name_required");
    expect((await studioAction(args(form({ ...base, objective: "growth" })))).problem?.code).toBe(
      "objective_required"
    );
    expect((await studioAction(args(form({ ...base, ownerRef: "" })))).problem?.code).toBe("owner_required");
    expect((await studioAction(args(form({ ...base, channels: " , " })))).problem?.code).toBe("channels_required");
    expect((await studioAction(args(form({ ...base, channels: "meta" })))).problem?.code).toBe("budget_required");
    expect(calls).toHaveLength(0);
  });

  it("collects one entry per ticked channel box", async () => {
    // The form posts `channels` once per checkbox, not one comma-joined string.
    const calls = stubFetch(json(campaignRow({ id: "cmp_new" })));
    const body = new FormData();
    body.set("intent", "create-campaign");
    body.set("name", "Winter push");
    body.set("objective", "acq");
    body.set("ownerRef", "usr_1");
    body.append("channels", "google_search");
    body.append("channels", "meta");
    body.set("dailyMinor", "100000");

    await studioAction(args(body)).catch(() => undefined);

    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      channelsJson: ["google_search", "meta"]
    });
  });

  it("creates the draft then redirects, so a refresh cannot create a second campaign", async () => {
    const calls = stubFetch(json(campaignRow({ id: "cmp_new" })));
    const body = form({
      intent: "create-campaign",
      key: "signal-studio:k1",
      name: "Winter push",
      objective: "acq",
      ownerRef: "usr_1",
      channels: "meta, google",
      dailyMinor: "100000",
      boundMinor: "25000"
    });

    const thrown = await studioAction(args(body)).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe("/signal/studio?campaignId=cmp_new");
    expect(calls[0]?.key).toBe("signal-studio:k1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      channelsJson: ["meta", "google"],
      budgetJson: { dailyMinor: 100_000, currency: "ZAR", autopilotBoundMinor: 25_000 }
    });
  });

  it("generates content through the gateway-backed endpoint, never a provider", async () => {
    const calls = stubFetch(json({ variants: [{ id: "crv_1" }, { id: "crv_2" }] }));
    const body = form({
      intent: "generate",
      campaignId: "cmp_1",
      brief: "Two weeks left on the winter offer, warm and plain.",
      kind: "ad",
      count: "2"
    });
    body.append("locales", "en");
    body.append("locales", "ar");

    const thrown = await studioAction(args(body)).catch((error: unknown) => error);

    expect(calls[0]?.url).toBe("https://api.test/v1/signal/creatives/generate");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      campaignId: "cmp_1",
      kind: "ad",
      brief: "Two weeks left on the winter offer, warm and plain.",
      count: 2,
      locales: ["en", "ar"]
    });
    // The generated content is a draft on the next read, not something sent.
    expect((thrown as Response).headers.get("location")).toBe("/signal/studio?campaignId=cmp_1&generated=2");
  });

  it("refuses a brief too thin to draft from, and a kind the API does not have", async () => {
    const calls = stubFetch(json({ variants: [] }));

    expect((await studioAction(args(form({ intent: "generate", campaignId: "cmp_1", brief: "sell" })))).problem?.code)
      .toBe("brief_required");
    expect(
      (
        await studioAction(
          args(form({ intent: "generate", campaignId: "cmp_1", brief: "A long enough brief.", kind: "billboard" }))
        )
      ).problem?.code
    ).toBe("kind_required");
    expect(calls).toHaveLength(0);
  });

  it("plans a hand-typed campaign, and refuses a subject too thin to argue from", async () => {
    const calls = stubFetch(json({ campaignId: "cmp_1", plan: { options: [] }, source: "ai" }));

    // The API argues the plan; the screen only carries the subject and the key.
    const thrown = await studioAction(
      args(form({ intent: "plan", key: "k_plan", campaignId: "cmp_1", subject: "marine cover" }))
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/v1/signal/campaigns/cmp_1/plan");
    expect(calls[0]?.key).toBe("k_plan");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ subject: "marine cover" });
    // A redirect, so a refresh re-reads the plan rather than arguing a second one.
    expect((thrown as Response).headers.get("location")).toBe("/signal/studio?campaignId=cmp_1&planned=1");

    expect((await studioAction(args(form({ intent: "plan", subject: "marine cover" })))).problem?.code).toBe(
      "campaign_required"
    );
    expect((await studioAction(args(form({ intent: "plan", campaignId: "cmp_1", subject: "x" })))).problem?.code).toBe(
      "subject_required"
    );
    expect(calls).toHaveLength(1);
  });

  it("clears a draft as a compliance verdict, and discarding is the same write inverted", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }), new Response(null, { status: 204 }));

    await studioAction(args(form({ intent: "clear-variant", creativeId: "crv_1" })));
    await studioAction(args(form({ intent: "discard-variant", creativeId: "crv_1" })));

    expect(calls[0]?.body).toBe(JSON.stringify({ complianceStatus: "passed" }));
    expect(calls[1]?.body).toBe(JSON.stringify({ complianceStatus: "blocked" }));
  });

  it("surfaces the approval a launch needs instead of throwing", async () => {
    stubFetch(
      json(
        {
          title: "Approval required",
          status: 403,
          code: "approval_required",
          policy_key: "signal.campaign_launch"
        },
        403
      )
    );

    const result = await studioAction(args(form({ intent: "launch", campaignId: "cmp_1" })));

    expect(result.done).toBeNull();
    expect(result.problem).toMatchObject({ status: 403, code: "approval_required" });
  });
});

/* ---------------------------------------------------------- budget and bounds */

describe("budget action", () => {
  it("refuses to widen the bounds without the written confirmation", async () => {
    const calls = stubFetch(json(campaignRow()));
    const body = form({
      intent: "set-bounds",
      campaignId: "cmp_1",
      dailyMinor: "100000",
      boundMinor: "25000",
      autonomyLevel: "act"
    });

    expect((await budgetAction(args(body))).problem?.code).toBe("confirm_required");
    expect(calls).toHaveLength(0);
  });

  it("refuses a per-move ceiling above the daily budget", async () => {
    const calls = stubFetch(json(campaignRow()));
    const body = form({
      intent: "set-bounds",
      campaignId: "cmp_1",
      dailyMinor: "100000",
      boundMinor: "200000",
      autonomyLevel: "act",
      confirm: "on"
    });

    expect((await budgetAction(args(body))).problem?.code).toBe("bound_over_daily");
    expect(calls).toHaveLength(0);
  });

  it("refuses an autonomy level the engine does not implement", async () => {
    const calls = stubFetch(json(campaignRow()));
    const body = form({
      intent: "set-bounds",
      campaignId: "cmp_1",
      dailyMinor: "100000",
      boundMinor: "25000",
      autonomyLevel: "do_whatever",
      confirm: "on"
    });

    expect((await budgetAction(args(body))).problem?.code).toBe("autonomy_required");
    expect(calls).toHaveLength(0);
  });

  it("reads the budget before patching it, so the currency and cap survive", async () => {
    const calls = stubFetch(json(campaignRow()), new Response(null, { status: 204 }));
    const body = form({
      intent: "set-bounds",
      key: "signal-budget:k1",
      campaignId: "cmp_1",
      dailyMinor: "150000",
      boundMinor: "25000",
      autonomyLevel: "act_with_approval",
      confirm: "on"
    });

    const result = await budgetAction(args(body));

    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.key).toBe("signal-budget:k1");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      budgetJson: { dailyMinor: 150_000, currency: "ZAR", capMinor: 3_000_000, autopilotBoundMinor: 25_000 },
      autonomyLevel: "act_with_approval"
    });
    expect(result).toEqual({ problem: null, done: "set-bounds" });
  });

  it("records an undo against the person who pulled it back", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await budgetAction(
      args(form({ intent: "reverse-move", moveId: "mv_1", actor: "usr_1", key: "signal-budget:k2" }))
    );

    expect(calls[0]?.url).toBe("https://api.test/v1/signal/budget-moves/mv_1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ reversedBy: "usr_1" });
    expect(result.done).toBe("reverse-move");
  });

  it("will not undo a move anonymously", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    expect((await budgetAction(args(form({ intent: "reverse-move", moveId: "mv_1" })))).problem?.code).toBe(
      "actor_required"
    );
    expect((await budgetAction(args(form({ intent: "reverse-move", actor: "usr_1" })))).problem?.code).toBe(
      "move_required"
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an intent it does not have", async () => {
    expect((await budgetAction(args(form({ intent: "wire-money" })))).problem?.code).toBe("bad_intent");
  });
});

/* ------------------------------------------------------------------ analytics */

describe("analytics export", () => {
  it("exports the spend ledger through the platform export endpoint, window and all", async () => {
    const calls = stubFetch(json({ id: "exp_1", format: "xlsx", state: "ready" }));

    const result = await analyticsAction(args(form({ intent: "export", format: "xlsx", days: "7" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/analytics/exports");
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      format: string;
      definition: { dataset: string; from: number; to: number };
    };
    expect(body.format).toBe("xlsx");
    expect(body.definition.dataset).toBe("spend");
    // The window lives inside the definition: analytics.ts only merges the
    // top-level from/to for a saved report.
    expect(body.definition.to - body.definition.from).toBe(7 * 86_400_000);
    expect(result.exported).toMatchObject({ id: "exp_1" });
  });

  it("refuses a format the export engine cannot render, and a foreign intent", async () => {
    const calls = stubFetch(json({ id: "exp_1" }));

    expect((await analyticsAction(args(form({ intent: "export", format: "docx" })))).problem?.code).toBe(
      "format_required"
    );
    expect((await analyticsAction(args(form({ intent: "email-it", format: "pdf" })))).problem?.code).toBe(
      "bad_intent"
    );
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- answer pages */

describe("answer-engine action", () => {
  it("stamps the verification clock when a page is published", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await aeoAction(
      args(form({ intent: "set-status", pageId: "aeo_1", status: "published", key: "signal-aeo:k1" }))
    );

    expect(calls[0]?.url).toBe("https://api.test/v1/signal/aeo-pages/aeo_1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.key).toBe("signal-aeo:k1");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { status: string; freshness?: number };
    expect(body.status).toBe("published");
    expect(typeof body.freshness).toBe("number");
    expect(result).toEqual({ problem: null, done: "published" });
  });

  it("moves a page to another state without touching its freshness", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    await aeoAction(args(form({ intent: "set-status", pageId: "aeo_1", status: "stale" })));

    expect(calls[0]?.body).toBe(JSON.stringify({ status: "stale" }));
  });

  it("refuses a state the column does not hold, a missing page and a foreign intent", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    expect((await aeoAction(args(form({ intent: "set-status", pageId: "aeo_1", status: "hidden" })))).problem?.code)
      .toBe("status_required");
    expect((await aeoAction(args(form({ intent: "set-status", status: "published" })))).problem?.code).toBe(
      "page_required"
    );
    expect((await aeoAction(args(form({ intent: "rewrite" })))).problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });

  it("reports a withheld write as a Problem rather than throwing", async () => {
    stubFetch(json({ title: "forbidden", status: 403, code: "forbidden" }, 403));

    const result = await aeoAction(args(form({ intent: "set-status", pageId: "aeo_1", status: "retired" })));

    expect(result.done).toBeNull();
    expect(result.problem?.status).toBe(403);
  });
});

describe("channelLabel", () => {
  it("names a channel the way a person would", () => {
    expect(channelLabel("google_search")).toBe("Google Search");
    expect(channelLabel("meta")).toBe("Facebook");
    expect(channelLabel("meta", "ar")).toBe("فيسبوك");
  });

  it("still renders a slug no catalogue knows", () => {
    expect(channelLabel("partner_portal")).toBe("Partner Portal");
  });
});
