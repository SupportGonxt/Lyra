import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, id as newId, schema } from "@lyra/db";
import { notFound, pendingOutbox, type Ctx } from "@lyra/core";
import { seedTestChart } from "@lyra/ledger/test-chart";
import {
  cancelPlan,
  createPlan,
  payInstalment,
  sweepPremiumFinancing,
  DUNNING_LAPSE_THRESHOLD,
  type PaymentPlanRow,
  type PolicyRow
} from "./engines/premium-financing.js";
import { onFinancingLapseDue, reinstatePolicy } from "./engines/axis-lifecycle.js";
import { drainOutbox } from "./dispatch.js";
import { axisRoutes } from "./routes/axis.js";
import { crudRouter } from "./crud.js";
import { BY_MODULE } from "./resources.js";
import { onError } from "./mw.js";
import type { App } from "./env.js";

// docs/27 group D — premium financing createPlan(). Flat/local-helper
// convention (no shared fixtures export seedTenantAndPolicy/testCtx in this
// codebase state — modeled on packages/ledger/src/posting.test.ts's testCtx
// and apps/api/src/engines/axis-fnol.test.ts's direct-insert seedPolicy).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A second contract in the same tenant — one policy may hold only one plan (C3). */
async function seedPolicy(ctx: Ctx, currency: string): Promise<PolicyRow> {
  const policyId = newId("pol", ctx.now);
  await ctx.db.insert(schema.axisPolicies).values({
    id: policyId,
    tenantId: ctx.tenantId,
    customerId: `cust_${policyId}`,
    providerId: "prov_test",
    policyNo: `POL-${policyId}`,
    versionSeq: 1,
    startAt: ctx.now - 30 * 86_400_000,
    endAt: ctx.now + 335 * 86_400_000,
    premiumMinor: 100_000,
    // Gross is premium plus tax/fees, and gross is what a financier advances —
    // so it is the ceiling createPlan enforces on totalMinor.
    grossMinor: 120_000,
    currency,
    status: "active",
    createdAt: ctx.now,
    updatedAt: ctx.now
  } as never);
  const [policy] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policyId));
  return policy!;
}

async function seedTenantAndPolicy(opts: { currency: string }): Promise<{ ctx: Ctx; policy: PolicyRow }> {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const tenantId = "t_test";
  const now = Date.UTC(2026, 5, 15, 12);
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: { kind: "user", id: "u_test", tenantId, grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now,
    locale: "en",
    policy: PolicyJson.parse({ currency: opts.currency }),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);

  return { ctx, policy: await seedPolicy(ctx, opts.currency) };
}

/**
 * A minimal router with a fixed ctx, mirroring resources.test.ts's `router()`
 * helper — the full `app` from ./index.js authenticates over a real session
 * (axis-lifecycle.test.ts's login flow), which this file's flat convention
 * has no fixture for. Mounting the real axisRoutes and the real
 * ledger/payment-plans resource under their real paths, with ctx injected
 * directly, exercises the actual route/permission wiring without the login
 * detour.
 */
function testApp(ctx: Ctx): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/v1/axis", axisRoutes);
  const paymentPlans = BY_MODULE.ledger?.find((r) => r.path === "payment-plans");
  if (!paymentPlans) throw new Error("no ledger/payment-plans resource");
  app.route("/v1/ledger/payment-plans", crudRouter(paymentPlans));
  return app;
}

const DAY = 86_400_000;

/**
 * The non-payment signal (ADR-0066): a `ledger_payments` row scoped to the
 * instalment by `providerRef = "<planId>:<seq>"`. Nothing in production writes
 * these yet — a PSP/financier settlement intake is the follow-up work — so the
 * tests are the seam's only writer today.
 */
async function insertPayment(
  ctx: Ctx,
  planId: string,
  seq: number,
  state: string,
  opts: { at?: number; id?: string } = {}
): Promise<void> {
  const at = opts.at ?? ctx.now;
  await ctx.db.insert(schema.ledgerPayments).values({
    id: opts.id ?? newId("pay", at + seq),
    tenantId: ctx.tenantId,
    direction: "in",
    method: "bank",
    providerRef: `${planId}:${seq}`,
    amountMinor: 10_000,
    currency: "AED",
    state,
    failureCode: state === "failed" ? "insufficient_funds" : null,
    createdAt: at,
    updatedAt: at
  } as never);
}

async function reread(ctx: Ctx, planId: string): Promise<PaymentPlanRow> {
  const [row] = await ctx.db
    .select()
    .from(schema.ledgerPaymentPlans)
    .where(eq(schema.ledgerPaymentPlans.id, planId));
  return row!;
}

const txnsOfType = (ctx: Ctx, type: string) =>
  ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.type, type));

describe("createPlan", () => {
  it("opens a non-financial PLAN-CREATE txn, chains a balanced FIN-CMSN commission, and stores the schedule", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const now = ctx.now;

    const { plan, txn } = await createPlan(ctx, policy, {
      totalMinor: 120_000,
      currency: "AED",
      instalments: 12,
      startAt: now,
      frequencyDays: 30,
      commissionMinor: 15_000,
      commissionTaxMinor: 700
    });

    expect(plan.subjectRef).toBe(`policy:${policy.id}`);
    expect(plan.totalMinor).toBe(120_000);
    expect(plan.state).toBe("active");
    expect(plan.missedStreak).toBe(0);
    const schedule = JSON.parse(plan.scheduleJson);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]).toEqual({ seq: 1, dueAt: now, amountMinor: 10_000, state: "pending" });
    expect(schedule[11].dueAt).toBe(now + 11 * 30 * DAY);

    // PLAN-CREATE itself is non-financial (no lines); the chained FIN-CMSN txn
    // carries the balanced double-entry, so look it up via parentTxnId.
    const child = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(eq(schema.ledgerTxns.parentTxnId, txn.id));
    expect(child).toHaveLength(1);
    const [childTxn] = child;
    expect(childTxn!.type).toBe("FIN-CMSN");
    // The txn header's own gross, not just the posted batch's base total —
    // every sibling engine stamps it and txn-level reports read it.
    expect(childTxn!.grossMinor).toBe(15_000);

    const childLines = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, childTxn!.id));
    const byAccount = Object.fromEntries(
      childLines.map((l) => [l.accountCode, { side: l.side, amountMinor: l.amountMinor }])
    );
    expect(byAccount["1150"]).toEqual({ side: "debit", amountMinor: 15_000 });
    expect(byAccount["4080"]).toEqual({ side: "credit", amountMinor: 14_300 });
    expect(byAccount["2200"]).toEqual({ side: "credit", amountMinor: 700 });
  });

  it("gives the last instalment the rounding remainder so the schedule sums to totalMinor", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 10_000, currency: "AED", instalments: 3,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
    });
    const schedule: { amountMinor: number }[] = JSON.parse(plan.scheduleJson);
    expect(schedule.map((r) => r.amountMinor)).toEqual([3_333, 3_333, 3_334]);
    expect(schedule.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(10_000);
  });

  it("throws badRequest when the plan currency has no fx rate to the tenant base currency", async () => {
    const { ctx } = await seedTenantAndPolicy({ currency: "AED" });
    // The plan currency must equal the *policy's* currency, so an fx gap is only
    // reachable through a policy written in something other than the tenant base
    // currency — which is the case the pre-check exists for.
    const policy = await seedPolicy(ctx, "JPY");
    // badRequest()'s Error.message is the fixed literal "Bad request" (docs/04
    // §1 problem+json); the reason lives on `.detail` — see apps/api/src/
    // analytics.test.ts for the same assertion shape.
    let error: unknown;
    try {
      await createPlan(ctx, policy, {
        totalMinor: 120_000,
        currency: "JPY",
        instalments: 12,
        startAt: ctx.now,
        frequencyDays: 30,
        commissionMinor: 15_000
      });
    } catch (e) {
      error = e;
    }
    expect((error as { detail?: string } | undefined)?.detail).toMatch(/fx rate/i);
    // The point of the pre-check is that the refusal leaves *no trace*: without
    // it, posting.ts throws the same message from inside the FIN-CMSN post and
    // an `active` plan row with an unpostable commission survives the call.
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
    expect(await txnsOfType(ctx, "PLAN-CREATE")).toHaveLength(0);
  });

  it("refuses a plan whose currency is not the policy's currency", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // Route input is a trust boundary: without this check a USD plan opens on an
    // AED policy, and every instalment posts client money in USD against that
    // policy's dim with nothing downstream to reconcile it against the premium.
    let error: unknown;
    try {
      await createPlan(ctx, policy, {
        totalMinor: 120_000, currency: "USD", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
      });
    } catch (e) {
      error = e;
    }
    expect((error as { status?: number } | undefined)?.status).toBe(400);
    expect((error as { detail?: string } | undefined)?.detail).toMatch(/does not match policy currency/);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
    expect(await txnsOfType(ctx, "PLAN-CREATE")).toHaveLength(0);
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(0);
  });

  it("refuses a plan for more than the policy's gross, and allows exactly the gross", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // Financing may cover premium plus tax/fees, so the ceiling is gross (120_000
    // here) rather than premium — but above it the sweep over-collects real client
    // money for the life of the plan on otherwise-valid route input.
    let error: unknown;
    try {
      await createPlan(ctx, policy, {
        totalMinor: 120_001, currency: "AED", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
      });
    } catch (e) {
      error = e;
    }
    expect((error as { status?: number } | undefined)?.status).toBe(400);
    expect((error as { detail?: string } | undefined)?.detail).toMatch(/exceeds financeable amount 120000/);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);

    // The boundary itself is allowed: gross exactly is the normal financed case.
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    expect(plan.totalMinor).toBe(120_000);
  });

  it("falls back to premium as the ceiling when the policy has no gross computed", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // `grossMinor` defaults to 0 (H9 reserved: it is populated by the rating path
    // and older/simpler policies never carry one), so the ceiling has to fall back
    // to premium rather than refusing every plan on such a policy.
    await ctx.db
      .update(schema.axisPolicies)
      .set({ grossMinor: 0 })
      .where(eq(schema.axisPolicies.id, policy.id));
    const [bare] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));

    await expect(
      createPlan(ctx, bare!, {
        totalMinor: 100_001, currency: "AED", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
      })
    ).rejects.toMatchObject({ status: 400 });

    const { plan } = await createPlan(ctx, bare!, {
      totalMinor: 100_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    expect(plan.totalMinor).toBe(100_000);
  });

  it("refuses a non-positive commission before anything is written, so the corrected retry succeeds (C-1)", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // `commissionMinor: 0` was a route-legal body, and buildRecipe rejects a
    // zero gross — but it ran *after* the plan row was inserted `active`, so the
    // 400 left a live plan behind that the sweep collected with no commission
    // ever recognised, and C3 then refused the corrected retry forever.
    let error: unknown;
    try {
      await createPlan(ctx, policy, {
        totalMinor: 120_000, currency: "AED", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 0
      });
    } catch (e) {
      error = e;
    }
    expect((error as { status?: number } | undefined)?.status).toBe(400);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
    expect(await txnsOfType(ctx, "PLAN-CREATE")).toHaveLength(0);
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(0);

    // The whole point of leaving no trace: the operator fixes the body and gets
    // a plan, rather than a permanent Conflict from C3 on an orphan row.
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    expect(plan.state).toBe("active");
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(1);
  });

  it("refuses a total that cannot fund one minor unit per instalment (I-1)", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // `Math.round` used to hand the last instalment `total - per * (n - 1)`,
    // which goes negative as soon as the division rounds up: {5, 10} produced
    // [1,1,1,1,1,1,1,1,1,-4]. The -4 row throws inside buildRecipe on every
    // tick, is swallowed by the per-row catch (I11), and the plan never
    // completes — locked out of re-financing by C3 for good.
    let error: unknown;
    try {
      await createPlan(ctx, policy, {
        totalMinor: 5, currency: "AED", instalments: 10,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
      });
    } catch (e) {
      error = e;
    }
    expect((error as { status?: number } | undefined)?.status).toBe(400);
    expect((error as { detail?: string } | undefined)?.detail).toMatch(/instalment/i);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
  });

  it("floors the instalment so no row is ever zero or negative (I-1)", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    // {10, 6}: Math.round gave [2,2,2,2,2,0] — a zero-amount row buildRecipe
    // also refuses. Math.floor gives the remainder to the last row instead.
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 10, currency: "AED", instalments: 6,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
    });
    const amounts: number[] = (JSON.parse(plan.scheduleJson) as { amountMinor: number }[]).map((r) => r.amountMinor);
    expect(amounts).toEqual([1, 1, 1, 1, 1, 5]);
    expect(Math.min(...amounts)).toBeGreaterThan(0);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("refuses a policy that is neither bound nor active", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const cancelled = { ...policy, status: "cancelled" } as PolicyRow;

    await expect(
      createPlan(ctx, cancelled, {
        totalMinor: 120_000, currency: "AED", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(0);
  });
});

describe("payInstalment", () => {
  it("collects a due instalment via PREM-INSTALMENT and marks the row paid", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });

    await payInstalment(ctx, plan, ctx.now);

    const after = await reread(ctx, plan.id);
    const schedule = JSON.parse(after.scheduleJson);
    expect(schedule[0].state).toBe("paid");
    expect(after.missedStreak).toBe(0);
    expect(after.state).toBe("active"); // 11 instalments still to run

    const txns = await txnsOfType(ctx, "PREM-INSTALMENT");
    expect(txns).toHaveLength(1);
    expect(txns[0]!.grossMinor).toBe(10_000);
  });

  it("leaves the row pending with the streak untouched when the fx rate is missing, and collects it on a later tick once the rate is loaded", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    // Force the plan into a currency with no fx rate on file: our inability to
    // rate the posting is an internal fault, not the customer failing to pay.
    await ctx.db.update(schema.ledgerPaymentPlans).set({ currency: "JPY" }).where(eq(schema.ledgerPaymentPlans.id, plan.id));
    const jpyPlan = await reread(ctx, plan.id);

    await expect(payInstalment(ctx, jpyPlan, ctx.now)).resolves.toBeUndefined();

    const after = await reread(ctx, plan.id);
    expect(after.missedStreak).toBe(0);
    expect(after.state).toBe("active");
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("pending");
    expect(await txnsOfType(ctx, "DUNNING")).toHaveLength(0);
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(0);
    expect(after.updatedAt).toBe(plan.updatedAt); // nothing written at all

    // The operator loads the JPY rate an hour later; the next tick collects it.
    await ctx.db.insert(schema.ledgerFxRates).values({
      id: newId("fx", ctx.now), tenantId: ctx.tenantId,
      fromCurrency: "JPY", toCurrency: "AED", ratePpm: 10_000, asOf: "2026-06-15", source: "manual"
    } as never);

    await payInstalment(ctx, after, ctx.now + 3_600_000);

    const collected = await reread(ctx, plan.id);
    expect(JSON.parse(collected.scheduleJson)[0].state).toBe("paid");
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(1);
  });

  it.each(["failed", "charged_back", "refunded"])("marks the instalment missed and posts DUNNING on a %s payment", async (paymentState) => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await insertPayment(ctx, plan.id, 1, paymentState);

    await payInstalment(ctx, plan, ctx.now);

    const after = await reread(ctx, plan.id);
    expect(after.missedStreak).toBe(1);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("missed");
    const dunning = await txnsOfType(ctx, "DUNNING");
    expect(dunning).toHaveLength(1);
    expect(JSON.parse(dunning[0]!.metadataJson!)).toMatchObject({ seq: 1, paymentState });
    // No client-money receipt for money that did not arrive.
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(0);
  });

  it("persists the miss even when the DUNNING record itself cannot post", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    // A prior DUNNING for this seq is already `failed`, so runTxn's replay
    // guard raises conflict("… already failed") on the second attempt.
    await ctx.db.insert(schema.ledgerTxns).values({
      id: newId("txn", ctx.now), tenantId: ctx.tenantId, type: "DUNNING",
      idempotencyKey: `finance.dunning:${plan.id}:1:pay_already_failed`, state: "failed",
      actorKind: "system", actorId: "sys", currency: "AED", baseCurrency: "AED",
      createdAt: ctx.now, updatedAt: ctx.now
    } as never);
    await insertPayment(ctx, plan.id, 1, "failed", { id: "pay_already_failed" });

    await expect(payInstalment(ctx, plan, ctx.now)).resolves.toBeUndefined();

    const after = await reread(ctx, plan.id);
    expect(after.missedStreak).toBe(1);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("missed");
  });

  it("posts one DUNNING per refused attempt when the same instalment bounces three times", async () => {
    // The threshold counts refused *attempts*, not distinct instalments: a
    // financier re-presenting instalment 1 three times lapses the policy on the
    // third, and each attempt is its own dunning record.
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });

    for (const attempt of [1, 2, 3]) {
      await insertPayment(ctx, plan.id, 1, "failed", {
        at: ctx.now + attempt * DAY,
        id: `pay_attempt_${attempt}`
      });
      await payInstalment(ctx, await reread(ctx, plan.id), ctx.now + attempt * DAY);
    }

    const after = await reread(ctx, plan.id);
    expect(after.missedStreak).toBe(DUNNING_LAPSE_THRESHOLD);
    expect(after.state).toBe("defaulted");
    const dunning = await txnsOfType(ctx, "DUNNING");
    expect(dunning).toHaveLength(3);
    expect(dunning.map((t) => JSON.parse(t.metadataJson!).paymentId).sort()).toEqual([
      "pay_attempt_1", "pay_attempt_2", "pay_attempt_3"
    ]);
  });

  it.each(["authorized", "captured", "settled"])("collects the instalment on a %s payment", async (paymentState) => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await insertPayment(ctx, plan.id, 1, paymentState);

    await payInstalment(ctx, plan, ctx.now);

    expect(JSON.parse((await reread(ctx, plan.id)).scheduleJson)[0].state).toBe("paid");
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(1);
  });

  it.each(["pending", "some_future_psp_state"])(
    "leaves the instalment pending on a %s payment rather than treating it as cash",
    async (paymentState) => {
      const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
      const { plan } = await createPlan(ctx, policy, {
        totalMinor: 120_000, currency: "AED", instalments: 12,
        startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
      });
      // The engine does not own ledger_payments' state set, so an in-flight or
      // unrecognised state must never become a client-money receipt: it is not
      // a miss either, so the row waits for the next tick.
      await insertPayment(ctx, plan.id, 1, paymentState);

      await payInstalment(ctx, plan, ctx.now);

      const after = await reread(ctx, plan.id);
      expect(JSON.parse(after.scheduleJson)[0].state).toBe("pending");
      expect(after.missedStreak).toBe(0);
      expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(0);
      expect(await txnsOfType(ctx, "DUNNING")).toHaveLength(0);
      expect(after.updatedAt).toBe(plan.updatedAt); // nothing written at all
    }
  );

  it("breaks a created_at tie on the payment id, not on scan order", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    // A financier settlement file imported in one batch stamps every row with
    // the same created_at. Insert the loser last so scan order and id order
    // disagree: without the id tiebreaker the `settled` row wins by accident.
    await insertPayment(ctx, plan.id, 1, "failed", { id: "pay_zzz" });
    await insertPayment(ctx, plan.id, 1, "settled", { id: "pay_aaa" });

    await payInstalment(ctx, plan, ctx.now);

    const after = await reread(ctx, plan.id);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("missed");
    expect(after.missedStreak).toBe(1);
  });

  it("leaves the row pending and the streak clear when our own PREM-INSTALMENT post fails", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    // A non-fx internal cause: a prior instalment txn under this seq's key is
    // already `failed`, so runTxn's replay guard raises conflict. Stands in for
    // a transient D1 error, a closed period, or a client-money breach — all of
    // which are our fault, not the customer's, so none may become a miss.
    await ctx.db.insert(schema.ledgerTxns).values({
      id: newId("txn", ctx.now), tenantId: ctx.tenantId, type: "PREM-INSTALMENT",
      idempotencyKey: `finance.instalment:${plan.id}:1`, state: "failed",
      actorKind: "system", actorId: "sys", currency: "AED", baseCurrency: "AED",
      createdAt: ctx.now, updatedAt: ctx.now
    } as never);

    await expect(payInstalment(ctx, plan, ctx.now)).resolves.toBeUndefined();

    const after = await reread(ctx, plan.id);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("pending");
    expect(after.missedStreak).toBe(0);
    expect(await txnsOfType(ctx, "DUNNING")).toHaveLength(0);
    expect(after.updatedAt).toBe(plan.updatedAt); // nothing written at all
  });

  it("collects a missed instalment once the re-presented debit settles, clearing the miss", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 10_000, currency: "AED", instalments: 1,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
    });
    await insertPayment(ctx, plan.id, 1, "failed");

    await payInstalment(ctx, plan, ctx.now);
    expect((await reread(ctx, plan.id)).missedStreak).toBe(1);

    // The financier re-presents a week later and it clears. Real money arrived;
    // a `missed` row that can never be revisited would hide it forever and keep
    // the plan in the sweep for the life of the tenant.
    await insertPayment(ctx, plan.id, 1, "settled", { at: ctx.now + 7 * DAY });

    await payInstalment(ctx, await reread(ctx, plan.id), ctx.now + 7 * DAY);

    const after = await reread(ctx, plan.id);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("paid");
    expect(after.missedStreak).toBe(0);
    expect(after.state).toBe("completed");
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(1);
  });

  it("counts one miss for one failed payment however many ticks pass over it", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await insertPayment(ctx, plan.id, 1, "failed");

    // Re-examining a `missed` row must key off a *newer* payment attempt. The
    // naive version — just making `missed` collectable — re-counts the same
    // failure every tick and lapses a customer in three ticks off one bounce.
    for (let i = 0; i < 5; i++) await payInstalment(ctx, await reread(ctx, plan.id), ctx.now + i * 1_000);

    const after = await reread(ctx, plan.id);
    expect(after.missedStreak).toBe(1);
    expect(after.state).toBe("active");
    expect(await txnsOfType(ctx, "DUNNING")).toHaveLength(1);
  });

  it("marks the plan completed once every instalment is paid, so the sweep stops seeing it", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 20_000, currency: "AED", instalments: 2,
      startAt: ctx.now - 30 * DAY, frequencyDays: 30, commissionMinor: 2_000
    });

    await payInstalment(ctx, plan, ctx.now);

    const after = await reread(ctx, plan.id);
    expect(JSON.parse(after.scheduleJson).map((r: { state: string }) => r.state)).toEqual(["paid", "paid"]);
    expect(after.state).toBe("completed");
  });

  it('collects a legacy-shaped schedule row (state "due", prefixed subjectRef)', async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 20_000, currency: "AED", instalments: 2,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 2_000
    });
    // The vocabulary written by packages/core/src/seed/ledger.ts and by the
    // formerly-writable payment-plans CRUD: "due" instead of "pending", and a
    // `policy:`-prefixed subjectRef.
    const legacy = (JSON.parse(plan.scheduleJson) as { state: string }[]).map((r, i) => (i === 0 ? { ...r, state: "due" } : r));
    await ctx.db
      .update(schema.ledgerPaymentPlans)
      .set({ scheduleJson: JSON.stringify(legacy), subjectRef: `policy:${policy.id}` })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    const legacyPlan = await reread(ctx, plan.id);

    await payInstalment(ctx, legacyPlan, ctx.now);

    const after = await reread(ctx, plan.id);
    expect(JSON.parse(after.scheduleJson)[0].state).toBe("paid");
    const [txn] = await txnsOfType(ctx, "PREM-INSTALMENT");
    // The bare policy id, or onFinancingLapseDue's lookup finds nothing.
    expect(JSON.parse(txn!.subjectRefsJson!).policy).toBe(policy.id);
  });

  it("emits ledger.financing.lapse_due once on the crossing tick and defaults the plan", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ missedStreak: DUNNING_LAPSE_THRESHOLD - 1 })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await insertPayment(ctx, plan.id, 1, "failed");

    await payInstalment(ctx, await reread(ctx, plan.id), ctx.now);

    const events = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "ledger.financing.lapse_due"));
    expect(events).toHaveLength(1);
    const crossed = await reread(ctx, plan.id);
    expect(crossed.missedStreak).toBe(DUNNING_LAPSE_THRESHOLD);
    expect(crossed.state).toBe("defaulted");

    // A later tick where the plan misses again (streak already past the
    // threshold) must not re-fire. Put the plan back in the sweep's set —
    // `reinstatePolicy` does exactly this write for real (see its spec above);
    // here it is inlined so the fixture stays free of the approval gate.
    await ctx.db.update(schema.ledgerPaymentPlans).set({ state: "active" }).where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await insertPayment(ctx, plan.id, 2, "failed");

    await payInstalment(ctx, await reread(ctx, plan.id), ctx.now + 30 * DAY);

    const eventsAfterSecondTick = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "ledger.financing.lapse_due"));
    expect(eventsAfterSecondTick).toHaveLength(1);
    expect((await reread(ctx, plan.id)).missedStreak).toBe(DUNNING_LAPSE_THRESHOLD + 1);
  });
});

describe("onFinancingLapseDue", () => {
  it("lapses the policy via the existing lapsePolicy cascade", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ missedStreak: DUNNING_LAPSE_THRESHOLD - 1 })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await insertPayment(ctx, plan.id, 1, "failed");

    await sweepPremiumFinancing(ctx); // this tick's miss crosses the threshold and emits

    const envelope = (await pendingOutbox(ctx.db)).find((e) => e.type === "ledger.financing.lapse_due");
    expect(envelope).toBeDefined();

    await onFinancingLapseDue(ctx, envelope!);

    const [after] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    expect(after!.status).toBe("lapsed");
  });

  it("lapses the policy end to end through drainOutbox, the production wiring", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ missedStreak: DUNNING_LAPSE_THRESHOLD - 1 })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await insertPayment(ctx, plan.id, 1, "failed");

    await sweepPremiumFinancing(ctx);
    // The join the other two specs each prove half of: nothing else in the
    // codebase carries a real miss to a real lapse, and drainOutbox's own
    // comment invites a refactor into a type->handler map that could drop it.
    await drainOutbox(ctx);

    const [after] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    expect(after!.status).toBe("lapsed");
  });

  it("returns quietly when the policy is not active, instead of throwing into six retries and the DLQ", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ missedStreak: DUNNING_LAPSE_THRESHOLD - 1 })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await insertPayment(ctx, plan.id, 1, "failed");
    await sweepPremiumFinancing(ctx);
    const envelope = (await pendingOutbox(ctx.db)).find((e) => e.type === "ledger.financing.lapse_due");

    // POLICY_TRANSITIONS allows only active -> lapsed, so anything else would
    // make lapsePolicy's hop() throw conflict and dead-letter the event after
    // six pointless retries.
    await ctx.db.update(schema.axisPolicies).set({ status: "cancelled" }).where(eq(schema.axisPolicies.id, policy.id));

    await expect(onFinancingLapseDue(ctx, envelope!)).resolves.toBeUndefined();

    const [after] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    expect(after!.status).toBe("cancelled");
  });
});

describe("reinstatePolicy", () => {
  it("puts the policy's defaulted financing plan back in the sweep with a clear streak", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ state: "defaulted", missedStreak: DUNNING_LAPSE_THRESHOLD })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await ctx.db.update(schema.axisPolicies)
      .set({ status: "lapsed", lapsedAt: ctx.now - DAY })
      .where(eq(schema.axisPolicies.id, policy.id));
    const [lapsed] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    // axis.reinstate is neverAutoApprove + dualControl:"always", so the gate
    // needs a real approved row rather than a tenant allowlist entry.
    await ctx.db.insert(schema.approvals).values({
      id: newId("apr", ctx.now), tenantId: ctx.tenantId, subjectRef: `axis_reinstate:${policy.id}`,
      policyKey: "axis.reinstate", module: "axis", requestedBy: "u_other", requestedAt: ctx.now - 1_000,
      decidedBy: "u_test", decision: "approved", decidedAt: ctx.now - 500,
      contextJson: JSON.stringify({ amountMinor: 50_000 })
    } as never);

    await reinstatePolicy(ctx, lapsed as PolicyRow, { arrearsMinor: 50_000, note: "arrears collected" });

    // Arrears cleared and cover back on risk, but a plan left `defaulted` is
    // out of the sweep for good: the remaining instalments would never collect.
    const after = await reread(ctx, plan.id);
    expect(after.state).toBe("active");
    expect(after.missedStreak).toBe(0);

    // The reset is money-affecting — the sweep starts debiting again — so it
    // leaves its own trail row keyed on the plan, not just on the policy.
    const trail = await ctx.db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.subjectRef, plan.id));
    expect(trail.map((r) => r.action)).toContain("ledger.financing.plan.reinstate");
  });

  it("leaves missedPaymentId on the missed rows so the next tick does not re-default", async () => {
    // The stamp looks like stale bookkeeping, but it is the only thing stopping
    // the sweep counting the same refused payment again: that payment is still
    // the newest one for its instalment.
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now - DAY, frequencyDays: 30, commissionMinor: 15_000
    });
    await insertPayment(ctx, plan.id, 1, "failed", { id: "pay_refused" });
    // Let the sweep stamp the miss itself rather than hand-writing the row.
    await sweepPremiumFinancing(ctx);
    expect((await reread(ctx, plan.id)).missedStreak).toBe(1);
    await ctx.db.update(schema.ledgerPaymentPlans)
      .set({ state: "defaulted", missedStreak: DUNNING_LAPSE_THRESHOLD })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await ctx.db.update(schema.axisPolicies)
      .set({ status: "lapsed", lapsedAt: ctx.now - DAY })
      .where(eq(schema.axisPolicies.id, policy.id));
    const [lapsed] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    await ctx.db.insert(schema.approvals).values({
      id: newId("apr", ctx.now), tenantId: ctx.tenantId, subjectRef: `axis_reinstate:${policy.id}`,
      policyKey: "axis.reinstate", module: "axis", requestedBy: "u_other", requestedAt: ctx.now - 1_000,
      decidedBy: "u_test", decision: "approved", decidedAt: ctx.now - 500,
      contextJson: JSON.stringify({ amountMinor: 50_000 })
    } as never);

    await reinstatePolicy(ctx, lapsed as PolicyRow, { arrearsMinor: 50_000, note: "arrears collected" });
    await sweepPremiumFinancing(ctx);

    const after = await reread(ctx, plan.id);
    expect(after.state).toBe("active");
    expect(after.missedStreak).toBe(0);
  });
});

describe("one-live-plan-per-subject constraint", () => {
  it("is enforced by the database, not only by createPlan's read", async () => {
    // createPlan reads-then-writes, and two concurrent requests both pass the
    // read (Workers offer no serialisable transaction to hold it). The partial
    // unique index is what actually makes the rule true.
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });

    const second = {
      id: "finplan_race", tenantId: ctx.tenantId, subjectRef: plan.subjectRef,
      financierRef: null, totalMinor: 10_000, currency: "AED", instalments: 1,
      scheduleJson: "[]", state: "active", missedStreak: 0,
      createdAt: ctx.now, updatedAt: ctx.now
    };
    await expect(ctx.db.insert(schema.ledgerPaymentPlans).values(second as never)).rejects.toThrow();

    // Partial: a finished plan does not occupy the slot, so cancel-and-reopen
    // works (the whole point of cancelPlan).
    await ctx.db.update(schema.ledgerPaymentPlans).set({ state: "cancelled" })
      .where(eq(schema.ledgerPaymentPlans.id, plan.id));
    await expect(ctx.db.insert(schema.ledgerPaymentPlans).values(second as never)).resolves.toBeDefined();
  });
});

describe("cancelPlan", () => {
  it("reverses the commission, leaves the plan out of the sweep, and frees the policy", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });

    await cancelPlan(ctx, plan, "opened against the wrong contract");

    const after = await reread(ctx, plan.id);
    expect(after.state).toBe("cancelled");
    // The receivable is un-earned: the original goes `reversed` and a balanced
    // contra transaction carries the other side.
    const commissions = await txnsOfType(ctx, "FIN-CMSN");
    expect(commissions).toHaveLength(2);
    const original = commissions.find((t) => t.idempotencyKey === `finance.plan_commission:${plan.id}`)!;
    expect(original.state).toBe("reversed");
    expect(commissions.find((t) => t.reversalOf === original.id)!.state).toBe("settled");
    expect(await sweepPremiumFinancing(ctx)).toBe(0);

    // The point of the cancel path: C3 no longer locks the policy out.
    await expect(createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    })).resolves.toBeDefined();
  });

  it("refuses a plan that is not live", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 10_000, currency: "AED", instalments: 1,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
    });
    // One instalment, collected: the plan is `completed`, and cancelling a
    // finished plan would reverse a commission the financier has earned.
    await payInstalment(ctx, plan, ctx.now);

    await expect(cancelPlan(ctx, await reread(ctx, plan.id), "changed my mind")).rejects.toThrow();
  });

  it("cancels a plan whose commission was never posted", async () => {
    // The release valve for a legacy orphan (a plan row that survived a failed
    // chained FIN-CMSN before createPlan wrote the row last).
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    await ctx.db.insert(schema.ledgerPaymentPlans).values({
      id: "finplan_orphan", tenantId: ctx.tenantId, subjectRef: `policy:${policy.id}`,
      financierRef: null, totalMinor: 10_000, currency: "AED", instalments: 1,
      scheduleJson: JSON.stringify([{ seq: 1, dueAt: ctx.now, amountMinor: 10_000, state: "pending" }]),
      state: "active", missedStreak: 0, createdAt: ctx.now, updatedAt: ctx.now
    } as never);

    await cancelPlan(ctx, await reread(ctx, "finplan_orphan"), "orphan cleanup");

    expect((await reread(ctx, "finplan_orphan")).state).toBe("cancelled");
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(0);
  });
});

describe("POST /v1/axis/policies/:id/premium-financing-plan/cancel", () => {
  it("cancels the policy's live plan", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });

    const res = await testApp(ctx).request(`/v1/axis/policies/${policy.id}/premium-financing-plan/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "opened against the wrong contract" })
    });

    expect(res.status).toBe(200);
    expect((await reread(ctx, plan.id)).state).toBe("cancelled");
  });

  it("404s when the policy has no live plan", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });

    const res = await testApp(ctx).request(`/v1/axis/policies/${policy.id}/premium-financing-plan/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "nothing to cancel" })
    });

    expect(res.status).toBe(404);
  });
});

describe("sweepPremiumFinancing", () => {
  it("collects every active plan and leaves a plan it cannot rate for the next tick", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const good = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    // A second contract, not a second plan on the same one: one policy holds at
    // most one financing plan (C3).
    const bad = await createPlan(ctx, await seedPolicy(ctx, "AED"), {
      totalMinor: 60_000, currency: "AED", instalments: 6,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 6_000
    });
    await ctx.db.update(schema.ledgerPaymentPlans).set({ currency: "JPY" }).where(eq(schema.ledgerPaymentPlans.id, bad.plan.id));

    const count = await sweepPremiumFinancing(ctx);

    expect(count).toBe(2);
    const goodAfter = await reread(ctx, good.plan.id);
    const badAfter = await reread(ctx, bad.plan.id);
    expect(JSON.parse(goodAfter.scheduleJson)[0].state).toBe("paid");
    expect(badAfter.missedStreak).toBe(0);
    expect(JSON.parse(badAfter.scheduleJson)[0].state).toBe("pending");
  });

  it("leaves a plan belonging to another subject kind alone", async () => {
    // `payment_plans` is a shared table (docs/19): an instalment plan on an
    // invoice or an order is a legitimate row a sibling module may own. This
    // engine's whole vocabulary is policy-shaped — policyIdOf, the ledger
    // `policy` dim, the lapse cascade — so it collects only what it owns.
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const mine = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    });
    await ctx.db.insert(schema.ledgerPaymentPlans).values({
      id: "finplan_foreign", tenantId: ctx.tenantId, subjectRef: "invoice:inv_1",
      financierRef: null, totalMinor: 10_000, currency: "AED", instalments: 1,
      scheduleJson: JSON.stringify([{ seq: 1, dueAt: ctx.now, amountMinor: 10_000, state: "pending" }]),
      state: "active", missedStreak: 0, createdAt: ctx.now - 1, updatedAt: ctx.now - 1
    } as never);

    // Oldest-first, so the foreign plan would be swept before ours if it were
    // in the set at all.
    expect(await sweepPremiumFinancing(ctx)).toBe(1);

    expect(JSON.parse((await reread(ctx, mine.plan.id)).scheduleJson)[0].state).toBe("paid");
    const foreign = await reread(ctx, "finplan_foreign");
    expect(JSON.parse(foreign.scheduleJson)[0].state).toBe("pending");
    expect(await txnsOfType(ctx, "PREM-INSTALMENT")).toHaveLength(1);
  });

  it("does not block a plan on another subject kind for the same id", async () => {
    // C3 is a per-policy rule, not a per-id one: `invoice:X` must not make
    // `policy:X` unopenable.
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    await ctx.db.insert(schema.ledgerPaymentPlans).values({
      id: "finplan_foreign2", tenantId: ctx.tenantId, subjectRef: `invoice:${policy.id}`,
      financierRef: null, totalMinor: 10_000, currency: "AED", instalments: 1,
      scheduleJson: "[]", state: "active", missedStreak: 0, createdAt: ctx.now, updatedAt: ctx.now
    } as never);

    await expect(createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000
    })).resolves.toBeDefined();
  });

  it("does not rewrite a plan with nothing due", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const { plan } = await createPlan(ctx, policy, {
      totalMinor: 120_000, currency: "AED", instalments: 12,
      startAt: ctx.now + 30 * DAY, frequencyDays: 30, commissionMinor: 15_000
    });

    // A tick a day later, still nothing due: no row churn, so `updatedAt` stays
    // a real signal of "when this plan last changed".
    await payInstalment(ctx, plan, ctx.now + DAY);

    expect((await reread(ctx, plan.id)).updatedAt).toBe(plan.updatedAt);
  });

  it("stops sweeping a plan once it is completed", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    await createPlan(ctx, policy, {
      totalMinor: 10_000, currency: "AED", instalments: 1,
      startAt: ctx.now, frequencyDays: 30, commissionMinor: 1_000
    });

    expect(await sweepPremiumFinancing(ctx)).toBe(1);
    expect(await sweepPremiumFinancing(ctx)).toBe(0);
  });
});

describe("POST /v1/axis/policies/:id/premium-financing-plan", () => {
  const planBody = (now: number) => ({
    totalMinor: 120_000, currency: "AED", instalments: 12,
    startAt: now, frequencyDays: 30, commissionMinor: 15_000
  });

  it("creates a plan and is idempotent under a repeated idempotency key", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const body = planBody(ctx.now);
    const key = "idem-plan-1";

    const first = await app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { plan: { id: string } };

    const second = await app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const secondJson = (await second.json()) as { plan: { id: string } };
    expect(secondJson.plan.id).toBe(firstJson.plan.id);

    const plans = await ctx.db.select().from(schema.ledgerPaymentPlans).where(eq(schema.ledgerPaymentPlans.subjectRef, `policy:${policy.id}`));
    expect(plans).toHaveLength(1); // not 2 — the replay didn't insert a second row
  });

  it("is idempotent with no idempotency-key header — the policy is the key", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const body = planBody(ctx.now);
    const post = () =>
      app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    const first = (await (await post()).json()) as { plan: { id: string } };
    const second = (await (await post()).json()) as { plan: { id: string } };

    expect(second.plan.id).toBe(first.plan.id);
    // Two plans on one policy would double-count the FIN-CMSN commission and
    // post a duplicate client-money receipt every tick for the plan's life.
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(1);
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(1);
  });

  it("refuses a second plan on the same policy even under a fresh idempotency key", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const body = planBody(ctx.now);
    const post = (key: string) =>
      app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
        method: "POST",
        headers: { "idempotency-key": key, "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    // The normal client: a fresh UUID per attempt. The idempotency key cannot
    // see the double-submit, so uniqueness has to live in the engine.
    expect((await post("client-uuid-1")).status).toBe(200);
    expect((await post("client-uuid-2")).status).toBe(409);

    // Two plans would book the FIN-CMSN commission twice — real revenue and a
    // real receivable that do not exist — then collect the same premium twice
    // every tick, on separate idempotency keys (CLAUDE.md #12).
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(1);
    expect(await txnsOfType(ctx, "FIN-CMSN")).toHaveLength(1);
    expect(await txnsOfType(ctx, "PLAN-CREATE")).toHaveLength(1);
  });

  it("rejects a malformed body with a clean 400 instead of reaching createPlan", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const res = await app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ totalMinor: 120_000, currency: "AED", instalments: 0, startAt: ctx.now, frequencyDays: 30, commissionMinor: 15_000 })
    });
    expect(res.status).toBe(400);
  });

  it("rejects commissionMinor: 0 at the route and leaves no plan row behind (C-1)", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const post = (commissionMinor: number) =>
      app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `k-${commissionMinor}` },
        body: JSON.stringify({ ...planBody(ctx.now), commissionMinor })
      });

    expect((await post(0)).status).toBe(400);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
    // Not 409: the refused attempt wrote nothing, so C3 has nothing to trip on.
    expect((await post(15_000)).status).toBe(200);
  });

  it("refuses a policy that is neither bound nor active with a 409", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ currency: "AED" });
    await ctx.db.update(schema.axisPolicies).set({ status: "draft" }).where(eq(schema.axisPolicies.id, policy.id));
    const app = testApp(ctx);

    const res = await app.request(`/v1/axis/policies/${policy.id}/premium-financing-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(planBody(ctx.now))
    });

    expect(res.status).toBe(409);
    expect(await ctx.db.select().from(schema.ledgerPaymentPlans)).toHaveLength(0);
  });
});

describe("payment-plans resource route (regression)", () => {
  it("rejects a direct create against the generic CRUD route", async () => {
    const { ctx } = await seedTenantAndPolicy({ currency: "AED" });
    const app = testApp(ctx);
    const res = await app.request("/v1/ledger/payment-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectRef: "pol_x", totalMinor: 1000, currency: "AED", instalments: 1, scheduleJson: "[]" })
    });
    // ro() declares no `create` permission, so crud.ts never registers the
    // POST route at all — it falls through to app.notFound (404), exactly
    // like the sibling ledger/payments and ledger/txns resources
    // (resources.test.ts "POST /txns and POST /payments do not exist as
    // routes"). Not 403 — deviation from the brief's literal snippet, but
    // matching this codebase's own established, tested convention for ro().
    expect(res.status).toBe(404);
  });
});
