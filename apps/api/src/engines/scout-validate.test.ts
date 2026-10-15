import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { onExperimentConcluded, verdictOf } from "./scout-validate.js";

// The validation half of the SCOUT loop. These tests pin the contract the
// radar stands on: a concluded experiment decides its whitespace's fate
// deterministically (significant + non-negative lift = validated, anything
// else parked), terminal whitespaces are never reopened, and the whole chain
// is emitted + audited so "validated by live data" is a claim with a paper
// trail.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function actor(): Actor {
  return {
    kind: "system",
    id: "scheduler",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

async function makeCtx(now = 1_700_000_000_000): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}
import { drizzle } from "drizzle-orm/libsql";

async function seedWhitespace(status: string): Promise<string> {
  const id = `wsp_${status}_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.db.insert(schema.scoutWhitespaces).values({
    id,
    tenantId: "t_1",
    category: "motor",
    description: "A gap worth testing",
    status,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  return id;
}

async function seedExperiment(whitespaceId: string, results: object | null, state = "concluded"): Promise<{ id: string; whitespaceId: string; state: string; resultsJson: string | null }> {
  const id = `sxp_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.db.insert(schema.scoutExperiments).values({
    id,
    tenantId: "t_1",
    whitespaceId,
    resultsJson: results === null ? null : JSON.stringify(results),
    state,
    concludedAt: state === "concluded" ? ctx.now : null,
    createdAt: ctx.now
  });
  return { id, whitespaceId, state, resultsJson: results === null ? null : JSON.stringify(results) };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

describe("verdictOf", () => {
  it("validates significant non-negative lift", () => {
    expect(verdictOf({ significant: true, liftBps: 1_200 })).toBe("validated");
    expect(verdictOf({ significant: true, liftBps: 0 })).toBe("validated");
  });

  it("parks insignificant lift however large", () => {
    expect(verdictOf({ significant: false, liftBps: 5_000 })).toBe("parked");
  });

  it("parks a statistically confident failure", () => {
    expect(verdictOf({ significant: true, liftBps: -800 })).toBe("parked");
  });

  it("parks missing or malformed results — fail closed", () => {
    expect(verdictOf(null)).toBe("parked");
    expect(verdictOf({})).toBe("parked");
  });
});

describe("onExperimentConcluded", () => {
  it("stamps validated and emits the event for a winning experiment", async () => {
    const whitespaceId = await seedWhitespace("validating");
    const experiment = await seedExperiment(whitespaceId, { significant: true, liftBps: 1_500 });

    expect(await onExperimentConcluded(ctx, experiment)).toBe(true);
    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, whitespaceId));
    expect(row?.status).toBe("validated");
  });

  it("parks the whitespace when the experiment is inconclusive", async () => {
    const whitespaceId = await seedWhitespace("validating");
    const experiment = await seedExperiment(whitespaceId, { significant: false, liftBps: 300 });

    expect(await onExperimentConcluded(ctx, experiment)).toBe(true);
    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, whitespaceId));
    expect(row?.status).toBe("parked");
  });

  it("never reopens a terminal whitespace — a second experiment changes nothing", async () => {
    const whitespaceId = await seedWhitespace("parked");
    const experiment = await seedExperiment(whitespaceId, { significant: true, liftBps: 9_999 });

    expect(await onExperimentConcluded(ctx, experiment)).toBe(false);
    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, whitespaceId));
    expect(row?.status).toBe("parked");
  });

  it("ignores experiments that have not concluded", async () => {
    const whitespaceId = await seedWhitespace("validating");
    const experiment = await seedExperiment(whitespaceId, { significant: true, liftBps: 1_500 }, "running");

    expect(await onExperimentConcluded(ctx, experiment)).toBe(false);
    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, whitespaceId));
    expect(row?.status).toBe("validating");
  });

  it("is tenant-scoped: another tenant's whitespace is not stamped", async () => {
    const whitespaceId = await seedWhitespace("validating");
    const experiment = await seedExperiment(whitespaceId, { significant: true, liftBps: 1_500 });
    const other = { ...(await makeCtx()), tenantId: "t_2" };

    expect(await onExperimentConcluded(other, experiment)).toBe(false);
    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, whitespaceId));
    expect(row?.status).toBe("validating");
  });
});
