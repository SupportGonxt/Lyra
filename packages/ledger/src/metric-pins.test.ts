import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { canonicalJson, sha256Hex, type Ctx } from "@lyra/core";
import { countersignPin, pinHashInput, pinMetricSnapshot, pinSourceHash, successFeeKey } from "./metric-pins.js";

// docs/specs/gap-finance-design.md D11, ADR-0111. A success fee is billed on a
// pinned copy of one verified snapshot, countersigned by both sides — never on
// the live north_snapshots row, which may be recomputed after sign-off.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
  .map((s) => s.trim())
  .filter(Boolean);

const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;

const as = (userId: string): Ctx => ({
  ...ctx,
  actor: { kind: "user", id: userId, tenantId: ctx.tenantId, grants: ctx.actor.grants }
});

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of SQL) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: { kind: "user", id: "u_pinner", tenantId: "t_test", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({ autoApprove: [] }),
    entitlements: EntitlementsJson.parse({})
  };
  await ctx.db.insert(schema.northMetrics).values({
    id: "mtr_gwp",
    tenantId: ctx.tenantId,
    key: "gwp",
    nameJson: JSON.stringify({ en: "GWP", ar: "GWP" }),
    definitionSqlRef: "gwp",
    unit: "money",
    currency: "AED",
    grain: "month",
    createdAt: NOW,
    updatedAt: NOW
  });
});

async function snapshot(id: string, opts: { verified: boolean; tenantId?: string; value?: number } = { verified: true }) {
  await ctx.db.insert(schema.northSnapshots).values({
    id,
    tenantId: opts.tenantId ?? ctx.tenantId,
    metricKey: "gwp",
    grain: "month",
    period: "2026-05",
    dimsHash: id,
    value: opts.value ?? 1_000_000,
    ts: NOW - 1000,
    ...(opts.verified ? { verifiedAt: NOW - 500, verifiedBy: "user:u_auditor", verificationRef: "stmt-5" } : {})
  });
}

const detail = (re: RegExp) => expect.objectContaining({ detail: expect.stringMatching(re) });

describe("pinMetricSnapshot", () => {
  it("copies the verified row, its unit and currency, and hashes the copy", async () => {
    await snapshot("nsp_1");
    const pin = await pinMetricSnapshot(ctx, "nsp_1");

    expect(pin).toMatchObject({
      sourceSnapshotId: "nsp_1",
      metricKey: "gwp",
      period: "2026-05",
      value: 1_000_000,
      unit: "money",
      currency: "AED",
      state: "pinned",
      pinnedBy: "user:u_pinner",
      sourceVerifiedBy: "user:u_auditor"
    });
    expect(pin.sourceHash).toBe(await sha256Hex(canonicalJson(pinHashInput(pin))));
    expect(pin.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unverified snapshot, a missing one and another tenant's", async () => {
    await snapshot("nsp_raw", { verified: false });
    await snapshot("nsp_theirs", { verified: true, tenantId: "t_other" });
    await expect(pinMetricSnapshot(ctx, "nsp_raw")).rejects.toThrowError(detail(/not been verified/));
    await expect(pinMetricSnapshot(ctx, "nsp_none")).rejects.toThrowError(expect.objectContaining({ status: 404 }));
    await expect(pinMetricSnapshot(ctx, "nsp_theirs")).rejects.toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("pins a snapshot once — a second pin would be a second bill", async () => {
    await snapshot("nsp_1");
    await pinMetricSnapshot(ctx, "nsp_1");
    await expect(pinMetricSnapshot(as("u_other"), "nsp_1")).rejects.toThrowError(detail(/already pinned/));
  });

  it("does not move when the live snapshot is later recomputed", async () => {
    await snapshot("nsp_1");
    const pin = await pinMetricSnapshot(ctx, "nsp_1");
    await ctx.db.update(schema.northSnapshots).set({ value: 9_999_999 }).where(eq(schema.northSnapshots.id, "nsp_1"));
    const [row] = await ctx.db.select().from(schema.ledgerMetricPins).where(eq(schema.ledgerMetricPins.id, pin.id));
    expect(row!.value).toBe(1_000_000);
    expect(await pinSourceHash(row!)).toBe(pin.sourceHash);
  });

  it("audits the pin", async () => {
    await snapshot("nsp_1");
    const pin = await pinMetricSnapshot(ctx, "nsp_1");
    const rows = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), eq(schema.auditLog.action, "ledger.metric_pin.pinned")));
    expect(rows.map((r) => r.subjectRef)).toEqual([`ledger_metric_pin:${pin.id}`]);
  });
});

describe("countersignPin", () => {
  let pinId: string;
  beforeEach(async () => {
    await snapshot("nsp_1");
    pinId = (await pinMetricSnapshot(ctx, "nsp_1")).id;
  });

  it("walks pinned → countersigned once both sides have signed", async () => {
    const half = await countersignPin(as("u_director"), pinId, "tenant");
    expect(half).toMatchObject({ state: "pinned", tenantSignedBy: "user:u_director", tenantSignedAt: NOW });
    const full = await countersignPin(as("u_controller"), pinId, "counterparty", { evidenceRef: "esign-778" });
    expect(full).toMatchObject({
      state: "countersigned",
      counterpartySignedBy: "user:u_controller",
      counterpartyEvidenceRef: "esign-778"
    });
  });

  it("either side may sign first", async () => {
    await countersignPin(as("u_controller"), pinId, "counterparty", { evidenceRef: "esign-778" });
    const full = await countersignPin(as("u_director"), pinId, "tenant");
    expect(full.state).toBe("countersigned");
  });

  it("refuses our signature from whoever pinned — dual control", async () => {
    await expect(countersignPin(ctx, pinId, "tenant")).rejects.toThrowError(detail(/pinned it/));
  });

  it("refuses the same person on both sides", async () => {
    await countersignPin(as("u_director"), pinId, "tenant");
    await expect(
      countersignPin(as("u_director"), pinId, "counterparty", { evidenceRef: "esign-778" })
    ).rejects.toThrowError(detail(/both sides/));
  });

  it("refuses the counterparty side without its evidence", async () => {
    await expect(countersignPin(as("u_controller"), pinId, "counterparty")).rejects.toThrowError(detail(/evidenceRef/));
  });

  it("signs each side once", async () => {
    await countersignPin(as("u_director"), pinId, "tenant");
    await expect(countersignPin(as("u_third"), pinId, "tenant")).rejects.toThrowError(detail(/already signed/));
  });

  it("refuses another tenant's pin", async () => {
    const other = { ...as("u_director"), tenantId: "t_other" };
    await expect(countersignPin(other, pinId, "tenant")).rejects.toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("audits each signature", async () => {
    await countersignPin(as("u_director"), pinId, "tenant");
    await countersignPin(as("u_controller"), pinId, "counterparty", { evidenceRef: "esign-778" });
    const rows = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), eq(schema.auditLog.action, "ledger.metric_pin.countersigned")));
    expect(rows).toHaveLength(2);
  });
});

describe("successFeeKey", () => {
  it("is derived from the pin id alone", () => {
    expect(successFeeKey("pms_1")).toBe("success-fee:pms_1");
  });
});
