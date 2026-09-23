import { id, schema } from "@lyra/db";
import { sha256Hex } from "../crypto.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { dayKey, monthName } from "./period.js";

// The admin workspace is where an operator answers "what did this platform
// actually do?". Empty tables answer nothing, so every screen under /admin gets
// rows drawn from the one story the core seed tells: Rania Haddad asked for
// motor cover, the request fanned out to four underwriters, and Cedar's row won
// through the b2c web channel. Everything below is a consequence of that.

/**
 * A stand-in digest. The gateway and the run recorder store hashes, never
 * content, so a seeded row needs a hash that looks like the real thing and is
 * stable across seeds — deriving it from a label gives both, and guarantees two
 * rows never share one by accident.
 */
async function digest(label: string): Promise<string> {
  return sha256Hex(`lyra.seed.admin:${label}`);
}

export async function seedAdmin(ctx: SeedContext): Promise<void> {
  const { db, now, tenantId, users, customerId, caseId, policyId, renewalPolicyId, quoteRequestId } = ctx;

  // The subjects everything below points at. Written once so a change to the
  // reference format is one edit rather than ninety.
  const customerRef = `customer:${customerId}`;
  const caseRef = `cases:${caseId}`;
  const policyRef = `policies:${policyId}`;
  const renewalRef = `policies:${renewalPolicyId}`;
  const quoteRef = `quote-requests:${quoteRequestId}`;

  const admin = users["tenant.admin"]!;
  const compliance = users["tenant.compliance"]!;
  const agent = users["axis.agent"]!;
  const lead = users["axis.lead"]!;
  const retention = users["orbit.retention"]!;
  const partners = users["orbit.partners"]!;
  const marketer = users["signal.lead"]!;
  const scout = users["scout.lead"]!;
  const exec = users["north.exec"]!;
  const controller = users["finance.controller"]!;
  const developer = users["dev.admin"]!;

  /* ---------------------------------------------------------------- files */
  // The document trail of one sale. Upload is a signed-URL flow, so this table
  // is the register: what was stored, against whom, and how sensitive it is —
  // which is exactly what the retention and erasure jobs read.
  await db.insert(schema.files).values([
    {
      id: id("fil", now + 1),
      tenantId,
      r2Key: `t/${tenantId}/kyc/emirates-id-front.jpg`,
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.eid.front"),
      sizeBytes: 412_884,
      contentType: "image/jpeg",
      // An identity document is the highest-sensitivity thing the platform
      // holds: it is what the unmasked-export approval exists to protect.
      piiLevel: "high",
      createdAt: now - 3 * DAY
    },
    {
      id: id("fil", now + 2),
      tenantId,
      r2Key: `t/${tenantId}/kyc/driving-licence.jpg`,
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.licence"),
      sizeBytes: 288_140,
      contentType: "image/jpeg",
      piiLevel: "high",
      createdAt: now - 3 * DAY
    },
    {
      id: id("fil", now + 3),
      tenantId,
      r2Key: `t/${tenantId}/quotes/comparison-GNX-2601-0001.pdf`,
      kind: "comparison",
      subjectRef: quoteRef,
      sha256: await digest("file.comparison"),
      sizeBytes: 96_512,
      contentType: "application/pdf",
      // The comparison names the customer and her vehicle but carries no
      // identity document, so it sits a level below the KYC scans.
      piiLevel: "low",
      createdAt: now + MINUTE
    },
    {
      id: id("fil", now + 4),
      tenantId,
      r2Key: `t/${tenantId}/policies/CDR-MOT-2601-778201-schedule.pdf`,
      kind: "policy_schedule",
      subjectRef: policyRef,
      sha256: await digest("file.schedule"),
      sizeBytes: 154_003,
      contentType: "application/pdf",
      piiLevel: "low",
      createdAt: ctx.issuedAt
    },
    {
      id: id("fil", now + 5),
      tenantId,
      r2Key: `t/${tenantId}/vehicles/land-cruiser-2023-front.jpg`,
      kind: "vehicle_photo",
      subjectRef: quoteRef,
      sha256: await digest("file.vehicle"),
      sizeBytes: 1_244_902,
      contentType: "image/jpeg",
      piiLevel: "low",
      createdAt: now - 2 * DAY
    },
    {
      id: id("fil", now + 6),
      tenantId,
      r2Key: `t/${tenantId}/wordings/cedar-motor-comprehensive-v4.pdf`,
      kind: "policy_wording",
      sha256: await digest("file.wording.cedar"),
      sizeBytes: 742_118,
      contentType: "application/pdf",
      // A published wording is a public document; it carries no personal data
      // at all, which is why the retrieval index is allowed to read it.
      piiLevel: "none",
      createdAt: now - 60 * DAY
    },
    {
      id: id("fil", now + 7),
      tenantId,
      r2Key: `t/${tenantId}/brand/gonxt-mark.svg`,
      kind: "brand_asset",
      sha256: await digest("file.brand"),
      sizeBytes: 4_206,
      contentType: "image/svg+xml",
      piiLevel: "none",
      createdAt: now - 90 * DAY
    },
    {
      id: id("fil", now + 8),
      tenantId,
      r2Key: `t/${tenantId}/kyc/emirates-id-superseded.jpg`,
      kind: "kyc_document",
      subjectRef: customerRef,
      sha256: await digest("file.eid.superseded"),
      sizeBytes: 388_201,
      contentType: "image/jpeg",
      piiLevel: "high",
      createdAt: now - 400 * DAY,
      // Soft-deleted rather than removed: the register keeps the fact that a
      // document existed and was destroyed, which is what an auditor asks for.
      deletedAt: now - 30 * DAY
    }
  ]);

  /* ------------------------------------------------------------ approvals */
  // The human-in-the-loop record (CLAUDE.md rule 4). A queue that is all
  // pending looks broken and a queue that is all approved looks ceremonial, so
  // this is what a real week leaves behind: decisions in every direction.
  const endorseApprovalId = id("apr", now + 10);
  const bindApprovalId = id("apr", now + 11);
  await db.insert(schema.approvals).values([
    {
      id: bindApprovalId,
      tenantId,
      subjectRef: caseRef,
      policyKey: "axis.bind",
      module: "axis",
      requestedBy: agent,
      requestedAt: ctx.issuedAt - HOUR,
      decidedBy: lead,
      decision: "approved",
      reason: "Cedar's terms match the comparison the customer was shown.",
      contextJson: JSON.stringify({ amountMinor: 412_500, currency: "AED", dualControl: false }),
      decidedAt: ctx.issuedAt - 20 * MINUTE
    },
    {
      id: endorseApprovalId,
      tenantId,
      subjectRef: policyRef,
      policyKey: "axis.endorse",
      module: "axis",
      requestedBy: agent,
      requestedAt: now + 6 * HOUR,
      // Still open: a mid-term endorsement is parked against this id awaiting a
      // human decision — real regardless of which caller filed it.
      decision: "pending",
      contextJson: JSON.stringify({
        amountMinor: 31_000,
        currency: "AED",
        dualControl: true,
        change: "Add a named second driver mid-term"
      })
    },
    {
      id: id("apr", now + 12),
      tenantId,
      subjectRef: `quotes:${quoteRequestId}`,
      policyKey: "axis.price_match",
      module: "axis",
      requestedBy: agent,
      requestedAt: now - 1 * DAY,
      decidedBy: lead,
      decision: "rejected",
      // A rejection with a reason is the point of the queue: the record shows
      // why the discount did not happen, not merely that it did not.
      reason: "The competitor quote excludes agency repair, so the two prices are not comparable.",
      contextJson: JSON.stringify({ amountMinor: 42_000, currency: "AED", dualControl: false }),
      decidedAt: now - 22 * HOUR
    },
    {
      id: id("apr", now + 13),
      tenantId,
      subjectRef: `settlements:cedar-2512`,
      policyKey: "ledger.partner_settlement",
      module: "ledger",
      requestedBy: controller,
      requestedAt: now - 5 * DAY,
      decidedBy: admin,
      decision: "approved",
      reason: `${monthName(now, -1)} commission statement reconciles to the ledger with no unmatched lines.`,
      contextJson: JSON.stringify({ amountMinor: 1_284_000, currency: "AED", dualControl: true }),
      decidedAt: now - 4 * DAY
    },
    {
      id: id("apr", now + 14),
      tenantId,
      subjectRef: `analytics-exports:motor-book-q4`,
      policyKey: "core.unmasked_export",
      module: "core",
      requestedBy: users["north.analyst"]!,
      requestedAt: now - 2 * DAY,
      decidedBy: compliance,
      decision: "rejected",
      reason: "The question can be answered from the masked dataset; unmasked identifiers are not needed.",
      contextJson: JSON.stringify({ dualControl: true, rows: 18_402 }),
      decidedAt: now - 2 * DAY + 3 * HOUR
    },
    {
      id: id("apr", now + 15),
      tenantId,
      subjectRef: `ai_budget:signal`,
      policyKey: "ai.budget_raise",
      module: "ai",
      requestedBy: marketer,
      requestedAt: now - 6 * HOUR,
      decision: "pending",
      contextJson: JSON.stringify({
        dualControl: false,
        fromCostMicro: 8_000_000,
        toCostMicro: 12_000_000
      })
    },
    {
      id: id("apr", now + 16),
      tenantId,
      subjectRef: `dist-rates:cedar-motor-plus`,
      policyKey: "dist.rate_change",
      module: "core",
      requestedBy: partners,
      requestedAt: now - 9 * DAY,
      decidedBy: admin,
      decision: "approved",
      reason: "Cedar confirmed the loading in writing; the panel rate card now matches their sheet.",
      contextJson: JSON.stringify({ dualControl: true, deltaBps: 250 }),
      decidedAt: now - 8 * DAY
    },
    {
      id: id("apr", now + 17),
      tenantId,
      subjectRef: `compliance-erasures:${customerId}-2512`,
      policyKey: "compliance.erasure",
      module: "core",
      requestedBy: compliance,
      requestedAt: now - 40 * DAY,
      decidedBy: admin,
      decision: "approved",
      reason: "Superseded identity scan is outside the retention window and under no legal hold.",
      contextJson: JSON.stringify({ dualControl: true, files: 1 }),
      decidedAt: now - 31 * DAY
    }
  ]);

  /* ------------------------------------------------------------- api keys */
  // Integration credentials. Only the prefix survives issue, so these rows are
  // recognisable and useless — and the revoked one is here because a console
  // that has never seen a revocation teaches nobody how one looks.
  await db.insert(schema.apiKeys).values([
    {
      id: id("key", now + 20),
      tenantId,
      name: "Alpha Brokers — quote intake",
      prefix: "qvk_live_a1b2c3d4",
      keyHash: await digest("key.alpha"),
      mode: "live",
      scopesJson: JSON.stringify(["dist:quotes:create", "dist:quotes:read", "core:customers:read"]),
      createdBy: partners,
      lastUsedAt: now - 40 * MINUTE,
      createdAt: now - 120 * DAY
    },
    {
      id: id("key", now + 21),
      tenantId,
      name: "Meridian Bank — embedded motor journey",
      prefix: "qvk_live_e5f6g7h8",
      keyHash: await digest("key.meridian"),
      mode: "live",
      scopesJson: JSON.stringify(["dist:quotes:create", "dist:offerings:read"]),
      createdBy: partners,
      lastUsedAt: now - 3 * HOUR,
      expiresAt: now + 180 * DAY,
      createdAt: now - 75 * DAY
    },
    {
      id: id("key", now + 22),
      tenantId,
      name: "Sandbox — partner onboarding tests",
      prefix: "qvk_test_j9k0l1m2",
      keyHash: await digest("key.sandbox"),
      mode: "test",
      scopesJson: JSON.stringify(["dist:quotes:create", "dist:quotes:read"]),
      createdBy: developer,
      lastUsedAt: now - 2 * DAY,
      createdAt: now - 30 * DAY
    },
    {
      id: id("key", now + 23),
      tenantId,
      name: "Alpha Brokers — legacy intake (leaked)",
      prefix: "qvk_live_n3p4q5r6",
      keyHash: await digest("key.leaked"),
      mode: "live",
      scopesJson: JSON.stringify(["dist:quotes:create"]),
      createdBy: partners,
      lastUsedAt: now - 14 * DAY,
      // Found in a partner's public repository and cut the same hour. The row
      // stays so the last-used timestamp can be compared against the incident.
      revokedAt: now - 14 * DAY + 30 * MINUTE,
      createdAt: now - 300 * DAY
    },
    {
      id: id("key", now + 24),
      tenantId,
      name: "Migration import — 2025 book",
      prefix: "qvk_test_s7t8u9v0",
      keyHash: await digest("key.migration"),
      mode: "test",
      scopesJson: JSON.stringify(["core:customers:write", "axis:policies:create"]),
      createdBy: developer,
      lastUsedAt: now - 200 * DAY,
      // Deliberately short-lived: a one-off import key that has already lapsed
      // rather than one that lives forever because nobody remembered it.
      expiresAt: now - 180 * DAY,
      createdAt: now - 210 * DAY
    },
    {
      id: id("key", now + 25),
      tenantId,
      name: "Cedar Insurance — settlement statement pull",
      prefix: "qvk_live_w1x2y3z4",
      keyHash: await digest("key.cedar"),
      mode: "live",
      scopesJson: JSON.stringify(["ledger:settlements:read", "dist:commissions:read"]),
      createdBy: controller,
      lastUsedAt: now - 6 * HOUR,
      createdAt: now - 45 * DAY
    }
  ]);

  /* --------------------------------------------------- identity providers */
  // Enterprise sign-in routes. Each row owns an email domain, so staff, the
  // bank's embedded team and the broker each arrive through their own IdP.
  await db.insert(schema.identityProviders).values([
    {
      id: id("idp", now + 30),
      tenantId,
      kind: "oidc",
      name: "GONXT staff directory",
      emailDomain: "gonxt.ae",
      issuer: "https://login.microsoftonline.com/gonxt/v2.0",
      clientId: "gonxt-lyra-web",
      clientSecretRef: "IDP_GONXT_CLIENT_SECRET",
      discoveryUrl: "https://login.microsoftonline.com/gonxt/v2.0/.well-known/openid-configuration",
      defaultRoleKey: "axis.agent",
      enabled: true,
      // The staff route asserts MFA, which is what lets it cover privileged
      // roles instead of falling back to the password form (PLAT-013).
      mfaAsserted: true,
      createdAt: now - 200 * DAY,
      updatedAt: now - 20 * DAY
    },
    {
      id: id("idp", now + 31),
      tenantId,
      kind: "oidc",
      name: "Meridian Bank partner staff",
      emailDomain: "meridianbank.ae",
      issuer: "https://sso.meridianbank.ae",
      clientId: "meridian-lyra",
      clientSecretRef: "IDP_MERIDIAN_CLIENT_SECRET",
      discoveryUrl: "https://sso.meridianbank.ae/.well-known/openid-configuration",
      defaultRoleKey: "orbit.partners",
      enabled: true,
      mfaAsserted: true,
      createdAt: now - 70 * DAY,
      updatedAt: now - 70 * DAY
    },
    {
      id: id("idp", now + 32),
      tenantId,
      // SAML is the reserved seam (CLAUDE.md §15): one broker still runs an
      // ADFS estate, and it binds through the same row shape as OIDC.
      kind: "saml",
      name: "Alpha Brokers ADFS",
      emailDomain: "alphabrokers.ae",
      issuer: "urn:alphabrokers:adfs",
      ssoUrl: "https://adfs.alphabrokers.ae/adfs/ls/",
      certificate: "MIIC-seed-placeholder-certificate-not-a-real-key",
      defaultRoleKey: "axis.agent",
      enabled: true,
      mfaAsserted: false,
      createdAt: now - 55 * DAY,
      updatedAt: now - 12 * DAY
    },
    {
      id: id("idp", now + 33),
      tenantId,
      kind: "oidc",
      name: "Cedar Insurance underwriters",
      emailDomain: "cedarinsurance.ae",
      issuer: "https://id.cedarinsurance.ae",
      clientId: "cedar-lyra",
      discoveryUrl: "https://id.cedarinsurance.ae/.well-known/openid-configuration",
      defaultRoleKey: "orbit.partners",
      // Half-configured on purpose: the client secret has not been bound yet,
      // so the row stays disabled and cannot shadow the password form.
      enabled: false,
      mfaAsserted: false,
      createdAt: now - 9 * DAY,
      updatedAt: now - 9 * DAY
    }
  ]);

  /* --------------------------------------------------------- webhooks */
  // Every subscribed type is one the code emits — apps/api event-seams.test.ts
  // holds that, and SEED_EVENT_RENAMES (seed.ts) rewrites the older names a
  // tenant provisioned before 2026-09-23 still carries.
  // Outbound integration. The signing secrets here are obvious demo strings —
  // a real one is generated server-side and shown once, never seeded.
  const whkPartner = id("whk", now + 40);
  const whkCedar = id("whk", now + 41);
  const whkBank = id("whk", now + 42);
  const whkFinance = id("whk", now + 43);
  const whkLegacy = id("whk", now + 44);
  await db.insert(schema.webhooks).values([
    {
      id: whkPartner,
      tenantId,
      url: "https://hooks.alphabrokers.ae/lyra/policy-events",
      eventTypesJson: JSON.stringify(["axis.policy.issued", "axis.policy.cancelled", "orbit.renewal.due"]),
      secret: "whsec_seed_alpha_not_a_real_secret",
      status: "active",
      createdAt: now - 120 * DAY
    },
    {
      id: whkCedar,
      tenantId,
      url: "https://api.cedarinsurance.ae/partners/gonxt/events",
      eventTypesJson: JSON.stringify(["axis.policy.issued", "axis.policy.endorsed"]),
      secret: "whsec_seed_cedar_not_a_real_secret",
      status: "active",
      createdAt: now - 88 * DAY
    },
    {
      id: whkBank,
      tenantId,
      url: "https://embed.meridianbank.ae/lyra/callbacks",
      eventTypesJson: JSON.stringify(["dist.quote_request.fanned_out", "axis.policy.issued"]),
      secret: "whsec_seed_meridian_not_a_real_secret",
      status: "active",
      createdAt: now - 70 * DAY
    },
    {
      id: whkFinance,
      tenantId,
      url: "https://ops.gonxt.ae/webhooks/ledger",
      eventTypesJson: JSON.stringify(["ledger.settlement.approved", "ledger.recon.completed"]),
      secret: "whsec_seed_ops_not_a_real_secret",
      status: "active",
      createdAt: now - 45 * DAY
    },
    {
      id: whkLegacy,
      tenantId,
      url: "https://legacy.alphabrokers.ae/hooks/quotes",
      eventTypesJson: JSON.stringify(["dist.quote_request.fanned_out"]),
      secret: "whsec_seed_legacy_not_a_real_secret",
      // Paused after the endpoint went dark: the deliveries below are why.
      status: "paused",
      createdAt: now - 260 * DAY
    }
  ]);

  /* --------------------------------------------------- webhook deliveries */
  // The attempt log. A delivery table that only shows successes hides the one
  // thing an operator opens it for — which endpoint is failing, and since when.
  await db.insert(schema.webhookDeliveries).values([
    {
      id: id("whd", now + 50),
      tenantId,
      webhookId: whkCedar,
      eventId: `evt_${await digest("evt.bound")}`.slice(0, 30),
      status: "delivered",
      responseCode: 200,
      attempts: 1,
      createdAt: ctx.issuedAt
    },
    {
      id: id("whd", now + 51),
      tenantId,
      webhookId: whkPartner,
      eventId: `evt_${await digest("evt.issued")}`.slice(0, 30),
      status: "delivered",
      responseCode: 202,
      attempts: 1,
      createdAt: ctx.issuedAt + MINUTE
    },
    {
      id: id("whd", now + 52),
      tenantId,
      webhookId: whkBank,
      eventId: `evt_${await digest("evt.ready")}`.slice(0, 30),
      status: "delivered",
      // Succeeded, but only on the retry: the first attempt timed out, so the
      // attempt count is the honest signal that the endpoint is marginal.
      responseCode: 200,
      attempts: 2,
      createdAt: now - 20 * MINUTE
    },
    {
      id: id("whd", now + 53),
      tenantId,
      webhookId: whkFinance,
      eventId: `evt_${await digest("evt.settlement")}`.slice(0, 30),
      status: "failed",
      responseCode: 502,
      attempts: 3,
      nextAttemptAt: now + 8 * MINUTE,
      error: "Bad gateway from ops.gonxt.ae after 3 attempts",
      createdAt: now - 35 * MINUTE
    },
    {
      id: id("whd", now + 54),
      tenantId,
      webhookId: whkLegacy,
      eventId: `evt_${await digest("evt.legacy.1")}`.slice(0, 30),
      status: "dead",
      responseCode: 410,
      attempts: 8,
      // Dead, not failed: the endpoint answered Gone, so retrying is pointless
      // and the webhook above was paused instead.
      error: "Endpoint returned 410 Gone; retries exhausted",
      createdAt: now - 6 * DAY
    },
    {
      id: id("whd", now + 55),
      tenantId,
      webhookId: whkLegacy,
      eventId: `evt_${await digest("evt.legacy.2")}`.slice(0, 30),
      status: "dead",
      responseCode: 410,
      attempts: 8,
      error: "Endpoint returned 410 Gone; retries exhausted",
      createdAt: now - 5 * DAY
    },
    {
      id: id("whd", now + 56),
      tenantId,
      webhookId: whkPartner,
      eventId: `evt_${await digest("evt.renewal")}`.slice(0, 30),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now + 2 * MINUTE,
      createdAt: now
    },
    {
      id: id("whd", now + 57),
      tenantId,
      webhookId: whkBank,
      eventId: `evt_${await digest("evt.bound.bank")}`.slice(0, 30),
      status: "delivered",
      responseCode: 200,
      attempts: 1,
      createdAt: now - 2 * DAY
    }
  ]);

  /* ------------------------------------------------------- notifications */
  // The inbox stores a key and its parameters, never a sentence (rule 7). The
  // mix is deliberate: some read, some not, because an all-unread inbox and an
  // all-read one both hide how the badge behaves.
  await db.insert(schema.notifications).values([
    {
      id: id("ntf", now + 60),
      tenantId,
      userId: lead,
      kind: "approval",
      titleKey: "axis.endorsement.approval_pending",
      paramsJson: JSON.stringify({ policyNo: "CDR-MOT-2601-778201", customer: "Rania Haddad" }),
      subjectRef: `approvals:${endorseApprovalId}`,
      createdAt: now + 6 * HOUR
    },
    {
      id: id("ntf", now + 61),
      tenantId,
      userId: agent,
      kind: "alert",
      titleKey: "axis.price_match.rejected",
      paramsJson: JSON.stringify({ caseRef: "GNX-2601-0001" }),
      subjectRef: caseRef,
      readAt: now - 20 * HOUR,
      createdAt: now - 22 * HOUR
    },
    {
      id: id("ntf", now + 62),
      tenantId,
      userId: retention,
      kind: "task",
      titleKey: "orbit.renewal.due",
      paramsJson: JSON.stringify({ policyNo: "CDR-MOT-2501-664118", daysToExpiry: 20 }),
      subjectRef: renewalRef,
      createdAt: now - 4 * HOUR
    },
    {
      id: id("ntf", now + 63),
      tenantId,
      userId: controller,
      kind: "alert",
      titleKey: "ledger.webhook.delivery_failed",
      paramsJson: JSON.stringify({ url: "https://ops.gonxt.ae/webhooks/ledger", attempts: 3 }),
      subjectRef: `webhooks:${whkFinance}`,
      createdAt: now - 30 * MINUTE
    },
    {
      id: id("ntf", now + 64),
      tenantId,
      userId: compliance,
      kind: "alert",
      titleKey: "ai.guardrail.blocked",
      paramsJson: JSON.stringify({ rule: "regulated_claim", agentKey: "creative" }),
      subjectRef: `campaigns:motor-jan`,
      createdAt: now - 2 * HOUR
    },
    {
      id: id("ntf", now + 65),
      tenantId,
      userId: exec,
      kind: "report",
      titleKey: "north.briefing.ready",
      paramsJson: JSON.stringify({ period: dayKey(now, -2) }),
      subjectRef: `north-briefings:2026-01-04`,
      readAt: now - 3 * DAY + HOUR,
      createdAt: now - 3 * DAY
    },
    {
      id: id("ntf", now + 66),
      tenantId,
      userId: admin,
      kind: "alert",
      titleKey: "core.api_key.revoked",
      paramsJson: JSON.stringify({ prefix: "qvk_live_n3p4q5r6", reason: "exposed_in_public_repo" }),
      subjectRef: `api-keys:${id("key", now + 23)}`,
      readAt: now - 13 * DAY,
      createdAt: now - 14 * DAY
    },
    {
      id: id("ntf", now + 67),
      tenantId,
      userId: marketer,
      kind: "approval",
      titleKey: "ai.budget.raise_requested",
      paramsJson: JSON.stringify({ module: "signal", toCostMicro: 12_000_000 }),
      subjectRef: `ai_budget:signal`,
      createdAt: now - 6 * HOUR
    }
  ]);

  /* ------------------------------------------------------------ mandates */
  // H1 seam (docs/16): the delegated authority an agent acts under. Nothing in
  // the product spends money autonomously yet, so these rows exist to make the
  // cap, the scope and the expiry visible before anything relies on them.
  await db.insert(schema.mandates).values([
    {
      id: id("mnd", now + 70),
      tenantId,
      principalRef: customerRef,
      agentIdentity: "agent:quoting",
      scopeJson: JSON.stringify({ modules: ["dist"], productLines: ["motor"] }),
      spendCapMinor: 500_000,
      currency: "AED",
      verificationRef: "uae-pass:rania.haddad",
      expiry: now + 90 * DAY,
      status: "active",
      createdAt: now - 3 * DAY
    },
    {
      id: id("mnd", now + 71),
      tenantId,
      principalRef: `user:${retention}`,
      agentIdentity: "agent:renewal",
      scopeJson: JSON.stringify({ modules: ["orbit"], teamIds: [ctx.teams.retention] }),
      spendCapMinor: 0,
      currency: "AED",
      // A zero cap is the point: the renewal agent may draft and send nothing
      // that costs money, so the mandate proves the boundary rather than a budget.
      expiry: now + 180 * DAY,
      status: "active",
      createdAt: now - 30 * DAY
    },
    {
      id: id("mnd", now + 72),
      tenantId,
      principalRef: `provider:${ctx.providers.meridian}`,
      agentIdentity: "agent:quoting",
      scopeJson: JSON.stringify({ modules: ["dist"], productLines: ["motor", "travel"] }),
      spendCapMinor: 2_500_000,
      currency: "AED",
      verificationRef: "contract:meridian-embed-2026",
      expiry: now + 300 * DAY,
      status: "active",
      createdAt: now - 70 * DAY
    },
    {
      id: id("mnd", now + 73),
      tenantId,
      principalRef: `user:${marketer}`,
      agentIdentity: "agent:creative",
      scopeJson: JSON.stringify({ modules: ["signal"] }),
      spendCapMinor: 1_000_000,
      currency: "AED",
      expiry: now - 10 * DAY,
      // Left expired rather than deleted: the console should show what lapsed,
      // because a lapsed mandate is the usual reason an agent stopped acting.
      status: "expired",
      createdAt: now - 200 * DAY
    },
    {
      id: id("mnd", now + 74),
      tenantId,
      principalRef: `user:${partners}`,
      agentIdentity: "agent:copilot",
      scopeJson: JSON.stringify({ modules: ["axis"], teamIds: [ctx.teams.motor] }),
      spendCapMinor: 250_000,
      currency: "AED",
      expiry: now + 45 * DAY,
      status: "revoked",
      createdAt: now - 100 * DAY
    }
  ]);

  /* ---------------------------------------------- identity verifications */
  // H5 seam. Evidence, not a boolean: the level is what a downstream decision
  // is allowed to lean on, and it decays, which is why expiry is a column.
  await db.insert(schema.identityVerifications).values([
    {
      id: id("idv", now + 80),
      tenantId,
      subjectRef: customerRef,
      method: "uae_pass",
      evidenceLevel: "high",
      providerRef: "uae-pass:2601-88412",
      expiry: now + 365 * DAY,
      createdAt: now - 3 * DAY
    },
    {
      id: id("idv", now + 81),
      tenantId,
      subjectRef: customerRef,
      method: "document_scan",
      evidenceLevel: "substantial",
      providerRef: "kyc-vendor:scan-77120",
      expiry: now + 700 * DAY,
      createdAt: now - 3 * DAY
    },
    {
      id: id("idv", now + 82),
      tenantId,
      subjectRef: customerRef,
      method: "otp_sms",
      // A phone OTP proves possession of a number and nothing else, so it can
      // open a session but must never carry a bind on its own.
      evidenceLevel: "low",
      providerRef: "+9715*****567",
      expiry: now + 30 * DAY,
      createdAt: now - 4 * DAY
    },
    {
      id: id("idv", now + 83),
      tenantId,
      subjectRef: `user:${agent}`,
      method: "staff_mfa",
      evidenceLevel: "substantial",
      providerRef: "idp:gonxt.ae",
      expiry: now + 90 * DAY,
      createdAt: now - 20 * DAY
    },
    {
      id: id("idv", now + 84),
      tenantId,
      subjectRef: `user:${controller}`,
      method: "staff_mfa",
      evidenceLevel: "high",
      providerRef: "idp:gonxt.ae",
      expiry: now + 90 * DAY,
      createdAt: now - 20 * DAY
    },
    {
      id: id("idv", now + 85),
      tenantId,
      subjectRef: `provider:${ctx.providers.cedar}`,
      method: "trade_licence",
      evidenceLevel: "substantial",
      providerRef: "dubai-ded:CN-1188402",
      // Already lapsed: the partner file is due a refresh, and this is where an
      // operator finds that out before the next settlement run.
      expiry: now - 15 * DAY,
      createdAt: now - 380 * DAY
    }
  ]);

  /* ------------------------------------------------------------ memories */
  // H11 seam. Purpose-bound and deletable by design: each row names where it
  // came from and what it may be used for, so erasure can reach in cleanly.
  await db.insert(schema.memories).values([
    {
      id: id("mem", now + 90),
      tenantId,
      subjectRef: customerRef,
      kind: "preference",
      contentJson: JSON.stringify({ preferredChannel: "whatsapp", contactWindow: "18:00-21:00 GST" }),
      provenance: "stated_by_customer",
      sensitivity: "low",
      purposesJson: JSON.stringify({ marketing: false, profiling: false, dataSharing: false }),
      expiry: now + 730 * DAY,
      createdAt: now - 3 * DAY
    },
    {
      id: id("mem", now + 91),
      tenantId,
      subjectRef: customerRef,
      kind: "preference",
      contentJson: JSON.stringify({ language: "en", correspondence: "en", callsIn: "ar" }),
      provenance: "stated_by_customer",
      sensitivity: "low",
      purposesJson: JSON.stringify({ marketing: false, profiling: false, dataSharing: false }),
      createdAt: now - 3 * DAY
    },
    {
      id: id("mem", now + 92),
      tenantId,
      subjectRef: customerRef,
      kind: "context",
      contentJson: JSON.stringify({
        household: "villa, Al Barsha",
        vehicles: 1,
        note: "Mentioned a second car arriving in spring."
      }),
      provenance: "agent_note",
      // Household detail is what the cross-sell reads, so it is marked above
      // low and carries an expiry rather than living forever.
      sensitivity: "medium",
      purposesJson: JSON.stringify({ marketing: true, profiling: true, dataSharing: false }),
      expiry: now + 365 * DAY,
      createdAt: now - 2 * DAY
    },
    {
      id: id("mem", now + 93),
      tenantId,
      subjectRef: customerRef,
      kind: "objection",
      contentJson: JSON.stringify({ objection: "excess_too_high", resolvedBy: "agency_repair_explained" }),
      provenance: "conversation_summary",
      sensitivity: "low",
      purposesJson: JSON.stringify({ marketing: false, profiling: true, dataSharing: false }),
      expiry: now + 365 * DAY,
      createdAt: now - 1 * DAY
    },
    {
      id: id("mem", now + 94),
      tenantId,
      subjectRef: `provider:${ctx.providers.cedar}`,
      kind: "partner_behaviour",
      contentJson: JSON.stringify({ medianQuoteLatencyMs: 1_250, declineRate: 0.07 }),
      provenance: "derived_from_events",
      sensitivity: "low",
      purposesJson: JSON.stringify({ marketing: false, profiling: false, dataSharing: false }),
      createdAt: now - 7 * DAY
    },
    {
      id: id("mem", now + 95),
      tenantId,
      subjectRef: `user:${agent}`,
      kind: "working_style",
      contentJson: JSON.stringify({ prefersCompactTables: true, dismissesGhostText: "in_notes_field" }),
      provenance: "derived_from_interaction",
      sensitivity: "low",
      purposesJson: JSON.stringify({ marketing: false, profiling: true, dataSharing: false }),
      createdAt: now - 10 * DAY
    },
    {
      id: id("mem", now + 96),
      tenantId,
      subjectRef: customerRef,
      kind: "claim_history",
      contentJson: JSON.stringify({ claimsLast3y: 0, ncdYears: 5 }),
      provenance: "underwriter_declaration",
      // Claims history is what pricing leans on, so it is the most sensitive
      // memory here and the one an erasure request is most likely to name.
      sensitivity: "high",
      purposesJson: JSON.stringify({ marketing: false, profiling: true, dataSharing: true }),
      expiry: now + 1_095 * DAY,
      createdAt: now - 3 * DAY
    }
  ]);

  /* -------------------------------------------------------------- lenses */
  // docs/15 §5. One row per user by construction, so each of these belongs to a
  // different person and shows what that role actually pinned.
  await db.insert(schema.lenses).values([
    {
      id: id("lns", now + 100),
      tenantId,
      userId: agent,
      lensJson: JSON.stringify({
        workspace: "axis",
        pinned: ["cases", "quotes", "tasks"],
        hidden: ["escrow"],
        density: "compact",
        savedViews: [
          { id: "mine-open", name: "My open cases", route: "/axis/cases", query: "status=open&owner=me" }
        ]
      }),
      updatedAt: now - 2 * DAY
    },
    {
      id: id("lns", now + 101),
      tenantId,
      userId: lead,
      lensJson: JSON.stringify({
        workspace: "axis",
        pinned: ["approvals", "cases", "sla-breaches"],
        hidden: [],
        density: "comfortable",
        savedViews: [
          { id: "pending", name: "Awaiting my decision", route: "/admin/approvals", query: "decision=pending" }
        ]
      }),
      updatedAt: now - 5 * HOUR
    },
    {
      id: id("lns", now + 102),
      tenantId,
      userId: retention,
      lensJson: JSON.stringify({
        workspace: "orbit",
        pinned: ["renewals", "conversations"],
        hidden: ["partners"],
        density: "compact",
        savedViews: [
          { id: "due-30", name: "Expiring in 30 days", route: "/orbit/renewals", query: "window=30" }
        ]
      }),
      updatedAt: now - 4 * HOUR
    },
    {
      id: id("lns", now + 103),
      tenantId,
      userId: controller,
      lensJson: JSON.stringify({
        workspace: "ledger",
        pinned: ["journals", "settlements", "client-money"],
        hidden: [],
        density: "compact",
        savedViews: [
          { id: "unmatched", name: "Unmatched receipts", route: "/ledger/recon", query: "state=unmatched" }
        ]
      }),
      updatedAt: now - 1 * DAY
    },
    {
      id: id("lns", now + 104),
      tenantId,
      userId: exec,
      lensJson: JSON.stringify({
        workspace: "north",
        pinned: ["briefings", "anomalies"],
        hidden: ["experiments"],
        // The executive view is the one place comfortable density is the right
        // default: fewer rows, read on a phone, not worked through.
        density: "comfortable",
        savedViews: []
      }),
      updatedAt: now - 3 * DAY
    },
    {
      id: id("lns", now + 105),
      tenantId,
      userId: compliance,
      lensJson: JSON.stringify({
        workspace: "compliance",
        pinned: ["dsar-requests", "guardrail-events", "audit-log"],
        hidden: [],
        density: "compact",
        savedViews: [
          { id: "blocks", name: "Blocked outputs", route: "/admin/guardrail-events", query: "severity=block" }
        ]
      }),
      updatedAt: now - 2 * HOUR
    }
  ]);

  /* ----------------------------------------------------------- rulepacks */
  // H12 seam: regulation as data. A pack is pasted in whole and dated, never
  // authored rule by rule, and a superseded pack stays because a decision taken
  // last quarter has to be replayable against the rules that were live then.
  await db.insert(schema.rulepacks).values([
    {
      id: id("rpk", now + 110),
      tenantId,
      market: "AE",
      version: "2026.1",
      effectiveAt: now - 6 * DAY,
      rulesJson: JSON.stringify({
        disclosure: { comparisonBasis: "required", commissionDisclosure: "on_request" },
        coolingOff: { days: 5, appliesTo: ["motor", "home", "travel"] },
        advice: { regulatedAdviceRequiresLicensedHuman: true }
      }),
      createdAt: now - 20 * DAY
    },
    {
      id: id("rpk", now + 111),
      tenantId,
      market: "AE",
      version: "2025.2",
      // Superseded by 2026.1 above, kept for replay rather than deleted.
      effectiveAt: now - 200 * DAY,
      rulesJson: JSON.stringify({
        disclosure: { comparisonBasis: "required", commissionDisclosure: "none" },
        coolingOff: { days: 5, appliesTo: ["motor", "home"] },
        advice: { regulatedAdviceRequiresLicensedHuman: true }
      }),
      createdAt: now - 220 * DAY
    },
    {
      id: id("rpk", now + 112),
      tenantId,
      market: "SA",
      version: "2026.1",
      // Dated forward: the pack for the next market is loaded before the desk
      // opens there, so nothing is authored under time pressure on launch day.
      effectiveAt: now + 60 * DAY,
      rulesJson: JSON.stringify({
        disclosure: { comparisonBasis: "required", commissionDisclosure: "required" },
        coolingOff: { days: 7, appliesTo: ["motor"] },
        advice: { regulatedAdviceRequiresLicensedHuman: true },
        localisation: { arabicContractMandatory: true }
      }),
      createdAt: now - 12 * DAY
    },
    {
      id: id("rpk", now + 113),
      tenantId,
      market: "AE-DIFC",
      version: "2026.1",
      effectiveAt: now - 30 * DAY,
      rulesJson: JSON.stringify({
        disclosure: { comparisonBasis: "required", commissionDisclosure: "required" },
        coolingOff: { days: 14, appliesTo: ["life", "health"] },
        advice: { regulatedAdviceRequiresLicensedHuman: true }
      }),
      createdAt: now - 35 * DAY
    },
    {
      id: id("rpk", now + 114),
      tenantId,
      market: "EG",
      version: "2025.1",
      effectiveAt: now - 400 * DAY,
      rulesJson: JSON.stringify({
        disclosure: { comparisonBasis: "optional", commissionDisclosure: "none" },
        coolingOff: { days: 0, appliesTo: [] },
        advice: { regulatedAdviceRequiresLicensedHuman: true }
      }),
      createdAt: now - 410 * DAY
    }
  ]);

  /* ---------------------------------------------------------------- runs */
  // What the seven seeded agents actually did. The states span the full set on
  // purpose: a console filtered to "failed" that finds nothing teaches an
  // operator that failures do not happen, which is the wrong lesson.
  const runQuoting = id("air", now + 120);
  const runRenewal = id("air", now + 123);
  const runCreativeRefused = id("air", now + 124);
  const runDiscovery = id("air", now + 125);
  const runBriefing = id("air", now + 126);
  const runReconFailed = id("air", now + 127);
  const runQa = id("air", now + 128);
  const runQuotingStopped = id("air", now + 129);
  const runCreativeCancelled = id("air", now + 131);

  await db.insert(schema.aiRuns).values([
    {
      id: runQuoting,
      tenantId,
      agentKey: "quoting",
      module: "dist",
      purpose: "quote.compare",
      subjectRef: quoteRef,
      // Triggered by the fan-out completing, not by a person: the comparison is
      // written before the customer opens the page.
      actorRef: "system:dist-fanout",
      autonomyLevel: "suggest",
      trigger: "event",
      state: "succeeded",
      inputHash: await digest("run.quoting.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/quote-compare.json`,
      confidence: 78,
      evidenceJson: JSON.stringify([
        { kind: "quote", ref: quoteRef },
        { kind: "offering", ref: `offerings:${ctx.offerings.cedarMotor}` },
        { kind: "offering", ref: `offerings:${ctx.offerings.falconMotor}` }
      ]),
      tokensIn: 2_140,
      tokensOut: 388,
      costMicro: 1_820,
      latencyMs: 2_310,
      startedAt: now + 20_000,
      endedAt: now + 22_310
    },
    {
      id: runRenewal,
      tenantId,
      agentKey: "renewal",
      module: "orbit",
      purpose: "renewal.outreach_draft",
      subjectRef: renewalRef,
      actorRef: "system:orbit-tick",
      autonomyLevel: "suggest",
      trigger: "schedule",
      state: "succeeded",
      inputHash: await digest("run.renewal.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/renewal-draft.json`,
      confidence: 66,
      evidenceJson: JSON.stringify([{ kind: "policy", ref: renewalRef }]),
      tokensIn: 1_204,
      tokensOut: 262,
      costMicro: 410,
      latencyMs: 880,
      startedAt: now - 4 * HOUR,
      endedAt: now - 4 * HOUR + 880
    },
    {
      id: runCreativeRefused,
      tenantId,
      agentKey: "creative",
      module: "signal",
      purpose: "creative.variant",
      subjectRef: `campaigns:motor-jan`,
      actorRef: `user:${marketer}`,
      autonomyLevel: "suggest",
      trigger: "user",
      // Refused rather than failed: the model answered, the guardrail stopped
      // the answer. The block below is the same event from the other side.
      state: "refused",
      inputHash: await digest("run.creative.input"),
      confidence: 40,
      errorCode: "guardrail_block",
      tokensIn: 890,
      tokensOut: 142,
      costMicro: 720,
      latencyMs: 1_460,
      startedAt: now - 2 * HOUR,
      endedAt: now - 2 * HOUR + 1_460
    },
    {
      id: runDiscovery,
      tenantId,
      agentKey: "discovery",
      module: "scout",
      purpose: "market.scan",
      actorRef: "system:scout-tick",
      autonomyLevel: "suggest",
      trigger: "schedule",
      state: "succeeded",
      inputHash: await digest("run.discovery.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/market-scan.json`,
      confidence: 58,
      tokensIn: 8_402,
      tokensOut: 1_940,
      costMicro: 11_200,
      latencyMs: 12_800,
      startedAt: now - 1 * DAY,
      endedAt: now - 1 * DAY + 12_800
    },
    {
      id: runBriefing,
      tenantId,
      agentKey: "briefing",
      module: "north",
      purpose: "exec.briefing",
      subjectRef: `north-briefings:2026-01-04`,
      actorRef: "system:north-tick",
      autonomyLevel: "suggest",
      trigger: "schedule",
      state: "succeeded",
      inputHash: await digest("run.briefing.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/briefing-2026-01-04.json`,
      confidence: 81,
      tokensIn: 6_120,
      tokensOut: 1_402,
      costMicro: 8_400,
      latencyMs: 9_600,
      startedAt: now - 3 * DAY,
      endedAt: now - 3 * DAY + 9_600
    },
    {
      id: runReconFailed,
      tenantId,
      agentKey: "recon",
      module: "ledger",
      purpose: "recon.match",
      subjectRef: `settlements:cedar-2512`,
      actorRef: "system:ledger-tick",
      autonomyLevel: "suggest",
      trigger: "schedule",
      // The provider dropped the connection mid-call; nothing was written, and
      // the next tick will retry. Failure here is infrastructure, not judgement.
      state: "failed",
      inputHash: await digest("run.recon.input"),
      errorCode: "provider_error",
      tokensIn: 1_840,
      tokensOut: 0,
      costMicro: 300,
      latencyMs: 30_020,
      startedAt: now - 8 * HOUR,
      endedAt: now - 8 * HOUR + 30_020
    },
    {
      id: runQa,
      tenantId,
      agentKey: "qa",
      module: "core",
      purpose: "output.review",
      subjectRef: `ai_runs:${runRenewal}`,
      actorRef: "api:qvk_live_a1b2c3d4",
      autonomyLevel: "suggest",
      trigger: "api",
      state: "succeeded",
      inputHash: await digest("run.qa.input"),
      outputRef: `r2:t/${tenantId}/ai/runs/qa-review.json`,
      confidence: 92,
      tokensIn: 1_602,
      tokensOut: 208,
      costMicro: 1_180,
      latencyMs: 1_720,
      startedAt: now - 4 * HOUR + MINUTE,
      endedAt: now - 4 * HOUR + MINUTE + 1_720
    },
    {
      id: runQuotingStopped,
      tenantId,
      agentKey: "quoting",
      module: "dist",
      purpose: "quote.compare",
      subjectRef: `quote-requests:bulk-import-2601`,
      actorRef: "api:qvk_live_e5f6g7h8",
      autonomyLevel: "suggest",
      trigger: "api",
      // The daily ceiling caught a bulk import mid-flight. Stopping is the
      // designed behaviour, so the row records it as a state and not an error.
      state: "budget_stopped",
      inputHash: await digest("run.quoting.bulk.input"),
      errorCode: "budget_exceeded",
      tokensIn: 12_400,
      tokensOut: 0,
      costMicro: 14_800,
      latencyMs: 640,
      startedAt: now - 26 * HOUR,
      endedAt: now - 26 * HOUR + 640
    },
    {
      id: runCreativeCancelled,
      tenantId,
      agentKey: "creative",
      module: "signal",
      purpose: "creative.variant",
      subjectRef: `campaigns:renewal-nudge`,
      actorRef: `user:${marketer}`,
      autonomyLevel: "suggest",
      trigger: "user",
      // Cancelled by the person who started it, which is a different thing from
      // refused: nothing was wrong with the request, they changed their mind.
      state: "cancelled",
      inputHash: await digest("run.creative.cancelled.input"),
      tokensIn: 420,
      tokensOut: 0,
      costMicro: 180,
      latencyMs: 900,
      startedAt: now - 5 * HOUR,
      endedAt: now - 5 * HOUR + 900
    }
  ]);

  /* ---------------------------------------------------------- tool calls */
  // Every tool an agent reached for, in sequence, with the consequential ones
  // carrying an approval id — no side effect without one. Tool names come from
  // the allowlists the core seed gave these agents, not from invention.
  await db.insert(schema.aiToolCalls).values([
    {
      id: id("tlc", now + 140),
      tenantId,
      runId: runQuoting,
      seq: 1,
      tool: "dist.quote_requests.read",
      argsHash: await digest("tool.quoting.1"),
      argsRedactedJson: JSON.stringify({ requestId: quoteRequestId }),
      outcome: "ok",
      resultHash: await digest("tool.quoting.1.result"),
      durationMs: 42,
      ts: now + 20_100
    },
    {
      id: id("tlc", now + 141),
      tenantId,
      runId: runQuoting,
      seq: 2,
      tool: "dist.offerings.read",
      argsHash: await digest("tool.quoting.2"),
      argsRedactedJson: JSON.stringify({ productLine: "motor", panel: 4 }),
      outcome: "ok",
      resultHash: await digest("tool.quoting.2.result"),
      durationMs: 68,
      ts: now + 20_300
    },
    {
      id: id("tlc", now + 142),
      tenantId,
      runId: runQuoting,
      seq: 3,
      tool: "dist.next_best_offers.propose",
      argsHash: await digest("tool.quoting.3"),
      argsRedactedJson: JSON.stringify({ customerRef: "[redacted]", productLine: "home" }),
      // Proposing is not selling: the offer is written for a human to raise, so
      // it stays non-consequential even though it touches the customer record.
      outcome: "ok",
      resultHash: await digest("tool.quoting.3.result"),
      durationMs: 96,
      ts: now + 21_000
    },
    {
      id: id("tlc", now + 147),
      tenantId,
      runId: runRenewal,
      seq: 1,
      tool: "orbit.renewals.read",
      argsHash: await digest("tool.renewal.1"),
      argsRedactedJson: JSON.stringify({ windowDays: 30 }),
      outcome: "ok",
      resultHash: await digest("tool.renewal.1.result"),
      durationMs: 44,
      ts: now - 4 * HOUR + 120
    },
    {
      id: id("tlc", now + 148),
      tenantId,
      runId: runRenewal,
      seq: 2,
      tool: "orbit.conversations.reply",
      argsHash: await digest("tool.renewal.2"),
      argsRedactedJson: JSON.stringify({ channel: "whatsapp", to: "[redacted]" }),
      // Outbound send is consequential by definition (CLAUDE.md rule 4), and
      // this agent is suggest-only, so the draft was written and nothing sent.
      consequential: true,
      outcome: "blocked",
      durationMs: 8,
      ts: now - 4 * HOUR + 800
    },
    {
      id: id("tlc", now + 149),
      tenantId,
      runId: runCreativeRefused,
      seq: 1,
      tool: "signal.campaigns.read",
      argsHash: await digest("tool.creative.1"),
      argsRedactedJson: JSON.stringify({ campaign: "motor-jan" }),
      outcome: "ok",
      resultHash: await digest("tool.creative.1.result"),
      durationMs: 33,
      ts: now - 2 * HOUR + 200
    },
    {
      id: id("tlc", now + 150),
      tenantId,
      runId: runCreativeRefused,
      seq: 2,
      tool: "signal.creatives.write",
      argsHash: await digest("tool.creative.2"),
      argsRedactedJson: JSON.stringify({ campaign: "motor-jan", variant: "b" }),
      consequential: true,
      // Blocked by the guardrail before the write, which is why the run above
      // reads refused rather than succeeded with a bad artefact in it.
      outcome: "blocked",
      durationMs: 6,
      ts: now - 2 * HOUR + 1_400
    },
    {
      id: id("tlc", now + 151),
      tenantId,
      runId: runReconFailed,
      seq: 1,
      tool: "ledger.settlements.read",
      argsHash: await digest("tool.recon.1"),
      argsRedactedJson: JSON.stringify({ statement: "cedar-2512" }),
      // The tool itself is what failed: the upstream statement API timed out,
      // and the run could not proceed past it.
      outcome: "error",
      durationMs: 30_000,
      ts: now - 8 * HOUR + 20
    }
  ]);

  /* --------------------------------------------------------- suggestions */
  // The receipt for the ambient grammar (docs/15 §4). Dismissals are recorded
  // as carefully as acceptances, because a surface that is mostly dismissed has
  // not earned its place and this table is the only thing that will say so.
  await db.insert(schema.aiSuggestions).values([
    {
      id: id("sug", now + 160),
      tenantId,
      runId: runQuoting,
      surface: "chip",
      module: "dist",
      subjectRef: quoteRef,
      userId: agent,
      contentRef: `r2:t/${tenantId}/ai/suggestions/why-cedar.json`,
      outcome: "accepted",
      shownAt: now + 25_000,
      resolvedAt: now + 41_000
    },
    {
      id: id("sug", now + 161),
      tenantId,
      runId: runQuoting,
      surface: "chip",
      module: "dist",
      subjectRef: customerRef,
      userId: agent,
      contentRef: `r2:t/${tenantId}/ai/suggestions/home-cross-sell.json`,
      // Shown and not yet answered: the cross-sell chip sits on the case for
      // the agent's next call rather than expiring on the spot.
      outcome: "shown",
      shownAt: now + 30_000
    },
    {
      id: id("sug", now + 164),
      tenantId,
      runId: runRenewal,
      surface: "draft",
      module: "orbit",
      subjectRef: renewalRef,
      userId: retention,
      contentRef: `r2:t/${tenantId}/ai/suggestions/renewal-message.json`,
      outcome: "accepted",
      shownAt: now - 4 * HOUR + 1_000,
      resolvedAt: now - 3 * HOUR
    },
    {
      id: id("sug", now + 165),
      tenantId,
      runId: runRenewal,
      surface: "chip",
      module: "orbit",
      subjectRef: renewalRef,
      userId: retention,
      outcome: "edited",
      editDistance: 26,
      shownAt: now - 4 * HOUR + 1_200,
      resolvedAt: now - 3 * HOUR + 5 * MINUTE
    },
    {
      id: id("sug", now + 166),
      tenantId,
      runId: runBriefing,
      surface: "forecast",
      module: "north",
      subjectRef: `north-briefings:2026-01-04`,
      userId: exec,
      contentRef: `r2:t/${tenantId}/ai/suggestions/motor-gwp-forecast.json`,
      outcome: "accepted",
      shownAt: now - 3 * DAY + 10_000,
      resolvedAt: now - 3 * DAY + 2 * HOUR
    },
    {
      id: id("sug", now + 167),
      tenantId,
      runId: runDiscovery,
      surface: "filter",
      module: "scout",
      userId: scout,
      // Nobody answered it before the window closed. Expired is not dismissed:
      // one is a judgement, the other is a surface shown at the wrong moment.
      outcome: "expired",
      shownAt: now - 1 * DAY + 13_000,
      resolvedAt: now - 12 * HOUR
    },
    {
      id: id("sug", now + 168),
      tenantId,
      runId: runCreativeCancelled,
      surface: "draft",
      module: "signal",
      subjectRef: `campaigns:renewal-nudge`,
      userId: marketer,
      outcome: "dismissed",
      shownAt: now - 5 * HOUR + 1_000,
      resolvedAt: now - 5 * HOUR + 30_000
    },
    {
      id: id("sug", now + 169),
      tenantId,
      surface: "ghost_text",
      module: "core",
      subjectRef: customerRef,
      userId: lead,
      // No run id: this one came from the cached completion the surface keeps
      // for repeat prefixes, so there is nothing to trace back to.
      outcome: "accepted",
      shownAt: now - 90 * MINUTE,
      resolvedAt: now - 89 * MINUTE
    }
  ]);

  /* --------------------------------------------------------------- evals */
  // The scoreboard for eval-first development (CLAUDE.md §4). The failing rows
  // are the reason this table is worth opening: a suite that is green forever
  // is a suite that stopped asking anything hard.
  const gitSha = "9f2c41a";
  await db.insert(schema.aiEvals).values([
    {
      id: id("evl", now + 180),
      tenantId,
      suite: "quoting.comparison",
      caseKey: "motor.cheapest_vs_best_value",
      agentKey: "quoting",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 88,
      passed: true,
      thresholdScore: 80,
      detailJson: JSON.stringify({ groundedness: 0.94, coverageMentions: 4, hallucinatedPrices: 0 }),
      gitSha,
      ts: now - 2 * DAY
    },
    {
      id: id("evl", now + 181),
      tenantId,
      suite: "quoting.comparison",
      caseKey: "motor.declined_offer_explained",
      agentKey: "quoting",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 74,
      // Below the bar: the model summarises a declined quote without saying why
      // it was declined, which is exactly the failure the case was written for.
      passed: false,
      thresholdScore: 80,
      detailJson: JSON.stringify({
        groundedness: 0.88,
        missing: ["decline_reason"],
        note: "Reason omitted in 3 of 10 samples."
      }),
      gitSha,
      ts: now - 2 * DAY
    },
    {
      id: id("evl", now + 182),
      tenantId,
      suite: "quoting.comparison",
      caseKey: "motor.arabic_parity",
      agentKey: "quoting",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 83,
      passed: true,
      thresholdScore: 80,
      detailJson: JSON.stringify({ localeMatch: 1.0, termConsistency: 0.91 }),
      gitSha,
      ts: now - 2 * DAY
    },
    {
      id: id("evl", now + 183),
      tenantId,
      suite: "copilot.case_summary",
      caseKey: "axis.summary_no_advice",
      agentKey: "copilot",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 95,
      passed: true,
      thresholdScore: 90,
      detailJson: JSON.stringify({ regulatedAdviceLeaks: 0, factualErrors: 0 }),
      gitSha,
      ts: now - 2 * DAY
    },
    {
      id: id("evl", now + 184),
      tenantId,
      suite: "copilot.case_summary",
      caseKey: "axis.pii_redaction",
      agentKey: "copilot",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 100,
      passed: true,
      // The redaction case is held at 100 deliberately: anything below it is a
      // leak, so a threshold with slack in it would be meaningless.
      thresholdScore: 100,
      detailJson: JSON.stringify({ leakedIdentifiers: 0, samples: 40 }),
      gitSha,
      ts: now - 2 * DAY
    },
    {
      id: id("evl", now + 185),
      tenantId,
      suite: "renewal.outreach",
      caseKey: "orbit.no_price_promise",
      agentKey: "renewal",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      score: 79,
      passed: false,
      thresholdScore: 85,
      detailJson: JSON.stringify({
        promisedUnquotedPrice: 2,
        samples: 40,
        note: "The fast tier invents a renewal premium when the sheet has none."
      }),
      gitSha,
      ts: now - 1 * DAY
    },
    {
      id: id("evl", now + 186),
      tenantId,
      suite: "renewal.outreach",
      caseKey: "orbit.tone_and_length",
      agentKey: "renewal",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      score: 91,
      passed: true,
      thresholdScore: 75,
      detailJson: JSON.stringify({ avgSentences: 3.2, readingLevel: "B1" }),
      gitSha,
      ts: now - 1 * DAY
    },
    {
      id: id("evl", now + 187),
      tenantId,
      suite: "creative.compliance",
      caseKey: "signal.no_regulated_claim",
      agentKey: "creative",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 97,
      passed: true,
      thresholdScore: 95,
      detailJson: JSON.stringify({ regulatedClaims: 0, comparativeClaimsWithSource: 12 }),
      gitSha,
      ts: now - 1 * DAY
    },
    {
      id: id("evl", now + 188),
      tenantId,
      suite: "qa.review",
      caseKey: "core.catches_planted_violation",
      agentKey: "qa",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 89,
      passed: true,
      thresholdScore: 85,
      detailJson: JSON.stringify({ recall: 0.93, precision: 0.86 }),
      gitSha,
      ts: now - 1 * DAY
    },
    {
      id: id("evl", now + 189),
      tenantId,
      suite: "recon.matching",
      caseKey: "ledger.partial_settlement",
      agentKey: "recon",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      score: 86,
      passed: true,
      thresholdScore: 80,
      detailJson: JSON.stringify({ matchedLines: 118, falseMatches: 0 }),
      gitSha,
      ts: now - 1 * DAY
    },
    {
      id: id("evl", now + 190),
      tenantId,
      suite: "briefing.accuracy",
      caseKey: "north.numbers_match_source",
      agentKey: "briefing",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 93,
      passed: true,
      thresholdScore: 90,
      detailJson: JSON.stringify({ numericMismatches: 0, unsourcedClaims: 0 }),
      gitSha,
      ts: now - 3 * DAY
    },
    {
      id: id("evl", now + 191),
      tenantId,
      suite: "quoting.comparison",
      caseKey: "motor.declined_offer_explained",
      agentKey: "quoting",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      score: 68,
      passed: false,
      thresholdScore: 80,
      // The same case a week earlier and worse. Two dated rows for one case are
      // what turn a score into a trend, which is the only reading that matters.
      detailJson: JSON.stringify({ groundedness: 0.81, missing: ["decline_reason", "referral_reason"] }),
      gitSha: "4d81b07",
      ts: now - 9 * DAY
    }
  ]);

  /* --------------------------------------------------- knowledge sources */
  // The retrieval corpus registry. Chunks live in the vector index; these rows
  // are the tenant-scoped, permissioned handles to them — including the ones
  // that are stale or broken, which is when this screen is actually opened.
  await db.insert(schema.aiKnowledgeSources).values([
    {
      id: id("kns", now + 200),
      tenantId,
      name: "Cedar Motor Comprehensive — wording v4",
      kind: "policy_wording",
      uri: `r2:t/${tenantId}/wordings/cedar-motor-comprehensive-v4.pdf`,
      locale: "en",
      piiLevel: "none",
      chunkCount: 412,
      indexNamespace: `${tenantId}:wordings`,
      status: "ready",
      lastIndexedAt: now - 58 * DAY,
      createdAt: now - 60 * DAY
    },
    {
      id: id("kns", now + 201),
      tenantId,
      name: "Cedar Motor Comprehensive — wording v4 (Arabic)",
      kind: "policy_wording",
      uri: `r2:t/${tenantId}/wordings/cedar-motor-comprehensive-v4-ar.pdf`,
      // Arabic is a first-class locale, so the corpus carries both or the
      // Arabic answer quietly falls back to an English source.
      locale: "ar",
      piiLevel: "none",
      chunkCount: 398,
      indexNamespace: `${tenantId}:wordings`,
      status: "ready",
      lastIndexedAt: now - 58 * DAY,
      createdAt: now - 60 * DAY
    },
    {
      id: id("kns", now + 202),
      tenantId,
      name: "Motor claims handling SOP",
      kind: "sop",
      uri: `r2:t/${tenantId}/sop/motor-claims-handling.md`,
      locale: "en",
      piiLevel: "none",
      chunkCount: 88,
      indexNamespace: `${tenantId}:sop`,
      status: "ready",
      lastIndexedAt: now - 14 * DAY,
      createdAt: now - 150 * DAY
    },
    {
      id: id("kns", now + 203),
      tenantId,
      name: "Customer FAQ — motor renewals",
      kind: "faq",
      uri: "https://gonxt.ae/help/motor-renewals",
      locale: "en",
      piiLevel: "none",
      chunkCount: 34,
      indexNamespace: `${tenantId}:faq`,
      // The published page changed after the last index run, so the corpus is
      // knowingly behind rather than silently wrong.
      status: "stale",
      lastIndexedAt: now - 45 * DAY,
      createdAt: now - 120 * DAY
    },
    {
      id: id("kns", now + 204),
      tenantId,
      name: "UAE motor insurance regulations 2026.1",
      kind: "regulatory",
      uri: "https://www.centralbank.ae/en/insurance/motor",
      locale: "en",
      piiLevel: "none",
      chunkCount: 206,
      indexNamespace: `${tenantId}:regulatory`,
      status: "ready",
      lastIndexedAt: now - 6 * DAY,
      createdAt: now - 20 * DAY
    },
    {
      id: id("kns", now + 205),
      tenantId,
      name: "Falcon Motor rate card and endorsements",
      kind: "product",
      uri: `r2:t/${tenantId}/products/falcon-motor-rates.xlsx`,
      locale: "en",
      piiLevel: "none",
      chunkCount: 0,
      indexNamespace: `${tenantId}:products`,
      // Mid-flight as the seed clock reads: chunk count fills in as it goes.
      status: "indexing",
      createdAt: now - 20 * MINUTE
    },
    {
      id: id("kns", now + 206),
      tenantId,
      name: "Meridian Bank embedded-journey copy deck",
      kind: "product",
      uri: "https://partners.meridianbank.ae/lyra/copy-deck",
      locale: "en",
      piiLevel: "none",
      chunkCount: 0,
      // The partner's endpoint answered 403 to the crawler; nothing indexed and
      // the failure is on the screen rather than buried in a log.
      status: "failed",
      createdAt: now - 2 * DAY
    },
    {
      id: id("kns", now + 207),
      tenantId,
      name: "Call-centre objection handling transcripts (2025)",
      kind: "sop",
      uri: `r2:t/${tenantId}/sop/objection-transcripts-2025.jsonl`,
      locale: "en",
      // Transcripts carry customer names and numbers, so the corpus is marked
      // and the retrieval path must redact before anything reaches a prompt.
      piiLevel: "high",
      chunkCount: 1_204,
      indexNamespace: `${tenantId}:sop-restricted`,
      status: "ready",
      lastIndexedAt: now - 9 * DAY,
      createdAt: now - 90 * DAY
    }
  ]);

  /* ---------------------------------------------------- guardrail events */
  // Post-flight trips recorded by the gateway. Rules are the real ones the
  // guardrail module enforces, not decorative names — including the two blocks
  // that actually stopped output reaching a person.
  await db.insert(schema.aiGuardrailEvents).values([
    {
      id: id("gre", now + 210),
      tenantId,
      runId: runCreativeRefused,
      rule: "regulated_claim",
      severity: "block",
      // This is the refusal on the creative run above, from the guardrail's
      // side: the draft promised cover the wording does not give.
      detail: "Draft asserted 'full coverage guaranteed' in customer-facing copy.",
      subjectRef: `campaigns:motor-jan`,
      ts: now - 2 * HOUR + 1_400
    },
    {
      id: id("gre", now + 211),
      tenantId,
      runId: runRenewal,
      rule: "hallucinated_placeholder",
      severity: "warn",
      detail: "Renewal draft contained '[premium]' with no value from the source sheet.",
      subjectRef: renewalRef,
      ts: now - 4 * HOUR + 700
    },
    {
      id: id("gre", now + 212),
      tenantId,
      runId: runQuoting,
      rule: "prompt_injection",
      severity: "warn",
      // The injection arrived inside a partner-supplied vehicle description,
      // which is why untrusted input is scanned and not merely trusted.
      detail: "Vehicle notes field contained 'ignore previous instructions'.",
      subjectRef: quoteRef,
      ts: now + 20_500
    },
    {
      id: id("gre", now + 213),
      tenantId,
      rule: "secret_in_output",
      severity: "block",
      detail: "Draft integration guide echoed a live API key prefix; output withheld.",
      subjectRef: `api-keys:qvk_live_a1b2c3d4`,
      ts: now - 14 * DAY + 25 * MINUTE
    },
    {
      id: id("gre", now + 214),
      tenantId,
      runId: runBriefing,
      rule: "hallucinated_placeholder",
      severity: "info",
      // Informational: caught in an internal briefing that never leaves the
      // building, so it is logged for the trend and nothing more.
      detail: "Briefing draft used a rounded figure not present in the rollup.",
      subjectRef: `north-briefings:2026-01-04`,
      ts: now - 3 * DAY + 9_000
    }
  ]);

  /* ------------------------------------------------------- ai audit log */
  // The immutable spine (CLAUDE.md rule 3): every model call the gateway made,
  // hashes only. Cloud routing is what the catalogue actually does — fast tier
  // to llama-3.1-8b, standard and reasoning to llama-3.3-70b.
  const fastModel = "@cf/meta/llama-3.1-8b-instruct-fast";
  const bigModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  await db.insert(schema.aiAuditLog).values([
    {
      id: id("aia", now + 220),
      tenantId,
      module: "dist",
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
      toolCallsJson: JSON.stringify(["dist.quote_requests.read", "dist.offerings.read"]),
      guardrailFlagsJson: JSON.stringify(["prompt_injection"]),
      actorRef: "system:dist-fanout",
      subjectRef: quoteRef,
      outcome: "ok",
      ts: now + 22_310
    },
    {
      id: id("aia", now + 222),
      tenantId,
      module: "orbit",
      purpose: "renewal.outreach_draft",
      model: fastModel,
      provider: "workers-ai",
      // The renewal agent runs on the fast tier: short drafts, high volume, and
      // a human reads every one before it goes anywhere.
      tier: "fast",
      inputHash: await digest("run.renewal.input"),
      outputHash: await digest("aia.renewal.output"),
      tokensIn: 1_204,
      tokensOut: 262,
      costMicro: 410,
      latencyMs: 880,
      guardrailFlagsJson: JSON.stringify(["hallucinated_placeholder"]),
      actorRef: "system:orbit-tick",
      subjectRef: renewalRef,
      outcome: "ok",
      ts: now - 4 * HOUR + 880
    },
    {
      id: id("aia", now + 223),
      tenantId,
      module: "signal",
      purpose: "creative.variant",
      model: bigModel,
      provider: "workers-ai",
      tier: "standard",
      inputHash: await digest("run.creative.input"),
      tokensIn: 890,
      tokensOut: 142,
      costMicro: 720,
      latencyMs: 1_460,
      guardrailFlagsJson: JSON.stringify(["regulated_claim"]),
      actorRef: `user:${marketer}`,
      subjectRef: `campaigns:motor-jan`,
      // No output hash on a refusal: there is no output. The row exists so the
      // refusal is auditable, which is the whole point of writing it here.
      outcome: "refused",
      ts: now - 2 * HOUR + 1_460
    },
    {
      id: id("aia", now + 224),
      tenantId,
      module: "scout",
      purpose: "market.scan",
      model: bigModel,
      provider: "workers-ai",
      tier: "reasoning",
      inputHash: await digest("run.discovery.input"),
      outputHash: await digest("aia.discovery.output"),
      tokensIn: 8_402,
      tokensOut: 1_940,
      costMicro: 11_200,
      latencyMs: 12_800,
      actorRef: "system:scout-tick",
      outcome: "ok",
      ts: now - 1 * DAY + 12_800
    },
    {
      id: id("aia", now + 225),
      tenantId,
      module: "north",
      purpose: "exec.briefing",
      model: bigModel,
      provider: "workers-ai",
      tier: "reasoning",
      inputHash: await digest("run.briefing.input"),
      outputHash: await digest("aia.briefing.output"),
      tokensIn: 6_120,
      tokensOut: 1_402,
      costMicro: 8_400,
      latencyMs: 9_600,
      guardrailFlagsJson: JSON.stringify(["hallucinated_placeholder"]),
      actorRef: "system:north-tick",
      subjectRef: `north-briefings:2026-01-04`,
      outcome: "ok",
      ts: now - 3 * DAY + 9_600
    },
    {
      id: id("aia", now + 226),
      tenantId,
      module: "ledger",
      purpose: "recon.match",
      model: fastModel,
      provider: "workers-ai",
      tier: "fast",
      inputHash: await digest("run.recon.input"),
      tokensIn: 1_840,
      tokensOut: 0,
      costMicro: 300,
      latencyMs: 30_020,
      guardrailFlagsJson: JSON.stringify(["provider_error"]),
      actorRef: "system:ledger-tick",
      subjectRef: `settlements:cedar-2512`,
      outcome: "error",
      ts: now - 8 * HOUR + 30_020
    },
    {
      id: id("aia", now + 227),
      tenantId,
      module: "dist",
      purpose: "quote.compare",
      model: bigModel,
      provider: "workers-ai",
      tier: "standard",
      inputHash: await digest("run.quoting.bulk.input"),
      tokensIn: 12_400,
      tokensOut: 0,
      costMicro: 14_800,
      latencyMs: 640,
      actorRef: "api:qvk_live_e5f6g7h8",
      subjectRef: `quote-requests:bulk-import-2601`,
      // The ceiling stopped it before the provider was called, so the cost is
      // the accounting for what had already been spent that day, not this call.
      outcome: "budget_exceeded",
      ts: now - 26 * HOUR + 640
    },
    {
      id: id("aia", now + 228),
      tenantId,
      module: "core",
      purpose: "output.review",
      model: bigModel,
      provider: "workers-ai",
      tier: "standard",
      inputHash: await digest("run.qa.input"),
      outputHash: await digest("aia.qa.output"),
      tokensIn: 1_602,
      tokensOut: 208,
      costMicro: 1_180,
      latencyMs: 1_720,
      toolCallsJson: JSON.stringify(["ai.runs.read"]),
      actorRef: "api:qvk_live_a1b2c3d4",
      subjectRef: `ai_runs:${runRenewal}`,
      outcome: "ok",
      ts: now - 4 * HOUR + MINUTE + 1_720
    },
    {
      id: id("aia", now + 229),
      tenantId,
      module: "core",
      purpose: "knowledge.embed",
      model: "@cf/baai/bge-m3",
      provider: "workers-ai",
      // Embedding runs on the fast tier and dominates the token count without
      // dominating the cost, which is the shape an operator should recognise.
      tier: "fast",
      inputHash: await digest("aia.embed.input"),
      outputHash: await digest("aia.embed.output"),
      tokensIn: 88_400,
      tokensOut: 0,
      costMicro: 640,
      latencyMs: 4_180,
      actorRef: "system:knowledge-indexer",
      subjectRef: `knowledge-sources:falcon-motor-rates`,
      outcome: "ok",
      ts: now - 18 * MINUTE
    }
  ]);
}
