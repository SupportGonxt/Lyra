import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { notFound, type Ctx } from "@lyra/core";
import { onError } from "../mw.js";
// Side-effect: REGISTRY is what turns a ref into a resource (see names.test.ts).
import "../resources.js";
import { noteRoutes } from "./notes.js";
import type { App } from "../env.js";

// ADR-0085. Every route here answers two questions before it answers the one
// asked: may this caller read notes at all, and may they read the record the
// note is about? A note is a read of its record, so a caller who could not
// open the customer must not learn what was written about them.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

let db: Ctx["db"];
const NOW = Date.UTC(2026, 8, 1, 9);
const ALL = ["*:*:*"];
const NOTES_AND_CUSTOMERS = ["core:notes:read", "core:notes:write", "core:customers:read"];

function ctxFor(grants: string[], tenantId = "t_test"): Ctx {
  return {
    db,
    tenantId,
    actor: { kind: "user", id: "us_me", tenantId, grants: [{ roleKey: "test", permissions: grants }] },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

function router(ctx: Ctx): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/", noteRoutes);
  return app;
}

async function call(grants: string[], method: string, path: string, body?: unknown, tenantId?: string) {
  const res = await router(ctxFor(grants, tenantId)).fetch(
    new Request(`http://api.test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
    })
  );
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, res, body: type.includes("json") ? ((await res.json()) as Record<string, any>) : null };
}

function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const nameLen = view.getUint16(offset + 26, true);
    const dataLen = view.getUint32(offset + 22, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen;
    out.set(name, new TextDecoder().decode(bytes.subarray(start, start + dataLen)));
    offset = start + dataLen;
  }
  return out;
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  db = drizzle(client) as unknown as Ctx["db"];
  const customer = (id: string, name: string, tenantId = "t_test") => ({
    id,
    tenantId,
    nameJson: JSON.stringify({ en: name, ar: name }),
    createdAt: NOW,
    updatedAt: NOW
  });
  await db.insert(schema.customers).values([
    customer("cu_1", "Falcon Freight"),
    customer("cu_2", "Oasis Dairy"),
    customer("cu_other", "Elsewhere Ltd", "t_other")
  ]);
  await db.insert(schema.axisPolicies).values({
    id: "pol_1",
    tenantId: "t_test",
    customerId: "cu_1",
    providerId: "prv_1",
    policyNo: "MTR-0001",
    startAt: NOW,
    endAt: NOW + 1,
    premiumMinor: 100,
    currency: "AED",
    createdAt: NOW,
    updatedAt: NOW
  } as never);
});

describe("GET/PUT /notes", () => {
  it("saves and reads one note per record, whatever spelling of the ref is used", async () => {
    const put = await call(NOTES_AND_CUSTOMERS, "PUT", "/notes?subject=cu_1", {
      bodyMd: "Fleet renewal due. See [[cu_2|Oasis]].",
      version: 0
    });
    expect(put.status).toBe(200);
    expect(put.body!.subject).toBe("customer:cu_1");
    expect(put.body!.note.version).toBe(1);

    const got = await call(NOTES_AND_CUSTOMERS, "GET", "/notes?subject=customer:cu_1");
    expect(got.status).toBe(200);
    expect(got.body!.note.bodyMd).toBe("Fleet renewal due. See [[cu_2|Oasis]].");
    expect(got.body!.note.authorRef).toBe("user:us_me");
  });

  it("answers an unwritten note as null, not 404", async () => {
    const got = await call(NOTES_AND_CUSTOMERS, "GET", "/notes?subject=cu_1");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ subject: "customer:cu_1", note: null });
  });

  it("refuses a stale version with 409", async () => {
    await call(NOTES_AND_CUSTOMERS, "PUT", "/notes?subject=cu_1", { bodyMd: "one", version: 0 });
    const stale = await call(NOTES_AND_CUSTOMERS, "PUT", "/notes?subject=cu_1", { bodyMd: "two", version: 0 });
    expect(stale.status).toBe(409);
  });

  it("needs the notes permission and the record's own read", async () => {
    expect((await call(["core:customers:read"], "GET", "/notes?subject=cu_1")).status).toBe(403);
    expect((await call(["core:notes:read", "core:notes:write"], "GET", "/notes?subject=cu_1")).status).toBe(403);
    expect(
      (await call(["core:notes:read", "core:customers:read"], "PUT", "/notes?subject=cu_1", { bodyMd: "x", version: 0 }))
        .status
    ).toBe(403);
  });

  it("is 404 for another tenant's record and 400 for a ref that names no resource", async () => {
    expect((await call(ALL, "GET", "/notes?subject=cu_other")).status).toBe(404);
    expect((await call(ALL, "GET", "/notes?subject=zz_1")).status).toBe(400);
    expect((await call(ALL, "GET", "/notes")).status).toBe(400);
  });

  it("refuses a body with fields the server owns", async () => {
    const res = await call(ALL, "PUT", "/notes?subject=cu_1", { bodyMd: "x", version: 0, authorRef: "user:us_else" });
    expect(res.status).toBe(400);
  });
});

describe("GET /links (backlinks)", () => {
  beforeEach(async () => {
    await call(ALL, "PUT", "/notes?subject=pol_1", { bodyMd: "Held by [[cu_1|Falcon]]", version: 0 });
    await call(ALL, "PUT", "/notes?subject=cu_2", { bodyMd: "Referred by [[customer:cu_1]]", version: 0 });
  });

  it("lists the notes linking here, with names and where each record opens", async () => {
    const res = await call(ALL, "GET", "/links?to=cu_1");
    expect(res.status).toBe(200);
    expect(res.body!.to).toBe("customer:cu_1");
    const refs = res.body!.links.map((l: { fromRef: string }) => l.fromRef).sort();
    expect(refs).toEqual(["customer:cu_2", "policy:pol_1"]);
    const policy = res.body!.links.find((l: { fromRef: string }) => l.fromRef === "policy:pol_1");
    expect(policy).toMatchObject({ module: "axis", resource: "policies", id: "pol_1" });
    expect(res.body!.names["policy:pol_1"]).toBe("MTR-0001");
    expect(res.body!.names["customer:cu_2"]).toBe("Oasis Dairy");
  });

  it("hides a linking record the reader may not open", async () => {
    const res = await call(NOTES_AND_CUSTOMERS, "GET", "/links?to=cu_1");
    expect(res.body!.links.map((l: { fromRef: string }) => l.fromRef)).toEqual(["customer:cu_2"]);
  });
});

describe("GET /graph", () => {
  it("returns nodes with names and depth, edges, and refuses a depth past 2", async () => {
    await call(ALL, "PUT", "/notes?subject=pol_1", { bodyMd: "[[cu_1]]", version: 0 });
    await call(ALL, "PUT", "/notes?subject=cu_1", { bodyMd: "[[cu_2]]", version: 0 });
    const res = await call(ALL, "GET", "/graph?subject=cu_2&depth=2");
    expect(res.status).toBe(200);
    const byRef = Object.fromEntries(res.body!.nodes.map((n: { ref: string; depth: number }) => [n.ref, n.depth]));
    expect(byRef).toEqual({ "customer:cu_2": 0, "customer:cu_1": 1, "policy:pol_1": 2 });
    expect(res.body!.edges).toContainEqual({ from: "customer:cu_1", to: "customer:cu_2" });
    expect(res.body!.names["customer:cu_1"]).toBe("Falcon Freight");
    expect((await call(ALL, "GET", "/graph?subject=cu_2&depth=3")).status).toBe(400);
  });

  it("drops nodes the reader may not open", async () => {
    await call(ALL, "PUT", "/notes?subject=pol_1", { bodyMd: "[[cu_1]]", version: 0 });
    const res = await call(NOTES_AND_CUSTOMERS, "GET", "/graph?subject=cu_1&depth=1");
    expect(res.body!.nodes.map((n: { ref: string }) => n.ref)).toEqual(["customer:cu_1"]);
    expect(res.body!.edges).toEqual([]);
  });
});

describe("GET /notes/export", () => {
  it("zips an Obsidian vault of the notes the reader may open, and audits the export", async () => {
    await call(ALL, "PUT", "/notes?subject=cu_1", { bodyMd: "Owns [[pol_1|motor]]", version: 0 });
    await call(ALL, "PUT", "/notes?subject=pol_1", { bodyMd: "Held by [[cu_1]]", version: 0 });

    const res = await call(ALL, "GET", "/notes/export");
    expect(res.status).toBe(200);
    expect(res.res.headers.get("content-type")).toBe("application/zip");
    expect(res.res.headers.get("content-disposition")).toMatch(/attachment; filename="notes-vault-\d{4}-\d{2}-\d{2}\.zip"/);
    const files = unzip(new Uint8Array(await res.res.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual(["Customer/Falcon Freight.md", "Policy/MTR-0001.md"]);
    expect(files.get("Customer/Falcon Freight.md")).toContain("Owns [[Policy/MTR-0001|motor]]");
    expect(files.get("Customer/Falcon Freight.md")).toMatch(/^---\nref: "customer:cu_1"\ntype: "Customer"\n/);

    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toContain("core.note.exported");

    const narrow = await call(NOTES_AND_CUSTOMERS, "GET", "/notes/export");
    const only = unzip(new Uint8Array(await narrow.res.arrayBuffer()));
    // No policy read, so no policy note; no core:pii:view, so the file is named
    // by the masked name the list screens show this reader, not the real one.
    expect([...only.keys()]).toEqual(["Customer/Falcon F••••••.md"]);
  });

  it("needs the notes read permission", async () => {
    expect((await call(["core:customers:read"], "GET", "/notes/export")).status).toBe(403);
  });
});
