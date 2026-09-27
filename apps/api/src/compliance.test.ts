import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seed, sha256Hex } from "@lyra/core";
import { id as newId, schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/12 §3–§5. Three compliance capabilities held a permission and no
// endpoint: screening, evidence export, retention purge. What these tests are
// about is the part a form could not do honestly — the hashes and counts are
// the server's, never the caller's — plus the usual two: one tenant, one audit
// row per action.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const exec = { waitUntil() {}, passThroughOnException() {} };

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let database: Db;
let env: Env;
const tokens: Record<string, string> = {};
/** Rows planted in a tenant nobody here can log into. */
let foreign: { tenantId: string; screeningId: string; bundleId: string };

/** Compliance officer holds `compliance:*:*`; the agent holds none of it. */
const OFFICER = "khalid.rashed@gonxt.ae";
const AGENT = "layla.hassan@gonxt.ae";

interface Res<T = any> {
  status: number;
  body: T;
}

async function raw(
  email: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  const token = email ? tokens[email] : undefined;
  return app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
}

async function call<T = any>(
  email: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<Res<T>> {
  const res = await raw(email, method, path, payload, headers);
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

const HEX64 = /^[0-9a-f]{64}$/;

async function auditRows(action: string) {
  return database.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never);
  env = {
    DB_CLIENT: database,
    // Staging so the persona door is open; MFA proves nothing about a purge.
    ENVIRONMENT: "staging",
    APP_ORIGIN: "http://localhost:5173",
    // ponytail: a Map is the whole of R2 a bundle needs — put then get.
    FILES: (() => {
      const objects = new Map<string, Uint8Array>();
      return {
        put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes),
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { body: new Response(bytes).body } : null;
        }
      };
    })()
  } as unknown as Env;

  for (const email of [OFFICER, AGENT]) {
    const res = await call(null, "POST", "/v1/auth/demo/login", { email });
    expect(res.status).toBe(200);
    tokens[email] = res.body.token as string;
  }

  const now = Date.now();
  const tenantId = newId("tn", now);
  await database.insert(schema.tenants).values({
    id: tenantId,
    slug: "otherco",
    name: "Other Co",
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  const screeningId = newId("scr", now);
  await database.insert(schema.screenings).values({
    id: screeningId,
    tenantId,
    subjectRef: "name:someone else",
    kind: "sanctions",
    provider: "stub",
    queryHash: "0".repeat(64),
    result: "hit",
    hitsJson: null,
    blocked: true,
    ts: now
  });
  const bundleId = newId("evb", now);
  await database.insert(schema.evidenceBundles).values({
    id: bundleId,
    tenantId,
    purpose: "regulator",
    scopeJson: "{}",
    manifestJson: "{}",
    bundleHash: "1".repeat(64),
    fileId: null,
    requestedBy: "system:test",
    state: "ready",
    createdAt: now,
    updatedAt: now
  });
  foreign = { tenantId, screeningId, bundleId };
}, 60_000);

/* ------------------------------------------------------------- screening */

describe("POST /v1/compliance/screenings/run", () => {
  it("screens a name, hashes the query itself and returns a clear result", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/screenings/run", {
      name: "  Amina   Saleh ",
      identifiers: { passport: "A1234567" }
    });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe("clear");
    expect(res.body.blocked).toBe(false);
    expect(res.body.provider).toBe("stub");
    // Normalised subject: two spellings of one search are one subject.
    expect(res.body.subjectRef).toBe("name:amina saleh");
    expect(res.body.queryHash).toMatch(HEX64);
    expect(res.body.hits).toEqual([]);

    // Same question, differently typed, hashes the same — that is what makes
    // the hash evidence of the question rather than of the request body.
    const again = await call(OFFICER, "POST", "/v1/compliance/screenings/run", {
      name: "AMINA SALEH",
      identifiers: { passport: "A1234567" }
    });
    expect(again.body.queryHash).toBe(res.body.queryHash);
    expect(again.body.id).not.toBe(res.body.id);
  });

  it("blocks on a hit, labels it a stub and emits instead of writing another module's rows", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/screenings/run", { name: "lyra-test-hit" });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe("hit");
    expect(res.body.blocked).toBe(true);
    expect(res.body.hits[0].stub).toBe(true);
    // docs/19 §4 wants case + block. The case is opened by a consumer of the
    // event, so the ref stays null here rather than compliance writing AXIS.
    expect(res.body.caseRef).toBeNull();

    const outbox = await database
      .select()
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.type, "compliance.screening.hit"));
    expect(outbox.length).toBe(1);
  });

  it("screens a customer on file and refuses one that is not", async () => {
    const customers = await database.select({ id: schema.customers.id }).from(schema.customers).limit(1);
    const customerId = customers[0]!.id;
    const res = await call(OFFICER, "POST", "/v1/compliance/screenings/run", { customerId, kind: "pep" });
    expect(res.status).toBe(201);
    expect(res.body.subjectRef).toBe(`customer:${customerId}`);
    expect(res.body.kind).toBe("pep");

    expect((await call(OFFICER, "POST", "/v1/compliance/screenings/run", { customerId: "cus_nope" })).status).toBe(404);
    expect((await call(OFFICER, "POST", "/v1/compliance/screenings/run", {})).status).toBe(400);
  });

  it("refuses a caller-supplied hash and a caller-supplied result", async () => {
    for (const payload of [
      { name: "someone", queryHash: "deadbeef" },
      { name: "someone", result: "clear" },
      { name: "someone", provider: "worldcheck" }
    ]) {
      const res = await call(OFFICER, "POST", "/v1/compliance/screenings/run", payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses the generated create, which would take any of those", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/screenings", {
      subjectRef: "name:forged",
      kind: "sanctions",
      provider: "worldcheck",
      queryHash: "f".repeat(64),
      result: "clear"
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("/v1/compliance/screenings/run");
    const rows = await database
      .select()
      .from(schema.screenings)
      .where(eq(schema.screenings.subjectRef, "name:forged"));
    expect(rows.length).toBe(0);
  });

  it("is 403 without the run permission and 401 without a session", async () => {
    expect((await call(AGENT, "POST", "/v1/compliance/screenings/run", { name: "x" })).status).toBe(403);
    // The shadowed create answers 403 before it answers 400 — a caller without
    // the permission learns nothing about the shape of the resource.
    expect((await call(AGENT, "POST", "/v1/compliance/screenings", { subjectRef: "x" })).status).toBe(403);
    expect((await call(null, "POST", "/v1/compliance/screenings/run", { name: "x" })).status).toBe(401);
  });

  it("leaves the generated list and record routes serving", async () => {
    const mine = await call(OFFICER, "POST", "/v1/compliance/screenings/run", { name: "listable" });
    const list = await call(OFFICER, "GET", "/v1/compliance/screenings?limit=50");
    expect(list.status).toBe(200);
    expect(list.body.data.some((r: { id: string }) => r.id === mine.body.id)).toBe(true);
    const record = await call(OFFICER, "GET", `/v1/compliance/screenings/${mine.body.id}`);
    expect(record.status).toBe(200);
    expect(record.body.queryHash).toBe(mine.body.queryHash);
  });

  it("cannot see or fetch another tenant's screening", async () => {
    const list = await call(OFFICER, "GET", "/v1/compliance/screenings?limit=100");
    expect(list.body.data.some((r: { id: string }) => r.id === foreign.screeningId)).toBe(false);
    expect((await call(OFFICER, "GET", `/v1/compliance/screenings/${foreign.screeningId}`)).status).toBe(404);
  });

  it("writes an audit row for every run", async () => {
    const rows = await auditRows("compliance.screening.run");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId !== foreign.tenantId)).toBe(true);
    expect(rows.some((r) => r.subjectRef === "name:lyra-test-hit")).toBe(true);
  });
});

/* ------------------------------------------------------- evidence bundles */

describe("POST /v1/compliance/evidence-bundles/export", () => {
  let bundle: any;

  it("assembles the bundle, hashes each file and the archive", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "regulator",
      deliveredTo: "Insurance Authority"
    });
    expect(res.status).toBe(201);
    bundle = res.body;
    expect(bundle.state).toBe("ready");
    expect(bundle.bundleHash).toMatch(HEX64);
    expect(bundle.requestedBy).toMatch(/^user:/);
    // Nothing is delivered by this endpoint, whatever the request called it.
    expect(bundle.approvedBy).toBeNull();
    expect(bundle.manifest.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "ai-audit.jsonl",
      "audit.jsonl",
      "summary.pdf"
    ]);
    for (const file of bundle.manifest.files) expect(file.sha256).toMatch(HEX64);
    expect(bundle.manifest.tenantId).not.toBe(foreign.tenantId);
  });

  it("downloads an archive whose bytes hash to the stored bundle hash", async () => {
    const res = await raw(OFFICER, "GET", `/v1/compliance/evidence-bundles/${bundle.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
    // The hash on the row is the hash of what a regulator receives, manifest
    // included — otherwise it attests to nothing.
    expect(await sha256Hex(bytes)).toBe(bundle.bundleHash);
  });

  it("scopes to a subject and a window", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "dispute",
      subjectRef: "name:lyra-test-hit",
      from: 0,
      to: Date.now()
    });
    expect(res.status).toBe(201);
    const audits = res.body.manifest.files.find((f: { path: string }) => f.path === "audit.jsonl");
    expect(audits.sizeBytes).toBeGreaterThan(0);
    expect(res.body.bundleHash).not.toBe(bundle.bundleHash);
    expect((await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "audit",
      from: 2,
      to: 1
    })).status).toBe(400);
  });

  // The manifest renders the window with `new Date(x).toISOString()`, which
  // throws RangeError for |ms| > 8.64e15. `z.number().int()` is a *safe*-integer
  // check, so it let the band (8.64e15, 9.007e15] through and the throw landed
  // inside `withIdempotency` — a 500 on the one export path a regulator uses.
  it("refuses a window bound no Date can hold, and still exports a real one", async () => {
    expect((await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "audit",
      to: 9e15
    })).status).toBe(400);
    expect((await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "audit",
      from: 9e15
    })).status).toBe(400);
    // Positive control: the same route with a window a Date can hold still exports.
    const ok = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "audit",
      from: Date.now() - 86_400_000,
      to: Date.now()
    });
    expect(ok.status).toBe(201);
    expect(ok.body.manifest.scope.to).toBeLessThanOrEqual(8.64e15);
  });

  it("refuses a caller-supplied hash or manifest, by either door", async () => {
    expect((await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", {
      purpose: "audit",
      bundleHash: "a".repeat(64)
    })).status).toBe(400);
    const forged = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles", {
      purpose: "audit",
      scopeJson: "{}",
      manifestJson: "{}",
      bundleHash: "b".repeat(64)
    });
    expect(forged.status).toBe(400);
    const rows = await database
      .select()
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.bundleHash, "b".repeat(64)));
    expect(rows.length).toBe(0);
  });

  it("is 403 without the export permission, 401 without a session", async () => {
    expect((await call(AGENT, "POST", "/v1/compliance/evidence-bundles/export", { purpose: "audit" })).status).toBe(403);
    expect((await call(AGENT, "GET", `/v1/compliance/evidence-bundles/${bundle.id}/download`)).status).toBe(403);
    expect((await call(null, "POST", "/v1/compliance/evidence-bundles/export", { purpose: "audit" })).status).toBe(401);
  });

  it("replays the same bundle for a repeated idempotency key instead of building a second one (regression: IMPORTANT 4/5)", async () => {
    const key = `idem-export-${Date.now()}`;
    const payload = { purpose: "regulator", deliveredTo: "Insurance Authority" };
    const first = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", payload, { "idempotency-key": key });
    expect(first.status).toBe(201);

    const replay = await call(OFFICER, "POST", "/v1/compliance/evidence-bundles/export", payload, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.bundleHash).toBe(first.body.bundleHash);

    const rows = await database
      .select()
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.bundleHash, first.body.bundleHash));
    expect(rows.length).toBe(1);

    const conflict = await call(
      OFFICER,
      "POST",
      "/v1/compliance/evidence-bundles/export",
      { ...payload, purpose: "dispute" },
      { "idempotency-key": key }
    );
    expect(conflict.status).toBe(409);
  });

  it("cannot download another tenant's bundle", async () => {
    expect((await call(OFFICER, "GET", `/v1/compliance/evidence-bundles/${foreign.bundleId}/download`)).status).toBe(404);
    const list = await call(OFFICER, "GET", "/v1/compliance/evidence-bundles?limit=100");
    expect(list.body.data.some((r: { id: string }) => r.id === foreign.bundleId)).toBe(false);
  });

  it("writes an audit row for the export and for the download", async () => {
    const exported = await auditRows("compliance.evidence.export");
    expect(exported.some((r) => r.subjectRef === `evidence_bundle:${bundle.id}`)).toBe(true);
    const downloaded = await auditRows("compliance.evidence.download");
    expect(downloaded.some((r) => r.subjectRef === `evidence_bundle:${bundle.id}`)).toBe(true);
  });
});

/* ------------------------------------------------------------- retention */

describe("POST /v1/compliance/retention/run", () => {
  const OLD = Date.now() - 1000 * 60 * 60 * 24 * 365 * 3; // three years back
  let heldMessageId: string;
  let purgeableMessageId: string;
  let purgeRunId: string;
  let purgeAuditsBefore = 0;

  beforeAll(async () => {
    const tenants = await database
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, "gonxt"));
    const tenantId = tenants[0]!.id;

    const conversations = [
      { id: newId("conv", OLD), held: true },
      { id: newId("conv", OLD + 1), held: false }
    ];
    for (const conversation of conversations) {
      await database.insert(schema.orbitConversations).values({
        id: conversation.id,
        tenantId,
        customerId: null,
        channel: "whatsapp",
        state: "closed",
        lang: "en",
        createdAt: OLD,
        updatedAt: OLD
      });
    }
    heldMessageId = newId("msg", OLD);
    purgeableMessageId = newId("msg", OLD + 1);
    await database.insert(schema.orbitMessages).values([
      {
        id: heldMessageId,
        tenantId,
        conversationId: conversations[0]!.id,
        role: "customer",
        content: "under hold",
        ts: OLD
      },
      {
        id: purgeableMessageId,
        tenantId,
        conversationId: conversations[1]!.id,
        role: "customer",
        content: "past the floor",
        ts: OLD
      }
    ]);
    await database.insert(schema.legalHolds).values({
      id: newId("hold", OLD),
      tenantId,
      subjectRef: `conversation:${conversations[0]!.id}`,
      reason: "litigation",
      placedBy: "system:test",
      createdAt: OLD
    });
    // Another tenant's message, equally old: a purge must not reach it.
    await database.insert(schema.orbitConversations).values({
      id: newId("conv", OLD + 2),
      tenantId: foreign.tenantId,
      customerId: null,
      channel: "web",
      state: "closed",
      lang: "en",
      createdAt: OLD,
      updatedAt: OLD
    });
  });

  it("plans without deleting, and defaults to planning", async () => {
    // The seed ships this tenant's retention history, so what a plan must not do
    // is add to it — an absolute count would only be measuring the fixture.
    const runsBefore = (await database.select().from(schema.retentionRuns)).length;
    const res = await call(OFFICER, "POST", "/v1/compliance/retention/run", { policyKey: "messages" });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.tableName).toBe("orbit_messages");
    // The cutoff is the server's: 24 months from docs/12 §3, never the body's.
    expect(res.body.retentionMonths).toBeGreaterThanOrEqual(24);
    expect(res.body.cutoffAt).toBeLessThan(Date.now());
    expect(res.body.rowsAffected).toBe(1);
    expect(res.body.rowsHeld).toBe(1);

    // A plan is not a run: no new row, and nothing gone.
    expect((await database.select().from(schema.retentionRuns)).length).toBe(runsBefore);
    expect((await database.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.id, purgeableMessageId))).length).toBe(1);
  });

  it("refuses a caller-chosen cutoff or class", async () => {
    for (const payload of [
      { policyKey: "messages", cutoffAt: Date.now() },
      { policyKey: "messages", rowsAffected: 0 },
      // Consent is kept indefinitely (docs/03); no class purges it.
      { policyKey: "consent" },
      { policyKey: "notifications" }
    ]) {
      const res = await call(OFFICER, "POST", "/v1/compliance/retention/run", payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it("plans the schedule's other classes under their own floors (docs/30 Compliance 5)", async () => {
    for (const [policyKey, tableName] of [["files", "core_files"], ["ai_audit", "ai_audit_log"]] as const) {
      const res = await call(OFFICER, "POST", "/v1/compliance/retention/run", { policyKey });
      expect(res.status, policyKey).toBe(200);
      expect(res.body.tableName).toBe(tableName);
      expect(res.body.retentionMonths).toBeGreaterThanOrEqual(84);
    }
  });

  it("purges past the cutoff, honours a legal hold and stays inside the tenant", async () => {
    // The tenant ships its own retention history, so what the audit test can
    // assert is what this purge added — not how many purges have ever run.
    purgeAuditsBefore = (await auditRows("compliance.retention.run")).length;
    const res = await call(OFFICER, "POST", "/v1/compliance/retention/run", {
      policyKey: "messages",
      dryRun: false
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("done");
    expect(res.body.rowsAffected).toBe(1);
    expect(res.body.rowsHeld).toBe(1);
    purgeRunId = res.body.id as string;

    const left = await database.select().from(schema.orbitMessages);
    expect(left.some((m) => m.id === purgeableMessageId)).toBe(false);
    // A hold freezes deletion for its subject. It outlives the cutoff.
    expect(left.some((m) => m.id === heldMessageId)).toBe(true);
  });

  it("refuses the generated create for a run row", async () => {
    const res = await call(OFFICER, "POST", "/v1/compliance/retention-runs", {
      policyKey: "messages",
      tableName: "orbit_messages",
      cutoffAt: 0,
      rowsAffected: 9999,
      state: "done"
    });
    expect(res.status).toBe(400);
    const rows = await database
      .select()
      .from(schema.retentionRuns)
      .where(eq(schema.retentionRuns.rowsAffected, 9999));
    expect(rows.length).toBe(0);
  });

  it("is 403 without the run permission and 401 without a session", async () => {
    expect((await call(AGENT, "POST", "/v1/compliance/retention/run", { policyKey: "messages" })).status).toBe(403);
    expect((await call(null, "POST", "/v1/compliance/retention/run", { policyKey: "messages" })).status).toBe(401);
  });

  it("audits the plan and the purge, and lists the run", async () => {
    expect((await auditRows("compliance.retention.plan")).length).toBeGreaterThan(0);
    const purges = await auditRows("compliance.retention.run");
    expect(purges.length).toBe(purgeAuditsBefore + 1);
    const latest = purges.reduce((a, b) => (b.ts >= a.ts ? b : a));
    expect(latest.subjectRef).toBe("retention:messages");

    const list = await call(OFFICER, "GET", "/v1/compliance/retention-runs");
    expect(list.status).toBe(200);
    // The run this suite performed has to be readable back, alongside whatever
    // history the tenant already had.
    expect(list.body.data.some((r: { id: string }) => r.id === purgeRunId)).toBe(true);
  });

  it("left no compliance action unaudited", async () => {
    const rows = await database
      .select()
      .from(schema.auditLog)
      .where(and(like(schema.auditLog.action, "compliance.%"), eq(schema.auditLog.tenantId, foreign.tenantId)));
    expect(rows.length).toBe(0);
  });
});
