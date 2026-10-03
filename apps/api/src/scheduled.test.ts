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

vi.mock("./engines/signal-experiment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  concludeExperiments: vi.fn(async () => ({ concluded: 0 }))
}));

vi.mock("./engines/compliance-retention.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sweepRetention: vi.fn(async () => [])
}));

vi.mock("./engines/signal-conversions.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportConversions: vi.fn(async () => ({ connectors: 0, sent: 0, skipped: 0, failed: 0, errors: [] }))
}));

import worker from "./index.js";
import { exportConversions } from "./engines/signal-conversions.js";
import { sweepRenewals } from "./engines/renewals.js";
import { sweepWhitespace } from "./engines/scout-whitespace.js";
import { concludeExperiments } from "./engines/signal-experiment.js";
import { sweepRetention } from "./engines/compliance-retention.js";

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
              values ('t_scout','scout','Scout','active',?,?,?), ('t_axis','axis','Axis','active',?,?,?), ('t_sig','sig','Sig','active',?,?,?)`,
        args: [JSON.stringify({ modules: ["scout"] }), now, now, JSON.stringify({ modules: ["axis"] }), now, now, JSON.stringify({ modules: ["signal"] }), now, now]
      });
      vi.mocked(sweepWhitespace).mockClear();
      let tail: Promise<unknown> = Promise.resolve();
      await worker.scheduled(undefined, env, { waitUntil(p: Promise<unknown>) { tail = p; } });
      await tail;
      const swept = vi.mocked(sweepWhitespace).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
      expect(swept).toEqual(["t_scout"]);
      // docs/30 SIGNAL 4: experiments conclude only where SIGNAL is on.
      const concluded = vi.mocked(concludeExperiments).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
      expect(concluded).toContain("t_sig");
      expect(concluded).not.toContain("t_scout");
      expect(concluded).not.toContain("t_axis");
    } finally {
      vi.useRealTimers();
    }
  });

  // docs/30 Compliance 5: retention runs on the clock only for a tenant whose
  // policy names a cadence. One that never configured retention keeps its data
  // — the purge is irreversible, so silence is never read as consent to delete.
  it("sweeps retention for a tenant with a configured cadence, and for no other", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.UTC(2026, 8, 29, 2, 5);
      vi.setSystemTime(now);
      const AXIS = JSON.stringify({ modules: ["axis"] });
      await client.execute({
        sql: `insert into core_tenants (id, slug, name, status, policy_json, entitlements_json, created_at, updated_at)
              values ('t_ret','ret','Ret','active',?,?,?,?), ('t_none','none','None','active','{}',?,?,?),
                     ('t_never','never','Never','active',?,?,?,?)`,
        // Retention is the platform's, not a module's: it runs whatever was bought.
        args: [
          JSON.stringify({ retention: { schedule: "weekly" } }), AXIS, now, now,
          AXIS, now, now,
          JSON.stringify({ retention: { schedule: "never" } }), AXIS, now, now
        ]
      });
      const tick = async () => {
        vi.mocked(sweepRetention).mockClear();
        let tail: Promise<unknown> = Promise.resolve();
        await worker.scheduled(undefined, env, { waitUntil(p: Promise<unknown>) { tail = p; } });
        await tail;
        return vi.mocked(sweepRetention).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
      };
      expect(await tick()).toEqual(["t_ret"]);
      // Outside the nightly window nothing purges, configured or not.
      vi.setSystemTime(Date.UTC(2026, 8, 29, 14, 5));
      expect(await tick()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // J-E1, docs/06 "the 7am read": the exec brief exists every morning, model
  // or no model. This env binds no provider at all — the on-prem/outage shape
  // — so what lands is the template, in each of the tenant's languages.
  it("writes the day's exec brief per locale with no model configured, only where NORTH is on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.UTC(2026, 8, 29, 2, 5);
      vi.setSystemTime(now);
      await client.execute({
        sql: `insert into core_tenants (id, slug, name, status, policy_json, entitlements_json, created_at, updated_at)
              values ('t_north','north','North','active','{}',?,?,?), ('t_axis','axis','Axis','active','{}',?,?,?)`,
        args: [JSON.stringify({ modules: ["north"] }), now, now, JSON.stringify({ modules: ["axis"] }), now, now]
      });
      const tick = async () => {
        let tail: Promise<unknown> = Promise.resolve();
        await worker.scheduled(undefined, env, { waitUntil(p: Promise<unknown>) { tail = p; } });
        await tail;
        const rows = await client.execute(
          "select tenant_id, date, audience, locale, generated_by, narrative_ref from north_briefings order by locale"
        );
        return rows.rows;
      };
      const rows = await tick();
      expect(rows.map((r) => [r.tenant_id, r.date, r.audience, r.locale, r.generated_by])).toEqual([
        ["t_north", "2026-09-29", "exec", "ar", "template"],
        ["t_north", "2026-09-29", "exec", "en", "template"]
      ]);
      expect(String(rows[0]!.narrative_ref)).not.toMatch(/[A-Za-z]/);
      // A second tick in the same window writes nothing new.
      expect(await tick()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // docs/17 SIG-032, ADR-0112: binds are reported to the ad platforms once a
  // day, right after the spend pull, only where SIGNAL is on.
  it("exports value-based bidding conversions on the first tick of the UTC day, for tenants with SIGNAL on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.UTC(2026, 8, 29, 0, 5);
      vi.setSystemTime(now);
      await client.execute({
        sql: `insert into core_tenants (id, slug, name, status, policy_json, entitlements_json, created_at, updated_at)
              values ('t_sig','sig','Sig','active','{}',?,?,?), ('t_off','off','Off','active',?,?,?,?), ('t_axis','axis','Axis','active','{}',?,?,?)`,
        args: [
          JSON.stringify({ modules: ["signal"] }), now, now,
          JSON.stringify({ moduleConfig: { signal: { enabled: false } } }), JSON.stringify({ modules: ["signal"] }), now, now,
          JSON.stringify({ modules: ["axis"] }), now, now
        ]
      });
      const tick = async () => {
        vi.mocked(exportConversions).mockClear();
        let tail: Promise<unknown> = Promise.resolve();
        await worker.scheduled(undefined, env, { waitUntil(p: Promise<unknown>) { tail = p; } });
        await tail;
        return vi.mocked(exportConversions).mock.calls.map(([c]) => (c as { tenantId: string }).tenantId);
      };
      expect(await tick()).toEqual(["t_sig"]);
      vi.setSystemTime(Date.UTC(2026, 8, 29, 14, 5));
      expect(await tick()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
