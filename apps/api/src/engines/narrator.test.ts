import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { buildSnapshot, generateBriefing, nightlyBriefing, verifyNumericClaims } from "./narrator.js";
import { BY_MODULE } from "../resources.js";

// The seed leaves {2026-01-06, exec, en} free specifically for this engine to
// fill (packages/core/src/seed.ts's comment on the fake `north_briefings`
// rows). `now` defaults to that exact morning, so every test below narrates
// "yesterday" (2026-01-05) and "this month so far" (2026-01) against the
// fixture values seed.ts actually wrote.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;
let tenantId: string;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "narrator-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "user",
      id: "u_1",
      tenantId,
      grants: [{ roleKey: "axis.agent", permissions: permissionsForRole("axis.agent") }]
    },
    requestId: "req_1",
    now: Date.UTC(2026, 0, 6, 8, 0, 0),
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

function stubbedGateway(replies?: string[]): { stub: ReturnType<typeof makeStub>; gw: Gateway } {
  const stub = makeStub(replies ? { replies } : {});
  return { stub, gw: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } }) };
}

describe("buildSnapshot", () => {
  it("reads yesterday's day-grain figures and this month's month-grain figures, with deltas", async () => {
    const snapshot = await buildSnapshot(ctx, "2026-01-06");

    const policies = snapshot.metrics.find((m) => m.metricKey === "policies_issued");
    expect(policies).toBeDefined();
    expect(policies!.period).toBe("2026-01-05");
    expect(policies!.value).toBe(57);
    expect(policies!.previousPeriod).toBe("2026-01-04");
    expect(policies!.previousValue).toBe(61);
    expect(policies!.deltaBps).toBe(Math.round(((57 - 61) / 61) * 10_000));

    const bindRate = snapshot.metrics.find((m) => m.metricKey === "quote_to_bind_rate");
    expect(bindRate!.value).toBe(1_890);
    expect(bindRate!.previousValue).toBe(2_360);

    const gwp = snapshot.metrics.find((m) => m.metricKey === "gwp");
    expect(gwp).toBeDefined();
    expect(gwp!.grain).toBe("month");
    expect(gwp!.period).toBe("2026-01");
    expect(gwp!.value).toBe(74_300_000);
    expect(gwp!.previousPeriod).toBe("2025-12");
    expect(gwp!.previousValue).toBe(238_900_000);
    expect(gwp!.deltaBps).toBe(Math.round(((74_300_000 - 238_900_000) / 238_900_000) * 10_000));
  });

  it("skips a metric with no rolled-up snapshot for the period instead of throwing", async () => {
    // A date far outside the seeded window has no day-grain rows at all.
    const snapshot = await buildSnapshot(ctx, "2099-01-01");
    expect(snapshot.metrics.find((m) => m.grain === "day")).toBeUndefined();
  });
});

describe("verifyNumericClaims", () => {
  it("passes a briefing whose numbers all trace back to the snapshot", async () => {
    const snapshot = await buildSnapshot(ctx, "2026-01-06");
    const text =
      "Policies issued yesterday were 57, down from 61 the day before. " +
      "The quote-to-bind rate fell to 18.9%, from 23.6%. " +
      "Gross written premium this month so far is AED 743,000.00, well behind December's AED 2,389,000.00 pace.";
    const result = verifyNumericClaims(text, snapshot);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("catches a deliberately-wrong number planted in the prose", async () => {
    const snapshot = await buildSnapshot(ctx, "2026-01-06");
    const text =
      "Policies issued yesterday were 999, down from 61 the day before. " + // 999 is wrong — should be 57
      "The quote-to-bind rate fell to 18.9%, from 23.6%.";
    const result = verifyNumericClaims(text, snapshot);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain(999);
  });
});

describe("generateBriefing", () => {
  it("generates, verifies and persists a clean briefing as review-ready", async () => {
    const { stub, gw } = stubbedGateway([
      "Policies issued yesterday were 57, down from 61 the day before. " +
        "Gross written premium this month so far is AED 743,000.00."
    ]);

    const result = await generateBriefing(ctx, gw, { date: "2026-01-06" });

    expect(result.status).toBe("review");
    expect(result.mismatches).toEqual([]);
    expect(stub.calls[0]!.module).toBe("north");
    expect(stub.calls[0]!.purpose).toBe("briefing.generate");
    expect(stub.calls[0]!.tier).toBe("reasoning");

    const [row] = await ctx.db
      .select()
      .from(schema.northBriefings)
      .where(and(eq(schema.northBriefings.tenantId, tenantId), eq(schema.northBriefings.id, result.id)));
    expect(row).toBeDefined();
    expect(row!.date).toBe("2026-01-06");
    expect(row!.audience).toBe("exec");
    expect(row!.locale).toBe("en");
    expect(row!.status).toBe("review");
    expect(row!.narrativeRef).toContain("57");
    expect(row!.aiAuditId).toBe(result.auditId);
    expect(row!.approvedBy).toBeNull();

    const [audit] = await ctx.db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.id, result.auditId));
    expect(audit).toBeDefined();
    expect(audit!.module).toBe("north");
    expect(audit!.tenantId).toBe(tenantId);
  });

  it("keeps a briefing with an unverifiable number in draft, never review", async () => {
    const { gw } = stubbedGateway(["Policies issued yesterday were 4321, a record high."]); // 4321 matches nothing

    const result = await generateBriefing(ctx, gw, { date: "2026-01-06", audience: "board" });

    expect(result.status).toBe("draft");
    expect(result.mismatches).toContain(4321);

    const [row] = await ctx.db
      .select()
      .from(schema.northBriefings)
      .where(and(eq(schema.northBriefings.tenantId, tenantId), eq(schema.northBriefings.id, result.id)));
    expect(row!.status).toBe("draft");
    expect(row!.approvedBy).toBeNull();
  });
});

// docs/30 NORTH gap 1. The brief existed only when someone pressed Generate;
// the nightly window now writes yesterday's, once, beside the snapshot. It is
// still never published by a machine (rule 4): a person moves it to published,
// and that transition — only that one — announces north.briefing.published.
describe("the nightly brief", () => {
  it("writes yesterday's exec brief once, and does nothing when it exists", async () => {
    const night = { ...ctx, now: Date.parse("2026-01-08T02:00:00Z") };
    const { stub, gw } = stubbedGateway(["A quiet day."]);
    const first = await nightlyBriefing(night, gw);
    expect(first).toMatchObject({ status: expect.stringMatching(/review|draft/) });
    const [row] = await ctx.db.select().from(schema.northBriefings).where(eq(schema.northBriefings.id, first!.id));
    expect(row).toMatchObject({ date: "2026-01-07", audience: "exec", locale: "en", approvedBy: null, publishedAt: null });
    expect(await nightlyBriefing(night, gw)).toBeNull();
    expect(stub.calls).toHaveLength(1);
  });
});

describe("publishing a brief", () => {
  const briefings = BY_MODULE.north!.find((r) => r.path === "briefings")!;
  const write = (values: Record<string, unknown>, existing: Record<string, unknown>) =>
    Promise.resolve().then(() => briefings.beforeWrite!(ctx, values, existing, {} as never));

  it("publishes only a verified brief, stamping who and when", async () => {
    await expect(write({ status: "published" }, { status: "draft" })).rejects.toMatchObject({ status: 409 });
    const values = await write({ status: "published" }, { status: "review" });
    expect(values).toMatchObject({ status: "published", approvedBy: `${ctx.actor.kind}:${ctx.actor.id}`, publishedAt: ctx.now });
  });

  it("announces north.briefing.published on the transition, and not on a later edit", async () => {
    const published = () =>
      ctx.db.select().from(schema.eventOutbox).then((rows) => rows.map((e) => JSON.parse(e.envelopeJson)).filter((e) => e.type === "north.briefing.published"));
    const row = { id: "brf_x", date: "2026-01-05", audience: "exec", locale: "en", status: "published" };
    await briefings.afterWrite!(ctx, row, "update", { ...row, status: "review" });
    await briefings.afterWrite!(ctx, row, "update", row);
    expect((await published()).map((e) => e.data)).toEqual([{ id: "brf_x", date: "2026-01-05", audience: "exec", locale: "en" }]);
  });
});
