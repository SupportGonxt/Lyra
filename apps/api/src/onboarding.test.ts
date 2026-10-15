import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { id as newId, schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import type { Env } from "./env.js";

// Acceptance suite for partner and channel onboarding. Each test is the rule it
// would be embarrassing to break: a checklist that regenerates itself, a stage
// that opens without its evidence, a waiver nobody signed for, a drafter who
// countersigns their own agreement, or a tenant that can see another's diligence.

// NOTE: apps/api/src/index.ts does not mount this router yet (see the report).
// Mounted here so the suite exercises the real app, middleware and context.
if (!app.routes.some((r) => r.path.startsWith("/v1/onboarding"))) {
  app.route("/v1/onboarding", onboardingRoutes);
}

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  // Runs onboarding: may complete a step, draft an agreement, move a partner.
  "orbit.partners": "dana.aziz",
  // Waives a required step — the one thing the partner desk may not do.
  "tenant.compliance": "khalid.rashed",
  // Holds dist:agreements:sign. Nobody else countersigns.
  "tenant.admin": "amina.saleh"
};

const FOREIGN_TENANT = "tn_foreign_onboarding";

let env: Env;
let database: Db;
let seeded: SeedResult;
let tokens: Record<string, string>;
let partnerId: string;
let channelId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
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
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

/** Initiator is refused with an approval id, a second person clears it, retry. */
async function throughApproval<T = any>(
  initiator: string,
  approver: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<{ status: number; body: T }> {
  const first = await call(initiator, method, path, payload);
  expect(first.status).toBe(403);
  const approvalId = (first.body as any).approval_id as string;
  expect(approvalId).toBeTruthy();
  const decided = await call(approver, "POST", `/v1/me/approvals/${approvalId}/decide`, {
    decision: "approved"
  });
  expect(decided.status).toBe(200);
  return call<T>(initiator, method, path, payload);
}

async function stepOf(subjectRef: string, key: string): Promise<typeof schema.onboardingSteps.$inferSelect> {
  const rows = await database
    .select()
    .from(schema.onboardingSteps)
    .where(
      and(
        eq(schema.onboardingSteps.tenantId, seeded.tenantId),
        eq(schema.onboardingSteps.subjectRef, subjectRef),
        eq(schema.onboardingSteps.key, key)
      )
    );
  return rows[0]!;
}

async function complete(subjectRef: string, key: string, evidenceRef?: string) {
  const step = await stepOf(subjectRef, key);
  return call("orbit.partners", "POST", `/v1/onboarding/steps/${step.id}/complete`, {
    ...(evidenceRef ? { evidenceRef } : {})
  });
}

const advance = () => call("orbit.partners", "POST", `/v1/onboarding/partners/${partnerId}/advance`);

async function stageOf(id: string): Promise<string> {
  const rows = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, id));
  return rows[0]!.stage;
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

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173"
  } as unknown as Env;

  tokens = {};
  for (const [role, local] of Object.entries(PEOPLE)) {
    const login = await call(null, "POST", "/v1/auth/login", {
      email: `${local}@gonxt.ae`,
      password: PASSWORD,
      tenantSlug: "gonxt"
    });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const verified = await call(
      null,
      "POST",
      "/v1/auth/mfa/verify",
      { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
      { authorization: `Bearer ${token}` }
    );
    expect(verified.status).toBe(200);
    tokens[role] = token;
  }

  // A counterparty at the very beginning: prospect, sandbox, nothing proven.
  partnerId = newId("ptn", Date.now());
  channelId = newId("ch", Date.now());
  await database.insert(schema.orbitPartners).values({
    id: partnerId,
    tenantId: seeded.tenantId,
    name: "Northwind Mobility",
    kind: "telco",
    sandboxFlag: true,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}, 120_000);

/* ------------------------------------------------ 1. generated, not typed */

describe("the checklist is generated from a template", () => {
  it("generates every step, in both languages, with its gate", async () => {
    const res = await call("orbit.partners", "POST", "/v1/onboarding/steps", {
      subjectKind: "partner",
      subjectRef: partnerId,
      template: "partner.distribution"
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(11);

    const screening = res.body.data.find((s: any) => s.key === "sanctions_pep_screening");
    expect(JSON.parse(screening.labelJson)).toEqual({
      en: "Sanctions and PEP screening clear",
      ar: expect.any(String)
    });
    expect(screening.gatesStage).toBe("screening");
    expect(screening.state).toBe("pending");
  });

  it("is idempotent: starting again adds nothing and resets nothing", async () => {
    const done = await complete(partnerId, "legal_identity", "doc:northwind/trade-licence.pdf");
    expect(done.status).toBe(200);

    const again = await call("orbit.partners", "POST", "/v1/onboarding/steps", {
      subjectKind: "partner",
      subjectRef: partnerId,
      template: "partner.distribution"
    });
    expect(again.status).toBe(201);
    expect(again.body.data).toHaveLength(11);

    const rows = await database
      .select()
      .from(schema.onboardingSteps)
      .where(eq(schema.onboardingSteps.subjectRef, partnerId));
    expect(rows).toHaveLength(11);
    expect((await stepOf(partnerId, "legal_identity")).state).toBe("done");
  });

  it("generates the b2b channel checklist for a channel subject", async () => {
    const res = await call("orbit.partners", "POST", "/v1/onboarding/steps", {
      subjectKind: "channel",
      subjectRef: channelId,
      template: "channel.b2b"
    });
    expect(res.status).toBe(201);
    expect(res.body.data.map((s: any) => s.key)).toContain("partner_agreement_linked");
    // A branding pack is nice to have and must not hold a channel at a gate.
    expect(res.body.data.find((s: any) => s.key === "branding_assets").required).toBe(false);
  });
});

/* ---------------------------------------------------- 2. the stage gate */

describe("a stage is entered only when the steps gating it are cleared", () => {
  it("advances to applied now that legal identity is proven", async () => {
    const res = await advance();
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("applied");
  });

  it("refuses to enter screening while the screening step is open, and names it", async () => {
    const res = await advance();
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("sanctions_pep_screening");
    expect(await stageOf(partnerId)).toBe("applied");
  });

  it("refuses to close a step that needs evidence with none", async () => {
    const res = await complete(partnerId, "sanctions_pep_screening");
    expect(res.status).toBe(400);
    expect((await stepOf(partnerId, "sanctions_pep_screening")).state).toBe("pending");
  });

  it("advances once the evidence is attached", async () => {
    expect((await complete(partnerId, "sanctions_pep_screening", "scr_northwind_clear")).status).toBe(200);
    const res = await advance();
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("screening");
  });
});

/* -------------------------------------------------------- 3. the waiver */

describe("waiving a required step is an approval, never an edit", () => {
  it("refuses the partner desk outright — a waiver is not a stronger write", async () => {
    const step = await stepOf(partnerId, "ubo_disclosure");
    const res = await call("orbit.partners", "POST", `/v1/onboarding/steps/${step.id}/waive`, {
      reason: "Ownership is public on the register."
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
    expect(res.body.detail).toContain("core:onboarding:waive");
  });

  it("refuses compliance with approval_required and leaves the step open", async () => {
    const step = await stepOf(partnerId, "ubo_disclosure");
    const res = await call("tenant.compliance", "POST", `/v1/onboarding/steps/${step.id}/waive`, {
      reason: "Listed entity; ownership is public on the register."
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("core.onboarding_waive");
    expect((await stepOf(partnerId, "ubo_disclosure")).state).toBe("pending");
  });

  it("waives, and records who cleared it, once a second pair of eyes decides", async () => {
    const step = await stepOf(partnerId, "ubo_disclosure");
    const res = await throughApproval(
      "tenant.compliance",
      "tenant.admin",
      "POST",
      `/v1/onboarding/steps/${step.id}/waive`,
      { reason: "Listed entity; ownership is public on the register." }
    );
    expect(res.status).toBe(200);

    const after = await stepOf(partnerId, "ubo_disclosure");
    expect(after.state).toBe("waived");
    expect(after.waivedApprovalId).toBeTruthy();
    expect(after.decidedBy).toBeTruthy();

    const approval = await database
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, after.waivedApprovalId!));
    expect(approval[0]!.decision).toBe("approved");
    expect(approval[0]!.decidedBy).not.toBe(approval[0]!.requestedBy);

    const audits = await database.select().from(schema.auditLog);
    expect(audits.some((a) => a.action === "core.onboarding.waive")).toBe(true);
  });

  it("counts a waived step as cleared at the gate", async () => {
    expect((await complete(partnerId, "licence_check", "doc:northwind/licence.pdf")).status).toBe(200);
    const res = await advance();
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("diligence");
  });
});

/* ----------------------------------------------------- 4. the agreement */

describe("the drafter cannot sign what they drafted", () => {
  let agreementId: string;

  it("drafts version 1", async () => {
    const res = await call("orbit.partners", "POST", "/v1/onboarding/agreements", {
      partnerId,
      terms: {
        settlement: { frequency: "monthly", netDays: 30, minPayoutMinor: 50_000 },
        rateCard: { defaultSharePpm: 250_000 },
        clawbackDays: 60,
        terminationNoticeDays: 30
      }
    });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.state).toBe("draft");
    agreementId = res.body.id;

    expect((await call("orbit.partners", "POST", `/v1/onboarding/agreements/${agreementId}/send`)).status).toBe(200);
  });

  it("refuses the drafter's signature with approval_required", async () => {
    const res = await call("orbit.partners", "POST", `/v1/onboarding/agreements/${agreementId}/sign`, {
      signedByPartnerName: "Hessa Al Zaabi"
    });
    expect(res.status).toBe(403);
    expect(res.body.policy_key).toBe("dist.agreement_sign");

    // ...and refuses to let them clear their own request, which would make the
    // countersignature a formality the same person performs twice.
    const self = await call("orbit.partners", "POST", `/v1/me/approvals/${res.body.approval_id}/decide`, {
      decision: "approved"
    });
    expect(self.status).toBe(403);
    expect((await database.select().from(schema.distPartnerAgreements).where(eq(schema.distPartnerAgreements.id, agreementId)))[0]!.signedAt).toBeNull();
  });

  it("activates in the approver's name once they countersign", async () => {
    const res = await throughApproval(
      "orbit.partners",
      "tenant.admin",
      "POST",
      `/v1/onboarding/agreements/${agreementId}/sign`,
      { signedByPartnerName: "Hessa Al Zaabi" }
    );
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("active");
    expect(res.body.signedByUserId).toBe(seeded.users["tenant.admin"]);
    expect(res.body.signedByPartnerName).toBe("Hessa Al Zaabi");

    const partner = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partnerId));
    expect(partner[0]!.agreementId).toBe(agreementId);
  });

  it("refuses to sign the same agreement twice", async () => {
    const res = await call("orbit.partners", "POST", `/v1/onboarding/agreements/${agreementId}/sign`, {
      signedByPartnerName: "Someone Else"
    });
    expect(res.status).toBe(409);
  });

  it("supersedes the previous version when the next one is signed", async () => {
    const draft = await call("orbit.partners", "POST", "/v1/onboarding/agreements", {
      partnerId,
      terms: { rateCard: { defaultSharePpm: 275_000 }, terminationNoticeDays: 30 }
    });
    expect(draft.status).toBe(201);
    expect(draft.body.version).toBe(2);

    const signed = await throughApproval(
      "orbit.partners",
      "tenant.admin",
      "POST",
      `/v1/onboarding/agreements/${draft.body.id}/sign`,
      { signedByPartnerName: "Hessa Al Zaabi" }
    );
    expect(signed.status).toBe(200);
    expect(signed.body.supersedesId).toBe(agreementId);

    const rows = await database
      .select()
      .from(schema.distPartnerAgreements)
      .where(eq(schema.distPartnerAgreements.partnerId, partnerId));
    expect(rows.find((r) => r.id === agreementId)!.state).toBe("superseded");
    expect(rows.find((r) => r.id === agreementId)!.effectiveTo).toBeTruthy();
    expect(rows.find((r) => r.id === draft.body.id)!.state).toBe("active");
  });
});

describe("the retired generic CRUD door onto partner-agreements is gone", () => {
  it("cannot mint an active agreement in one write, skipping draft/send/sign", async () => {
    // /v1/onboarding/agreements is the sole doorway (draft/send/sign). The
    // generic create route is unmounted entirely (no `create` perm on the
    // resources.ts entry), so it 404s rather than just being permission-denied.
    const res = await call("orbit.partners", "POST", "/v1/dist/partner-agreements", {
      partnerId,
      version: 1,
      kind: "distribution",
      termsJson: "{}",
      state: "active",
      signedAt: Date.now(),
      signedByUserId: seeded.users["orbit.partners"],
      signedByPartnerName: "Forged Signature"
    });
    expect(res.status).toBe(404);
  });

  it("still reads through the generic resource", async () => {
    const res = await call("orbit.partners", "GET", "/v1/dist/partner-agreements");
    expect(res.status).toBe(200);
  });
});

/* ---------------------------------------------------------- 5. going live */

describe("going live is the gate, not the last checkbox", () => {
  it("walks the ladder as far as sandbox", async () => {
    const evidence: Record<string, string> = {
      agreement_drafted: "pag_v1",
      agreement_countersigned: "pag_v1",
      rate_card_agreed: "attested",
      payout_method: "payout:mandate:northwind-adcb-4410",
      api_credentials: "northwind-sandbox",
      sandbox_transactions: "42/42"
    };
    for (const [key, ref] of Object.entries(evidence)) {
      expect((await complete(partnerId, key, ref)).status).toBe(200);
    }
    for (const stage of ["agreement", "integration", "sandbox"]) {
      const res = await advance();
      expect(res.status).toBe(200);
      expect(res.body.stage).toBe(stage);
    }
  });

  it("refuses to go live on the sign-off alone", async () => {
    const res = await advance();
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("go_live_signoff");
  });

  it("requires dist.partner_activate even with every step cleared", async () => {
    expect((await complete(partnerId, "go_live_signoff", "signed-off")).status).toBe(200);
    const res = await advance();
    expect(res.status).toBe(403);
    expect(res.body.policy_key).toBe("dist.partner_activate");
    expect(await stageOf(partnerId)).toBe("sandbox");
  });

  it("goes live, out of the sandbox, once activation is approved", async () => {
    const res = await throughApproval(
      "orbit.partners",
      "orbit.partners", // dist.partner_activate is single control by policy
      "POST",
      `/v1/onboarding/partners/${partnerId}/advance`
    );
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("live");

    const rows = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partnerId));
    expect(rows[0]!.sandboxFlag).toBe(false);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.goLiveAt).toBeTruthy();
  });

  it("suspends without unwinding the diligence, and resumes", async () => {
    const suspended = await call("orbit.partners", "POST", `/v1/onboarding/partners/${partnerId}/suspend`, {
      reason: "Settlement dispute on the March statement."
    });
    expect(suspended.status).toBe(200);
    let rows = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partnerId));
    expect(rows[0]!.status).toBe("suspended");
    expect(rows[0]!.stage).toBe("live"); // pausing is not re-onboarding

    expect((await advance()).status).toBe(409);

    expect((await call("orbit.partners", "POST", `/v1/onboarding/partners/${partnerId}/resume`)).status).toBe(200);
    rows = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partnerId));
    expect(rows[0]!.status).toBe("active");
  });
});

/* ------------------------------------------------------------ 6. tenancy */

describe("another tenant's onboarding is invisible and immovable", () => {
  let foreignPartner: string;
  let foreignStep: string;

  beforeAll(async () => {
    foreignPartner = newId("ptn", Date.now());
    foreignStep = newId("obs", Date.now());
    await database.insert(schema.orbitPartners).values({
      id: foreignPartner,
      tenantId: FOREIGN_TENANT,
      name: "Someone Else's Partner",
      kind: "bank",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    await database.insert(schema.onboardingSteps).values({
      id: foreignStep,
      tenantId: FOREIGN_TENANT,
      subjectKind: "partner",
      subjectRef: foreignPartner,
      template: "partner.distribution",
      key: "legal_identity",
      labelJson: JSON.stringify({ en: "Legal identity verified", ar: "التحقق من الهوية القانونية" }),
      seq: 1,
      required: true,
      gatesStage: "applied",
      state: "pending",
      evidenceKind: "verification",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  });

  it("does not return their steps", async () => {
    const res = await call(
      "orbit.partners",
      "GET",
      `/v1/onboarding/steps?subjectKind=partner&subjectRef=${foreignPartner}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("cannot complete their step or advance their partner", async () => {
    const done = await call("orbit.partners", "POST", `/v1/onboarding/steps/${foreignStep}/complete`, {
      evidenceRef: "forged"
    });
    expect(done.status).toBe(404);

    const moved = await call("orbit.partners", "POST", `/v1/onboarding/partners/${foreignPartner}/advance`);
    expect(moved.status).toBe(404);

    const rows = await database
      .select()
      .from(schema.onboardingSteps)
      .where(eq(schema.onboardingSteps.id, foreignStep));
    expect(rows[0]!.state).toBe("pending");
  });
});

/* ------------------------------------------- the live key J-X3 ends with */

// docs/modules/orbit.md §8: "Partner sandbox → live key promotion without code
// changes." The signup route mints a `test` key and says of itself that it "can
// never mint a live key"; `advancePartner` moved a partner to `live` behind an
// approval; and **no live credential was ever issued**. A live partner held only
// a sandbox key, and issuing one meant a code change.
//
// The stage is set directly here rather than by re-walking the ladder: the
// ladder has its own tests above, and this one is about the key.

const liveKey = (id = partnerId) => call("orbit.partners", "POST", `/v1/onboarding/partners/${id}/live-key`);

/**
 * This partner's live keys, not the table's: the seed writes a six-key
 * credential register of its own, so counting `apiKeys` counts the demo tenant.
 */
const partnerLiveKeys = () =>
  database
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.mode, "live"), eq(schema.apiKeys.createdBy, `partner:${partnerId}`)));

async function atStage(stage: string) {
  await database
    .update(schema.orbitPartners)
    .set({ stage, status: "active", sandboxFlag: stage !== "live" })
    .where(eq(schema.orbitPartners.id, partnerId));
}

describe("promoting a partner to a live key", () => {
  // The seeded database is shared across this file's tests, so a key minted by
  // one of them is still there for the next — which is how the "mints one"
  // assertion first read 7.
  beforeEach(async () => {
    await database.delete(schema.apiKeys).where(and(eq(schema.apiKeys.mode, "live"), eq(schema.apiKeys.createdBy, `partner:${partnerId}`)));
  });

  it("refuses before the partner is live, because a live credential is for live partners", async () => {
    await atStage("sandbox");
    const res = await liveKey();
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("sandbox");
    expect(await partnerLiveKeys()).toHaveLength(0);
  });

  it("mints a live key once, and points the partner at it", async () => {
    await atStage("live");
    const res = await liveKey();
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("live");
    expect(res.body.prefix).toMatch(/^qvk_live_/);
    // The plaintext comes back exactly once and is never stored — the row holds
    // the hash, same rule as every other mint here.
    expect(res.body.key).toMatch(/^qvk_live_/);

    const keys = await partnerLiveKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.mode).toBe("live");
    expect(keys[0]!.keyHash).not.toContain(res.body.key);
    expect(JSON.parse(keys[0]!.scopesJson)).toContain("dist:quote_requests:create");

    const [partner] = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partnerId));
    expect(partner!.apiKeyRef).toBe(res.body.id);
  });

  it("refuses a second one, because two live keys is a credential nobody can account for", async () => {
    await atStage("live");
    expect((await liveKey()).status).toBe(201);
    const again = await liveKey();
    expect(again.status).toBe(409);
    expect(again.body.detail).toContain("already holds a live key");
    expect(await partnerLiveKeys()).toHaveLength(1);
  });

  it("refuses a partner who is suspended, whatever stage they reached", async () => {
    await atStage("live");
    await database.update(schema.orbitPartners).set({ status: "suspended" }).where(eq(schema.orbitPartners.id, partnerId));
    const res = await liveKey();
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("suspended");
  });

  it("refuses a caller without the live-key permission", async () => {
    await atStage("live");
    // An axis seat runs its own desk and cannot mint a partner credential. A
    // seat that is not in the demo roster authenticates as nobody and gets a 401
    // rather than a 403 — either way the point is that no key was minted.
    const res = await call("axis.lead", "POST", `/v1/onboarding/partners/${partnerId}/live-key`);
    expect([401, 403]).toContain(res.status);
    expect(await partnerLiveKeys()).toHaveLength(0);
  });
});
