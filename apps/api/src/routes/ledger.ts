import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { actorRef, audit, badRequest, can, notFound, require_, scoped, sha256Hex, withIdempotency, type Ctx } from "@lyra/core";
import { id, schema } from "@lyra/db";
import {
  RECIPES,
  argFields,
  TXN_STATES,
  TXN_TYPES,
  accountStatement,
  agedBalances,
  agedOpenItems,
  balanceOf,
  balanceSheet,
  buildRecipe,
  chartOfAccountsTable,
  clientMoneyPosition,
  closeChecks,
  closePeriod,
  closeRun,
  commissionByDimension,
  decideMatch,
  ensurePeriod,
  FORCE_REASON_MIN,
  fxRevaluationPlan,
  getTxn,
  periodCode,
  profitAndLoss,
  rebuildBalances,
  reconSummary,
  reconcile,
  parseStatement,
  STATEMENT_FORMATS,
  reopenPeriod,
  reverseTxn,
  runTxn,
  transition,
  trialBalance,
  trialBalanceTable,
  TXN_PRECONDITIONS,
  txnType,
  valueFlow,
  valueFlowLines,
  yearEndPreview,
  type MatchProposer,
  type ReportTable,
  type TxnState
} from "@lyra/ledger";
import { promptInstant, type Gateway } from "@lyra/model-gateway";
import { EXPORT_FORMATS, isExportFormat, render } from "../engines/export/render.js";
import { meterEgress } from "../engines/egress.js";
import { utf8, zip } from "../engines/export/zip.js";
import { must } from "../rows.js";
import { body, instantParam, InstantMs } from "../http.js";
import type { App } from "../env.js";

// docs/19. The ledger package holds the invariants; this file is the doorway.
// Note what is absent: no endpoint writes a journal line directly. Money moves
// by running a transaction type, which picks its recipe from the table — so a
// new transaction is a row in RECIPES, never a new posting path.

export const ledgerRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/* ------------------------------------------------------------ transactions */

const RunBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  currency: z.string().length(3).optional(),
  baseCurrency: z.string().length(3).optional(),
  fxRatePpm: z.number().int().positive().optional(),
  grossMinor: z.number().int().optional(),
  correlationId: z.string().optional(),
  parentTxnId: z.string().optional(),
  subjectRefs: z.record(z.string(), z.string()).optional(),
  amounts: z.record(z.string(), z.number().int()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  periodCode: z.string().optional(),
  reason: z.string().max(500).optional(),
  /** Recipe arguments — validated by the recipe's own schema, not here. */
  args: z.record(z.string(), z.unknown()).default({})
});

/** The one write path for money. `type` is a key in TXN_TYPES. */
ledgerRoutes.post("/txn/:type", async (c) => {
  const ctx = ctxOf(c);
  const type = c.req.param("type").toUpperCase();
  const def = txnType(type); // throws 400 for an unknown code
  // docs/27 F2. Drafting is the analyst's half of dual control: a transaction
  // that cannot settle without a second seat's approval may be *originated* by a
  // drafter, and nothing else may. Everything that settles on its own still
  // needs the full create permission.
  const subject = { tenantId: ctx.tenantId, module: "ledger" };
  if (!(def.approval && can(ctx.actor, "ledger:journals:draft", subject))) {
    require_(ctx.actor, "ledger:txns:create", subject);
  }
  const input = await body(c, RunBody);

  const currency = input.currency ?? ctx.policy.currency;
  const recipe = RECIPES[type]
    ? {
        lines: buildRecipe(type, { ...input.args, currency }),
        currency,
        ...(input.baseCurrency !== undefined ? { baseCurrency: input.baseCurrency } : {}),
        ...(input.fxRatePpm !== undefined ? { fxRatePpm: input.fxRatePpm } : {}),
        ...(input.periodCode !== undefined ? { periodCode: input.periodCode } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {})
      }
    : null; // non-financial types settle without a batch

  const txn = await withIdempotency(ctx, c.req.header("idempotency-key"), `ledger.txn.${type}`, input, () =>
    runTxn(
      ctx,
      {
        type,
        idempotencyKey: input.idempotencyKey,
        currency,
        actorKind: ctx.actor.kind,
        ...(input.baseCurrency !== undefined ? { baseCurrency: input.baseCurrency } : {}),
        ...(input.grossMinor !== undefined ? { grossMinor: input.grossMinor } : {}),
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.parentTxnId !== undefined ? { parentTxnId: input.parentTxnId } : {}),
        ...(input.subjectRefs !== undefined ? { subjectRefs: input.subjectRefs } : {}),
        ...(input.amounts !== undefined ? { amounts: input.amounts } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
      },
      {
        recipe,
        // The recipe arguments travel with the run: built lines cannot answer
        // "which fiscal year is this", which is what a precondition asks.
        args: input.args,
        event: { name: `ledger.txn.${type.toLowerCase()}.settled` }
      }
    )
  );

  return c.json({ txn, type: def }, 201);
});

ledgerRoutes.get("/txn/:id", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:txns:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await getTxn(ctx, c.req.param("id")));
});

/** The transaction-type catalogue, for the UI's type picker and the docs. */
ledgerRoutes.get("/txn-types", (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:txns:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json({
    data: Object.entries(TXN_TYPES).map(([code, def]) => ({
      ...def,
      code,
      financial: Boolean(RECIPES[code]),
      // The recipe's arguments as a field list, so the UI asks for money in a
      // money field rather than asking for JSON (docs/ui.md §7 P3-16).
      args: argFields(code)
    }))
  });
});

/** Manual state moves for the operator: only the legal hops, always audited. */
ledgerRoutes.post("/txn/:id/transition", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:txns:authorize", { tenantId: ctx.tenantId, module: "ledger" });
  const input = await body(
    c,
    z.object({
      to: z.enum(TXN_STATES),
      reason: z.string().max(500).optional(),
      failureCode: z.string().max(64).optional(),
      failureDetail: z.string().max(500).optional()
    })
  );
  const { to, ...opts } = input;
  return c.json(await transition(ctx, c.req.param("id"), to as TxnState, opts));
});

ledgerRoutes.post("/txn/:id/reverse", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:txns:reverse", { tenantId: ctx.tenantId, module: "ledger" });
  const input = await body(
    c,
    z.object({ reason: z.string().min(3).max(500), idempotencyKey: z.string().optional() })
  );
  const { reason, idempotencyKey } = input;
  return c.json(
    await reverseTxn(ctx, c.req.param("id"), reason, idempotencyKey ? { idempotencyKey } : {})
  );
});

/* ----------------------------------------------------------------- periods */

/**
 * Singular on purpose. `/periods/:id` belongs to the generated CRUD record
 * handler, and a hand-written route registered first would swallow it — the
 * record screen would then get this `{period, checks}` wrapper where it expects
 * a flat row and render nothing. The enriched view lives one path over.
 */
ledgerRoutes.get("/period/:code", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:periods:read", { tenantId: ctx.tenantId, module: "ledger" });
  const code = c.req.param("code");
  return c.json({ period: await ensurePeriod(ctx, code), checks: await closeChecks(ctx, code) });
});

// The permission and approval gates live in closePeriod/reopenPeriod (ADR D10),
// so a close reached from a scheduler is gated the same as one reached from here.
// docs/27 F20. `force` used to be a bare boolean off the body: no reason, no
// evidence, nothing an auditor could read. It is now a *pair* — the flag and the
// reason arrive together or the request is a 400 — and the schema says so, so a
// caller cannot send the flag alone and discover the rule from the engine.
const ClosePeriodBody = z
  .object({
    to: z.enum(["soft_closed", "hard_closed"]),
    force: z.boolean().default(false),
    reason: z.string().min(FORCE_REASON_MIN).max(500).optional()
  })
  .refine((v) => !v.force || Boolean(v.reason), {
    message: `forcing a close requires a reason of at least ${FORCE_REASON_MIN} characters naming the break being accepted`,
    path: ["reason"]
  });

ledgerRoutes.post("/periods/:code/close", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, ClosePeriodBody);
  return c.json(
    await closePeriod(ctx, c.req.param("code"), input.to, {
      force: input.force,
      ...(input.reason !== undefined ? { reason: input.reason } : {})
    })
  );
});

ledgerRoutes.post("/periods/:code/reopen", async (c) => {
  const ctx = ctxOf(c);
  // A month that was signed off and is now open again says why, on the same
  // terms as a forced close.
  const input = await body(c, z.object({ reason: z.string().min(FORCE_REASON_MIN).max(500) }));
  return c.json(await reopenPeriod(ctx, c.req.param("code"), { reason: input.reason }));
});

/* ----------------------------------------------------- fx revaluation (F18) */

// docs/19 §5.3. Two routes and the same read behind both: the preview a
// controller signs off and the entry that posts must be the same computation,
// for the same reason year-end close reads its closing lines off the ledger
// rather than accepting them from a browser.

ledgerRoutes.get("/fx-revaluation", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const at = asOf(qOf(c));
  return c.json(await fxRevaluationPlan(ctx, at !== undefined ? { asOf: at } : {}));
});

ledgerRoutes.post("/fx-revaluation", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:post", { tenantId: ctx.tenantId, module: "ledger" });
  const at = asOf(qOf(c));
  const plan = await fxRevaluationPlan(ctx, at !== undefined ? { asOf: at } : {});
  if (!plan.adjustments.length) throw badRequest("nothing to revalue: every open foreign balance is already carried at the closing rate");

  const period = periodCode(at ?? ctx.now);
  const args = {
    adjustments: plan.adjustments.map((a) => ({
      accountCode: a.accountCode,
      deltaMinor: a.deltaMinor,
      currency: a.currency,
      memo: `fx revaluation ${a.currency}->${plan.baseCurrency} @ ${a.ratePpm}ppm`
    }))
  };
  // One revaluation per period, whoever asks and however many times.
  const txn = await runTxn(
    ctx,
    {
      type: "FX-REVAL",
      idempotencyKey: `fxreval:${period}`,
      currency: plan.baseCurrency,
      grossMinor: Math.abs(plan.netMinor)
    },
    {
      recipe: { lines: buildRecipe("FX-REVAL", args), currency: plan.baseCurrency },
      args,
      event: { name: "ledger.txn.fx-reval.settled" }
    }
  );
  return c.json({ txn, plan }, 201);
});

/* ---------------------------------------------------------------- year end */

// docs/27 F3. One transaction zeroes every income and expense account into
// retained earnings. The closing lines are read out of the ledger on both
// routes rather than accepted from the caller: the preview a controller signs
// off and the entry that posts have to be the same read, and a browser that
// could state retained earnings could state it wrong.

function fiscalYear(raw: string): number {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw badRequest(`bad fiscal year ${raw}`);
  return year;
}

ledgerRoutes.get("/year-end/:year", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await yearEndPreview(ctx, fiscalYear(c.req.param("year"))));
});

ledgerRoutes.post("/year-end/:year", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:periods:year_end", { tenantId: ctx.tenantId, module: "ledger" });
  const year = fiscalYear(c.req.param("year"));
  const preview = await yearEndPreview(ctx, year);
  // "Nothing to close" is only true for a year that was never traded. A year
  // that was closed already also reads as empty here, and the caller is owed
  // that answer instead — so let the precondition inside runTxn speak first.
  if (!preview.closingLines.length) {
    await TXN_PRECONDITIONS["YEAR-END-CLOSE"]?.(ctx, { fiscalYear: year });
    throw badRequest(`fiscal year ${year} has nothing to close`);
  }

  const args = {
    fiscalYear: year,
    retainedEarningsAccount: preview.retainedEarningsAccount,
    closingLines: preview.closingLines.map((l) => ({
      accountCode: l.accountCode,
      side: l.side,
      amountMinor: l.amountMinor,
      memo: `year-end close ${year}: ${l.name}`
    }))
  };
  const currency = preview.currency;

  // `yearend:{year}` is the key on purpose: a replay is a no-op through the
  // unique index, whoever sends it and however many times (D8).
  const txn = await runTxn(
    ctx,
    { type: "YEAR-END-CLOSE", idempotencyKey: `yearend:${year}`, currency, actorKind: ctx.actor.kind },
    {
      // The year's months are soft closed by the time this runs — that is the
      // precondition — so the entry states its adjustment reason, as any posting
      // into a frozen month must (docs/19 §6).
      recipe: {
        lines: buildRecipe("YEAR-END-CLOSE", { ...args, currency }),
        currency,
        reason: `year-end close ${year}`
      },
      args,
      event: { name: "ledger.txn.year-end-close.settled" }
    }
  );
  return c.json({ txn, preview }, 201);
});

/* ----------------------------------------------------------------- reports */

/** The one way a report reads its parameters, shared by the JSON and file routes. */
type Query = (key: string) => string | undefined;

const qOf =
  (c: { req: { query(k: string): string | undefined } }): Query =>
  (key) =>
    c.req.query(key);

const asOf = (q: Query): number | undefined => instantParam(q("asOf"));

/** Built once so the file and the screen are answers to the same question. */
function trialBalanceOpts(q: Query): { periodCode?: string; currency?: string; asOf?: number } {
  const at = asOf(q);
  return {
    ...(q("period") ? { periodCode: q("period") as string } : {}),
    ...(q("currency") ? { currency: q("currency") as string } : {}),
    ...(at !== undefined ? { asOf: at } : {})
  };
}

function agedOpts(q: Query): { accountCodes?: string[]; asOf?: number } {
  const codes = q("accounts")?.split(",").filter(Boolean);
  const at = asOf(q);
  return {
    ...(codes?.length ? { accountCodes: codes } : {}),
    ...(at !== undefined ? { asOf: at } : {})
  };
}

/**
 * docs/27 F15. `?kind=payable` is the side that did not exist; `receivable` is
 * the default because that is what the screen asked for before. `?legacy=1`
 * still reaches the line-by-posting-date report — kept for one release so a
 * controller can compare the two, and named `legacy` so nobody mistakes it for
 * a second opinion.
 */
function agedItemOpts(q: Query): {
  kind: "receivable" | "payable";
  accountCodes?: string[];
  asOf?: number;
  currency?: string;
} {
  const codes = q("accounts")?.split(",").filter(Boolean);
  const at = asOf(q);
  return {
    kind: q("kind") === "payable" ? "payable" : "receivable",
    ...(codes?.length ? { accountCodes: codes } : {}),
    ...(at !== undefined ? { asOf: at } : {}),
    ...(q("currency") ? { currency: q("currency") as string } : {})
  };
}

ledgerRoutes.get("/reports/trial-balance", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const tb = await trialBalance(ctx, trialBalanceOpts(qOf(c)));
  // `?format=table` returns the export shape the reporting engine feeds to XLSX
  // and PDF, so a spreadsheet and the screen cannot drift apart.
  return c.json(c.req.query("format") === "table" ? trialBalanceTable(tb) : tb);
});

ledgerRoutes.get("/reports/pnl", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await profitAndLoss(ctx, c.req.query("period") ?? periodCode(ctx.now)));
});

ledgerRoutes.get("/reports/balance-sheet", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await balanceSheet(ctx, asOf(qOf(c))));
});

ledgerRoutes.get("/reports/aged", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const q = qOf(c);
  if (q("legacy") === "1") return c.json({ data: await agedBalances(ctx, agedOpts(q)) });
  return c.json({ data: await agedOpenItems(ctx, agedItemOpts(q)) });
});

ledgerRoutes.get("/reports/commission", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const dimension = c.req.query("by") ?? "provider";
  return c.json({
    dimension,
    data: await commissionByDimension(ctx, dimension, {
      ...(c.req.query("period") ? { periodCode: c.req.query("period") as string } : {})
    })
  });
});

ledgerRoutes.get("/reports/client-money", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:client_money:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json({ data: await clientMoneyPosition(ctx, c.req.query("currency")) });
});

// docs/22 §1.2 — the Money Map. Same permission as the other journal reports:
// it shows nothing the trial balance does not, only shaped as a flow.
ledgerRoutes.get("/reports/value-flow", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const period = c.req.query("period") ?? periodCode(ctx.now);
  return c.json(
    await valueFlow(ctx, {
      periodCode: period,
      ...(c.req.query("currency") ? { currency: c.req.query("currency") as string } : {})
    })
  );
});

// What a node on the map opens: the lines that add up to the figure clicked.
// The generic journal-lines list cannot answer this — it filters by column, and
// the transaction type that produced a line is not one.
ledgerRoutes.get("/reports/value-flow/lines", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(
    await valueFlowLines(ctx, {
      periodCode: c.req.query("period") ?? periodCode(ctx.now),
      node: c.req.query("node") ?? "",
      ...(c.req.query("currency") ? { currency: c.req.query("currency") as string } : {})
    })
  );
});

ledgerRoutes.get("/reports/chart-of-accounts", (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(chartOfAccountsTable());
});

/* ---------------------------------------------------------- report exports */

// The finance reports as files — the six on /reports/*, plus the account
// statement and the money map, which are reports a controller downloads even
// though their JSON lives elsewhere. Every builder calls the very function its
// JSON route calls, so the spreadsheet a controller emails and the screen they
// read are the same numbers — a second summing path is the first thing to
// disagree with the ledger (docs/19 §9).
//
// ponytail: money cells carry minor units under `kind: "money"`, which is the
// renderer's contract — engines/export/xlsx.ts divides by 100 and applies the
// currency number format, so Excel receives a real number in major units rather
// than a formatted string. The currency travels in the column label or in its
// own column, never inside the number.

type ExportBuild = (ctx: Ctx, q: Query) => Promise<{ table: ReportTable; totals?: Record<string, number> }>;

interface ExportSpec {
  /** Exactly the permission the matching JSON route enforces. */
  permission: string;
  build: ExportBuild;
}

type Col = ReportTable["columns"][number];

const money = (key: string, label: string): Col => ({ key, label, kind: "money" });
const text = (key: string, label: string): Col => ({ key, label, kind: "text" });

/**
 * A single-currency statement says its currency once, in the money headers. A
 * multi-currency one already carries a `currency` column and is left alone.
 */
function labelCurrency(table: ReportTable): ReportTable {
  if (!table.currency || table.columns.some((col) => col.key === "currency")) return table;
  const currency = table.currency;
  return {
    ...table,
    columns: table.columns.map((col) => (col.kind === "money" ? { ...col, label: `${col.label} (${currency})` } : col))
  };
}

interface SectionLike {
  label: string;
  rows: { accountCode: string; name: string; amountMinor: number }[];
  totalMinor: number;
}

/** A section's accounts, then its total — how a finance reader expects to read it. */
function sectionRows(section: SectionLike): Record<string, unknown>[] {
  return [
    ...section.rows.map((r) => ({ section: section.label, accountCode: r.accountCode, name: r.name, amountMinor: r.amountMinor })),
    { section: section.label, accountCode: "", name: `Total ${section.label}`, amountMinor: section.totalMinor }
  ];
}

const SECTION_COLUMNS: Col[] = [
  text("section", "Section"),
  text("accountCode", "Account"),
  text("name", "Name"),
  money("amountMinor", "Amount")
];

const REPORT_EXPORTS: Record<string, ExportSpec> = {
  // Two of these are not on /reports/* as a JSON route — an account statement
  // is `/accounts/:code/statement` and the money map is `/reports/value-flow` —
  // but they are reports a controller downloads all the same, and the renderer
  // is keyed by report name, not by path. The account code travels as `?code=`
  // so one handler still serves every export.
  "account-statement": {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const code = q("code")?.trim();
      if (!code) throw badRequest("account-statement needs ?code=<account code>");
      const from = instantParam(q("from"));
      const to = instantParam(q("to"));
      const statement = await accountStatement(ctx, code, {
        ...(q("currency") ? { currency: q("currency") as string } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: 1000
      });
      return {
        table: {
          title: `Account statement ${code}`,
          columns: [
            { key: "postedAt", label: "Posted", kind: "date" },
            text("side", "Side"),
            text("currency", "Currency"),
            money("amountMinor", "Amount"),
            money("runningMinor", "Running balance"),
            text("txnId", "Transaction"),
            text("memo", "Memo")
          ],
          rows: statement.lines as unknown as Record<string, unknown>[],
          generatedAt: ctx.now
        },
        // The two figures the statement is read for, and neither is a row.
        totals: { openingMinor: statement.openingMinor, closingMinor: statement.closingMinor }
      };
    }
  },
  "value-flow": {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const map = await valueFlow(ctx, {
        periodCode: q("period") ?? periodCode(ctx.now),
        ...(q("currency") ? { currency: q("currency") as string } : {})
      });
      return {
        table: {
          title: `Money map ${map.periodCode}`,
          columns: [text("node", "Stage"), money("amountMinor", "Amount")],
          rows: map.nodes.map((n) => ({ node: n.key, amountMinor: n.amountMinor })),
          currency: map.currency,
          generatedAt: map.asOf
        },
        totals: { carriedMinor: map.carriedMinor }
      };
    }
  },
  "trial-balance": {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const tb = await trialBalance(ctx, trialBalanceOpts(q));
      return {
        table: trialBalanceTable(tb),
        totals: { debitMinor: tb.totalDebitMinor, creditMinor: tb.totalCreditMinor, balanceMinor: tb.totalDebitMinor - tb.totalCreditMinor }
      };
    }
  },
  pnl: {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const pnl = await profitAndLoss(ctx, q("period") ?? periodCode(ctx.now));
      return {
        table: {
          title: `Profit and loss ${pnl.periodCode}`,
          columns: SECTION_COLUMNS,
          rows: [
            ...sectionRows(pnl.income),
            ...sectionRows(pnl.expense),
            { section: "", accountCode: "", name: "Gross margin", amountMinor: pnl.grossMarginMinor }
          ],
          currency: pnl.currency,
          generatedAt: ctx.now
        }
      };
    }
  },
  "balance-sheet": {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const bs = await balanceSheet(ctx, asOf(q));
      return {
        table: {
          title: "Balance sheet",
          columns: SECTION_COLUMNS,
          rows: [
            ...sectionRows(bs.assets),
            ...sectionRows(bs.liabilities),
            ...sectionRows(bs.equity),
            // The year's result is not equity until the year is closed, so it is
            // its own line and says so (docs/27 F3).
            { section: "Equity", accountCode: "", name: "Current year (not yet closed)", amountMinor: bs.currentYearUnpostedMinor },
            { section: "Equity", accountCode: "", name: "Total equity", amountMinor: bs.equityMinor }
          ],
          currency: bs.currency,
          generatedAt: bs.asOf
        }
      };
    }
  },
  aged: {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const rows = await agedOpenItems(ctx, agedItemOpts(q));
      return {
        table: {
          title: agedItemOpts(q).kind === "payable" ? "Aged payables" : "Aged receivables",
          columns: [
            text("counterparty", "Counterparty"),
            text("currency", "Currency"),
            money("currentMinor", "Not yet due / 0-30 days"),
            money("d30Minor", "31-60 days"),
            money("d60Minor", "61-90 days"),
            money("d90Minor", "91-120 days"),
            money("olderMinor", "Over 120 days"),
            money("totalMinor", "Total")
          ],
          rows: rows as unknown as Record<string, unknown>[],
          generatedAt: asOf(q) ?? ctx.now
        }
      };
    }
  },
  commission: {
    permission: "ledger:journals:read",
    build: async (ctx, q) => {
      const dimension = q("by") ?? "provider";
      const rows = await commissionByDimension(ctx, dimension, {
        ...(q("period") ? { periodCode: q("period") as string } : {})
      });
      return {
        table: {
          title: `Commission by ${dimension}`,
          columns: [
            text("value", dimension),
            text("currency", "Currency"),
            money("grossMinor", "Gross"),
            money("channelShareMinor", "Channel share"),
            money("netMinor", "Net")
          ],
          rows: rows as unknown as Record<string, unknown>[],
          generatedAt: ctx.now
        }
      };
    }
  },
  "client-money": {
    permission: "ledger:client_money:read",
    build: async (ctx, q) => {
      const rows = await clientMoneyPosition(ctx, q("currency"));
      return {
        table: {
          title: "Client money position",
          columns: [
            text("currency", "Currency"),
            money("assetMinor", "Client bank"),
            money("liabilityMinor", "Owed to clients"),
            money("surplusMinor", "Surplus or shortfall"),
            text("status", "Status")
          ],
          // A breach is the only thing on this report anyone reads first, so it
          // is a word in a column and not a flag the spreadsheet drops.
          rows: rows.map((r) => ({ ...r, status: r.breach ? "SHORT" : "whole" })),
          generatedAt: ctx.now
        }
      };
    }
  }
};

/**
 * LED-REP. The same reports, downloadable. Permission-for-permission with the
 * JSON route beside it, tenant-scoped by the report functions themselves, and
 * audited — a finance export leaving the building is a read worth a record.
 */
ledgerRoutes.get("/reports/:report/export", async (c) => {
  const ctx = ctxOf(c);
  const key = c.req.param("report");
  const spec = REPORT_EXPORTS[key];
  if (!spec) throw notFound(`report ${key}`);
  require_(ctx.actor, spec.permission, { tenantId: ctx.tenantId, module: "ledger" });

  const format = c.req.query("format") ?? "xlsx";
  if (!isExportFormat(format)) throw badRequest(`format must be one of ${EXPORT_FORMATS.join(", ")}`);

  const q = qOf(c);
  const { table, totals } = await spec.build(ctx, q);
  const shaped = labelCurrency(table);
  const rendered = await render(
    format,
    shaped,
    {
      ...(totals ? { totals } : {}),
      meta: { "Requested by": actorRef(ctx), Rows: String(table.rows.length) }
    },
    c.env.BROWSER
  );

  const params = Object.fromEntries(new URL(c.req.url).searchParams);
  await audit(ctx, {
    action: "ledger.report.export",
    subjectRef: `report:${key}`,
    after: { format, rows: table.rows.length, params }
  });

  const stamp = new Date(ctx.now).toISOString().slice(0, 10);
  return new Response(rendered.bytes, {
    headers: {
      "content-type": rendered.contentType,
      "content-disposition": `attachment; filename="${key}-${stamp}.${format}"`,
      "cache-control": "no-store"
    }
  });
});

ledgerRoutes.get("/accounts/:code/statement", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  const from = instantParam(c.req.query("from"));
  const to = instantParam(c.req.query("to"));
  return c.json(
    await accountStatement(ctx, c.req.param("code"), {
      ...(c.req.query("currency") ? { currency: c.req.query("currency") as string } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      limit: 1000
    })
  );
});

ledgerRoutes.get("/accounts/:code/balance", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await balanceOf(ctx, c.req.param("code"), c.req.query("currency") ?? ctx.policy.currency));
});

/**
 * Rebuild the balance cache from the journal. The journal is the truth and the
 * cache is derived, so this is always safe to run — it is the answer to "the
 * dashboard looks wrong", not a data fix.
 */
ledgerRoutes.post("/balances/rebuild", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:journals:post", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await rebuildBalances(ctx));
});

/* ------------------------------------------------------------ reconciliation */

const StatementLine = z.object({
  ref: z.string().min(1),
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  ourRef: z.string().optional(),
  postedAt: InstantMs.optional(),
  description: z.string().max(500).optional()
});

ledgerRoutes.post("/recon/runs", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:run", { tenantId: ctx.tenantId, module: "ledger" });
  const input = await body(
    c,
    z.object({
      process: z.enum(["insurer", "psp", "client_money", "partner", "media"]),
      period: z.string().min(1),
      currency: z.string().length(3),
      counterpartyRef: z.string().optional(),
      statementFileId: z.string().optional(),
      toleranceMinor: z.number().int().min(0).optional(),
      /** Opt in to pass 3. Off by default: no silent AI in the money path. */
      propose: z.boolean().default(false),
      /** Already-parsed lines: a CSV paste, an API client, a test. */
      lines: z.array(StatementLine).max(5000).optional(),
      /**
       * docs/27 F16. The counterparty's own file, as text: CAMT.053, MT940 or
       * OFX. Parsed *here* rather than in the browser, for the same reason the
       * CSV is - the run reconciles what the server read, so a preview that
       * drifted cannot change what posts.
       */
      statementText: z.string().min(1).max(4_000_000).optional()
    })
      .refine((v) => Boolean(v.lines?.length) !== Boolean(v.statementText), {
        message: "give either parsed lines or a statement file, but not both",
        path: ["statementText"]
      })
  );

  const { propose, statementText, ...rest } = input;
  const parsed = statementText ? parseStatement(statementText) : null;
  // The file states its own currency; a caller that also states one and
  // disagrees is a mistake worth refusing rather than silently resolving.
  if (parsed?.currency && parsed.currency !== input.currency) {
    throw badRequest(
      `the ${parsed.format} statement is in ${parsed.currency}, not the ${input.currency} this run was asked for`
    );
  }
  const statementLines = parsed ? parsed.lines : (rest.lines ?? []);
  // A run posts matches against money, so a double submit must not start two of
  // them — same wrapper the transaction endpoint uses, keyed on the statement.
  return c.json(
    await withIdempotency(ctx, c.req.header("idempotency-key"), `ledger.recon.${input.process}`, input, () =>
      reconcile(ctx, {
        ...rest,
        lines: statementLines,
        ...(propose ? { propose: aiProposer(ctx, c.get("gateway")) } : {})
      })
    ),
    201
  );
});

/**
 * Pass 3. The model only ever *proposes* — every ai_proposed match lands in
 * `proposed` and needs a human `decide`, so a hallucinated join can never post.
 */
export function aiProposer(ctx: Ctx, gateway: Gateway): MatchProposer {
  return async (unmatched, open) => {
    if (!open.length) return [];
    const res = await gateway.complete(ctx, {
      module: "ledger",
      purpose: "recon.match",
      tier: "reasoning",
      maxTokens: 2000,
      responseSchema: {
        type: "object",
        properties: {
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                statementRef: { type: "string" },
                txnId: { type: "string" },
                confidence: { type: "number" },
                reasonCode: { type: "string" }
              },
              required: ["statementRef", "txnId", "confidence"]
            }
          }
        },
        required: ["matches"]
      },
      messages: [
        {
          role: "system",
          content:
            "You reconcile a counterparty statement against our settled transactions. " +
            "Match a statement line to at most one transaction, and only when amount, " +
            "date and reference agree. Leave a line unmatched rather than guessing: an " +
            "unmatched line costs a reviewer a minute, a wrong match costs an audit. " +
            "Confidence is 0-100. Reply as JSON only."
        },
        {
          role: "user",
          // Dates go over as ISO-8601, never epoch ms. A bare 13-digit instant is a
          // card-shaped run: ~1 in 10 passes Luhn and the scrubber replaces it with
          // `[[CARD_n]]`, so the model would be asked to agree on a date it cannot
          // see. The ledger's own `postedAt` stays numeric — only this payload renders.
          content: JSON.stringify({
            statementLines: unmatched.slice(0, 200).map((l) => ({ ...l, postedAt: l.postedAt === undefined ? undefined : promptInstant(l.postedAt) })),
            ourTransactions: open.slice(0, 400).map((t) => ({ ...t, postedAt: promptInstant(t.postedAt) }))
          })
        }
      ]
    });
    const parsed = z
      .object({
        matches: z.array(
          z.object({
            statementRef: z.string(),
            txnId: z.string(),
            confidence: z.number().min(0).max(100),
            reasonCode: z.string().optional()
          })
        )
      })
      .safeParse(safeJson(res.text));
    return parsed.success ? parsed.data.matches : [];
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** What the importer can read, so an upload control need not hard-code it. */
ledgerRoutes.get("/recon/statement-formats", (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json({ data: [...STATEMENT_FORMATS] });
});

ledgerRoutes.get("/recon/runs/:id", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:read", { tenantId: ctx.tenantId, module: "ledger" });
  return c.json(await reconSummary(ctx, c.req.param("id")));
});

ledgerRoutes.post("/recon/matches/:id/decide", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:confirm", { tenantId: ctx.tenantId, module: "ledger" });
  const input = await body(
    c,
    z.object({ decision: z.enum(["confirmed", "rejected"]), reasonCode: z.string().max(64).optional() })
  );
  await decideMatch(ctx, c.req.param("id"), input.decision, input.reasonCode);
  return c.body(null, 204);
});

/**
 * Close a run. Same permission as deciding a match, because closing is the same
 * judgement made once more: it asserts nothing is left open. The engine refuses
 * while anything still is (`closeRun`, packages/ledger/src/recon.ts) and there
 * is deliberately no force flag — the stragglers are rejected with a reason, one
 * at a time, or the run stays in review. The fresh summary comes back so the
 * caller renders the state the engine just wrote rather than one it assumed.
 */
ledgerRoutes.post("/recon/runs/:id/close", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:confirm", { tenantId: ctx.tenantId, module: "ledger" });
  const runId = c.req.param("id");
  await closeRun(ctx, runId);
  return c.json(await reconSummary(ctx, runId));
});

ledgerRoutes.post("/recon/runs/:id/evidence-bundle", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:export", { tenantId: ctx.tenantId, module: "ledger" });
  const run = await must(ctx, schema.ledgerReconRuns, c.req.param("id"), "recon run");

  const matches = await ctx.db
    .select()
    .from(schema.ledgerReconMatches)
    .where(scoped(ctx, schema.ledgerReconMatches, eq(schema.ledgerReconMatches.runId, run.id)))
    .orderBy(schema.ledgerReconMatches.createdAt);

  const scope = { runId: run.id, process: run.process, period: run.period, purpose: "audit" as const };
  const jsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

  const summary: ReportTable = {
    title: "Reconciliation evidence bundle",
    columns: [
      { key: "item", label: "Item", kind: "text" },
      { key: "value", label: "Value", kind: "text" }
    ],
    rows: [
      { item: "Run", value: run.id },
      { item: "Process", value: run.process },
      { item: "Period", value: run.period },
      { item: "Counterparty", value: run.counterpartyRef ?? "—" },
      { item: "Matched", value: String(run.matchedCount) },
      { item: "Variance count", value: String(run.varianceCount) },
      { item: "Variance", value: `${run.varianceMinor} ${run.currency}` },
      { item: "State", value: run.state },
      { item: "Requested by", value: actorRef(ctx) }
    ],
    generatedAt: ctx.now
  };

  const contents = [
    { path: "run.json", data: utf8(JSON.stringify(run, null, 2)) },
    { path: "matches.jsonl", data: utf8(jsonl(matches)) },
    { path: "summary.pdf", data: (await render("pdf", summary, {}, c.env.BROWSER)).bytes }
  ];
  const manifest = {
    version: 1,
    tenantId: ctx.tenantId,
    generatedAt: ctx.now,
    requestedBy: actorRef(ctx),
    scope,
    files: await Promise.all(
      contents.map(async (f) => ({ path: f.path, sizeBytes: f.data.length, sha256: await sha256Hex(f.data) }))
    )
  };
  // manifest travels inside the archive, so the bundle hash covers it too —
  // one hash to quote, entries verify against the manifest. Same idiom as
  // compliance.ts's evidence-bundles/export.
  const archive = zip([...contents, { path: "manifest.json", data: utf8(JSON.stringify(manifest, null, 2)) }]);
  const bundleHash = await sha256Hex(archive);

  const bundleId = id("evb", ctx.now);
  const bucket = c.env.FILES;
  const fileId = bucket ? id("file", ctx.now) : null;
  if (bucket && fileId) {
    const r2Key = `evidence/${ctx.tenantId}/${bundleId}.zip`;
    await bucket.put(r2Key, archive, { httpMetadata: { contentType: "application/zip" } });
    await ctx.db.insert(schema.files).values({
      id: fileId,
      tenantId: ctx.tenantId,
      r2Key,
      kind: "evidence_bundle",
      subjectRef: bundleId,
      sha256: bundleHash,
      sizeBytes: archive.length,
      contentType: "application/zip",
      piiLevel: "high",
      createdAt: ctx.now,
      deletedAt: null
    });
    await ctx.db
      .update(schema.ledgerReconRuns)
      .set({ evidenceBundleFileId: fileId, updatedAt: ctx.now })
      .where(scoped(ctx, schema.ledgerReconRuns, eq(schema.ledgerReconRuns.id, run.id)));
  }

  const row = {
    id: bundleId,
    tenantId: ctx.tenantId,
    purpose: "audit" as const,
    scopeJson: JSON.stringify(scope),
    manifestJson: JSON.stringify(manifest),
    bundleHash,
    fileId,
    requestedBy: actorRef(ctx),
    approvedBy: null,
    state: bucket ? "ready" : "failed",
    deliveredTo: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.evidenceBundles).values(row);
  await audit(ctx, {
    action: "ledger.recon.evidence.export",
    subjectRef: `evidence_bundle:${bundleId}`,
    after: { ...row, manifestJson: undefined, manifest, runId: run.id }
  });
  return c.json({ ...row, manifest }, 201);
});

ledgerRoutes.get("/recon/runs/:id/evidence-bundle/download", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ledger:recon:export", { tenantId: ctx.tenantId, module: "ledger" });
  const run = await must(ctx, schema.ledgerReconRuns, c.req.param("id"), "recon run");
  if (!run.evidenceBundleFileId) throw notFound("evidence bundle");

  const file = await must(ctx, schema.files, run.evidenceBundleFileId, "evidence bundle file");
  const object = await c.env.FILES?.get(file.r2Key);
  if (!object) throw notFound("evidence bundle file");

  await audit(ctx, {
    action: "ledger.recon.evidence.download",
    subjectRef: `evidence_bundle:${file.subjectRef ?? run.id}`,
    after: { runId: run.id, fileId: file.id }
  });
  await meterEgress(ctx, file.sizeBytes ?? object.size);
  return new Response(object.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="evidence-${run.id}.zip"`,
      "cache-control": "no-store"
    }
  });
});
