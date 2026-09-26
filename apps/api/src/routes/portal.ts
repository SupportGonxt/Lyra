import { Hono, type Context } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema, BrandJson, EntitlementsJson, PolicyJson } from "@lyra/db";
import { audit, badRequest, conflict, emit, notFound, recordConsent, sha256Hex, timingSafeEqual } from "@lyra/core";
import { body, parse } from "../http.js";
import { readUpload } from "../upload.js";
import { verifyTurnstile } from "../turnstile.js";
import { ctxFor, db as rawDb, throttle } from "../auth.js";
import { portalLinkToken, type PortalLinkKind } from "../portal-link.js";
import {
  clampToCriteria,
  criteriaFor,
  panelFor,
  parseJson,
  quoteOne,
  rankOutcomes,
  type Criterion
} from "../engines/rating.js";
import { runShop } from "../engines/shop.js";
import { quoterFor } from "../engines/dist-quoter.js";
import { recordTouch } from "../engines/signal-attribution.js";
import { recordSignedConversion, verifyTrackSignature } from "../engines/signal-track.js";
import type { App, Env } from "../env.js";

// The public comparison site (yallacompare-style). No session exists at all —
// same reasoning as routes/onboarding.ts §partner signup — so this router
// builds its own system Ctx and is listed public-by-shape in mw.ts (the
// tenant slug is a dynamic segment, so it cannot be an exact-match PUBLIC entry).

export const portalRoutes = new Hono<App>();

const DIRECT_WEB_CHANNEL_KEY = "direct-web";
// ponytail: AED default (UAE launch market); a real multi-currency portal
// reads this off the tenant/product instead once a second market ships.
const DEFAULT_CURRENCY = "AED";
const LEAD_MAX = 3;
const LEAD_WINDOW_SEC = 24 * 60 * 60;
// An email-keyed throttle alone is free to bypass by rotating the address;
// this second, coarser throttle keys on the connecting IP so the same
// visitor can't just cycle emails.
const LEAD_IP_MAX = 10;

async function activeTenant(database: ReturnType<typeof rawDb>, slug: string) {
  const rows = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  const tenant = rows[0];
  if (!tenant || tenant.status !== "active") throw notFound("tenant");
  return tenant;
}

portalRoutes.get("/:tenantSlug/site", async (c) => {
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const brand = BrandJson.parse(tenant.brandJson ? JSON.parse(tenant.brandJson) : {});
  // The active domain pack (CLAUDE.md §14, docs/21 §3). Public pages need it for
  // the same reason the workspace does: a renewal page must not say "policy" to
  // a tenant whose pack calls it an order. It is a vocabulary name, not data.
  const domainPack = PolicyJson.parse(tenant.policyJson ? JSON.parse(tenant.policyJson) : {}).domainPack;

  const productRows = await database
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenant.id), eq(schema.products.status, "active")));
  const providerIds = [...new Set(productRows.map((p) => p.providerId).filter((id): id is string => Boolean(id)))];
  const providerRows = providerIds.length
    ? await database.select().from(schema.providers).where(eq(schema.providers.tenantId, tenant.id))
    : [];
  const providerNameById = new Map(providerRows.map((p) => [p.id, p.name]));

  return c.json({
    tenant: { name: tenant.name, brand, domainPack },
    products: productRows.map((p) => ({
      id: p.id,
      line: p.line,
      name: JSON.parse(p.nameJson).en as string,
      providerName: p.providerId ? (providerNameById.get(p.providerId) ?? null) : null
    }))
  });
});

/** The widget's `cf-turnstile-response`, forwarded by the web action. Optional in
 * the schema because the gate itself decides whether one is required — see
 * `verifyTurnstile`. */
const TurnstileToken = z.string().max(4096).optional();

const LeadBody = z
  .object({
    productId: z.string().min(1),
    name: z.string().min(1).max(200),
    email: z.string().email(),
    phone: z.string().max(40).optional(),
    message: z.string().max(2000).optional(),
    consent: z.literal(true),
    /**
     * The risk, in the product's rating inputs (J-C1's "3-field quick quote").
     * Absent means the visitor only asked to be contacted, which is the older
     * lead-capture behaviour and still valid — a product whose panel prices by
     * referral has nothing to show in the browser.
     */
    inputs: z.record(z.string(), z.unknown()).optional(),
    turnstileToken: TurnstileToken
  })
  .strict();

async function findOrCreateDirectWebChannel(ctx: Awaited<ReturnType<typeof ctxFor>>, now: number): Promise<string> {
  const existing = await ctx.db
    .select()
    .from(schema.distChannels)
    .where(and(eq(schema.distChannels.tenantId, ctx.tenantId), eq(schema.distChannels.key, DIRECT_WEB_CHANNEL_KEY)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const channelRow = {
    id: newId("chn", now),
    tenantId: ctx.tenantId,
    key: DIRECT_WEB_CHANNEL_KEY,
    kind: "b2c" as const,
    nameJson: JSON.stringify({ en: "Direct web" }),
    partnerId: null as string | null,
    medium: "web" as const,
    collectsPayment: "us" as const,
    settlementTermsJson: null,
    defaultCommissionPpm: null,
    currency: DEFAULT_CURRENCY,
    status: "active" as const,
    createdAt: now,
    updatedAt: now
  };
  await ctx.db.insert(schema.distChannels).values(channelRow);
  await audit(ctx, { action: "dist.channels.create", subjectRef: `channels:${channelRow.id}`, after: channelRow });
  return channelRow.id;
}

async function findOrCreateCustomer(
  ctx: Awaited<ReturnType<typeof ctxFor>>,
  now: number,
  input: { name: string; email: string; phone?: string }
): Promise<string> {
  const emailHash = await sha256Hex(input.email);
  const existing = await ctx.db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.nationalIdHash, emailHash)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  // ponytail: reusing nationalIdHash purely as a "lookup key for this lead
  // source" slot — there is no KYC id yet at anonymous-lead stage. A real
  // customer-matching pass happens when staff work the quote request.
  const customerRow = {
    id: newId("cus", now),
    tenantId: ctx.tenantId,
    type: "person" as const,
    nameJson: JSON.stringify({ en: input.name }),
    emailsJson: JSON.stringify([input.email]),
    phonesJson: input.phone ? JSON.stringify([input.phone]) : null,
    nationalIdHash: emailHash,
    kycStatus: "none" as const,
    consentId: null as string | null,
    tagsJson: JSON.stringify(["portal-lead"]),
    ltvCached: null,
    riskFlagsJson: null,
    locale: "en",
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
  await ctx.db.insert(schema.customers).values(customerRow);
  await audit(ctx, { action: "core.customers.create", subjectRef: `customers:${customerRow.id}`, after: customerRow });
  // The same announcement CRUD makes: SIGNAL records a new person as a prospect (ADR-0091).
  await emit(ctx, { module: "core", type: "core.customers.created", subject: customerRow.id, data: { id: customerRow.id } });
  return customerRow.id;
}

portalRoutes.post("/:tenantSlug/leads", async (c) => {
  const now = Date.now();
  const input = await body(c, LeadBody);
  const email = input.email.toLowerCase();
  await throttle(c.env, `portal-lead:${email}`, LEAD_MAX, LEAD_WINDOW_SEC);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-lead-ip:${ip}`, LEAD_IP_MAX, LEAD_WINDOW_SEC);
  await verifyTurnstile(c.env, input.turnstileToken, ip);

  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));

  const productRows = await database
    .select()
    .from(schema.products)
    .where(
      and(
        eq(schema.products.tenantId, tenant.id),
        eq(schema.products.id, input.productId),
        eq(schema.products.status, "active")
      )
    )
    .limit(1);
  if (!productRows[0]) throw notFound("product");

  const ctx = await ctxFor(
    c.env,
    {
      tenantId: tenant.id,
      locale: "en",
      actor: { kind: "system", id: "portal-lead", tenantId: tenant.id, grants: [] },
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    },
    now,
    c.req.header("cf-connecting-ip"),
    c.req.header("user-agent")
  );

  const channelId = await findOrCreateDirectWebChannel(ctx, now);
  const customerId = await findOrCreateCustomer(ctx, now, {
    name: input.name,
    email,
    ...(input.phone ? { phone: input.phone } : {})
  });
  // input.consent is required true by LeadBody's z.literal(true) - this is what
  // makes that checkbox mean something rather than being validated and discarded.
  const consent = await recordConsent(ctx, {
    customerId,
    purposes: { dataSharing: true },
    channels: { email: true, ...(input.phone ? { sms: true } : {}) },
    source: "portal",
    evidenceRef: `quote-request-lead:${tenant.slug}`
  });

  // The contact details are what the customer typed; the risk (if any) is what
  // gets priced. Both belong on the request — staff working the lead need the
  // former, the panel needs the latter.
  const contact = { name: input.name, email, phone: input.phone ?? null, message: input.message ?? null };
  const inputs = input.inputs ?? null;

  // A shop only makes sense if something on the panel can answer in-session.
  // An empty panel is not an error for a lead — it means "a human will call" —
  // so it falls back rather than 409ing a member of the public.
  const panel = inputs
    ? await panelFor(ctx, { productId: input.productId, channelKey: DIRECT_WEB_CHANNEL_KEY, at: now })
    : [];

  const baseRow = {
    id: newId("qrq", now),
    tenantId: tenant.id,
    caseId: null as string | null,
    customerId,
    channelId,
    productId: input.productId,
    inputsJson: JSON.stringify(inputs ? { ...contact, ...inputs } : contact),
    consentId: consent.id as string | null,
    currency: DEFAULT_CURRENCY,
    sharedWithCustomerAt: null as number | null,
    expiresAt: inputs && panel.length ? now + QUOTE_TTL_MS : null,
    createdAt: now,
    updatedAt: now
  };

  if (!inputs || !panel.length) {
    const leadRow = {
      ...baseRow,
      fanoutCount: 0,
      respondedCount: 0,
      bestOfferingId: null as string | null,
      bestPremiumMinor: null as number | null,
      portalTokenHash: null as string | null,
      state: "open" as const
    };
    await ctx.db.insert(schema.distQuoteRequests).values(leadRow);
    await audit(ctx, {
      action: "dist.quote_requests.create",
      subjectRef: `quote-requests:${leadRow.id}`,
      after: leadRow
    });
    await emit(ctx, {
      module: "dist",
      type: "dist.quote_requests.created",
      subject: leadRow.id,
      data: { id: leadRow.id, via: "portal" }
    });
    return c.json({ quoteRequestId: leadRow.id }, 201);
  }

  // The visitor has no session, so the token in the response is the only thing
  // that will let them come back to this comparison. Stored as a hash: a leaked
  // database row must not re-open somebody's quote.
  const token = portalToken();
  const shopped = await runShop(ctx, {
    request: { ...baseRow, portalTokenHash: await sha256Hex(token) },
    channelKey: DIRECT_WEB_CHANNEL_KEY,
    inputs,
    quoter: quoterFor(c.env)
  });
  await audit(ctx, {
    action: "dist.quote_requests.create",
    subjectRef: `quote-requests:${shopped.request.id}`,
    after: { ...shopped.request, portalTokenHash: "[redacted]" }
  });
  await emit(ctx, {
    module: "dist",
    type: "dist.quote_requests.created",
    subject: shopped.request.id,
    data: { id: shopped.request.id, via: "portal", fanout: shopped.request.fanoutCount }
  });

  return c.json(
    {
      quoteRequestId: shopped.request.id,
      token,
      ...(await comparison(ctx, shopped.request, shopped.responses))
    },
    201
  );
});

// ---------------------------------------------------------------------------
// Self-registration (J-C1's "create an account" step, and the B2B door beside
// it). The third public write on this router, and the one with the sharpest
// edge: creating a *record* is fine, creating *access* is not. This endpoint
// only ever writes a `core_customers` row at `kyc_status: "pending"` — no
// user, no session, no role, no key. Verification and any entitlement that
// follows are `consequential: true` (CLAUDE.md §4) and belong to a human, the
// same way a partner signup lands at `stage: "prospect"` and cannot walk itself
// to "live" (routes/onboarding.ts).

const REGISTER_MAX = 3;
const REGISTER_WINDOW_SEC = 24 * 60 * 60;
const REGISTER_IP_MAX = 10;

const RegistrationBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      name: z.string().min(1).max(200),
      email: z.string().email(),
      phone: z.string().max(40).optional(),
      locale: z.enum(["en", "ar"]).optional(),
      consent: z.literal(true),
      turnstileToken: TurnstileToken
    })
    .strict(),
  z
    .object({
      kind: z.literal("business"),
      companyName: z.string().min(2).max(200),
      registrationNo: z.string().min(1).max(80).optional(),
      taxId: z.string().min(1).max(80).optional(),
      /** ISO 3166-1 alpha-2. A free-text country is a KYB field nobody can check. */
      country: z.string().length(2).optional(),
      /** The human who signs. A company on its own has no one to email. */
      contactName: z.string().min(1).max(200),
      email: z.string().email(),
      phone: z.string().max(40).optional(),
      locale: z.enum(["en", "ar"]).optional(),
      consent: z.literal(true),
      turnstileToken: TurnstileToken
    })
    .strict()
]);

portalRoutes.post("/:tenantSlug/registrations", async (c) => {
  const now = Date.now();
  const input = await body(c, RegistrationBody);
  const email = input.email.toLowerCase();
  await throttle(c.env, `portal-register:${email}`, REGISTER_MAX, REGISTER_WINDOW_SEC);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-register-ip:${ip}`, REGISTER_IP_MAX, REGISTER_WINDOW_SEC);
  await verifyTurnstile(c.env, input.turnstileToken, ip);

  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const ctx = await portalCtx(c, tenant.id, now, "portal-register");

  const emailHash = await sha256Hex(email);
  const existing = (
    await ctx.db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, tenant.id), eq(schema.customers.nationalIdHash, emailHash)))
      .limit(1)
  )[0];

  const business = input.kind === "business" ? input : null;
  const tags = new Set<string>([
    ...(existing?.tagsJson ? (JSON.parse(existing.tagsJson) as string[]) : []),
    "portal-registration",
    input.kind
  ]);
  const fields = {
    type: input.kind === "business" ? ("business" as const) : ("person" as const),
    nameJson: JSON.stringify(
      input.kind === "business" ? { en: input.companyName, contact: input.contactName } : { en: input.name }
    ),
    emailsJson: JSON.stringify([email]),
    phonesJson: input.phone ? JSON.stringify([input.phone]) : (existing?.phonesJson ?? null),
    registrationNo: business?.registrationNo ?? existing?.registrationNo ?? null,
    taxId: business?.taxId ?? existing?.taxId ?? null,
    country: business?.country?.toUpperCase() ?? existing?.country ?? null,
    // Registering asks to be verified; it never claims to be. An already
    // verified customer re-registering must not be walked backwards either.
    kycStatus: existing?.kycStatus === "verified" ? ("verified" as const) : ("pending" as const),
    tagsJson: JSON.stringify([...tags]),
    locale: input.locale ?? existing?.locale ?? "en",
    updatedAt: now
  };

  const customerId = existing?.id ?? newId("cus", now);
  if (existing) {
    await ctx.db
      .update(schema.customers)
      .set(fields)
      .where(and(eq(schema.customers.tenantId, tenant.id), eq(schema.customers.id, existing.id)));
  } else {
    await ctx.db.insert(schema.customers).values({
      id: customerId,
      tenantId: tenant.id,
      nationalIdHash: emailHash,
      consentId: null,
      ltvCached: null,
      riskFlagsJson: null,
      createdAt: now,
      deletedAt: null,
      ...fields
    });
    await emit(ctx, { module: "core", type: "core.customers.created", subject: customerId, data: { id: customerId } });
  }

  const consent = await recordConsent(ctx, {
    customerId,
    purposes: { dataSharing: true },
    channels: { email: true, ...(input.phone ? { sms: true } : {}) },
    source: "portal",
    evidenceRef: `registration:${tenant.slug}`
  });
  await ctx.db
    .update(schema.customers)
    .set({ consentId: consent.id, updatedAt: now })
    .where(and(eq(schema.customers.tenantId, tenant.id), eq(schema.customers.id, customerId)));

  await audit(ctx, {
    action: "core.customers.register",
    subjectRef: `customers:${customerId}`,
    ...(existing ? { before: existing } : {}),
    after: { id: customerId, ...fields }
  });
  await emit(ctx, {
    module: "core",
    type: "core.customers.registered",
    subject: customerId,
    data: { id: customerId, kind: input.kind, via: "portal" }
  });

  // 202, and nothing to hold: no id, no token, no key. A registration that
  // handed back a handle would be a credential, and the reply is identical
  // whether or not the email was already known — a public form must not be an
  // oracle for who is a customer here.
  return c.json({ status: "pending" as const }, 202);
});

// ---------------------------------------------------------------------------
// J-C1 "Get covered" (docs/06 §J-C1): quick quote -> ranked offers -> docs ->
// pay -> policy. Everything up to `pay` is here. Payment is not: no PSP
// connector exists in the repo (engines/settlement.ts says the same), and
// issuance is `consequential` (CLAUDE.md §4) so a human approves it. ADR-0043.

const QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_IP_MAX = 20;

function portalToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The request behind a portal link, or 404. Wrong token and unknown id answer
 * identically on purpose: the id is in the visitor's own URL, so a distinct
 * "token invalid" would confirm that someone else's quote exists.
 */
async function requestForToken(
  database: ReturnType<typeof rawDb>,
  tenantId: string,
  requestId: string,
  token: string | undefined
): Promise<typeof schema.distQuoteRequests.$inferSelect> {
  const rows = await database
    .select()
    .from(schema.distQuoteRequests)
    .where(and(eq(schema.distQuoteRequests.tenantId, tenantId), eq(schema.distQuoteRequests.id, requestId)))
    .limit(1);
  const row = rows[0];
  if (!row?.portalTokenHash || !token || row.portalTokenHash !== (await sha256Hex(token))) {
    throw notFound("quote request");
  }
  return row;
}

/** One priced answer, in the fields the public shape is built from. Both the
 *  stored responses and a live indicative re-price reduce to this. */
interface OfferLike {
  offeringId: string;
  providerId: string;
  premiumMinor: number;
  taxMinor: number;
  feesMinor: number;
  currency: string;
  coverage: Record<string, unknown> | null;
  rank: number | null;
  validUntil: number | null;
}

/**
 * Ranked offers with their names resolved. The one place the public offer shape
 * is decided, so a re-price cannot drift into showing a field the stored
 * comparison hides.
 */
async function publicOffers(ctx: Awaited<ReturnType<typeof ctxFor>>, quoted: OfferLike[]) {
  const offeringIds = quoted.map((o) => o.offeringId);
  const offerings = offeringIds.length
    ? await ctx.db
        .select()
        .from(schema.distOfferings)
        .where(and(eq(schema.distOfferings.tenantId, ctx.tenantId), inArray(schema.distOfferings.id, offeringIds)))
    : [];
  const offeringById = new Map(offerings.map((o) => [o.id, o]));
  const providers = offerings.length
    ? await ctx.db.select().from(schema.providers).where(eq(schema.providers.tenantId, ctx.tenantId))
    : [];
  const providerNameById = new Map(providers.map((p) => [p.id, p.name]));

  return [...quoted]
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map((o) => {
      const offering = offeringById.get(o.offeringId);
      return {
        offeringId: o.offeringId,
        name: offering ? (JSON.parse(offering.nameJson).en as string) : o.offeringId,
        providerName: providerNameById.get(o.providerId) ?? null,
        premiumMinor: o.premiumMinor,
        taxMinor: o.taxMinor,
        feesMinor: o.feesMinor,
        totalMinor: o.premiumMinor + o.taxMinor + o.feesMinor,
        currency: o.currency,
        coverage: o.coverage,
        rank: o.rank,
        validUntil: o.validUntil
      };
    });
}

/**
 * The criteria this request's panel rates on, plus the visitor's own values for
 * them. Only criteria fields come back: the same `inputs_json` also holds the
 * contact details typed into the lead form, which are not the public's to read
 * off a link.
 */
async function criteriaOf(
  ctx: Awaited<ReturnType<typeof ctxFor>>,
  request: typeof schema.distQuoteRequests.$inferSelect
): Promise<{ criteria: Criterion[]; stored: Record<string, unknown>; inputs: Record<string, unknown> }> {
  const panel = await panelFor(ctx, {
    productId: request.productId,
    channelKey: DIRECT_WEB_CHANNEL_KEY,
    at: ctx.now
  });
  const stored = parseJson<Record<string, unknown>>(request.inputsJson) ?? {};
  const criteria = criteriaFor(panel, stored);
  const inputs: Record<string, unknown> = {};
  for (const c of criteria) if (stored[c.field] !== undefined) inputs[c.field] = stored[c.field];
  return { criteria, stored, inputs };
}

/**
 * The comparison as a member of the public may see it: quotes only, ranked, with
 * the ranking criterion stated (docs/12 — the customer is told what "best" means
 * here). Commission, provider scores and decline reasons stay internal.
 */
async function comparison(
  ctx: Awaited<ReturnType<typeof ctxFor>>,
  request: typeof schema.distQuoteRequests.$inferSelect,
  responses?: (typeof schema.distQuoteResponses.$inferSelect)[]
) {
  const rows =
    responses ??
    (await ctx.db
      .select()
      .from(schema.distQuoteResponses)
      .where(
        and(
          eq(schema.distQuoteResponses.tenantId, ctx.tenantId),
          eq(schema.distQuoteResponses.requestId, request.id)
        )
      ));

  const quoted = rows.filter((r) => r.state === "quoted" && r.premiumMinor !== null);
  const { criteria, inputs } = await criteriaOf(ctx, request);

  return {
    state: request.state,
    currency: request.currency,
    // Declared ranking criteria: J-C1 says "ranked offers (declared criteria
    // visible)", and a comparison that hides how it sorted is the thing the
    // journey is written against.
    rankedBy: "total_price" as const,
    acceptedOfferingId: request.state === "converted" ? request.bestOfferingId : null,
    referredCount: rows.filter((r) => r.state === "referred").length,
    // What the visitor may move, and where they currently stand. The comparison
    // is the page the sliders live on, so the knobs travel with it rather than
    // needing a second round trip before the first drag.
    criteria,
    inputs,
    offers: await publicOffers(
      ctx,
      quoted.map((r) => ({
        offeringId: r.offeringId,
        providerId: r.providerId,
        premiumMinor: r.premiumMinor as number,
        taxMinor: r.taxMinor,
        feesMinor: r.feesMinor,
        // A response may leave currency null and mean "the one the request was
        // raised in"; the public shape has no null to offer.
        currency: r.currency ?? request.currency,
        coverage: r.coverageJson ? (JSON.parse(r.coverageJson) as Record<string, unknown>) : null,
        rank: r.priceRank,
        validUntil: r.validUntil
      }))
    )
  };
}

async function portalCtx(c: Context<App>, tenantId: string, now: number, who: string) {
  return ctxFor(
    c.env,
    {
      tenantId,
      locale: "en",
      actor: { kind: "system", id: who, tenantId, grants: [] },
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    },
    now,
    c.req.header("cf-connecting-ip"),
    c.req.header("user-agent")
  );
}

portalRoutes.get("/:tenantSlug/quote-requests/:id", async (c) => {
  const now = Date.now();
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const request = await requestForToken(database, tenant.id, c.req.param("id"), c.req.query("token"));
  const ctx = await portalCtx(c, tenant.id, now, "portal-quote");
  return c.json(await comparison(ctx, request));
});

// "What if my excess were higher / my cover bigger / I were older" — the whole
// point of a comparison site. It runs the same panelFor/quoteOne/rankOutcomes
// path a real shop runs (engines/shop.ts) but persists nothing: an indicative
// price is not a transaction (docs/19 §2), so it may not touch money state, and
// a visitor dragging a slider must not leave a hundred quote responses behind.
const REPRICE_ROW_MAX = 120;
const REPRICE_IP_MAX = 600;
const REPRICE_WINDOW_SEC = 10 * 60;

const RepriceBody = z
  .object({
    token: z.string().min(1),
    /** Criteria only. Anything the panel does not rate on is dropped, and every
     *  number is clamped into the panel's declared range — see clampToCriteria. */
    inputs: z.record(z.string().max(64), z.union([z.number().finite(), z.boolean()]))
  })
  .strict();

portalRoutes.post("/:tenantSlug/quote-requests/:id/reprice", async (c) => {
  const now = Date.now();
  const input = await body(c, RepriceBody);
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  // Token first: an unthrottled stranger must not be able to burn a real
  // visitor's re-price budget by guessing quote ids.
  const request = await requestForToken(database, tenant.id, c.req.param("id"), input.token);
  await throttle(c.env, `portal-reprice:${request.id}`, REPRICE_ROW_MAX, REPRICE_WINDOW_SEC);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-reprice-ip:${ip}`, REPRICE_IP_MAX, REPRICE_WINDOW_SEC);

  const ctx = await portalCtx(c, tenant.id, now, "portal-reprice");
  const { criteria, stored } = await criteriaOf(ctx, request);
  const moved = clampToCriteria(criteria, input.inputs);
  if (!Object.keys(moved).length) throw badRequest("no rating criteria in inputs");

  // The stored risk is the base: fields the sliders do not expose (vehicle use,
  // market) still have to reach the underwriter, and they stay server-side
  // rather than being round-tripped through a public browser.
  const inputs = { ...stored, ...moved };
  const panel = await panelFor(ctx, {
    productId: request.productId,
    channelKey: DIRECT_WEB_CHANNEL_KEY,
    at: now
  });
  const outcomes = await Promise.all(panel.map((entry) => quoteOne(ctx, entry, inputs)));
  const ranked = await rankOutcomes(ctx, outcomes, { channelId: request.channelId });
  const quoted = ranked.filter(
    (o): o is (typeof ranked)[number] & { premiumMinor: number } =>
      o.state === "quoted" && typeof o.premiumMinor === "number"
  );

  return c.json({
    // Said in the payload, not only in the UI copy: nothing here is an offer,
    // and the stored comparison is still whatever it was before the drag.
    indicative: true,
    currency: request.currency,
    rankedBy: "total_price" as const,
    referredCount: ranked.filter((o) => o.state === "referred").length,
    criteria,
    inputs: moved,
    offers: await publicOffers(
      ctx,
      quoted.map((o) => ({
        offeringId: o.offeringId,
        providerId: o.providerId,
        premiumMinor: o.premiumMinor,
        taxMinor: o.taxMinor,
        feesMinor: o.feesMinor,
        currency: o.currency,
        coverage: o.coverage ?? null,
        rank: o.priceRank ?? null,
        validUntil: o.validUntil ?? null
      }))
    )
  });
});

const AcceptBody = z.object({ token: z.string().min(1), offeringId: z.string().min(1) }).strict();

portalRoutes.post("/:tenantSlug/quote-requests/:id/accept", async (c) => {
  const now = Date.now();
  const input = await body(c, AcceptBody);
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const request = await requestForToken(database, tenant.id, c.req.param("id"), input.token);
  if (request.expiresAt !== null && request.expiresAt < now) throw conflict("quote has expired");

  const ctx = await portalCtx(c, tenant.id, now, "portal-quote-accept");
  const responses = await ctx.db
    .select()
    .from(schema.distQuoteResponses)
    .where(
      and(eq(schema.distQuoteResponses.tenantId, tenant.id), eq(schema.distQuoteResponses.requestId, request.id))
    );
  const chosen = responses.find((r) => r.offeringId === input.offeringId && r.state === "quoted");
  if (!chosen) throw notFound("offer");

  // Accepting is the customer saying which quote they want. It is not issuance:
  // binding cover is `consequential: true` (CLAUDE.md §4), so a human approves
  // it from the case this converts into. Re-accepting a different offer before
  // that happens is allowed — nothing has been bound yet.
  await ctx.db
    .update(schema.distQuoteRequests)
    .set({
      bestOfferingId: chosen.offeringId,
      bestPremiumMinor: chosen.premiumMinor,
      state: "converted",
      sharedWithCustomerAt: request.sharedWithCustomerAt ?? now,
      updatedAt: now
    })
    .where(and(eq(schema.distQuoteRequests.tenantId, tenant.id), eq(schema.distQuoteRequests.id, request.id)));

  await audit(ctx, {
    action: "dist.quote_requests.accept",
    subjectRef: `quote-requests:${request.id}`,
    before: { bestOfferingId: request.bestOfferingId, state: request.state },
    after: { bestOfferingId: chosen.offeringId, state: "converted", via: "portal" }
  });
  await emit(ctx, {
    module: "dist",
    type: "dist.quote_requests.accepted",
    subject: request.id,
    data: { id: request.id, offeringId: chosen.offeringId, premiumMinor: chosen.premiumMinor, via: "portal" }
  });

  // No payment step: no PSP connector exists (engines/settlement.ts §7), so what
  // the customer is told next is "send your documents", and a human takes it
  // from there. ADR-0043.
  return c.json({ acceptedOfferingId: chosen.offeringId, nextStep: "documents" });
});

portalRoutes.post("/:tenantSlug/quote-requests/:id/documents", async (c) => {
  const now = Date.now();
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const form = await c.req.formData();
  const token = form.get("token");
  const request = await requestForToken(
    database,
    tenant.id,
    c.req.param("id"),
    typeof token === "string" ? token : undefined
  );

  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-upload-ip:${ip}`, UPLOAD_IP_MAX, LEAD_WINDOW_SEC);

  const { bytes, contentType } = await readUpload(form);

  const bucket = c.env.FILES;
  if (!bucket) throw conflict("document storage is not configured");

  const ctx = await portalCtx(c, tenant.id, now, "portal-quote-documents");
  const fileId = newId("file", now);
  const r2Key = `portal/${tenant.id}/${request.id}/${fileId}`;
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: tenant.id,
    r2Key,
    kind: "customer_document",
    subjectRef: `quote-requests:${request.id}`,
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    contentType,
    // An ID photo or a licence disc is as sensitive as the platform holds, and
    // nobody verified who uploaded it.
    piiLevel: "high",
    createdAt: now,
    deletedAt: null
  });
  await audit(ctx, {
    action: "core.files.create",
    subjectRef: `files:${fileId}`,
    after: { id: fileId, kind: "customer_document", subjectRef: `quote-requests:${request.id}`, via: "portal" }
  });

  return c.json({ fileId }, 201);
});

// ---------------------------------------------------------------------------
// J-C4 privacy rights (docs/06 §J-C4, docs/12 §Rights). ADR-0042 supersedes
// ADR-0041's staff-mediated intake: the data subject starts their own clock.
//
// What deliberately does NOT happen here: verification. docs/12 states no
// verification method and `IdentityVerifier` (packages/core/src/seams.ts, H5)
// has no implementation, so the row lands unverified — `verificationRef: null`,
// state `received` — and `tenant.compliance` staff verify before anything is
// packaged or erased. An intake that verified nothing but claimed it had would
// be worse than one that is honest about the gap.

const DSAR_MAX = 3;
const DSAR_IP_MAX = 10;
// The tenant's own service target, matching packages/core/src/seed/compliance.ts:
// docs/12 does not state a statutory period, so this does not invent one.
const DSAR_DUE_DAYS = 30;

const PrivacyRequestBody = z
  .object({
    type: z.enum(["access", "erasure", "rectification", "portability", "objection", "restriction"]),
    email: z.string().email(),
    name: z.string().max(200).optional(),
    details: z.string().max(2000).optional(),
    turnstileToken: TurnstileToken
  })
  .strict();

// Best-effort link to an existing record. A miss is not an error and not
// disclosed: an unmatched request is still a request, and the response must
// look identical either way or the portal becomes a customer-enumeration oracle.
async function customerIdForEmail(
  database: ReturnType<typeof rawDb>,
  tenantId: string,
  email: string
): Promise<string | null> {
  const candidates = await database
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, tenantId), like(schema.customers.emailsJson, `%${email}%`)))
    .limit(20);
  // `_` is a legal email character and a LIKE wildcard, so the SQL narrows and
  // this exact-matches.
  const hit = candidates.find((row) => {
    if (!row.emailsJson) return false;
    const parsed: unknown = JSON.parse(row.emailsJson);
    return Array.isArray(parsed) && parsed.some((e) => typeof e === "string" && e.toLowerCase() === email);
  });
  return hit?.id ?? null;
}

portalRoutes.post("/:tenantSlug/privacy-requests", async (c) => {
  const now = Date.now();
  const input = await body(c, PrivacyRequestBody);
  const email = input.email.toLowerCase();
  await throttle(c.env, `portal-dsar:${email}`, DSAR_MAX, LEAD_WINDOW_SEC);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-dsar-ip:${ip}`, DSAR_IP_MAX, LEAD_WINDOW_SEC);
  await verifyTurnstile(c.env, input.turnstileToken, ip);

  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const customerId = await customerIdForEmail(database, tenant.id, email);

  const ctx = await ctxFor(
    c.env,
    {
      tenantId: tenant.id,
      locale: "en",
      actor: { kind: "system", id: "portal-dsar", tenantId: tenant.id, grants: [] },
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    },
    now,
    ip,
    c.req.header("user-agent")
  );

  const dueAt = now + DSAR_DUE_DAYS * 24 * 60 * 60 * 1000;
  const requestRow = {
    id: newId("dsr", now),
    tenantId: tenant.id,
    customerId,
    subjectIdentifier: email,
    type: input.type,
    channel: "portal" as const,
    verificationRef: null as string | null,
    subjectNote: [input.name ? `Name given: ${input.name}` : null, input.details ?? null]
      .filter(Boolean)
      .join("\n") || null,
    state: "received" as const,
    dueAt,
    fulfilledAt: null as number | null,
    refusalReason: null as string | null,
    bundleFileId: null as string | null,
    completenessProofJson: null as string | null,
    handledBy: null as string | null,
    createdAt: now,
    updatedAt: now
  };
  await ctx.db.insert(schema.dsarRequests).values(requestRow);
  await audit(ctx, {
    action: "compliance.dsar-requests.create",
    subjectRef: `dsar-requests:${requestRow.id}`,
    after: requestRow
  });
  await emit(ctx, {
    module: "compliance",
    type: "compliance.dsar-requests.created",
    subject: requestRow.id,
    data: { id: requestRow.id, type: requestRow.type, via: "portal" }
  });

  // 202, not 201: what was accepted is the request, not the outcome — nothing
  // is packaged or erased until a human verifies the subject.
  return c.json({ reference: requestRow.id, dueAt }, 202);
});

// ---------------------------------------------------------------------------
// ORBIT's two messaged public pages: the one-tap renewal
// (docs/modules/orbit.md §2.2 "one-tap renewal link (hosted page,
// tenant-branded)", J-C3) and satisfaction capture (§5 "CSAT/NPS collection",
// J-C2 "→ CSAT tap", §7 KPI "CSAT ≥ 4.5"). Both are reached from a link we sent
// to one person about one row, so the link itself is the whole credential —
// same reasoning as the quote-request token above.
//
// The token is *derived*, not stored: HMAC-SHA256(FIELD_KEY,
// "portal-link.v1:<kind>:<tenantId>:<rowId>"). `orbit_renewals` and
// `orbit_conversations` carry no token column and migrations are forward-only
// (CLAUDE.md §9), so deriving avoids a schema change while still binding the
// credential to one tenant and one row: a token minted for tenant A's renewal
// does not verify against tenant B's row of the same id, and a leaked database
// row yields no working link because the key never touches the database.
//
// ponytail: derived means no per-link revocation. Each row's own state machine
// closes the link instead — an accepted renewal and a rated conversation both
// refuse a second write. Add a token-hash column the day a tenant needs to kill
// one link early.

// The token and the whole link live in ../portal-link.ts, where the staff
// route and the journey `survey` node mint them too.

/**
 * Wrong token, token for another tenant's row, and unknown id all answer
 * `404 <kind>` — the id is in the visitor's own URL, so any distinguishable
 * answer would confirm that somebody else's row exists.
 */
async function assertPortalLink(
  env: Pick<Env, "FIELD_KEY">
  , kind: PortalLinkKind
  , tenantId: string
  , rowId: string
  , token: string | undefined
): Promise<void> {
  const expected = await portalLinkToken(env, kind, tenantId, rowId);
  if (!token || !timingSafeEqual(token, expected)) throw notFound(kind);
}

// A messaged link is opened by one person on one phone, often twice. These are
// generous enough not to punish that and tight enough that the link is not a
// free write endpoint.
const LINK_ROW_MAX = 10;
const LINK_IP_MAX = 40;

async function throttleLink(env: App["Bindings"], kind: PortalLinkKind, rowId: string, ip: string | undefined) {
  await throttle(env, `portal-${kind}:${rowId}`, LINK_ROW_MAX, LEAD_WINDOW_SEC);
  if (ip) await throttle(env, `portal-${kind}-ip:${ip}`, LINK_IP_MAX, LEAD_WINDOW_SEC);
}

/**
 * The renewal as the person whose cover it is may see it. `churnScore`,
 * `strategy`, `ownerRef` and `outcomeReason` are internal scoring and internal
 * wording (docs/12): they stay on the staff side of the wall.
 */
function renewalView(row: typeof schema.orbitRenewals.$inferSelect) {
  return {
    reference: row.policyRef,
    expiryAt: row.expiryAt,
    state: row.state,
    decidedAt: row.decidedAt
  };
}

async function renewalForLink(c: Context<App>, tenantId: string, rowId: string, token: string | undefined) {
  await assertPortalLink(c.env, "renewal", tenantId, rowId, token);
  const rows = await rawDb(c.env)
    .select()
    .from(schema.orbitRenewals)
    .where(and(eq(schema.orbitRenewals.tenantId, tenantId), eq(schema.orbitRenewals.id, rowId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("renewal");
  return row;
}

portalRoutes.get("/:tenantSlug/renewals/:id", async (c) => {
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const row = await renewalForLink(c, tenant.id, c.req.param("id"), c.req.query("token"));
  return c.json(renewalView(row));
});

const RenewalAcceptBody = z.object({ token: z.string().min(1) }).strict();

/**
 * J-C3 "Renew in one tap". What this writes is the customer's decision —
 * `state: "accepted"`, which nothing else in the codebase ever sets — and
 * nothing else. It does not issue cover, take payment or reprice: binding is
 * `consequential: true` (CLAUDE.md §4) so a human picks the accepted renewal up
 * from the desk, exactly as `/quote-requests/:id/accept` above hands its
 * conversion to a person. `accepted` is terminal in renewal-campaign.ts's
 * `resolved()`, so this also stops the 30-day nudge campaign.
 *
 * No `withIdempotency`: a browser sends no idempotency key, and the state
 * machine already makes a second tap a no-op that returns the same body.
 */
portalRoutes.post("/:tenantSlug/renewals/:id/accept", async (c) => {
  const now = Date.now();
  const input = await body(c, RenewalAcceptBody);
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const row = await renewalForLink(c, tenant.id, c.req.param("id"), input.token);
  await throttleLink(c.env, "renewal", row.id, c.req.header("cf-connecting-ip"));

  if (row.state === "accepted") return c.json(renewalView(row));
  if (row.state === "lost") throw conflict("this renewal is closed");
  if (row.expiryAt < now) throw conflict("this renewal has expired");

  const after = { ...row, state: "accepted" as const, outcomeReason: "customer_accepted", decidedAt: now, updatedAt: now };
  const ctx = await portalCtx(c, tenant.id, now, "portal-renewal-accept");
  await ctx.db
    .update(schema.orbitRenewals)
    .set({ state: "accepted", outcomeReason: "customer_accepted", decidedAt: now, updatedAt: now })
    .where(and(eq(schema.orbitRenewals.tenantId, tenant.id), eq(schema.orbitRenewals.id, row.id)));
  await audit(ctx, { action: "orbit.renewal.accepted", subjectRef: row.id, before: row, after });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.accepted",
    subject: row.id,
    data: { policyRef: row.policyRef, customerId: row.customerId, via: "portal" }
  });

  return c.json(renewalView(after));
});

// The 1-5 scale orbit-analytics.tsx already averages (`outOf(loaded.csat, 5)`)
// and seed/orbit.ts already writes. NPS is not here: `orbit_conversations` has
// one `csat` integer and no NPS column, and inventing a second meaning for that
// column would poison the KPI the same screen reports.
const CSAT_MAX = 5;

const FeedbackBody = z
  .object({ token: z.string().min(1), rating: z.number().int().min(1).max(CSAT_MAX) })
  .strict();

/**
 * Nothing about the conversation except whether it can be rated and what it was
 * rated. No transcript, no AI summary, no assignee, no customer: the link holder
 * is not authenticated as anybody, they merely hold a link to one row.
 */
function feedbackView(row: typeof schema.orbitConversations.$inferSelect) {
  return {
    ratable: row.state === "closed" && row.csat === null,
    rating: row.csat,
    scaleMax: CSAT_MAX,
    closedAt: row.closedAt
  };
}

async function conversationForLink(c: Context<App>, tenantId: string, rowId: string, token: string | undefined) {
  await assertPortalLink(c.env, "feedback", tenantId, rowId, token);
  const rows = await rawDb(c.env)
    .select()
    .from(schema.orbitConversations)
    .where(and(eq(schema.orbitConversations.tenantId, tenantId), eq(schema.orbitConversations.id, rowId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("feedback");
  return row;
}

portalRoutes.get("/:tenantSlug/feedback/:id", async (c) => {
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  return c.json(feedbackView(await conversationForLink(c, tenant.id, c.req.param("id"), c.req.query("token"))));
});

portalRoutes.post("/:tenantSlug/feedback/:id", async (c) => {
  const now = Date.now();
  const input = await body(c, FeedbackBody);
  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const row = await conversationForLink(c, tenant.id, c.req.param("id"), input.token);
  await throttleLink(c.env, "feedback", row.id, c.req.header("cf-connecting-ip"));

  // Rating a live conversation would corrupt the KPI (orbit-analytics samples
  // closed ones), and a second rating would let one link move the average.
  if (row.state !== "closed") throw conflict("this conversation is still open");
  if (row.csat !== null) throw conflict("this conversation has already been rated");

  const ctx = await portalCtx(c, tenant.id, now, "portal-feedback");
  await ctx.db
    .update(schema.orbitConversations)
    .set({ csat: input.rating, updatedAt: now })
    .where(and(eq(schema.orbitConversations.tenantId, tenant.id), eq(schema.orbitConversations.id, row.id)));
  await audit(ctx, {
    action: "orbit.conversation.rated",
    subjectRef: row.id,
    before: { csat: row.csat },
    after: { csat: input.rating, via: "portal" }
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.conversation.rated",
    subject: row.id,
    data: { csat: input.rating, scaleMax: CSAT_MAX, via: "portal" }
  });

  return c.json(feedbackView({ ...row, csat: input.rating }));
});

// The acquisition tracking pixel. Public by shape (it sits on /v1/portal/*),
// throttled by IP, and tenant-scoped by the slug segment — a visitor's browser
// posts impression/click/visit touches here so SIGNAL's funnel has something to
// measure. No session, no customer row: touches carry an anonId the page
// generated, and only become a named customer when a lead is captured.
// (engines/signal-attribution.ts is the writer this feeds.)
const TRACK_MAX = 60;
const TRACK_WINDOW_SEC = 60;

const TrackBody = z
  .object({
    touchType: z.enum(["impression", "click", "visit"]),
    channel: z.string().min(1).max(64),
    campaignId: z.string().max(64).optional(),
    creativeId: z.string().max(64).optional(),
    anonId: z.string().min(1).max(128)
  })
  .strict();

// docs/30 SIGNAL gap 2, ADR-0092: a lead or a sale reported from a partner's
// own site. A claim about money, so it must be signed with one of the tenant's
// webhook keys (engines/signal-track.ts); unsigned, /track stays anonymous.
const SignedTrackBody = z
  .object({
    touchType: z.enum(["lead", "bind"]),
    eventId: z.string().min(1).max(128),
    channel: z.string().min(1).max(64),
    campaignId: z.string().max(64).optional(),
    customerId: z.string().max(64).optional(),
    valueMinor: z.number().int().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional()
  })
  .strict();

portalRoutes.post("/:tenantSlug/track", async (c) => {
  const now = Date.now();
  const raw = await c.req.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
  const signature = c.req.header("x-lyra-signature");
  const input = signature ? null : parse(TrackBody, json);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) await throttle(c.env, `portal-track-ip:${ip}`, TRACK_MAX, TRACK_WINDOW_SEC);

  const database = rawDb(c.env);
  const tenant = await activeTenant(database, c.req.param("tenantSlug"));
  const ctx = await portalCtx(c, tenant.id, now, "portal-track");

  if (signature) {
    await verifyTrackSignature(ctx, { keyId: c.req.header("x-lyra-key-id") ?? "", timestamp: c.req.header("x-lyra-timestamp") ?? "", signature }, raw);
    const out = await recordSignedConversion(ctx, parse(SignedTrackBody, json));
    return c.json({ id: out.id, duplicate: out.duplicate }, out.duplicate ? 200 : 201);
  }
  const id = await recordTouch(ctx, {
    touchType: input!.touchType,
    channel: input!.channel,
    campaignId: input!.campaignId ?? null,
    creativeId: input!.creativeId ?? null,
    anonId: input!.anonId
  });
  return c.json({ id }, 201);
});
