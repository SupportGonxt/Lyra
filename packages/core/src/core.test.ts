import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson } from "@lyra/db";
import { audit, chainFor, verifyChain } from "./audit.js";
import { consume, emit, markPublished, markPublishFailed, MAX_ATTEMPTS, pendingOutbox, replayDead, type Envelope } from "./events.js";
import { assertChannel, assertPurpose, recordConsent } from "./consent.js";
import { decide, gate } from "./approvals.js";
import { IDEMPOTENCY_TTL_MS, pruneIdempotency, withIdempotency } from "./idempotency.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function actor(roleKey: string, userId = "u_1"): Actor {
  return {
    kind: "user",
    id: userId,
    tenantId: "t_1",
    grants: [{ roleKey, permissions: permissionsForRole(roleKey) }]
  };
}

let client: Client;
let ctx: Ctx;

async function makeCtx(a: Actor = actor("tenant.admin"), now = 1_700_000_000_000): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: a,
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  ctx = await makeCtx();
});

describe("audit chain", () => {
  it("chains rows and detects tampering", async () => {
    for (const action of ["core.user.create", "core.user.update", "axis.case.approve"]) {
      ctx = { ...ctx, now: ctx.now + 1000 };
      await audit(ctx, { action, subjectRef: "user:u_2", after: { action } });
    }

    const rows = await chainFor(ctx);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.prevHash).toBeNull();
    expect(rows[1]!.prevHash).toBe(rows[0]!.chainHash);
    expect(await verifyChain(rows)).toEqual([]);

    // Edit a row in place, as an attacker with DB access would.
    await client.execute({
      sql: "UPDATE core_audit_log SET action = ? WHERE id = ?",
      args: ["core.user.delete", rows[1]!.id]
    });
    const breaks = await verifyChain(await chainFor(ctx));
    expect(breaks).toEqual([{ id: rows[1]!.id, reason: "hash_mismatch" }]);

    // Deleting a row breaks the link for every row after it.
    await client.execute({ sql: "DELETE FROM core_audit_log WHERE id = ?", args: [rows[1]!.id] });
    const afterDelete = await verifyChain(await chainFor(ctx));
    expect(afterDelete).toEqual([{ id: rows[2]!.id, reason: "prev_mismatch" }]);
  });
});

describe("events", () => {
  it("writes an outbox row and dedupes per consumer", async () => {
    const envelope = await emit(ctx, {
      module: "axis",
      type: "axis.case.issued",
      subject: "case:cs_1",
      data: { premiumMinor: 1000 }
    });
    expect(await pendingOutbox(ctx.db)).toHaveLength(1);

    let runs = 0;
    const handler = async () => {
      runs++;
    };
    expect(await consume(ctx.db, envelope, "orbit", handler, ctx.now)).toBe("processed");
    expect(await consume(ctx.db, envelope, "orbit", handler, ctx.now)).toBe("duplicate");
    expect(await consume(ctx.db, envelope, "ledger", handler, ctx.now)).toBe("processed");
    expect(runs).toBe(2);
  });

  it("skips outbox rows past MAX_ATTEMPTS and dead-letters them, so the drain keeps moving", async () => {
    // A poison row that keeps failing to publish must not sit at the head of the
    // oldest-first batch forever, starving every newer event behind it.
    const poison = await emit(ctx, { module: "core", type: "core.poison", data: {} });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await markPublishFailed(ctx.db, poison.id, "boom");
    const fresh = await emit({ ...ctx, now: ctx.now + 1_000 }, { module: "core", type: "core.fresh", data: {} });

    // limit 1: the old code returns only the (older) poison row, forever.
    const batch = await pendingOutbox(ctx.db, 1, ctx.now + 2_000);
    expect(batch.map((e) => e.id)).toEqual([fresh.id]);

    // Dead visibly, not silently dropped: one DLQ row, mirroring the inbox pattern.
    const dlq = await client.execute("SELECT consumer, attempts, error FROM core_event_dlq");
    expect(dlq.rows).toHaveLength(1);
    expect(dlq.rows[0]!["consumer"]).toBe("outbox.publish");
    expect(dlq.rows[0]!["attempts"]).toBe(MAX_ATTEMPTS);
    expect(dlq.rows[0]!["error"]).toBe("boom");

    // A second drain does not re-dead-letter the same row.
    expect((await pendingOutbox(ctx.db, 10, ctx.now + 3_000)).map((e) => e.id)).toEqual([fresh.id]);
    const again = await client.execute("SELECT id FROM core_event_dlq");
    expect(again.rows).toHaveLength(1);
  });

  it("dead-letters after MAX_ATTEMPTS", async () => {
    const envelope: Envelope = await emit(ctx, { module: "orbit", type: "orbit.msg.in", data: {} });
    const boom = async () => {
      throw new Error("nope");
    };
    let result = "";
    for (let i = 0; i < 5; i++) result = await consume(ctx.db, envelope, "axis", boom, ctx.now);
    expect(result).toBe("dead");
    const dlq = await client.execute("SELECT * FROM core_event_dlq");
    expect(dlq.rows).toHaveLength(1);
  });

  // docs/30 Admin 4: the DLQ promised admin replay (docs/09) and had no replay.
  // A replay re-queues the event and clears only the dead consumer's mark, so
  // that consumer runs again and every consumer that already succeeded skips it.
  it("replays a dead consumer once: the event drains again and only that consumer re-runs", async () => {
    const envelope: Envelope = await emit(ctx, { module: "orbit", type: "orbit.msg.in", data: {} });
    await markPublished(ctx.db, [envelope.id], ctx.now);
    await consume(ctx.db, envelope, "ok.consumer", async () => {}, ctx.now);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await consume(ctx.db, envelope, "axis", async () => { throw new Error("nope"); }, ctx.now);
    const [dead] = (await client.execute("SELECT id FROM core_event_dlq")).rows;

    await replayDead(ctx.db, ctx.tenantId, String(dead!["id"]), ctx.now + 1);
    expect((await pendingOutbox(ctx.db, 10, ctx.now + 2)).map((e) => e.id)).toEqual([envelope.id]);
    let ran = 0;
    expect(await consume(ctx.db, envelope, "axis", async () => { ran++; }, ctx.now + 3)).toBe("processed");
    expect(await consume(ctx.db, envelope, "ok.consumer", async () => { ran += 10; }, ctx.now + 3)).toBe("duplicate");
    expect(ran).toBe(1);

    const [after] = (await client.execute("SELECT replayed_at FROM core_event_dlq")).rows;
    expect(after!["replayed_at"]).toBe(ctx.now + 1);
    await expect(replayDead(ctx.db, ctx.tenantId, String(dead!["id"]), ctx.now + 4)).rejects.toMatchObject({ status: 409 });
    await expect(replayDead(ctx.db, "other_tenant", String(dead!["id"]), ctx.now + 4)).rejects.toMatchObject({ status: 404 });
  });
});

describe("consent", () => {
  it("gates purposes and channels, and honours expiry", async () => {
    await recordConsent(ctx, {
      customerId: "cu_1",
      purposes: { marketing: true },
      channels: { whatsapp: true },
      source: "web"
    });
    await expect(assertPurpose(ctx, "cu_1", "marketing")).resolves.toBeUndefined();
    await expect(assertPurpose(ctx, "cu_1", "profiling")).rejects.toThrow(AppError);
    await expect(assertChannel(ctx, "cu_1", "whatsapp")).resolves.toBeUndefined();
    await expect(assertChannel(ctx, "cu_1", "sms")).rejects.toThrow(AppError);

    // Withdrawal is a new row, not an edit.
    const later = { ...ctx, now: ctx.now + 1 };
    await recordConsent(later, {
      customerId: "cu_1",
      purposes: { marketing: false },
      channels: { whatsapp: true },
      source: "portal"
    });
    await expect(assertPurpose(later, "cu_1", "marketing")).rejects.toThrow(AppError);
    // Service messages still allowed on an opted-in channel.
    await expect(
      assertChannel(later, "cu_1", "whatsapp", { marketing: false })
    ).resolves.toBeUndefined();
  });
});

describe("approvals", () => {
  it("requires an approval, then honours it", async () => {
    const finance = await makeCtx(actor("finance.controller", "u_fin"), ctx.now);
    const initiator = await makeCtx(actor("finance.analyst", "u_ops"), ctx.now);

    await expect(gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:tx_1" })).rejects.toThrow(
      /Approval required/
    );

    const pending = await client.execute("SELECT id FROM core_approvals");
    const approvalId = pending.rows[0]!.id as string;

    // Dual control: the initiator cannot approve their own request.
    const selfApprove = await makeCtx(actor("finance.controller", "u_ops"), ctx.now);
    await expect(decide(selfApprove, approvalId, "approved")).rejects.toMatchObject({
      code: "bad_request",
      detail: expect.stringContaining("dual control")
    });

    await decide(finance, approvalId, "approved", "statement attached");
    const authorised = await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:tx_1" });
    expect(authorised?.decision).toBe("approved");
  });

  it("never auto-approves client money, whatever the tenant policy says", async () => {
    const lax = {
      ...ctx,
      policy: PolicyJson.parse({ autoApprove: ["ledger.client_money_transfer", "signal.budget_move"] })
    };
    await expect(
      gate(lax, { policyKey: "ledger.client_money_transfer", subjectRef: "txn:tx_2" })
    ).rejects.toThrow(/Approval required/);
    // A non-floor policy on the allowlist passes straight through.
    await expect(gate(lax, { policyKey: "signal.budget_move", subjectRef: "bm_1" })).resolves.toBeNull();
  });
});

describe("idempotency", () => {
  it("replays the stored response and rejects a reused key", async () => {
    let calls = 0;
    const run = () =>
      withIdempotency(ctx, "k1", "POST /v1/axis/cases", { a: 1 }, async () => {
        calls++;
        return { id: "cs_1" };
      });

    expect(await run()).toEqual({ id: "cs_1" });
    expect(await run()).toEqual({ id: "cs_1" });
    expect(calls).toBe(1);

    await expect(
      withIdempotency(ctx, "k1", "POST /v1/axis/cases", { a: 2 }, async () => ({ id: "cs_2" }))
    ).rejects.toMatchObject({ code: "conflict", detail: expect.stringContaining("different body") });
  });

  it("lets a failed attempt be retried", async () => {
    await expect(
      withIdempotency(ctx, "k2", "POST /v1/axis/cases", { a: 1 }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(
      await withIdempotency(ctx, "k2", "POST /v1/axis/cases", { a: 1 }, async () => ({ ok: true }))
    ).toEqual({ ok: true });
  });

  // No key means no slot: the handler runs every time and nothing is stored, so
  // a caller who never sends the header is never silently de-duplicated.
  it.each([
    ["undefined", undefined],
    ["an empty string", ""]
  ])("runs every time and stores nothing when the key is %s", async (_label, key) => {
    let calls = 0;
    const run = () => withIdempotency(ctx, key, "POST /v1/axis/cases", { a: 1 }, async () => ({ n: ++calls }));
    expect(await run()).toEqual({ n: 1 });
    expect(await run()).toEqual({ n: 2 });
    expect((await client.execute("SELECT id FROM core_idempotency_keys")).rows).toHaveLength(0);
  });

  // The slot is (tenant, key, route) — all three. Drop any one and a key reused
  // legitimately on another route, or by another tenant, replays the wrong body.
  it("scopes the slot to the route, so the same key on another route runs again", async () => {
    await withIdempotency(ctx, "k3", "POST /v1/axis/cases", { a: 1 }, async () => ({ id: "cs_1" }));
    expect(await withIdempotency(ctx, "k3", "POST /v1/axis/claims", { a: 1 }, async () => ({ id: "cl_1" }))).toEqual({
      id: "cl_1"
    });
  });

  it("scopes the slot to the tenant, so another tenant's identical key is its own", async () => {
    await withIdempotency(ctx, "k4", "POST /v1/axis/cases", { a: 1 }, async () => ({ id: "cs_1" }));
    const other = { ...ctx, tenantId: "t_2" };
    expect(await withIdempotency(other, "k4", "POST /v1/axis/cases", { a: 1 }, async () => ({ id: "cs_2" }))).toEqual({
      id: "cs_2"
    });
  });

  // 24h exactly, and the boundary is inclusive of the stored instant: a row whose
  // expiresAt has arrived is dead, not live.
  it("honours a key for 24h, then hands the slot to the next caller", async () => {
    let calls = 0;
    const run = (now: number) =>
      withIdempotency({ ...ctx, now }, "k5", "POST /v1/axis/cases", { a: 1 }, async () => ({ n: ++calls }));

    expect(await run(ctx.now)).toEqual({ n: 1 });
    // One millisecond before expiry: still a replay.
    expect(await run(ctx.now + IDEMPOTENCY_TTL_MS - 1)).toEqual({ n: 1 });
    // At expiry: the slot is taken over, and only one row survives.
    expect(await run(ctx.now + IDEMPOTENCY_TTL_MS)).toEqual({ n: 2 });
    expect((await client.execute("SELECT id FROM core_idempotency_keys")).rows).toHaveLength(1);
  });

  it("is 24 hours", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
  });

  // A replay that lands while the first attempt is still running must not run the
  // handler a second time — it is a 409, distinct from the reused-key 409.
  it("refuses a concurrent replay of a key still in flight", async () => {
    let release = (): void => {};
    let entered = (): void => {};
    const started = new Promise<void>((resolve) => (entered = resolve));
    const first = withIdempotency(
      ctx,
      "k6",
      "POST /v1/axis/cases",
      { a: 1 },
      () =>
        new Promise<{ id: string }>((resolve) => {
          release = () => resolve({ id: "cs_1" });
          entered();
        })
    );
    // withIdempotency commits the in-flight row before it calls the handler, so
    // the handler being entered is proof the row is there. Without this await the
    // second call races the first's insert and wins on a slow machine — the
    // handler runs twice and the test fails in CI having passed locally.
    await started;
    await expect(
      withIdempotency(ctx, "k6", "POST /v1/axis/cases", { a: 1 }, async () => ({ id: "cs_2" }))
    ).rejects.toMatchObject({ code: "conflict", detail: expect.stringContaining("still in flight") });
    // The row that conflict was read off: the prefixed id and the status word
    // are contract — the replay path and the prune sweep both read them back.
    const inFlight = await client.execute("SELECT id, status, response_json FROM core_idempotency_keys");
    expect(inFlight.rows).toHaveLength(1);
    expect(String(inFlight.rows[0]!.id)).toMatch(/^idm_/);
    expect(inFlight.rows[0]!.status).toBe("in_flight");
    expect(inFlight.rows[0]!.response_json).toBeNull();
    release();
    expect(await first).toEqual({ id: "cs_1" });
    const done = await client.execute("SELECT id, status FROM core_idempotency_keys");
    expect(done.rows[0]!.id).toBe(inFlight.rows[0]!.id);
    expect(done.rows[0]!.status).toBe("done");
  });

  it("hashes the request body canonically, so key order alone is not a different body", async () => {
    let calls = 0;
    const run = (request: unknown) =>
      withIdempotency(ctx, "k7", "POST /v1/axis/cases", request, async () => ({ n: ++calls }));
    expect(await run({ a: 1, b: 2 })).toEqual({ n: 1 });
    expect(await run({ b: 2, a: 1 })).toEqual({ n: 1 });
  });

  it("replays a handler that returned nothing without re-running it", async () => {
    let calls = 0;
    const run = () =>
      withIdempotency(ctx, "k8", "POST /v1/axis/cases", { a: 1 }, async () => {
        calls++;
      });
    expect(await run()).toBeUndefined();
    expect(await run()).toBeNull(); // stored as JSON null; the point is it did not re-run
    expect(calls).toBe(1);
  });

  it("prunes only the keys that have already expired", async () => {
    await withIdempotency(ctx, "k9", "POST /v1/axis/cases", { a: 1 }, async () => ({ id: "cs_1" }));
    await pruneIdempotency(ctx.db, ctx.now + IDEMPOTENCY_TTL_MS);
    expect((await client.execute("SELECT id FROM core_idempotency_keys")).rows).toHaveLength(1);
    await pruneIdempotency(ctx.db, ctx.now + IDEMPOTENCY_TTL_MS + 1);
    expect((await client.execute("SELECT id FROM core_idempotency_keys")).rows).toHaveLength(0);
  });
});

// PII masking lives in pii.test.ts: the fixture there is shaped like a real
// hydrated `core_customers` row, which is the thing the block that used to sit
// here never checked.

describe("tenancy", () => {
  it("keeps another tenant's audit rows out of the chain", async () => {
    await audit(ctx, { action: "core.user.create" });
    const other = await makeCtx(actor("tenant.admin", "u_9"), ctx.now);
    await audit({ ...other, tenantId: "t_2" }, { action: "core.user.create" });
    expect(await chainFor(ctx)).toHaveLength(1);
  });
});
