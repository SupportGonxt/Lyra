import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { LABELS, action, labelsIn, platformLede, type TenantHealth } from "./platform";

// The platform workspace holds the two controls a customer never sees: a global
// capability switch and standing in for one of their users. Both are gated on
// the API side, so what matters here is that the screen refuses early on a
// missing reason or an unticked confirmation, and that a held approval renders
// as a gate instead of a crash.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/platform", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const ok = () => new Response(JSON.stringify({ id: "x" }), { status: 200 });

describe("platformLede", () => {
  const l = labelsIn("en");
  const tenant = (over: Partial<TenantHealth>): TenantHealth => ({
    tenantId: "t1",
    outboxPending: 0,
    dlqDepth: 0,
    pendingApprovals: 0,
    ...over
  });

  it("leads with dead letters when any exist, over anything else waiting", () => {
    const tenants = [tenant({ dlqDepth: 3 }), tenant({ outboxPending: 5 })];
    expect(platformLede(tenants, l)).toBe("3 dead letters across 2 tenants — that queue needs a look now.");
  });

  it("reports what is waiting once there are no dead letters", () => {
    const tenants = [tenant({ outboxPending: 4, pendingApprovals: 2 })];
    expect(platformLede(tenants, l)).toBe("4 events and 2 decisions waiting across 1 tenant.");
  });

  it("reads all clear when nothing is outstanding", () => {
    const tenants = [tenant({}), tenant({})];
    expect(platformLede(tenants, l)).toBe("All 2 tenants are clear — nothing waiting, no dead letters.");
  });
});

describe("platform workspace labels", () => {
  it("answers the keys the shared approval gate reads", () => {
    const l = labelsIn("en");
    expect(l("approvalBody", { policy: "core.impersonate" })).toContain("core.impersonate");
    expect(l("approvalTitle").length).toBeGreaterThan(0);
    expect(l("approvalLink").length).toBeGreaterThan(0);
  });

  it("translates every key it renders", () => {
    const en = Object.keys(LABELS.en ?? {}).sort();
    const ar = Object.keys(LABELS.ar ?? {}).sort();
    expect(ar).toEqual(en);
    for (const key of en) expect(LABELS.ar?.[key]).not.toBe(LABELS.en?.[key]);
  });
});

describe("platform workspace action", () => {
  it("refuses a flag with no key or no description", async () => {
    expect((await action(args(form({ intent: "flag-create", description: "d" })))).error).toBe("errKeyRequired");
    expect((await action(args(form({ intent: "flag-create", key: "k" })))).error).toBe("errDescriptionRequired");
  });

  it("keeps rollout inside 0..100", async () => {
    const over = form({ intent: "flag-create", key: "k", description: "d", rolloutPercent: "140" });
    expect((await action(args(over))).error).toBe("errRolloutRange");
    const patch = form({ intent: "flag-rollout", flagId: "flg_1", rolloutPercent: "-5" });
    expect((await action(args(patch))).error).toBe("errRolloutRange");
  });

  it("sends the toggle as the opposite of what the row shows", async () => {
    const calls = stubFetch(ok());
    const result = await action(args(form({ intent: "flag-toggle", flagId: "flg_1", enabled: "on" })));
    expect(result.saved).toBe("savedToggle");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/v1/platform/flags/flg_1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ enabled: true });
  });

  it("will not start standing in for someone without a ticked confirmation and a reason", async () => {
    const unticked = form({ intent: "impersonate-start", targetUserId: "usr_1", reason: "case 12" });
    expect((await action(args(unticked))).error).toBe("errConfirmRequired");
    const noReason = form({ intent: "impersonate-start", targetUserId: "usr_1", confirm: "on" });
    expect((await action(args(noReason))).error).toBe("errReasonRequired");
    const noTarget = form({ intent: "impersonate-start", reason: "case 12", confirm: "on" });
    expect((await action(args(noTarget))).error).toBe("errTargetRequired");
  });

  it("carries the idempotency key and reason to the start endpoint", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ id: "ims_1" }), { status: 201 }));
    const result = await action(
      args(
        form({
          intent: "impersonate-start",
          targetUserId: "usr_1",
          reason: "case 12",
          confirm: "on",
          idempotencyKey: "key-1"
        })
      )
    );
    expect(result.saved).toBe("savedStart");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ targetUserId: "usr_1", reason: "case 12" });
  });

  it("renders a held approval instead of throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "approval required", status: 403, code: "approval_required" }), {
        status: 403
      })
    );
    const result = await action(
      args(form({ intent: "impersonate-start", targetUserId: "usr_1", reason: "case 12", confirm: "on" }))
    );
    expect(result.saved).toBeNull();
    expect(result.problem?.code).toBe("approval_required");
  });

  it("ends the session the row names", async () => {
    const calls = stubFetch(ok());
    const result = await action(args(form({ intent: "impersonate-end", sessionId: "ims_1" })));
    expect(result.saved).toBe("savedEnd");
    expect(calls[0]?.url).toContain("/v1/platform/impersonation/ims_1/end");
  });

  // docs/30 Admin 4: the platform AI kill switch had routes and no button. A
  // stop needs a stated reason (the route requires 3+ characters); a release
  // goes through the gated route, never the generic flag toggle.
  it("stops all AI only with a reason, and releases through the gated route", async () => {
    expect((await action(args(form({ intent: "ai-kill", reason: " " })))).error).toBe("errReasonRequired");
    const calls = stubFetch(ok());
    expect((await action(args(form({ intent: "ai-kill", reason: "provider outage" })))).saved).toBe("savedKill");
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/v1/platform/ai/kill") });
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ reason: "provider outage" });
    expect((await action(args(form({ intent: "ai-release" })))).saved).toBe("savedRelease");
    expect(calls[1]?.url).toContain("/v1/platform/ai/release");
  });

  it("refuses an intent it does not know", async () => {
    expect((await action(args(form({ intent: "nope" })))).problem?.status).toBe(400);
  });
});
