import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { notFound, permissionsForRole, type Ctx } from "@lyra/core";
import { BY_MODULE } from "./resources.js";
import { crudRouter, type Resource } from "./crud.js";
import { onError } from "./mw.js";
import type { App } from "./env.js";

// docs/modules/axis.md §2.3: `axis_process_events` feeds the live process map —
// bottlenecks, rework loops — and `caseHistory`, which the SLA sentinel turns into
// a breach prediction. Before this, **nothing in production wrote the table**: the
// only writers were the seed and one test fixture, so the map was as live as the
// seed and every prediction ran on an empty history.
//
// The writer sits on the cases resource's `afterWrite` because every case write
// goes through it, and these tests are about the three things it must get right:
// it records a real step, it does *not* record a write that moved nothing, and it
// reads rework from the declared state machine rather than a second list.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";
const MINUTE = 60_000;

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const statement of statements()) await client.execute(statement);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "user", id: "u_lead", tenantId: TENANT, grants: [{ roleKey: "axis.lead", permissions: permissionsForRole("axis.lead") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

const find = (module: string, path: string): Resource => {
  const resource = BY_MODULE[module]?.find((r) => r.path === path);
  if (!resource) throw new Error(`no ${module}/${path} resource`);
  return resource;
};

/** The cases router, with the clock the test controls. */
function router(now = NOW): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, now });
    await next();
  });
  app.route("/", crudRouter(find("axis", "cases")));
  return app;
}

async function call(app: Hono<App>, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    })
  );
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
}

const created = () =>
  call(router(), "POST", "/", {
    ref: "CASE-0001",
    kind: "quote",
    status: "intake",
    source: "web",
    ownerRef: "user:1"
  });

const events = () =>
  ctx.db.select().from(schema.axisProcessEvents).where(and(eq(schema.axisProcessEvents.tenantId, TENANT)));

describe("a case write records a process step", () => {
  it("opens the case with the seed's own first step name, and no duration for it", async () => {
    // `case_opened` is what the seed writes and what the readers already know;
    // and a duration for the first step would be a measurement of nothing.
    const response = await created();
    expect(response.status).toBe(201);
    const [event] = await events();
    expect(event).toMatchObject({ caseId: response.body.id, step: "case_opened", outcome: "ok", durationMs: null });
    expect(event!.actorRef).toContain("u_lead");
  });

  it("records each stage the case moves through, with the step's own duration", async () => {
    const { body } = await created();
    await call(router(NOW + 5 * MINUTE), "PATCH", `/${body.id}`, { status: "quoting" });
    await call(router(NOW + 12 * MINUTE), "PATCH", `/${body.id}`, { status: "review" });

    const rows = (await events()).sort((a, b) => a.ts - b.ts);
    expect(rows.map((r) => r.step)).toEqual(["case_opened", "quoting", "review"]);
    expect(rows.map((r) => r.durationMs)).toEqual([null, 5 * MINUTE, 7 * MINUTE]);
    expect(rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok"]);
  });

  it("does not record a write that moved nothing", async () => {
    // Editing a note is not a stage of the pipeline. Without this guard the map
    // would fill with steps a reader cannot act on.
    const { body } = await created();
    await call(router(NOW + MINUTE), "PATCH", `/${body.id}`, { priority: "high" });
    await call(router(NOW + 2 * MINUTE), "PATCH", `/${body.id}`, { status: "intake" });
    const rows = await events();
    expect(rows.map((r) => r.step)).toEqual(["case_opened"]);
  });

  it("calls a move backwards through the machine rework", async () => {
    // §2.3 asks the map to surface rework loops, and the machine declares which
    // moves those are: `review → awaiting_docs` is one, `review → approval` is not.
    const { body } = await created();
    await call(router(NOW + MINUTE), "PATCH", `/${body.id}`, { status: "quoting" });
    await call(router(NOW + 2 * MINUTE), "PATCH", `/${body.id}`, { status: "awaiting_docs" });
    await call(router(NOW + 3 * MINUTE), "PATCH", `/${body.id}`, { status: "review" });
    await call(router(NOW + 4 * MINUTE), "PATCH", `/${body.id}`, { status: "awaiting_docs" });

    const rows = (await events()).sort((a, b) => a.ts - b.ts);
    expect(rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok", "rework"]);
    // The step is named for where it landed, which is what a bottleneck read needs.
    expect(rows.at(-1)!.step).toBe("awaiting_docs");
  });

  it("records a failed case as failed rather than as another ok", async () => {
    const { body } = await created();
    await call(router(NOW + MINUTE), "PATCH", `/${body.id}`, { status: "quoting" });
    await call(router(NOW + 2 * MINUTE), "PATCH", `/${body.id}`, { status: "review" });
    await call(router(NOW + 3 * MINUTE), "PATCH", `/${body.id}`, { status: "failed" });
    const rows = (await events()).sort((a, b) => a.ts - b.ts);
    expect(rows.at(-1)!.outcome).toBe("failed");
  });

  it("keeps one case's history apart from another's", async () => {
    const first = await created();
    await ctx.db.insert(schema.axisCases).values({
      id: "cas_other", tenantId: TENANT, ref: "CASE-0002", kind: "quote", status: "intake", source: "web", ownerRef: "user:1", createdAt: NOW, updatedAt: NOW
    });
    await call(router(NOW + MINUTE), "PATCH", "/cas_other", { status: "quoting" });
    const mine = (await events()).filter((r) => r.caseId === first.body.id);
    expect(mine).toHaveLength(1);
    expect(await events()).toHaveLength(2);
  });
});
