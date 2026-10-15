import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx } from "@lyra/core";
import {
  COMPLAINER_WINDOW_DAYS,
  PURCHASER_WINDOW_DAYS,
  complaintSuppresses,
  purchaseSuppresses,
  suppressionFloor,
  suppressionWindows
} from "./signal-suppression.js";

// docs/modules/signal.md §2.2: "suppression lists always applied (recent
// purchasers, do-not-contact, complainers)". Consent was the only one wired, so
// a first send would have reached people who bought last week and people with an
// open regulated complaint. These hold the two added causes and, as importantly,
// their boundaries — a suppression that over-reaches silently shrinks a
// legitimate audience.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const DAY = 86_400_000;
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
    actor: { kind: "system", id: "sweep", tenantId: TENANT, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function bind(customerId: string, at: number) {
  await ctx.db.insert(schema.signalAttributionEvents).values({
    id: `ate_${customerId}_${at}`,
    tenantId: TENANT,
    customerId,
    touchType: "bind",
    channel: "meta",
    ts: at
  });
}

async function complaint(customerId: string, over: { state?: string; resolvedAt?: number | null } = {}) {
  await ctx.db.insert(schema.axisComplaints).values({
    id: `cmp_${customerId}_${over.resolvedAt ?? "open"}`,
    tenantId: TENANT,
    ref: `CMP-${customerId}`,
    customerId,
    channel: "email",
    categoryCode: "service",
    receivedAt: NOW - 10 * DAY,
    dueAt: NOW + 5 * DAY,
    resolvedAt: over.resolvedAt ?? null,
    state: over.state ?? "investigating",
    redressMinor: 0,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY
  });
}

describe("the windows", () => {
  it("defaults, and reads a tenant's own numbers", () => {
    expect(suppressionWindows({})).toEqual({ purchaserDays: PURCHASER_WINDOW_DAYS, complainerDays: COMPLAINER_WINDOW_DAYS });
    expect(suppressionWindows({ suppression: { purchaserDays: 7, complainerDays: 14 } })).toEqual({ purchaserDays: 7, complainerDays: 14 });
  });

  it("refuses nonsense rather than shrinking a window to nothing", () => {
    // A zero-day window would silently un-suppress everyone, which is the one
    // failure mode an operator would never notice.
    expect(suppressionWindows({ suppression: { purchaserDays: 0 } }).purchaserDays).toBe(PURCHASER_WINDOW_DAYS);
    expect(suppressionWindows({ suppression: { purchaserDays: -5 } }).purchaserDays).toBe(PURCHASER_WINDOW_DAYS);
    expect(suppressionWindows({ suppression: { purchaserDays: 1.5 } }).purchaserDays).toBe(PURCHASER_WINDOW_DAYS);
    expect(suppressionWindows({ suppression: { purchaserDays: 99999 } }).purchaserDays).toBe(PURCHASER_WINDOW_DAYS);
    expect(suppressionWindows({ suppression: "yesterday" }).purchaserDays).toBe(PURCHASER_WINDOW_DAYS);
  });
});

describe("the boundaries", () => {
  const windows = { purchaserDays: 30, complainerDays: 30 };

  it("suppresses a purchase inside the window and not one outside it", () => {
    expect(purchaseSuppresses(NOW - 10 * DAY, NOW, windows)).toBe(true);
    expect(purchaseSuppresses(NOW - 30 * DAY, NOW, windows)).toBe(true);
    expect(purchaseSuppresses(NOW - 31 * DAY, NOW, windows)).toBe(false);
  });

  it("suppresses an open complaint however old it is", () => {
    // Mid-complaint marketing is the case that becomes a regulator's letter, so
    // age does not expire it.
    expect(complaintSuppresses({ state: "investigating", resolvedAt: null }, NOW, windows)).toBe(true);
    expect(complaintSuppresses({ state: "escalated", resolvedAt: null }, NOW, windows)).toBe(true);
  });

  it("suppresses a resolved complaint for its window, and then not", () => {
    expect(complaintSuppresses({ state: "resolved", resolvedAt: NOW - 5 * DAY }, NOW, windows)).toBe(true);
    expect(complaintSuppresses({ state: "resolved", resolvedAt: NOW - 31 * DAY }, NOW, windows)).toBe(false);
  });
});

describe("suppressionFloor", () => {
  it("finds a recent purchaser and leaves an old one alone", async () => {
    await bind("cus_recent", NOW - 3 * DAY);
    await bind("cus_old", NOW - 200 * DAY);
    const floor = await suppressionFloor(ctx);
    expect(floor.byCustomer.get("cus_recent")).toBe("recent_purchaser");
    expect(floor.byCustomer.has("cus_old")).toBe(false);
    expect(floor.counts.recent_purchaser).toBe(1);
  });

  it("ignores every touch that is not a purchase", async () => {
    // A click is not a purchase; suppressing on any touch would empty the funnel.
    await ctx.db.insert(schema.signalAttributionEvents).values({
      id: "ate_click",
      tenantId: TENANT,
      customerId: "cus_clicked",
      touchType: "click",
      channel: "meta",
      ts: NOW - DAY
    });
    expect((await suppressionFloor(ctx)).byCustomer.has("cus_clicked")).toBe(false);
  });

  it("finds an open complaint and a freshly resolved one", async () => {
    await complaint("cus_open", { state: "investigating" });
    await complaint("cus_just_resolved", { state: "resolved", resolvedAt: NOW - 2 * DAY });
    await complaint("cus_long_resolved", { state: "resolved", resolvedAt: NOW - 200 * DAY });
    const floor = await suppressionFloor(ctx);
    expect(floor.byCustomer.get("cus_open")).toBe("complainer");
    expect(floor.byCustomer.get("cus_just_resolved")).toBe("complainer");
    expect(floor.byCustomer.has("cus_long_resolved")).toBe(false);
    expect(floor.counts.complainer).toBe(2);
  });

  it("puts the complaint first when somebody is both", async () => {
    // The operator needs the serious fact, not the incidental one.
    await bind("cus_both", NOW - 2 * DAY);
    await complaint("cus_both", { state: "escalated" });
    expect((await suppressionFloor(ctx)).byCustomer.get("cus_both")).toBe("complainer");
  });

  it("scopes the scan to the customers in hand", async () => {
    await bind("cus_in", NOW - DAY);
    await bind("cus_out", NOW - DAY);
    const floor = await suppressionFloor(ctx, {}, ["cus_in"]);
    expect(floor.byCustomer.has("cus_in")).toBe(true);
    expect(floor.byCustomer.has("cus_out")).toBe(false);
  });

  it("honours the tenant's own windows", async () => {
    await bind("cus_recent", NOW - 10 * DAY);
    expect((await suppressionFloor(ctx, {})).byCustomer.has("cus_recent")).toBe(true);
    expect((await suppressionFloor(ctx, { suppression: { purchaserDays: 5 } })).byCustomer.has("cus_recent")).toBe(false);
  });

  it("is empty for a tenant with nothing to suppress", async () => {
    const floor = await suppressionFloor(ctx);
    expect(floor.byCustomer.size).toBe(0);
    expect(floor.counts).toEqual({ recent_purchaser: 0, complainer: 0 });
  });

  it("never crosses a tenant boundary", async () => {
    await ctx.db.insert(schema.signalAttributionEvents).values({
      id: "ate_other",
      tenantId: "t_2",
      customerId: "cus_other_tenant",
      touchType: "bind",
      channel: "meta",
      ts: NOW - DAY
    });
    expect((await suppressionFloor(ctx)).byCustomer.has("cus_other_tenant")).toBe(false);
  });

  it("needs many customers without tripping a bind limit", async () => {
    // D1 binds at most ~100 parameters per statement, so the scan chunks.
    const ids = Array.from({ length: 150 }, (_, i) => `cus_${i}`);
    for (const id of ids.slice(0, 120)) await bind(id, NOW - DAY);
    const floor = await suppressionFloor(ctx, {}, ids);
    expect(floor.counts.recent_purchaser).toBe(120);
  });
});
