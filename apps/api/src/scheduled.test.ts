import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@lyra/core";
import type { Env } from "./env.js";

// Regression cover for the worker's two background entry points:
// - scheduled(): one tenant blowing up must not starve every tenant after it.
// - queue(): a poison message must stop retrying at the cap, not spin forever.

vi.mock("./engines/renewals.js", () => ({
  sweepRenewals: vi.fn(async (ctx: { tenantId: string }) => {
    if (ctx.tenantId === "t_bad") throw new Error("boom");
    return 0;
  })
}));

vi.mock("./engines/scout-whitespace.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sweepWhitespace: vi.fn(async () => 0)
}));

import worker from "./index.js";
import { sweepRenewals } from "./engines/renewals.js";
import { sweepWhitespace } from "./engines/scout-whitespace.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let env: Env;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  env = { DB_CLIENT: drizzle(client) } as unknown as Env;
  vi.mocked(sweepRenewals).mockClear();
});

// Every provisioned tenant carries what it bought (seed.ts); one that bought
// nothing has every module stood down, on the clock as at its routes.
const ALL = JSON.stringify({ modules: ["axis", "orbit", "signal", "scout", "north"] });

describe("scheduled tick", () => {
  it("keeps sweeping the remaining tenants when one tenant's tick throws", async () => {
    const now = Date.now();
    await client.execute({
      sql: `insert into core_tenants (id, slug, name, status, entitlements_json, created_at, updated_at)
            values ('t_bad','bad','Bad',?,?,?,?), ('t_good','good','Good',?,?,?,?)`,
      args: ["active", ALL, now, now, "active", ALL, now, now]
    });

    let tail: Promise<unknown> = Promise.resolve();
    await worker.scheduled(undefined, env, {
      waitUntil(p: Promise<unknown>) {
        tail = p;
      }
    });
    await tail;

    const tenants = vi.mocked(sweepRenewals).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
    expect(tenants).toContain("t_bad");
    expect(tenants).toContain("t_good");
  });

  it("does not run a module's sweeps for a tenant that switched it off (ADR-0087)", async () => {
    const now = Date.now();
    await client.execute({
      sql: `insert into core_tenants (id, slug, name, status, policy_json, entitlements_json, created_at, updated_at)
            values ('t_off','off','Off','active',?,?,?,?), ('t_on','on','On','active',?,?,?,?)`,
      args: [JSON.stringify({ moduleConfig: { orbit: { enabled: false } } }), ALL, now, now, "{}", ALL, now, now]
    });

    let tail: Promise<unknown> = Promise.resolve();
    await worker.scheduled(undefined, env, {
      waitUntil(p: Promise<unknown>) {
        tail = p;
      }
    });
    await tail;

    const tenants = vi.mocked(sweepRenewals).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
    expect(tenants).toEqual(["t_on"]);
  });
});

describe("queue consumer", () => {
  const poisonMessage = (attempts: number) => ({
    // A body the handler cannot even read: fails on every delivery.
    body: null as unknown as Envelope,
    attempts,
    ack: vi.fn(),
    retry: vi.fn()
  });

  it("retries a failing message below the attempts cap", async () => {
    const m = poisonMessage(1);
    await worker.queue({ messages: [m] }, env);
    expect(m.retry).toHaveBeenCalled();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it("acks a poison message at the attempts cap instead of retrying forever", async () => {
    const m = poisonMessage(3);
    await worker.queue({ messages: [m] }, env);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe("the nightly window", () => {
  // @accept:SA: the Radar's whitespace was only ever computed by hand, so a
  // tenant living on SCOUT saw last quarter's candidates until someone pressed
  // a button. The nightly window recomputes it, for tenants with SCOUT on.
  it("recomputes whitespace for a tenant with SCOUT, and not for one without", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 29, 2, 5));
    try {
      const now = Date.now();
      await client.execute({
        sql: `insert into core_tenants (id, slug, name, status, entitlements_json, created_at, updated_at)
              values ('t_scout','scout','Scout','active',?,?,?), ('t_axis','axis','Axis','active',?,?,?)`,
        args: [JSON.stringify({ modules: ["scout"] }), now, now, JSON.stringify({ modules: ["axis"] }), now, now]
      });
      vi.mocked(sweepWhitespace).mockClear();
      let tail: Promise<unknown> = Promise.resolve();
      await worker.scheduled(undefined, env, { waitUntil(p: Promise<unknown>) { tail = p; } });
      await tail;
      const swept = vi.mocked(sweepWhitespace).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
      expect(swept).toEqual(["t_scout"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
