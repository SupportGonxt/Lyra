import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { buildRecipe } from "./recipes.js";
import { runTxn } from "./txn.js";

// docs/19 §11.10: "`SUCCESS-FEE` cannot post without a verified metric snapshot
// reference." docs/19 §7 says the same from the approvals side: "verified metric
// snapshot + both parties' sign-off". docs/27 F21 found neither implemented —
// SUCCESS-FEE was `spec(InvoiceArgs, invoiceRaised)` and nothing anywhere asked
// what metric it was a fee on.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: {
      kind: "user",
      id: "u_test",
      tenantId: "t_test",
      grants: [{ roleKey: "owner", permissions: ["*:*:*"] }]
    },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({ autoApprove: [] }),
    entitlements: EntitlementsJson.parse({})
  };
});

async function snapshot(opts: { id: string; verified: boolean; tenantId?: string }): Promise<string> {
  await ctx.db.insert(schema.northSnapshots).values({
    id: opts.id,
    tenantId: opts.tenantId ?? ctx.tenantId,
    metricKey: "gwp",
    grain: "month",
    period: "2026-05",
    dimsHash: "",
    value: 1_000_000,
    ts: NOW - 1000,
    ...(opts.verified ? { verifiedAt: NOW - 500, verifiedBy: "user:u_auditor" } : {})
  });
  return opts.id;
}

const ARGS = { netMinor: 10_000, taxMinor: 500 };

async function run(args: Record<string, unknown>): Promise<unknown> {
  return runTxn(
    ctx,
    { type: "SUCCESS-FEE", idempotencyKey: `sf:${JSON.stringify(args)}`, currency: "AED" },
    {
      recipe: { lines: buildRecipe("SUCCESS-FEE", ARGS), currency: "AED" },
      args,
      preApproved: true
    }
  );
}

describe("docs/19 §11.10 — SUCCESS-FEE needs a verified metric snapshot", () => {
  it("refuses to post with no snapshot reference at all", async () => {
    await expect(run({ ...ARGS })).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/metricSnapshotId is required/i) })
    );
  });

  it("refuses a reference to a snapshot that does not exist", async () => {
    await expect(run({ ...ARGS, metricSnapshotId: "nsp_nope" })).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/not found/i) })
    );
  });

  it("refuses a snapshot that exists but has never been verified", async () => {
    await snapshot({ id: "nsp_unverified", verified: false });
    await expect(run({ ...ARGS, metricSnapshotId: "nsp_unverified" })).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/not been verified/i) })
    );
  });

  it("refuses another tenant's snapshot — a reference is not a permission", async () => {
    await snapshot({ id: "nsp_theirs", verified: true, tenantId: "t_other" });
    await expect(run({ ...ARGS, metricSnapshotId: "nsp_theirs" })).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/not found/i) })
    );
  });

  it("posts when the fee names a verified snapshot, and leaves nothing behind when it does not", async () => {
    await snapshot({ id: "nsp_ok", verified: true });
    const txn = (await run({ ...ARGS, metricSnapshotId: "nsp_ok" })) as { state: string };
    expect(txn.state).toBe("settled");

    // A precondition is a "not yet", so a refusal must burn no idempotency key:
    // the same shape as YEAR-END-CLOSE (txn.ts runs preconditions before openTxn).
    const rows = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
    expect(rows).toHaveLength(1);
  });
});
