import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { checkCompliance, permissionsForRole, type Ctx } from "@lyra/core";
import { EMPTY_KIT, bannedClaimsFrom, brandKitFor, guardrailRecordFor, kitIsEmpty, KIT_LIST_MAX } from "./signal-brand-kit.js";

// docs/modules/signal.md §2.1. The pre-flight is pure and DB-free so the eval
// harness can score the same function; loading the tenant's kit is this file's
// only job. What matters here: a tenant with no kit behaves exactly as before,
// and a pattern the engine refuses to run costs that one rule rather than every
// generation the tenant makes.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "user", id: "u_1", tenantId: TENANT, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function kit(row: { required?: unknown; forbidden?: unknown; claims?: unknown; raw?: boolean }) {
  const asJson = (v: unknown, _fallback = "[]") => (row.raw && typeof v === "string" ? v : JSON.stringify(v ?? []));
  await ctx.db.insert(schema.signalBrandKits).values({
    id: "sbk_1",
    tenantId: TENANT,
    requiredPhrasesJson: asJson(row.required),
    forbiddenWordsJson: asJson(row.forbidden),
    bannedClaimsJson: asJson(row.claims),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("brandKitFor", () => {
  it("is the empty kit for a tenant that has configured none", async () => {
    expect(await brandKitFor(ctx)).toEqual(EMPTY_KIT);
    expect(kitIsEmpty(await brandKitFor(ctx))).toBe(true);
    // And the empty kit changes no verdict: this is what every tenant ran on.
    expect(checkCompliance("Compare nine insurers", await brandKitFor(ctx)).status).toBe("passed");
  });

  it("reads all three lists", async () => {
    await kit({
      required: ["nxt"],
      forbidden: ["cheap"],
      claims: [{ pattern: "approved by the central bank", note: "Not ours to borrow.", severity: "block" }]
    });
    const loaded = await brandKitFor(ctx);
    expect(loaded).toEqual({
      requiredPhrases: ["nxt"],
      forbiddenWords: ["cheap"],
      bannedClaims: [{ pattern: "approved by the central bank", note: "Not ours to borrow.", severity: "block" }]
    });
    expect(kitIsEmpty(loaded)).toBe(false);
  });

  it("honours a kit end to end through the pre-flight", async () => {
    await kit({ required: [], forbidden: [], claims: [{ pattern: "no questions asked", note: "Our register avoids it." }] });
    const result = checkCompliance("nxt cover, no questions asked", await brandKitFor(ctx));
    expect(result.status).toBe("flagged");
    expect(result.findings[0]).toMatchObject({ rule: "tenant_banned_claim" });
  });

  it("drops a pattern the engine will not run, and keeps the rest", async () => {
    await kit({
      claims: [
        { pattern: "(a+)+$", isRegex: true, note: "catastrophic backtracking" },
        { pattern: "guaranteed approval", note: "still enforced" }
      ]
    });
    const loaded = await brandKitFor(ctx);
    expect(loaded.bannedClaims.map((c) => c.pattern)).toEqual(["guaranteed approval"]);
  });

  it("survives a malformed blob rather than throwing a read", async () => {
    // The kit is configuration; a bad row must not take down every page that
    // reads it.
    await kit({ required: "{not json", forbidden: "null", claims: '"a string"', raw: true });
    expect(await brandKitFor(ctx)).toEqual(EMPTY_KIT);
  });

  it("drops non-strings and blanks from a list", async () => {
    await kit({ required: ["nxt", 42, "", "  ", null] });
    expect((await brandKitFor(ctx)).requiredPhrases).toEqual(["nxt"]);
  });

  it("caps each list, so a kit cannot put an unbounded scan in front of every generation", async () => {
    await kit({ forbidden: Array.from({ length: KIT_LIST_MAX + 25 }, (_, i) => `word${i}`) });
    expect((await brandKitFor(ctx)).forbiddenWords).toHaveLength(KIT_LIST_MAX);
  });
});

describe("bannedClaimsFrom", () => {
  it("treats a pattern as a literal phrase unless isRegex says otherwise", () => {
    const [literal] = bannedClaimsFrom(JSON.stringify([{ pattern: "10% off", note: "x" }]));
    expect(literal).toEqual({ pattern: "10% off", note: "x" });
    const [pattern] = bannedClaimsFrom(JSON.stringify([{ pattern: "free\\s+cover", isRegex: true, note: "x" }]));
    expect(pattern).toMatchObject({ isRegex: true });
  });

  it("only carries a severity it understands", () => {
    // Anything that is not "block" is the advisory default, so a typo in the
    // config cannot silently make a rule blocking.
    const claims = bannedClaimsFrom(JSON.stringify([{ pattern: "a", note: "x", severity: "BLOCK" }]));
    expect(claims[0]!.severity).toBeUndefined();
    const blocking = bannedClaimsFrom(JSON.stringify([{ pattern: "b", note: "x", severity: "block" }]));
    expect(blocking[0]!.severity).toBe("block");
  });

  it("needs a pattern and a note to keep an entry", () => {
    expect(bannedClaimsFrom(JSON.stringify([{ pattern: "a" }, { note: "b" }, "c", null]))).toEqual([]);
  });
});

/* ------------------------------------------------------- the guardrail record */

// docs/modules/signal.md §2.1 and the admin screen's guardrail table. The seed
// wrote `brandKit: "pass"` / `bannedClaims: "pass"` as bare strings for its own
// campaigns and nothing computed them, so every campaign a real team launched
// showed a passing guardrail table beside an empty fault list. These hold the
// two halves of the fix: the record is computed, and "nobody checked" is not
// spelled "pass".

async function campaign(id = "cmp_1") {
  await ctx.db.insert(schema.signalCampaigns).values({
    id,
    tenantId: TENANT,
    name: id,
    objective: "acq",
    channelsJson: JSON.stringify(["email"]),
    budgetJson: JSON.stringify({}),
    state: "draft",
    autonomyLevel: "act",
    ownerRef: "user:1",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function creative(id: string, over: { status?: string; findings?: unknown[]; campaignId?: string } = {}) {
  await ctx.db.insert(schema.signalCreatives).values({
    id,
    tenantId: TENANT,
    campaignId: over.campaignId ?? "cmp_1",
    kind: "ad_copy",
    locale: "en",
    contentRef: "Cover your car",
    complianceStatus: over.status ?? "passed",
    complianceNotesJson: over.findings ? JSON.stringify({ checkedAt: NOW, lane: "soft_flag", findings: over.findings }) : null,
    generatedBy: "ai",
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("guardrailRecordFor", () => {
  it("does not spell an unchecked campaign as passing", async () => {
    await campaign();
    const record = await guardrailRecordFor(ctx, "cmp_1");
    // No kit and no cleared creative are gaps, not ticks.
    expect(record).toMatchObject({ brandKit: "not-configured", bannedClaims: "unchecked", brandKitVersion: null });
  });

  it("passes only once a kit exists and a creative has cleared it", async () => {
    await campaign();
    await creative("crv_1");
    await kit({ forbidden: ["cheap"] });
    const record = await guardrailRecordFor(ctx, "cmp_1");
    expect(record).toMatchObject({ brandKit: "pass", bannedClaims: "pass", brandKitVersion: 1, frequencyCapPerWeek: 2 });
  });

  it("flags a brand finding and reports the kit version it was checked against", async () => {
    await campaign();
    await creative("crv_1", { status: "flagged", findings: [{ rule: "brand_forbidden_word", excerpt: "cheap", note: "x" }] });
    await kit({ forbidden: ["cheap"] });
    const record = await guardrailRecordFor(ctx, "cmp_1");
    expect(record.brandKit).toBe("flagged");
  });

  it("reports a blocked claim as blocked, not merely flagged", async () => {
    await campaign();
    await creative("crv_1", {
      status: "blocked",
      findings: [{ rule: "tenant_banned_claim", excerpt: "x", note: "x", severity: "block" }]
    });
    await kit({ claims: [{ pattern: "guaranteed", note: "x", severity: "block" }] });
    expect((await guardrailRecordFor(ctx, "cmp_1")).bannedClaims).toBe("blocked");
  });

  it("counts the built-in rules against the claims check too", async () => {
    await campaign();
    await creative("crv_1", {
      status: "flagged",
      findings: [{ rule: "no_guarantee_of_cover", excerpt: "guaranteed", note: "x" }]
    });
    await kit({ forbidden: ["cheap"] });
    expect((await guardrailRecordFor(ctx, "cmp_1")).bannedClaims).toBe("flagged");
  });

  it("states the window it enforces in the tenant's own zone", async () => {
    await campaign();
    ctx = { ...ctx, policy: PolicyJson.parse({ timezone: "Asia/Dubai" }) };
    const record = await guardrailRecordFor(ctx, "cmp_1");
    expect(record.quietHours).toEqual({ from: "20:00", to: "08:00", tz: "Asia/Dubai" });
    expect(record.checkedAt).toBe(NOW);
  });

  it("only counts this campaign's creatives", async () => {
    await campaign("cmp_1");
    await campaign("cmp_2");
    await kit({ forbidden: ["cheap"] });
    // A blocked creative on another campaign must not condemn this one.
    await creative("crv_other", { campaignId: "cmp_2", status: "blocked" });
    await creative("crv_mine", { campaignId: "cmp_1" });
    expect(await guardrailRecordFor(ctx, "cmp_1")).toMatchObject({ bannedClaims: "pass" });
  });
});
