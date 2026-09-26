import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { closePeriod, reopenPeriod } from "./periods.js";

// docs/27 F20. `force: true` was accepted straight from the request body: a
// boolean, no reason, nothing recorded about *what break* was being accepted.
// The permission (`ledger:periods:force_close`) and the approval policy
// (`ledger.period_close_force`) were already there — what was missing is the
// thing an auditor actually reads, which is why.
//
// The register also says reopenPeriod "has no approval gate at all". It does
// (`ledger.period_reopen`, added after the register was written); what it had
// no notion of was a stated reason either, so that half is held here too.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
const CODE = "2026-05";
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: {
      kind: "user",
      id: "u_test",
      tenantId: "t_test",
      grants: [{ roleKey: "owner", permissions: ["*:*:*"] }]
    },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/** A batch whose header disagrees with its lines — the break `force` exists for. */
async function tornBatch(): Promise<void> {
  await ctx.db.insert(schema.ledgerPeriods).values({
    id: "per_1",
    tenantId: ctx.tenantId,
    code: CODE,
    startAt: Date.UTC(2026, 4, 1),
    endAt: Date.UTC(2026, 5, 1) - 1,
    state: "open"
  });
  await ctx.db.insert(schema.ledgerJournalBatches).values({
    id: "bat_torn",
    tenantId: ctx.tenantId,
    txnId: "txn_torn",
    periodId: "per_1",
    currency: "AED",
    baseCurrency: "AED",
    fxRatePpm: 1_000_000,
    totalDebitMinor: 100,
    totalCreditMinor: 100,
    baseTotalDebitMinor: 100,
    baseTotalCreditMinor: 100,
    postedBy: "user:u_test",
    postedAt: NOW
  });
}

describe("docs/27 F20 — forcing a close is a decision, not a flag", () => {
  it("refuses a forced close with no stated reason", async () => {
    await tornBatch();
    await expect(
      closePeriod(ctx, CODE, "soft_closed", { force: true, preApproved: true })
    ).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/forcing a close requires a reason/i) })
    );
  });

  it("refuses a reason too short to be one", async () => {
    await tornBatch();
    await expect(
      closePeriod(ctx, CODE, "soft_closed", { force: true, reason: "ok", preApproved: true })
    ).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/forcing a close requires a reason/i) })
    );
  });

  it("refuses a force when nothing is actually broken", async () => {
    // Nothing to override is not an override: a force that finds a clean month
    // is a caller asking for a power it does not need, and granting it silently
    // trains everyone to send force: true always.
    await expect(
      closePeriod(ctx, CODE, "soft_closed", {
        force: true,
        reason: "closing over the known FX residual from the March migration",
        preApproved: true
      })
    ).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/nothing to force/i) })
    );
  });

  it("records the reason and the checks it overrode, where a reader will find them", async () => {
    await tornBatch();
    const reason = "closing over the known torn batch bat_torn, ticket FIN-411";
    await closePeriod(ctx, CODE, "soft_closed", { force: true, reason, preApproved: true });

    // The audit log stores hashes of before/after, not the payload, so the
    // sentence has to live on the row an auditor opens.
    const [row] = await ctx.db
      .select()
      .from(schema.ledgerPeriods)
      .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, CODE)));
    expect(row?.stateReason).toContain(reason);
    expect(row?.stateReason).toContain(`batches_match_lines@${CODE}`);

    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), eq(schema.auditLog.action, "ledger.period.close")));
    expect(audits).toHaveLength(1);
  });

  it("leaves an unforced close of a clean month exactly as it was", async () => {
    const p = await closePeriod(ctx, CODE, "soft_closed", { preApproved: true });
    expect(p.state).toBe("soft_closed");
  });
});

describe("docs/27 F20 — a reopen states why", () => {
  it("refuses a reopen with no reason", async () => {
    await closePeriod(ctx, CODE, "soft_closed", { preApproved: true });
    await expect(reopenPeriod(ctx, CODE, { preApproved: true })).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/reopening a period requires a reason/i) })
    );
  });

  it("reopens with a reason, and records it", async () => {
    await closePeriod(ctx, CODE, "soft_closed", { preApproved: true });
    const reason = "reopening to post the late insurer statement for May";
    const p = await reopenPeriod(ctx, CODE, { reason, preApproved: true });
    expect(p.state).toBe("open");

    const [row] = await ctx.db
      .select()
      .from(schema.ledgerPeriods)
      .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, CODE)));
    expect(row?.stateReason).toContain(reason);
  });

  it("an already-open period is a no-op and needs no reason", async () => {
    expect((await reopenPeriod(ctx, CODE)).state).toBe("open");
  });
});

// docs/30 Ledger gap 3. A close (and a reopen) changed a period's state and
// told only the audit log; nothing on the bus could hear that a month was
// signed off. Both now announce it, once per transition.
describe("a period's close and reopen are announced", () => {
  const announced = async () =>
    (await ctx.db.select().from(schema.eventOutbox)).map((e) => JSON.parse(e.envelopeJson)).filter((e) => e.type.startsWith("ledger.period."));

  it("emits ledger.period.closed with the transition, and ledger.period.reopened with the reason", async () => {
    await closePeriod(ctx, CODE, "soft_closed", { preApproved: true });
    await reopenPeriod(ctx, CODE, { reason: "late supplier invoice for March", preApproved: true });
    await reopenPeriod(ctx, CODE, { preApproved: true }); // already open: no transition, no event
    expect((await announced()).map((e) => [e.type, e.subject, e.data])).toEqual([
      ["ledger.period.closed", `period:${CODE}`, { code: CODE, from: "open", to: "soft_closed", forced: false }],
      ["ledger.period.reopened", `period:${CODE}`, { code: CODE, from: "soft_closed", reason: "late supplier invoice for March" }]
    ]);
  });
});
