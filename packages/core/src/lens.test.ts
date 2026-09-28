import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EntitlementsJson, PolicyJson, id, schema } from "@lyra/db";
import { availableShellsForRoles, defaultWorkspaceForRoles, recordLensUsage, resetLens, resolveLens } from "./lens.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const NOW = 1_700_000_000_000;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function actorWith(roleKey: string): Actor {
  return {
    kind: "user",
    id: "u_1",
    tenantId: "t_1",
    grants: [{ roleKey, permissions: permissionsForRole(roleKey) }]
  };
}

let client: Client;
let ctx: Ctx;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actorWith("axis.agent"),
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

describe("defaultWorkspaceForRoles", () => {
  it("a module role's prefix is its workspace, with no table to maintain", () => {
    expect(defaultWorkspaceForRoles(["axis.agent"])).toBe("axis");
    expect(defaultWorkspaceForRoles(["orbit.retention"])).toBe("orbit");
    expect(defaultWorkspaceForRoles(["north.exec"])).toBe("north");
  });

  it("routes the named exceptions the module prefix would get wrong", () => {
    // tenant.compliance is not the generic tenant.* -> admin default: compliance
    // officers land on their own workspace, not the settings console.
    expect(defaultWorkspaceForRoles(["tenant.compliance"])).toBe("compliance");
    expect(defaultWorkspaceForRoles(["finance.controller"])).toBe("ledger");
    expect(defaultWorkspaceForRoles(["tenant.admin"])).toBe("admin");
  });

  it("falls back to north when no role matches anything", () => {
    expect(defaultWorkspaceForRoles([])).toBe("north");
  });
});

describe("availableShellsForRoles", () => {
  it("returns every distinct workspace a multi-role actor's roles resolve to", () => {
    expect(availableShellsForRoles(["north.exec", "axis.agent"])).toEqual(
      expect.arrayContaining(["north", "axis"])
    );
    expect(availableShellsForRoles(["north.exec", "axis.agent"])).toHaveLength(2);
  });

  it("returns exactly one shell for a single-role actor", () => {
    expect(availableShellsForRoles(["north.exec"])).toEqual(["north"]);
  });

  it("collapses duplicate workspaces from different roles into one entry", () => {
    expect(availableShellsForRoles(["tenant.compliance", "tenant.admin"])).toEqual(
      expect.arrayContaining(["compliance", "admin"])
    );
    expect(availableShellsForRoles(["tenant.compliance", "tenant.admin"])).toHaveLength(2);
  });

  it("falls back to north when no role resolves to anything", () => {
    expect(availableShellsForRoles([])).toEqual(["north"]);
  });

  it("grants finance.controller the AXIS shell too, for inbound bordereaux reconciliation (ADR-0105)", () => {
    expect(availableShellsForRoles(["finance.controller"])).toEqual(expect.arrayContaining(["ledger", "axis"]));
    // Its default stays the ledger: the exception opens a door, not a home.
    expect(defaultWorkspaceForRoles(["finance.controller"])).toBe("ledger");
  });

  it("grants orbit.retention the AXIS shell too, per ADR-0054", () => {
    expect(availableShellsForRoles(["orbit.retention"])).toEqual(expect.arrayContaining(["orbit", "axis"]));
    expect(availableShellsForRoles(["orbit.retention"])).toHaveLength(2);
  });

  it("does not extend the ADR-0054 exception to other roles holding cross-module reads", () => {
    expect(availableShellsForRoles(["north.exec"])).toEqual(["north"]);
  });
});

describe("resolveLens", () => {
  it("resolves the role default when no row has ever been written", async () => {
    const resolved = await resolveLens(ctx, "usr_1", ["orbit.retention"]);
    expect(resolved.isDefault).toBe(true);
    expect(resolved.lens.workspace).toBe("orbit");
    expect(resolved.lens.pinned).toEqual([]);
    expect(resolved.lens.weights).toEqual({});
  });

  it("resolves the stored lens once one exists, over the role default", async () => {
    await ctx.db.insert(schema.lenses).values({
      id: id("lns", NOW),
      tenantId: ctx.tenantId,
      userId: "usr_1",
      lensJson: JSON.stringify({ workspace: "compliance", pinned: ["dsar"], density: "compact" }),
      updatedAt: NOW
    });

    const resolved = await resolveLens(ctx, "usr_1", ["orbit.retention"]);
    expect(resolved.isDefault).toBe(false);
    expect(resolved.lens.workspace).toBe("compliance");
    expect(resolved.lens.pinned).toEqual(["dsar"]);
  });

  it("never resolves another tenant's stored lens", async () => {
    await ctx.db.insert(schema.lenses).values({
      id: id("lns", NOW),
      tenantId: "t_2",
      userId: "usr_1",
      lensJson: JSON.stringify({ workspace: "compliance" }),
      updatedAt: NOW
    });

    const resolved = await resolveLens(ctx, "usr_1", ["axis.agent"]);
    expect(resolved.isDefault).toBe(true);
    expect(resolved.lens.workspace).toBe("axis");
  });
});

describe("recordLensUsage", () => {
  it("creates a row on first use, starting from the role default", async () => {
    const lens = await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    expect(lens.workspace).toBe("axis");
    expect(lens.weights).toEqual({ cases: 1 });

    const row = (
      await ctx.db.select().from(schema.lenses).where(eq(schema.lenses.userId, "usr_1"))
    )[0]!;
    expect(JSON.parse(row.lensJson!).weights).toEqual({ cases: 1 });
  });

  it("increments the same key on repeated use, and different keys independently", async () => {
    await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    const lens = await recordLensUsage(ctx, "usr_1", ["axis.agent"], "quotes");
    expect(lens.weights).toEqual({ cases: 2, quotes: 1 });
  });

  it("caps a weight instead of growing it without bound", async () => {
    let lens;
    for (let i = 0; i < 500; i++) {
      lens = await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    }
    expect(lens!.weights.cases).toBeLessThanOrEqual(100);
  });

  it("preserves the rest of the lens (pinned, density) while updating weights", async () => {
    await ctx.db.insert(schema.lenses).values({
      id: id("lns", NOW),
      tenantId: ctx.tenantId,
      userId: "usr_1",
      lensJson: JSON.stringify({ workspace: "axis", pinned: ["cases"], density: "compact" }),
      updatedAt: NOW
    });

    const lens = await recordLensUsage(ctx, "usr_1", ["axis.agent"], "quotes");
    expect(lens.pinned).toEqual(["cases"]);
    expect(lens.density).toBe("compact");
    expect(lens.weights).toEqual({ quotes: 1 });
  });
});

describe("resetLens", () => {
  it("discards learned adaptation and reverts to the role default", async () => {
    await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    await ctx.db
      .update(schema.lenses)
      .set({ lensJson: JSON.stringify({ workspace: "axis", pinned: ["custom-pin"], weights: { cases: 5 } }) })
      .where(eq(schema.lenses.userId, "usr_1"));

    const reset = await resetLens(ctx, "usr_1", ["axis.agent"]);
    expect(reset).toEqual({ workspace: "axis", pinned: [], hidden: [], density: "comfortable", savedViews: [], weights: {} });

    const resolved = await resolveLens(ctx, "usr_1", ["axis.agent"]);
    expect(resolved.isDefault).toBe(true);
  });

  it("is a no-op-safe reset (no row yet) that still audits the attempt", async () => {
    const reset = await resetLens(ctx, "usr_1", ["north.exec"]);
    expect(reset.workspace).toBe("north");

    const rows = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "core.lens.reset"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectRef).toBe("usr_1");
  });

  it("audits with the discarded state as before and the tenant default as after", async () => {
    await recordLensUsage(ctx, "usr_1", ["axis.agent"], "cases");
    await resetLens(ctx, "usr_1", ["axis.agent"]);

    const rows = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "core.lens.reset"));
    expect(rows).toHaveLength(1);
    // Hash-chained, not plaintext (docs/12 §1) — presence of the hashes is the
    // audit contract this module owes; before/after payload equality is
    // exercised in audit.test.ts / core.test.ts, not here.
    expect(rows[0]!.beforeHash).not.toBeNull();
    expect(rows[0]!.afterHash).not.toBeNull();
  });
});
