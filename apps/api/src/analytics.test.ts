import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { crudRouter } from "./crud.js";
import { onError } from "./mw.js";
import { ANALYTICS } from "./resources.js";
import { analyticsRoutes, nextRun, runDueSchedules } from "./routes/analytics.js";
import type { App, Env } from "./env.js";

// ANL-010 (warehouse feed) and ANL-012 (scheduled delivery). Both are driven
// through the real handlers with the real permission checks — the feed because
// a warehouse export that leaks a tenant is the worst bug in the product, the
// scheduler because "fired twice" is indistinguishable from "worked" in a log.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
const HOUR = 3_600_000;

let ctx: Ctx;

/** Whatever was written to the object store this test. */
let stored: Map<string, Uint8Array>;

const bucket = {
  put: async (key: string, bytes: Uint8Array) => {
    stored.set(key, bytes);
  },
  get: async (key: string) => (stored.has(key) ? { body: stored.get(key) } : null)
} as unknown as R2Bucket;

const env = { FILES: bucket } as unknown as Env;

function actor(permissions: string[]): Ctx["actor"] {
  return { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "test", permissions }] };
}

/** The analytics router with a fixed context — no login, the same handlers. */
function router(over: Partial<Ctx> = {}): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, ...over });
    await next();
  });
  app.route("/v1/analytics", analyticsRoutes);
  return app;
}

async function feed(path: string, over: Partial<Ctx> = {}): Promise<{ status: number; rows: any[]; res: Response }> {
  const res = await router(over).fetch(new Request(`http://api.test${path}`), env as never);
  const text = await res.text();
  const rows = res.ok
    ? text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { status: res.status, rows, res };
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  stored = new Map();
  const now = NOW;
  await client.execute({
    sql: `insert into core_users (id, tenant_id, email, name, locale, status, auth_provider, mfa_enrolled, created_at, updated_at)
          values ('u_owner','t_test','owner@test','Owner','en','active','password',0,?,?),
                 ('u_recipient','t_test','rec@test','Recipient','en','active','password',0,?,?)`,
    args: [now, now, now, now]
  });
  // Delivery re-reads each recipient's real grants, so a test recipient needs
  // real role rows — a user with none is a user who was never given the report.
  await client.execute({
    sql: `insert into core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
          values ('rol_reader','t_test','test.reader','Reader',?,1,?)`,
    args: [JSON.stringify(["axis:policies:read", "analytics:exports:download"]), now]
  });
  await client.execute({
    sql: `insert into core_user_roles (id, tenant_id, user_id, role_id, created_at)
          values ('ur_owner','t_test','u_owner','rol_reader',?),
                 ('ur_recipient','t_test','u_recipient','rol_reader',?)`,
    args: [now, now]
  });
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: actor(["*:*:*"]),
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/* -------------------------------------------------------------- ANL-010 feed */

describe("warehouse feed", () => {
  it("ships only the caller's tenant, and stamps the tenant on every row", async () => {
    await seedPolicies();
    const { status, rows } = await feed("/v1/analytics/feed/policies");
    expect(status).toBe(200);
    expect(rows.map((r) => r.id)).toEqual(["pol_1", "pol_2"]);
    expect(rows.every((r) => r.tenant_id === "t_test")).toBe(true);
  });

  it("answers NDJSON, one row per line", async () => {
    await seedPolicies();
    const { res } = await feed("/v1/analytics/feed/policies");
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  });

  it("resumes from its cursor without repeating or dropping a row", async () => {
    await seedPolicies();
    const first = await feed("/v1/analytics/feed/policies?limit=1");
    expect(first.rows.map((r) => r.id)).toEqual(["pol_1"]);
    expect(first.res.headers.get("x-lyra-more")).toBe("true");

    const cursor = first.res.headers.get("x-lyra-cursor");
    expect(cursor).toBeTruthy();
    const second = await feed(`/v1/analytics/feed/policies?limit=1&cursor=${encodeURIComponent(cursor!)}`);
    expect(second.rows.map((r) => r.id)).toEqual(["pol_2"]);

    // The warehouse keeps the last cursor and polls again later: nothing new,
    // and nothing it has already loaded comes back a second time.
    const third = await feed(
      `/v1/analytics/feed/policies?cursor=${encodeURIComponent(second.res.headers.get("x-lyra-cursor")!)}`
    );
    expect(third.rows).toEqual([]);
    expect(third.res.headers.get("x-lyra-more")).toBe("false");
  });

  it("honours an incremental `since` watermark", async () => {
    await seedPolicies();
    const { rows } = await feed(`/v1/analytics/feed/policies?since=${NOW + HOUR}`);
    expect(rows.map((r) => r.id)).toEqual(["pol_2"]);
  });

  it("rejects a cursor that is not one of ours", async () => {
    await seedPolicies();
    expect((await feed("/v1/analytics/feed/policies?cursor=not-a-cursor")).status).toBe(400);
  });

  it("masks a PII column unless the caller holds core:pii:view", async () => {
    await seedPolicies();
    const masked = await feed("/v1/analytics/feed/policies", {
      actor: actor(["analytics:exports:create", "axis:policies:read"])
    });
    expect(masked.rows.map((r) => r.customer_id)).toEqual(["•us_1", "•us_2"]);

    const clear = await feed("/v1/analytics/feed/policies", {
      actor: actor(["analytics:exports:create", "axis:policies:read", "core:pii:view"])
    });
    expect(clear.rows.map((r) => r.customer_id)).toEqual(["cus_1", "cus_2"]);
  });

  it("refuses a caller who cannot read the dataset", async () => {
    await seedPolicies();
    const res = await feed("/v1/analytics/feed/policies", { actor: actor(["analytics:exports:create"]) });
    expect(res.status).toBe(403);
  });

  it("refuses a caller who can read the dataset but may not export", async () => {
    await seedPolicies();
    const res = await feed("/v1/analytics/feed/policies", { actor: actor(["axis:policies:read"]) });
    expect(res.status).toBe(403);
  });

  it("refuses an unknown dataset instead of guessing a table", async () => {
    expect((await feed("/v1/analytics/feed/core_users")).status).toBe(400);
  });

  it("records the pull in the audit log", async () => {
    await seedPolicies();
    await feed("/v1/analytics/feed/policies");
    const rows = await ctx.db.select().from(schema.auditLog);
    expect(rows.map((r) => r.action)).toContain("analytics.feed.read");
  });
});

/* --------------------------------------------------------- ANL-012 delivery */

describe("scheduled delivery", () => {
  it("runs a due schedule exactly once and files it in the recipient's inbox", async () => {
    await seedPolicies();
    const scheduleId = await seedSchedule({ recipients: ["u_recipient"] });

    const first = await runDueSchedules(system(), bucket);
    const second = await runDueSchedules(system(), bucket);
    expect([first, second]).toEqual([1, 0]);

    const exports_ = await ctx.db.select().from(schema.analyticsExports);
    expect(exports_.length).toBe(1);
    expect(exports_[0]?.state).toBe("ready");
    expect(stored.size).toBe(1);

    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes.length).toBe(1);
    expect(notes[0]?.userId).toBe("u_recipient");
    // Rule 7: an inbox row carries an i18n key, never an English sentence.
    expect(notes[0]?.titleKey).toMatch(/^[a-z0-9_.]+$/);
    expect(notes[0]?.subjectRef).toBe(exports_[0]?.id);

    const row = (await ctx.db.select().from(schema.analyticsSchedules).where(eq(schema.analyticsSchedules.id, scheduleId)))[0];
    expect(row?.lastState).toBe("done");
    expect(row?.lastRunAt).toBe(NOW);
    expect(row?.nextRunAt).toBeGreaterThan(NOW);

    const audit = await ctx.db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toContain("analytics.schedule.deliver");
  });

  it("leaves a paused schedule alone", async () => {
    await seedPolicies();
    await seedSchedule({ status: "paused" });
    expect(await runDueSchedules(system(), bucket)).toBe(0);
  });

  it("leaves a schedule that is not due yet alone", async () => {
    await seedPolicies();
    await seedSchedule({ nextRunAt: NOW + HOUR });
    expect(await runDueSchedules(system(), bucket)).toBe(0);
  });

  it("stays inside the schedule's tenant", async () => {
    await seedPolicies();
    await seedSchedule({});
    // The scheduler for another tenant must not deliver this one.
    expect(await runDueSchedules({ ...system(), tenantId: "t_other" }, bucket)).toBe(0);
  });

  it("alerts the owner when a run fails, and reschedules rather than wedging", async () => {
    const scheduleId = await seedSchedule({ reportId: "rep_missing" });
    expect(await runDueSchedules(system(), bucket)).toBe(0);

    const row = (await ctx.db.select().from(schema.analyticsSchedules).where(eq(schema.analyticsSchedules.id, scheduleId)))[0];
    expect(row?.lastState).toBe("failed");
    expect(row?.nextRunAt).toBeGreaterThan(NOW);

    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes.length).toBe(1);
    expect(notes[0]?.userId).toBe("u_owner");
    expect(notes[0]?.kind).toBe("alert");
  });

  it("alerts the owner when a recipient has nowhere to deliver to", async () => {
    await seedPolicies();
    await seedSchedule({ recipients: ["u_recipient", "nobody@example.com"] });
    expect(await runDueSchedules(system(), bucket)).toBe(1);

    const row = (await ctx.db.select().from(schema.analyticsSchedules))[0];
    expect(row?.lastState).toBe("partial");
    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes.filter((n) => n.kind === "alert").map((n) => n.userId)).toEqual(["u_owner"]);
  });

  // A schedule outlives the roles of everyone named on it. Delivering to someone
  // who has since lost the report is a leak if the download trusts the inbox row,
  // and a lie if it doesn't — so they are dropped before the row is written.
  it("does not deliver to a recipient who cannot read the report", async () => {
    await seedPolicies();
    await ctx.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, "u_recipient"));
    await seedSchedule({ recipients: ["u_recipient"] });
    expect(await runDueSchedules(system(), bucket)).toBe(1);

    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes.map((n) => n.userId)).toEqual(["u_owner"]);
    expect(notes[0]?.kind).toBe("alert");
    expect((await ctx.db.select().from(schema.analyticsSchedules))[0]?.lastState).toBe("undelivered");
  });

  it("masks PII in a scheduled artefact — the scheduler holds no permissions", async () => {
    await seedPolicies();
    await seedSchedule({ format: "csv", dimensions: ["customerId"] });
    expect(await runDueSchedules(system(), bucket)).toBe(1);
    const csv = new TextDecoder().decode([...stored.values()][0]!);
    expect(csv).not.toContain("cus_1");
  });
});

/* ------------------------------------------------ schedule cron timezone */

describe("nextRun timezone", () => {
  it("evaluates the cron in the schedule's timezone: 09:00 Asia/Dubai is 05:00 UTC", () => {
    expect(nextRun("0 9 * * *", Date.UTC(2026, 5, 15), "Asia/Dubai")).toBe(Date.UTC(2026, 5, 15, 5));
  });

  it("stays UTC when no timezone is given", () => {
    expect(nextRun("0 9 * * *", Date.UTC(2026, 5, 15))).toBe(Date.UTC(2026, 5, 15, 9));
  });

  it("rejects a timezone Intl does not know", () => {
    try {
      nextRun("0 9 * * *", 0, "Mars/Olympus");
      expect.unreachable("nextRun accepted an unknown timezone");
    } catch (e) {
      expect((e as { detail?: string }).detail).toMatch(/timezone/);
    }
  });

  // `Intl.DateTimeFormat.formatToParts` throws `RangeError` on an instant no
  // `Date` can hold, from inside the same `try` that guards the timezone — so a
  // bad `from` was reported as "unknown timezone: Asia/Dubai" and sent whoever
  // read it looking at a zone that is perfectly fine.
  it("blames the instant, not the timezone, when `from` is unusable", () => {
    try {
      nextRun("0 9 * * *", 9e15, "Asia/Dubai");
      expect.unreachable("nextRun accepted an instant no Date can hold");
    } catch (e) {
      expect((e as { detail?: string }).detail).not.toMatch(/timezone/);
      expect((e as { detail?: string }).detail).toMatch(/9000000000000000/);
    }
  });
});

describe("schedule creation", () => {
  const post = (payload: unknown, over: Partial<Ctx> = {}) =>
    router(over).fetch(
      new Request("http://api.test/v1/analytics/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }),
      env as never
    );

  it("stores nextRunAt computed in the schedule's timezone, not bare UTC", async () => {
    await seedSchedule({ status: "paused" }); // seeds rep_1
    const res = await post({
      reportId: "rep_1",
      name: { en: "Daily" },
      cron: "0 9 * * *",
      timezone: "Asia/Dubai",
      recipients: ["u_owner"]
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { nextRunAt: number };
    // NOW is 2026-06-15T12:00Z = 16:00 in Dubai; next 09:00 Dubai is 05:00 UTC next day.
    expect(row.nextRunAt).toBe(Date.UTC(2026, 5, 16, 5));
  });

  // The zone is three answers in priority order, and the middle one is the one
  // that was missing: a code literal ("Asia/Dubai") used to be the default, so a
  // South African broker's daily report fired on Gulf wall-clock. NOW is
  // 2026-06-15T12:00Z; 09:00 next day is 05:00Z in Dubai, 07:00Z in
  // Johannesburg and 09:00Z in UTC — three distinct instants, so each branch
  // below is told apart by the answer and not by the argument.
  const daily = { reportId: "rep_1", name: { en: "Daily" }, cron: "0 9 * * *", recipients: ["u_owner"] };

  it("prefers the zone the caller named over the tenant's own", async () => {
    await seedSchedule({ status: "paused" });
    const res = await post(
      { ...daily, timezone: "Asia/Dubai" },
      { policy: PolicyJson.parse({ timezone: "Africa/Johannesburg" }) }
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { nextRunAt: number; timezone: string };
    expect(row.timezone).toBe("Asia/Dubai");
    expect(row.nextRunAt).toBe(Date.UTC(2026, 5, 16, 5));
  });

  it("falls back to the tenant's zone when the caller names none", async () => {
    await seedSchedule({ status: "paused" });
    const res = await post(daily, { policy: PolicyJson.parse({ timezone: "Africa/Johannesburg" }) });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { nextRunAt: number; timezone: string };
    expect(row.timezone).toBe("Africa/Johannesburg");
    expect(row.nextRunAt).toBe(Date.UTC(2026, 5, 16, 7));
  });

  it("stores UTC — not a market — when neither the caller nor the tenant has a zone", async () => {
    await seedSchedule({ status: "paused" });
    const res = await post(daily);
    expect(res.status).toBe(201);
    const row = (await res.json()) as { nextRunAt: number; timezone: string };
    expect(row.timezone).toBe("UTC");
    expect(row.nextRunAt).toBe(Date.UTC(2026, 5, 16, 9));
  });

  // deliverSchedule only renders reports; accepting a dashboard-only schedule
  // mints one that fails and alerts its owner on every fire, forever.
  it("rejects a dashboard-only schedule with a 400 at creation", async () => {
    const res = await post({
      dashboardId: "dsh_1",
      name: { en: "Board" },
      cron: "0 9 * * *",
      recipients: ["u_owner"]
    });
    expect(res.status).toBe(400);
  });

  // Regression: with a reportId beside it, `dashboardId` was accepted, stored,
  // and never delivered — the owner asked for a dashboard and got the report.
  it("rejects a dashboardId beside a reportId instead of storing it and ignoring it", async () => {
    await seedSchedule({ status: "paused" });
    const res = await post({ ...daily, dashboardId: "dsh_1" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/dashboard/);
  });

  // The generic PATCH is the other door onto the same row: dropping the report
  // or adding a dashboard there mints the schedule deliverSchedule refuses on
  // every fire.
  it("refuses a PATCH that would turn a report schedule into a dashboard schedule", async () => {
    const id = await seedSchedule({ status: "paused" });
    const crud = new Hono<App>();
    crud.onError(onError);
    crud.use("*", async (c, next) => {
      c.set("ctx", ctx);
      await next();
    });
    crud.route("/", crudRouter(ANALYTICS.find((r) => r.path === "schedules")!));
    const patch = (payload: unknown) =>
      crud.fetch(
        new Request(`http://api.test/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }),
        env as never
      );
    expect((await patch({ dashboardId: "dsh_1" })).status).toBe(400);
    expect((await patch({ reportId: null })).status).toBe(400);
    expect((await patch({ locale: "ar" })).status).toBe(200);
  });

  // The seed carries one paused dashboard schedule (seed/analytics.ts), and
  // deployed tenants hold it. Resuming it is the third door onto a schedule
  // that fails on every tick; editing its name or deleting it is not.
  it("refuses to resume a dashboard schedule, and still lets it be tidied", async () => {
    const id = await seedSchedule({ status: "paused" });
    await ctx.db
      .update(schema.analyticsSchedules)
      .set({ reportId: null, dashboardId: "dsh_1" })
      .where(eq(schema.analyticsSchedules.id, id));
    const resume = await router().fetch(
      new Request(`http://api.test/v1/analytics/schedules/${id}/resume`, { method: "POST" }),
      env as never
    );
    expect(resume.status).toBe(400);
    const [row] = await ctx.db.select().from(schema.analyticsSchedules).where(eq(schema.analyticsSchedules.id, id));
    expect(row?.status).toBe("paused");

    const crud = new Hono<App>();
    crud.onError(onError);
    crud.use("*", async (c, next) => {
      c.set("ctx", ctx);
      await next();
    });
    crud.route("/", crudRouter(ANALYTICS.find((r) => r.path === "schedules")!));
    const rename = await crud.fetch(
      new Request(`http://api.test/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: "ar" })
      }),
      env as never
    );
    expect(rename.status).toBe(200);
    const activate = await crud.fetch(
      new Request(`http://api.test/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" })
      }),
      env as never
    );
    expect(activate.status).toBe(400);
  });
});

/* --------------------------------------------------------- unit economics */

describe("unit economics", () => {
  it("rejects a non-numeric `since` instead of silently dropping the filter", async () => {
    const res = await router().fetch(new Request("http://api.test/v1/analytics/unit-economics?since=banana"), env as never);
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------- row visibility by id */

// The class of bug: a list narrows to the rows you may see, the by-id handler
// next to it only checks the tenant. Knowing an id then beats the filter. Each
// pair below asserts the list and the by-id read give the same answer.

describe("dashboard visibility", () => {
  const reader = (roleKey: string, id = "u_test"): Ctx["actor"] => ({
    kind: "user",
    id,
    tenantId: "t_test",
    grants: [{ roleKey, permissions: ["analytics:dashboards:read", "axis:policies:read"] }]
  });

  async function dashboards(over: Partial<Ctx>): Promise<string[]> {
    const res = await router(over).fetch(new Request("http://api.test/v1/analytics/dashboards"), env as never);
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data.map((d) => d.id);
  }

  async function data(dashId: string, over: Partial<Ctx>): Promise<number> {
    const res = await router(over).fetch(
      new Request(`http://api.test/v1/analytics/dashboards/${dashId}/data`),
      env as never
    );
    return res.status;
  }

  it("refuses a role-restricted dashboard by id to an actor outside its roles", async () => {
    await seedDashboard({ id: "dsh_board", roles: ["north.board"] });
    const outsider = { actor: reader("axis.agent") };
    // The two must agree: invisible in the list, unreadable by id.
    expect(await dashboards(outsider)).toEqual([]);
    expect(await data("dsh_board", outsider)).toBe(404);
  });

  it("serves a role-restricted dashboard to an actor inside its roles", async () => {
    await seedPolicies();
    await seedDashboard({ id: "dsh_board", roles: ["north.board"] });
    const insider = { actor: reader("north.board") };
    expect(await dashboards(insider)).toEqual(["dsh_board"]);
    expect(await data("dsh_board", insider)).toBe(200);
  });

  it("keeps a personal dashboard to its owner", async () => {
    await seedPolicies();
    await seedDashboard({ id: "dsh_mine", scope: "personal", ownerRef: "user:u_owner" });
    const owner = { actor: reader("axis.agent", "u_owner") };
    expect(await dashboards(owner)).toEqual(["dsh_mine"]);
    expect(await data("dsh_mine", owner)).toBe(200);

    const other = { actor: reader("axis.agent", "u_other") };
    expect(await dashboards(other)).toEqual([]);
    expect(await data("dsh_mine", other)).toBe(404);
  });

  it("does not reach across tenants", async () => {
    await seedDashboard({ id: "dsh_theirs", tenantId: "t_other" });
    const here = { actor: reader("axis.agent") };
    expect(await dashboards(here)).toEqual([]);
    expect(await data("dsh_theirs", here)).toBe(404);
  });

  it("leaves an unrestricted dashboard readable to anyone who can read dashboards", async () => {
    await seedPolicies();
    await seedDashboard({ id: "dsh_all" });
    const anyone = { actor: reader("orbit.agent") };
    expect(await dashboards(anyone)).toEqual(["dsh_all"]);
    expect(await data("dsh_all", anyone)).toBe(200);
  });

  // The module router is not the only way in. Generated CRUD serves
  // `GET /v1/analytics/dashboards/:id` from the same table, and it honoured the
  // permission and the tenant but not the row rule — so the board's dashboard
  // was one URL away for anyone who could read any dashboard.
  it("applies the same rule through generated CRUD, not just the module router", async () => {
    await seedDashboard({ id: "dsh_board", roles: ["north.board"] });
    const crud = (over: Partial<Ctx>): Hono<App> => {
      const app = new Hono<App>();
      app.onError(onError);
      app.use("*", async (c, next) => {
        c.set("ctx", { ...ctx, ...over });
        await next();
      });
      app.route("/", crudRouter(ANALYTICS.find((r) => r.path === "dashboards")!));
      return app;
    };
    const url = new Request("http://api.test/dsh_board");
    expect((await crud({ actor: reader("axis.agent") }).fetch(url, env as never)).status).toBe(404);
    expect((await crud({ actor: reader("north.board") }).fetch(url, env as never)).status).toBe(200);
  });
});

describe("export visibility", () => {
  const downloader = (id: string): Ctx["actor"] => ({
    kind: "user",
    id,
    tenantId: "t_test",
    grants: [{ roleKey: "test", permissions: ["analytics:exports:download"] }]
  });

  async function get(path: string, over: Partial<Ctx>): Promise<Response> {
    return router(over).fetch(new Request(`http://api.test${path}`), env as never);
  }

  it("shows the register to a download-only actor", async () => {
    await seedExport({ id: "exp_mine", requestedBy: "user:u_owner" });
    const res = await get("/v1/analytics/exports", { actor: downloader("u_owner") });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string }[] }).data.map((e) => e.id)).toEqual(["exp_mine"]);
  });

  it("refuses another actor's export by id, exactly as the register hides it", async () => {
    await seedExport({ id: "exp_hers", requestedBy: "user:u_owner" });
    const them = { actor: downloader("u_other") };
    const list = (await (await get("/v1/analytics/exports", them)).json()) as { data: { id: string }[] };
    expect(list.data).toEqual([]);
    expect((await get("/v1/analytics/exports/exp_hers/download", them)).status).toBe(404);
  });

  it("lets an audit reader see and fetch any export in the tenant", async () => {
    await seedExport({ id: "exp_hers", requestedBy: "user:u_owner" });
    const auditor = {
      actor: {
        kind: "user" as const,
        id: "u_other",
        tenantId: "t_test",
        grants: [{ roleKey: "test", permissions: ["analytics:exports:download", "core:audit:read"] }]
      }
    };
    const list = (await (await get("/v1/analytics/exports", auditor)).json()) as { data: { id: string }[] };
    expect(list.data.map((e) => e.id)).toEqual(["exp_hers"]);
    expect((await get("/v1/analytics/exports/exp_hers/download", auditor)).status).toBe(200);
  });

  it("still delivers a scheduled artefact to the recipient it was filed with", async () => {
    await seedPolicies();
    await seedSchedule({ recipients: ["u_recipient"] });
    expect(await runDueSchedules(system(), bucket)).toBe(1);
    const exportId = (await ctx.db.select().from(schema.analyticsExports))[0]!.id;
    // The scheduler requested it, not the recipient — the inbox row is what
    // identifies them. It is not what authorises them: being sent a file is not
    // permission to read it, so the report's own permission still has to hold.
    const recipient = (permissions: string[]): Ctx["actor"] => ({
      kind: "user",
      id: "u_recipient",
      tenantId: "t_test",
      grants: [{ roleKey: "test", permissions }]
    });
    expect(
      (await get(`/v1/analytics/exports/${exportId}/download`, { actor: recipient(["analytics:exports:download"]) })).status
    ).toBe(404);
    expect(
      (
        await get(`/v1/analytics/exports/${exportId}/download`, {
          actor: recipient(["analytics:exports:download", "axis:policies:read"])
        })
      ).status
    ).toBe(200);
    // …and someone the schedule never named stays out either way.
    expect(
      (
        await get(`/v1/analytics/exports/${exportId}/download`, {
          actor: {
            kind: "user",
            id: "u_other",
            tenantId: "t_test",
            grants: [{ roleKey: "test", permissions: ["analytics:exports:download", "axis:policies:read"] }]
          }
        })
      ).status
    ).toBe(404);
  });

  // An export is the report's data in a file. Having asked for the file, or
  // having been sent it, is not authority to read it — otherwise an export is a
  // way around the report's own permission that outlives the role that made it.
  it("refuses an export whose report the actor cannot read, even to its requester", async () => {
    await ctx.db.insert(schema.reports).values({
      id: "rep_locked",
      tenantId: "t_test",
      key: "board",
      module: "north",
      nameJson: JSON.stringify({ en: "Board" }),
      definitionJson: JSON.stringify({ dataset: "policies", metrics: ["gwp"] }),
      piiLevel: "none",
      requiredPermission: "north:board:read",
      ownerRef: "user:u_owner",
      scope: "tenant",
      system: false,
      createdAt: NOW,
      updatedAt: NOW
    });
    await seedExport({ id: "exp_locked", requestedBy: "user:u_owner", reportId: "rep_locked" });
    // `downloader` holds `analytics:exports:download` and nothing else.
    expect((await get("/v1/analytics/exports/exp_locked/download", { actor: downloader("u_owner") })).status).toBe(404);

    const allowed: Ctx["actor"] = {
      kind: "user",
      id: "u_owner",
      tenantId: "t_test",
      grants: [{ roleKey: "test", permissions: ["analytics:exports:download", "north:board:read"] }]
    };
    expect((await get("/v1/analytics/exports/exp_locked/download", { actor: allowed })).status).toBe(200);
  });

  it("does not reach across tenants", async () => {
    await seedExport({ id: "exp_theirs", requestedBy: "user:u_owner", tenantId: "t_other" });
    expect((await get("/v1/analytics/exports/exp_theirs/download", { actor: downloader("u_owner") })).status).toBe(404);
  });
});

/* ------------------------------------------------- docs/25 §6 cost guards */

describe("usage metering", () => {
  it("adds each download to the day's egress and derives storage from live files", async () => {
    await seedExport({ id: "exp_u", requestedBy: "user:u_owner" });
    // A deleted file is not stored any more — it must not count.
    await ctx.db.insert(schema.files).values({
      id: "file_gone",
      tenantId: "t_test",
      r2Key: "gone",
      kind: "analytics_export",
      subjectRef: null,
      sha256: "x",
      sizeBytes: 1000,
      contentType: "text/csv",
      piiLevel: "none",
      createdAt: NOW,
      deletedAt: NOW
    });

    const download = () =>
      router({ actor: downloader("u_owner") }).fetch(
        new Request("http://api.test/v1/analytics/exports/exp_u/download"),
        env as never
      );
    expect((await download()).status).toBe(200);
    expect((await download()).status).toBe(200);

    const res = await router({ actor: actor(["analytics:reports:read"]) }).fetch(
      new Request("http://api.test/v1/analytics/usage"),
      env as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { storageBytes: number; egressDays: { day: string; bytes: number }[] } };
    expect(body.data.storageBytes).toBe(8);
    // Two 8-byte downloads on the same day land on one upserted counter row.
    expect(body.data.egressDays).toEqual([{ day: "2026-06-15", bytes: 16 }]);
  });

  const downloader = (id: string): Ctx["actor"] => ({
    kind: "user",
    id,
    tenantId: "t_test",
    grants: [{ roleKey: "test", permissions: ["analytics:exports:download"] }]
  });
});

describe("report visibility by id", () => {
  const writer: Ctx["actor"] = {
    kind: "user",
    id: "u_other",
    tenantId: "t_test",
    // Can write reports, cannot read the dataset the report is built on.
    grants: [{ roleKey: "test", permissions: ["analytics:reports:read", "analytics:reports:write"] }]
  };

  async function call(method: string, path: string, over: Partial<Ctx>, json?: unknown): Promise<number> {
    const res = await router(over).fetch(
      new Request(`http://api.test${path}`, {
        method,
        ...(json ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {})
      }),
      env as never
    );
    return res.status;
  }

  it("refuses PATCH and DELETE on a report the list would not show", async () => {
    await seedSchedule({}); // seeds rep_1, requiredPermission axis:policies:read
    const over = { actor: writer };
    const list = await router(over).fetch(new Request("http://api.test/v1/analytics/reports"), env as never);
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([]);
    expect(await call("PATCH", "/v1/analytics/reports/rep_1", over, { piiLevel: "low" })).toBe(403);
    expect(await call("DELETE", "/v1/analytics/reports/rep_1", over)).toBe(403);
  });

  it("refuses a run belonging to a report the caller cannot read", async () => {
    await seedSchedule({});
    await ctx.db.insert(schema.reportRuns).values({
      id: "run_1",
      tenantId: "t_test",
      reportId: "rep_1",
      paramsJson: "{}",
      requestedBy: "user:u_owner",
      trigger: "user",
      state: "done",
      truncated: false,
      startedAt: NOW,
      endedAt: NOW
    });
    expect(await call("GET", "/v1/analytics/runs/run_1", { actor: writer })).toBe(403);
    expect(await call("GET", "/v1/analytics/runs/run_1", {})).toBe(200);
  });
});

describe("report name round-trip", () => {
  it("returns the i18n maps PATCH accepts, so an edit form loads what it saves", async () => {
    await seedSchedule({});
    const res = await router().fetch(new Request("http://api.test/v1/analytics/reports/rep_1"), env as never);
    const report = (await res.json()) as { name: Record<string, string>; nameJson: string };
    expect(report.name).toEqual({ en: "Premium" });

    const patched = await router().fetch(
      new Request("http://api.test/v1/analytics/reports/rep_1", {
        method: "PATCH",
        body: JSON.stringify({ name: report.name, description: { en: "GWP" } }),
        headers: { "content-type": "application/json" }
      }),
      env as never
    );
    const after = (await patched.json()) as { name: Record<string, string>; description: Record<string, string> };
    expect(after.name).toEqual({ en: "Premium" });
    expect(after.description).toEqual({ en: "GWP" });
  });
});

/* -------------------------------------------------------------------- seeds */

async function seedDashboard(over: {
  id: string;
  roles?: string[];
  scope?: string;
  ownerRef?: string;
  tenantId?: string;
}): Promise<void> {
  await ctx.db.insert(schema.dashboards).values({
    id: over.id,
    tenantId: over.tenantId ?? "t_test",
    key: over.id,
    module: "axis",
    nameJson: JSON.stringify({ en: "Board" }),
    layoutJson: JSON.stringify({ tiles: [{ key: "gwp", viz: "number", span: 4, definition: { dataset: "policies", metrics: ["gwp"] } }] }),
    scope: over.scope ?? "tenant",
    ownerRef: over.ownerRef ?? "user:u_owner",
    rolesJson: over.roles ? JSON.stringify(over.roles) : null,
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function seedExport(over: {
  id: string;
  requestedBy: string;
  tenantId?: string;
  reportId?: string;
}): Promise<void> {
  const tenantId = over.tenantId ?? "t_test";
  stored.set(`exports/${tenantId}/${over.id}.csv`, new TextEncoder().encode("a,b\n1,2\n"));
  await ctx.db.insert(schema.files).values({
    id: `file_${over.id}`,
    tenantId,
    r2Key: `exports/${tenantId}/${over.id}.csv`,
    kind: "analytics_export",
    subjectRef: over.id,
    sha256: "x",
    sizeBytes: 8,
    contentType: "text/csv",
    piiLevel: "none",
    createdAt: NOW,
    deletedAt: null
  });
  await ctx.db.insert(schema.analyticsExports).values({
    id: over.id,
    tenantId,
    runId: `run_${over.id}`,
    reportId: over.reportId ?? null,
    subjectRef: null,
    format: "csv",
    fileId: `file_${over.id}`,
    sizeBytes: 8,
    rowCount: 1,
    piiMasked: true,
    piiJustification: null,
    watermark: null,
    requestedBy: over.requestedBy,
    approvedBy: null,
    state: "ready",
    downloadCount: 0,
    expiresAt: NOW + 7 * 24 * HOUR,
    error: null,
    createdAt: NOW,
    updatedAt: NOW
  });
}

/** The cron actor: a system principal with no grants at all. */
function system(): Ctx {
  return { ...ctx, actor: { kind: "system", id: "scheduler", tenantId: ctx.tenantId, grants: [] } };
}

async function seedPolicies(): Promise<void> {
  const base = {
    tenantId: "t_test",
    providerId: "prv_1",
    offeringId: "off_1",
    status: "active",
    currency: "AED",
    endAt: NOW + 365 * 24 * HOUR,
    commissionMinor: 0,
    createdAt: NOW,
    updatedAt: NOW
  };
  await ctx.db.insert(schema.axisPolicies).values([
    { ...base, id: "pol_1", policyNo: "P-1", customerId: "cus_1", premiumMinor: 125_00, startAt: NOW },
    { ...base, id: "pol_2", policyNo: "P-2", customerId: "cus_2", premiumMinor: 175_00, startAt: NOW + HOUR },
    { ...base, id: "pol_3", policyNo: "P-3", customerId: "cus_3", premiumMinor: 999_00, startAt: NOW, tenantId: "t_other" }
  ]);
}

async function seedSchedule(over: {
  recipients?: string[];
  status?: string;
  nextRunAt?: number;
  reportId?: string;
  format?: string;
  dimensions?: string[];
}): Promise<string> {
  if (!over.reportId) {
    await ctx.db.insert(schema.reports).values({
      id: "rep_1",
      tenantId: "t_test",
      key: "gwp",
      module: "axis",
      nameJson: JSON.stringify({ en: "Premium" }),
      definitionJson: JSON.stringify({
        dataset: "policies",
        metrics: ["gwp"],
        ...(over.dimensions ? { dimensions: over.dimensions } : {})
      }),
      piiLevel: "none",
      requiredPermission: "axis:policies:read",
      ownerRef: "user:u_owner",
      scope: "tenant",
      system: false,
      createdAt: NOW,
      updatedAt: NOW
    });
  }
  const id = "sch_1";
  await ctx.db.insert(schema.analyticsSchedules).values({
    id,
    tenantId: "t_test",
    reportId: over.reportId ?? "rep_1",
    dashboardId: null,
    nameJson: JSON.stringify({ en: "Weekly premium" }),
    cron: "0 6 * * *",
    timezone: "Asia/Dubai",
    format: over.format ?? "csv",
    recipientsJson: JSON.stringify(over.recipients ?? ["u_owner"]),
    paramsJson: null,
    locale: "en",
    status: over.status ?? "active",
    lastRunAt: null,
    lastState: null,
    nextRunAt: over.nextRunAt ?? NOW - HOUR,
    createdBy: "user:u_owner",
    createdAt: NOW,
    updatedAt: NOW
  });
  return id;
}
