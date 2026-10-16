import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx, type Envelope } from "@lyra/core";
import { onCreativeFlagged } from "./signal-creative-notify.js";

// `signal.creative.flagged` was emitted by the generator and consumed by nobody,
// so a variant the pre-flight flagged reached the approvals queue and told no
// one. This is the consumer, and these are the tests that demand it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";

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
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "system", id: "outbox", tenantId: TENANT, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/** One user holding `tenant.compliance` — the role with `signal:creatives:approve`. */
async function reviewer(userId: string) {
  const roleId = "rol_compliance";
  const [existing] = await ctx.db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
  if (!existing) {
    await ctx.db.insert(schema.roles).values({
      id: roleId,
      tenantId: TENANT,
      key: "tenant.compliance",
      name: "Compliance",
      permissionsJson: JSON.stringify([...permissionsForRole("tenant.compliance")]),
      createdAt: NOW
    });
  }
  await ctx.db.insert(schema.users).values({
    id: userId,
    tenantId: TENANT,
    name: userId,
    email: `${userId}@test.example`,
    locale: "en",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.userRoles).values({ id: `ur_${userId}`, tenantId: TENANT, userId, roleId, createdAt: NOW });
}

const envelope = (data: Record<string, unknown>, subject = "crv_1"): Envelope =>
  ({ id: "evt_1", type: "signal.creative.flagged", subject, ts: NOW, tenantId: TENANT, data } as unknown as Envelope);

describe("onCreativeFlagged", () => {
  it("tells every reviewer that a variant needs a decision", async () => {
    await reviewer("usr_one");
    await reviewer("usr_two");
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_1", campaignId: "cmp_1", rules: ["banned-claim", "superlative"] }));

    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.userId).sort()).toEqual(["usr_one", "usr_two"]);
    expect(notes[0]).toMatchObject({ kind: "review", titleKey: "signal.creative.flagged", subjectRef: "crv_1" });
    // Rule 7: a key and its parameters, never a rendered sentence.
    expect(JSON.parse(notes[0]!.paramsJson!)).toEqual({
      creativeId: "crv_1",
      campaignId: "cmp_1",
      rules: ["banned-claim", "superlative"]
    });
  });

  it("does not tell the same reviewer twice about the same variant", async () => {
    // The inbox is a queue, not a log: re-flagging a variant says nothing new to
    // somebody who has already been told and not yet acted.
    await reviewer("usr_one");
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_1" }));
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_1" }));
    expect(await ctx.db.select().from(schema.notifications)).toHaveLength(1);

    // A different variant is a different question, and is asked again.
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_2" }));
    expect(await ctx.db.select().from(schema.notifications)).toHaveLength(2);
  });

  it("records why nobody was told when the tenant has no reviewer seat", async () => {
    // Notifying nobody is the honest outcome; a missing seat is what an operator
    // has to fix, so it is recorded rather than silently dropped.
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_1" }));
    expect(await ctx.db.select().from(schema.notifications)).toEqual([]);
    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, TENANT), eq(schema.auditLog.action, "signal.creative.flagged_unnotified")));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.subjectRef).toBe("signal_creative:crv_1");
  });

  it("falls back to the envelope's subject when the payload carries no id", async () => {
    await reviewer("usr_one");
    await onCreativeFlagged(ctx, envelope({}, "crv_from_subject"));
    const [note] = await ctx.db.select().from(schema.notifications);
    expect(note!.subjectRef).toBe("crv_from_subject");
  });

  it("does nothing at all when there is nothing to name", async () => {
    await reviewer("usr_one");
    await onCreativeFlagged(ctx, envelope({}, ""));
    expect(await ctx.db.select().from(schema.notifications)).toEqual([]);
    expect(await ctx.db.select().from(schema.auditLog)).toEqual([]);
  });

  it("never reaches another tenant's reviewers", async () => {
    await reviewer("usr_one");
    await ctx.db.insert(schema.users).values({
      id: "usr_other", tenantId: "t_2", name: "other", email: "o@test.example", locale: "en", status: "active", createdAt: NOW, updatedAt: NOW
    });
    await onCreativeFlagged(ctx, envelope({ creativeId: "crv_1" }));
    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes.map((n) => n.userId)).toEqual(["usr_one"]);
  });
});
