import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { id as newId, schema, PolicyJson } from "@lyra/db";
import {
  assertSeatAvailable,
  badRequest,
  base64urlDecode,
  forbidden,
  notFound,
  randomToken,
  unauthorized,
  type Ctx
} from "@lyra/core";
import { db, issueSession, tenantConfig } from "../auth.js";
import type { App, Env } from "../env.js";
import { authnRequestUrl, spMetadata, verifySamlResponse } from "../engines/saml.js";

// docs/06 §2 — enterprise sign-in. OIDC authorization code + PKCE, id_token
// verified against the provider's JWKS. Nothing here trusts a claim it did not
// verify: the signature, the issuer, the audience, the expiry and the nonce all
// have to line up before a session exists.
//
// SAML 2.0 (ADR-0097, lifting ADR-0001's seam): the HTTP-Redirect AuthnRequest
// out, the HTTP-POST Response back to /acs, verified in engines/saml.ts, then
// the same linking, provisioning and session as OIDC.

export const ssoRoutes = new Hono<App>();

/** State lives ten minutes. Long enough for a slow IdP login, short enough to matter. */
const STATE_TTL_SEC = 600;
/** Discovery and JWKS documents change rarely; a stale key would fail closed anyway. */
const DOC_TTL_SEC = 3600;

type Provider = typeof schema.identityProviders.$inferSelect;

interface Pending {
  providerId: string;
  next: string;
  /** OIDC */
  nonce?: string;
  verifier?: string;
  /** SAML: the AuthnRequest ID the Response must answer. */
  requestId?: string;
}

function kv(env: Env): KVNamespace {
  // No CACHE means no way to hold state across the round trip to the IdP, and
  // holding it in a cookie would put the nonce where script can read it.
  const cache = env.CACHE ?? env.KV;
  if (!cache) throw badRequest("sso is not available on this deployment");
  return cache;
}

/** Only ever come back to a path on the app origin. */
function safeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/** Provider-supplied URLs are admin config, but they are still fetched server-side. */
function httpsOnly(url: string | null | undefined, what: string): string {
  if (!url || !url.startsWith("https://")) throw badRequest(`${what} must be an https URL`);
  return url;
}

async function providerById(env: Env, id: string): Promise<Provider> {
  const rows = await db(env)
    .select()
    .from(schema.identityProviders)
    .where(eq(schema.identityProviders.id, id))
    .limit(1);
  const provider = rows[0];
  if (!provider || !provider.enabled) throw notFound(`identity provider ${id}`);
  return provider;
}

/** Cached GET of a JSON document the provider publishes. */
async function fetchJson<T>(env: Env, url: string, cacheKey: string): Promise<T> {
  const cached = await kv(env).get(cacheKey);
  if (cached) return JSON.parse(cached) as T;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw badRequest(`identity provider returned ${res.status} for ${cacheKey}`);
  const text = await res.text();
  await kv(env).put(cacheKey, text, { expirationTtl: DOC_TTL_SEC });
  return JSON.parse(text) as T;
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Explicit endpoints win over discovery, so a provider that does not publish a
 * well-known document can still be configured by hand.
 */
async function endpoints(env: Env, provider: Provider): Promise<Endpoints> {
  if (provider.authorizeUrl && provider.tokenUrl && provider.jwksUrl) {
    return {
      authorization_endpoint: httpsOnly(provider.authorizeUrl, "authorizeUrl"),
      token_endpoint: httpsOnly(provider.tokenUrl, "tokenUrl"),
      jwks_uri: httpsOnly(provider.jwksUrl, "jwksUrl")
    };
  }
  const doc = await fetchJson<Endpoints>(
    env,
    httpsOnly(provider.discoveryUrl, "discoveryUrl"),
    `sso:disc:${provider.id}`
  );
  return {
    authorization_endpoint: httpsOnly(doc.authorization_endpoint, "authorization_endpoint"),
    token_endpoint: httpsOnly(doc.token_endpoint, "token_endpoint"),
    jwks_uri: httpsOnly(doc.jwks_uri, "jwks_uri")
  };
}

function redirectUri(url: string, providerId: string): string {
  return `${new URL(url).origin}/v1/auth/sso/${providerId}/callback`;
}

/* ---------------------------------------------------------------- discovery */

/**
 * Which provider, if any, owns an email address. The sign-in form calls this
 * before it asks for a password, so a federated user never types one.
 */
ssoRoutes.get("/discover", async (c) => {
  const email = (c.req.query("email") ?? "").toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  if (!domain) throw badRequest("email is required");

  const rows = await db(c.env)
    .select({
      id: schema.identityProviders.id,
      name: schema.identityProviders.name,
      kind: schema.identityProviders.kind
    })
    .from(schema.identityProviders)
    .where(
      and(
        eq(schema.identityProviders.emailDomain, domain),
        eq(schema.identityProviders.enabled, true)
      )
    )
    .limit(1);

  const found = rows[0];
  // Not an error: most addresses are not federated, and the caller draws the
  // password form either way.
  return c.json(found ? { ...found, startUrl: `/v1/auth/sso/${found.id}/start` } : {});
});

/* -------------------------------------------------------------------- start */

ssoRoutes.get("/:id/start", async (c) => {
  const provider = await providerById(c.env, c.req.param("id"));
  if (provider.kind === "saml") return c.redirect(await samlStart(c.env, provider, c.req.url, c.req.query("next")), 302);
  if (provider.kind !== "oidc") throw badRequest(`${provider.kind} sign-in is not enabled`);
  if (!provider.clientId) throw badRequest("provider has no clientId");

  const { authorization_endpoint } = await endpoints(c.env, provider);
  const state = randomToken(24);
  const nonce = randomToken(24);
  // PKCE: the code is useless to anyone who intercepts it without this.
  const verifier = randomToken(48);
  const pending: Pending = { providerId: provider.id, nonce, verifier, next: safeNext(c.req.query("next")) };
  await kv(c.env).put(`sso:state:${state}`, JSON.stringify(pending), {
    expirationTtl: STATE_TTL_SEC
  });

  const url = new URL(authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri(c.req.url, provider.id));
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return c.redirect(url.toString(), 302);
});

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ----------------------------------------------------------------- callback */

interface Claims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  name?: string;
  locale?: string;
}

interface Jwks {
  keys: (JsonWebKey & { kid?: string; alg?: string })[];
}

/**
 * Verify an id_token the way the spec means it: signature first, then issuer,
 * audience, expiry and nonce. A failure at any step is an unauthorized, never a
 * fallback to a weaker check.
 */
async function verifyIdToken(
  env: Env,
  provider: Provider,
  jwksUri: string,
  token: string,
  nonce: string,
  now: number
): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized("id_token is malformed");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(rawHeader))) as {
    alg?: string;
    kid?: string;
  };
  // RS256 only. `none` and the HMAC algorithms are the classic JWT bypasses, and
  // an allow-list of one is the shortest way to be immune to both.
  if (header.alg !== "RS256") throw unauthorized("id_token algorithm is not RS256");

  const jwks = await fetchJson<Jwks>(env, jwksUri, `sso:jwks:${provider.id}`);
  const candidates = jwks.keys.filter((k) => !header.kid || !k.kid || k.kid === header.kid);
  const data = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const signature = base64urlDecode(rawSignature);

  let verified = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, data)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw unauthorized("id_token signature does not verify");

  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(rawPayload))) as Claims;
  if (claims.iss !== provider.issuer) throw unauthorized("id_token issuer does not match");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!provider.clientId || !audiences.includes(provider.clientId)) {
    throw unauthorized("id_token audience does not match");
  }
  if (!claims.exp || claims.exp * 1000 <= now) throw unauthorized("id_token has expired");
  // Without this an id_token captured from another sign-in could be replayed
  // into this one.
  if (claims.nonce !== nonce) throw unauthorized("id_token nonce does not match");
  if (!claims.sub) throw unauthorized("id_token has no subject");
  return claims;
}

ssoRoutes.get("/:id/callback", async (c) => {
  const now = Date.now();
  const provider = await providerById(c.env, c.req.param("id"));
  if (provider.kind !== "oidc") throw badRequest(`${provider.kind} sign-in is not enabled`);

  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  if (!state || !code) throw badRequest("state and code are required");

  const key = `sso:state:${state}`;
  const raw = await kv(c.env).get(key);
  if (!raw) throw unauthorized("sign-in request expired or was already used");
  // Single use: delete before anything can fail, so a replay finds nothing.
  await kv(c.env).delete(key);
  const pending = JSON.parse(raw) as Pending;
  if (pending.providerId !== provider.id) throw unauthorized("state belongs to another provider");

  const { token_endpoint, jwks_uri } = await endpoints(c.env, provider);
  // The secret is named by the provider row and lives in the worker's secrets —
  // the database never holds one (CLAUDE.md §10).
  const secret = provider.clientSecretRef
    ? (c.env as unknown as Record<string, string | undefined>)[provider.clientSecretRef]
    : undefined;

  if (!pending.verifier || !pending.nonce) throw unauthorized("state is not an OIDC sign-in");
  const exchange = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(c.req.url, provider.id),
      client_id: provider.clientId ?? "",
      code_verifier: pending.verifier,
      ...(secret ? { client_secret: secret } : {})
    })
  });
  if (!exchange.ok) throw unauthorized("identity provider rejected the authorization code");
  const tokens = (await exchange.json()) as { id_token?: string };
  if (!tokens.id_token) throw unauthorized("identity provider returned no id_token");

  const claims = await verifyIdToken(
    c.env,
    provider,
    jwks_uri,
    tokens.id_token,
    pending.nonce,
    now
  );
  const user = await linkOrCreate(c.env, provider, claims, now);

  await issueSession(c, db(c.env), user, now, {
    mfaAsserted: provider.mfaAsserted,
    via: `sso:${provider.id}`
  });
  // Back to the app, not to a JSON body: this hop is a browser navigation.
  return c.redirect(`${c.env.APP_ORIGIN ?? ""}${safeNext(pending.next)}`, 302);
});

/**
 * Match on the subject claim first — an email address can be reassigned to a new
 * person, a subject cannot. An account that matches by email is linked once and
 * matches by subject from then on.
 */
async function linkOrCreate(
  env: Env,
  provider: Provider,
  claims: Claims,
  now: number
): Promise<typeof schema.users.$inferSelect> {
  const database = db(env);
  const email = (claims.email ?? "").toLowerCase();

  const bySubject = await database
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, provider.tenantId),
        eq(schema.users.externalId, claims.sub),
        isNull(schema.users.deletedAt)
      )
    )
    .limit(1);
  if (bySubject[0]) {
    if (bySubject[0].status !== "active") throw forbidden(`user is ${bySubject[0].status}`);
    return bySubject[0];
  }

  if (!email) throw unauthorized("identity provider returned no email");
  // The provider owns its domain (core_identity_providers.email_domain), so an
  // address outside it is someone else's user.
  if (email.split("@")[1] !== provider.emailDomain) {
    throw forbidden("email is outside this provider's domain");
  }

  const byEmail = await database
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, provider.tenantId),
        eq(schema.users.email, email),
        isNull(schema.users.deletedAt)
      )
    )
    .limit(1);

  if (byEmail[0]) {
    if (byEmail[0].status === "suspended") throw forbidden("user is suspended");
    await database
      .update(schema.users)
      .set({
        externalId: claims.sub,
        authProvider: provider.kind,
        // An invited account becomes real the moment the provider vouches for it.
        status: "active",
        updatedAt: now
      })
      .where(eq(schema.users.id, byEmail[0].id));
    return { ...byEmail[0], externalId: claims.sub, authProvider: provider.kind, status: "active" };
  }

  // Just-in-time provisioning is opt-in per provider: without a default role an
  // unknown person gets no account rather than an empty one.
  if (!provider.defaultRoleKey) throw forbidden("this account has not been invited");

  const roles = await database
    .select()
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.tenantId, provider.tenantId),
        eq(schema.roles.key, provider.defaultRoleKey)
      )
    )
    .limit(1);
  const role = roles[0];
  if (!role) throw forbidden(`default role ${provider.defaultRoleKey} does not exist`);

  const user = {
    id: newId("us", now),
    tenantId: provider.tenantId,
    email,
    phone: null,
    name: claims.name ?? email,
    locale: claims.locale?.slice(0, 2) === "ar" ? "ar" : "en",
    status: "active",
    authProvider: provider.kind,
    passwordHash: null,
    mfaEnrolled: false,
    mfaSecret: null,
    mfaRecoveryJson: null,
    externalId: claims.sub,
    providerId: null,
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  } satisfies typeof schema.users.$inferSelect;

  // No session exists yet at JIT time, so there is no Ctx to borrow — build
  // the minimal one assertSeatAvailable/scoped() need straight from the
  // provider's tenant, same as auditCorruptConfig does for the audit() call.
  const { entitlements } = await tenantConfig(database, provider.tenantId, now);
  await assertSeatAvailable({
    db: database as unknown as Ctx["db"],
    tenantId: provider.tenantId,
    actor: { kind: "system", id: "sso", tenantId: provider.tenantId, grants: [] },
    requestId: newId("req", now),
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements
  });

  await database.insert(schema.users).values(user);
  await database.insert(schema.userRoles).values({
    id: newId("url", now),
    tenantId: provider.tenantId,
    userId: user.id,
    roleId: role.id,
    scopeJson: null,
    createdAt: now
  });
  return user;
}

/* --------------------------------------------------------------------- SAML */

const spEntityId = (url: string, id: string) => `${new URL(url).origin}/v1/auth/sso/${id}/metadata`;
const acsUrl = (url: string, id: string) => `${new URL(url).origin}/v1/auth/sso/${id}/acs`;

/** The `certificate` column holds a PEM, or the bare base64 certificate IdP metadata carries. */
function pem(certificate: string): string {
  if (certificate.includes("-----BEGIN")) return certificate;
  const body = certificate.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function samlConfigured(provider: Provider): { ssoUrl: string; certificate: string } {
  if (!provider.ssoUrl || !provider.certificate) throw badRequest("this SAML provider needs its ssoUrl and signing certificate before anyone can sign in");
  return { ssoUrl: httpsOnly(provider.ssoUrl, "ssoUrl"), certificate: pem(provider.certificate) };
}

async function samlStart(env: Env, provider: Provider, url: string, next: string | undefined): Promise<string> {
  const { ssoUrl } = samlConfigured(provider);
  const relayState = randomToken(24);
  const pending: Pending = { providerId: provider.id, requestId: `_${randomToken(20)}`, next: safeNext(next) };
  await kv(env).put(`sso:state:${relayState}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_SEC });
  return authnRequestUrl({
    ssoUrl,
    requestId: pending.requestId!,
    spEntityId: spEntityId(url, provider.id),
    acsUrl: acsUrl(url, provider.id),
    relayState,
    now: Date.now()
  });
}

/** What an IdP administrator pastes in: entity id, ACS, signed assertions wanted. */
ssoRoutes.get("/:id/metadata", async (c) => {
  const provider = await providerById(c.env, c.req.param("id"));
  if (provider.kind !== "saml") throw notFound(`SAML provider ${provider.id}`);
  return c.body(spMetadata(spEntityId(c.req.url, provider.id), acsUrl(c.req.url, provider.id)), 200, {
    "content-type": "application/samlmetadata+xml"
  });
});

/** The Assertion Consumer Service: the IdP's browser POST lands here. */
ssoRoutes.post("/:id/acs", async (c) => {
  const now = Date.now();
  const provider = await providerById(c.env, c.req.param("id"));
  if (provider.kind !== "saml") throw badRequest(`${provider.kind} providers do not post to an ACS`);
  const { certificate } = samlConfigured(provider);

  const form = await c.req.parseBody();
  const samlResponse = typeof form.SAMLResponse === "string" ? form.SAMLResponse : "";
  const relayState = typeof form.RelayState === "string" ? form.RelayState : "";
  if (!samlResponse || !relayState) throw badRequest("SAMLResponse and RelayState are required");

  const key = `sso:state:${relayState}`;
  const raw = await kv(c.env).get(key);
  if (!raw) throw unauthorized("sign-in request expired or was already used");
  // Single use, as for OIDC: an IdP-initiated or replayed response finds nothing.
  await kv(c.env).delete(key);
  const pending = JSON.parse(raw) as Pending;
  if (pending.providerId !== provider.id || !pending.requestId) throw unauthorized("state belongs to another sign-in");

  const identity = await verifySamlResponse(samlResponse, {
    certificate,
    idpIssuer: provider.issuer,
    spEntityId: spEntityId(c.req.url, provider.id),
    acsUrl: acsUrl(c.req.url, provider.id),
    requestId: pending.requestId,
    now
  });
  const user = await linkOrCreate(
    c.env,
    provider,
    {
      iss: provider.issuer,
      aud: spEntityId(c.req.url, provider.id),
      sub: identity.nameId,
      exp: Math.floor(now / 1000),
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.name ? { name: identity.name } : {})
    },
    now
  );
  await issueSession(c, db(c.env), user, now, { mfaAsserted: provider.mfaAsserted, via: `sso:${provider.id}` });
  return c.redirect(`${c.env.APP_ORIGIN ?? ""}${safeNext(pending.next)}`, 302);
});
