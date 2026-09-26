import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  PERMISSIONS,
  ROLES,
  TENANT_ROLE_KEYS,
  can,
  expand,
  isInternalRole,
  isKnownPermission,
  isValidGrantString,
  permissionsForRole,
  require_,
  requiresMfa,
  type Actor
} from "./rbac.js";

function actor(roleKey: string, scope?: Actor["grants"][number]["scope"]): Actor {
  return {
    kind: "user",
    id: "u_1",
    tenantId: "t_1",
    grants: [{ roleKey, permissions: permissionsForRole(roleKey), ...(scope ? { scope } : {}) }]
  };
}

describe("can", () => {
  it("matches wildcards segment-wise", () => {
    expect(can(actor("axis.admin"), "axis:cases:approve")).toBe(true);
    expect(can(actor("axis.admin"), "signal:campaigns:launch")).toBe(false);
    expect(can(actor("platform.admin"), "compliance:erasure:execute")).toBe(true);
  });

  it("denies across tenants before looking at permissions", () => {
    expect(can(actor("platform.admin"), "core:users:read", { tenantId: "t_2" })).toBe(false);
    expect(can(actor("platform.admin"), "core:users:read", { tenantId: "t_1" })).toBe(true);
  });

  it("fails closed when a team-scoped grant meets an unscoped subject", () => {
    const scoped = actor("axis.lead", { teamIds: ["tm_a"] });
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", teamId: "tm_a" })).toBe(true);
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", teamId: "tm_b" })).toBe(false);
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1" })).toBe(false);
  });

  it("keeps scope on its own grant instead of merging across roles", () => {
    const two: Actor = {
      kind: "user",
      id: "u_1",
      tenantId: "t_1",
      grants: [
        { roleKey: "axis.lead", permissions: permissionsForRole("axis.lead"), scope: { teamIds: ["tm_a"] } },
        { roleKey: "north.board", permissions: permissionsForRole("north.board") }
      ]
    };
    // The unscoped board role must not lend its reach to the scoped AXIS role.
    expect(can(two, "axis:cases:approve", { tenantId: "t_1", teamId: "tm_b" })).toBe(false);
    expect(can(two, "north:briefings:read", { tenantId: "t_1", teamId: "tm_b" })).toBe(true);
  });

  it("masks PII behind core:pii:view regardless of role", () => {
    expect(can(actor("axis.agent"), "core:pii:view")).toBe(false);
    expect(can(actor("axis.lead"), "core:pii:view")).toBe(true);
  });

  it("holds a module-scoped grant to its own module, and lets an unscoped subject through", () => {
    const scoped = actor("axis.lead", { modules: ["axis"] });
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", module: "axis" })).toBe(true);
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", module: "signal" })).toBe(false);
    // Unlike teamIds, a module scope does not fail closed on a subject with no
    // module: modules are a filing dimension, teams are a data boundary.
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1" })).toBe(true);
  });

  it("holds a product-line-scoped grant to its own lines, and fails closed on a subject with none", () => {
    const scoped = actor("axis.lead", { productLines: ["motor"] });
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", productLine: "motor" })).toBe(true);
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1", productLine: "home" })).toBe(false);
    expect(can(scoped, "axis:cases:approve", { tenantId: "t_1" })).toBe(false);
  });

  // An empty list is "no restriction on this dimension", not "nothing allowed" —
  // otherwise a half-filled scope row would lock its holder out of everything.
  it("ignores a scope dimension that lists nothing", () => {
    const empty = actor("axis.lead", { modules: [], teamIds: [], productLines: [] });
    expect(can(empty, "axis:cases:approve", { tenantId: "t_1" })).toBe(true);
  });

  it("applies scope even with no subject to test it against", () => {
    expect(can(actor("axis.lead", { teamIds: ["tm_a"] }), "axis:cases:approve")).toBe(false);
    expect(can(actor("axis.lead", { productLines: ["motor"] }), "axis:cases:approve")).toBe(false);
    // The module dimension is the one that does not fail closed, so the absent
    // subject has to be *read* safely rather than merely not matched.
    expect(can(actor("axis.lead", { modules: ["axis"] }), "axis:cases:approve")).toBe(true);
    expect(can(actor("axis.lead"), "axis:cases:approve")).toBe(true);
  });

  // Segment-wise matching is only meaningful on three segments. Without the
  // length guard a two-segment grant matches every verb under it — "axis:cases"
  // would authorize `axis:cases:approve` — and a two-segment *request* would be
  // answered yes by any wildcard bundle. Custom tenant roles make both reachable.
  it("never authorizes across a grant or a request that is not three segments", () => {
    const holding = (permission: string): Actor => ({
      kind: "user",
      id: "u_1",
      tenantId: "t_1",
      grants: [{ roleKey: "tenant.custom", permissions: [permission] }]
    });
    expect(can(holding("axis:cases"), "axis:cases:read")).toBe(false);
    expect(can(holding("axis:*"), "axis:cases:read")).toBe(false);
    expect(can(holding("axis:cases:read:extra"), "axis:cases:read")).toBe(false);
    expect(can(holding("axis:cases:read"), "axis:cases:read")).toBe(true);
    expect(can(actor("platform.admin"), "axis:cases")).toBe(false);
    expect(can(actor("platform.admin"), "axis:cases:read")).toBe(true);
  });

  it("grants nothing for a role key the catalogue does not define", () => {
    expect(permissionsForRole("axis.wizard")).toEqual([]);
    expect(can(actor("axis.wizard"), "axis:cases:read")).toBe(false);
  });
});

describe("require_", () => {
  it("passes silently when allowed and names the permission when not", () => {
    expect(() => require_(actor("axis.admin"), "axis:cases:approve")).not.toThrow();
    try {
      require_(actor("axis.agent"), "axis:cases:approve");
      expect.unreachable("require_ should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).permission).toBe("axis:cases:approve");
      expect((err as ForbiddenError).name).toBe("ForbiddenError");
      expect((err as ForbiddenError).message).toBe("forbidden: axis:cases:approve");
    }
  });
});

describe("isInternalRole", () => {
  it.each(["tenant.admin", "axis.agent", "finance.controller", "platform.admin"])("treats %s as staff", (key) => {
    expect(isInternalRole(key)).toBe(true);
  });

  it.each(["partner.developer", "partner.manager", "provider.viewer", "customer"])(
    "treats %s as external",
    (key) => {
      expect(isInternalRole(key)).toBe(false);
    }
  );
});

describe("grant strings", () => {
  it("knows exactly the catalogue, and no wildcard, as a concrete permission", () => {
    expect(isKnownPermission("axis:cases:read")).toBe(true);
    expect(isKnownPermission("axis:*:*")).toBe(false);
    expect(isKnownPermission("axis:unicorns:read")).toBe(false);
  });

  // A grant string is what a tenant types into a custom role, so it is a trust
  // boundary: a wildcard that expands to nothing is a typo, not a permission.
  it.each([
    ["a concrete permission", "axis:cases:read", true],
    ["a segment wildcard", "axis:cases:*", true],
    ["a module wildcard", "axis:*:*", true],
    ["the everything wildcard", "*:*:*", true],
    ["a wildcard over a module nobody has", "unicorn:*:*", false],
    ["too few segments", "axis:*", false],
    ["too many segments", "axis:cases:read:extra", false],
    ["nothing at all", "", false]
  ])("treats %s as %s", (_label, grant, valid) => {
    expect(isValidGrantString(grant)).toBe(valid);
  });
});

describe("requiresMfa", () => {
  it("requires MFA when ANY internal role is held, even alongside external ones", async () => {
    // .every() let one external role exempt an admin from MFA.
    expect(requiresMfa(["partner.developer", "tenant.admin"])).toBe(true);
    expect(requiresMfa(["customer", "finance.controller"])).toBe(true);
  });

  it("exempts only purely external accounts, and fails closed on no roles at all", async () => {
    expect(requiresMfa(["partner.developer"])).toBe(false);
    expect(requiresMfa(["provider.viewer", "customer"])).toBe(false);
    expect(requiresMfa([])).toBe(true);
  });
});

describe("role catalogue", () => {
  it("grants only permissions that exist", () => {
    for (const [key, bundle] of Object.entries(ROLES)) {
      for (const p of bundle) {
        expect(isValidGrantString(p), `${key} grants unknown permission ${p}`).toBe(true);
      }
    }
  });

  it("keeps north.board read-only", () => {
    for (const p of expand(permissionsForRole("north.board"))) {
      expect(p.endsWith(":read"), `north.board may not hold ${p}`).toBe(true);
    }
  });

  /**
   * The class, not the instance. A permission the API's `require_()` and the web
   * app's gates name, that no tenant role resolves — directly or through a
   * wildcard — is a screen no tenant user can ever reach. Three separate
   * instances of that have been found and patched one at a time; this asserts
   * the invariant instead.
   *
   * `admin:*` is the one legitimate exception: docs/06 reserves it for goNXT
   * staff, and TENANT_ROLE_KEYS deliberately excludes the platform.* roles that
   * hold it. Everything else in the catalogue is a tenant surface, so something
   * inside the tenant must be able to reach it. Widening this exemption to make
   * a new permission pass is the bug, not the fix — grant it to a role.
   */
  it("puts every non-platform permission in reach of at least one tenant role", () => {
    const held = new Set(TENANT_ROLE_KEYS.flatMap((key) => expand(permissionsForRole(key))));
    const unreachable = PERMISSIONS.filter((p) => !p.startsWith("admin:") && !held.has(p));
    expect(unreachable).toEqual([]);
  });

  // platform.* roles are goNXT staff and are deliberately not provisioned into a
  // tenant; every other catalogue role is.
  it("provisions every role into a tenant except the platform ones", () => {
    expect([...TENANT_ROLE_KEYS].sort()).toEqual(Object.keys(ROLES).filter((k) => !k.startsWith("platform.")).sort());
    expect(TENANT_ROLE_KEYS.filter((k) => k.startsWith("platform."))).toEqual([]);
    expect(TENANT_ROLE_KEYS).toContain("tenant.admin");
  });

  it("expands a wildcard bundle to concrete permissions and only those", () => {
    const axis = expand(["axis:*:*"]);
    expect(axis).toContain("axis:cases:read");
    expect(axis.every((p) => p.startsWith("axis:"))).toBe(true);
    expect(expand(["*:*:*"])).toEqual([...PERMISSIONS]);
    expect(expand([])).toEqual([]);
  });

  it("gives external roles no tenant-staff reach", () => {
    for (const key of ["customer", "partner.developer", "partner.manager", "provider.viewer"]) {
      const granted = expand(permissionsForRole(key));
      expect(granted.filter((p) => p.startsWith("core:") || p.startsWith("admin:"))).toEqual([]);
    }
  });

  // A bundle nobody can do anything with is a role that should not be in the
  // catalogue. The customer portal role is the one deliberate blank: its reach
  // is the portal's own, not a grant string.
  it("leaves no role but the customer with an empty bundle", () => {
    expect(Object.entries(ROLES).filter(([, b]) => b.length === 0).map(([k]) => k)).toEqual(["customer"]);
  });

  // Module roles open with `...readsOf(module)` rather than a hand-listed set,
  // so the module argument is load-bearing: get it wrong and the role silently
  // starts from nothing while every other assertion here still passes.
  it.each([
    ["axis.agent", "axis"],
    ["axis.lead", "axis"],
    ["orbit.agent", "orbit"],
    ["orbit.lead", "orbit"],
    ["orbit.retention", "orbit"],
    ["orbit.partners", "orbit"],
    ["signal.marketer", "signal"],
    ["signal.lead", "signal"],
    ["scout.pm", "scout"],
    ["scout.lead", "scout"],
    ["north.exec", "north"],
    ["north.analyst", "north"],
    ["finance.analyst", "ledger"],
    ["finance.director", "ledger"]
  ])("starts %s from every read in %s", (roleKey, module) => {
    const bundle = permissionsForRole(roleKey);
    const reads = PERMISSIONS.filter((p) => p.startsWith(`${module}:`) && p.endsWith(":read"));
    expect(reads.length).toBeGreaterThan(1);
    for (const p of reads) expect(bundle, `${roleKey} misses ${p}`).toContain(p);
  });

  // The other half of that helper: it filters on the module prefix *and* on the
  // read verb. Widening either filter hands the agent the lead's QA scoring or
  // another module's book, and no count-based assertion notices.
  it("inherits reads of that module only, and no verb but read", () => {
    const agent = permissionsForRole("orbit.agent");
    expect(agent).not.toContain("orbit:qa:score");
    expect(agent).not.toContain("signal:campaigns:read");
  });
});

// Spend actuals are what the autopilot's CAC and every response rate divide by;
// a table only a demo tick could write was a seam with no writer (docs/30).
describe("signal:spend:write", () => {
  it("is a declared permission held by the growth lead and the admin, not the marketer", () => {
    expect(PERMISSIONS).toContain("signal:spend:write");
    const holds = (role: string) => can({ kind: "user", id: "u", tenantId: "t", grants: [{ roleKey: role, permissions: permissionsForRole(role) }] }, "signal:spend:write", { tenantId: "t" });
    expect(holds("signal.lead")).toBe(true);
    expect(holds("signal.admin")).toBe(true);
    expect(holds("signal.marketer")).toBe(false);
  });
});
