import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { action } from "./analytics-schedule-new";

// docs/30 Analytics 2: scheduling a report saved earlier. The body is the
// builder's own (scheduleBody), so cron comes from a named cadence, never typed.
const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
afterEach(() => vi.unstubAllGlobals());

const args = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return {
    request: new Request("https://web.test/analytics/schedules/new", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
};

function stub() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = String(input).includes("/reports/") ? { id: "rpt_1", name: { en: "Weekly premium", ar: "الأقساط الأسبوعية" } } : { id: "sch_1" };
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 201, headers: { "content-type": "application/json" } }));
  });
  return calls;
}

describe("scheduling a saved report", () => {
  it("posts the builder's body with the report's own names", async () => {
    const calls = stub();
    const result = await action(args({ reportId: "rpt_1", cadence: "weekly", format: "xlsx", recipients: "a@x.test, b@x.test", locale: "en" }));
    expect(result.done).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/v1/analytics/schedules");
    expect(post.body).toEqual({
      reportId: "rpt_1",
      name: { en: "Weekly premium", ar: "الأقساط الأسبوعية" },
      cron: "0 6 * * 1",
      format: "xlsx",
      recipients: ["a@x.test", "b@x.test"],
      locale: "en"
    });
  });

  it("refuses no report, no cadence, or no recipient without scheduling anything", async () => {
    const calls = stub();
    expect((await action(args({ cadence: "weekly", recipients: "a@x.test" }))).error).toBe("errReport");
    expect((await action(args({ reportId: "rpt_1", cadence: "hourly", recipients: "a@x.test" }))).error).toBe("errCadence");
    expect((await action(args({ reportId: "rpt_1", cadence: "daily", recipients: " , " }))).error).toBe("errRecipients");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
