import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacHex, seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// The two hosted public pages ORBIT's spec asks for and nothing served until
// now: the one-tap renewal link (orbit.md §2.2, J-C3) and the CSAT tap
// (orbit.md §5, J-C2). Both are unauthenticated by design — the credential is
// the link's derived token — so the tests that matter here are the ones about
// what a link *cannot* reach: another tenant's row, another row of the same
// kind, or the internal churn/strategy fields on its own row.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PASSWORD = "Gonxt-Demo-2026!";
const FIELD_KEY = "test-field-key";
const exec = { waitUntil() {}, passThroughOnException() {} };

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let env: Env;
let database: Db;
let tenantId: string;
let rivalId: string;
let renewalsToken: string;
let outsiderToken: string;

const YEAR = 365 * 24 * 60 * 60 * 1000;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function login(local: string): Promise<string> {
  const first = await call("POST", "/v1/auth/login", {
    email: `${local}@gonxt.ae`,
    password: PASSWORD,
    tenantSlug: "gonxt"
  });
  expect(first.status).toBe(200);
  const token = first.body.token as string;
  const verified = await call(
    "POST",
    "/v1/auth/mfa/verify",
    { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
    { authorization: `Bearer ${token}` }
  );
  expect(verified.status).toBe(200);
  return token;
}

/** A problem+json body minus `instance`, which is the request's own URL and so
 *  always differs between two requests. Everything else must match exactly for
 *  the answers to be indistinguishable. */
function refusal(body: any): unknown {
  const { instance: _instance, ...rest } = body;
  return rest;
}

/** The same derivation the route uses, restated so a change to it fails here
 *  rather than silently invalidating every link already sent. */
function linkToken(kind: "renewal" | "feedback", tenant: string, rowId: string): Promise<string> {
  return hmacHex(FIELD_KEY, `portal-link.v1:${kind}:${tenant}:${rowId}`);
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    FIELD_KEY
  } as unknown as Env;

  const [tenant] = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, "gonxt"));
  tenantId = tenant!.id;
  const now = Date.now();

  // A second live tenant on the same database, so "cross-tenant" is a real
  // condition here and not a hypothetical.
  rivalId = "tn_rival";
  await database.insert(schema.tenants).values({
    id: rivalId,
    slug: "rival",
    name: "Rival Cover",
    plan: "standard",
    status: "active",
    brandJson: null,
    policyJson: null,
    entitlementsJson: null,
    createdAt: now,
    updatedAt: now
  });

  await database.insert(schema.orbitRenewals).values([
    {
      id: "rnw_open",
      tenantId,
      policyRef: "POL-OPEN",
      customerId: "cus_open",
      expiryAt: now + YEAR,
      churnScore: 87,
      strategy: "auto_requote",
      state: "offered",
      ownerRef: "user:us_owner",
      offeredAt: now,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "rnw_lost",
      tenantId,
      policyRef: "POL-LOST",
      customerId: "cus_lost",
      expiryAt: now + YEAR,
      state: "lost",
      outcomeReason: "price",
      decidedAt: now,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "rnw_expired",
      tenantId,
      policyRef: "POL-EXPIRED",
      customerId: "cus_expired",
      expiryAt: now - 1,
      state: "offered",
      createdAt: now,
      updatedAt: now
    },
    // Same shape, other tenant. Note the *id* differs from rnw_open's: the
    // isolation test mints tenant A's token and points it at tenant B's slug.
    {
      id: "rnw_rival",
      tenantId: rivalId,
      policyRef: "POL-RIVAL",
      customerId: "cus_rival",
      expiryAt: now + YEAR,
      state: "offered",
      createdAt: now,
      updatedAt: now
    }
  ]);

  await database.insert(schema.orbitConversations).values([
    {
      id: "cnv_closed",
      tenantId,
      customerId: "cus_open",
      channel: "whatsapp",
      state: "closed",
      assigneeRef: "user:us_agent",
      summary: "Customer asked about roadside cover and was satisfied.",
      lang: "en",
      closedAt: now,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "cnv_open",
      tenantId,
      channel: "web",
      state: "human",
      lang: "en",
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "cnv_rated",
      tenantId,
      channel: "web",
      state: "closed",
      csat: 4,
      lang: "en",
      closedAt: now,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "cnv_rival",
      tenantId: rivalId,
      channel: "web",
      state: "closed",
      lang: "en",
      closedAt: now,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    }
  ]);

  renewalsToken = await login("hind.saqr"); // orbit.admin — orbit:renewals:read
  outsiderToken = await login("layla.hassan"); // axis.agent — no orbit permission
}, 120_000);

describe("GET /v1/portal/:tenantSlug/renewals/:id", () => {
  it("opens the renewal with its link token, and shows only customer-facing fields", async () => {
    const token = await linkToken("renewal", tenantId, "rnw_open");
    const res = await call("GET", `/v1/portal/gonxt/renewals/rnw_open?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reference: "POL-OPEN",
      expiryAt: expect.any(Number),
      state: "offered",
      decidedAt: null
    });
    // Internal scoring and internal wording never cross to the public page.
    // Names and ids only, no bare figures: `expiryAt` is a millisecond stamp and
    // a two-digit score is a substring of one often enough to make this flaky.
    // The shape is pinned exactly above, so a leaked value has nowhere to sit.
    expect(JSON.stringify(res.body)).not.toMatch(/churnScore|strategy|auto_requote|ownerRef|us_owner|cus_open/);
  });

  it("is 404 without a token", async () => {
    const res = await call("GET", "/v1/portal/gonxt/renewals/rnw_open");
    expect(res.status).toBe(404);
  });

  it("answers a wrong token and an unknown id identically, so neither confirms the other exists", async () => {
    const wrong = await call("GET", "/v1/portal/gonxt/renewals/rnw_open?token=deadbeef");
    const unknown = await call(
      "GET",
      `/v1/portal/gonxt/renewals/rnw_nope?token=${await linkToken("renewal", tenantId, "rnw_nope")}`
    );
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(refusal(wrong.body)).toEqual(refusal(unknown.body));
  });

  it("refuses another tenant's renewal, indistinguishably from not-found", async () => {
    // A token minted by tenant A for its own row id, aimed at tenant B's slug.
    const forged = await call(
      "GET",
      `/v1/portal/rival/renewals/rnw_open?token=${await linkToken("renewal", tenantId, "rnw_open")}`
    );
    // And a valid tenant-B token replayed against tenant B's slug for a row
    // that belongs to A — the reverse direction of the same wall.
    const crossRow = await call(
      "GET",
      `/v1/portal/rival/renewals/rnw_open?token=${await linkToken("renewal", rivalId, "rnw_open")}`
    );
    const unknown = await call(
      "GET",
      `/v1/portal/rival/renewals/rnw_nope?token=${await linkToken("renewal", rivalId, "rnw_nope")}`
    );
    expect(forged.status).toBe(404);
    expect(crossRow.status).toBe(404);
    expect(refusal(forged.body)).toEqual(refusal(unknown.body));
    expect(refusal(crossRow.body)).toEqual(refusal(unknown.body));

    // The rival's own row is reachable only with the rival's own token — proof
    // the 404s above are the wall and not a broken route.
    const own = await call(
      "GET",
      `/v1/portal/rival/renewals/rnw_rival?token=${await linkToken("renewal", rivalId, "rnw_rival")}`
    );
    expect(own.status).toBe(200);
    expect(own.body.reference).toBe("POL-RIVAL");
  });

  it("does not let one row's token open a sibling row", async () => {
    const res = await call(
      "GET",
      `/v1/portal/gonxt/renewals/rnw_lost?token=${await linkToken("renewal", tenantId, "rnw_open")}`
    );
    expect(res.status).toBe(404);
  });

  it("does not let a feedback token open a renewal", async () => {
    const res = await call(
      "GET",
      `/v1/portal/gonxt/renewals/rnw_open?token=${await linkToken("feedback", tenantId, "rnw_open")}`
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/portal/:tenantSlug/renewals/:id/accept", () => {
  it("records the customer's decision, ends the campaign, and repeats without complaint", async () => {
    const token = await linkToken("renewal", tenantId, "rnw_open");
    const res = await call("POST", "/v1/portal/gonxt/renewals/rnw_open/accept", { token });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("accepted");
    expect(res.body.decidedAt).toEqual(expect.any(Number));

    const [row] = await database
      .select()
      .from(schema.orbitRenewals)
      .where(eq(schema.orbitRenewals.id, "rnw_open"));
    expect(row!.state).toBe("accepted");
    expect(row!.outcomeReason).toBe("customer_accepted");

    // A second tap on the same link (the normal case on a phone) is a no-op.
    const again = await call("POST", "/v1/portal/gonxt/renewals/rnw_open/accept", { token });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);

    const [entry] = await database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectRef, "rnw_open"));
    expect(entry!.action).toBe("orbit.renewal.accepted");
    expect(entry!.tenantId).toBe(tenantId);
  });

  it("is 409 on a renewal the desk already closed", async () => {
    const res = await call("POST", "/v1/portal/gonxt/renewals/rnw_lost/accept", {
      token: await linkToken("renewal", tenantId, "rnw_lost")
    });
    expect(res.status).toBe(409);
  });

  it("is 409 once the term has expired", async () => {
    const res = await call("POST", "/v1/portal/gonxt/renewals/rnw_expired/accept", {
      token: await linkToken("renewal", tenantId, "rnw_expired")
    });
    expect(res.status).toBe(409);
  });

  it("cannot accept another tenant's renewal", async () => {
    const res = await call("POST", "/v1/portal/rival/renewals/rnw_rival/accept", {
      token: await linkToken("renewal", tenantId, "rnw_rival")
    });
    expect(res.status).toBe(404);
    const [row] = await database
      .select()
      .from(schema.orbitRenewals)
      .where(eq(schema.orbitRenewals.id, "rnw_rival"));
    expect(row!.state).toBe("offered");
  });

  it("rejects a body with anything extra in it", async () => {
    const res = await call("POST", "/v1/portal/gonxt/renewals/rnw_expired/accept", {
      token: await linkToken("renewal", tenantId, "rnw_expired"),
      state: "accepted"
    });
    expect(res.status).toBe(400);
  });
});

describe("GET|POST /v1/portal/:tenantSlug/feedback/:id", () => {
  it("says whether a closed conversation can be rated, and reveals nothing else about it", async () => {
    const res = await call(
      "GET",
      `/v1/portal/gonxt/feedback/cnv_closed?token=${await linkToken("feedback", tenantId, "cnv_closed")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ratable: true, rating: null, scaleMax: 5, closedAt: expect.any(Number) });
    // No transcript, no AI summary, no assignee, no customer.
    expect(JSON.stringify(res.body)).not.toMatch(/roadside|summary|assignee|us_agent|cus_open/i);
  });

  it("takes one rating on the 1-5 scale the analytics screen averages", async () => {
    const token = await linkToken("feedback", tenantId, "cnv_closed");
    const res = await call("POST", "/v1/portal/gonxt/feedback/cnv_closed", { token, rating: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ratable: false, rating: 5, scaleMax: 5, closedAt: expect.any(Number) });

    const [row] = await database
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.id, "cnv_closed"));
    expect(row!.csat).toBe(5);

    // A second rating would let one link move the KPI.
    const again = await call("POST", "/v1/portal/gonxt/feedback/cnv_closed", { token, rating: 1 });
    expect(again.status).toBe(409);
  });

  it("refuses to rate a conversation that is still open", async () => {
    const res = await call("POST", "/v1/portal/gonxt/feedback/cnv_open", {
      token: await linkToken("feedback", tenantId, "cnv_open"),
      rating: 5
    });
    expect(res.status).toBe(409);
  });

  it("refuses a rating off the scale", async () => {
    const token = await linkToken("feedback", tenantId, "cnv_rated");
    for (const rating of [0, 6, 2.5]) {
      const res = await call("POST", "/v1/portal/gonxt/feedback/cnv_rated", { token, rating });
      expect(res.status, String(rating)).toBe(400);
    }
  });

  it("refuses another tenant's conversation, indistinguishably from not-found", async () => {
    const forged = await call(
      "GET",
      `/v1/portal/rival/feedback/cnv_closed?token=${await linkToken("feedback", tenantId, "cnv_closed")}`
    );
    const unknown = await call(
      "GET",
      `/v1/portal/rival/feedback/cnv_nope?token=${await linkToken("feedback", rivalId, "cnv_nope")}`
    );
    expect(forged.status).toBe(404);
    expect(refusal(forged.body)).toEqual(refusal(unknown.body));

    const write = await call("POST", "/v1/portal/rival/feedback/cnv_rival", {
      token: await linkToken("feedback", tenantId, "cnv_rival"),
      rating: 1
    });
    expect(write.status).toBe(404);
    const [row] = await database
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.id, "cnv_rival"));
    expect(row!.csat).toBeNull();
  });
});

describe("GET /v1/orbit/portal-links/:kind/:id", () => {
  it("hands staff a sendable link that the public route then accepts", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/renewal/rnw_lost", undefined, {
      authorization: `Bearer ${renewalsToken}`
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`^http://localhost:5173/portal/gonxt/renewals/rnw_lost\\?token=[0-9a-f]{64}$`));

    const opened = await call("GET", res.body.url.replace("http://localhost:5173/portal/", "/v1/portal/"));
    expect(opened.status).toBe(200);
    expect(opened.body.reference).toBe("POL-LOST");
  });

  it("mints a feedback link for a conversation", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/feedback/cnv_rated", undefined, {
      authorization: `Bearer ${renewalsToken}`
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("/portal/gonxt/feedback/cnv_rated?token=");
  });

  it("is 403 for a caller who may not read the row it points at", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/renewal/rnw_lost", undefined, {
      authorization: `Bearer ${outsiderToken}`
    });
    expect(res.status).toBe(403);
  });

  it("is 401 with no session at all — the link is not itself public", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/renewal/rnw_lost");
    expect(res.status).toBe(401);
  });

  it("404s a row that does not exist, so it cannot be used to probe ids", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/renewal/rnw_nope", undefined, {
      authorization: `Bearer ${renewalsToken}`
    });
    expect(res.status).toBe(404);
  });

  it("400s an unknown link kind", async () => {
    const res = await call("GET", "/v1/orbit/portal-links/invoice/rnw_lost", undefined, {
      authorization: `Bearer ${renewalsToken}`
    });
    expect(res.status).toBe(400);
  });
});
