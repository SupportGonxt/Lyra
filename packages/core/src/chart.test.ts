import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CHART_OF_ACCOUNTS, EntitlementsJson, PolicyJson, id, schema } from "@lyra/db";
import { suspenseAccounts, tenantAccount, tenantChart, tenantChartMap } from "./chart.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

// ADR-0083 / docs/27 P2: "chart of accounts is a hard-coded TypeScript
// constant, so a tenant cannot add an account without a deploy." These tests
// hold the runtime read path: a tenant's chart comes from `ledger_accounts`,
// scoped to that tenant, and an account a tenant adds at runtime is visible
// through the same functions a seeded one is — never through the static
// `CHART_OF_ACCOUNTS` import.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const NOW = 1_700_000_000_000;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const actor: Actor = {
  kind: "user",
  id: "u_1",
  tenantId: "t_1",
  grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
};

let client: Client;
let ctx: Ctx;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor,
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/** The default chart, provisioned the way seed() provisions it. */
async function seedChart(tenantId = "t_1"): Promise<void> {
  const rows = CHART_OF_ACCOUNTS.map((a, i) => ({
    id: id("acc", NOW + i),
    tenantId,
    code: a.code,
    nameJson: JSON.stringify({ en: a.en, ar: a.ar }),
    type: a.type,
    normalSide: a.normalSide,
    clientMoney: a.clientMoney ?? false,
    suspense: a.suspense ?? false,
    currency: "AED",
    status: "active",
    createdAt: NOW
  }));
  await ctx.db.insert(schema.ledgerAccounts).values(rows);
}

describe("a tenant's chart comes from ledger_accounts, not the static constant", () => {
  it("tenantChart returns every seeded row, mirroring the default chart's fields", async () => {
    await seedChart();
    const chart = await tenantChart(ctx);
    expect(chart).toHaveLength(CHART_OF_ACCOUNTS.length);
    const byCode = Object.fromEntries(chart.map((a) => [a.code, a]));
    expect(byCode["1010"]).toMatchObject({ en: "Cash – Client Money", normalSide: "debit", clientMoney: true });
    expect(byCode["1300"]).toMatchObject({ suspense: true });
    expect(byCode["1000"]).not.toHaveProperty("clientMoney");
  });

  it("sees an account a tenant added at runtime, with no code change required", async () => {
    await seedChart();
    await ctx.db.insert(schema.ledgerAccounts).values({
      id: "acc_local_9900",
      tenantId: "t_1",
      code: "9900",
      nameJson: JSON.stringify({ en: "Custom Reserve", ar: "احتياطي مخصص" }),
      type: "liability",
      normalSide: "credit",
      clientMoney: false,
      suspense: false,
      currency: "AED",
      status: "active",
      createdAt: NOW
    });
    expect(await tenantAccount(ctx, "9900")).toMatchObject({ code: "9900", en: "Custom Reserve", normalSide: "credit" });
    expect(await tenantChart(ctx)).toHaveLength(CHART_OF_ACCOUNTS.length + 1);
  });

  it("tenantAccount and tenantChartMap agree on a known code", async () => {
    await seedChart();
    const map = await tenantChartMap(ctx);
    expect(map.get("2010")).toEqual(await tenantAccount(ctx, "2010"));
  });

  it("returns undefined for a code this tenant has never had", async () => {
    await seedChart();
    expect(await tenantAccount(ctx, "9999")).toBeUndefined();
  });

  it("never leaks another tenant's accounts", async () => {
    await seedChart("t_1");
    await seedChart("t_2");
    await ctx.db.insert(schema.ledgerAccounts).values({
      id: "acc_other_only",
      tenantId: "t_2",
      code: "8800",
      nameJson: JSON.stringify({ en: "Other Tenant Only", ar: "" }),
      type: "asset",
      normalSide: "debit",
      clientMoney: false,
      suspense: false,
      currency: "AED",
      status: "active",
      createdAt: NOW
    });
    expect(await tenantAccount(ctx, "8800")).toBeUndefined();
    expect(await tenantChart(ctx)).toHaveLength(CHART_OF_ACCOUNTS.length);
  });

  it("suspenseAccounts returns exactly the flagged accounts (1300 PSP Clearing by default)", async () => {
    await seedChart();
    const codes = (await suspenseAccounts(ctx)).map((a) => a.code);
    expect(codes).toEqual(["1300"]);
  });
});
