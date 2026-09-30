import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "./index.js";
import { kv } from "./node.js";
import type { Env } from "./env.js";

// Sighting 18: the virtual clock (clock.ts, docs/24 sim plan) was declared and
// honoured by request contexts, but the scheduled tick and the queue consumer
// read Date.now() — so advancing the clock moved every screen and no nightly
// job — and node.ts bound no CONFIG, so on-prem the clock could not be staged
// at all. A compressed month could not be run anywhere but Cloudflare.

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("the virtual clock reaches every entry point", () => {
  it("the scheduled tick and the queue consumer take their time from simNow", () => {
    const index = source("./index.ts");
    const scheduled = index.slice(index.indexOf("async scheduled("));
    const queue = index.slice(index.indexOf("async queue("), index.indexOf("async scheduled("));
    expect(scheduled.slice(0, 200)).toMatch(/const now = await simNow\(env\)/);
    expect(queue).not.toMatch(/Date\.now\(\)/);
  });

  it("the on-prem runtime binds CONFIG, so the clock can be staged there", () => {
    expect(source("./node.ts")).toMatch(/CONFIG:\s*kv\(\)/);
  });

  it("reports real elapsed time even with the clock advanced", async () => {
    const config = kv();
    await config.put("sim:clock:offsetMs", String(10 * 86_400_000));
    const env = { ENVIRONMENT: "local", CONFIG: config } as unknown as Env;
    const res = await worker.fetch(new Request("http://api.test/health"), env, { waitUntil() {}, passThroughOnException() {} } as never);
    const ms = Number(res.headers.get("x-response-time-ms"));
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(60_000);
  });

  // Found by the month simulation: the portal priced a quote valid for seven
  // real days, then staff select compared it with the virtual clock, so from
  // day seven every portal quote was born expired and nothing bound.
  it("no route takes its business clock from Date.now()", () => {
    // Verifying an IdP assertion is against the IdP's real clock, not ours.
    const REAL_CLOCK: Record<string, string> = { "sso.ts": "IdP assertion and token lifetimes are real time" };
    const dir = new URL("./routes/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !REAL_CLOCK[f])
      .filter((f) => /const now = Date\.now\(\)/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(offenders).toEqual([]);
  });
});
