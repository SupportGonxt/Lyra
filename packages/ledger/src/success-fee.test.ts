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
import { countersignPin, pinMetricSnapshot, successFeeKey } from "./metric-pins.js";
import { seedTestChart } from "./test-chart.js";

// docs/19 §11.10: "`SUCCESS-FEE` cannot post without a verified metric snapshot
// reference." docs/19 §7 says the same from the approvals side: "verified metric
// snapshot + both parties' sign-off". docs/27 F21 found neither implemented —
// SUCCESS-FEE was `spec(InvoiceArgs, invoiceRaised)` and nothing anywhere asked
// what metric it was a fee on.
//
// D11 (docs/specs/gap-finance-design.md, ADR-0111) then closed the gap the first
// fix left: a verified north_snapshots row can still be recomputed between
// sign-off and posting. The fee now names a *pin* — a hashed copy both sides
// countersigned — and its idempotency key is derived from that pin, so one pin
// bills exactly once.

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
  await seedTestChart(ctx);
});

const as = (userId: string): Ctx => ({
  ...ctx,
  actor: { kind: "user", id: userId, tenantId: ctx.tenantId, grants: ctx.actor.grants }
});

async function snapshot(id: string, tenantId = ctx.tenantId): Promise<void> {
  await ctx.db.insert(schema.northSnapshots).values({
    id,
    tenantId,
    metricKey: "gwp",
    grain: "month",
    period: "2026-05",
    dimsHash: id,
    value: 1_000_000,
    ts: NOW - 1000,
    verifiedAt: NOW - 500,
    verifiedBy: "user:u_auditor"
  });
}

async function metric(tenantId = ctx.tenantId): Promise<void> {
  await ctx.db.insert(schema.northMetrics).values({
    id: `mtr_${tenantId}`,
    tenantId,
    key: "gwp",
    nameJson: JSON.stringify({ en: "GWP" }),
    definitionSqlRef: "gwp",
    unit: "money",
    currency: "AED",
    createdAt: NOW,
    updatedAt: NOW
  });
}

/** A pin with `signed` sides countersigned, pinned by u_test. */
async function pin(snapshotId: string, signed: ("tenant" | "counterparty")[] = ["tenant", "counterparty"]): Promise<string> {
  await snapshot(snapshotId);
  const row = await pinMetricSnapshot(ctx, snapshotId);
  if (signed.includes("tenant")) await countersignPin(as("u_director"), row.id, "tenant");
  if (signed.includes("counterparty")) {
    await countersignPin(as("u_controller"), row.id, "counterparty", { evidenceRef: "esign-1" });
  }
  return row.id;
}

const ARGS = { netMinor: 10_000, taxMinor: 500 };

async function run(args: Record<string, unknown>, key?: string): Promise<{ id: string; state: string }> {
  const pinId = typeof args["pinnedSnapshotId"] === "string" ? args["pinnedSnapshotId"] : "none";
  return runTxn(
    ctx,
    { type: "SUCCESS-FEE", idempotencyKey: key ?? successFeeKey(pinId), currency: "AED" },
    {
      recipe: { lines: buildRecipe("SUCCESS-FEE", ARGS), currency: "AED" },
      args,
      preApproved: true
    }
  );
}

async function txnCount(): Promise<number> {
  return (await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId))).length;
}

const detail = (re: RegExp) => expect.objectContaining({ detail: expect.stringMatching(re) });

describe("docs/19 §11.10, D11 — SUCCESS-FEE needs a countersigned metric pin", () => {
  beforeEach(async () => {
    await metric();
  });

  it("refuses to post with no pin reference at all", async () => {
    await expect(run({ ...ARGS })).rejects.toThrowError(detail(/pinnedSnapshotId is required/i));
  });

  it("refuses the old live-snapshot reference — reading north_snapshots at posting time is the rejected design", async () => {
    await snapshot("nsp_live");
    await expect(run({ ...ARGS, metricSnapshotId: "nsp_live" })).rejects.toThrowError(detail(/pinnedSnapshotId is required/i));
  });

  it("refuses a pin that does not exist, and another tenant's", async () => {
    await expect(run({ ...ARGS, pinnedSnapshotId: "pms_nope" })).rejects.toThrowError(detail(/not found/i));
    await metric("t_other");
    const theirs = await pin("nsp_theirs");
    await ctx.db.update(schema.ledgerMetricPins).set({ tenantId: "t_other" }).where(eq(schema.ledgerMetricPins.id, theirs));
    await expect(run({ ...ARGS, pinnedSnapshotId: theirs })).rejects.toThrowError(detail(/not found/i));
  });

  it("refuses a pin only one side has countersigned", async () => {
    const ours = await pin("nsp_half", ["tenant"]);
    await expect(run({ ...ARGS, pinnedSnapshotId: ours })).rejects.toThrowError(detail(/countersigned by both/i));
    const theirs = await pin("nsp_half2", ["counterparty"]);
    await expect(run({ ...ARGS, pinnedSnapshotId: theirs })).rejects.toThrowError(detail(/countersigned by both/i));
    expect(await txnCount()).toBe(0);
  });

  it("refuses a pin whose copy no longer matches its source_hash", async () => {
    const id = await pin("nsp_tampered");
    await ctx.db.update(schema.ledgerMetricPins).set({ value: 2_000_000 }).where(eq(schema.ledgerMetricPins.id, id));
    await expect(run({ ...ARGS, pinnedSnapshotId: id })).rejects.toThrowError(detail(/source_hash/i));
    expect(await txnCount()).toBe(0);
  });

  it("refuses any idempotency key not derived from the pin", async () => {
    const id = await pin("nsp_key");
    await expect(run({ ...ARGS, pinnedSnapshotId: id }, "sf:whatever")).rejects.toThrowError(
      detail(new RegExp(`success-fee:${id}`))
    );
    expect(await txnCount()).toBe(0);
  });

  it("posts on a countersigned pin even after the live snapshot moved", async () => {
    const id = await pin("nsp_ok");
    await ctx.db.update(schema.northSnapshots).set({ value: 7, verifiedAt: null }).where(eq(schema.northSnapshots.id, "nsp_ok"));
    const txn = await run({ ...ARGS, pinnedSnapshotId: id });
    expect(txn.state).toBe("settled");
  });

  it("bills one pin exactly once: a second attempt replays the first", async () => {
    const id = await pin("nsp_once");
    const first = await run({ ...ARGS, pinnedSnapshotId: id });
    const second = await run({ ...ARGS, pinnedSnapshotId: id });
    expect(second.id).toBe(first.id);
    expect(await txnCount()).toBe(1);
  });
});
