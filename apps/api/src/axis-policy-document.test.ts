import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { issuePolicyDocument } from "./engines/axis-policy-document.js";

// docs/27 F5 §D.11. The certificate is the document handed to a third party, so
// the one thing it must never do is fail to exist: the cover dates it prints
// come off a stored version row, and a row written before the API bounded its
// write surfaces can hold an instant no `Date` can. `toISOString()` throws
// RangeError on those, and the throw is mid-render — no document at all, rather
// than a document with one unreadable line.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.UTC(2026, 5, 15, 12);
const YEAR = 365 * 86_400_000;

let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: {
      kind: "user",
      id: "u_runner",
      tenantId: "t_test",
      grants: [{ roleKey: "owner", permissions: ["*:*:*"] }]
    },
    requestId: "req_doc",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/** One bound contract and its version-1 terms, with the cover dates given. */
async function policyWithCover(effectiveFrom: number, effectiveTo: number) {
  const policy = {
    id: "pol_1",
    tenantId: ctx.tenantId,
    customerId: "cus_1",
    providerId: "prv_1",
    policyNo: "POL-0001",
    startAt: effectiveFrom,
    endAt: effectiveTo,
    premiumMinor: 120_000,
    currency: "AED",
    currentVersionId: "pov_1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  };
  await ctx.db.insert(schema.axisPolicies).values(policy);
  await ctx.db.insert(schema.axisPolicyVersions).values({
    id: "pov_1",
    tenantId: ctx.tenantId,
    policyId: policy.id,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom,
    effectiveTo,
    premiumMinor: 120_000,
    currency: "AED",
    termsJson: JSON.stringify({ cover: "comprehensive" }),
    state: "effective",
    issuedBy: "user:u_runner",
    issuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  return policy as never;
}

/** A customer for `pol_1`, with the name blob and locale given. */
async function customer(nameJson: Record<string, string>, locale = "en") {
  await ctx.db.insert(schema.customers).values({
    id: "cus_1",
    tenantId: ctx.tenantId,
    nameJson: JSON.stringify(nameJson),
    locale,
    createdAt: NOW,
    updatedAt: NOW
  });
}

/** An R2 stand-in that keeps the bytes it was handed. */
function bucket(): { r2: R2Bucket; bytes: () => string } {
  let kept: Uint8Array | undefined;
  const r2 = {
    put: async (_key: string, value: Uint8Array) => {
      kept = value;
      return null;
    }
  } as unknown as R2Bucket;
  return { r2, bytes: () => new TextDecoder("latin1").decode(kept) };
}

/** ActualText spans (UTF-16BE hex) — the logical text of each drawn string. */
function spans(pdf: string): string[] {
  return [...pdf.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)].map((m) =>
    String.fromCharCode(...m[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16)))
  );
}

/** The embedded-face glyph runs, decoded through the ToUnicode CMap, in drawn order. */
function viaToUnicode(pdf: string): string[][] {
  const map = new Map<string, string>();
  const cmap = /begincmap([\s\S]*?)endcmap/.exec(pdf)![1]!;
  for (const [, gid, hex] of cmap.matchAll(/<([0-9A-F]{4})>\s*<([0-9A-F]+)>/g)) {
    map.set(gid!, String.fromCharCode(...hex!.match(/.{4}/g)!.map((h) => parseInt(h, 16))));
  }
  return [...pdf.matchAll(/\/F3 [\d.]+ Tf <([0-9A-F]*)> Tj/g)].map((m) => m[1]!.match(/.{4}/g)!.map((g) => map.get(g)!));
}

// ADR-0114. A customer who gave only an Arabic name used to get no schedule at
// all: the renderer drew Latin only, the English fallback did not exist, and
// the issue ended in a 409 — about 18% of a simulated month's policies.
describe("policy document — a customer named only in Arabic", () => {
  it("issues the schedule with the Arabic name drawn, not a conflict", async () => {
    const policy = await policyWithCover(NOW - YEAR, NOW + YEAR);
    await customer({ ar: "مريم الكعبي" });
    const out = bucket();

    const issued = await issuePolicyDocument(ctx, policy, { kind: "schedule" }, out.r2);

    expect(issued.kind).toBe("schedule");
    const pdf = out.bytes();
    expect(pdf).toContain("/Subtype /Type0");
    expect(pdf).toContain("/FontFile2");
    expect(pdf).toMatch(/\/ToUnicode \d+ 0 R/);
    // Read back through ToUnicode, the drawn run is the name reversed —
    // visual order — so reversing it gives the name as she wrote it.
    const runs = viaToUnicode(pdf);
    expect(runs.map((r) => [...r].reverse().join(""))).toContain("مريم الكعبي");
    expect(spans(pdf)).toContain("مريم الكعبي");
    // The reader asked in English, so the labels are English.
    expect(pdf).toContain("(Policy schedule) Tj");
  });

  it("prefers the name in the document's language when there are two", async () => {
    const policy = await policyWithCover(NOW - YEAR, NOW + YEAR);
    await customer({ en: "Maryam Al Kaabi", ar: "مريم الكعبي" }, "ar");
    const out = bucket();

    await issuePolicyDocument(ctx, policy, { kind: "schedule" }, out.r2);

    expect(spans(out.bytes())).toContain("مريم الكعبي");
    expect(out.bytes()).not.toContain("Maryam");
  });

  it("writes an Arabic-locale customer's schedule in Arabic, right to left", async () => {
    const policy = await policyWithCover(NOW - YEAR, NOW + YEAR);
    await customer({ ar: "مريم الكعبي" }, "ar");
    const out = bucket();

    await issuePolicyDocument(ctx, policy, { kind: "schedule" }, out.r2);

    const text = spans(out.bytes());
    expect(text).toContain("جدول الوثيقة");
    expect(text).toContain("رقم الوثيقة");
    expect(text).toContain("القسط");
    expect(text.some((s) => /^صفحة 1 من \d+$/.test(s))).toBe(true);
    expect(out.bytes()).not.toContain("(Policy schedule)");
  });

  it("keeps an English customer's schedule exactly as it was", async () => {
    const policy = await policyWithCover(NOW - YEAR, NOW + YEAR);
    await customer({ en: "Maryam Al Kaabi", ar: "مريم الكعبي" });
    const out = bucket();

    await issuePolicyDocument(ctx, policy, { kind: "schedule" }, out.r2);

    expect(out.bytes()).toContain("(Maryam Al Kaabi) Tj");
    expect(out.bytes()).not.toContain("/Type0");
  });
});

describe("policy document — cover dates no Date can hold", () => {
  it("issues the certificate anyway", async () => {
    const policy = await policyWithCover(NOW - YEAR, 9e15);

    const issued = await issuePolicyDocument(ctx, policy, { kind: "certificate" });

    expect(issued.kind).toBe("certificate");
    const files = await ctx.db.select().from(schema.files);
    expect(files).toHaveLength(1);
  });

  it("still issues one for a term a Date can hold", async () => {
    const policy = await policyWithCover(NOW - YEAR, NOW);

    const issued = await issuePolicyDocument(ctx, policy, { kind: "certificate" });

    expect(issued.kind).toBe("certificate");
  });
});
