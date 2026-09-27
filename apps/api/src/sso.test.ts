import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64url, seed } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";
import { samlFixture } from "./saml-fixture.js";

// docs/06 §2. The whole point of this file is that nothing signs a user in
// unless the signature, issuer, audience, expiry, nonce and single-use state all
// hold. Each of those is asserted by breaking it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const ISSUER = "https://idp.test";
const CLIENT_ID = "lyra-test-client";
const KID = "test-key-1";

const exec = { waitUntil() {}, passThroughOnException() {} };

/** Enough of KVNamespace for the two things sso.ts does with it. */
class FakeKv {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

let env: Env;
let kv: FakeKv;
let database: Db;
let signingKey: CryptoKey;
let publicJwk: JsonWebKey;
let tenantId: string;
let providerId = "";
/** What the fake token endpoint hands back on the next exchange. */
let nextIdToken = "";
const realFetch = globalThis.fetch;

function jwt(header: object, claims: object, signature: Uint8Array): string {
  const enc = new TextEncoder();
  const part = (o: object) => base64url(enc.encode(JSON.stringify(o)));
  return `${part(header)}.${part(claims)}.${base64url(signature)}`;
}

async function mintIdToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {}
): Promise<string> {
  const enc = new TextEncoder();
  const full = {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims
  };
  const head = { alg: "RS256", kid: KID, typ: "JWT", ...header };
  const part = (o: object) => base64url(enc.encode(JSON.stringify(o)));
  const signed = enc.encode(`${part(head)}.${part(full)}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, signed)
  );
  return jwt(head, full, signature);
}

/** The identity provider, in about as much detail as a real one behaves. */
function fakeIdp(input: RequestInfo | URL): Response | undefined {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`
    });
  }
  if (url === `${ISSUER}/jwks`) return Response.json({ keys: [{ ...publicJwk, kid: KID }] });
  if (url === `${ISSUER}/token`) {
    return nextIdToken
      ? Response.json({ id_token: nextIdToken, token_type: "Bearer" })
      : new Response("invalid_grant", { status: 400 });
  }
  return undefined;
}

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://api.test${path}`), env as never, exec as never);
}

/** Walk `start`, read the nonce the API stored, and come back with a token for it. */
async function signIn(
  claims: Record<string, unknown>,
  options: { nonce?: string; header?: Record<string, unknown> } = {}
): Promise<Response> {
  const started = await get(`/v1/auth/sso/${providerId}/start?next=/axis`);
  const location = new URL(started.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const pending = JSON.parse(kv.store.get(`sso:state:${state}`) ?? "{}") as { nonce: string };
  nextIdToken = await mintIdToken(
    { nonce: options.nonce ?? pending.nonce, ...claims },
    options.header ?? {}
  );
  return get(`/v1/auth/sso/${providerId}/callback?code=abc&state=${state}`);
}

/** The problem+json `detail` a refusal explains itself with. */
async function detailOf(response: Response): Promise<string> {
  return ((await response.json()) as { detail?: string }).detail ?? "";
}

/** The session cookie a callback set, ready for an Authorization-free follow-up. */
function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  const seeded = await seed(database as never);
  tenantId = seeded.tenantId;

  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;

  const now = Date.now();
  providerId = "idp_test";
  // The seed ships GONXT's real staff IdP, and an email domain routes to exactly
  // one provider. Swap it for the fake issuer this suite can mint tokens against
  // rather than adding a second claimant to the same domain.
  await database
    .delete(schema.identityProviders)
    .where(eq(schema.identityProviders.emailDomain, "gonxt.ae"));
  await database.insert(schema.identityProviders).values({
    id: providerId,
    tenantId,
    kind: "oidc",
    name: "Test IdP",
    emailDomain: "gonxt.ae",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecretRef: "SSO_TEST_SECRET",
    discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
    authorizeUrl: null,
    tokenUrl: null,
    jwksUrl: null,
    ssoUrl: null,
    certificate: null,
    defaultRoleKey: "customer",
    enabled: true,
    // The IdP performed the second factor, so this session is born satisfied.
    mfaAsserted: true,
    createdAt: now,
    updatedAt: now
  });
  await database.insert(schema.identityProviders).values({
    id: "idp_saml",
    tenantId,
    kind: "saml",
    name: "Legacy SAML",
    emailDomain: "saml.example",
    issuer: "https://saml.example",
    enabled: true,
    createdAt: now,
    updatedAt: now
  });

  kv = new FakeKv();
  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    KV: kv as unknown as KVNamespace,
    SSO_TEST_SECRET: "shh"
  } as unknown as Env;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const canned = fakeIdp(input);
    return canned ? Promise.resolve(canned) : realFetch(input as never, init as never);
  }) as typeof fetch;
}, 60_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("sso discovery", () => {
  it("names the provider that owns a domain and nothing for one it does not", async () => {
    const found = await (await get("/v1/auth/sso/discover?email=Amina.Saleh@GONXT.ae")).json();
    expect(found).toMatchObject({ id: providerId, kind: "oidc", startUrl: `/v1/auth/sso/${providerId}/start` });

    const none = await (await get("/v1/auth/sso/discover?email=someone@elsewhere.test")).json();
    expect(none).toEqual({});
  });
});

describe("sso start", () => {
  it("redirects with PKCE and stores single-use state", async () => {
    const res = await get(`/v1/auth/sso/${providerId}/start?next=/axis/cases`);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `http://api.test/v1/auth/sso/${providerId}/callback`
    );

    const state = url.searchParams.get("state") ?? "";
    const pending = JSON.parse(kv.store.get(`sso:state:${state}`) ?? "{}");
    expect(pending.nonce).toBeTruthy();
    // The verifier never leaves the server; only its digest went to the IdP.
    expect(url.toString()).not.toContain(pending.verifier);
    expect(pending.next).toBe("/axis/cases");
  });

  it("refuses an off-site next", async () => {
    const res = await get(`/v1/auth/sso/${providerId}/start?next=//evil.test/`);
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(JSON.parse(kv.store.get(`sso:state:${state}`) ?? "{}").next).toBe("/");
  });

  it("refuses a SAML provider that has no SSO URL or signing certificate yet, saying which", async () => {
    const res = await get("/v1/auth/sso/idp_saml/start");
    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/ssoUrl|certificate/);
  });
});

describe("sso callback", () => {
  it("links an existing account by email and issues a session", async () => {
    const res = await signIn({ sub: "idp-sub-amina", email: "amina.saleh@gonxt.ae", name: "Amina" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173/axis");

    const rows = await database
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "amina.saleh@gonxt.ae"));
    expect(rows[0]?.externalId).toBe("idp-sub-amina");
    expect(rows[0]?.authProvider).toBe("oidc");

    // mfaAsserted: the session works straight away, with no TOTP hop, even though
    // this is a staff role that would otherwise be sent to enrol.
    const me = await app.fetch(
      new Request("http://api.test/v1/me", { headers: { cookie: cookieOf(res) } }),
      env as never,
      exec as never
    );
    expect(me.status).toBe(200);
  });

  it("provisions an unknown account against the provider's default role", async () => {
    const res = await signIn({ sub: "idp-sub-new", email: "new.person@gonxt.ae", name: "New Person" });
    expect(res.status).toBe(302);

    const rows = await database
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "new.person@gonxt.ae"));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.passwordHash).toBeNull();

    const assigned = await database
      .select({ key: schema.roles.key })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, rows[0]!.id));
    expect(assigned.map((a) => a.key)).toEqual(["customer"]);
  });

  it("refuses an email outside the provider's domain", async () => {
    const res = await signIn({ sub: "idp-sub-outside", email: "someone@elsewhere.test" });
    expect(res.status).toBe(403);
  });

  it("refuses a replayed state", async () => {
    const started = await get(`/v1/auth/sso/${providerId}/start`);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const pending = JSON.parse(kv.store.get(`sso:state:${state}`) ?? "{}") as { nonce: string };
    nextIdToken = await mintIdToken({ sub: "idp-sub-amina", email: "amina.saleh@gonxt.ae", nonce: pending.nonce });

    const first = await get(`/v1/auth/sso/${providerId}/callback?code=abc&state=${state}`);
    expect(first.status).toBe(302);
    const replay = await get(`/v1/auth/sso/${providerId}/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(401);
  });

  it("refuses a token whose nonce belongs to another sign-in", async () => {
    const res = await signIn({ sub: "idp-sub-amina", email: "amina.saleh@gonxt.ae" }, { nonce: "not-the-one" });
    expect(res.status).toBe(401);
    expect(await detailOf(res)).toContain("nonce");
  });

  it("refuses an unsigned token", async () => {
    const enc = new TextEncoder();
    const part = (o: object) => base64url(enc.encode(JSON.stringify(o)));
    const started = await get(`/v1/auth/sso/${providerId}/start`);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const pending = JSON.parse(kv.store.get(`sso:state:${state}`) ?? "{}") as { nonce: string };
    nextIdToken = `${part({ alg: "none", typ: "JWT" })}.${part({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "idp-sub-amina",
      email: "amina.saleh@gonxt.ae",
      nonce: pending.nonce,
      exp: Math.floor(Date.now() / 1000) + 300
    })}.`;

    const res = await get(`/v1/auth/sso/${providerId}/callback?code=abc&state=${state}`);
    expect(res.status).toBe(401);
    expect(await detailOf(res)).toContain("RS256");
  });

  it("refuses a token signed by a key the provider does not publish", async () => {
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const honest = signingKey;
    signingKey = other.privateKey;
    const res = await signIn({ sub: "idp-sub-amina", email: "amina.saleh@gonxt.ae" });
    signingKey = honest;
    expect(res.status).toBe(401);
    expect(await detailOf(res)).toContain("signature");
  });

  it("refuses an expired token and a token issued for someone else", async () => {
    const expired = await signIn({
      sub: "idp-sub-amina",
      email: "amina.saleh@gonxt.ae",
      exp: Math.floor(Date.now() / 1000) - 10
    });
    expect(expired.status).toBe(401);

    const wrongAudience = await signIn({
      sub: "idp-sub-amina",
      email: "amina.saleh@gonxt.ae",
      aud: "someone-elses-client"
    });
    expect(wrongAudience.status).toBe(401);

    const wrongIssuer = await signIn({
      sub: "idp-sub-amina",
      email: "amina.saleh@gonxt.ae",
      iss: "https://attacker.test"
    });
    expect(wrongIssuer.status).toBe(401);
  });

  it("refuses to JIT-provision past the tenant's seat limit", async () => {
    const [count] = await database
      .select({ n: sql<number>`count(*)` })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), isNull(schema.users.deletedAt)));
    const n = count?.n ?? 0;
    const [before] = await database
      .select({ entitlementsJson: schema.tenants.entitlementsJson })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    // Full at exactly the live headcount — the next unknown claimant has nowhere to go.
    await database
      .update(schema.tenants)
      .set({ entitlementsJson: JSON.stringify({ seats: n }) })
      .where(eq(schema.tenants.id, tenantId));
    try {
      const res = await signIn({ sub: "idp-sub-over", email: "over.seat@gonxt.ae", name: "Over Seat" });
      expect(res.status).toBe(403);
      expect(await detailOf(res)).toContain("seat limit");
      const rows = await database.select().from(schema.users).where(eq(schema.users.email, "over.seat@gonxt.ae"));
      expect(rows).toHaveLength(0);
    } finally {
      await database
        .update(schema.tenants)
        .set({ entitlementsJson: before?.entitlementsJson ?? null })
        .where(eq(schema.tenants.id, tenantId));
    }
  });
});

/* ------------------------------------------------------------------ SAML */

// ADR-0097: SAML over the same session, linking and provisioning rules as
// OIDC. The attack vectors live in engines/saml.test.ts; this walks the routes:
// a request out, a signed answer back once, and a replay refused.
describe("sso SAML", () => {
  const SAML_ID = "idp_saml2";
  const idpKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const acsUrl = `http://api.test/v1/auth/sso/${SAML_ID}/acs`;
  const spEntityId = `http://api.test/v1/auth/sso/${SAML_ID}/metadata`;

  beforeAll(async () => {
    const now = Date.now();
    await database.insert(schema.identityProviders).values({
      id: SAML_ID,
      tenantId,
      kind: "saml",
      name: "Entra (SAML)",
      emailDomain: "saml2.example",
      issuer: "https://sts.saml2.example/",
      ssoUrl: "https://login.saml2.example/saml2",
      certificate: idpKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      defaultRoleKey: "customer",
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
  });

  async function start(): Promise<{ relayState: string; requestId: string }> {
    const res = await get(`/v1/auth/sso/${SAML_ID}/start?next=/orbit`);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://login.saml2.example/saml2");
    expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
    const relayState = url.searchParams.get("RelayState") ?? "";
    const pending = JSON.parse(kv.store.get(`sso:state:${relayState}`) ?? "{}") as { requestId: string; next: string };
    expect(pending.next).toBe("/orbit");
    return { relayState, requestId: pending.requestId };
  }

  const post = (relayState: string, samlResponse: string) =>
    app.fetch(
      new Request(`http://api.test/v1/auth/sso/${SAML_ID}/acs`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState })
      }),
      env as never,
      exec as never
    );

  const answer = (requestId: string) =>
    samlFixture({
      idpIssuer: "https://sts.saml2.example/",
      spEntityId,
      acsUrl,
      requestId,
      now: Date.now(),
      privateKey: idpKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    });

  it("publishes SP metadata naming the ACS and asking for signed assertions", async () => {
    const res = await get(`/v1/auth/sso/${SAML_ID}/metadata`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`entityID="${spEntityId}"`);
    expect(xml).toContain(`Location="${acsUrl}"`);
    expect(xml).toContain('WantAssertionsSigned="true"');
  });

  it("signs a person in from a signed answer to its own request, once", async () => {
    const { relayState, requestId } = await start();
    const fx = answer(requestId);
    const body = fx.b64(fx.signedResponse({ nameId: "ops@saml2.example", attributes: { email: "ops@saml2.example", displayName: "Ops Person" } }));
    const res = await post(relayState, body);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173/orbit");
    expect(cookieOf(res)).toContain("=");
    const [user] = await database.select().from(schema.users).where(eq(schema.users.email, "ops@saml2.example"));
    expect(user).toMatchObject({ externalId: "ops@saml2.example", authProvider: "saml", name: "Ops Person" });

    // The same answer again: the request it answered is spent.
    const replay = await post(relayState, body);
    expect(replay.status).toBe(401);
  });

  it("refuses an answer to a different request than the one this RelayState started", async () => {
    const { relayState } = await start();
    const fx = answer("_not_this_request");
    const res = await post(relayState, fx.b64(fx.signedResponse()));
    expect(res.status).toBe(401);
    expect(await detailOf(res)).toMatch(/InResponseTo/);
  });
});
