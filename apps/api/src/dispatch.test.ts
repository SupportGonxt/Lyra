import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, isNull } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { emit, permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { drainOutbox } from "./dispatch.js";

// A queue.send() that throws must not abort the drain: the failing event's
// outbox attempts have to rise (so pendingOutbox's MAX_ATTEMPTS dead-letter cap
// can ever engage) and every event behind it must still publish.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

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

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now: 1_700_000_000_000,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

describe("drainOutbox", () => {
  it("marks a queue-send failure and keeps draining the events behind it", async () => {
    const first = await emit(ctx, { module: "core", type: "core.test.poison", data: {} });
    ctx = { ...ctx, now: ctx.now + 1 };
    const second = await emit(ctx, { module: "core", type: "core.test.fine", data: {} });

    const result = await drainOutbox(ctx, {
      send: async (e) => {
        if (e.id === first.id) throw new Error("queue unavailable");
      }
    });

    expect(result.queued).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);

    const rows = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.id, first.id));
    expect(rows[0]?.publishedAt).toBeNull();
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain("queue unavailable");

    const ok = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.id, second.id));
    expect(ok[0]?.publishedAt).toBe(ctx.now);
  });

  it("closes SIGNAL's funnel when a policy is issued — the lead becomes a bind", async () => {
    // A lead the portal tracking pixel attributed to a campaign.
    await ctx.db.insert(schema.signalAttributionEvents).values({
      id: "att_lead",
      tenantId: ctx.tenantId,
      customerId: "cus_1",
      anonId: null,
      touchType: "lead",
      channel: "meta",
      campaignId: "cmp_1",
      creativeId: null,
      valueMinor: null,
      currency: null,
      subjectRef: null,
      ts: ctx.now
    });

    await emit(ctx, {
      module: "axis",
      type: "axis.policy.issued",
      subject: "pol_1",
      data: { policyId: "pol_1", customerId: "cus_1", premiumMinor: 120_000_00, currency: "AED" }
    });

    await drainOutbox(ctx);

    const binds = await ctx.db
      .select()
      .from(schema.signalAttributionEvents)
      .where(eq(schema.signalAttributionEvents.touchType, "bind"));
    expect(binds).toHaveLength(1);
    expect(binds[0]?.campaignId).toBe("cmp_1");
    expect(binds[0]?.valueMinor).toBe(120_000_00);
    expect(binds[0]?.subjectRef).toBe("pol_1");
  });

  it("acknowledges a portal-filed DSAR by notifying the compliance staff", async () => {
    // A user holding the tenant.compliance role.
    const roleId = "rol_compliance";
    await ctx.db.insert(schema.roles).values({
      id: roleId,
      tenantId: ctx.tenantId,
      key: "tenant.compliance",
      name: "Compliance",
      permissionsJson: "[]",
      system: true,
      createdAt: ctx.now
    });
    await ctx.db.insert(schema.userRoles).values({
      id: "ur_1",
      tenantId: ctx.tenantId,
      userId: "u_comp",
      roleId,
      createdAt: ctx.now
    });

    await emit(ctx, {
      module: "compliance",
      type: "compliance.dsar-requests.created",
      subject: "dsr_1",
      data: { id: "dsr_1", type: "access", via: "portal" }
    });

    await drainOutbox(ctx);

    const notes = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.tenantId, ctx.tenantId));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.userId).toBe("u_comp");
    expect(notes[0]?.subjectRef).toBe("dsr_1");
  });
});

/* --------------- a failed delivery is retried on a quiet tenant too */

/**
 * The 2026-10-01 sweep's JOBS finding. `retryFailed` sat at the **end** of
 * `drainOutbox`, behind an early return for an empty outbox — so a failed webhook
 * delivery was retried only when some **unrelated** event happened to be pending in
 * the same tick. On a quiet tenant it was never retried at all.
 *
 * The comment where the call used to be read *"Retries run every tick regardless of
 * the queue"* — what the code was supposed to do and did not. This asserts it.
 */
describe("drainOutbox retries with nothing new to publish", () => {
  it("replays a due failed delivery even though the outbox is empty", async () => {
    await ctx.db.insert(schema.webhooks).values({
      id: "whk_retry",
      tenantId: ctx.tenantId,
      url: "https://partner.test/hook",
      secret: "s3cret",
      status: "active",
      eventTypesJson: JSON.stringify(["axis.policy.issued"]),
      createdAt: ctx.now,
      updatedAt: ctx.now
    } as never);
    await ctx.db.insert(schema.webhookDeliveries).values({
      id: "whd_retry",
      tenantId: ctx.tenantId,
      webhookId: "whk_retry",
      eventId: "evt_old",
      eventType: "axis.policy.issued",
      envelopeJson: JSON.stringify({
        id: "evt_old",
        tenantId: ctx.tenantId,
        module: "axis",
        type: "axis.policy.issued",
        subject: "pol_1",
        ts: ctx.now - 60_000,
        data: { policyId: "pol_1" }
      }),
      status: "failed",
      attempts: 1,
      // Due now: the backoff has elapsed and it is waiting only on a tick.
      nextAttemptAt: ctx.now - 1_000,
      createdAt: ctx.now - 60_000,
      updatedAt: ctx.now - 60_000
    } as never);

    // The event's outbox row exists and is **published** — so `pendingOutbox`
    // returns nothing and the drain takes its empty-batch path. That is the case
    // that used to skip the retry entirely, and it is the normal state of a tenant
    // whose last delivery failed: the event was published, the *delivery* failed.
    await ctx.db.insert(schema.eventOutbox).values({
      id: "evt_old",
      tenantId: ctx.tenantId,
      module: "axis",
      type: "axis.policy.issued",
      subject: "pol_1",
      envelopeJson: JSON.stringify({
        id: "evt_old",
        tenantId: ctx.tenantId,
        module: "axis",
        type: "axis.policy.issued",
        subject: "pol_1",
        ts: ctx.now - 60_000,
        data: { policyId: "pol_1" }
      }),
      attempts: 1,
      publishedAt: ctx.now - 60_000,
      createdAt: ctx.now - 60_000,
      updatedAt: ctx.now - 60_000
    } as never);
    const pending = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, ctx.tenantId), isNull(schema.eventOutbox.publishedAt)));
    expect(pending).toHaveLength(0);

    await drainOutbox(ctx);

    // The observable is the **status**, not `attempts`: `retryFailed` supersedes
    // rather than updates, because the delivery table is the attempt history — the
    // superseded row keeps its original count and a new row carries the new attempt
    // ("Supersede rather than update", dispatch.ts:364). Before the fix this row sat
    // at `failed` with its deadline long past, for ever.
    const [after] = await ctx.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, "whd_retry"));
    expect(after!.status).toBe("superseded");
    const attempts = await ctx.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.tenantId, ctx.tenantId));
    expect(attempts.length).toBeGreaterThan(1);
  });
});
