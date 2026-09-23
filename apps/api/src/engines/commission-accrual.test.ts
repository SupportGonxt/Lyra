import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema, type Db } from "@lyra/db";
import { consume, decide, emit, seed, type Ctx, type Envelope, type SeedResult } from "@lyra/core";
import { drainOutbox } from "../dispatch.js";

// Regression: commission did not accrue on bind. AXIS emits
// `axis.policy.issued` (routes/axis.ts, engines/group-commission.ts) and the
// only consumer was SIGNAL's attribution; Distribution never heard about a
// bind, so a channel's commission existed only if someone remembered to POST
// /v1/dist/commission-entries/accrue by hand.
//
// The consumer takes exactly the manual route's path (engines/commission-
// accrual.ts is that route's body, extracted): rate from the offering and
// channel, the `dist.commission_accrue` gate, the one-per-(policy, kind)
// unique index, the audit row and `dist.commission.accrued`. Nothing here is
// auto-approved — the bind raises the approval, the approver's decision books it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = Date.now();

let database: Db;
let seeded: SeedResult;
let policy: typeof schema.axisPolicies.$inferSelect;

function ctxAs(actor: Ctx["actor"], tenantId = seeded.tenantId, now = NOW): Ctx {
  return {
    db: database as unknown as Ctx["db"],
    tenantId,
    actor,
    requestId: "req_accrual",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

const scheduler = () => ctxAs({ kind: "system", id: "scheduler", tenantId: seeded.tenantId, grants: [] });
const approver = () =>
  ctxAs({ kind: "user", id: "u_second_pair", tenantId: seeded.tenantId, grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] });

const entriesFor = (policyId: string) =>
  database
    .select()
    .from(schema.distCommissionEntries)
    .where(and(eq(schema.distCommissionEntries.tenantId, seeded.tenantId), eq(schema.distCommissionEntries.policyId, policyId)));

const approvalsFor = (policyId: string) =>
  database
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, seeded.tenantId), eq(schema.approvals.subjectRef, `${policyId}:new_business`)));

async function issued(c: Ctx, p: typeof policy): Promise<Envelope> {
  return emit(c, {
    module: "axis",
    type: "axis.policy.issued",
    subject: p.id,
    data: { policyId: p.id, customerId: p.customerId, channelId: p.channelId, premiumMinor: p.premiumMinor, currency: p.currency }
  });
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  // The renewal-window policy — seeded with an offering and channel and no
  // commission entry, the same one dist.test.ts accrues by hand.
  policy = (await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118")))[0]!;
}, 120_000);

describe("axis.policy.issued accrues the channel's commission", () => {
  it("raises the accrual approval on bind and writes nothing until it is decided", async () => {
    expect(policy.channelId && policy.offeringId).toBeTruthy();
    expect(await entriesFor(policy.id)).toHaveLength(0);

    const c = scheduler();
    await issued(c, policy);
    await drainOutbox(c);

    expect(await entriesFor(policy.id)).toHaveLength(0);
    const [approval] = await approvalsFor(policy.id);
    expect(approval?.policyKey).toBe("dist.commission_accrue");
    expect(approval?.decision).toBe("pending");
    expect(approval?.requestedBy).toBe("system:scheduler");
  });

  it("books the accrual once the approval is decided, audited and announced", async () => {
    const [approval] = await approvalsFor(policy.id);
    await decide(approver(), approval!.id, "approved");
    const c = scheduler();
    await drainOutbox(c);

    const entries = await entriesFor(policy.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: "accrued", kind: "new_business", channelId: policy.channelId, premiumMinor: policy.premiumMinor });
    expect(entries[0]!.grossCommissionMinor).toBeGreaterThan(0);

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.subjectRef, entries[0]!.id)));
    expect(audits.map((a) => a.action)).toContain("dist.commission.accrue");
    const accrued = (await database.select().from(schema.eventOutbox)).filter(
      (e) => e.type === "dist.commission.accrued" && e.envelopeJson.includes(policy.id)
    );
    expect(accrued).toHaveLength(1);
  });

  it("does not double-accrue on a second delivery of the same fact", async () => {
    const c = scheduler();
    // A re-emitted bind (new event id) and a replay of one already consumed.
    const again = await issued(c, policy);
    await drainOutbox(c);
    expect(await consume(c.db, again, "dist.commission.accrual", async () => {}, c.now)).toBe("duplicate");
    expect(await entriesFor(policy.id)).toHaveLength(1);
    // ...and it raised no second approval either.
    expect(await approvalsFor(policy.id)).toHaveLength(1);
  });

  it("leaves a policy with no channel alone", async () => {
    // A direct sale: the same policy shape with no channel on it.
    const bare = { ...policy, id: "pol_direct_sale", policyNo: "DIRECT-0001", channelId: null };
    await database.insert(schema.axisPolicies).values(bare);
    const c = scheduler();
    await issued(c, bare);
    await drainOutbox(c);
    expect(await entriesFor(bare.id)).toHaveLength(0);
    expect(await approvalsFor(bare.id)).toHaveLength(0);
  });

  it("does not complete an accrual a person asked for by hand — that retry stays theirs", async () => {
    // The manual route raises the same approval under a user's name. Its
    // decision must not book the entry behind the controller's back, or their
    // retry of POST /accrue would meet a 409 for an accrual they never saw land.
    const other = (
      await database
        .select()
        .from(schema.axisPolicies)
        .where(eq(schema.axisPolicies.tenantId, seeded.tenantId))
    ).find((p) => p.id !== policy.id && p.channelId && p.offeringId);
    if (!other) throw new Error("the seed has a second channel policy");
    const existing = await entriesFor(other.id);
    await database.insert(schema.approvals).values({
      id: "apr_manual_1",
      tenantId: seeded.tenantId,
      subjectRef: `${other.id}:renewal`,
      policyKey: "dist.commission_accrue",
      module: "core",
      requestedBy: "user:u_controller",
      requestedAt: NOW,
      decidedBy: null,
      decision: "pending",
      reason: null,
      contextJson: JSON.stringify({ amountMinor: 1, dualControl: false }),
      decidedAt: null,
      delegationId: null
    });
    await decide(approver(), "apr_manual_1", "approved");
    await drainOutbox(scheduler());
    expect(await entriesFor(other.id)).toHaveLength(existing.length);
  });
});
