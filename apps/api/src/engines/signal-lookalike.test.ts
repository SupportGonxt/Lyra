import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { AppError, PROTECTED_AXES, notFound, permissionsForRole, seed, type Ctx } from "@lyra/core";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import { expandAudience, lookalikeWriteProblem } from "./signal-lookalike.js";
import { audienceRuleProblem, recipientsFor } from "./signal-outreach.js";
import { BY_MODULE } from "../resources.js";
import type { App } from "../env.js";

// docs/17 §SIG-028 (lookalike expansion with consent basis preserved), ADR-0113,
// against a real libSQL book: the consent states, suppression and deleted rows
// the pure scorer is handed are the ones the database actually holds.
//
// The seed audience is everyone tagged `bound` (24, all lsm:7 in gauteng, all
// consented to marketing and profiling). Around it:
//
//   close      5 × lsm:7 + gauteng, every purpose           -> in, score 1000
//   half       5 × gauteng, marketing+profiling+dataSharing -> in, score 500
//   noProfile  3 × lsm:7 + gauteng, marketing only          -> excluded: consent
//   expired    2 × lsm:7 + gauteng, every purpose, expired  -> excluded: consent
//   suppressed 2 × lsm:7 + gauteng, a suppressed prospect   -> excluded: suppressed
//   erased     2 × lsm:7 + gauteng, soft-deleted            -> never considered
//   protected  3 × religion:observant, every purpose        -> excluded: unlike
//   far        2 × region:limpopo, every purpose            -> excluded: unlike
//
// and a second tenant whose five perfect lookalikes must never appear.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 8, 28, 8, 0, 0);
const OTHER_TENANT = "tn_other_lookalike";

const EVERY = { marketing: true, profiling: true, dataSharing: true, crossBorder: true };
const MP = { marketing: true, profiling: true };

let client: Client;
let ctx: Ctx;
let tenantId: string;
let seedAudienceId: string;
const ids: Record<string, string[]> = {};

async function people(
  tenant: string,
  group: string,
  n: number,
  tags: string[],
  purposes: Record<string, boolean> | null,
  opts: { expiry?: number; deleted?: boolean; suppressed?: boolean } = {}
): Promise<void> {
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `cu_${group}_${String(i).padStart(2, "0")}`;
    made.push(id);
    await ctx.db.insert(schema.customers).values({
      id,
      tenantId: tenant,
      type: "person",
      nameJson: JSON.stringify({ en: `${group} ${i}` }),
      kycStatus: "none",
      tagsJson: JSON.stringify(tags),
      locale: "en",
      deletedAt: opts.deleted ? NOW : null,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
    if (purposes) {
      await ctx.db.insert(schema.consents).values({
        id: `con_${group}_${i}`,
        tenantId: tenant,
        customerId: id,
        purposesJson: JSON.stringify(purposes),
        channelOptinsJson: JSON.stringify({ whatsapp: true }),
        source: "portal",
        ts: NOW - 86_400_000,
        expiry: opts.expiry ?? null
      });
    }
    if (opts.suppressed) {
      await ctx.db.insert(schema.signalProspects).values({
        id: `psp_${group}_${i}`,
        tenantId: tenant,
        customerId: id,
        reason: "no_policy",
        state: "suppressed",
        createdAt: NOW,
        updatedAt: NOW
      });
    }
  }
  ids[group] = made;
}

async function audience(tenant: string, id: string, def: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  await ctx.db.insert(schema.signalAudiences).values({
    id,
    tenantId: tenant,
    name: `Audience ${id}`,
    definitionJson: JSON.stringify(def),
    consentPurposes: "marketing",
    createdBy: "user:u_1",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra
  });
  return id;
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "signal-lookalike-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "user",
      id: "u_1",
      tenantId,
      grants: [{ roleKey: "signal.lead", permissions: permissionsForRole("signal.lead") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };

  await people(tenantId, "seed", 24, ["bound", "lsm:7", "region:gauteng"], MP);
  await people(tenantId, "close", 5, ["lsm:7", "region:gauteng"], EVERY);
  await people(tenantId, "half", 5, ["region:gauteng"], { ...MP, dataSharing: true });
  await people(tenantId, "noprofile", 3, ["lsm:7", "region:gauteng"], { marketing: true });
  await people(tenantId, "expired", 2, ["lsm:7", "region:gauteng"], EVERY, { expiry: NOW - 1 });
  await people(tenantId, "suppressed", 2, ["lsm:7", "region:gauteng"], EVERY, { suppressed: true });
  await people(tenantId, "erased", 2, ["lsm:7", "region:gauteng"], EVERY, { deleted: true });
  await people(tenantId, "protected", 3, ["religion:observant"], EVERY);
  await people(tenantId, "far", 2, ["region:limpopo"], EVERY);
  await people(OTHER_TENANT, "theirs", 5, ["lsm:7", "region:gauteng"], EVERY);

  seedAudienceId = await audience(tenantId, "aud_seed_bound", { all: [{ field: "tagsJson", op: "contains", value: "bound" }] });
  await audience(OTHER_TENANT, "aud_theirs", { all: [{ field: "tagsJson", op: "contains", value: "lsm:7" }] });
}, 120_000);

const membersOf = async (audienceId: string) =>
  ctx.db
    .select()
    .from(schema.signalAudienceMembers)
    .where(and(eq(schema.signalAudienceMembers.tenantId, tenantId), eq(schema.signalAudienceMembers.audienceId, audienceId)));

const audienceRow = async (id: string) =>
  (await ctx.db.select().from(schema.signalAudiences).where(eq(schema.signalAudiences.id, id)))[0]!;

const counts = async () => ({
  audiences: (await ctx.db.select().from(schema.signalAudiences)).length,
  members: (await ctx.db.select().from(schema.signalAudienceMembers)).length,
  audits: (await ctx.db.select().from(schema.auditLog)).length,
  events: (await ctx.db.select().from(schema.eventOutbox)).length
});

describe("expandAudience", () => {
  it("writes the top N consented lookalikes, ranked, with the strictest basis they share", async () => {
    const out = await expandAudience(ctx, seedAudienceId, { size: 50 });

    expect(out.size).toBe(10);
    expect(out.basis).toEqual(["marketing", "profiling", "dataSharing"]);
    const rows = await membersOf(out.audienceId);
    expect(rows.map((r) => r.customerId).sort()).toEqual([...ids.close!, ...ids.half!].sort());
    for (const r of rows) {
      expect(r.score).toBe(ids.close!.includes(r.customerId) ? 1000 : 500);
      expect(JSON.parse(r.matchedJson)).toContainEqual({ axis: "region", value: "gauteng" });
    }

    const row = await audienceRow(out.audienceId);
    expect(row.tenantId).toBe(tenantId);
    expect(row.sizeCached).toBe(10);
    expect(row.consentPurposes).toBe("marketing,profiling,dataSharing");
    expect(row.refreshPolicy).toBe("manual");
    const def = JSON.parse(row.definitionJson) as {
      all: unknown[];
      lookalike: { seedAudienceId: string; seedSize: number; requested: number; floor: number; axes: string[]; excluded: Record<string, number> };
    };
    expect(def.all).toEqual([{ field: "lookalike.member", op: "eq", value: true }]);
    expect(def.lookalike).toMatchObject({
      seedAudienceId,
      seedSize: 24,
      requested: 50,
      floor: 20,
      axes: ["lsm", "region"]
    });
    expect(def.lookalike.excluded).toMatchObject({ seed: 24, consent: 5, suppressed: 2, beyondSize: 0 });
    expect(def.lookalike.excluded.unlike).toBeGreaterThanOrEqual(5);
  });

  it("never scores or stores a protected attribute", async () => {
    const out = await expandAudience(ctx, seedAudienceId, { size: 50 });
    const row = await audienceRow(out.audienceId);
    const rows = await membersOf(out.audienceId);
    const stored = JSON.stringify([row, rows]);
    for (const axis of PROTECTED_AXES) expect(stored).not.toContain(`"${axis}"`);
    expect(rows.some((r) => ids.protected!.includes(r.customerId))).toBe(false);
  });

  it("keeps exactly the top N and says how many it left out", async () => {
    const out = await expandAudience(ctx, seedAudienceId, { size: 5 });
    expect((await membersOf(out.audienceId)).map((r) => r.customerId).sort()).toEqual([...ids.close!].sort());
    // Only the closest five, all of whom granted everything: the basis widens.
    expect(out.basis).toEqual(["marketing", "profiling", "dataSharing", "crossBorder"]);
    expect(out.excluded.beyondSize).toBe(5);
  });

  it("audits and emits the expansion", async () => {
    const out = await expandAudience(ctx, seedAudienceId, { size: 3, name: "Bound lookalikes" });
    expect((await audienceRow(out.audienceId)).name).toBe("Bound lookalikes");
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.subjectRef, `signal_audience:${out.audienceId}`)));
    expect(audits.map((a) => a.action)).toEqual(["signal.audience.expanded"]);
    const events = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, tenantId), eq(schema.eventOutbox.type, "signal.audience.expanded")));
    expect(events.some((e) => (JSON.parse(e.envelopeJson) as { subject?: string }).subject === out.audienceId)).toBe(true);
  });

  it("refuses another tenant's audience as not found, and writes nothing", async () => {
    const before = await counts();
    await expect(expandAudience(ctx, "aud_theirs", { size: 5 })).rejects.toMatchObject({ status: 404 });
    expect(await counts()).toEqual(before);
  });

  it("refuses a seed under the k-anonymity floor with a conflict, and writes nothing", async () => {
    const thin = await audience(tenantId, "aud_thin", { all: [{ field: "tagsJson", op: "contains", value: "limpopo" }] });
    const before = await counts();
    const err = await expandAudience(ctx, thin, { size: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409 });
    expect((err as AppError).detail).toMatch(/fewer than 20/);
    expect(await counts()).toEqual(before);
  });

  it("refuses a size out of bounds as a bad request", async () => {
    await expect(expandAudience(ctx, seedAudienceId, { size: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("expands a lookalike of a lookalike through the same resolver", async () => {
    const first = await expandAudience(ctx, seedAudienceId, { size: 50 });
    // Ten members, but the floor is twenty: its own profile is too thin to be alike on.
    await expect(expandAudience(ctx, first.audienceId, { size: 5 })).rejects.toMatchObject({ status: 409 });
  });
});

describe("outreach resolves a lookalike against current consent", () => {
  it("reaches the members, and drops one who withdraws profiling after the expansion", async () => {
    const out = await expandAudience(ctx, seedAudienceId, { size: 5 });
    const campaign = { id: "cmp_lookalike", name: "Lookalike push", audienceId: out.audienceId };
    expect((await recipientsFor(ctx, campaign)).map((r) => r.customerId).sort()).toEqual([...ids.close!].sort());

    const leaver = ids.close![0]!;
    await ctx.db.insert(schema.consents).values({
      id: "con_leaver_withdraws_profiling",
      tenantId,
      customerId: leaver,
      purposesJson: JSON.stringify({ ...EVERY, profiling: false }),
      channelOptinsJson: JSON.stringify({ whatsapp: true }),
      source: "portal",
      ts: NOW
    });
    const after = (await recipientsFor(ctx, campaign)).map((r) => r.customerId);
    expect(after).not.toContain(leaver);
    expect(after).toHaveLength(4);
  });
});

describe("lookalikeWriteProblem", () => {
  const lookalikeDef = { all: [{ field: "lookalike.member", op: "eq", value: true }], lookalike: { seedAudienceId: "aud_x" } };

  it("refuses a lookalike rule written by hand", () => {
    expect(lookalikeWriteProblem({ definitionJson: lookalikeDef }, undefined)?.field).toBe("definitionJson");
    expect(lookalikeWriteProblem({ definitionJson: JSON.stringify(lookalikeDef) }, { definitionJson: "{}" })?.field).toBe("definitionJson");
  });

  it("refuses a lookalike leaf smuggled into an ordinary rule", () => {
    expect(
      lookalikeWriteProblem({ definitionJson: { any: [{ field: "lookalike.member", op: "eq", value: true }] } }, undefined)?.problem
    ).toMatch(/expand/);
  });

  it("refuses a change to a lookalike's consent basis", () => {
    const existing = { definitionJson: JSON.stringify(lookalikeDef), consentPurposes: "marketing,profiling" };
    expect(lookalikeWriteProblem({ consentPurposes: "marketing,profiling,dataSharing" }, existing)).toMatchObject({ field: "consentPurposes", problem: expect.stringMatching(/consent basis/) });
    // Posting the same basis back — an edit form sends every field — is not a change.
    expect(lookalikeWriteProblem({ consentPurposes: "marketing,profiling" }, existing)).toBeNull();
  });

  it("lets a lookalike be narrowed by an extra leaf", () => {
    const existing = { definitionJson: JSON.stringify(lookalikeDef), consentPurposes: "marketing,profiling" };
    const narrowed = {
      all: [...lookalikeDef.all, { field: "tagsJson", op: "contains", value: "vip" }],
      lookalike: lookalikeDef.lookalike
    };
    expect(lookalikeWriteProblem({ definitionJson: narrowed }, existing)).toBeNull();
  });

  it("leaves ordinary audiences alone", () => {
    expect(lookalikeWriteProblem({ definitionJson: { all: [{ field: "tagsJson", op: "contains", value: "vip" }] }, consentPurposes: "anything" }, undefined)).toBeNull();
    expect(lookalikeWriteProblem({ name: "x" }, { definitionJson: "not json" })).toBeNull();
  });
});

describe("the audiences resource routes writes through lookalikeWriteProblem", () => {
  const resource = BY_MODULE.signal!.find((r) => r.path === "audiences")!;
  const write = (values: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
    Promise.resolve().then(() => resource.beforeWrite!(ctx, values, existing, {} as never));
  const lookalikeDef = JSON.stringify({ all: [{ field: "lookalike.member", op: "eq", value: true }], lookalike: {} });

  it("refuses a hand-written lookalike on create, naming the rule", async () => {
    await expect(write({ name: "x", definitionJson: lookalikeDef })).rejects.toMatchObject({
      status: 400,
      extras: { errors: { definitionJson: expect.stringMatching(/expand/) } }
    });
  });

  it("refuses a widened basis on update, naming the basis", async () => {
    await expect(
      write({ consentPurposes: "marketing,profiling,dataSharing" }, { definitionJson: lookalikeDef, consentPurposes: "marketing,profiling" })
    ).rejects.toMatchObject({ status: 400, extras: { errors: { consentPurposes: expect.stringMatching(/consent basis/) } } });
  });

  it("lets an edit form post a lookalike back unchanged", async () => {
    const existing = { definitionJson: lookalikeDef, consentPurposes: "marketing,profiling" };
    await expect(write({ definitionJson: lookalikeDef, consentPurposes: "marketing,profiling" }, existing)).resolves.toBeDefined();
  });

  it("is a rule the resolver accepts", () => {
    expect(audienceRuleProblem({ all: [{ field: "lookalike.member", op: "eq", value: true }] })).toBeNull();
    expect(audienceRuleProblem({ all: [{ field: "lookalike.member", op: "eq", value: false }] })).toMatch(/lookalike\.member/);
  });
});

describe("POST /audiences/:id/lookalike", () => {
  const app = (actor: Ctx["actor"]): Hono<App> => {
    const a = new Hono<App>();
    a.onError(onError);
    a.notFound((c) => onError(notFound(c.req.path), c));
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor });
      await next();
    });
    a.route("/", signalRoutes);
    return a;
  };
  const actorWith = (permissions: string[]): Ctx["actor"] => ({
    kind: "user",
    id: "u_route",
    tenantId,
    grants: [{ roleKey: "test", permissions: permissions as Ctx["actor"]["grants"][number]["permissions"] }]
  });
  const post = async (a: Hono<App>, id: string, body: unknown) => {
    const res = await a.fetch(
      new Request(`http://api.test/audiences/${id}/lookalike`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("refuses an actor without signal:audiences:create, and writes nothing", async () => {
    const before = await counts();
    const res = await post(app(actorWith(["signal:audiences:read"])), seedAudienceId, { size: 5 });
    expect(res.status).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("creates the lookalike and answers its id, size and basis", async () => {
    const res = await post(app(actorWith(["signal:audiences:create"])), seedAudienceId, { size: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ size: 5, basis: expect.arrayContaining(["marketing", "profiling"]) });
    expect(res.body.id).toBe(res.body.audienceId);
  });

  it("rejects a size the body schema does not allow, naming the field", async () => {
    const res = await post(app(actorWith(["signal:audiences:create"])), seedAudienceId, { size: 0 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty("size");
  });
});
