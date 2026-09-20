import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/16 H8 "Shariah-board workflow (review lane like compliance pre-flight)",
// docs/27 F45. Two things are pinned: the lane works end to end, and it is the
// *only* way into the ruling — an approval policy that a second, ungated door
// bypasses is a declared gate nothing passes through, which is the defect this
// repo keeps finding.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

let env: Env;
let database: Db;
let seeded: SeedResult;
/** tenant.compliance — the board's seat, holding `compliance:*:*`. */
let token: string;
/** tenant.admin — holds `core:products:write`, which is the door being closed. */
let adminToken: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  as: "compliance" | "admin" = "compliance"
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${as === "admin" ? adminToken : token}`
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : await res.arrayBuffer()) as T };
}

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** The seeded takaful product — the only one, which is itself the point. */
async function takafulProductId(): Promise<string> {
  const rows = await database
    .select({ id: schema.products.id, structure: schema.products.structure })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, seeded.tenantId), eq(schema.products.structure, "takaful")));
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!.id;
}

async function conventionalProductId(): Promise<string> {
  const rows = await database
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, seeded.tenantId), eq(schema.products.structure, "conventional")));
  return rows[0]!.id;
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
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  const signIn = async (email: string): Promise<string> => {
    const login = await app.fetch(
      new Request("http://api.test/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD, tenantSlug: "gonxt" })
      }),
      env as never,
      exec as never
    );
    const issued = ((await login.json()) as { token: string }).token;
    const verified = await app.fetch(
      new Request("http://api.test/v1/auth/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued}` },
        body: JSON.stringify({
          code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
        })
      }),
      env as never,
      exec as never
    );
    expect(verified.status).toBe(200);
    return issued;
  };

  // Two seats, because the point of the CRUD guard is that they are different
  // people: the board certifies, operations edits the product, and neither may
  // do the other's job.
  token = await signIn("khalid.rashed@gonxt.ae");
  adminToken = await signIn("amina.saleh@gonxt.ae");
}, 120_000);

describe("the seeded takaful product carries real terms", () => {
  it("is certified, with a wakala fee and a surplus rule an engine can post from", async () => {
    // Before F45 the column held `structure: "takaful"` and nothing else, so
    // the one takaful product in the demo could not be sold as takaful by its
    // own rules — the horizon seam was declared and empty.
    const out = ok(await call("GET", `/v1/compliance/shariah/${await takafulProductId()}`));
    expect(out.model).toBe("wakala");
    expect(out.wakalaFeeBps).toBeGreaterThan(0);
    expect(out.participantShareBps).toBe(10_000);
    expect(out.shariah.state).toBe("certified");
    expect(out.shariah.fatwaRef).toBeTruthy();
    expect(out.current).toBe(true);
  });

  it("refuses a Shariah reading of a product that is not takaful", async () => {
    const res = await call("GET", `/v1/compliance/shariah/${await conventionalProductId()}`);
    expect(res.status).toBe(400);
  });

  it("is 404 for a product this tenant does not have", async () => {
    expect((await call("GET", "/v1/compliance/shariah/prd_nope")).status).toBe(404);
  });
});

describe("the review lane", () => {
  it("resubmitting drops the standing ruling rather than keeping it beside new terms", async () => {
    const productId = await takafulProductId();
    const out = ok(
      await call("POST", "/v1/compliance/shariah/submit", {
        productId,
        model: "mudaraba",
        participantShareBps: 7_000
      })
    );
    // A board certified the terms it was shown. A certificate that survives an
    // edit to the surplus rule is a certificate for a different product.
    expect(out.shariah.state).toBe("submitted");
    expect(out.shariah.fatwaRef).toBeUndefined();

    const after = ok(await call("GET", `/v1/compliance/shariah/${productId}`));
    expect(after.model).toBe("mudaraba");
    expect(after.participantShareBps).toBe(7_000);
    expect(after.current).toBe(false);
  });

  it("holds the certification for an approval instead of granting it", async () => {
    const productId = await takafulProductId();
    const res = await call("POST", "/v1/compliance/shariah/certify", {
      productId,
      boardRef: "board:gonxt-shariah-supervisory",
      fatwaRef: "FTW-2026-020"
    });
    // 403 `approval_required` (packages/core/src/errors.ts), not a refusal of
    // the actor: `compliance.shariah_certify` is dualControl "always" and
    // neverAutoApprove, so a board is by definition more than one person, one
    // signature is not a ruling, and no tenant setting may make it one.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("compliance.shariah_certify");

    const still = ok(await call("GET", `/v1/compliance/shariah/${productId}`));
    expect(still.shariah.state).toBe("submitted");
    expect(still.current).toBe(false);

    const pending = await database
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.tenantId, seeded.tenantId),
          eq(schema.approvals.policyKey, "compliance.shariah_certify")
        )
      );
    expect(pending.length).toBe(1);
    expect(pending[0]?.subjectRef).toBe(`product:${productId}`);
  });
});

describe("the generic product CRUD is not a second door into the ruling", () => {
  it("refuses a takafulJson carrying a Shariah block", async () => {
    const productId = await takafulProductId();
    const res = await call(
      "PATCH",
      `/v1/core/products/${productId}`,
      {
        takafulJson: JSON.stringify({
          model: "wakala",
          shariah: { state: "certified", boardRef: "board:me", fatwaRef: "SELF-1" }
        })
      },
      "admin"
    );
    // `core:products:write` is an operations permission. Without this guard it
    // would also be the authority to certify a product as Shariah-compliant,
    // and SURPLUS-DIST's precondition would wave the result straight through.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/shariah\/submit/);

    const unchanged = ok(await call("GET", `/v1/compliance/shariah/${productId}`));
    expect(unchanged.shariah.fatwaRef).toBeUndefined();
  });

  it("still allows the terms themselves to be edited", async () => {
    const productId = await takafulProductId();
    const res = await call(
      "PATCH",
      `/v1/core/products/${productId}`,
      { takafulJson: JSON.stringify({ model: "wakala", wakalaFeeBps: 2_500 }) },
      "admin"
    );
    expect(res.status).toBe(200);
    const out = ok(await call("GET", `/v1/compliance/shariah/${productId}`));
    expect(out.wakalaFeeBps).toBe(2_500);
    // And the ruling is gone with the terms it certified, not silently kept.
    expect(out.current).toBe(false);
  });
});
