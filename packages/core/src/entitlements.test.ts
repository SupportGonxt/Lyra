import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson } from "@lyra/db";
import { assertSeatAvailable, entitledGrants, moduleOn } from "./entitlements.js";
import type { Ctx } from "./context.js";

// One answer to "can this tenant use module X right now": it bought it and has
// not switched it off. The same subtraction entitledGrants applies to grants,
// asked by engines that must behave differently when a sibling is absent.

const ctx = (modules: string[], off: string[] = []) => ({
  entitlements: EntitlementsJson.parse({ modules }),
  policy: PolicyJson.parse({ moduleConfig: Object.fromEntries(off.map((m) => [m, { enabled: false }])) })
});

describe("moduleOn", () => {
  it("is on only when bought and not switched off", () => {
    expect(moduleOn(ctx(["axis", "scout"]), "axis")).toBe(true);
    expect(moduleOn(ctx(["scout"]), "axis")).toBe(false);
    expect(moduleOn(ctx(["axis", "scout"], ["axis"]), "axis")).toBe(false);
  });

  it("treats the platform as always on", () => {
    expect(moduleOn(ctx([]), "dist")).toBe(true);
    expect(moduleOn(ctx([]), "core")).toBe(true);
  });
});

describe("entitledGrants", () => {
  const grants = [{ roleKey: "r", permissions: ["axis:policies:read", "orbit:cases:read", "core:users:read", "*:*:*"] }];
  const ents = (modules: string[]) => EntitlementsJson.parse({ modules });

  it("keeps every grant whole when nothing is off", () => {
    const all = ents(["axis", "orbit", "signal", "scout", "north"]);
    const out = entitledGrants(grants, all);
    expect(out).toEqual(grants);
    expect(out).not.toBe(grants);
  });

  it("drops the permissions of an unbought module and of a switched-off one, never core or a wildcard", () => {
    const out = entitledGrants(grants, ents(["axis", "orbit"]), { orbit: { enabled: false } });
    expect(out).toEqual([{ roleKey: "r", permissions: ["axis:policies:read", "core:users:read", "*:*:*"] }]);
  });

  it("matches the module prefix exactly", () => {
    const out = entitledGrants([{ roleKey: "r", permissions: ["axisx:a:b", "axis:a:b"] }], ents([]));
    expect(out[0]!.permissions).toEqual(["axisx:a:b"]);
  });

  it("leaves a module on unless it says enabled: false", () => {
    const all = ents(["axis", "orbit", "signal", "scout", "north"]);
    expect(entitledGrants(grants, all, { axis: {} })).toEqual(grants);
  });
});

describe("assertSeatAvailable", () => {
  const ctxWith = (users: number, seats: number) => {
    let limited = -1;
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: (n: number) => {
        limited = n;
        return Promise.resolve(Array.from({ length: users }, (_, i) => ({ id: `u${i}` })));
      }
    };
    const c = {
      db: chain,
      tenantId: "t1",
      entitlements: EntitlementsJson.parse({ seats }),
      policy: PolicyJson.parse({})
    } as unknown as Ctx;
    return { c, limit: () => limited };
  };

  it("lets a user in while a seat is free, reading no more rows than the seats", async () => {
    const { c, limit } = ctxWith(2, 3);
    await expect(assertSeatAvailable(c)).resolves.toBeUndefined();
    expect(limit()).toBe(3);
  });

  it("refuses the next user once every seat is taken, naming the limit", async () => {
    const { c } = ctxWith(3, 3);
    await expect(assertSeatAvailable(c)).rejects.toMatchObject({ status: 403, detail: "seat limit reached (3 seats)" });
  });
});
