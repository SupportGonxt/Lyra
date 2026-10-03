import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { asc, desc, eq } from "drizzle-orm";
import { schema, ulidTime } from "@lyra/db";
import { seed } from "../seed.js";
import { verifyChain, type AuditRow } from "../audit.js";
import { canonicalJson, sha256Hex } from "../crypto.js";
import { DAY, HOUR, MINUTE } from "./context.js";
import type { CoreDb } from "../context.js";

// Same DB harness as axis.test.ts: an in-memory libSQL db with the real
// migrations replayed.
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const T0 = Date.UTC(2026, 0, 6, 8, 0, 0);

// The three UA strings platform.ts assigns to seats, copied rather than
// imported: a mutated literal in the source must show up as a mismatch here.
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0";
const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";

let db: CoreDb;
let tenantId: string;
let adminRef: string;
let complianceRef: string;
let controllerRef: string;
let analystRef: string;
let developerRef: string;
let axisAgentRef: string;
let axisLeadRef: string;
let northExecRef: string;
let policyId: string;
let renewalPolicyId: string;
let quoteRequestId: string;
let customerId: string;
let cedarMotorOfferingId: string;

async function auditRows(): Promise<AuditRow[]> {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.tenantId, tenantId))
    .orderBy(asc(schema.auditLog.ts), asc(schema.auditLog.id));
}

function one(rows: AuditRow[], action: string, subject: string): AuditRow {
  const row = rows.find((r) => r.action === action && r.subjectRef === subject);
  if (!row) throw new Error(`expected an audit row for ${action} / ${subject}`);
  return row;
}

// Some subjects collide (e.g. two retention runs on the same policyKey, two
// screenings on the same customer): action+subject alone doesn't uniquely
// identify a row, so callers that know the row's `ts` disambiguate with it.
function oneAt(rows: AuditRow[], action: string, subject: string, ts: number): AuditRow {
  const row = rows.find((r) => r.action === action && r.subjectRef === subject && r.ts === ts);
  if (!row) throw new Error(`expected an audit row for ${action} / ${subject} @ ${ts}`);
  return row;
}

async function hashOf(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

function actorRefOf(value: string | null | undefined, fallback: string): string {
  return value == null || value === "" ? fallback : value.includes(":") ? value : `user:${value}`;
}

beforeEach(async () => {
  const client: Client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  const r = await seed(db, { password: "platform-test-password-2026", now: T0 });
  tenantId = r.tenantId;
  adminRef = `user:${r.users["tenant.admin"]}`;
  complianceRef = `user:${r.users["tenant.compliance"]}`;
  controllerRef = `user:${r.users["finance.controller"]}`;
  analystRef = `user:${r.users["finance.analyst"]}`;
  developerRef = `user:${r.users["dev.admin"]}`;
  axisAgentRef = `user:${r.users["axis.agent"]}`;
  axisLeadRef = `user:${r.users["axis.lead"]}`;
  northExecRef = `user:${r.users["north.exec"]}`;
  cedarMotorOfferingId = r.offerings.cedarMotor!;

  const policies = await db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.tenantId, tenantId));
  policyId = policies.find((p) => p.policyNo === "CDR-MOT-2601-778201")!.id;
  renewalPolicyId = policies.find((p) => p.policyNo === "CDR-MOT-2501-664118")!.id;

  const [qr] = await db.select().from(schema.distQuoteRequests).where(eq(schema.distQuoteRequests.tenantId, tenantId));
  quoteRequestId = qr!.id;

  const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.tenantId, tenantId));
  customerId = cust!.id;
});

describe("seedPlatform: audit chain", () => {
  it("writes exactly 88 hash-chained rows for the tenant, in an unbroken chain", async () => {
    const rows = await auditRows();
    // One row per settled ledger transaction among them, so the six settlement
    // sales' BINDs (seed/settlement.ts) are six of these.
    expect(rows).toHaveLength(88);
    expect(await verifyChain(rows)).toEqual([]);
  });

  it("stamps ip/ua for the exact seat of each recognised actor, and null for everyone else", async () => {
    const rows = await auditRows();
    const seats: Record<string, { ip: string; ua: string }> = {
      [adminRef]: { ip: "94.200.14.87", ua: CHROME },
      [complianceRef]: { ip: "94.200.14.91", ua: EDGE },
      [controllerRef]: { ip: "94.200.14.88", ua: CHROME },
      [analystRef]: { ip: "94.200.14.94", ua: EDGE },
      [developerRef]: { ip: "5.32.180.212", ua: CHROME },
      [axisAgentRef]: { ip: "94.200.14.102", ua: CHROME },
      [axisLeadRef]: { ip: "2.51.44.19", ua: IOS },
      [northExecRef]: { ip: "2.51.9.140", ua: IOS }
    };
    let seatedRowCount = 0;
    let unseatedRowCount = 0;
    for (const row of rows) {
      const seat = seats[row.actorRef];
      if (seat) {
        seatedRowCount++;
        expect(row.ip).toBe(seat.ip);
        expect(row.ua).toBe(seat.ua);
      } else {
        unseatedRowCount++;
        expect(row.ip).toBeNull();
        expect(row.ua).toBeNull();
      }
    }
    // Both branches of the seat lookup are actually exercised by this tenant.
    expect(seatedRowCount).toBeGreaterThan(0);
    expect(unseatedRowCount).toBeGreaterThan(0);
  });
});

describe("seedPlatform: approvals", () => {
  it("logs a requested row (pending image) for every approval, and a decided row only for non-pending ones", async () => {
    const rows = await auditRows();
    const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.tenantId, tenantId));
    expect(approvals.length).toBeGreaterThan(0);

    for (const a of approvals) {
      const pending = { ...a, decidedBy: null, decision: "pending", reason: null, decidedAt: null };
      const requestedRow = one(rows, "core.approval.requested", a.subjectRef!);
      expect(requestedRow.ts).toBe(a.requestedAt);
      expect(requestedRow.actorRef).toBe(actorRefOf(a.requestedBy, adminRef));
      expect(requestedRow.beforeHash).toBeNull();
      expect(requestedRow.afterHash).toBe(await hashOf(pending));

      const decidedRow = rows.find(
        (r) => r.action === `core.approval.${a.decision}` && r.subjectRef === a.subjectRef
      );
      if (a.decision !== "pending" && a.decidedAt != null) {
        expect(decidedRow).toBeDefined();
        expect(decidedRow!.ts).toBe(a.decidedAt);
        // Dual control: the decider is never the requester, so the actor comes
        // from decidedBy first, falling back to requestedBy only if that's unset.
        expect(decidedRow!.actorRef).toBe(actorRefOf(a.decidedBy ?? a.requestedBy, adminRef));
        expect(decidedRow!.beforeHash).toBe(await hashOf(pending));
        expect(decidedRow!.afterHash).toBe(await hashOf(a));
      } else {
        expect(decidedRow).toBeUndefined();
      }
    }

    // At least one decision of each kind actually exists in this tenant, so the
    // requested/approved/rejected branch split is genuinely exercised above.
    expect(approvals.some((a) => a.decision === "approved")).toBe(true);
    expect(approvals.some((a) => a.decision === "rejected")).toBe(true);
  });

  it("ties a rejected approval back to the seeded quote request", async () => {
    const rows = await auditRows();
    const rejectedOnQuote = rows.find(
      (r) => r.action === "core.approval.rejected" && r.subjectRef === `quotes:${quoteRequestId}`
    );
    expect(rejectedOnQuote).toBeDefined();
  });
});

describe("seedPlatform: ledger transactions", () => {
  it("audits every settled/reversed/adjusted transaction under its type code, and skips the rest", async () => {
    const rows = await auditRows();
    const txns = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, tenantId));
    const settledLike = txns.filter((t) => t.state === "settled" || t.state === "reversed" || t.state === "adjusted");
    const notSettledLike = txns.filter(
      (t) => !(t.state === "settled" || t.state === "reversed" || t.state === "adjusted")
    );
    expect(settledLike.length).toBeGreaterThan(0);
    // The seed genuinely includes a transaction that never settled, so the
    // early-continue branch is exercised, not just theoretically reachable.
    expect(notSettledLike.length).toBeGreaterThan(0);

    for (const t of settledLike) {
      const row = one(rows, `ledger.txn.${t.type.toLowerCase()}`, `txn:${t.id}`);
      expect(row.ts).toBe(t.settledAt ?? t.updatedAt);
      expect(row.actorRef).toBe(`${t.actorKind}:${t.actorId}`);
      expect(row.afterHash).toBe(
        await hashOf({ type: t.type, state: "settled", grossMinor: t.grossMinor, batch: t.ledgerBatchId })
      );
    }
    for (const t of notSettledLike) {
      expect(rows.some((r) => r.subjectRef === `txn:${t.id}` && r.action.startsWith("ledger.txn."))).toBe(false);
    }
  });

  it("reverses one minute after the original settle, quoting the failure detail or the default reason", async () => {
    const rows = await auditRows();
    const txns = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, tenantId));
    const reversal = txns.find((t) => t.reversalOf != null)!;
    const original = txns.find((t) => t.id === reversal.reversalOf)!;
    const at = reversal.settledAt ?? reversal.updatedAt;

    const row = one(rows, "ledger.txn.reverse", `txn:${original.id}`);
    expect(row.ts).toBe(at + MINUTE);
    expect(row.actorRef).toBe(`${reversal.actorKind}:${reversal.actorId}`);
    expect(row.beforeHash).toBe(await hashOf({ state: "settled" }));
    expect(row.afterHash).toBe(
      await hashOf({
        state: "reversed",
        reversalTxnId: reversal.id,
        reason: reversal.failureDetail ?? "posted against the wrong offering; corrected by reversal"
      })
    );
  });
});

describe("seedPlatform: ledger periods", () => {
  it("closes exactly the non-open periods, quoting each one's own checklist, and never claims a forced close", async () => {
    const rows = await auditRows();
    const periods = await db.select().from(schema.ledgerPeriods).where(eq(schema.ledgerPeriods.tenantId, tenantId));
    const open = periods.filter((p) => p.state === "open" || p.closedAt == null);
    const closed = periods.filter((p) => !(p.state === "open" || p.closedAt == null));
    expect(open.length).toBeGreaterThan(0);
    expect(closed).toHaveLength(2);

    for (const p of closed) {
      const row = one(rows, "ledger.period.close", `period:${p.code}`);
      expect(row.ts).toBe(p.closedAt);
      expect(row.actorRef).toBe(actorRefOf(p.closedBy, controllerRef));
      expect(row.beforeHash).toBe(await hashOf({ state: "open" }));
      expect(row.afterHash).toBe(
        await hashOf({
          state: p.state,
          checks: p.checklistJson ? JSON.parse(p.checklistJson) : [],
          forced: false
        })
      );
    }
    for (const p of open) {
      expect(rows.some((r) => r.action === "ledger.period.close" && r.subjectRef === `period:${p.code}`)).toBe(
        false
      );
    }
  });
});

describe("seedPlatform: fixed entries", () => {
  it("exports the trial balance nine hours into the day it was pulled, tagged with this month's period code", async () => {
    const rows = await auditRows();
    const row = one(rows, "ledger.report.export", "report:trial-balance");
    expect(row.ts).toBe(T0 - 2 * DAY + 9 * HOUR);
    expect(row.actorRef).toBe(analystRef);
    expect(row.beforeHash).toBeNull();
    expect(row.afterHash).toBe(await hashOf({ report: "trial-balance", format: "xlsx", periodCode: "2026-01" }));
  });

  it("raises the signal budget's cost ceiling only, twenty minutes before the three-hour mark", async () => {
    const rows = await auditRows();
    const row = one(rows, "ai.budget.set_limits", "ai_budget:signal");
    expect(row.ts).toBe(T0 - 3 * HOUR - 20 * MINUTE);
    expect(row.actorRef).toBe(adminRef);
    expect(row.beforeHash).toBe(
      await hashOf({ module: "signal", tokensLimit: 250_000, costMicroLimit: 8_000_000 })
    );
    expect(row.afterHash).toBe(
      await hashOf({ module: "signal", tokensLimit: 250_000, costMicroLimit: 12_000_000 })
    );
  });
});

describe("seedPlatform: compliance", () => {
  it("creates the five most recent DSAR requests, and updates only the ones that were fulfilled", async () => {
    const rows = await auditRows();
    const dsars = await db
      .select()
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.tenantId, tenantId))
      .orderBy(desc(schema.dsarRequests.createdAt))
      .limit(5);
    expect(dsars).toHaveLength(5);
    expect(dsars.some((d) => d.fulfilledAt != null)).toBe(true);
    expect(dsars.some((d) => d.fulfilledAt == null)).toBe(true);

    for (const d of dsars) {
      const row = one(rows, "compliance.dsar-requests.create", d.id);
      expect(row.ts).toBe(d.createdAt);
      // Nobody has picked up a request that just landed, so an unhandled one
      // is authored by the portal itself, not a fallback human.
      expect(row.actorRef).toBe(actorRefOf(d.handledBy, "system:privacy-portal"));
      expect(row.afterHash).toBe(await hashOf({ type: d.type, channel: d.channel, state: "received", dueAt: d.dueAt }));

      const updateRow = rows.find((r) => r.action === "compliance.dsar-requests.update" && r.subjectRef === d.id);
      if (d.fulfilledAt != null) {
        expect(updateRow).toBeDefined();
        expect(updateRow!.ts).toBe(d.fulfilledAt);
        expect(updateRow!.actorRef).toBe(actorRefOf(d.handledBy, complianceRef));
        expect(updateRow!.beforeHash).toBe(await hashOf({ state: "in_progress", fulfilledAt: null }));
        expect(updateRow!.afterHash).toBe(
          await hashOf({ state: d.state, fulfilledAt: d.fulfilledAt, bundleFileId: d.bundleFileId })
        );
      } else {
        expect(updateRow).toBeUndefined();
      }
    }
  });

  it("carries the whole screening row as its after-image, for the three most recent", async () => {
    const rows = await auditRows();
    const screenings = await db
      .select()
      .from(schema.screenings)
      .where(eq(schema.screenings.tenantId, tenantId))
      .orderBy(desc(schema.screenings.ts))
      .limit(3);
    expect(screenings).toHaveLength(3);
    for (const s of screenings) {
      // Two of the three sampled screenings share a subjectRef (same customer,
      // different runs), so the row is pinned down by ts too.
      const row = oneAt(rows, "compliance.screening.run", s.subjectRef, s.ts);
      expect(row.ts).toBe(s.ts);
      expect(row.actorRef).toBe(actorRefOf(s.dispositionedBy, complianceRef));
      expect(row.afterHash).toBe(await hashOf(s));
    }
  });

  it("creates the two most recent legal holds, quoting reason and (possibly null) authority", async () => {
    const rows = await auditRows();
    const holds = await db
      .select()
      .from(schema.legalHolds)
      .where(eq(schema.legalHolds.tenantId, tenantId))
      .orderBy(desc(schema.legalHolds.createdAt))
      .limit(2);
    expect(holds).toHaveLength(2);
    // One of the two really does have a null authority, so the field is
    // asserted rather than assumed always-present.
    expect(holds.some((h) => h.authority == null)).toBe(true);
    for (const h of holds) {
      const row = one(rows, "compliance.legal-holds.create", h.id);
      expect(row.ts).toBe(h.createdAt);
      expect(row.actorRef).toBe(actorRefOf(h.placedBy, complianceRef));
      expect(row.afterHash).toBe(await hashOf({ subjectRef: h.subjectRef, reason: h.reason, authority: h.authority }));
    }
  });

  it("carries the whole retention-run row as its after-image, actor always compliance, for the two most recent runs", async () => {
    const rows = await auditRows();
    const retention = await db
      .select()
      .from(schema.retentionRuns)
      .where(eq(schema.retentionRuns.tenantId, tenantId))
      .orderBy(desc(schema.retentionRuns.startedAt))
      .limit(2);
    expect(retention).toHaveLength(2);
    // Both sampled runs are on the "messages" policy, so subject alone doesn't
    // disambiguate the two rows either.
    expect(retention[0]!.policyKey).toBe(retention[1]!.policyKey);
    for (const r of retention) {
      const row = oneAt(rows, "compliance.retention.run", `retention:${r.policyKey}`, r.startedAt);
      expect(row.ts).toBe(r.startedAt);
      expect(row.actorRef).toBe(complianceRef);
      expect(row.afterHash).toBe(await hashOf(r));
    }
  });

  it("exports the most recent evidence bundle, and downloads it only if it was actually delivered", async () => {
    const rows = await auditRows();
    const [bundle] = await db
      .select()
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.tenantId, tenantId))
      .orderBy(desc(schema.evidenceBundles.createdAt))
      .limit(1);
    expect(bundle).toBeDefined();

    const row = one(rows, "compliance.evidence.export", `evidence_bundle:${bundle!.id}`);
    expect(row.ts).toBe(bundle!.createdAt);
    expect(row.actorRef).toBe(actorRefOf(bundle!.requestedBy, complianceRef));
    expect(row.afterHash).toBe(
      await hashOf({ purpose: bundle!.purpose, bundleHash: bundle!.bundleHash, state: bundle!.state })
    );

    const downloadRow = rows.find(
      (r) => r.action === "compliance.evidence.download" && r.subjectRef === `evidence_bundle:${bundle!.id}`
    );
    if (bundle!.state === "delivered") {
      expect(downloadRow).toBeDefined();
      expect(downloadRow!.ts).toBe(bundle!.updatedAt);
      expect(downloadRow!.actorRef).toBe(actorRefOf(bundle!.approvedBy ?? bundle!.requestedBy, complianceRef));
      expect(downloadRow!.afterHash).toBe(await hashOf({ bundleHash: bundle!.bundleHash }));
    } else {
      // The most recent bundle in this seed is still "building": the download
      // half of the story genuinely does not happen for it.
      expect(bundle!.state).not.toBe("delivered");
      expect(downloadRow).toBeUndefined();
    }
  });
});

describe("seedPlatform: api keys, identity providers, webhooks", () => {
  it("logs a create for every revoked-or-live key, skips pristine test keys, and updates only the revoked one", async () => {
    const rows = await auditRows();
    const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.tenantId, tenantId));
    const qualifying = keys.filter((k) => !(k.revokedAt == null && k.mode !== "live"));
    const skipped = keys.filter((k) => k.revokedAt == null && k.mode !== "live");
    // Both a qualifying key and a skipped (pristine, non-live) key really exist.
    expect(qualifying.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);

    for (const k of qualifying) {
      const row = one(rows, "core.api-keys.create", `api-keys:${k.id}`);
      expect(row.ts).toBe(k.createdAt);
      expect(row.actorRef).toBe(actorRefOf(k.createdBy, developerRef));
      expect(row.afterHash).toBe(
        await hashOf({ name: k.name, prefix: k.prefix, mode: k.mode, scopesJson: k.scopesJson })
      );

      const updateRow = rows.find((r) => r.action === "core.api-keys.update" && r.subjectRef === k.id);
      if (k.revokedAt != null) {
        expect(updateRow).toBeDefined();
        expect(updateRow!.ts).toBe(k.revokedAt);
        expect(updateRow!.actorRef).toBe(adminRef);
        expect(updateRow!.beforeHash).toBe(await hashOf({ revokedAt: null }));
        expect(updateRow!.afterHash).toBe(await hashOf({ revokedAt: k.revokedAt, reason: "exposed_in_public_repo" }));
      } else {
        expect(updateRow).toBeUndefined();
      }
    }
    for (const k of skipped) {
      expect(rows.some((r) => r.subjectRef === `api-keys:${k.id}` || r.subjectRef === k.id)).toBe(false);
    }
  });

  it("creates the two most recent identity providers, actor always the developer seat", async () => {
    const rows = await auditRows();
    const idps = await db
      .select()
      .from(schema.identityProviders)
      .where(eq(schema.identityProviders.tenantId, tenantId))
      .orderBy(desc(schema.identityProviders.createdAt))
      .limit(2);
    expect(idps).toHaveLength(2);
    for (const p of idps) {
      const row = one(rows, "core.identity-providers.create", p.id);
      expect(row.ts).toBe(p.createdAt);
      expect(row.actorRef).toBe(developerRef);
      expect(row.afterHash).toBe(
        await hashOf({ kind: p.kind, name: p.name, emailDomain: p.emailDomain, enabled: p.enabled, mfaAsserted: p.mfaAsserted })
      );
    }
  });

  it("logs a synthetic create-then-pause pair only for paused webhooks, the pause fixed three hours before now", async () => {
    const rows = await auditRows();
    const webhooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    const paused = webhooks.filter((w) => w.status === "paused");
    const active = webhooks.filter((w) => w.status !== "paused");
    expect(paused.length).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);

    for (const w of paused) {
      const createRow = one(rows, "core.webhooks.create", `webhooks:${w.id}`);
      expect(createRow.ts).toBe(w.createdAt);
      expect(createRow.actorRef).toBe(developerRef);
      expect(createRow.afterHash).toBe(await hashOf({ url: w.url, eventTypesJson: w.eventTypesJson, status: "active" }));

      const updateRow = one(rows, "core.webhooks.update", w.id);
      // Fixed offset, independent of the webhook's own createdAt/updatedAt.
      expect(updateRow.ts).toBe(T0 - 3 * HOUR);
      expect(updateRow.actorRef).toBe(developerRef);
      expect(updateRow.beforeHash).toBe(await hashOf({ status: "active" }));
      expect(updateRow.afterHash).toBe(await hashOf({ status: "paused" }));
    }
    for (const w of active) {
      expect(rows.some((r) => r.subjectRef === `webhooks:${w.id}` || r.subjectRef === w.id)).toBe(false);
    }
  });
});

describe("seedPlatform: ai guardrails and agents", () => {
  it("logs only the block-severity guardrail events among the five most recent, none of the warn/info ones", async () => {
    const rows = await auditRows();
    const recent = await db
      .select()
      .from(schema.aiGuardrailEvents)
      .where(eq(schema.aiGuardrailEvents.tenantId, tenantId))
      .orderBy(desc(schema.aiGuardrailEvents.ts))
      .limit(5);
    expect(recent).toHaveLength(5);
    const blocked = recent.filter((g) => g.severity === "block").slice(0, 2);
    const notBlocked = recent.filter((g) => g.severity !== "block");
    expect(blocked.length).toBeGreaterThan(0);
    expect(notBlocked.length).toBeGreaterThan(0);

    for (const g of blocked) {
      const row = one(rows, "ai.guardrail.block", g.subjectRef ?? `ai_runs:${g.runId ?? "unknown"}`);
      expect(row.ts).toBe(g.ts);
      expect(row.actorRef).toBe("system:model-gateway");
      expect(row.beforeHash).toBeNull();
      expect(row.afterHash).toBe(await hashOf({ rule: g.rule, severity: g.severity, detail: g.detail, runId: g.runId }));
    }
    for (const g of notBlocked) {
      expect(rows.some((r) => r.action === "ai.guardrail.block" && r.ts === g.ts)).toBe(false);
    }
  });

  it("pauses no agent for this tenant: every seeded agent is active, so no ai.agent.pause row exists", async () => {
    const rows = await auditRows();
    const agents = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.tenantId, tenantId));
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((a) => a.status !== "paused")).toBe(true);
    expect(rows.some((r) => r.action === "ai.agent.pause")).toBe(false);
  });
});

describe("seedPlatform: sign-ins", () => {
  it("logs the six fixed sign-ins at their exact offsets before now, with no before/after image", async () => {
    const rows = await auditRows();
    const logins = rows.filter((r) => r.action === "core.session.login");
    expect(logins).toHaveLength(6);
    const byActor = (ref: string) => logins.find((r) => r.actorRef === ref)!;

    expect(byActor(adminRef).ts).toBe(T0 - 3 * DAY - 2 * HOUR);
    expect(byActor(controllerRef).ts).toBe(T0 - 2 * DAY - 30 * MINUTE);
    expect(byActor(axisAgentRef).ts).toBe(T0 - DAY - 3 * HOUR);
    expect(byActor(complianceRef).ts).toBe(T0 - 26 * HOUR);
    expect(byActor(northExecRef).ts).toBe(T0 - 5 * HOUR);
    expect(byActor(axisLeadRef).ts).toBe(T0 - 90 * MINUTE);

    for (const row of logins) {
      expect(row.beforeHash).toBeNull();
      expect(row.afterHash).toBeNull();
    }
  });

  it("verifies MFA forty seconds after login, only for the admin and compliance seats", async () => {
    const rows = await auditRows();
    const mfas = rows.filter((r) => r.action === "core.mfa.verified");
    expect(mfas).toHaveLength(2);

    const adminLogin = rows.find((r) => r.action === "core.session.login" && r.actorRef === adminRef)!;
    const complianceLogin = rows.find((r) => r.action === "core.session.login" && r.actorRef === complianceRef)!;
    const adminMfa = mfas.find((m) => m.actorRef === adminRef)!;
    const complianceMfa = mfas.find((m) => m.actorRef === complianceRef)!;

    expect(adminMfa.ts).toBe(adminLogin.ts + 40_000);
    expect(adminMfa.subjectRef).toBe(adminLogin.subjectRef);
    expect(complianceMfa.ts).toBe(complianceLogin.ts + 40_000);
    expect(complianceMfa.subjectRef).toBe(complianceLogin.subjectRef);

    for (const ref of [axisAgentRef, northExecRef, axisLeadRef, controllerRef]) {
      expect(rows.some((r) => r.action === "core.mfa.verified" && r.actorRef === ref)).toBe(false);
    }
  });

  it("revokes only the north.exec session, twelve minutes after login, actioned by the admin", async () => {
    const rows = await auditRows();
    const revokes = rows.filter((r) => r.action === "core.session.revoke");
    expect(revokes).toHaveLength(1);

    const northLogin = rows.find((r) => r.action === "core.session.login" && r.actorRef === northExecRef)!;
    expect(revokes[0]!.ts).toBe(northLogin.ts + 12 * MINUTE);
    expect(revokes[0]!.subjectRef).toBe(northLogin.subjectRef);
    expect(revokes[0]!.actorRef).toBe(adminRef);
    expect(revokes[0]!.beforeHash).toBeNull();
    expect(revokes[0]!.afterHash).toBe(await hashOf({ reason: "sign-in from an unrecognised network" }));
  });
});

describe("seedPlatform: ai budgets", () => {
  it("seeds exactly 23 daily windows", async () => {
    const budgets = await db.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.tenantId, tenantId));
    expect(budgets).toHaveLength(23);
  });

  it("applies each module's own ceiling, and today's usage/limits are exact", async () => {
    const budgets = await db.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.tenantId, tenantId));
    const at = (day: string, module: string) => budgets.find((b) => b.day === day && b.module === module)!;

    expect(at("2026-01-06", "*")).toMatchObject({
      tokensUsed: 486_200,
      costMicroUsed: 21_480_000,
      tokensLimit: 2_000_000,
      costMicroLimit: 50_000_000,
      updatedAt: T0,
      thresholdNotifiedAt: null,
      stoppedAt: null
    });
    expect(at("2026-01-06", "axis")).toMatchObject({
      tokensUsed: 128_400,
      costMicroUsed: 3_120_000,
      tokensLimit: 400_000,
      costMicroLimit: 10_000_000
    });
    expect(at("2026-01-06", "dist")).toMatchObject({
      tokensUsed: 210_600,
      costMicroUsed: 6_840_000,
      tokensLimit: 500_000,
      costMicroLimit: 12_000_000
    });
    expect(at("2026-01-06", "orbit")).toMatchObject({
      tokensUsed: 96_200,
      costMicroUsed: 2_410_000,
      tokensLimit: 300_000,
      costMicroLimit: 8_000_000
    });
    expect(at("2026-01-06", "core")).toMatchObject({
      tokensUsed: 178_400,
      costMicroUsed: 1_640_000,
      tokensLimit: 200_000,
      costMicroLimit: 4_000_000
    });

    // 99% of the signal cost cap, still open (no stop) but already notified.
    const signalToday = at("2026-01-06", "signal");
    expect(signalToday.tokensUsed).toBe(194_000);
    expect(signalToday.costMicroUsed).toBe(7_960_000);
    expect(signalToday.tokensLimit).toBe(250_000);
    expect(signalToday.costMicroLimit).toBe(8_000_000);
    expect(signalToday.thresholdNotifiedAt).toBe(T0 - 6 * HOUR);
    expect(signalToday.stoppedAt).toBeNull();
  });

  it("stopped yesterday's dist window mid-window, to the millisecond", async () => {
    const budgets = await db.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.tenantId, tenantId));
    const distStopped = budgets.find((b) => b.day === "2026-01-05" && b.module === "dist")!;
    expect(distStopped.tokensUsed).toBe(512_400);
    expect(distStopped.costMicroUsed).toBe(12_180_000);
    expect(distStopped.stoppedAt).toBe(T0 - 26 * HOUR + 640);
    expect(distStopped.thresholdNotifiedAt).toBe(T0 - 30 * HOUR);
    expect(distStopped.updatedAt).toBe(T0 - 26 * HOUR);
  });

  it("falls back to the '*' ceiling for a module CEILINGS never names", async () => {
    const budgets = await db.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.tenantId, tenantId));
    const north = budgets.find((b) => b.day === "2026-01-03" && b.module === "north")!;
    expect(north.tokensUsed).toBe(121_600);
    expect(north.costMicroUsed).toBe(8_400_000);
    expect(north.tokensLimit).toBe(2_000_000);
    expect(north.costMicroLimit).toBe(50_000_000);

    const ledger = budgets.find((b) => b.day === "2026-01-01" && b.module === "ledger")!;
    expect(ledger.tokensUsed).toBe(42_800);
    expect(ledger.costMicroUsed).toBe(940_000);
    expect(ledger.tokensLimit).toBe(2_000_000);
    expect(ledger.costMicroLimit).toBe(50_000_000);
  });
});

describe("seedPlatform: event dead-letter queue", () => {
  it("parks exactly seven dead envelopes, each having failed five attempts", async () => {
    const dlq = await db.select().from(schema.eventDlq).where(eq(schema.eventDlq.tenantId, tenantId));
    expect(dlq).toHaveLength(7);
    for (const row of dlq) expect(row.attempts).toBe(5);
  });

  it("ties each envelope to the real customer/policy/quote-request rows the rest of the demo seeded", async () => {
    const dlq = await db.select().from(schema.eventDlq).where(eq(schema.eventDlq.tenantId, tenantId));
    const only = (type: string) => dlq.find((r) => r.type === type)!;

    const issued = only("axis.policy.issued");
    expect(issued.createdAt).toBe(T0 - 9 * DAY);
    expect(issued.consumer).toBe("webhook-dispatcher");
    expect(issued.replayedAt).toBeNull();
    expect(issued.error).toBe("POST https://legacy.alphabrokers.ae/hooks/quotes -> 410 Gone");
    const issuedEnvelope = JSON.parse(issued.envelopeJson) as Record<string, unknown>;
    expect(issuedEnvelope).toMatchObject({
      ts: T0 - 9 * DAY,
      tenant_id: tenantId,
      module: "axis",
      type: "axis.policy.issued",
      actor: "system:axis-issue",
      subject: `policies:${policyId}`,
      data: { policyId, offeringId: cedarMotorOfferingId },
      v: 1
    });
    expect(ulidTime(issuedEnvelope["id"] as string)).toBe(T0 - 9 * DAY);

    const settlement = only("ledger.settlement.posted");
    expect(settlement.consumer).toBe("north-briefings");
    expect(settlement.replayedAt).toBe(T0 - 5 * DAY - 4 * HOUR);
    expect(settlement.error).toBe("briefing rollup timed out after 30000ms");

    const commission = only("dist.commission.accrued");
    expect(commission.consumer).toBe("ledger-postings");
    expect(commission.error).toBe("period 2025-12 is hard_closed: refusing to post");
    const commissionEnvelope = JSON.parse(commission.envelopeJson) as Record<string, unknown>;
    expect(commissionEnvelope["subject"]).toBe(`commissions:${quoteRequestId}`);
    expect(commissionEnvelope["data"]).toEqual({ grossMinor: 84_000, currency: "AED" });

    const screeningHit = only("compliance.screening.hit");
    expect(screeningHit.consumer).toBe("axis-cases");
    expect(screeningHit.replayedAt).toBe(T0 - 3 * DAY + 7 * HOUR);
    const screeningEnvelope = JSON.parse(screeningHit.envelopeJson) as Record<string, unknown>;
    expect(screeningEnvelope["subject"]).toBe(`customer:${customerId}`);
    expect(screeningEnvelope["data"]).toEqual({ kind: "sanctions", result: "hit", blocked: true });

    const renewal = only("orbit.renewal.due");
    expect(renewal.consumer).toBe("signal-campaigns");
    expect(renewal.replayedAt).toBeNull();
    const renewalEnvelope = JSON.parse(renewal.envelopeJson) as Record<string, unknown>;
    expect(renewalEnvelope["subject"]).toBe(`policies:${renewalPolicyId}`);
    expect(renewalEnvelope["data"]).toEqual({ policyId: renewalPolicyId, dueInDays: 21 });
  });

  it("kills the same fanned-out envelope twice on replay: identical envelope content, two distinct DLQ rows", async () => {
    const dlq = await db.select().from(schema.eventDlq).where(eq(schema.eventDlq.tenantId, tenantId));
    const fannedOut = dlq
      .filter((r) => r.type === "dist.quote_request.fanned_out")
      .sort((a, b) => a.createdAt - b.createdAt);
    expect(fannedOut).toHaveLength(2);

    // Two separate DLQ rows, twenty hours apart...
    expect(fannedOut[0]!.createdAt).toBe(T0 - 40 * HOUR);
    expect(fannedOut[1]!.createdAt).toBe(T0 - 20 * HOUR);
    expect(fannedOut[0]!.id).not.toBe(fannedOut[1]!.id);
    expect(fannedOut[0]!.consumer).toBe("signal-attribution");
    expect(fannedOut[1]!.consumer).toBe("signal-attribution");
    for (const row of fannedOut) {
      expect(row.error).toBe("attribution store rejected the write: unknown channel broker-alpha");
    }

    // ...but both envelopes describe the exact same original event: same
    // minted-at time, same subject, same data. The second death replays the
    // original envelope rather than manufacturing a new one.
    const env0 = JSON.parse(fannedOut[0]!.envelopeJson) as Record<string, unknown>;
    const env1 = JSON.parse(fannedOut[1]!.envelopeJson) as Record<string, unknown>;
    expect(env0["ts"]).toBe(T0 - 40 * HOUR);
    expect(env1["ts"]).toBe(T0 - 40 * HOUR);
    expect(ulidTime(env0["id"] as string)).toBe(T0 - 40 * HOUR);
    expect(ulidTime(env1["id"] as string)).toBe(T0 - 40 * HOUR);
    expect(env0["subject"]).toBe(`quote-requests:${quoteRequestId}`);
    expect(env0["data"]).toEqual({ requestId: quoteRequestId, providers: 4, policyId });
    // The envelope id is minted fresh on each call (only its time component is
    // deterministic), so compare everything else and the id's time separately.
    const { id: id0, ...rest0 } = env0;
    const { id: id1, ...rest1 } = env1;
    expect(rest0).toEqual(rest1);
    expect(ulidTime(id0 as string)).toBe(ulidTime(id1 as string));
  });
});
