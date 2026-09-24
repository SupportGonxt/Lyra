import { CHART_OF_ACCOUNTS, id, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";

// ADR-0083: post() and the reports now read a tenant's chart from
// `ledger_accounts` rather than the static `CHART_OF_ACCOUNTS` import, the
// same way seed() provisions a real tenant (packages/core/src/seed.ts). Every
// packages/ledger test that posts a batch or reads a report needs this row
// set on file, exactly like a real tenant has from the moment it is seeded.
//
// `onConflictDoNothing` on the same (tenantId, code) unique index seed() and
// syncChartOfAccounts rely on: several test files build a second `Ctx` at a
// later `now` against the *same* in-memory db to simulate the clock moving
// on, and would otherwise re-seed the same tenant's chart and hit that index.
export async function seedTestChart(ctx: Ctx): Promise<void> {
  await ctx.db
    .insert(schema.ledgerAccounts)
    .values(
      CHART_OF_ACCOUNTS.map((a, i) => ({
        id: id("acc", ctx.now + i),
        tenantId: ctx.tenantId,
        code: a.code,
        nameJson: JSON.stringify({ en: a.en, ar: a.ar }),
        type: a.type,
        normalSide: a.normalSide,
        clientMoney: a.clientMoney ?? false,
        suspense: a.suspense ?? false,
        cashFlow: a.cashFlow ?? null,
        currency: "AED",
        status: "active",
        createdAt: ctx.now
      }))
    )
    .onConflictDoNothing();
}
