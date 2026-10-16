import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { BY_MODULE } from "./resources.js";
import { crudRouter, type Resource } from "./crud.js";
import type { App } from "./env.js";
import { onError } from "./mw.js";
import { notFound } from "@lyra/core";

// Three permissions were declared in `rbac.ts`, granted to roles, and required
// by nothing: `signal:campaigns:pause`, `signal:budget_moves:reverse` and
// `signal:creatives:publish`. The first two ride the generic resource PATCH, so
// the coarse `:update`/`:approve` permission carried them and the finer grant
// did nothing. A permission is a promise to whoever configures a role — that
// granting it does something — so each is now required on the transition that
// needs it, and these are the tests that demand it.
//
// `signal:creatives:publish` was worse than decorative: the publish route asked
// for `signal:creatives:approve`, which `tenant.compliance` holds, while
// `signal.lead` — whose job publishing is — holds `:publish`. The growth lead was
// refused by their own permission.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.UTC(2026, 9, 1, 9);
const TENANT = "t_test";

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
    actor: { kind: "user", id: "u_test", tenantId: TENANT, grants: [{ roleKey: "test", permissions: ["*:*:*"] }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({ autoApprove: ["signal.budget_move", "signal.campaign_launch"] }),
    entitlements: EntitlementsJson.parse({})
  };
});

function router(resource: Resource, permissions: string[]): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", {
      ...ctx,
      actor: { kind: "user", id: "u_role", tenantId: TENANT, grants: [{ roleKey: "test", permissions }] }
    });
    await next();
  });
  app.route("/", crudRouter(resource));
  return app;
}

async function patch(app: Hono<App>, path: string, payload: unknown) {
  const response = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  return response.status;
}

const find = (module: string, path: string): Resource => {
  const resource = BY_MODULE[module]?.find((r) => r.path === path);
  if (!resource) throw new Error(`no ${module}/${path} resource`);
  return resource;
};

describe("stopping a campaign is its own capability", () => {
  beforeEach(async () => {
    await ctx.db.insert(schema.signalCampaigns).values({
      id: "cmp_1",
      tenantId: TENANT,
      name: "Motor — always-on search",
      objective: "acq",
      channelsJson: JSON.stringify(["meta"]),
      budgetJson: JSON.stringify({ currency: "AED" }),
      state: "live",
      autonomyLevel: "act_with_approval",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
  });

  it("refuses a pause from a role that may edit a campaign but not stop one", async () => {
    // `signal:campaigns:update` is exactly what carried the transition before.
    const app = router(find("signal", "campaigns"), ["signal:campaigns:read", "signal:campaigns:update"]);
    expect(await patch(app, "/cmp_1", { state: "paused" })).toBe(403);
    const [row] = await ctx.db.select().from(schema.signalCampaigns);
    expect(row!.state).toBe("live");
  });

  it("allows it for the role that holds the capability", async () => {
    const app = router(find("signal", "campaigns"), ["signal:campaigns:read", "signal:campaigns:update", "signal:campaigns:pause"]);
    expect(await patch(app, "/cmp_1", { state: "paused" })).toBe(200);
  });

  it("leaves every other transition on the update permission", async () => {
    // The finer check is on the pause transition only; editing a live campaign
    // must not start needing a permission it never needed.
    const app = router(find("signal", "campaigns"), ["signal:campaigns:read", "signal:campaigns:update"]);
    expect(await patch(app, "/cmp_1", { name: "Motor — always-on search (v2)" })).toBe(200);
  });
});

describe("reversing a budget move is its own capability", () => {
  beforeEach(async () => {
    await ctx.db.insert(schema.signalBudgetMoves).values({
      id: "bmv_1",
      tenantId: TENANT,
      fromRef: "signal_campaign:cmp_1",
      toRef: "channel:meta",
      amountMinor: 50_000,
      currency: "AED",
      reason: "shift to the cheaper channel",
      approvedBy: "user:1",
      // The seven-day window (docs/19): the row cannot be reversed after it.
      reversibleUntil: NOW + 7 * 86_400_000,
      ts: NOW
    });
  });

  it("refuses a reversal from a role that may approve a move but not pull one back", async () => {
    const app = router(find("signal", "budget-moves"), ["signal:budget_moves:read", "signal:budget_moves:approve"]);
    expect(await patch(app, "/bmv_1", { reversedAt: NOW, reversedBy: "user:1" })).toBe(403);
    const [row] = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(row!.reversedAt).toBeNull();
  });

  it("allows it for the role that holds the capability", async () => {
    const app = router(find("signal", "budget-moves"), [
      "signal:budget_moves:read",
      "signal:budget_moves:approve",
      "signal:budget_moves:reverse"
    ]);
    expect(await patch(app, "/bmv_1", { reversedAt: NOW, reversedBy: "user:1" })).toBe(200);
    const [row] = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(row!.reversedAt).toBe(NOW);
  });

  it("does not re-ask on a move that is already reversed", async () => {
    // The check is on the transition, not on the field being present, or a
    // re-save of an already-reversed row would demand a permission it no longer
    // concerns.
    await ctx.db.update(schema.signalBudgetMoves).set({ reversedAt: NOW - 1000, reversedBy: "user:2" });
    const app = router(find("signal", "budget-moves"), ["signal:budget_moves:read", "signal:budget_moves:approve"]);
    expect(await patch(app, "/bmv_1", { reason: "noted after the fact" })).toBe(200);
  });
});
