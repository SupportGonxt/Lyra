import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson } from "@lyra/db";
import { moduleOn } from "./entitlements.js";

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
