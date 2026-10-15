import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, sha256Hex, type Ctx } from "@lyra/core";
import { assembleCaseBundle, trailTables } from "./axis-audit-bundle.js";

// docs/modules/axis.md §8 acceptance criterion 3: "Any case exports a complete
// signed audit bundle." Nothing implemented it — bundles existed for ledger recon
// and compliance and none for a case.
//
// What these hold, beyond "it runs": the manifest is the guarantee, so it is
// checked rather than trusted. Every entry's sha256 must match its own bytes, the
// audit chain must be present (that is what makes it an *audit* bundle), and an
// absent artefact must be **named** — a bundle that silently omits the policy of
// an unbound case reads as a case with no policy, which is a worse claim than
// the truth.

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
    actor: { kind: "user", id: "u_test", tenantId: TENANT, grants: [{ roleKey: "axis.lead", permissions: permissionsForRole("axis.lead") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function seedCase(over: { quoteRequestId?: string | null } = {}) {
  await ctx.db.insert(schema.axisCases).values({
    id: "cas_1",
    tenantId: TENANT,
    ref: "CASE-0001",
    kind: "quote",
    customerId: "cus_1",
    status: "quoting",
    source: "web",
    quoteRequestId: over.quoteRequestId ?? null,
    ownerRef: "user:1",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function seedRequest() {
  await ctx.db.insert(schema.distQuoteRequests).values({
    id: "dqr_1",
    tenantId: TENANT,
    channelId: "chn_1",
    productId: "prd_1",
    inputsJson: JSON.stringify({ line: "motor" }),
    fanoutCount: 3,
    respondedCount: 3,
    currency: "AED",
    state: "complete",
    createdAt: NOW,
    updatedAt: NOW
  } as never);
  // The panel answered: without these the bundle honestly reports that the shop
  // was sent and nothing came back.
  await ctx.db.insert(schema.distQuoteResponses).values([
    { id: "dqs_1", tenantId: TENANT, requestId: "dqr_1", offeringId: "off_1", providerId: "prv_1", state: "quoted", taxMinor: 0, feesMinor: 0, createdAt: NOW, updatedAt: NOW },
    { id: "dqs_2", tenantId: TENANT, requestId: "dqr_1", offeringId: "off_2", providerId: "prv_2", state: "quoted", taxMinor: 0, feesMinor: 0, createdAt: NOW, updatedAt: NOW },
    { id: "dqs_3", tenantId: TENANT, requestId: "dqr_1", offeringId: "off_3", providerId: "prv_3", state: "declined", taxMinor: 0, feesMinor: 0, createdAt: NOW, updatedAt: NOW }
  ] as never);
}

async function seedPolicy() {
  await ctx.db.insert(schema.axisPolicies).values({
    id: "pol_1",
    tenantId: TENANT,
    caseId: "cas_1",
    customerId: "cus_1",
    providerId: "prv_1",
    policyNo: "POL-1",
    startAt: NOW,
    endAt: NOW + 365 * 86_400_000,
    premiumMinor: 400_000,
    currency: "AED",
    status: "in_force",
    createdAt: NOW,
    updatedAt: NOW
  } as never);
}

const entryFor = (bundle: Awaited<ReturnType<typeof assembleCaseBundle>>, path: string) =>
  bundle.manifest.entries.find((e) => e.path === path);

describe("assembleCaseBundle", () => {
  it("carries the case, its shop, its documents and the audit chain", async () => {
    await seedRequest();
    await seedCase({ quoteRequestId: "dqr_1" });
    await seedPolicy();
    await ctx.db.insert(schema.auditLog).values([
      { id: "aud_1", tenantId: TENANT, actorRef: "user:1", action: "axis.case.created", subjectRef: "axis_case:cas_1", chainHash: "h1", ts: NOW - 100 },
      { id: "aud_2", tenantId: TENANT, actorRef: "user:1", action: "axis.policy.bound", subjectRef: "axis_policy:pol_1", chainHash: "h2", prevHash: "h1", ts: NOW - 50 }
    ]);

    const bundle = await assembleCaseBundle(ctx, "cas_1");
    const paths = bundle.contents.map((c) => c.path);

    expect(paths).toContain("case.json");
    expect(paths).toContain("quote-requests.json");
    expect(paths).toContain("policies.json");
    expect(paths).toContain("audit.jsonl");
    expect(bundle.manifest.counts).toMatchObject({ cases: 1, quoteRequests: 1, quoteResponses: 3, policies: 1, auditEntries: 2 });
    expect(bundle.manifest.missing).toEqual([]);
  });

  it("names what is not there instead of omitting it", async () => {
    // An unbound case has no policy; saying nothing would read as a case whose
    // policy is missing from the bundle.
    await seedCase();
    const bundle = await assembleCaseBundle(ctx, "cas_1");
    expect(bundle.manifest.missing.some((m) => m.startsWith("policy:"))).toBe(true);
    expect(bundle.manifest.missing.some((m) => m.startsWith("quote_request:"))).toBe(true);
    expect(bundle.contents.map((c) => c.path)).not.toContain("policies.json");
  });

  it("hashes every entry over its own bytes, so a reader can verify against the manifest", async () => {
    await seedCase();
    const bundle = await assembleCaseBundle(ctx, "cas_1");

    expect(bundle.manifest.entries.length).toBe(bundle.contents.length);
    for (const file of bundle.contents) {
      const entry = entryFor(bundle, file.path);
      expect(entry, file.path).toBeDefined();
      expect(entry!.sizeBytes).toBe(file.data.length);
      expect(entry!.sha256).toBe(await sha256Hex(file.data));
      expect(entry!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("orders the audit chain by time, which is what prevHash walks", async () => {
    await seedCase();
    await ctx.db.insert(schema.auditLog).values([
      { id: "aud_late", tenantId: TENANT, actorRef: "user:1", action: "b", subjectRef: "axis_case:cas_1", chainHash: "h2", prevHash: "h1", ts: NOW },
      { id: "aud_early", tenantId: TENANT, actorRef: "user:1", action: "a", subjectRef: "axis_case:cas_1", chainHash: "h1", ts: NOW - 1000 }
    ]);
    const bundle = await assembleCaseBundle(ctx, "cas_1");
    const chain = JSON.parse(`[${new TextDecoder().decode(bundle.contents.find((c) => c.path === "audit.jsonl")!.data).trim().split("\n").join(",")}]`) as { action: string }[];
    expect(chain.map((row) => row.action)).toEqual(["a", "b"]);
  });

  it("says so when no audit row names the case, rather than shipping an empty chain", async () => {
    await seedCase();
    const bundle = await assembleCaseBundle(ctx, "cas_1");
    expect(bundle.manifest.missing.some((m) => m.startsWith("audit:"))).toBe(true);
  });

  it("explains its own guarantee rather than leaving the word 'signed' to be assumed", async () => {
    await seedCase();
    const bundle = await assembleCaseBundle(ctx, "cas_1");
    expect(bundle.manifest.hashNote).toContain("tamper-evident");
    expect(bundle.manifest.hashNote).toContain("not cryptographically signed");
  });

  it("never crosses a tenant boundary", async () => {
    await seedCase();
    await ctx.db.insert(schema.axisCases).values({
      id: "cas_other",
      tenantId: "t_2",
      ref: "CASE-OTHER",
      kind: "quote",
      status: "quoting",
      source: "web",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
    await expect(assembleCaseBundle(ctx, "cas_other")).rejects.toThrow("not found");
  });
});

describe("the PDF half (docs/modules/axis.md §2.4, audit-on-demand)", () => {
  it("builds the trail from the bundle itself, not from the database", async () => {
    await seedCase();
    const bundle = await assembleCaseBundle(ctx, "cas_1");
    const tables = trailTables(bundle);
    const titles = tables.map((t) => t.title);
    expect(titles).toContain("Audit chain");
    expect(titles).toContain("Documents");
    // Every table is stamped with the bundle's own generation time, so a PDF
    // cannot claim a currency the archive it travels in does not have.
    for (const table of tables) expect(table.generatedAt).toBe(bundle.manifest.generatedAt);
  });

  it("says 'None' for what is missing rather than dropping the table", async () => {
    // A reader must be able to tell "nothing was missing" from "this page was
    // never generated", and an absent table cannot say that.
    await seedRequest();
    await seedCase({ quoteRequestId: "dqr_1" });
    await seedPolicy();
    // A complete bundle: the case, its shop with answers, a policy and a chain.
    // "Nothing is missing" is only reachable when all four are present.
    await ctx.db.insert(schema.auditLog).values({
      id: "aud_1", tenantId: TENANT, actorRef: "user:1", action: "axis.case.created", subjectRef: "axis_case:cas_1", chainHash: "h1", ts: NOW
    });
    const tables = trailTables(await assembleCaseBundle(ctx, "cas_1"));
    const missing = tables.find((t) => t.title === "Expected and not present")!;
    expect(missing.rows).toEqual([{ what: "None" }]);
  });

  it("carries the chain's own hashes, so the page can be verified against the JSON", async () => {
    await seedCase();
    await ctx.db.insert(schema.auditLog).values({
      id: "aud_1", tenantId: TENANT, actorRef: "user:1", action: "axis.case.created", subjectRef: "axis_case:cas_1", chainHash: "deadbeef", ts: NOW
    });
    const chain = trailTables(await assembleCaseBundle(ctx, "cas_1")).find((t) => t.title === "Audit chain")!;
    expect(chain.rows).toHaveLength(1);
    expect(chain.rows[0]).toMatchObject({ action: "axis.case.created", chainHash: "deadbeef" });
  });

  it("labels in Arabic as well as English", async () => {
    await seedCase();
    const arabic = trailTables(await assembleCaseBundle(ctx, "cas_1"), "ar").map((t) => t.title);
    expect(arabic).toContain("سلسلة التدقيق");
    // An unknown locale falls back to English rather than to blank labels.
    expect(trailTables(await assembleCaseBundle(ctx, "cas_1"), "fr").map((t) => t.title)).toContain("Audit chain");
  });
});
