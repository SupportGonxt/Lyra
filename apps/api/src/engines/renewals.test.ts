import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { assignCohort, churnScore, sweepRenewals } from "./renewals.js";

// docs/modules/orbit.md §2.2 + §8: "Renewal cohort A/B (auto vs control)
// instrumented from day one." The sweep raised a real renewal row already
// (docs/05 J-C3); this covers the part that was still a hardcoded literal —
// a real churn score and a real, reproducible cohort split.

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

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

/* --------------------------------------------------------- churnScore --- */

describe("churnScore", () => {
  it("scores a new customer with a claims history higher than a clean long-tenure one", () => {
    const risky = churnScore({
      tenureDays: 20,
      claimsCount: 3,
      daysSinceLastContact: 200,
      lastSentiment: -60
    });
    const clean = churnScore({
      tenureDays: 5 * 365,
      claimsCount: 0,
      daysSinceLastContact: 5,
      lastSentiment: 80
    });
    expect(risky).toBeGreaterThan(clean);
    expect(risky).toBeGreaterThan(70);
    expect(clean).toBeLessThan(20);
  });

  it("stays inside the 0-100 scale regardless of extreme inputs", () => {
    const maxed = churnScore({
      tenureDays: 0,
      claimsCount: 50,
      daysSinceLastContact: 10_000,
      lastSentiment: -100
    });
    expect(maxed).toBeLessThanOrEqual(100);
    expect(maxed).toBeGreaterThanOrEqual(0);

    const untouched = churnScore({
      tenureDays: 10_000,
      claimsCount: 0,
      daysSinceLastContact: null,
      lastSentiment: null
    });
    expect(untouched).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------------------------------------------- assignCohort --- */

describe("assignCohort", () => {
  it("is deterministic: the same renewal id and score always land in the same cohort", () => {
    const a = assignCohort("rnw_abc123", 30);
    const b = assignCohort("rnw_abc123", 30);
    expect(a).toBe(b);
  });

  it("routes a high churn-risk renewal to the human desk regardless of the hash", () => {
    for (const id of ["rnw_1", "rnw_2", "rnw_3", "rnw_4", "rnw_5"]) {
      expect(assignCohort(id, 90)).toBe("human");
    }
  });

  it("splits the low/mid-risk population across both cohorts, not into one bucket", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(assignCohort(`rnw_${i}`, 20));
    }
    expect(seen.has("human")).toBe(true);
    expect(seen.has("auto_requote")).toBe(true);
  });
});

/* --------------------------------------------------------- sweepRenewals --- */

describe("sweepRenewals term dedupe", () => {
  const DAY = 86_400_000;

  async function seedPolicy(): Promise<void> {
    await ctx.db.insert(schema.providers).values({
      id: "prov_1",
      tenantId: ctx.tenantId,
      name: "Test Insurer",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.customers).values({
      id: "cu_1",
      tenantId: ctx.tenantId,
      nameJson: JSON.stringify({ first: "Amina" }),
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: ctx.now - 345 * DAY,
      endAt: ctx.now + 20 * DAY,
      premiumMinor: 100_00,
      currency: "AED",
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
  }

  it("raises a fresh renewal this term even though last term's renewal row exists", async () => {
    await seedPolicy();
    // Last term's renewal, long since decided: its expiry is in the past.
    await ctx.db.insert(schema.orbitRenewals).values({
      id: "rnw_old",
      tenantId: ctx.tenantId,
      policyRef: "pol_1",
      customerId: "cu_1",
      expiryAt: ctx.now - 345 * DAY,
      strategy: "human",
      state: "accepted",
      createdAt: ctx.now - 380 * DAY,
      updatedAt: ctx.now - 345 * DAY
    });

    const raised = await sweepRenewals(ctx);
    expect(raised).toBe(1);

    const rows = await ctx.db.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.policyRef, "pol_1"));
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.expiryAt === ctx.now + 20 * DAY)).toBe(true);
  });

  it("does not duplicate an open renewal for the current term", async () => {
    await seedPolicy();
    await ctx.db.insert(schema.orbitRenewals).values({
      id: "rnw_open",
      tenantId: ctx.tenantId,
      policyRef: "pol_1",
      customerId: "cu_1",
      expiryAt: ctx.now + 20 * DAY,
      strategy: "human",
      state: "scheduled",
      createdAt: ctx.now - DAY,
      updatedAt: ctx.now - DAY
    });

    expect(await sweepRenewals(ctx)).toBe(0);
  });

  // Regression: the sweep raised the renewal row and announced nothing, so the
  // seeded renewal journey (which triggered on a never-emitted
  // `orbit.renewal.raised`) and the partner webhook subscribed to the
  // catalogue's `orbit.renewal.due` (docs/04 §7) could never hear of one.
  it("announces each renewal it raises as orbit.renewal.due, once", async () => {
    await seedPolicy();
    expect(await sweepRenewals(ctx)).toBe(1);
    expect(await sweepRenewals(ctx)).toBe(0);

    const due = (await ctx.db.select().from(schema.eventOutbox)).filter((e) => e.type === "orbit.renewal.due");
    expect(due).toHaveLength(1);
    const [row] = await ctx.db.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.policyRef, "pol_1"));
    const envelope = JSON.parse(due[0]!.envelopeJson);
    expect(envelope.subject).toBe(row!.id);
    // customerId is what a journey trigger enrols (orbit-journeys.ts onJourneyEvent).
    expect(envelope.data).toMatchObject({ policyRef: "pol_1", customerId: "cu_1", expiryAt: ctx.now + 20 * DAY });
    // SIGNAL's churn-risk prospects hear the score here, not by reading ORBIT (ADR-0091).
    expect(envelope.data.churnScore).toBe(row!.churnScore);
  });
});

describe("sweepRenewals cohort wiring", () => {
  it("raises a renewal with a computed churn score and a non-literal strategy", async () => {
    await ctx.db.insert(schema.providers).values({
      id: "prov_1",
      tenantId: ctx.tenantId,
      name: "Test Insurer",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.customers).values({
      id: "cu_1",
      tenantId: ctx.tenantId,
      nameJson: JSON.stringify({ first: "Amina" }),
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: ctx.now - 10 * 86_400_000, // brand new: high tenure risk
      endAt: ctx.now + 20 * 86_400_000,
      premiumMinor: 100_00,
      currency: "AED",
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.axisClaims).values([
      {
        id: "clm_1",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-1",
        reportedAt: ctx.now,
        currency: "AED",
        status: "settled",
        createdAt: ctx.now,
        updatedAt: ctx.now
      },
      {
        id: "clm_2",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-2",
        reportedAt: ctx.now,
        currency: "AED",
        status: "settled",
        createdAt: ctx.now,
        updatedAt: ctx.now
      }
    ]);

    const raised = await sweepRenewals(ctx);
    expect(raised).toBe(1);

    const [row] = await ctx.db.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.policyRef, "pol_1"));
    expect(row!.churnScore).not.toBeNull();
    expect(row!.churnScore!).toBeGreaterThan(0);
    expect(["auto_requote", "human"]).toContain(row!.strategy);
  });
});
