import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A permission is a promise to whoever configures a role: granting it does
// something. When nothing requires it, the grant is decorative — and this is the
// shape that made `signal:creatives:publish` a live defect rather than a tidy
// one: `signal.lead` held it and the publish route asked for
// `signal:creatives:approve`, which `tenant.compliance` holds. So the growth lead
// was refused by their own permission while the wrong role held the door.
//
// This is the inverse guard to `spec.routes.test.ts` (a link with no screen). It
// asks the other direction: a permission with no requirement. Seventeen sightings
// of the dead-seam family are recorded in CLAUDE.md and every one of them was
// found by a person reading; five of the six tools written to find them were
// themselves dead seams. A ratchet is what keeps this list at zero.
//
// Two lessons from that round are built in here:
//   - the extraction must understand *computed* permissions (`rw("signal:aeo")`
//     builds `signal:aeo:read`/`:write`; `${agent.module}:ai:invoke` builds eight
//     strings; `readsOf("signal")` grants every signal read). A literal-only scan
//     reported all of those as unenforced — six false positives on this list.
//   - a guard that selects its own subjects must assert it selected them, so the
//     population sizes are asserted below rather than assumed.

const API_SRC = join(import.meta.dirname);
const CORE_SRC = join(API_SRC, "..", "..", "..", "packages", "core", "src");
const RBAC = join(CORE_SRC, "rbac.ts");

/** Every module prefix a template-built permission can be expanded over. */
const MODULES = ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal", "analytics", "compliance", "admin", "platform"];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      tsFiles(path, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

const PERM = /"[a-z]+:[a-z_]+:[a-z_]+"/g;

/** Every permission the roles can be granted. */
export function declaredPermissions(): Set<string> {
  const source = readFileSync(RBAC, "utf8");
  return new Set((source.match(PERM) ?? []).map((one) => one.slice(1, -1)));
}

/** Every permission some non-test source can require, computed forms included. */
export function requiredPermissions(): Set<string> {
  const declared = declaredPermissions();
  const required = new Set<string>();
  const sources = [...tsFiles(API_SRC), ...tsFiles(CORE_SRC)].filter((file) => file !== RBAC);

  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const one of source.match(PERM) ?? []) required.add(one.slice(1, -1));

    // The resource builders: rw/ru/ro turn a stem into the per-action names.
    for (const match of source.matchAll(/\b(rw|ru|ro)\((?:"([^"]+)"|`([^`]+)`)/g)) {
      const stem = match[2] ?? match[3] ?? "";
      if (match[1] === "rw") {
        required.add(`${stem}:read`);
        required.add(`${stem}:write`);
      }
      else if (match[1] === "ru") {
        required.add(`${stem}:read`);
        required.add(`${stem}:update`);
      }
      else required.add(stem);
    }

    // `` `${agent.module}:ai:invoke` `` — a template no literal scan can see.
    for (const match of source.matchAll(/`\$\{[^}]+\}:([a-z:]+)`/g)) {
      for (const module of MODULES) required.add(`${module}:${match[1]}`);
    }

    // `...readsOf("signal")` grants every read permission under that module.
    for (const match of source.matchAll(/readsOf\("([a-z]+)"\)/g)) {
      for (const permission of declared) {
        if (permission.startsWith(`${match[1]}:`) && permission.endsWith(":read")) required.add(permission);
      }
    }
  }
  return required;
}

/**
 * Permissions declared with nothing requiring them, each with the reason it is
 * allowed to stand — and the ratchet. Every entry here is a **finding**, not an
 * approval: the reason says why it is not enforced *yet*, and adding one costs a
 * line in this map, which is the point.
 *
 * SIGNAL is absent deliberately: its three (`signal:campaigns:pause`,
 * `signal:budget_moves:reverse`, `signal:creatives:publish`) were enforced on
 * 2026-10-01 rather than exempted, and any new one now fails this test.
 */
export const EXEMPT: Record<string, string> = {
  // Capabilities that exist under a broader permission, where the finer seam is
  // declared for a future where the two are separated.
  "axis:cases:delete": "deleting a case is `axis:cases:update` today; the finer seam is reserved",
  "axis:complaints:close": "closing a complaint is `axis:complaints:update` today",
  "axis:policies:refer": "referring a policy rides the policy update permission",
  "axis:quotes:compare": "the comparison read is `axis:quotes:read` today",
  "axis:siu:decide": "an SIU referral is decided through `axis:siu:write` (the referral is a row; the decision is an update on it)",
  "core:customers:update": "customer edits are `core:customers:write` today",
  "core:customers:delete": "there is no delete path for a customer, and no route intends one — GDPR erasure is a DSAR, not a delete",
  "core:users:delete": "staff are deactivated, never deleted (the audit chain names them)",
  "dist:channels:suspend": "suspension is `dist:channels:update` today",
  "dist:offerings:withdraw": "withdrawal is `dist:offerings:update` today",
  "ledger:journals:void": "a journal is reversed by a new entry, never voided (docs/19)",
  "ledger:payments:create": "payments are created by the settlement engine, not by a permissioned route",
  "orbit:conversations:close": "closing a conversation is `orbit:conversations:update` today",
  // Reads whose screens do not exist yet: declared with the module, not used.
  "admin:tenants:read": "cross-tenant reads belong to the platform surface, which ships separately",
  "axis:reports:read": "no AXIS reports screen yet; the permission ships with the module",
  "dev:consoles:read": "the dev consoles are gated by ENVIRONMENT, not by a permission (they 404 off-demo)",
  // Partner key issuance: the sandbox keys are issued today; live keys are not.
  "orbit:partner_keys:issue_test": "issued by the seed and the sandbox console, which gates on `orbit:partner_keys:write`"
};

describe("every declared permission is required somewhere, or says why not", () => {
  const declared = declaredPermissions();
  const required = requiredPermissions();

  it("selected a plausible population on both sides", () => {
    // A guard that selects its own subjects must say it selected them: if the
    // extraction breaks, the difference goes empty and this file proves nothing.
    expect(declared.size).toBeGreaterThan(300);
    expect(required.size).toBeGreaterThan(400);
  });

  it("enforces SIGNAL completely — no SIGNAL permission is exempt", () => {
    // The module that ships first carries no decorative grants.
    expect(Object.keys(EXEMPT).filter((key) => key.startsWith("signal:"))).toEqual([]);
  });

  it("has no declared permission that is neither required nor explained", () => {
    const unenforced = [...declared].filter((one) => !required.has(one));
    const unexplained = unenforced.filter((one) => !(one in EXEMPT));
    expect(unexplained).toEqual([]);
  });

  it("keeps the exemption list honest — an entry that becomes enforced must leave it", () => {
    // The ratchet's other direction: exempting something and then enforcing it
    // leaves a stale excuse in the file, which is how the next reader is misled.
    const nowEnforced = Object.keys(EXEMPT).filter((one) => required.has(one));
    expect(nowEnforced).toEqual([]);
  });

  /**
   * The direction a route-level permission can be wrong in the *other* way.
   *
   * A permission a route requires but no roster declares is held by nobody, so
   * the route is unreachable for everyone — and nothing notices, because the
   * route's own test supplies the grant. This was found while building AXIS's
   * audit bundle: the new `axis:cases:export` was required before it was
   * declared, and the guard above passed because it only ever checked
   * declared → required.
   *
   * The scan is deliberately narrow. A general "required but undeclared" sweep
   * over every quoted string reports ten, of which most are data — an API-key
   * scope, a telemetry source, a SAML URN, seeded partner refs, and a
   * `forbidden("core:approvals:finish")` reason label. Those are exactly the
   * false positives that would teach a reader to ignore this file, so the test
   * checks the one position where the string *is* a grant.
   */
  it("grants only permissions that exist", () => {
    // `permissions: [...]` on a grant, and `scopesJson` on an API key — the two
    // places a string is handed to an actor as authority (auth.ts: a key's
    // scopes become its permissions verbatim).
    const granted = new Set<string>();
    for (const file of tsFiles(API_SRC).concat(tsFiles(CORE_SRC))) {
      if (file.endsWith("rbac.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/permissions:\s*\[([^\]]*)\]/g)) {
        for (const one of match[1]!.match(/"[a-z]+:[a-z_]+:[a-z_]+"/g) ?? []) granted.add(one.slice(1, -1));
      }
      for (const match of source.matchAll(/scopesJson:\s*JSON\.stringify\(\[([^\]]*)\]/g)) {
        for (const one of match[1]!.match(/"[a-z]+:[a-z_]+:[a-z_]+"/g) ?? []) granted.add(one.slice(1, -1));
      }
    }
    expect(granted.size).toBeGreaterThan(2);
    const unknown = [...granted].filter((one) => !declared.has(one)).sort();
    expect(unknown).toEqual([]);
  });

  it("gives every exemption a reason rather than a blank", () => {
    for (const [permission, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, permission).toBeGreaterThan(20);
    }
  });
});
