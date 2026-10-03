import { describe, expect, it } from "vitest";
import { APPROVAL_POLICIES } from "./approvals.js";
import { can, permissionsForRole, type Actor } from "./rbac.js";
import { SEED_PEOPLE } from "./seed.js";

/**
 * Every approval gate a seeded tenant can reach must be decidable by its
 * seeded staff alone — at least two distinct personas holding the policy's
 * `decide` permission.
 *
 * Two, not one, because a requester may never decide their own approval under
 * dual control (approvals.ts `decide`: "the approver must differ from the
 * initiator"), and the persona who holds a decide permission is very often the
 * one who requests it: before this guard only `axis.lead` (omar.farouk) held
 * `axis:policies:create`, `axis:policies:endorse` and `axis:claims:approve`,
 * and he is the one who binds. Binds above threshold, endorsements and claim
 * settlements could never complete in a tenant holding only the seeded roles —
 * the all-roles demo administrator was quietly approving them, which is why
 * that account is excluded here: it proves nothing about any real role mix.
 *
 * The population is partitioned (CLAUDE.md, "a guard that selects its own
 * subjects must assert that it selected all of them"): every policy is either
 * checked, or out of scope because no seeded persona works in its module, or
 * a named exception with its reason. Nothing is left over.
 */

const SELF_DECIDABLE =
  "dualControl never: the requester may decide their own request (approvals.ts only refuses self-decision under dual control), so one holder clears it";
const SPLIT_VERB =
  "the requesting verb and the deciding verb are never granted to the same role, so the one decider is never the requester";

/**
 * Policies a seeded tenant reaches that have fewer than two seeded deciders,
 * each with the reason that is acceptable. The ratchet below fails as soon as
 * one gains a second decider, so an entry cannot outlive its reason.
 */
const ONE_DECIDER: Readonly<Record<string, string>> = {
  // AXIS claims split the handler from the approver (rbac.ts, design §A.2):
  // axis.agent/axis.lead hold `:reserve`/`:pay`, only axis.admin the approvals.
  "axis.claim_reserve": SPLIT_VERB,
  "axis.claim_payment": SPLIT_VERB,
  "axis.claim_exgratia": SPLIT_VERB,
  // orbit.partners drafts the agreement and may not countersign it (rbac.ts).
  "dist.agreement_sign": SPLIT_VERB,
  // Raised by platform.support (`core:impersonate:use`), decided by the tenant.
  "core.impersonate": SPLIT_VERB,
  "core.delegation_grant": SELF_DECIDABLE,
  "signal.budget_move": SELF_DECIDABLE,
  "signal.campaign_launch": SELF_DECIDABLE,
  "signal.creative_publish": SELF_DECIDABLE,
  "signal.boost": SELF_DECIDABLE,
  "signal.creator_brief": SELF_DECIDABLE,
  "signal.outreach_send": SELF_DECIDABLE,
  "orbit.renewal_offer": SELF_DECIDABLE,
  "scout.whitespace_promote": SELF_DECIDABLE,
  "ai.prompt_publish": SELF_DECIDABLE
};

const TENANT = "t_guard";

function actorFor(person: { local: string; role: string }): Actor {
  return {
    kind: "user",
    id: person.local,
    tenantId: TENANT,
    grants: [{ roleKey: person.role, permissions: permissionsForRole(person.role) }]
  };
}

/**
 * The module a seeded role works in: its key's prefix (`axis.lead` → axis),
 * with `tenant.*` working in `core`. `finance`, `dev` and `provider` name no
 * policy module, which is harmless — reachability below catches their gates.
 */
function moduleOfRole(role: string): string {
  const prefix = role.split(".")[0]!;
  return prefix === "tenant" ? "core" : prefix;
}

const seededModules = new Set(SEED_PEOPLE.map((p) => moduleOfRole(p.role)));

function decidersOf(key: string): string[] {
  const p = APPROVAL_POLICIES[key]!;
  return SEED_PEOPLE.filter((person) => can(actorFor(person), p.decide, { tenantId: TENANT, module: p.module })).map(
    (person) => person.local
  );
}

describe("approval policies have two seeded deciders", () => {
  const keys = Object.keys(APPROVAL_POLICIES);
  // In scope: a seeded persona works in the policy's module, or holds its
  // decide permission from another module (finance.controller on ledger gates).
  const inScope = keys.filter((k) => seededModules.has(APPROVAL_POLICIES[k]!.module) || decidersOf(k).length > 0);
  const outOfScope = keys.filter((k) => !inScope.includes(k));

  it("every in-scope policy has two distinct seeded deciders, or a named exception", () => {
    const short = inScope
      .filter((k) => !(k in ONE_DECIDER))
      .map((k) => ({ key: k, decide: APPROVAL_POLICIES[k]!.decide, deciders: decidersOf(k) }))
      .filter((r) => new Set(r.deciders).size < 2);
    expect(short).toEqual([]);
  });

  it("the dual-control gates outside AXIS that had one seeded decider now have two", () => {
    for (const key of [
      "signal.budget_commit",
      "scout.data_product_subscribe",
      "compliance.erasure",
      "compliance.legal_hold_release",
      "compliance.shariah_certify",
      "ai.autonomy_raise",
      "ai.budget_raise"
    ]) {
      expect(new Set(decidersOf(key)).size, key).toBeGreaterThanOrEqual(2);
    }
  });

  it("the AXIS gates named in the finding each have two deciders", () => {
    for (const key of ["axis.bind", "axis.bind_group", "axis.endorse", "axis.claim_settlement", "axis.escrow_release"]) {
      expect(new Set(decidersOf(key)).size, key).toBeGreaterThanOrEqual(2);
    }
  });

  it("every exception is an in-scope policy still short of two, for a reason that holds", () => {
    for (const [key, reason] of Object.entries(ONE_DECIDER)) {
      expect(inScope, key).toContain(key);
      expect(decidersOf(key).length, key).toBeLessThan(2);
      if (reason === SELF_DECIDABLE) expect(APPROVAL_POLICIES[key]!.dualControl, key).toBe("never");
    }
  });

  it("out of scope means no seeded persona works in the module or can decide it", () => {
    // Today only the platform operator's gate (`core.flag_toggle`, module platform).
    for (const k of outOfScope) {
      expect(seededModules.has(APPROVAL_POLICIES[k]!.module), k).toBe(false);
      expect(decidersOf(k), k).toEqual([]);
    }
    expect(inScope.length + outOfScope.length).toBe(keys.length);
  });

  it("does not count the all-roles demo administrator", () => {
    expect(SEED_PEOPLE.map((p) => p.local)).not.toContain("demo");
  });
});
