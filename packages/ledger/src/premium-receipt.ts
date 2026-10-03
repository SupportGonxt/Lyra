import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, type Ctx } from "@lyra/core";
import type { PostingLine } from "./posting.js";
import { buildRecipe, type RecipeArgs } from "./recipes.js";

// docs/27 F14 books gross written premium at bind as Dr 1200 Premium Receivable
// / Cr 2000 Insurer Payable, and `clientMoneyReceipt` has a form that clears it.
// That form was a parameter no caller passed: every receipt in the product
// posted the plain Dr 1010 / Cr 2010 pair, so 1200 was debited at each bind and
// credited by nothing — a paid policy aged as unpaid for ever and the Money Map
// read every bound premium as still due.
//
// This is the one place a premium receipt is built. It asks the ledger how much
// of the named item's receivable is open, in the receipt's currency, and clears
// exactly that much (never more than the cash that arrived), on the item's own
// dims so the open-item aging nets the bind against the receipt. Whatever the
// caller said about clearing is discarded: how much a customer still owes is a
// fact the ledger holds, not an argument. `premium-receipt.guard.test.ts`
// (apps/api) fails on any premium receipt built anywhere else.

/** Cash in from a customer for premium. The Money Map's premium-in reads these. */
export const PREMIUM_RECEIPT_TYPES = ["CM-RECEIPT", "PREM-COLLECT", "PREM-INSTALMENT"] as const;
export type PremiumReceiptType = (typeof PREMIUM_RECEIPT_TYPES)[number];

const PREMIUM_RECEIVABLE = "1200";

export function isPremiumReceipt(type: string): type is PremiumReceiptType {
  return (PREMIUM_RECEIPT_TYPES as readonly string[]).includes(type);
}

/**
 * The open-item key a receipt names: `dims.item` as the bind wrote it, or the
 * policy it is for (the bind keys its legs `policy:<id>`). A receipt that names
 * neither clears nothing — matching cash to a debt by guessing is how a debt
 * silently disappears from the aging.
 */
function itemKey(dims: unknown): string | null {
  if (!dims || typeof dims !== "object") return null;
  const d = dims as Record<string, unknown>;
  if (typeof d["item"] === "string" && d["item"]) return d["item"];
  if (typeof d["policy"] === "string" && d["policy"]) return `policy:${d["policy"]}`;
  return null;
}

/** What is still owed on one item of 1200, and the dims the bind gave it. */
export async function openPremiumReceivable(
  ctx: Ctx,
  item: string,
  currency: string
): Promise<{ openMinor: number; dims: Record<string, string | number> | null }> {
  const l = schema.ledgerJournalLines;
  const rows = await ctx.db
    .select({ side: l.side, amountMinor: l.amountMinor, dimsJson: l.dimsJson })
    .from(l)
    .where(
      and(
        eq(l.tenantId, ctx.tenantId),
        eq(l.accountCode, PREMIUM_RECEIVABLE),
        eq(l.currency, currency),
        sql`json_extract(${l.dimsJson}, '$.item') = ${item}`
      )
    )
    .orderBy(asc(l.postedAt));
  let openMinor = 0;
  let dims: Record<string, string | number> | null = null;
  for (const r of rows) {
    openMinor += r.side === "debit" ? r.amountMinor : -r.amountMinor;
    if (!dims && r.side === "debit" && r.dimsJson) dims = JSON.parse(r.dimsJson) as Record<string, string | number>;
  }
  return { openMinor: Math.max(0, openMinor), dims };
}

/**
 * Build a premium receipt's lines, clearing whatever receivable is open for the
 * item it names. Async because the answer is in the ledger; otherwise exactly
 * `buildRecipe(type, args)`.
 */
export async function premiumReceiptLines(
  ctx: Ctx,
  type: string,
  args: RecipeArgs,
  currency: string
): Promise<PostingLine[]> {
  if (!isPremiumReceipt(type)) throw badRequest(`${type} is not a premium receipt`);
  const {
    clearsReceivableAccount: _account,
    clearsReceivableMinor: _minor,
    receivableDims: _dims,
    ...rest
  } = args;
  const amount = typeof rest["amountMinor"] === "number" ? rest["amountMinor"] : 0;
  const item = itemKey(rest["dims"]);
  if (!item || amount <= 0) return buildRecipe(type, rest);

  const open = await openPremiumReceivable(ctx, item, currency);
  const cleared = Math.min(amount, open.openMinor);
  if (cleared <= 0) return buildRecipe(type, rest);
  return buildRecipe(type, {
    ...rest,
    clearsReceivableAccount: PREMIUM_RECEIVABLE,
    clearsReceivableMinor: cleared,
    ...(open.dims ? { receivableDims: open.dims } : {})
  });
}
