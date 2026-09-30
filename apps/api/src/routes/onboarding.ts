import { Hono } from "hono";
import { simNow } from "../clock.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema, EntitlementsJson, PolicyJson } from "@lyra/db";
import {
  actorRef,
  audit,
  base32Encode,
  emit,
  notFound,
  require_,
  sha256Hex,
  withIdempotency,
  type Ctx
} from "@lyra/core";
import { body, InstantMs } from "../http.js";
import { ctxFor, db as rawDb, throttle } from "../auth.js";
import {
  STAGES,
  advancePartner,
  assertSubjectKind,
  blockingSteps,
  completeStep,
  draftAgreement,
  failStep,
  resumePartner,
  sendForSignature,
  signAgreement,
  startOnboarding,
  stepsFor,
  suspendPartner,
  terminatePartner,
  waiveStep,
  type Stage
} from "../engines/onboarding.js";
import type { App } from "../env.js";

// docs/05 §7. Onboarding a counterparty is the process generated CRUD must not
// touch: the steps are generated from a template, the stage is walked by the
// engine, and the two moves that matter — waiving a check, going live — are
// approvals. CRUD exposes the rows read-only (resources.ts); everything that
// changes them comes through here.

export const onboardingRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/* ------------------------------------------------------------------ steps */

const StartBody = z.object({
  subjectKind: z.enum(["partner", "channel", "staff"]),
  subjectRef: z.string().min(1),
  template: z.string().min(1),
  /** Role key -> user id, so generated steps land in a named queue. */
  owners: z.record(z.string(), z.string()).optional(),
  dueAt: InstantMs.optional()
});

onboardingRoutes.post("/steps", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:onboarding:write", { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, StartBody);
  const data = await withIdempotency(ctx, c.req.header("idempotency-key"), "core.onboarding.start", input, () =>
    startOnboarding(ctx, input)
  );
  return c.json({ data }, 201);
});

/** The checklist plus what it is currently blocking — one call, one screen. */
onboardingRoutes.get("/steps", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:onboarding:read", { tenantId: ctx.tenantId, module: "core" });
  const subjectKind = assertSubjectKind(c.req.query("subjectKind") ?? "partner");
  const subjectRef = c.req.query("subjectRef") ?? "";
  const data = await stepsFor(ctx, subjectKind, subjectRef);
  const stage = (c.req.query("stage") as Stage | undefined) ?? STAGES[STAGES.length - 1]!;
  return c.json({ data, blocking: blockingSteps(data, stage).map((s) => s.key) });
});

const CompleteBody = z.object({
  evidenceRef: z.string().min(1).optional(),
  note: z.string().max(2000).optional()
});

onboardingRoutes.post("/steps/:id/complete", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:onboarding:write", { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, CompleteBody);
  return c.json(await completeStep(ctx, c.req.param("id"), input));
});

const ReasonBody = z.object({ reason: z.string().min(3).max(2000) });

onboardingRoutes.post("/steps/:id/fail", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:onboarding:write", { tenantId: ctx.tenantId, module: "core" });
  const { reason } = await body(c, ReasonBody);
  return c.json(await failStep(ctx, c.req.param("id"), reason));
});

/**
 * Waiving is its own permission, not a stronger form of `write`. The person who
 * runs the checklist is not the person who gets to decide it does not apply.
 */
onboardingRoutes.post("/steps/:id/waive", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:onboarding:waive", { tenantId: ctx.tenantId, module: "core" });
  const { reason } = await body(c, ReasonBody);
  return c.json(await waiveStep(ctx, c.req.param("id"), reason));
});

/* --------------------------------------------------------- partner signup */

// docs/06 J-X3: "portal signup -> sandbox key -> mock quote in <30 min ->
// certification checklist -> live key." Everything else on this router runs
// behind a session that already picked a tenant; this is the one door with no
// session at all, so it is listed in mw.ts's PUBLIC set by exact path and
// builds its own Ctx the way the scheduled handler does for the same reason —
// there is no `Authenticated` for authenticate() to have produced.
//
// This creates only an `orbit_partners` row, never a `dist_channels` row: a
// channel is the specific commercial arrangement staff set up once a partner
// is actually trading (packages/db/src/schema/dist.ts), which is later than a
// prospect signing up for a sandbox key.
//
// It also bypasses the generated CRUD's `dist.partner_activate` approval gate
// (resources.ts) on purpose: that gate exists for `advancePartner` reaching
// `"live"` (engines/onboarding.ts), not for a prospect-stage row with a
// sandbox-only key. Approval still applies the moment this partner tries to
// go live.

const SignupBody = z
  .object({
    tenantSlug: z.string().min(1).max(64),
    companyName: z.string().min(2).max(200),
    contactEmail: z.string().email(),
    contactName: z.string().min(1).max(200).optional(),
    /**
     * Legal identity, optional because a prospect kicking the tyres of a
     * sandbox key has nothing to be paid yet — but kept when offered, because
     * the alternative is a payout ledger addressed to a trading name. Declared,
     * never proven: diligence is a step on the checklist, not a form field.
     */
    legalName: z.string().min(1).max(200).optional(),
    registrationNo: z.string().min(1).max(80).optional(),
    taxId: z.string().min(1).max(80).optional(),
    /** ISO 3166-1 alpha-2. */
    country: z.string().length(2).optional(),
    // Free text, not an enum: docs/21 domain-pack vocabulary is not fixed at
    // this layer, and the only real constraint (schema comment) is tenant-owned.
    kind: z.string().min(1).max(60)
  })
  .strict();

/**
 * Deliberately narrower than the `partner.developer` role: enough to read the
 * panel, shop the J-X3 "mock quote", and read the partner's own record back.
 * Never `dev:keys_test:issue` / `dev:keys_live:issue` — an anonymous signup
 * must not be handed the power to mint further keys; that is a staff upgrade.
 */
const SANDBOX_SCOPES = [
  "dev:sandbox:use",
  "orbit:partners:read",
  "dist:offerings:read",
  "dist:quote_requests:read",
  "dist:quote_requests:create"
];

const SIGNUP_SECRET_BYTES = 32;
const SIGNUP_WINDOW_SEC = 24 * 60 * 60;

onboardingRoutes.post("/partners/signup", async (c) => {
  const now = await simNow(c.env);
  const input = await body(c, SignupBody);
  const email = input.contactEmail.toLowerCase();
  // ponytail: one signup per email per day, reusing auth.ts's KV fixed-window
  // throttle under its own key namespace. No-ops without KV bound, same as the
  // login throttle it shares code with — upgrade path is a Durable Object.
  await throttle(c.env, `signup:${email}`, 1, SIGNUP_WINDOW_SEC);

  const database = rawDb(c.env);
  const tenantRows = await database
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, input.tenantSlug))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant || tenant.status !== "active") throw notFound("tenant");

  const ctx = await ctxFor(
    c.env,
    {
      tenantId: tenant.id,
      locale: "en",
      actor: { kind: "system", id: "partner-signup", tenantId: tenant.id, grants: [] },
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    },
    now,
    c.req.header("cf-connecting-ip"),
    c.req.header("user-agent")
  );

  const partnerRow = {
    id: newId("ptn", now),
    tenantId: tenant.id,
    name: input.companyName,
    kind: input.kind,
    apiKeyRef: null as string | null,
    revshareJson: null,
    sandboxFlag: true,
    status: "active",
    contactJson: JSON.stringify({ email, name: input.contactName ?? null }),
    stage: "prospect",
    ownerRef: null,
    legalName: input.legalName ?? null,
    registrationNo: input.registrationNo ?? null,
    taxId: input.taxId ?? null,
    country: input.country?.toUpperCase() ?? null,
    screeningId: null,
    riskRating: null,
    agreementId: null,
    payoutMethodRef: null,
    goLiveAt: null,
    suspendedAt: null,
    suspendedReason: null,
    terminatedAt: null,
    createdAt: now,
    updatedAt: now
  };
  await ctx.db.insert(schema.orbitPartners).values(partnerRow);
  await audit(ctx, { action: "orbit.partners.create", subjectRef: `partners:${partnerRow.id}`, after: partnerRow });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.partners.created",
    subject: partnerRow.id,
    data: { id: partnerRow.id, via: "signup" }
  });

  // Same certification checklist a staff-run onboarding gets (J-X3's
  // "certification checklist" step) — generated, not hand-typed here.
  await startOnboarding(ctx, {
    subjectKind: "partner",
    subjectRef: partnerRow.id,
    template: "partner.distribution"
  });

  // Key-mint logic mirrors routes/core.ts's POST /v1/core/api-keys exactly
  // (same secret size, base32 alphabet, prefix scheme and hash) rather than
  // reimplementing it — mode is hardcoded to "test", never taken from the
  // body, so this route can never mint a live key.
  const bytes = new Uint8Array(SIGNUP_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  const secret = base32Encode(bytes);
  const prefix = `qvk_test_${secret.slice(0, 8)}`;
  const plaintext = `qvk_test_${secret}`;
  const keyHash = await sha256Hex(plaintext);
  const keyRow = {
    id: newId("key", now),
    tenantId: tenant.id,
    name: `${input.companyName} sandbox`,
    prefix,
    keyHash,
    mode: "test" as const,
    scopesJson: JSON.stringify(SANDBOX_SCOPES),
    createdBy: actorRef(ctx),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now
  };
  await ctx.db.insert(schema.apiKeys).values(keyRow);
  // `after` holds the hash, never the plaintext — same rule as the staff mint.
  await audit(ctx, { action: "core.api-keys.create", subjectRef: `api-keys:${keyRow.id}`, after: keyRow });

  await ctx.db
    .update(schema.orbitPartners)
    .set({ apiKeyRef: keyRow.id, updatedAt: now })
    .where(eq(schema.orbitPartners.id, partnerRow.id));

  return c.json(
    {
      id: partnerRow.id,
      name: partnerRow.name,
      kind: partnerRow.kind,
      stage: partnerRow.stage,
      sandboxFlag: partnerRow.sandboxFlag,
      createdAt: partnerRow.createdAt,
      sandboxKeyId: keyRow.id,
      sandboxKey: plaintext
    },
    201,
    { location: `/v1/orbit/partners/${partnerRow.id}` }
  );
});

/* --------------------------------------------------------------- partners */

onboardingRoutes.post("/partners/:id/advance", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:partners:update", { tenantId: ctx.tenantId, module: "orbit" });
  const partnerId = c.req.param("id");
  return c.json(
    await withIdempotency(
      ctx,
      c.req.header("idempotency-key"),
      "core.onboarding.advance",
      { partnerId },
      () => advancePartner(ctx, partnerId)
    )
  );
});

onboardingRoutes.post("/partners/:id/suspend", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:partners:update", { tenantId: ctx.tenantId, module: "orbit" });
  const { reason } = await body(c, ReasonBody);
  await suspendPartner(ctx, c.req.param("id"), reason);
  return c.json({ status: "suspended" });
});

onboardingRoutes.post("/partners/:id/resume", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:partners:update", { tenantId: ctx.tenantId, module: "orbit" });
  await resumePartner(ctx, c.req.param("id"));
  return c.json({ status: "resumed" });
});

onboardingRoutes.post("/partners/:id/terminate", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:partners:update", { tenantId: ctx.tenantId, module: "orbit" });
  const { reason } = await body(c, ReasonBody);
  await terminatePartner(ctx, c.req.param("id"), reason);
  return c.json({ status: "terminated" });
});

/* ------------------------------------------------------------- agreements */

const DraftBody = z.object({
  partnerId: z.string().min(1),
  kind: z.string().min(1).optional(),
  /** docs/05: settlement, clawbackDays, exclusivity, territories, notice. */
  terms: z.record(z.string(), z.unknown()),
  documentFileId: z.string().optional(),
  effectiveFrom: InstantMs.optional()
});

onboardingRoutes.post("/agreements", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:agreements:write", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, DraftBody);
  const row = await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.agreement.draft", input, () =>
    draftAgreement(ctx, input)
  );
  return c.json(row, 201);
});

onboardingRoutes.post("/agreements/:id/send", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:agreements:write", { tenantId: ctx.tenantId, module: "dist" });
  return c.json(await sendForSignature(ctx, c.req.param("id")));
});

const SignBody = z.object({
  signedByPartnerName: z.string().min(2).max(200),
  effectiveFrom: InstantMs.optional()
});

/**
 * The route guard is `write`, not `sign`: the drafter asks, and the
 * `dist.agreement_sign` approval — dual control, decided by `dist:agreements:sign`
 * — is what actually binds the tenant. Guarding on `sign` here would let the
 * signatory both raise and clear their own signature.
 */
onboardingRoutes.post("/agreements/:id/sign", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:agreements:write", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, SignBody);
  const agreementId = c.req.param("id");
  return c.json(
    await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.agreement.sign", { agreementId, ...input }, () =>
      signAgreement(ctx, agreementId, input)
    )
  );
});
