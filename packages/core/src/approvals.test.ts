import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson } from "@lyra/db";
import {
  APPROVAL_POLICIES,
  APPROVAL_TTL_MS,
  decide,
  gate,
  grantsFor,
  heldDelegation,
  pendingApprovals,
  resolveDelegates
} from "./approvals.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function actor(roleKey: string, userId = "u_1", kind: Actor["kind"] = "user"): Actor {
  return { kind, id: userId, tenantId: "t_1", grants: [{ roleKey, permissions: permissionsForRole(roleKey) }] };
}

let client: Client;

function makeCtx(a: Actor, now = 1_700_000_000_000): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: a,
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

async function approvalId(err: unknown): Promise<string> {
  const extras = (err as { extras?: { approval_id?: string } }).extras;
  if (!extras?.approval_id) throw new Error("expected an approval_id on the thrown error");
  return extras.approval_id;
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
});

describe("APPROVAL_POLICIES", () => {
  it("defines the exact catalogue docs/19 §7 requires", () => {
    expect(APPROVAL_POLICIES).toEqual({
      "ledger.refund": { key: "ledger.refund", module: "ledger", decide: "ledger:payments:refund", dualControl: "above_threshold", defaultThresholdMinor: 500_00 },
      "ledger.payout": { key: "ledger.payout", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true },
      "ledger.client_money_transfer": { key: "ledger.client_money_transfer", module: "ledger", decide: "ledger:client_money:transfer", dualControl: "always", neverAutoApprove: true },
      "ledger.partner_settlement": { key: "ledger.partner_settlement", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true },
      "ledger.success_fee": { key: "ledger.success_fee", module: "ledger", decide: "ledger:invoices:approve", dualControl: "always", neverAutoApprove: true },
      "ledger.period_close": { key: "ledger.period_close", module: "ledger", decide: "ledger:periods:close", dualControl: "above_threshold" },
      "ledger.manual_journal": { key: "ledger.manual_journal", module: "ledger", decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true },
      "ledger.opening_balance": { key: "ledger.opening_balance", module: "ledger", decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true },
      "ledger.year_end_close": { key: "ledger.year_end_close", module: "ledger", decide: "ledger:periods:year_end", dualControl: "always", neverAutoApprove: true },
      "ledger.period_close_force": { key: "ledger.period_close_force", module: "ledger", decide: "ledger:periods:force_close", dualControl: "always", neverAutoApprove: true },
      "ledger.period_reopen": { key: "ledger.period_reopen", module: "ledger", decide: "ledger:periods:reopen", dualControl: "always", neverAutoApprove: true },
      "ledger.remit": { key: "ledger.remit", module: "ledger", decide: "ledger:client_money:transfer", dualControl: "always", neverAutoApprove: true },
      "ledger.surplus": { key: "ledger.surplus", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true },
      "ledger.credit_note": { key: "ledger.credit_note", module: "ledger", decide: "ledger:invoices:approve", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00, neverAutoApprove: true },
      "axis.case_issue": { key: "axis.case_issue", module: "axis", decide: "axis:cases:approve", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 },
      "axis.price_match": { key: "axis.price_match", module: "axis", decide: "axis:quotes:approve", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 },
      "axis.claim_settlement": { key: "axis.claim_settlement", module: "axis", decide: "axis:claims:approve", dualControl: "always", neverAutoApprove: true },
      "axis.escrow_release": { key: "axis.escrow_release", module: "axis", decide: "axis:escrow:approve", dualControl: "always", neverAutoApprove: true },
      "axis.bind": { key: "axis.bind", module: "axis", decide: "axis:policies:create", dualControl: "above_threshold", defaultThresholdMinor: 250_000_00 },
      "axis.bind_group": { key: "axis.bind_group", module: "axis", decide: "axis:policies:create", dualControl: "above_threshold", defaultThresholdMinor: 100_000_00 },
      "axis.endorse": { key: "axis.endorse", module: "axis", decide: "axis:policies:endorse", dualControl: "above_threshold", defaultThresholdMinor: 25_000_00 },
      "axis.cancel": { key: "axis.cancel", module: "axis", decide: "axis:policies:cancel", dualControl: "above_threshold", defaultThresholdMinor: 0 },
      "axis.reinstate": { key: "axis.reinstate", module: "axis", decide: "axis:policies:reinstate", dualControl: "always", neverAutoApprove: true },
      "axis.ntu": { key: "axis.ntu", module: "axis", decide: "axis:policies:ntu", dualControl: "above_threshold", defaultThresholdMinor: 0 },
      "axis.renew": { key: "axis.renew", module: "axis", decide: "axis:policies:renew", dualControl: "above_threshold", defaultThresholdMinor: 250_000_00 },
      "axis.claim_reserve": { key: "axis.claim_reserve", module: "axis", decide: "axis:claims:reserve_approve", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 },
      "axis.claim_payment": { key: "axis.claim_payment", module: "axis", decide: "axis:claims:pay_approve", dualControl: "always", neverAutoApprove: true },
      "axis.claim_exgratia": { key: "axis.claim_exgratia", module: "axis", decide: "axis:claims:pay_approve", dualControl: "always", neverAutoApprove: true },
      "axis.recovery_writeoff": { key: "axis.recovery_writeoff", module: "axis", decide: "axis:claims:recover", dualControl: "above_threshold", defaultThresholdMinor: 10_000_00 },
      "axis.underwriting_referral": { key: "axis.underwriting_referral", module: "axis", decide: "axis:policies:decide_referral", dualControl: "above_threshold", defaultThresholdMinor: 500_000_00 },
      "dist.rate_change": { key: "dist.rate_change", module: "core", decide: "dist:rates:approve", dualControl: "always", neverAutoApprove: true },
      "dist.commission_adjust": { key: "dist.commission_adjust", module: "core", decide: "dist:commissions:adjust", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 },
      "dist.commission_accrue": { key: "dist.commission_accrue", module: "core", decide: "dist:commissions:adjust", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00, singleUse: false },
      "dist.offering_publish": { key: "dist.offering_publish", module: "core", decide: "dist:offerings:publish", dualControl: "never" },
      "dist.settlement_run": { key: "dist.settlement_run", module: "core", decide: "dist:commissions:settle", dualControl: "always", neverAutoApprove: true },
      "dist.partner_activate": { key: "dist.partner_activate", module: "core", decide: "orbit:partners:certify", dualControl: "never" },
      "dist.rshare_adjust": { key: "dist.rshare_adjust", module: "core", decide: "dist:commissions:adjust", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 },
      "dist.agreement_sign": { key: "dist.agreement_sign", module: "core", decide: "dist:agreements:sign", dualControl: "always", neverAutoApprove: true },
      "core.onboarding_waive": { key: "core.onboarding_waive", module: "core", decide: "core:onboarding:waive", dualControl: "always", neverAutoApprove: true, singleUse: false },
      "core.delegation_grant": { key: "core.delegation_grant", module: "core", decide: "core:delegations:write", dualControl: "never" },
      "core.flag_toggle": { key: "core.flag_toggle", module: "platform", decide: "admin:flags:write", dualControl: "always", neverAutoApprove: true },
      "signal.budget_move": { key: "signal.budget_move", module: "signal", decide: "signal:budget_moves:approve", dualControl: "never" },
      "signal.campaign_launch": { key: "signal.campaign_launch", module: "signal", decide: "signal:campaigns:launch", dualControl: "never" },
      "signal.creative_publish": { key: "signal.creative_publish", module: "signal", decide: "signal:creatives:approve", dualControl: "never" },
      "signal.budget_commit": { key: "signal.budget_commit", module: "signal", decide: "signal:campaigns:launch", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 },
      "signal.boost": { key: "signal.boost", module: "signal", decide: "signal:campaigns:update", dualControl: "never" },
      "signal.creator_brief": { key: "signal.creator_brief", module: "signal", decide: "signal:creatives:approve", dualControl: "never" },
      "signal.outreach_send": { key: "signal.outreach_send", module: "signal", decide: "signal:outreach:send", dualControl: "never" },
      "scout.whitespace_promote": { key: "scout.whitespace_promote", module: "scout", decide: "scout:whitespaces:promote", dualControl: "never" },
      "core.impersonate": { key: "core.impersonate", module: "core", decide: "core:impersonate:use", dualControl: "always", neverAutoApprove: true },
      "core.mandate_register": { key: "core.mandate_register", module: "core", decide: "core:api_keys:create", dualControl: "always", neverAutoApprove: true },
      "core.unmasked_export": { key: "core.unmasked_export", module: "core", decide: "analytics:exports:unmasked", dualControl: "always", neverAutoApprove: true },
      "compliance.erasure": { key: "compliance.erasure", module: "core", decide: "compliance:erasure:execute", dualControl: "always", neverAutoApprove: true },
      "compliance.legal_hold_release": { key: "compliance.legal_hold_release", module: "core", decide: "compliance:legal_holds:write", dualControl: "always", neverAutoApprove: true },
      // docs/16 H8 / docs/27 F45 — the Shariah board's standing ruling on a
      // takaful product, gating SURPLUS-DIST through its precondition.
      "compliance.shariah_certify": { key: "compliance.shariah_certify", module: "core", decide: "compliance:shariah:certify", dualControl: "always", neverAutoApprove: true },
      "ai.autonomy_raise": { key: "ai.autonomy_raise", module: "ai", decide: "ai:agents:write", dualControl: "always", neverAutoApprove: true },
      "ai.prompt_publish": { key: "ai.prompt_publish", module: "ai", decide: "ai:prompts:write", dualControl: "never" },
      "ai.budget_raise": { key: "ai.budget_raise", module: "ai", decide: "ai:budgets:write", dualControl: "above_threshold" }
    });
  });

  it("keeps the approval TTL at exactly 24 hours", () => {
    expect(APPROVAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("gate: dual control threshold", () => {
  it("requires dual control only at or above the policy threshold", async () => {
    const analyst = makeCtx(actor("finance.analyst", "u_ops"));
    // ledger.refund: above_threshold at 500_00. Just under: single sign-off ok when auto-approved is off,
    // but not on the allowlist so it still needs an approval row either way. Assert dualControl flag in context.
    await expect(gate(analyst, { policyKey: "ledger.refund", subjectRef: "txn:below", amountMinor: 499_99 })).rejects.toThrow();
    const belowRow = await client.execute("SELECT context_json FROM core_approvals WHERE subject_ref = 'txn:below'");
    expect(JSON.parse(belowRow.rows[0]!.context_json as string).dualControl).toBe(false);

    await expect(gate(analyst, { policyKey: "ledger.refund", subjectRef: "txn:at", amountMinor: 500_00 })).rejects.toThrow();
    const atRow = await client.execute("SELECT context_json FROM core_approvals WHERE subject_ref = 'txn:at'");
    expect(JSON.parse(atRow.rows[0]!.context_json as string).dualControl).toBe(true);
  });

  it("fails closed: a missing amount on an above_threshold policy requires dual control", async () => {
    // An amount the caller could not state may be any amount; treating it as
    // zero would let it slip under the threshold with a single sign-off.
    const analyst = makeCtx(actor("finance.analyst", "u_ops"));
    await expect(gate(analyst, { policyKey: "ledger.refund", subjectRef: "txn:noamt" })).rejects.toThrow();
    const row = await client.execute("SELECT context_json FROM core_approvals WHERE subject_ref = 'txn:noamt'");
    const ctxJson = JSON.parse(row.rows[0]!.context_json as string);
    expect(ctxJson.dualControl).toBe(true);
    expect(ctxJson.amountMinor).toBeNull();
  });

  it("dualControl:'never' policies never require dual control regardless of amount", async () => {
    const ops = makeCtx(actor("axis.claims_handler", "u_ops"));
    await expect(gate(ops, { policyKey: "dist.offering_publish", subjectRef: "off:1", amountMinor: 999_999_99 })).rejects.toThrow();
    const row = await client.execute("SELECT context_json FROM core_approvals WHERE subject_ref = 'off:1'");
    expect(JSON.parse(row.rows[0]!.context_json as string).dualControl).toBe(false);
  });
});

describe("gate: lifecycle", () => {
  it("throws internal for an unknown policy key", async () => {
    const ctx = makeCtx(actor("tenant.admin"));
    await expect(gate(ctx, { policyKey: "not.a.policy", subjectRef: "x:1" })).rejects.toMatchObject({ status: 500 });
  });

  it("re-throws approval_required with the same id while a request is still pending", async () => {
    const ctx = makeCtx(actor("finance.analyst", "u_ops"));
    let firstId = "";
    try {
      await gate(ctx, { policyKey: "ledger.payout", subjectRef: "txn:dup" });
    } catch (err) {
      firstId = await approvalId(err);
    }
    try {
      await gate(ctx, { policyKey: "ledger.payout", subjectRef: "txn:dup" });
      throw new Error("expected gate to throw");
    } catch (err) {
      expect(await approvalId(err)).toBe(firstId);
    }
    const rows = await client.execute("SELECT id FROM core_approvals WHERE subject_ref = 'txn:dup'");
    expect(rows.rows).toHaveLength(1);
  });

  it("returns the approved row when decided within the TTL window", async () => {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);
    let id = "";
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:ttl" });
    } catch (err) {
      id = await approvalId(err);
    }
    await decide(finance, id, "approved", "ok");

    const justInside = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + APPROVAL_TTL_MS);
    const row = await gate(justInside, { policyKey: "ledger.payout", subjectRef: "txn:ttl" });
    expect(row?.decision).toBe("approved");
  });

  it("does not reuse an approval for a larger amount than was approved", async () => {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);
    let id = "";
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:grow", amountMinor: 1000 });
    } catch (err) {
      id = await approvalId(err);
    }
    await decide(finance, id, "approved", "ok");

    const later = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + 1000);
    let newId = "";
    try {
      await gate(later, { policyKey: "ledger.payout", subjectRef: "txn:grow", amountMinor: 2000 });
      throw new Error("expected gate to throw");
    } catch (err) {
      newId = await approvalId(err);
    }
    expect(newId).not.toBe(id);
  });

  it("consumes an approval on pass-through: one approval authorises exactly one execution", async () => {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);
    let id = "";
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:once", amountMinor: 1000 });
    } catch (err) {
      id = await approvalId(err);
    }
    await decide(finance, id, "approved", "ok");

    const retry = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + 1000);
    const row = await gate(retry, { policyKey: "ledger.payout", subjectRef: "txn:once", amountMinor: 1000 });
    expect(row?.decision).toBe("approved");

    const spent = await client.execute({ sql: "SELECT decision FROM core_approvals WHERE id = ?", args: [id] });
    expect(spent.rows[0]!.decision).toBe("consumed");

    let secondId = "";
    try {
      await gate(retry, { policyKey: "ledger.payout", subjectRef: "txn:once", amountMinor: 1000 });
      throw new Error("expected gate to throw");
    } catch (err) {
      secondId = await approvalId(err);
    }
    expect(secondId).not.toBe(id);
  });

  it("asks again once an approved decision has gone stale", async () => {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);
    let id = "";
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:stale" });
    } catch (err) {
      id = await approvalId(err);
    }
    await decide(finance, id, "approved", "ok");

    const wayAfter = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + APPROVAL_TTL_MS + 1);
    let newId = "";
    try {
      await gate(wayAfter, { policyKey: "ledger.payout", subjectRef: "txn:stale" });
      throw new Error("expected gate to throw");
    } catch (err) {
      newId = await approvalId(err);
    }
    expect(newId).not.toBe(id);
  });

  it("keeps a rejection blocking within the TTL, then falls through once stale", async () => {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);
    let id = "";
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef: "txn:rej" });
    } catch (err) {
      id = await approvalId(err);
    }
    await decide(finance, id, "rejected", "not documented");

    const soonAfter = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + 1000);
    try {
      await gate(soonAfter, { policyKey: "ledger.payout", subjectRef: "txn:rej" });
      throw new Error("expected gate to throw");
    } catch (err) {
      expect(await approvalId(err)).toBe(id);
    }

    const wayAfter = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000 + APPROVAL_TTL_MS + 1);
    try {
      await gate(wayAfter, { policyKey: "ledger.payout", subjectRef: "txn:rej" });
      throw new Error("expected gate to throw");
    } catch (err) {
      expect(await approvalId(err)).not.toBe(id);
    }
  });

  it("auto-approves and audits when the policy allows it and is not on the never-auto-approve list", async () => {
    const ctx = makeCtx(actor("tenant.admin"));
    const lax = { ...ctx, policy: PolicyJson.parse({ autoApprove: ["signal.budget_move"] }) };
    expect(await gate(lax, { policyKey: "signal.budget_move", subjectRef: "bm_9" })).toBeNull();
    const auditRow = await client.execute(
      "SELECT action FROM core_audit_log WHERE subject_ref = 'bm_9'"
    );
    expect(auditRow.rows[0]!.action).toBe("core.approval.auto");
  });
});

describe("decide", () => {
  async function requestPayout(subjectRef: string): Promise<string> {
    const initiator = makeCtx(actor("finance.analyst", "u_ops"));
    try {
      await gate(initiator, { policyKey: "ledger.payout", subjectRef });
      throw new Error("expected gate to throw");
    } catch (err) {
      return approvalId(err);
    }
  }

  it("throws notFound for an approval id that does not exist", async () => {
    const finance = makeCtx(actor("finance.controller", "u_fin"));
    await expect(decide(finance, "apr_missing", "approved")).rejects.toMatchObject({ status: 404 });
  });

  it("throws conflict when the approval was already decided", async () => {
    const id = await requestPayout("txn:conflict");
    const finance = makeCtx(actor("finance.controller", "u_fin"));
    await decide(finance, id, "approved", "ok");
    await expect(decide(finance, id, "approved", "ok")).rejects.toMatchObject({
      status: 409,
      detail: "already approved"
    });
  });

  it("throws forbidden when the decider lacks the permission and holds no delegation", async () => {
    const id = await requestPayout("txn:forbidden");
    const outsider = makeCtx(actor("finance.analyst", "u_outsider"));
    await expect(decide(outsider, id, "approved", "ok")).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    });
  });

  it("requires a reason for a rejection", async () => {
    const id = await requestPayout("txn:noreason");
    const finance = makeCtx(actor("finance.controller", "u_fin"));
    await expect(decide(finance, id, "rejected")).rejects.toMatchObject({
      status: 400,
      detail: "a rejection needs a reason"
    });
  });

  it("treats malformed context_json as dual-control instead of crashing or failing open", async () => {
    // The requester holds the deciding permission, so only the dual-control
    // check stands between them and self-approval once the context is corrupt.
    const requester = makeCtx(actor("finance.controller", "u_fin"));
    let id = "";
    try {
      await gate(requester, { policyKey: "ledger.payout", subjectRef: "txn:corrupt" });
    } catch (err) {
      id = await approvalId(err);
    }
    await client.execute({ sql: "UPDATE core_approvals SET context_json = 'not json' WHERE id = ?", args: [id] });

    await expect(decide(requester, id, "approved", "ok")).rejects.toMatchObject({
      status: 400,
      detail: "dual control: the approver must differ from the initiator"
    });
    const other = makeCtx(actor("finance.controller", "u_fin2"));
    const decided = await decide(other, id, "approved", "ok");
    expect(decided.decision).toBe("approved");
  });

  it("lets a delegate decide, and records which delegation authorised it", async () => {
    const now = 1_700_000_000_000;
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_fc', 't_1', 'finance.controller', 'Finance controller', ?, 1, ?)`,
      args: [JSON.stringify(permissionsForRole("finance.controller")), now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at)
            VALUES ('ur_1', 't_1', 'u_boss', 'role_fc', ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_delegations (id, tenant_id, from_user_id, to_user_id, reason, max_amount_minor, starts_at, ends_at, status, created_by, created_at)
            VALUES ('del_1', 't_1', 'u_boss', 'u_junior', 'leave', NULL, ?, ?, 'active', 'u_boss', ?)`,
      args: [now - 1000, now + 1_000_000, now]
    });

    const id = await requestPayout("txn:delegated");
    const junior = makeCtx(actor("finance.analyst", "u_junior"), now);
    const decided = await decide(junior, id, "approved", "covering for boss");
    expect(decided.delegationId).toBe("del_1");
  });
});

describe("grantsFor", () => {
  const now = 1_700_000_000_000;

  it("uses the stored permissions_json override when present", async () => {
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_custom', 't_1', 'custom.role', 'Custom', ?, 0, ?)`,
      args: [JSON.stringify(["ledger:payouts:approve"]), now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at) VALUES ('ur_c', 't_1', 'u_c', 'role_custom', ?)`,
      args: [now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_c");
    expect(grants).toEqual([{ roleKey: "custom.role", permissions: ["ledger:payouts:approve"] }]);
  });

  it("grants nothing for an explicitly emptied permissions bundle", async () => {
    // '[]' is a stored decision to strip the role; silently restoring the
    // compiled bundle would be privilege escalation.
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_empty', 't_1', 'finance.analyst', 'Analyst', '[]', 1, ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at) VALUES ('ur_e', 't_1', 'u_e', 'role_empty', ?)`,
      args: [now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_e");
    expect(grants).toEqual([{ roleKey: "finance.analyst", permissions: [] }]);
  });

  it("falls back to the compiled role bundle only when permissions_json is unparseable", async () => {
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_bad', 't_1', 'finance.analyst', 'Analyst', 'not json', 1, ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at) VALUES ('ur_b', 't_1', 'u_b', 'role_bad', ?)`,
      args: [now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_b");
    expect(grants).toEqual([{ roleKey: "finance.analyst", permissions: permissionsForRole("finance.analyst") }]);
  });

  it("attaches a parsed scope only when scope_json is present", async () => {
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_scoped', 't_1', 'finance.analyst', 'Analyst', '[]', 1, ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, scope_json, created_at)
            VALUES ('ur_s', 't_1', 'u_s', 'role_scoped', ?, ?)`,
      args: [JSON.stringify({ teamIds: ["team_1"] }), now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_s");
    expect(grants[0]!.scope).toEqual({ teamIds: ["team_1"] });
  });

  it("merges providerIds from core_users.provider_id (ROLE-028) even when scope_json is absent", async () => {
    await client.execute({
      sql: `INSERT INTO core_providers (id, tenant_id, name, kind, created_at, updated_at)
            VALUES ('prv_falcon', 't_1', 'Falcon', 'insurer', ?, ?)`,
      args: [now, now]
    });
    await client.execute({
      sql: `INSERT INTO core_users (id, tenant_id, email, name, provider_id, created_at, updated_at)
            VALUES ('u_provider', 't_1', 'p@falcon.example', 'Provider Contact', 'prv_falcon', ?, ?)`,
      args: [now, now]
    });
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_pv', 't_1', 'provider.viewer', 'Provider Viewer', '[]', 1, ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at)
            VALUES ('ur_pv', 't_1', 'u_provider', 'role_pv', ?)`,
      args: [now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_provider");
    expect(grants[0]!.scope).toEqual({ providerIds: ["prv_falcon"] });
  });

  it("leaves scope untouched for a user with no provider_id set", async () => {
    await client.execute({
      sql: `INSERT INTO core_users (id, tenant_id, email, name, created_at, updated_at)
            VALUES ('u_no_provider', 't_1', 'x@example.com', 'No Provider', ?, ?)`,
      args: [now, now]
    });
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at)
            VALUES ('role_np', 't_1', 'provider.viewer', 'Provider Viewer', '[]', 1, ?)`,
      args: [now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at)
            VALUES ('ur_np', 't_1', 'u_no_provider', 'role_np', ?)`,
      args: [now]
    });
    const grants = await grantsFor(makeCtx(actor("tenant.admin")).db, "t_1", "u_no_provider");
    expect(grants[0]!.scope).toBeUndefined();
  });
});

describe("delegations", () => {
  const now = 1_700_000_000_000;

  async function seedDelegator(roleKey: string, permissionsOverride?: string[]): Promise<void> {
    await client.execute({
      sql: `INSERT INTO core_roles (id, tenant_id, key, name, permissions_json, system, created_at) VALUES ('role_d', 't_1', ?, 'D', ?, 1, ?)`,
      args: [roleKey, JSON.stringify(permissionsOverride ?? permissionsForRole(roleKey)), now]
    });
    await client.execute({
      sql: `INSERT INTO core_user_roles (id, tenant_id, user_id, role_id, created_at) VALUES ('ur_d', 't_1', 'u_boss', 'role_d', ?)`,
      args: [now]
    });
  }

  async function insertDelegation(overrides: Partial<{
    id: string; scopeJson: string | null; maxAmountMinor: number | null; startsAt: number; endsAt: number; status: string; toUserId: string;
  }> = {}): Promise<void> {
    const row = {
      id: "del_1",
      scopeJson: null as string | null,
      maxAmountMinor: null as number | null,
      startsAt: now - 1000,
      endsAt: now + 1_000_000,
      status: "active",
      toUserId: "u_junior",
      ...overrides
    };
    await client.execute({
      sql: `INSERT INTO core_delegations (id, tenant_id, from_user_id, to_user_id, reason, scope_json, max_amount_minor, starts_at, ends_at, status, created_by, created_at)
            VALUES (?, 't_1', 'u_boss', ?, 'leave', ?, ?, ?, ?, ?, 'u_boss', ?)`,
      args: [row.id, row.toUserId, row.scopeJson, row.maxAmountMinor, row.startsAt, row.endsAt, row.status, now]
    });
  }

  it("resolves to nobody when the policy is unknown", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation();
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "not.a.policy" })).toEqual([]);
  });

  it("resolves a delegate only when the delegator currently holds the deciding permission", async () => {
    await seedDelegator("finance.analyst"); // lacks ledger:payouts:approve
    await insertDelegation();
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("re-reads the delegator's live grants: stripping their bundle changes the outcome immediately", async () => {
    await seedDelegator("finance.controller"); // holds ledger:payouts:approve
    await insertDelegation();
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual(["u_junior"]);

    await client.execute({
      sql: "UPDATE core_roles SET permissions_json = ? WHERE id = 'role_d'",
      args: [JSON.stringify(permissionsForRole("finance.analyst"))]
    });
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("excludes a delegation once amountMinor exceeds its ceiling, includes it exactly at the ceiling", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation({ maxAmountMinor: 1000 });
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout", amountMinor: 1000 })).toEqual(["u_junior"]);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout", amountMinor: 1001 })).toEqual([]);
  });

  it("fails closed: a ceilinged delegation does not cover a request with no stated amount", async () => {
    // No amount may be any amount; only an uncapped delegation covers it.
    await seedDelegator("finance.controller");
    await insertDelegation({ maxAmountMinor: 1000 });
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("excludes a delegation outside its scope, includes one inside it, excludes an unparseable scope", async () => {
    await seedDelegator("finance.controller");
    const ctx = makeCtx(actor("tenant.admin"), now);

    await insertDelegation({ scopeJson: JSON.stringify({ policyKeys: ["ledger.refund"] }) });
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);

    await client.execute("DELETE FROM core_delegations");
    await insertDelegation({ scopeJson: JSON.stringify({ policyKeys: ["ledger.payout"] }) });
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual(["u_junior"]);

    await client.execute("DELETE FROM core_delegations");
    await insertDelegation({ scopeJson: JSON.stringify({ modules: ["axis"] }) });
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);

    await client.execute("DELETE FROM core_delegations");
    await insertDelegation({ scopeJson: "not json" });
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("excludes a delegation outside its time window", async () => {
    await seedDelegator("finance.controller");
    const ctx = makeCtx(actor("tenant.admin"), now);

    await insertDelegation({ startsAt: now + 10, endsAt: now + 1000 }); // not started yet
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);

    await client.execute("DELETE FROM core_delegations");
    await insertDelegation({ startsAt: now - 1000, endsAt: now }); // ended exactly now (exclusive)
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("excludes a revoked delegation", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation({ status: "revoked" });
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual([]);
  });

  it("dedupes resolveDelegates when several delegations resolve to the same delegate", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation({ id: "del_1" });
    await client.execute({
      sql: `INSERT INTO core_delegations (id, tenant_id, from_user_id, to_user_id, reason, starts_at, ends_at, status, created_by, created_at)
            VALUES ('del_2', 't_1', 'u_boss', 'u_junior', 'cover', ?, ?, 'active', 'u_boss', ?)`,
      args: [now - 1000, now + 1_000_000, now]
    });
    const ctx = makeCtx(actor("tenant.admin"), now);
    expect(await resolveDelegates(ctx, { policyKey: "ledger.payout" })).toEqual(["u_junior"]);
  });

  it("heldDelegation returns null for a non-user actor, regardless of matching delegations", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation({ toUserId: "agent_1" });
    const ctx = makeCtx(actor("finance.analyst", "agent_1", "agent"), now);
    expect(await heldDelegation(ctx, { policyKey: "ledger.payout" })).toBeNull();
  });

  it("heldDelegation finds the delegation whose toUserId matches the current actor", async () => {
    await seedDelegator("finance.controller");
    await insertDelegation();
    const ctx = makeCtx(actor("finance.analyst", "u_junior"), now);
    expect(await heldDelegation(ctx, { policyKey: "ledger.payout" })).toBe("del_1");

    const otherCtx = makeCtx(actor("finance.analyst", "u_other"), now);
    expect(await heldDelegation(otherCtx, { policyKey: "ledger.payout" })).toBeNull();
  });
});

describe("pendingApprovals", () => {
  it("lists only pending rows for the tenant, oldest first, optionally filtered by module and capped by limit", async () => {
    const analyst = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_000);
    const finance = makeCtx(actor("finance.controller", "u_fin"), 1_700_000_000_000);

    for (const [subjectRef, at] of [
      ["txn:a", 1_700_000_000_000],
      ["txn:b", 1_700_000_000_100],
      ["txn:c", 1_700_000_000_200]
    ] as const) {
      await gate(makeCtx(actor("finance.analyst", "u_ops"), at), { policyKey: "ledger.payout", subjectRef }).catch(() => {});
    }
    // Decide one, so it drops out of "pending".
    let idB = "";
    const rowB = await client.execute("SELECT id FROM core_approvals WHERE subject_ref = 'txn:b'");
    idB = rowB.rows[0]!.id as string;
    await decide(finance, idB, "approved", "ok");

    const ops = makeCtx(actor("finance.analyst", "u_ops"), 1_700_000_000_300);
    await gate(ops, { policyKey: "axis.case_issue", subjectRef: "case:1", amountMinor: 60_000_00 }).catch(() => {});

    // F60: oldest first — the longest-waiting approvals are never dropped by
    // the cap; the newest rows fall off instead.
    const all = await pendingApprovals(analyst);
    expect(all.map((r) => r.subjectRef)).toEqual(["txn:a", "txn:c", "case:1"]);

    const ledgerOnly = await pendingApprovals(analyst, "ledger");
    expect(ledgerOnly.map((r) => r.subjectRef)).toEqual(["txn:a", "txn:c"]);

    const capped = await pendingApprovals(analyst, undefined, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.subjectRef).toBe("txn:a");
  });
});
