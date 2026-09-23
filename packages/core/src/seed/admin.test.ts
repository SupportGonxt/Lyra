import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@lyra/db";
import { seed, type SeedResult } from "../seed.js";
import { sha256Hex } from "../crypto.js";
import { DAY, HOUR, MINUTE } from "./context.js";
import type { CoreDb } from "../context.js";

// Mirrors admin.ts's own (unexported) helper exactly, so we can recompute the
// digests it wrote and assert on the real value rather than "some string".
async function digest(label: string): Promise<string> {
  return sha256Hex(`lyra.seed.admin:${label}`);
}

// evt_ ids are the digest, prefixed and truncated — recomputed the same way so
// a mutation to either the prefix or the slice length is caught by a miss.
async function evtId(label: string): Promise<string> {
  return `evt_${await digest(label)}`.slice(0, 30);
}

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Same clock seed.ts defaults to (T0) — pinned explicitly so every arithmetic
// offset below (now - 3*DAY, now + 6*HOUR, ...) is a concrete, checkable value.
const NOW = Date.UTC(2026, 0, 6, 8, 0, 0);
const ISSUED_AT = NOW + 2 * DAY;

// `approvals`, `aiRuns` and `aiAuditLog` are shared tables — other seed modules
// (axis.ts, onboarding.ts, signal.ts, orbit.ts) also write rows for the same
// tenant. Scope every query in this file to admin.ts's own literal keys so a
// sibling module's fixtures never leak into a count or a `.find`.
const ADMIN_APPROVAL_KEYS = [
  "axis.bind",
  "axis.endorse",
  "axis.price_match",
  "ledger.partner_settlement",
  "core.unmasked_export",
  "ai.budget_raise",
  "dist.rate_change",
  "compliance.erasure"
];
const ADMIN_RUN_PURPOSES = [
  "quote.compare",
  "renewal.outreach_draft",
  "creative.variant",
  "market.scan",
  "exec.briefing",
  "recon.match",
  "output.review"
];
const ADMIN_AUDIT_PURPOSES = [
  "quote.compare",
  "renewal.outreach_draft",
  "creative.variant",
  "market.scan",
  "exec.briefing",
  "recon.match",
  "output.review",
  "knowledge.embed"
];

let client: Client;
let db: CoreDb;
let result: SeedResult;

let tenantId: string;
let customerId: string;
let customerRef: string;
let caseId: string;
let caseRef: string;
let policyId: string;
let policyRef: string;
let renewalPolicyId: string;
let renewalRef: string;
let quoteRequestId: string;
let quoteRef: string;
let teamMotor: string;
let teamRetention: string;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;
  result = await seed(db, { password: "gonxt-test-password" });
  tenantId = result.tenantId;

  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.tenantId, tenantId));
  customerId = customer!.id;
  customerRef = `customer:${customerId}`;

  const [axisCase] = await db.select().from(schema.axisCases).where(eq(schema.axisCases.ref, "GNX-2601-0001"));
  caseId = axisCase!.id;
  caseRef = `cases:${caseId}`;

  const [policy] = await db
    .select()
    .from(schema.axisPolicies)
    .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2601-778201"));
  policyId = policy!.id;
  policyRef = `policies:${policyId}`;

  const [renewal] = await db
    .select()
    .from(schema.axisPolicies)
    .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118"));
  renewalPolicyId = renewal!.id;
  renewalRef = `policies:${renewalPolicyId}`;

  const [quoteRequest] = await db
    .select()
    .from(schema.distQuoteRequests)
    .where(eq(schema.distQuoteRequests.tenantId, tenantId));
  quoteRequestId = quoteRequest!.id;
  quoteRef = `quote-requests:${quoteRequestId}`;

  const [motor] = await db.select().from(schema.teams).where(eq(schema.teams.name, "Motor desk"));
  teamMotor = motor!.id;
  const [retention] = await db.select().from(schema.teams).where(eq(schema.teams.name, "Retention"));
  teamRetention = retention!.id;
});

describe("seedAdmin: files", () => {
  it("writes the 8-row document register with exact literal fields", async () => {
    const rows = await db.select().from(schema.files).where(eq(schema.files.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const front = rows.find((r) => r.r2Key === `t/${tenantId}/kyc/emirates-id-front.jpg`)!;
    expect(front).toMatchObject({
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.eid.front"),
      sizeBytes: 412_884,
      contentType: "image/jpeg",
      piiLevel: "high",
      createdAt: NOW - 3 * DAY
    });

    const licence = rows.find((r) => r.r2Key === `t/${tenantId}/kyc/driving-licence.jpg`)!;
    expect(licence).toMatchObject({
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.licence"),
      sizeBytes: 288_140,
      contentType: "image/jpeg",
      piiLevel: "high",
      createdAt: NOW - 3 * DAY
    });

    const comparison = rows.find((r) => r.r2Key === `t/${tenantId}/quotes/comparison-GNX-2601-0001.pdf`)!;
    expect(comparison).toMatchObject({
      kind: "comparison",
      subjectRef: quoteRef,
      sha256: await digest("file.comparison"),
      sizeBytes: 96_512,
      contentType: "application/pdf",
      piiLevel: "low",
      createdAt: NOW + MINUTE
    });

    const schedule = rows.find(
      (r) => r.r2Key === `t/${tenantId}/policies/CDR-MOT-2601-778201-schedule.pdf`
    )!;
    expect(schedule).toMatchObject({
      kind: "policy_schedule",
      subjectRef: policyRef,
      sha256: await digest("file.schedule"),
      sizeBytes: 154_003,
      contentType: "application/pdf",
      piiLevel: "low",
      createdAt: ISSUED_AT
    });

    const vehicle = rows.find(
      (r) => r.r2Key === `t/${tenantId}/vehicles/land-cruiser-2023-front.jpg`
    )!;
    expect(vehicle).toMatchObject({
      kind: "vehicle_photo",
      subjectRef: quoteRef,
      sha256: await digest("file.vehicle"),
      sizeBytes: 1_244_902,
      contentType: "image/jpeg",
      piiLevel: "low",
      createdAt: NOW - 2 * DAY
    });

    const wording = rows.find(
      (r) => r.r2Key === `t/${tenantId}/wordings/cedar-motor-comprehensive-v4.pdf`
    )!;
    expect(wording).toMatchObject({
      kind: "policy_wording",
      subjectRef: null,
      sha256: await digest("file.wording.cedar"),
      sizeBytes: 742_118,
      contentType: "application/pdf",
      piiLevel: "none",
      createdAt: NOW - 60 * DAY
    });

    const brand = rows.find((r) => r.r2Key === `t/${tenantId}/brand/gonxt-mark.svg`)!;
    expect(brand).toMatchObject({
      kind: "brand_asset",
      subjectRef: null,
      sha256: await digest("file.brand"),
      sizeBytes: 4_206,
      contentType: "image/svg+xml",
      piiLevel: "none",
      createdAt: NOW - 90 * DAY
    });

    const superseded = rows.find(
      (r) => r.r2Key === `t/${tenantId}/kyc/emirates-id-superseded.jpg`
    )!;
    expect(superseded).toMatchObject({
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.eid.superseded"),
      sizeBytes: 388_201,
      contentType: "image/jpeg",
      piiLevel: "high",
      createdAt: NOW - 400 * DAY,
      deletedAt: NOW - 30 * DAY
    });
  });
});

describe("seedAdmin: approvals", () => {
  it("writes the 8-row approval queue spanning every decision", async () => {
    const rows = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), inArray(schema.approvals.policyKey, ADMIN_APPROVAL_KEYS)));
    expect(rows).toHaveLength(8);

    const bind = rows.find((r) => r.policyKey === "axis.bind")!;
    expect(bind).toMatchObject({
      subjectRef: caseRef,
      module: "axis",
      requestedBy: result.users["axis.agent"],
      requestedAt: ISSUED_AT - HOUR,
      decidedBy: result.users["axis.lead"],
      decision: "approved",
      reason: "Cedar's terms match the comparison the customer was shown.",
      decidedAt: ISSUED_AT - 20 * MINUTE
    });
    expect(JSON.parse(bind.contextJson!)).toEqual({ amountMinor: 412_500, currency: "AED", dualControl: false });

    const endorse = rows.find((r) => r.policyKey === "axis.endorse")!;
    expect(endorse).toMatchObject({
      subjectRef: policyRef,
      module: "axis",
      requestedBy: result.users["axis.agent"],
      requestedAt: NOW + 6 * HOUR,
      decision: "pending",
      decidedBy: null,
      decidedAt: null
    });
    expect(JSON.parse(endorse.contextJson!)).toEqual({
      amountMinor: 31_000,
      currency: "AED",
      dualControl: true,
      change: "Add a named second driver mid-term"
    });

    const priceMatch = rows.find((r) => r.policyKey === "axis.price_match")!;
    expect(priceMatch).toMatchObject({
      subjectRef: `quotes:${quoteRequestId}`,
      module: "axis",
      requestedAt: NOW - 1 * DAY,
      decision: "rejected",
      reason: "The competitor quote excludes agency repair, so the two prices are not comparable.",
      decidedAt: NOW - 22 * HOUR
    });
    expect(JSON.parse(priceMatch.contextJson!)).toEqual({
      amountMinor: 42_000,
      currency: "AED",
      dualControl: false
    });

    const settlement = rows.find((r) => r.policyKey === "ledger.partner_settlement")!;
    expect(settlement).toMatchObject({
      subjectRef: "settlements:cedar-2512",
      module: "ledger",
      requestedBy: result.users["finance.controller"],
      decision: "approved",
      decidedBy: result.users["tenant.admin"]
    });
    expect(JSON.parse(settlement.contextJson!)).toEqual({
      amountMinor: 1_284_000,
      currency: "AED",
      dualControl: true
    });

    const unmaskedExport = rows.find((r) => r.policyKey === "core.unmasked_export")!;
    expect(unmaskedExport).toMatchObject({
      subjectRef: "analytics-exports:motor-book-q4",
      module: "core",
      requestedBy: result.users["north.analyst"],
      decision: "rejected",
      decidedBy: result.users["tenant.compliance"],
      decidedAt: NOW - 2 * DAY + 3 * HOUR
    });
    expect(JSON.parse(unmaskedExport.contextJson!)).toEqual({ dualControl: true, rows: 18_402 });

    const budgetRaise = rows.find((r) => r.policyKey === "ai.budget_raise")!;
    expect(budgetRaise).toMatchObject({
      subjectRef: "ai_budget:signal",
      module: "ai",
      decision: "pending"
    });
    expect(JSON.parse(budgetRaise.contextJson!)).toEqual({
      dualControl: false,
      fromCostMicro: 8_000_000,
      toCostMicro: 12_000_000
    });

    const rateChange = rows.find((r) => r.policyKey === "dist.rate_change")!;
    expect(rateChange).toMatchObject({
      subjectRef: "dist-rates:cedar-motor-plus",
      module: "core",
      requestedBy: result.users["orbit.partners"],
      decision: "approved"
    });
    expect(JSON.parse(rateChange.contextJson!)).toEqual({ dualControl: true, deltaBps: 250 });

    const erasure = rows.find((r) => r.policyKey === "compliance.erasure")!;
    expect(erasure).toMatchObject({
      subjectRef: `compliance-erasures:${customerId}-2512`,
      module: "core",
      requestedBy: result.users["tenant.compliance"],
      decision: "approved",
      decidedAt: NOW - 31 * DAY
    });
    expect(JSON.parse(erasure.contextJson!)).toEqual({ dualControl: true, files: 1 });
  });
});

describe("seedAdmin: apiKeys", () => {
  it("writes the 6-row credential register including a revoked and an expired key", async () => {
    const rows = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.tenantId, tenantId));
    expect(rows).toHaveLength(6);

    const alpha = rows.find((r) => r.prefix === "qvk_live_a1b2c3d4")!;
    expect(alpha).toMatchObject({
      name: "Alpha Brokers — quote intake",
      keyHash: await digest("key.alpha"),
      mode: "live",
      createdBy: result.users["orbit.partners"],
      lastUsedAt: NOW - 40 * MINUTE,
      createdAt: NOW - 120 * DAY,
      revokedAt: null,
      expiresAt: null
    });
    expect(JSON.parse(alpha.scopesJson!)).toEqual(["dist:quotes:create", "dist:quotes:read", "core:customers:read"]);

    const meridian = rows.find((r) => r.prefix === "qvk_live_e5f6g7h8")!;
    expect(meridian).toMatchObject({
      name: "Meridian Bank — embedded motor journey",
      keyHash: await digest("key.meridian"),
      mode: "live",
      expiresAt: NOW + 180 * DAY
    });

    const sandbox = rows.find((r) => r.prefix === "qvk_test_j9k0l1m2")!;
    expect(sandbox).toMatchObject({
      name: "Sandbox — partner onboarding tests",
      mode: "test",
      createdBy: result.users["dev.admin"]
    });

    const leaked = rows.find((r) => r.prefix === "qvk_live_n3p4q5r6")!;
    expect(leaked).toMatchObject({
      name: "Alpha Brokers — legacy intake (leaked)",
      mode: "live",
      lastUsedAt: NOW - 14 * DAY,
      revokedAt: NOW - 14 * DAY + 30 * MINUTE,
      createdAt: NOW - 300 * DAY
    });
    expect(JSON.parse(leaked.scopesJson!)).toEqual(["dist:quotes:create"]);

    const migration = rows.find((r) => r.prefix === "qvk_test_s7t8u9v0")!;
    expect(migration).toMatchObject({
      name: "Migration import — 2025 book",
      mode: "test",
      expiresAt: NOW - 180 * DAY,
      createdAt: NOW - 210 * DAY
    });

    const cedar = rows.find((r) => r.prefix === "qvk_live_w1x2y3z4")!;
    expect(cedar).toMatchObject({
      name: "Cedar Insurance — settlement statement pull",
      mode: "live",
      createdBy: result.users["finance.controller"],
      createdAt: NOW - 45 * DAY
    });
    expect(JSON.parse(cedar.scopesJson!)).toEqual(["ledger:settlements:read", "dist:commissions:read"]);
  });
});

describe("seedAdmin: identityProviders", () => {
  it("writes the 4-row IdP register, one disabled", async () => {
    const rows = await db
      .select()
      .from(schema.identityProviders)
      .where(eq(schema.identityProviders.tenantId, tenantId));
    expect(rows).toHaveLength(4);

    const gonxt = rows.find((r) => r.emailDomain === "gonxt.ae")!;
    expect(gonxt).toMatchObject({
      kind: "oidc",
      name: "GONXT staff directory",
      clientId: "gonxt-lyra-web",
      clientSecretRef: "IDP_GONXT_CLIENT_SECRET",
      defaultRoleKey: "axis.agent",
      enabled: true,
      mfaAsserted: true,
      createdAt: NOW - 200 * DAY,
      updatedAt: NOW - 20 * DAY
    });

    const meridian = rows.find((r) => r.emailDomain === "meridianbank.ae")!;
    expect(meridian).toMatchObject({
      kind: "oidc",
      name: "Meridian Bank partner staff",
      clientId: "meridian-lyra",
      defaultRoleKey: "orbit.partners",
      enabled: true,
      mfaAsserted: true
    });

    const alpha = rows.find((r) => r.emailDomain === "alphabrokers.ae")!;
    expect(alpha).toMatchObject({
      kind: "saml",
      name: "Alpha Brokers ADFS",
      issuer: "urn:alphabrokers:adfs",
      ssoUrl: "https://adfs.alphabrokers.ae/adfs/ls/",
      defaultRoleKey: "axis.agent",
      enabled: true,
      mfaAsserted: false
    });

    const cedar = rows.find((r) => r.emailDomain === "cedarinsurance.ae")!;
    expect(cedar).toMatchObject({
      kind: "oidc",
      name: "Cedar Insurance underwriters",
      clientId: "cedar-lyra",
      defaultRoleKey: "orbit.partners",
      enabled: false,
      mfaAsserted: false,
      createdAt: NOW - 9 * DAY,
      updatedAt: NOW - 9 * DAY
    });
  });
});

describe("seedAdmin: webhooks + webhookDeliveries", () => {
  it("writes the 5-row webhook register, one paused", async () => {
    const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    expect(rows).toHaveLength(5);

    const partner = rows.find((r) => r.url === "https://hooks.alphabrokers.ae/lyra/policy-events")!;
    expect(partner).toMatchObject({
      secret: "whsec_seed_alpha_not_a_real_secret",
      status: "active",
      createdAt: NOW - 120 * DAY
    });
    expect(JSON.parse(partner.eventTypesJson!)).toEqual([
      "axis.policy.issued",
      "axis.policy.cancelled",
      "orbit.renewal.due"
    ]);

    const cedar = rows.find((r) => r.url === "https://api.cedarinsurance.ae/partners/gonxt/events")!;
    expect(cedar).toMatchObject({ secret: "whsec_seed_cedar_not_a_real_secret", status: "active" });
    expect(JSON.parse(cedar.eventTypesJson!)).toEqual(["axis.policy.issued", "axis.policy.endorsed"]);

    const bank = rows.find((r) => r.url === "https://embed.meridianbank.ae/lyra/callbacks")!;
    expect(bank).toMatchObject({ secret: "whsec_seed_meridian_not_a_real_secret", status: "active" });

    const finance = rows.find((r) => r.url === "https://ops.gonxt.ae/webhooks/ledger")!;
    expect(finance).toMatchObject({ secret: "whsec_seed_ops_not_a_real_secret", status: "active" });

    const legacy = rows.find((r) => r.url === "https://legacy.alphabrokers.ae/hooks/quotes")!;
    expect(legacy).toMatchObject({
      secret: "whsec_seed_legacy_not_a_real_secret",
      status: "paused",
      createdAt: NOW - 260 * DAY
    });
    expect(JSON.parse(legacy.eventTypesJson!)).toEqual(["dist.quote_request.fanned_out"]);
  });

  it("writes the 8-row delivery attempt log with correctly derived event ids", async () => {
    const webhooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    const idOf = (url: string) => webhooks.find((w) => w.url === url)!.id;
    const whkPartner = idOf("https://hooks.alphabrokers.ae/lyra/policy-events");
    const whkCedar = idOf("https://api.cedarinsurance.ae/partners/gonxt/events");
    const whkBank = idOf("https://embed.meridianbank.ae/lyra/callbacks");
    const whkFinance = idOf("https://ops.gonxt.ae/webhooks/ledger");
    const whkLegacy = idOf("https://legacy.alphabrokers.ae/hooks/quotes");

    const rows = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const [
      evtBound,
      evtIssued,
      evtReady,
      evtSettlement,
      evtLegacy1,
      evtLegacy2,
      evtRenewal,
      evtBoundBank
    ] = await Promise.all([
      evtId("evt.bound"),
      evtId("evt.issued"),
      evtId("evt.ready"),
      evtId("evt.settlement"),
      evtId("evt.legacy.1"),
      evtId("evt.legacy.2"),
      evtId("evt.renewal"),
      evtId("evt.bound.bank")
    ]);

    const bound = rows.find((r) => r.eventId === evtBound)!;
    expect(bound).toMatchObject({
      webhookId: whkCedar,
      status: "delivered",
      responseCode: 200,
      attempts: 1,
      createdAt: ISSUED_AT
    });

    const issued = rows.find((r) => r.eventId === evtIssued)!;
    expect(issued).toMatchObject({
      webhookId: whkPartner,
      status: "delivered",
      responseCode: 202,
      attempts: 1,
      createdAt: ISSUED_AT + MINUTE
    });

    const ready = rows.find((r) => r.eventId === evtReady)!;
    expect(ready).toMatchObject({
      webhookId: whkBank,
      status: "delivered",
      responseCode: 200,
      attempts: 2,
      createdAt: NOW - 20 * MINUTE
    });

    const settlement = rows.find((r) => r.eventId === evtSettlement)!;
    expect(settlement).toMatchObject({
      webhookId: whkFinance,
      status: "failed",
      responseCode: 502,
      attempts: 3,
      nextAttemptAt: NOW + 8 * MINUTE,
      error: "Bad gateway from ops.gonxt.ae after 3 attempts",
      createdAt: NOW - 35 * MINUTE
    });

    const legacy1 = rows.find((r) => r.eventId === evtLegacy1)!;
    expect(legacy1).toMatchObject({
      webhookId: whkLegacy,
      status: "dead",
      responseCode: 410,
      attempts: 8,
      error: "Endpoint returned 410 Gone; retries exhausted",
      createdAt: NOW - 6 * DAY
    });

    const legacy2 = rows.find((r) => r.eventId === evtLegacy2)!;
    expect(legacy2).toMatchObject({
      webhookId: whkLegacy,
      status: "dead",
      responseCode: 410,
      attempts: 8,
      createdAt: NOW - 5 * DAY
    });

    const renewal = rows.find((r) => r.eventId === evtRenewal)!;
    expect(renewal).toMatchObject({
      webhookId: whkPartner,
      status: "pending",
      responseCode: null,
      attempts: 0,
      nextAttemptAt: NOW + 2 * MINUTE,
      createdAt: NOW
    });

    const boundBank = rows.find((r) => r.eventId === evtBoundBank)!;
    expect(boundBank).toMatchObject({
      webhookId: whkBank,
      status: "delivered",
      responseCode: 200,
      attempts: 1,
      createdAt: NOW - 2 * DAY
    });
  });
});

describe("seedAdmin: notifications", () => {
  it("writes the 8-row inbox with a mix of read and unread rows", async () => {
    const webhooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    const whkFinance = webhooks.find((w) => w.url === "https://ops.gonxt.ae/webhooks/ledger")!.id;
    const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.tenantId, tenantId));
    const endorseApprovalId = approvals.find((a) => a.policyKey === "axis.endorse")!.id;

    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const pendingApproval = rows.find((r) => r.titleKey === "axis.endorsement.approval_pending")!;
    expect(pendingApproval).toMatchObject({
      userId: result.users["axis.lead"],
      kind: "approval",
      subjectRef: `approvals:${endorseApprovalId}`,
      readAt: null,
      createdAt: NOW + 6 * HOUR
    });
    expect(JSON.parse(pendingApproval.paramsJson!)).toEqual({
      policyNo: "CDR-MOT-2601-778201",
      customer: "Rania Haddad"
    });

    const priceMatchRejected = rows.find((r) => r.titleKey === "axis.price_match.rejected")!;
    expect(priceMatchRejected).toMatchObject({
      userId: result.users["axis.agent"],
      kind: "alert",
      subjectRef: caseRef,
      readAt: NOW - 20 * HOUR,
      createdAt: NOW - 22 * HOUR
    });
    expect(JSON.parse(priceMatchRejected.paramsJson!)).toEqual({ caseRef: "GNX-2601-0001" });

    const renewalDue = rows.find((r) => r.titleKey === "orbit.renewal.due")!;
    expect(renewalDue).toMatchObject({
      userId: result.users["orbit.retention"],
      kind: "task",
      subjectRef: renewalRef,
      createdAt: NOW - 4 * HOUR
    });
    expect(JSON.parse(renewalDue.paramsJson!)).toEqual({ policyNo: "CDR-MOT-2501-664118", daysToExpiry: 20 });

    const deliveryFailed = rows.find((r) => r.titleKey === "ledger.webhook.delivery_failed")!;
    expect(deliveryFailed).toMatchObject({
      userId: result.users["finance.controller"],
      kind: "alert",
      subjectRef: `webhooks:${whkFinance}`,
      createdAt: NOW - 30 * MINUTE
    });
    expect(JSON.parse(deliveryFailed.paramsJson!)).toEqual({
      url: "https://ops.gonxt.ae/webhooks/ledger",
      attempts: 3
    });

    const guardrailBlocked = rows.find((r) => r.titleKey === "ai.guardrail.blocked")!;
    expect(guardrailBlocked).toMatchObject({
      userId: result.users["tenant.compliance"],
      kind: "alert",
      subjectRef: "campaigns:motor-jan",
      createdAt: NOW - 2 * HOUR
    });
    expect(JSON.parse(guardrailBlocked.paramsJson!)).toEqual({ rule: "regulated_claim", agentKey: "creative" });

    const briefingReady = rows.find((r) => r.titleKey === "north.briefing.ready")!;
    expect(briefingReady).toMatchObject({
      userId: result.users["north.exec"],
      kind: "report",
      subjectRef: "north-briefings:2026-01-04",
      readAt: NOW - 3 * DAY + HOUR,
      createdAt: NOW - 3 * DAY
    });
    expect(JSON.parse(briefingReady.paramsJson!)).toEqual({ period: "2026-01-04" });

    const keyRevoked = rows.find((r) => r.titleKey === "core.api_key.revoked")!;
    expect(keyRevoked).toMatchObject({
      userId: result.users["tenant.admin"],
      kind: "alert",
      readAt: NOW - 13 * DAY,
      createdAt: NOW - 14 * DAY
    });
    // `id("key", now + 23)` mints a fresh random ULID at this call site — it does
    // not reproduce the actual apiKeys row's own id (a separate `id()` call with
    // the same seedTime does not yield the same value). Assert the prefix only.
    expect(keyRevoked.subjectRef).toMatch(/^api-keys:key_/);
    expect(JSON.parse(keyRevoked.paramsJson!)).toEqual({
      prefix: "qvk_live_n3p4q5r6",
      reason: "exposed_in_public_repo"
    });

    const budgetRaise = rows.find((r) => r.titleKey === "ai.budget.raise_requested")!;
    expect(budgetRaise).toMatchObject({
      userId: result.users["signal.lead"],
      kind: "approval",
      subjectRef: "ai_budget:signal",
      createdAt: NOW - 6 * HOUR
    });
    expect(JSON.parse(budgetRaise.paramsJson!)).toEqual({ module: "signal", toCostMicro: 12_000_000 });
  });
});

describe("seedAdmin: mandates", () => {
  it("writes the 5-row H1 mandate register spanning active/expired/revoked", async () => {
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.tenantId, tenantId));
    expect(rows).toHaveLength(5);

    const quoting = rows.find((r) => r.principalRef === customerRef)!;
    expect(quoting).toMatchObject({
      agentIdentity: "agent:quoting",
      spendCapMinor: 500_000,
      currency: "AED",
      verificationRef: "uae-pass:rania.haddad",
      expiry: NOW + 90 * DAY,
      status: "active",
      createdAt: NOW - 3 * DAY
    });
    expect(JSON.parse(quoting.scopeJson!)).toEqual({ modules: ["dist"], productLines: ["motor"] });

    const renewal = rows.find((r) => r.principalRef === `user:${result.users["orbit.retention"]}`)!;
    expect(renewal).toMatchObject({
      agentIdentity: "agent:renewal",
      spendCapMinor: 0,
      currency: "AED",
      verificationRef: null,
      expiry: NOW + 180 * DAY,
      status: "active",
      createdAt: NOW - 30 * DAY
    });
    expect(JSON.parse(renewal.scopeJson!)).toEqual({ modules: ["orbit"], teamIds: [teamRetention] });

    const meridian = rows.find((r) => r.principalRef === `provider:${result.providers.meridian}`)!;
    expect(meridian).toMatchObject({
      agentIdentity: "agent:quoting",
      spendCapMinor: 2_500_000,
      verificationRef: "contract:meridian-embed-2026",
      expiry: NOW + 300 * DAY,
      status: "active",
      createdAt: NOW - 70 * DAY
    });
    expect(JSON.parse(meridian.scopeJson!)).toEqual({ modules: ["dist"], productLines: ["motor", "travel"] });

    const creative = rows.find((r) => r.principalRef === `user:${result.users["signal.lead"]}`)!;
    expect(creative).toMatchObject({
      agentIdentity: "agent:creative",
      spendCapMinor: 1_000_000,
      expiry: NOW - 10 * DAY,
      status: "expired",
      createdAt: NOW - 200 * DAY
    });
    expect(JSON.parse(creative.scopeJson!)).toEqual({ modules: ["signal"] });

    const copilot = rows.find((r) => r.principalRef === `user:${result.users["orbit.partners"]}`)!;
    expect(copilot).toMatchObject({
      agentIdentity: "agent:copilot",
      spendCapMinor: 250_000,
      expiry: NOW + 45 * DAY,
      status: "revoked",
      createdAt: NOW - 100 * DAY
    });
    expect(JSON.parse(copilot.scopeJson!)).toEqual({ modules: ["axis"], teamIds: [teamMotor] });
  });
});

describe("seedAdmin: identityVerifications", () => {
  it("writes the 6-row H5 verification register across evidence levels", async () => {
    const rows = await db
      .select()
      .from(schema.identityVerifications)
      .where(eq(schema.identityVerifications.tenantId, tenantId));
    expect(rows).toHaveLength(6);

    const uaePass = rows.find((r) => r.method === "uae_pass")!;
    expect(uaePass).toMatchObject({
      subjectRef: customerRef,
      evidenceLevel: "high",
      providerRef: "uae-pass:2601-88412",
      expiry: NOW + 365 * DAY,
      createdAt: NOW - 3 * DAY
    });

    const docScan = rows.find((r) => r.method === "document_scan")!;
    expect(docScan).toMatchObject({
      subjectRef: customerRef,
      evidenceLevel: "substantial",
      providerRef: "kyc-vendor:scan-77120",
      expiry: NOW + 700 * DAY
    });

    const otp = rows.find((r) => r.method === "otp_sms")!;
    expect(otp).toMatchObject({
      subjectRef: customerRef,
      evidenceLevel: "low",
      providerRef: "+9715*****567",
      expiry: NOW + 30 * DAY,
      createdAt: NOW - 4 * DAY
    });

    const agentMfa = rows.find(
      (r) => r.method === "staff_mfa" && r.subjectRef === `user:${result.users["axis.agent"]}`
    )!;
    expect(agentMfa).toMatchObject({ evidenceLevel: "substantial", providerRef: "idp:gonxt.ae", expiry: NOW + 90 * DAY });

    const controllerMfa = rows.find(
      (r) => r.method === "staff_mfa" && r.subjectRef === `user:${result.users["finance.controller"]}`
    )!;
    expect(controllerMfa).toMatchObject({ evidenceLevel: "high", providerRef: "idp:gonxt.ae" });

    const cedarLicence = rows.find((r) => r.method === "trade_licence")!;
    expect(cedarLicence).toMatchObject({
      subjectRef: `provider:${result.providers.cedar}`,
      evidenceLevel: "substantial",
      providerRef: "dubai-ded:CN-1188402",
      expiry: NOW - 15 * DAY,
      createdAt: NOW - 380 * DAY
    });
  });
});

describe("seedAdmin: memories", () => {
  it("writes the 7-row H11 memory register with purpose flags", async () => {
    const rows = await db.select().from(schema.memories).where(eq(schema.memories.tenantId, tenantId));
    expect(rows).toHaveLength(7);

    const channelPref = rows.find((r) => r.kind === "preference" && JSON.parse(r.contentJson!).preferredChannel)!;
    expect(channelPref).toMatchObject({ subjectRef: customerRef, provenance: "stated_by_customer", sensitivity: "low" });
    expect(JSON.parse(channelPref.contentJson!)).toEqual({
      preferredChannel: "whatsapp",
      contactWindow: "18:00-21:00 GST"
    });
    expect(JSON.parse(channelPref.purposesJson!)).toEqual({ marketing: false, profiling: false, dataSharing: false });
    expect(channelPref.expiry).toBe(NOW + 730 * DAY);

    const languagePref = rows.find((r) => r.kind === "preference" && JSON.parse(r.contentJson!).language)!;
    expect(JSON.parse(languagePref.contentJson!)).toEqual({ language: "en", correspondence: "en", callsIn: "ar" });
    expect(languagePref.expiry).toBeNull();

    const context = rows.find((r) => r.kind === "context")!;
    expect(context).toMatchObject({ subjectRef: customerRef, provenance: "agent_note", sensitivity: "medium" });
    expect(JSON.parse(context.contentJson!)).toEqual({
      household: "villa, Al Barsha",
      vehicles: 1,
      note: "Mentioned a second car arriving in spring."
    });
    expect(JSON.parse(context.purposesJson!)).toEqual({ marketing: true, profiling: true, dataSharing: false });

    const objection = rows.find((r) => r.kind === "objection")!;
    expect(JSON.parse(objection.contentJson!)).toEqual({
      objection: "excess_too_high",
      resolvedBy: "agency_repair_explained"
    });
    expect(objection.provenance).toBe("conversation_summary");

    const partnerBehaviour = rows.find((r) => r.kind === "partner_behaviour")!;
    expect(partnerBehaviour.subjectRef).toBe(`provider:${result.providers.cedar}`);
    expect(JSON.parse(partnerBehaviour.contentJson!)).toEqual({ medianQuoteLatencyMs: 1_250, declineRate: 0.07 });

    const workingStyle = rows.find((r) => r.kind === "working_style")!;
    expect(workingStyle.subjectRef).toBe(`user:${result.users["axis.agent"]}`);
    expect(JSON.parse(workingStyle.contentJson!)).toEqual({
      prefersCompactTables: true,
      dismissesGhostText: "in_notes_field"
    });

    const claimHistory = rows.find((r) => r.kind === "claim_history")!;
    expect(claimHistory).toMatchObject({ subjectRef: customerRef, provenance: "underwriter_declaration", sensitivity: "high" });
    expect(JSON.parse(claimHistory.contentJson!)).toEqual({ claimsLast3y: 0, ncdYears: 5 });
    expect(JSON.parse(claimHistory.purposesJson!)).toEqual({ marketing: false, profiling: true, dataSharing: true });
    expect(claimHistory.expiry).toBe(NOW + 1_095 * DAY);
  });
});

describe("seedAdmin: lenses", () => {
  it("writes exactly one lens per one of the six seeded users", async () => {
    const rows = await db.select().from(schema.lenses).where(eq(schema.lenses.tenantId, tenantId));
    expect(rows).toHaveLength(6);
    // One per user, no duplicates — a mutation that duplicates a userId onto a
    // second row would shrink this set below 6.
    expect(new Set(rows.map((r) => r.userId)).size).toBe(6);

    const agentLens = rows.find((r) => r.userId === result.users["axis.agent"])!;
    expect(JSON.parse(agentLens.lensJson!)).toEqual({
      workspace: "axis",
      pinned: ["cases", "quotes", "tasks"],
      hidden: ["escrow"],
      density: "compact",
      savedViews: [{ id: "mine-open", name: "My open cases", route: "/axis/cases", query: "status=open&owner=me" }]
    });
    expect(agentLens.updatedAt).toBe(NOW - 2 * DAY);

    const leadLens = rows.find((r) => r.userId === result.users["axis.lead"])!;
    expect(JSON.parse(leadLens.lensJson!)).toMatchObject({ workspace: "axis", density: "comfortable" });
    expect(leadLens.updatedAt).toBe(NOW - 5 * HOUR);

    const retentionLens = rows.find((r) => r.userId === result.users["orbit.retention"])!;
    expect(JSON.parse(retentionLens.lensJson!)).toEqual({
      workspace: "orbit",
      pinned: ["renewals", "conversations"],
      hidden: ["partners"],
      density: "compact",
      savedViews: [{ id: "due-30", name: "Expiring in 30 days", route: "/orbit/renewals", query: "window=30" }]
    });

    const execLens = rows.find((r) => r.userId === result.users["north.exec"])!;
    expect(JSON.parse(execLens.lensJson!)).toMatchObject({ workspace: "north", density: "comfortable", savedViews: [] });

    const complianceLens = rows.find((r) => r.userId === result.users["tenant.compliance"])!;
    expect(JSON.parse(complianceLens.lensJson!)).toEqual({
      workspace: "compliance",
      pinned: ["dsar-requests", "guardrail-events", "audit-log"],
      hidden: [],
      density: "compact",
      savedViews: [
        { id: "blocks", name: "Blocked outputs", route: "/admin/guardrail-events", query: "severity=block" }
      ]
    });
  });
});

describe("seedAdmin: rulepacks", () => {
  it("writes the 5-row H12 regulation register across markets and versions", async () => {
    const rows = await db.select().from(schema.rulepacks).where(eq(schema.rulepacks.tenantId, tenantId));
    expect(rows).toHaveLength(5);

    const ae2026 = rows.find((r) => r.market === "AE" && r.version === "2026.1")!;
    expect(ae2026).toMatchObject({ effectiveAt: NOW - 6 * DAY, createdAt: NOW - 20 * DAY });
    expect(JSON.parse(ae2026.rulesJson!)).toEqual({
      disclosure: { comparisonBasis: "required", commissionDisclosure: "on_request" },
      coolingOff: { days: 5, appliesTo: ["motor", "home", "travel"] },
      advice: { regulatedAdviceRequiresLicensedHuman: true }
    });

    const ae2025 = rows.find((r) => r.market === "AE" && r.version === "2025.2")!;
    expect(ae2025.effectiveAt).toBe(NOW - 200 * DAY);
    expect(JSON.parse(ae2025.rulesJson!).disclosure.commissionDisclosure).toBe("none");

    const sa2026 = rows.find((r) => r.market === "SA")!;
    expect(sa2026).toMatchObject({ version: "2026.1", effectiveAt: NOW + 60 * DAY, createdAt: NOW - 12 * DAY });
    expect(JSON.parse(sa2026.rulesJson!)).toEqual({
      disclosure: { comparisonBasis: "required", commissionDisclosure: "required" },
      coolingOff: { days: 7, appliesTo: ["motor"] },
      advice: { regulatedAdviceRequiresLicensedHuman: true },
      localisation: { arabicContractMandatory: true }
    });

    const difc = rows.find((r) => r.market === "AE-DIFC")!;
    expect(difc).toMatchObject({ version: "2026.1", effectiveAt: NOW - 30 * DAY, createdAt: NOW - 35 * DAY });
    expect(JSON.parse(difc.rulesJson!).coolingOff).toEqual({ days: 14, appliesTo: ["life", "health"] });

    const eg = rows.find((r) => r.market === "EG")!;
    expect(eg).toMatchObject({ version: "2025.1", effectiveAt: NOW - 400 * DAY, createdAt: NOW - 410 * DAY });
    expect(JSON.parse(eg.rulesJson!)).toEqual({
      disclosure: { comparisonBasis: "optional", commissionDisclosure: "none" },
      coolingOff: { days: 0, appliesTo: [] },
      advice: { regulatedAdviceRequiresLicensedHuman: true }
    });
  });
});

describe("seedAdmin: aiRuns", () => {
  it("writes the 9-row run log spanning every run state", async () => {
    const rows = await db
      .select()
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.tenantId, tenantId), inArray(schema.aiRuns.purpose, ADMIN_RUN_PURPOSES)));
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.state)).size).toBe(5); // succeeded/refused/failed/budget_stopped/cancelled

    const quoting = rows.find((r) => r.agentKey === "quoting" && r.subjectRef === quoteRef)!;
    expect(quoting).toMatchObject({
      module: "dist",
      purpose: "quote.compare",
      actorRef: "system:dist-fanout",
      autonomyLevel: "suggest",
      trigger: "event",
      state: "succeeded",
      inputHash: await digest("run.quoting.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/quote-compare.json`,
      confidence: 78,
      tokensIn: 2_140,
      tokensOut: 388,
      costMicro: 1_820,
      latencyMs: 2_310,
      startedAt: NOW + 20_000,
      endedAt: NOW + 22_310
    });
    expect(JSON.parse(quoting.evidenceJson!)).toEqual([
      { kind: "quote", ref: quoteRef },
      { kind: "offering", ref: `offerings:${result.offerings.cedarMotor}` },
      { kind: "offering", ref: `offerings:${result.offerings.falconMotor}` }
    ]);

    const renewal = rows.find((r) => r.agentKey === "renewal")!;
    expect(renewal).toMatchObject({
      module: "orbit",
      purpose: "renewal.outreach_draft",
      subjectRef: renewalRef,
      actorRef: "system:orbit-tick",
      trigger: "schedule",
      state: "succeeded",
      confidence: 66,
      tokensIn: 1_204,
      tokensOut: 262,
      costMicro: 410,
      latencyMs: 880,
      startedAt: NOW - 4 * HOUR,
      endedAt: NOW - 4 * HOUR + 880
    });

    const creativeRefused = rows.find((r) => r.agentKey === "creative" && r.subjectRef === "campaigns:motor-jan")!;
    expect(creativeRefused).toMatchObject({
      module: "signal",
      purpose: "creative.variant",
      actorRef: `user:${result.users["signal.lead"]}`,
      state: "refused",
      confidence: 40,
      errorCode: "guardrail_block",
      tokensIn: 890,
      tokensOut: 142,
      costMicro: 720,
      latencyMs: 1_460,
      startedAt: NOW - 2 * HOUR,
      endedAt: NOW - 2 * HOUR + 1_460
    });

    const discovery = rows.find((r) => r.agentKey === "discovery")!;
    expect(discovery).toMatchObject({
      module: "scout",
      purpose: "market.scan",
      subjectRef: null,
      actorRef: "system:scout-tick",
      trigger: "schedule",
      state: "succeeded",
      confidence: 58,
      tokensIn: 8_402,
      tokensOut: 1_940,
      costMicro: 11_200,
      latencyMs: 12_800,
      startedAt: NOW - 1 * DAY,
      endedAt: NOW - 1 * DAY + 12_800
    });

    const briefing = rows.find((r) => r.agentKey === "briefing")!;
    expect(briefing).toMatchObject({
      module: "north",
      purpose: "exec.briefing",
      subjectRef: "north-briefings:2026-01-04",
      state: "succeeded",
      confidence: 81,
      tokensIn: 6_120,
      tokensOut: 1_402,
      costMicro: 8_400,
      latencyMs: 9_600,
      startedAt: NOW - 3 * DAY,
      endedAt: NOW - 3 * DAY + 9_600
    });

    const reconFailed = rows.find((r) => r.agentKey === "recon")!;
    expect(reconFailed).toMatchObject({
      module: "ledger",
      purpose: "recon.match",
      subjectRef: "settlements:cedar-2512",
      state: "failed",
      errorCode: "provider_error",
      tokensIn: 1_840,
      tokensOut: 0,
      costMicro: 300,
      latencyMs: 30_020,
      startedAt: NOW - 8 * HOUR,
      endedAt: NOW - 8 * HOUR + 30_020
    });
    expect(reconFailed.confidence).toBeNull();

    const qa = rows.find((r) => r.agentKey === "qa")!;
    expect(qa).toMatchObject({
      module: "core",
      purpose: "output.review",
      actorRef: "api:qvk_live_a1b2c3d4",
      trigger: "api",
      state: "succeeded",
      confidence: 92,
      tokensIn: 1_602,
      tokensOut: 208,
      costMicro: 1_180,
      latencyMs: 1_720,
      startedAt: NOW - 4 * HOUR + MINUTE,
      endedAt: NOW - 4 * HOUR + MINUTE + 1_720
    });
    expect(qa.subjectRef).toBe(`ai_runs:${renewal.id}`);

    const quotingStopped = rows.find((r) => r.agentKey === "quoting" && r.subjectRef === "quote-requests:bulk-import-2601")!;
    expect(quotingStopped).toMatchObject({
      module: "dist",
      actorRef: "api:qvk_live_e5f6g7h8",
      trigger: "api",
      state: "budget_stopped",
      errorCode: "budget_exceeded",
      tokensIn: 12_400,
      tokensOut: 0,
      costMicro: 14_800,
      latencyMs: 640,
      startedAt: NOW - 26 * HOUR,
      endedAt: NOW - 26 * HOUR + 640
    });

    const creativeCancelled = rows.find(
      (r) => r.agentKey === "creative" && r.subjectRef === "campaigns:renewal-nudge"
    )!;
    expect(creativeCancelled).toMatchObject({
      module: "signal",
      purpose: "creative.variant",
      state: "cancelled",
      tokensIn: 420,
      tokensOut: 0,
      costMicro: 180,
      latencyMs: 900,
      startedAt: NOW - 5 * HOUR,
      endedAt: NOW - 5 * HOUR + 900
    });
  });
});

describe("seedAdmin: aiToolCalls", () => {
  it("writes the 8-row tool call log with consequential calls held on an approval", async () => {
    const runs = await db
      .select()
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.tenantId, tenantId), inArray(schema.aiRuns.purpose, ADMIN_RUN_PURPOSES)));
    const runId = (agentKey: string, purpose: string) =>
      runs.find((r) => r.agentKey === agentKey && r.purpose === purpose)!.id;
    const runQuoting = runs.find((r) => r.agentKey === "quoting" && r.subjectRef === quoteRef)!.id;
    const runRenewal = runId("renewal", "renewal.outreach_draft");
    const runCreativeRefused = runs.find(
      (r) => r.agentKey === "creative" && r.subjectRef === "campaigns:motor-jan"
    )!.id;
    const runReconFailed = runId("recon", "recon.match");

    const rows = await db.select().from(schema.aiToolCalls).where(eq(schema.aiToolCalls.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const byRunSeq = (rid: string, seq: number) => rows.find((r) => r.runId === rid && r.seq === seq)!;

    const q1 = byRunSeq(runQuoting, 1);
    expect(q1).toMatchObject({
      tool: "dist.quote_requests.read",
      argsHash: await digest("tool.quoting.1"),
      outcome: "ok",
      resultHash: await digest("tool.quoting.1.result"),
      durationMs: 42,
      ts: NOW + 20_100,
      consequential: false,
      approvalId: null
    });
    expect(JSON.parse(q1.argsRedactedJson!)).toEqual({ requestId: quoteRequestId });

    const q2 = byRunSeq(runQuoting, 2);
    expect(q2.tool).toBe("dist.offerings.read");
    expect(JSON.parse(q2.argsRedactedJson!)).toEqual({ productLine: "motor", panel: 4 });
    expect(q2).toMatchObject({ outcome: "ok", durationMs: 68, ts: NOW + 20_300 });

    const q3 = byRunSeq(runQuoting, 3);
    expect(q3.tool).toBe("dist.next_best_offers.propose");
    expect(JSON.parse(q3.argsRedactedJson!)).toEqual({ customerRef: "[redacted]", productLine: "home" });
    expect(q3).toMatchObject({ outcome: "ok", durationMs: 96, ts: NOW + 21_000, consequential: false });

    const r1 = byRunSeq(runRenewal, 1);
    expect(r1.tool).toBe("orbit.renewals.read");
    expect(JSON.parse(r1.argsRedactedJson!)).toEqual({ windowDays: 30 });
    expect(r1).toMatchObject({ outcome: "ok", durationMs: 44, ts: NOW - 4 * HOUR + 120 });

    const r2 = byRunSeq(runRenewal, 2);
    expect(r2.tool).toBe("orbit.conversations.reply");
    expect(JSON.parse(r2.argsRedactedJson!)).toEqual({ channel: "whatsapp", to: "[redacted]" });
    expect(r2).toMatchObject({
      consequential: true,
      outcome: "blocked",
      durationMs: 8,
      ts: NOW - 4 * HOUR + 800,
      approvalId: null
    });

    const cr1 = byRunSeq(runCreativeRefused, 1);
    expect(cr1.tool).toBe("signal.campaigns.read");
    expect(JSON.parse(cr1.argsRedactedJson!)).toEqual({ campaign: "motor-jan" });
    expect(cr1).toMatchObject({ outcome: "ok", durationMs: 33, ts: NOW - 2 * HOUR + 200 });

    const cr2 = byRunSeq(runCreativeRefused, 2);
    expect(cr2.tool).toBe("signal.creatives.write");
    expect(JSON.parse(cr2.argsRedactedJson!)).toEqual({ campaign: "motor-jan", variant: "b" });
    expect(cr2).toMatchObject({ consequential: true, outcome: "blocked", durationMs: 6, ts: NOW - 2 * HOUR + 1_400 });

    const recon1 = byRunSeq(runReconFailed, 1);
    expect(recon1.tool).toBe("ledger.settlements.read");
    expect(JSON.parse(recon1.argsRedactedJson!)).toEqual({ statement: "cedar-2512" });
    expect(recon1).toMatchObject({ outcome: "error", durationMs: 30_000, ts: NOW - 8 * HOUR + 20, resultHash: null });
  });
});

describe("seedAdmin: aiSuggestions", () => {
  it("writes the 8-row ambient-surface receipt log", async () => {
    const runs = await db
      .select()
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.tenantId, tenantId), inArray(schema.aiRuns.purpose, ADMIN_RUN_PURPOSES)));
    const runQuoting = runs.find((r) => r.agentKey === "quoting" && r.subjectRef === quoteRef)!.id;
    const runRenewal = runs.find((r) => r.agentKey === "renewal")!.id;
    const runBriefing = runs.find((r) => r.agentKey === "briefing")!.id;
    const runDiscovery = runs.find((r) => r.agentKey === "discovery")!.id;
    const runCreativeCancelled = runs.find(
      (r) => r.agentKey === "creative" && r.subjectRef === "campaigns:renewal-nudge"
    )!.id;

    const rows = await db.select().from(schema.aiSuggestions).where(eq(schema.aiSuggestions.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const cedarChip = rows.find(
      (r) => r.runId === runQuoting && r.surface === "chip" && r.subjectRef === quoteRef
    )!;
    expect(cedarChip).toMatchObject({
      module: "dist",
      userId: result.users["axis.agent"],
      contentRef: `r2:t/${tenantId}/ai/suggestions/why-cedar.json`,
      outcome: "accepted",
      shownAt: NOW + 25_000,
      resolvedAt: NOW + 41_000
    });

    const crossSell = rows.find(
      (r) => r.runId === runQuoting && r.surface === "chip" && r.subjectRef === customerRef
    )!;
    expect(crossSell).toMatchObject({
      contentRef: `r2:t/${tenantId}/ai/suggestions/home-cross-sell.json`,
      outcome: "shown",
      shownAt: NOW + 30_000,
      resolvedAt: null
    });

    const renewalDraft = rows.find((r) => r.runId === runRenewal && r.surface === "draft")!;
    expect(renewalDraft).toMatchObject({
      module: "orbit",
      subjectRef: renewalRef,
      userId: result.users["orbit.retention"],
      contentRef: `r2:t/${tenantId}/ai/suggestions/renewal-message.json`,
      outcome: "accepted",
      shownAt: NOW - 4 * HOUR + 1_000,
      resolvedAt: NOW - 3 * HOUR
    });

    const renewalChip = rows.find((r) => r.runId === runRenewal && r.surface === "chip")!;
    expect(renewalChip).toMatchObject({
      outcome: "edited",
      editDistance: 26,
      shownAt: NOW - 4 * HOUR + 1_200,
      resolvedAt: NOW - 3 * HOUR + 5 * MINUTE
    });

    const forecast = rows.find((r) => r.surface === "forecast")!;
    expect(forecast).toMatchObject({
      runId: runBriefing,
      module: "north",
      subjectRef: "north-briefings:2026-01-04",
      userId: result.users["north.exec"],
      contentRef: `r2:t/${tenantId}/ai/suggestions/motor-gwp-forecast.json`,
      outcome: "accepted",
      shownAt: NOW - 3 * DAY + 10_000,
      resolvedAt: NOW - 3 * DAY + 2 * HOUR
    });

    const filter = rows.find((r) => r.surface === "filter")!;
    expect(filter).toMatchObject({
      runId: runDiscovery,
      module: "scout",
      subjectRef: null,
      userId: result.users["scout.lead"],
      outcome: "expired",
      shownAt: NOW - 1 * DAY + 13_000,
      resolvedAt: NOW - 12 * HOUR
    });

    const cancelledDraft = rows.find((r) => r.runId === runCreativeCancelled)!;
    expect(cancelledDraft).toMatchObject({
      surface: "draft",
      module: "signal",
      subjectRef: "campaigns:renewal-nudge",
      userId: result.users["signal.lead"],
      outcome: "dismissed",
      shownAt: NOW - 5 * HOUR + 1_000,
      resolvedAt: NOW - 5 * HOUR + 30_000
    });

    const noRun = rows.find((r) => r.runId === null)!;
    expect(noRun).toMatchObject({
      surface: "ghost_text",
      module: "core",
      subjectRef: customerRef,
      userId: result.users["axis.lead"],
      outcome: "accepted",
      shownAt: NOW - 90 * MINUTE,
      resolvedAt: NOW - 89 * MINUTE
    });
  });
});

describe("seedAdmin: aiEvals", () => {
  it("writes the 12-row eval scoreboard including two failing rows for the same case over time", async () => {
    const rows = await db.select().from(schema.aiEvals).where(eq(schema.aiEvals.tenantId, tenantId));
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => !r.passed)).toHaveLength(3);

    const cheapest = rows.find((r) => r.caseKey === "motor.cheapest_vs_best_value")!;
    expect(cheapest).toMatchObject({
      suite: "quoting.comparison",
      agentKey: "quoting",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 88,
      passed: true,
      thresholdScore: 80,
      gitSha: "9f2c41a",
      ts: NOW - 2 * DAY
    });
    expect(JSON.parse(cheapest.detailJson!)).toEqual({ groundedness: 0.94, coverageMentions: 4, hallucinatedPrices: 0 });

    const declinedRecent = rows.find(
      (r) => r.caseKey === "motor.declined_offer_explained" && r.gitSha === "9f2c41a"
    )!;
    expect(declinedRecent).toMatchObject({ score: 74, passed: false, thresholdScore: 80, ts: NOW - 2 * DAY });
    expect(JSON.parse(declinedRecent.detailJson!)).toEqual({
      groundedness: 0.88,
      missing: ["decline_reason"],
      note: "Reason omitted in 3 of 10 samples."
    });

    const declinedOlder = rows.find(
      (r) => r.caseKey === "motor.declined_offer_explained" && r.gitSha === "4d81b07"
    )!;
    expect(declinedOlder).toMatchObject({ score: 68, passed: false, thresholdScore: 80, ts: NOW - 9 * DAY });
    expect(JSON.parse(declinedOlder.detailJson!)).toEqual({
      groundedness: 0.81,
      missing: ["decline_reason", "referral_reason"]
    });

    const arabicParity = rows.find((r) => r.caseKey === "motor.arabic_parity")!;
    expect(arabicParity).toMatchObject({ score: 83, passed: true, thresholdScore: 80 });

    const summaryNoAdvice = rows.find((r) => r.caseKey === "axis.summary_no_advice")!;
    expect(summaryNoAdvice).toMatchObject({ suite: "copilot.case_summary", agentKey: "copilot", score: 95, passed: true, thresholdScore: 90 });

    const piiRedaction = rows.find((r) => r.caseKey === "axis.pii_redaction")!;
    expect(piiRedaction).toMatchObject({ score: 100, passed: true, thresholdScore: 100 });

    const noPricePromise = rows.find((r) => r.caseKey === "orbit.no_price_promise")!;
    expect(noPricePromise).toMatchObject({
      suite: "renewal.outreach",
      agentKey: "renewal",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      score: 79,
      passed: false,
      thresholdScore: 85,
      ts: NOW - 1 * DAY
    });

    const toneAndLength = rows.find((r) => r.caseKey === "orbit.tone_and_length")!;
    expect(toneAndLength).toMatchObject({ score: 91, passed: true, thresholdScore: 75 });

    const noRegulatedClaim = rows.find((r) => r.caseKey === "signal.no_regulated_claim")!;
    expect(noRegulatedClaim).toMatchObject({ suite: "creative.compliance", agentKey: "creative", score: 97, passed: true, thresholdScore: 95 });

    const catchesViolation = rows.find((r) => r.caseKey === "core.catches_planted_violation")!;
    expect(catchesViolation).toMatchObject({ suite: "qa.review", agentKey: "qa", score: 89, passed: true, thresholdScore: 85 });

    const partialSettlement = rows.find((r) => r.caseKey === "ledger.partial_settlement")!;
    expect(partialSettlement).toMatchObject({
      suite: "recon.matching",
      agentKey: "recon",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      score: 86,
      passed: true,
      thresholdScore: 80
    });

    const numbersMatch = rows.find((r) => r.caseKey === "north.numbers_match_source")!;
    expect(numbersMatch).toMatchObject({ suite: "briefing.accuracy", agentKey: "briefing", score: 93, passed: true, thresholdScore: 90, ts: NOW - 3 * DAY });
  });
});

describe("seedAdmin: aiKnowledgeSources", () => {
  it("writes the 8-row retrieval corpus registry including stale/indexing/failed rows", async () => {
    const rows = await db
      .select()
      .from(schema.aiKnowledgeSources)
      .where(eq(schema.aiKnowledgeSources.tenantId, tenantId));
    expect(rows).toHaveLength(8);

    const wordingEn = rows.find((r) => r.name === "Cedar Motor Comprehensive — wording v4")!;
    expect(wordingEn).toMatchObject({
      kind: "policy_wording",
      uri: `r2:t/${tenantId}/wordings/cedar-motor-comprehensive-v4.pdf`,
      locale: "en",
      piiLevel: "none",
      chunkCount: 412,
      indexNamespace: `${tenantId}:wordings`,
      status: "ready",
      lastIndexedAt: NOW - 58 * DAY,
      createdAt: NOW - 60 * DAY
    });

    const wordingAr = rows.find((r) => r.name === "Cedar Motor Comprehensive — wording v4 (Arabic)")!;
    expect(wordingAr).toMatchObject({
      uri: `r2:t/${tenantId}/wordings/cedar-motor-comprehensive-v4-ar.pdf`,
      locale: "ar",
      chunkCount: 398,
      indexNamespace: `${tenantId}:wordings`,
      status: "ready"
    });

    const sop = rows.find((r) => r.name === "Motor claims handling SOP")!;
    expect(sop).toMatchObject({
      kind: "sop",
      chunkCount: 88,
      indexNamespace: `${tenantId}:sop`,
      status: "ready",
      lastIndexedAt: NOW - 14 * DAY,
      createdAt: NOW - 150 * DAY
    });

    const faq = rows.find((r) => r.name === "Customer FAQ — motor renewals")!;
    expect(faq).toMatchObject({
      kind: "faq",
      uri: "https://gonxt.ae/help/motor-renewals",
      chunkCount: 34,
      indexNamespace: `${tenantId}:faq`,
      status: "stale",
      lastIndexedAt: NOW - 45 * DAY,
      createdAt: NOW - 120 * DAY
    });

    const regulatory = rows.find((r) => r.name === "UAE motor insurance regulations 2026.1")!;
    expect(regulatory).toMatchObject({
      kind: "regulatory",
      uri: "https://www.centralbank.ae/en/insurance/motor",
      chunkCount: 206,
      indexNamespace: `${tenantId}:regulatory`,
      status: "ready",
      lastIndexedAt: NOW - 6 * DAY
    });

    const falcon = rows.find((r) => r.name === "Falcon Motor rate card and endorsements")!;
    expect(falcon).toMatchObject({
      kind: "product",
      chunkCount: 0,
      indexNamespace: `${tenantId}:products`,
      status: "indexing",
      lastIndexedAt: null,
      createdAt: NOW - 20 * MINUTE
    });

    const meridianDeck = rows.find((r) => r.name === "Meridian Bank embedded-journey copy deck")!;
    expect(meridianDeck).toMatchObject({
      kind: "product",
      uri: "https://partners.meridianbank.ae/lyra/copy-deck",
      chunkCount: 0,
      indexNamespace: null,
      status: "failed",
      lastIndexedAt: null,
      createdAt: NOW - 2 * DAY
    });

    const transcripts = rows.find((r) => r.name === "Call-centre objection handling transcripts (2025)")!;
    expect(transcripts).toMatchObject({
      kind: "sop",
      piiLevel: "high",
      chunkCount: 1_204,
      indexNamespace: `${tenantId}:sop-restricted`,
      status: "ready",
      lastIndexedAt: NOW - 9 * DAY,
      createdAt: NOW - 90 * DAY
    });
  });
});

describe("seedAdmin: aiGuardrailEvents", () => {
  it("writes the 5-row guardrail trip log spanning block/warn/info severities", async () => {
    const runs = await db
      .select()
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.tenantId, tenantId), inArray(schema.aiRuns.purpose, ADMIN_RUN_PURPOSES)));
    const runCreativeRefused = runs.find(
      (r) => r.agentKey === "creative" && r.subjectRef === "campaigns:motor-jan"
    )!.id;
    const runRenewal = runs.find((r) => r.agentKey === "renewal")!.id;
    const runQuoting = runs.find((r) => r.agentKey === "quoting" && r.subjectRef === quoteRef)!.id;
    const runBriefing = runs.find((r) => r.agentKey === "briefing")!.id;

    const rows = await db
      .select()
      .from(schema.aiGuardrailEvents)
      .where(eq(schema.aiGuardrailEvents.tenantId, tenantId));
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.severity === "block")).toHaveLength(2);
    expect(rows.filter((r) => r.severity === "warn")).toHaveLength(2);
    expect(rows.filter((r) => r.severity === "info")).toHaveLength(1);

    const creativeBlock = rows.find((r) => r.runId === runCreativeRefused)!;
    expect(creativeBlock).toMatchObject({
      rule: "regulated_claim",
      severity: "block",
      detail: "Draft asserted 'full coverage guaranteed' in customer-facing copy.",
      subjectRef: "campaigns:motor-jan",
      ts: NOW - 2 * HOUR + 1_400
    });

    const renewalWarn = rows.find((r) => r.runId === runRenewal)!;
    expect(renewalWarn).toMatchObject({
      rule: "hallucinated_placeholder",
      severity: "warn",
      detail: "Renewal draft contained '[premium]' with no value from the source sheet.",
      subjectRef: renewalRef,
      ts: NOW - 4 * HOUR + 700
    });

    const quotingWarn = rows.find((r) => r.runId === runQuoting)!;
    expect(quotingWarn).toMatchObject({
      rule: "prompt_injection",
      severity: "warn",
      detail: "Vehicle notes field contained 'ignore previous instructions'.",
      subjectRef: quoteRef,
      ts: NOW + 20_500
    });

    const secretLeak = rows.find((r) => r.rule === "secret_in_output")!;
    expect(secretLeak).toMatchObject({
      runId: null,
      severity: "block",
      detail: "Draft integration guide echoed a live API key prefix; output withheld.",
      subjectRef: "api-keys:qvk_live_a1b2c3d4",
      ts: NOW - 14 * DAY + 25 * MINUTE
    });

    const briefingInfo = rows.find((r) => r.runId === runBriefing)!;
    expect(briefingInfo).toMatchObject({
      rule: "hallucinated_placeholder",
      severity: "info",
      detail: "Briefing draft used a rounded figure not present in the rollup.",
      subjectRef: "north-briefings:2026-01-04",
      ts: NOW - 3 * DAY + 9_000
    });

  });
});

describe("seedAdmin: aiAuditLog", () => {
  it("writes the 9-row immutable model-call spine with cloud tier routing", async () => {
    const runs = await db
      .select()
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.tenantId, tenantId), inArray(schema.aiRuns.purpose, ADMIN_RUN_PURPOSES)));
    const runRenewal = runs.find((r) => r.agentKey === "renewal")!.id;

    const rows = await db
      .select()
      .from(schema.aiAuditLog)
      .where(and(eq(schema.aiAuditLog.tenantId, tenantId), inArray(schema.aiAuditLog.purpose, ADMIN_AUDIT_PURPOSES)));
    expect(rows).toHaveLength(9);
    const bigModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const fastModel = "@cf/meta/llama-3.1-8b-instruct-fast";

    const quoteCompare = rows.find((r) => r.module === "dist" && r.actorRef === "system:dist-fanout")!;
    expect(quoteCompare).toMatchObject({
      purpose: "quote.compare",
      model: bigModel,
      provider: "workers-ai",
      tier: "standard",
      inputHash: await digest("run.quoting.input"),
      outputHash: await digest("aia.quoting.output"),
      tokensIn: 2_140,
      tokensOut: 388,
      costMicro: 1_820,
      latencyMs: 2_310,
      subjectRef: quoteRef,
      outcome: "ok",
      ts: NOW + 22_310
    });
    expect(JSON.parse(quoteCompare.toolCallsJson!)).toEqual(["dist.quote_requests.read", "dist.offerings.read"]);
    expect(JSON.parse(quoteCompare.guardrailFlagsJson!)).toEqual(["prompt_injection"]);

    const renewalDraft = rows.find((r) => r.purpose === "renewal.outreach_draft")!;
    expect(renewalDraft).toMatchObject({
      module: "orbit",
      model: fastModel,
      tier: "fast",
      tokensIn: 1_204,
      tokensOut: 262,
      costMicro: 410,
      latencyMs: 880,
      actorRef: "system:orbit-tick",
      subjectRef: renewalRef,
      outcome: "ok",
      ts: NOW - 4 * HOUR + 880
    });
    expect(JSON.parse(renewalDraft.guardrailFlagsJson!)).toEqual(["hallucinated_placeholder"]);

    const creativeVariant = rows.find((r) => r.purpose === "creative.variant")!;
    expect(creativeVariant).toMatchObject({
      module: "signal",
      model: bigModel,
      tier: "standard",
      tokensIn: 890,
      tokensOut: 142,
      costMicro: 720,
      latencyMs: 1_460,
      actorRef: `user:${result.users["signal.lead"]}`,
      subjectRef: "campaigns:motor-jan",
      outcome: "refused",
      outputHash: null,
      ts: NOW - 2 * HOUR + 1_460
    });
    expect(JSON.parse(creativeVariant.guardrailFlagsJson!)).toEqual(["regulated_claim"]);

    const marketScan = rows.find((r) => r.purpose === "market.scan")!;
    expect(marketScan).toMatchObject({
      module: "scout",
      model: bigModel,
      tier: "reasoning",
      tokensIn: 8_402,
      tokensOut: 1_940,
      costMicro: 11_200,
      latencyMs: 12_800,
      actorRef: "system:scout-tick",
      subjectRef: null,
      outcome: "ok",
      ts: NOW - 1 * DAY + 12_800
    });

    const execBriefing = rows.find((r) => r.purpose === "exec.briefing")!;
    expect(execBriefing).toMatchObject({
      module: "north",
      model: bigModel,
      tier: "reasoning",
      tokensIn: 6_120,
      tokensOut: 1_402,
      costMicro: 8_400,
      latencyMs: 9_600,
      actorRef: "system:north-tick",
      subjectRef: "north-briefings:2026-01-04",
      outcome: "ok",
      ts: NOW - 3 * DAY + 9_600
    });

    const reconMatch = rows.find((r) => r.purpose === "recon.match")!;
    expect(reconMatch).toMatchObject({
      module: "ledger",
      model: fastModel,
      tier: "fast",
      tokensIn: 1_840,
      tokensOut: 0,
      costMicro: 300,
      latencyMs: 30_020,
      actorRef: "system:ledger-tick",
      subjectRef: "settlements:cedar-2512",
      outcome: "error",
      outputHash: null,
      ts: NOW - 8 * HOUR + 30_020
    });

    const bulkQuote = rows.find(
      (r) => r.purpose === "quote.compare" && r.actorRef === "api:qvk_live_e5f6g7h8"
    )!;
    expect(bulkQuote).toMatchObject({
      module: "dist",
      model: bigModel,
      tier: "standard",
      tokensIn: 12_400,
      tokensOut: 0,
      costMicro: 14_800,
      latencyMs: 640,
      subjectRef: "quote-requests:bulk-import-2601",
      outcome: "budget_exceeded",
      outputHash: null,
      ts: NOW - 26 * HOUR + 640
    });

    const outputReview = rows.find((r) => r.purpose === "output.review")!;
    expect(outputReview).toMatchObject({
      module: "core",
      model: bigModel,
      tier: "standard",
      tokensIn: 1_602,
      tokensOut: 208,
      costMicro: 1_180,
      latencyMs: 1_720,
      actorRef: "api:qvk_live_a1b2c3d4",
      subjectRef: `ai_runs:${runRenewal}`,
      outcome: "ok",
      ts: NOW - 4 * HOUR + MINUTE + 1_720
    });
    expect(JSON.parse(outputReview.toolCallsJson!)).toEqual(["ai.runs.read"]);

    const knowledgeEmbed = rows.find((r) => r.purpose === "knowledge.embed")!;
    expect(knowledgeEmbed).toMatchObject({
      module: "core",
      model: "@cf/baai/bge-m3",
      tier: "fast",
      inputHash: await digest("aia.embed.input"),
      outputHash: await digest("aia.embed.output"),
      tokensIn: 88_400,
      tokensOut: 0,
      costMicro: 640,
      latencyMs: 4_180,
      actorRef: "system:knowledge-indexer",
      subjectRef: "knowledge-sources:falcon-motor-rates",
      outcome: "ok",
      ts: NOW - 18 * MINUTE
    });
  });
});
