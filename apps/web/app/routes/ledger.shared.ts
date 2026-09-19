// What the four bespoke ledger screens agree on: the state machine they may
import { formatMoney, minorFromMajor } from "@lyra/ui";
import { humanise } from "../modules/spec";
import { vocabulary } from "../modules/vocabulary";
import { pseudoText } from "../i18n";
// offer, the invariant they must show, and the words they say it in.
//
// Nothing here computes money. `balanceCheck` sums what the API already posted
// so the screen can say out loud whether the batch foots — it never derives an
// amount, and it never decides that an unbalanced batch is fine.
//
// The web app cannot import @lyra/ledger (it would drag Drizzle into the
// worker bundle), so the machine below is a mirror. `ledger.shared.test.ts`
// pins it; if the package moves, that test is what should fail.

/* ------------------------------------------------------------ state machine */

/** Mirrors packages/ledger/src/types.ts TXN_STATES. */
export const TXN_STATES = [
  "initiated",
  "validated",
  "authorized",
  "executing",
  "pending_external",
  "settled",
  "reversing",
  "reversed",
  "adjusting",
  "adjusted",
  "failed",
  "rejected",
  "expired"
] as const;

export type TxnState = (typeof TXN_STATES)[number];

/** Mirrors packages/ledger/src/types.ts TRANSITIONS. */
export const TRANSITIONS: Record<TxnState, readonly TxnState[]> = {
  initiated: ["validated", "rejected", "failed"],
  validated: ["authorized", "rejected", "failed"],
  authorized: ["executing", "failed", "rejected"],
  executing: ["settled", "pending_external", "failed"],
  pending_external: ["executing", "failed", "expired"],
  settled: ["reversing", "adjusting"],
  reversing: ["reversed", "failed"],
  reversed: [],
  adjusting: ["adjusted", "failed"],
  adjusted: ["reversing"],
  failed: [],
  rejected: [],
  expired: []
};

export function isTxnState(value: string): value is TxnState {
  return (TXN_STATES as readonly string[]).includes(value);
}

/**
 * The legal hops out of a state. An operator picks from this list rather than
 * typing a state, so an illegal hop is never offered — the API refuses it with
 * a 409 either way, which is the authority; this is only the manners.
 */
export function nextStates(from: string): readonly TxnState[] {
  return isTxnState(from) ? TRANSITIONS[from] : [];
}

/* ------------------------------------------------------------- permissions */

/** Exactly the strings apps/api/src/routes/ledger.ts calls `require_` with. */
export const PERM = {
  txnsRead: "ledger:txns:read",
  txnsCreate: "ledger:txns:create",
  txnsAuthorize: "ledger:txns:authorize",
  txnsReverse: "ledger:txns:reverse",
  periodsRead: "ledger:periods:read",
  periodsClose: "ledger:periods:close",
  periodsYearEnd: "ledger:periods:year_end",
  journalsDraft: "ledger:journals:draft",
  journalsRead: "ledger:journals:read",
  journalsPost: "ledger:journals:post",
  reconRead: "ledger:recon:read",
  reconRun: "ledger:recon:run",
  reconConfirm: "ledger:recon:confirm",
  reconExport: "ledger:recon:export",
  approvalsRead: "core:approvals:read",
  auditRead: "core:audit:read"
} as const;

export interface TxnActions {
  /** States this actor may move the transaction to, right now. */
  transitions: readonly TxnState[];
  canReverse: boolean;
}

/**
 * What the actor may do to this transaction. Two gates, both real: the
 * permission the API enforces, and the state the machine allows. An action that
 * fails either one is absent from the screen, not disabled on it.
 *
 * Reversal is only legal from `settled` — packages/ledger/src/txn.ts throws a
 * conflict otherwise, and a reversal is a counter-entry, so there is nothing to
 * counter until money has actually posted.
 */
export function txnActions(held: ReadonlySet<string>, state: string): TxnActions {
  return {
    transitions: held.has(PERM.txnsAuthorize) ? nextStates(state) : [],
    canReverse: held.has(PERM.txnsReverse) && state === "settled"
  };
}

/* ------------------------------------------------------- recipe arguments */

/** Mirrors packages/ledger/src/recipes.ts ArgField, as published by `GET /txn-types`. */
export interface ArgField {
  name: string;
  kind: "integer" | "text";
  required: boolean;
  default?: string | number;
  /** A closed set the answer must come from; rendered as a picker, not free text. */
  options?: string[];
}

/**
 * The arguments the operator actually typed, read off `arg.<name>` inputs.
 *
 * A blank field is left out entirely rather than sent as an empty string, so
 * the recipe's own default stands. Nothing is validated here beyond the number
 * conversion: the ledger owns the schema and names the field it refused, and a
 * second opinion in the browser would only be a second thing to keep in step.
 */
export function argsFromForm(fields: readonly ArgField[], form: FormData): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = String(form.get(`arg.${field.name}`) ?? "").trim();
    if (!raw) continue;
    const asNumber = Number(raw);
    args[field.name] = field.kind === "integer" && raw !== "" && !Number.isNaN(asNumber) ? asNumber : raw;
  }
  return args;
}

/* -------------------------------------------------------- statement lines */

/** Mirrors packages/ledger/src/recon.ts StatementLine, as `POST /recon/runs` takes it. */
export interface StatementLine {
  ref: string;
  amountMinor: number;
  currency: string;
  ourRef?: string;
  postedAt?: number;
  description?: string;
}

export interface StatementParse {
  lines: StatementLine[];
  /** Rows that were not read, quoted back with their number so the operator can find them. */
  rejected: Array<{ row: number; text: string }>;
}

/** One row, comma or tab separated, with quoted fields kept whole. */
function cells(row: string, separator: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (quoted) {
      // "" inside a quoted field is a literal quote — the CSV convention.
      if (char === '"' && row[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      out.push(cell);
      cell = "";
    } else cell += char;
  }
  out.push(cell);
  return out.map((value) => value.trim());
}

/**
 * A pasted statement, in the shape the counterparty exported it: reference,
 * amount, our reference, date, description — comma or tab separated, header
 * row optional. Amounts are read in the currency's own precision, so a
 * controller pastes 1 500,55 and the run sees 150055.
 *
 * A row that cannot be read is handed back rather than dropped: a statement
 * that silently loses a line reconciles to the wrong answer.
 */
export function statementFromCsv(text: string, currency: string, locale = "en"): StatementParse {
  const lines: StatementLine[] = [];
  const rejected: Array<{ row: number; text: string }> = [];
  const rows = text.split(/\r?\n/);
  const separator = rows.find((row) => row.trim())?.includes("\t") ? "\t" : ",";

  rows.forEach((raw, index) => {
    if (!raw.trim()) return;
    const [ref = "", amount = "", ourRef = "", postedAt = "", description = ""] = cells(raw, separator);
    const amountMinor = minorFromMajor(amount, currency, locale);
    if (amountMinor === null || !ref) {
      // A first row whose amount is not a number is the header, not a mistake.
      if (index === 0 && !lines.length) return;
      rejected.push({ row: index + 1, text: raw.trim() });
      return;
    }
    const at = Date.parse(postedAt);
    lines.push({
      ref,
      amountMinor,
      currency,
      ...(ourRef ? { ourRef } : {}),
      ...(Number.isNaN(at) ? {} : { postedAt: at }),
      ...(description ? { description } : {})
    });
  });

  return { lines, rejected };
}

/* --------------------------------------------------------- the invariant */

export interface SidedLine {
  side: string;
  amountMinor: number;
}

export interface BalanceCheck {
  debitMinor: number;
  creditMinor: number;
  /** debits − credits. Zero, or the batch does not foot. */
  deltaMinor: number;
  balanced: boolean;
  lineCount: number;
}

/**
 * Σdebits = Σcredits over the lines the API returned. Amounts are always
 * positive and the side carries the sign (packages/db ledger_journal_lines), so
 * a line with an unrecognised side is counted into neither total and shows up
 * as a discrepancy rather than quietly vanishing.
 */
export function balanceCheck(lines: readonly SidedLine[]): BalanceCheck {
  let debitMinor = 0;
  let creditMinor = 0;
  for (const line of lines) {
    if (line.side === "debit") debitMinor += line.amountMinor;
    else if (line.side === "credit") creditMinor += line.amountMinor;
  }
  const deltaMinor = debitMinor - creditMinor;
  return {
    debitMinor,
    creditMinor,
    deltaMinor,
    // An empty batch is balanced at zero but has nothing in it; the caller
    // decides whether that is "no lines yet" or "a financial txn with none".
    balanced: deltaMinor === 0 && lines.every((l) => l.side === "debit" || l.side === "credit"),
    lineCount: lines.length
  };
}

/* -------------------------------------------------------------------- tone */

type Tone = "neutral" | "accent" | "success" | "danger" | "warning" | "info";

const TXN_TONE: Record<TxnState, Tone> = {
  initiated: "neutral",
  validated: "neutral",
  authorized: "info",
  executing: "info",
  pending_external: "warning",
  settled: "success",
  reversing: "warning",
  reversed: "danger",
  adjusting: "warning",
  adjusted: "info",
  failed: "danger",
  rejected: "danger",
  expired: "danger"
};

export function txnTone(state: string): Tone {
  return isTxnState(state) ? TXN_TONE[state] : "neutral";
}

export function periodTone(state: string): Tone {
  return state === "open" ? "success" : state === "soft_closed" ? "warning" : "neutral";
}

/* ------------------------------------------------------------- idempotency */

/**
 * Minted once per form render, server side, and carried in a hidden field. A
 * key the browser generates at submit time is a new key per press, which is
 * exactly the double-post the header is supposed to stop (CLAUDE.md §12).
 */
export function mintKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/* ------------------------------------------------------------------ labels */

// Local rather than app/i18n: those files are shared and these words are not.
// Same pattern as ledger-reports.tsx and conversation.tsx.
export const LABELS: Record<string, Record<string, string>> = {
  en: {
    /* shared */
    denied: "You do not have permission to see this.",
    deniedBody: "This screen needs {permission}. Ask an administrator if you should have it.",
    back: "Back",
    none: "—",
    apply: "Apply",
    reason: "Reason",
    reasonRequired: "A reason is required.",
    currency: "Currency",
    amount: "Amount",
    state: "State",
    when: "When",
    actor: "Actor",
    idempotencyNote: "This form carries a one-time key, so pressing twice posts once.",
    // F64: dual-control writes (manual journal, year-end close) are approval-gated
    // always on, so the first submit is a request, not a posting — say so calmly
    // instead of showing the raw policy key in a danger alert.
    approvalTitle: "Waiting on an approval",
    approvalBody: "This needs sign-off under {policy} before it can go through.",
    approvalLink: "Open the approval queue",

    /* transaction detail */
    "txn.title": "Transaction",
    "txn.intro": "One transaction, its journal, and everything done to it.",
    "txn.type": "Type",
    "txn.gross": "Gross",
    "txn.correlation": "Correlation",
    "txn.parent": "Opened by",
    "txn.reversalOf": "Reverses",
    "txn.reversedBy": "Reversed by",
    "txn.failure": "Failure",
    "txn.key": "Idempotency key",
    "txn.batch": "Journal batch",
    "txn.lines": "Journal lines",
    "txn.linesCaption": "Journal lines posted by this transaction",
    "txn.noLines": "No journal lines",
    "txn.noLinesBody": "A non-financial transaction settles without a batch. Nothing was posted.",
    "txn.account": "Account",
    "txn.side": "Side",
    "txn.memo": "Memo",
    "txn.debit": "Debit",
    "txn.credit": "Credit",
    "txn.totalDebit": "Total debits",
    "txn.totalCredit": "Total credits",
    "txn.balanced": "Debits equal credits.",
    "txn.imbalance": "This batch does not balance",
    "txn.imbalanceBody":
      "Debits and credits differ by the amount above. Double entry says they cannot. Do not act on this transaction — send the batch id to finance engineering.",
    "txn.history": "History",
    "txn.historyLabel": "State changes",
    "txn.approvals": "Approvals",
    "txn.approvalsEmpty": "Nothing about this transaction has needed an approval.",
    "txn.approvalsEmpty.body": "It stayed inside the limits your policy automates, so nobody had to sign it off.",
    "txn.approvalsInbox": "Open the approvals queue",
    "txn.audit": "Audit trail",
    "txn.auditEmpty": "Nothing has happened to this transaction yet.",
    "txn.auditEmpty.body": "Every posting, reversal and approval on it will be recorded here as it happens.",
    "txn.transition": "Move state",
    "txn.transitionTo": "Move to",
    "txn.transitionSubmit": "Move",
    "txn.transitionNone": "No move is legal from this state.",
    "txn.failureCode": "Failure code",
    "txn.reverse": "Reverse",
    "txn.reverseBody":
      "A reversal does not delete anything. It opens a second transaction that posts the opposite journal and leaves both on the record.",
    "txn.reverseSubmit": "Reverse this transaction",
    "txn.reverseConfirm": "Reverse this transaction? A counter-entry will be posted and both remain on the record.",
    "txn.approvalRaised": "Approval requested",
    "txn.approvalRaisedBody":
      "Nothing has happened yet. The request is waiting in the approvals queue for someone who may decide it.",
    "txn.moved": "Moved to {state}.",
    "txn.reversedAs": "Reversal posted as {id}.",
    "txn.statement": "Open the account statement",
    "txn.headline": "{type} — {amount}, {state}.",

    /* opening a transaction */
    "open.title": "Open a transaction",
    "open.intro":
      "Money moves by running a transaction type. Pick the type, give it its arguments, and the ledger posts the recipe.",
    "open.headline": "{count} transaction type(s) ready to run.",
    "open.headlineGated": "{count} transaction type(s) ready to run; {gated} need approval first.",
    "open.headlineEmpty": "No transaction types are published yet.",
    "open.type": "Transaction type",
    "open.financial": "Posts a journal",
    "open.nonFinancial": "No journal",
    "open.approval": "Needs approval",
    "open.payout": "Money out",
    "open.clientMoney": "Client money",
    "open.key": "Transaction key",
    "open.keyHint": "The natural key for this transaction. Reusing it returns the same transaction.",
    "open.gross": "Gross amount",
    "open.args": "Arguments",
    "open.argsHint":
      "What this type needs to post its journal. Leave a field blank to take the recipe's own default.",
    "open.argsNone": "This type takes no arguments.",
    "open.argAccountHint": "Account code",
    /* The recipe argument names, from `GET /txn-types`. An unnamed one falls
       back to its own name read as words, so a new recipe field still shows. */
    "arg.amountMinor": "Amount",
    "arg.grossMinor": "Gross commission",
    "arg.netMinor": "Net amount",
    "arg.taxMinor": "Tax",
    "arg.feeMinor": "Fee",
    "arg.channelMinor": "Channel share",
    "arg.premiumMinor": "Premium",
    "arg.flatFeeMinor": "Flat fee",
    "arg.withholdingMinor": "Withholding tax",
    "arg.baseCommissionPpm": "Commission rate (ppm)",
    "arg.channelSharePpm": "Channel share rate (ppm)",
    "arg.taxPpm": "Tax rate (ppm)",
    "arg.incomeAccount": "Income account",
    "arg.expenseAccount": "Expense account",
    "arg.receivableAccount": "Receivable account",
    "arg.payableAccount": "Payable account",
    "arg.cashAccount": "Cash account",
    "arg.creditAccount": "Credit account",
    "arg.debitAccount": "Debit account",
    "arg.deferredAccount": "Deferred revenue account",
    "arg.liabilityAccount": "Liability account",
    "arg.memo": "Memo",
    "open.submit": "Open transaction",
    "open.confirm": "Open this transaction? It posts to the ledger.",
    "open.opened": "Transaction opened",
    "open.catalogue": "Type catalogue",
    "open.catalogueCaption": "Transaction types this tenant can run",
    "open.catalogueEmpty": "No transaction types yet",
    "open.catalogueEmptyBody": "Nothing can be opened until a type is published for this tenant.",
    "open.code": "Code",
    "open.openedAs": "Opened as {id}.",
    "open.openRecord": "Open it",

    /* periods */
    "period.title": "Period close",
    "period.intro":
      "A period closes when its checks pass. Soft close first: it stops ordinary posting and still allows an adjustment with a reason.",
    "period.headlineNone": "No period is selected yet.",
    "period.headlineBlocked": "{code} has {count} check(s) still blocking close.",
    "period.headlineReady": "{code} is ready to close.",
    "period.headlineState": "{code} is {state}.",
    "period.code": "Period",
    "period.checks": "Checks",
    "period.checksCaption": "Close checks for this period",
    "period.check": "Check",
    "check.trial_balance_zero": "Debits equal credits",
    "check.batches_match_lines": "Every batch agrees with its lines",
    "check.no_pending_external": "Nothing still waiting on a provider",
    "check.no_open_client_money_breach": "No open client-money breach",
    "period.detail": "Detail",
    "period.ok": "Pass",
    "period.fail": "Fail",
    "period.blocked": "This period cannot close yet",
    "period.blockedBody": "The checks below have not passed. Fix what they name, then close.",
    "period.closedBy": "Closed by",
    "period.closedNow": "Period {code} is now {state}.",
    "period.reopened": "Period {code} is open again.",
    "period.close": "Close",
    "period.closeSoft": "Soft close",
    "period.closeHard": "Hard close",
    "period.closeSoftConfirm": "Soft close this period? Ordinary posting stops; adjustments with a reason still post.",
    "period.closeHardConfirm": "Hard close this period? Only contra entries post afterwards.",
    "period.reopen": "Reopen",
    "period.reopenConfirm": "Reopen this period? Posting resumes and the close is undone.",
    "period.recent": "Periods",
    "period.recentCaption": "Recent accounting periods",
    "period.noneRecent": "No periods have been closed yet.",
    "period.noneRecent.body": "A period appears here once it is closed. Closing locks its journal so the balances can be reported.",
    "period.noneSelected": "No period chosen.",
    "period.noneSelectedBody":
      "Pick a period from the list below, or look one up by code, to see its checks and close it.",
    "period.lookup": "Look up a period",

    /* year end */
    "ye.title": "Year-end close",
    "ye.intro":
      "One entry zeroes every income and expense account into retained earnings. The lines are read out of the journal, not typed: what is previewed here is exactly what posts.",
    "ye.headlineEmpty": "Fiscal year {year} has nothing to close.",
    "ye.headline": "Fiscal year {year} nets {amount}.",
    "ye.year": "Fiscal year",
    "ye.preview": "The entry that would post",
    "ye.previewCaption": "Closing lines for the fiscal year",
    "ye.income": "Income",
    "ye.expense": "Expense",
    "ye.net": "Result for the year",
    "ye.retained": "Into {account}",
    "ye.account": "Account",
    "ye.side": "Side",
    "ye.amount": "Amount",
    "ye.side.debit": "Debit",
    "ye.side.credit": "Credit",
    "ye.nothing": "Nothing to close",
    "ye.nothingBody":
      "No income or expense account carries a balance for this year, so there is no closing entry to post.",
    "ye.post": "Post the close",
    "ye.postConfirm":
      "Post the year-end close? It needs a second seat's approval, and once it settles the year's result sits in retained earnings.",
    "ye.posted": "Fiscal year {year} is closed. The result now sits in {account}.",
    "ye.prereq": "Close every month of the year first",
    "ye.prereqBody":
      "The year-end entry posts into months that are already frozen. Soft close each month on the period-close screen, then come back.",
    "ye.toPeriods": "Go to period close",

    /* manual journals */
    "mj.title": "Manual journal",
    "mj.intro":
      "A hand-written entry for what no transaction type covers — an accrual, a correction, a reclass. It never posts on the drafter's word alone: a second seat approves it.",
    "mj.reason": "Why this entry exists",
    "mj.reasonHint": "At least ten characters. It is what an auditor reads first.",
    "mj.lines": "Lines",
    "mj.account": "Account",
    "mj.accountHint": "Four digits",
    "mj.memo": "Memo",
    "mj.side": "Side",
    "mj.amount": "Amount",
    "mj.debit": "Debit",
    "mj.credit": "Credit",
    "mj.addLine": "Add a line",
    "mj.removeLine": "Remove this line",
    "mj.totalDebit": "Total debits",
    "mj.totalCredit": "Total credits",
    "mj.difference": "Out by",
    "mj.balanced": "The entry balances.",
    "mj.unbalanced": "Debits and credits do not agree yet, so this cannot be submitted.",
    "mj.submit": "Send for approval",
    "mj.submitConfirm":
      "Send this entry for approval? It posts to the ledger the moment a second seat approves it.",
    "mj.sent": "Sent for approval. It posts when a second seat approves it.",
    "mj.settled": "Posted as {id}.",
    "mj.forbidden":
      "Client-money and equity accounts are out of reach here: client money moves through its own transaction types, and equity moves at the year-end close.",
    "period.rebuild": "Check balances against the journal",
    "period.rebuildBody":
      "The journal is the truth and the balances table is a cache derived from it. This re-reads every line and reports where the two disagree. It writes nothing and moves no money — it is the answer to a check that argues with the journal.",
    "period.rebuildConfirm":
      "Re-read the whole journal? Nothing is written, but on a large ledger this takes a while.",
    "period.rebuildSubmit": "Run the check",
    "period.checked": "Checked {count} balances. Every one agrees with the journal.",
    "period.driftTable": "Balance check",
    "period.driftCaption": "Stored balances compared against the journal",
    "period.driftedTitle": "{count} of {total} balances disagree with the journal",
    "period.driftedBody":
      "The stored balance and the journal differ on the accounts below. The journal is the truth: nothing here has changed money, and no close should be forced until these agree.",
    "period.driftOnly": "Only the accounts that disagree are listed.",
    "period.stored": "Stored",
    "period.rebuiltCol": "From the journal",

    /* account statement */
    "account.title": "Account statement",
    "account.intro": "Every line posted to this account, with the balance it left behind.",
    "account.headlineNone": "Enter an account code to see its statement.",
    "account.headlineDrift": "Account {code}'s cached balance disagrees with the journal.",
    "account.headline": "Account {code} closes at {amount}.",
    "account.code": "Account",
    "account.opening": "Opening",
    "account.closing": "Closing",
    "account.balance": "Cached balance",
    "account.from": "From",
    "account.to": "To",
    "account.lookup": "Look up an account",
    "account.hint": "Account code from the chart of accounts, e.g. 1000",
    "account.pick": "Pick an account",
    "account.browse": "Browse the chart of accounts",
    "account.pickBody": "Enter an account code above to read its statement.",
    "account.lines": "Statement",
    "account.linesCaption": "Journal lines for this account",
    "account.running": "Running",
    "account.txn": "Transaction",
    "account.empty": "No lines in this window",
    "account.emptyBody": "Nothing posted to this account between these dates.",
    "account.drift": "The cached balance disagrees with the journal",
    "account.driftBody":
      "The statement closes on one figure and the balance cache holds another. The journal is the truth. Rebuild the cache from the period close screen.",

    /* reconciliation */
    "recon.title": "Reconciliation",
    "recon.intro":
      "Match a counterparty statement against what we settled. Nothing posts here — a match is a judgement, and it is recorded as one.",
    "recon.headlineNone": "{count} recent reconciliation run(s). Pick one to see its detail.",
    "recon.headlineOpen": "{process} has {count} match(es) awaiting a decision.",
    "recon.headlineMatched": "{process} is matched, nothing awaiting a decision.",
    "recon.process": "Process",
    "recon.period": "Period",
    "recon.counterparty": "Counterparty",
    "recon.counterpartyHint": "The insurer, partner or provider id this statement came from. Leave it blank to match the whole period.",
    "recon.tolerance": "Tolerance",
    "recon.propose": "Let the assistant propose matches for the leftovers",
    "recon.proposeHint": "Proposals are never posted. Each one still needs a person to confirm it.",
    "recon.file": "Statement file",
    "recon.fileHint":
      "Upload the file the bank or insurer sent: CAMT.053, MT940 or OFX. The format is read from the file itself, so its name does not matter. Leave this empty to paste the lines instead.",
    "recon.fileOr": "Or paste the lines",
    "recon.fileUnreadable": "That file is not a statement in a format we read. Upload a CAMT.053, MT940 or OFX export, or paste the lines below.",
    "recon.lines": "Statement lines",
    "recon.linesHint":
      "Paste the statement as it was exported — one line per row, columns in this order: reference, amount, our reference, date, description. Only the first two are needed. Commas or tabs; a header row is fine.",
    "recon.linesPlaceholder": "INS-8891, 1500.55, TXN-01, 2026-08-01, August premium",
    "recon.linesRead": "{count} lines read, {rejected} not.",
    "recon.linesCaption": "The statement lines as they were read",
    "recon.linesMore": "…and {count} more, all of which will be reconciled.",
    "recon.linesRejected": "These rows were not read. Fix them or take them out — a run must see the whole statement.",
    "recon.linesRow": "Row {row}",
    "recon.lineAmount": "Amount",
    "recon.lineOurRef": "Our reference",
    "recon.linePostedAt": "Date",
    "recon.lineDescription": "Description",
    "recon.start": "Start run",
    "recon.startConfirm": "Start this reconciliation run?",
    "recon.runs": "Runs",
    "recon.runsCaption": "Recent reconciliation runs",
    "recon.noRuns": "No reconciliation runs yet.",
    "recon.noRuns.body": "A run compares a bank statement against the ledger. Start one from the accounts screen to see breaks here.",
    "recon.run": "Run",
    "recon.matched": "Matched",
    "recon.variance": "Variance",
    "recon.varianceMinor": "Variance amount",
    "recon.open": "Awaiting a decision",
    "recon.matches": "Matches",
    "recon.matchesCaption": "Proposed and decided matches in this run",
    "recon.statementRef": "Statement line",
    "recon.txn": "Transaction",
    "recon.delta": "Delta",
    "recon.method": "How",
    "recon.confidence": "Confidence",
    "recon.decidedBy": "Decided by",
    "recon.decide": "Decide",
    "recon.confirm": "Confirm",
    "recon.reject": "Reject",
    "recon.reasonCode": "Why",
    "recon.reasonCodeHint": "Recorded against your name on the match. Say what convinced you.",
    "recon.confirmConfirm": "Confirm this match? Your name and reason go on the record.",
    "recon.rejectConfirm": "Reject this match? Your name and reason go on the record.",
    "recon.noMatches": "No matches yet",
    "recon.noMatchesBody": "This run produced nothing to decide.",
    "recon.aiProposed": "Proposed by the assistant",
    "recon.lookup": "Open a run",
    "recon.runId": "Run id",
    "recon.started": "Run {id} started: {matched} matched, {variances} with a variance.",
    "recon.decided": "Match recorded as {decision}.",
    "recon.close": "Close run",
    "recon.closeConfirm":
      "Close this run? It only closes if nothing is left awaiting a decision, and your name goes on the record.",
    "recon.closed": "Run {id} closed.",
    "recon.writeOff": "Write off the residual",
    "recon.writeOffIntro":
      "Clears a small difference off the account it is sitting on, as a transaction: two balanced lines, your reason on the record, and a second person's approval before it posts.",
    "recon.writeOffAmount": "Amount to write off",
    "recon.writeOffAmountHint": "Prefilled with this run's variance. Change it to write off part of it.",
    "recon.writeOffAmountInvalid": "Enter an amount above zero to write off.",
    "recon.writeOffDirection": "Which way it runs",
    "recon.writeOffShortfall": "They paid less than we booked",
    "recon.writeOffSurplus": "They paid more than we booked",
    "recon.writeOffAccount": "Account carrying it",
    "recon.writeOffAccountHint": "1100 commission receivable, 1300 payment-provider clearing, 2100 partner payable.",
    "recon.writeOffReason": "Why",
    "recon.writeOffReasonHint":
      "At least ten characters, and the only thing an auditor will have to go on. Say what the difference was.",
    "recon.writeOffConfirm":
      "Write this off? It posts a journal entry in your name once a second person approves it, and it cannot be undone — only reversed.",
    "recon.wroteOff": "Write-off {id} recorded.",
    "recon.writeOffApproval": "The write-off is waiting for a second pair of eyes",
    "recon.writeOffApprovalBody":
      "Nothing has posted yet. A write-off always needs someone other than you to approve it; it is in the approvals queue now.",
    "recon.approvalsInbox": "Open approvals",
    "recon.pick": "Pick a run",
    "recon.pickBody": "Start a run above, or open one by its id.",
    "recon.linesInvalid": "Paste the statement before starting a run.",
    "recon.unmatched": "Unmatched",
    "recon.unmatchedRefs": "Statement lines with no transaction",
    "recon.unmatchedTxns": "Transactions with no statement line",
    "recon.evidence": "Evidence bundle",
    "recon.evidenceIntro":
      "Gathers this run and its matches into one hashed archive a regulator or auditor can be handed.",
    "recon.evidenceBuild": "Build evidence bundle",
    "recon.evidenceBuildConfirm": "Build an evidence bundle for this run?",
    "recon.evidenceReady": "Bundle built, {count} file(s).",
    "recon.evidenceFailed": "The archive could not be stored.",
    "recon.evidenceStateReady": "Ready",
    "recon.evidenceStateFailed": "Failed",
    "recon.evidenceHash": "Bundle hash",
    "recon.evidenceRequestedBy": "Prepared by",
    "recon.evidenceDownload": "Download bundle",
    "recon.evidencePipeline": "How it was built",
    "recon.evidenceDocuments": "Bundled documents",
    "recon.evidenceStepRun": "Run captured",
    "recon.evidenceStepMatches": "Matches captured",
    "recon.evidenceStepSummary": "Summary rendered",
    "recon.evidenceRunIdInvalid": "Open a run before building its evidence bundle.",

    /* method / process / decision vocabulary */
    "method.deterministic": "Exact",
    "method.tolerance": "Within tolerance",
    "method.ai_proposed": "Assistant",
    "process.insurer": "Insurer",
    "process.psp": "Payment provider",
    "process.client_money": "Client money",
    "process.partner": "Partner",
    "process.media": "Media",
    "match.proposed": "Proposed",
    "match.confirmed": "Confirmed",
    "match.rejected": "Rejected",
    "match.unmatched": "Unmatched",
    "side.debit": "Debit",
    "side.credit": "Credit",
    "state.open": "Open",
    "state.soft_closed": "Soft closed",
    "state.hard_closed": "Hard closed",
    "state.running": "Running",
    "state.review": "Review",
    "state.closed": "Closed",
    "state.initiated": "Initiated",
    "state.validated": "Validated",
    "state.authorized": "Authorized",
    "state.executing": "Executing",
    "state.pending_external": "Waiting on a third party",
    "state.settled": "Settled",
    "state.reversing": "Reversing",
    "state.reversed": "Reversed",
    "state.adjusting": "Adjusting",
    "state.adjusted": "Adjusted",
    "state.failed": "Failed",
    "state.rejected": "Rejected",
    "state.expired": "Expired"
  },

  ar: {
    denied: "ليس لديك إذن لعرض هذه الشاشة.",
    deniedBody: "تحتاج هذه الشاشة إلى {permission}. راجع المسؤول إن كان ينبغي أن تملكه.",
    back: "رجوع",
    none: "—",
    apply: "تطبيق",
    reason: "السبب",
    reasonRequired: "السبب مطلوب.",
    currency: "العملة",
    amount: "المبلغ",
    state: "الحالة",
    when: "الوقت",
    actor: "المنفّذ",
    idempotencyNote: "يحمل هذا النموذج مفتاحًا لمرة واحدة، فالضغط مرتين يُرسل مرة واحدة.",
    approvalTitle: "بانتظار موافقة",
    approvalBody: "يتطلب هذا اعتمادًا بموجب {policy} قبل أن يُنفَّذ.",
    approvalLink: "افتح قائمة الموافقات",

    "txn.title": "المعاملة",
    "txn.intro": "معاملة واحدة، وقيودها، وكل ما جرى عليها.",
    "txn.headline": "{type} — {amount}، {state}.",
    "txn.type": "النوع",
    "txn.gross": "الإجمالي",
    "txn.correlation": "معرّف الارتباط",
    "txn.parent": "فتحتها",
    "txn.reversalOf": "تعكس",
    "txn.reversedBy": "عُكست بواسطة",
    "txn.failure": "سبب الفشل",
    "txn.key": "مفتاح عدم التكرار",
    "txn.batch": "دفعة القيود",
    "txn.lines": "سطور القيد",
    "txn.linesCaption": "سطور القيد التي رحّلتها هذه المعاملة",
    "txn.noLines": "لا توجد سطور قيد",
    "txn.noLinesBody": "المعاملة غير المالية تُسوّى دون دفعة قيود. لم يُرحّل شيء.",
    "txn.account": "الحساب",
    "txn.side": "الجانب",
    "txn.memo": "البيان",
    "txn.debit": "مدين",
    "txn.credit": "دائن",
    "txn.totalDebit": "إجمالي المدين",
    "txn.totalCredit": "إجمالي الدائن",
    "txn.balanced": "المدين يساوي الدائن.",
    "txn.imbalance": "هذه الدفعة غير متوازنة",
    "txn.imbalanceBody":
      "يختلف المدين عن الدائن بالمقدار أعلاه، والقيد المزدوج لا يسمح بذلك. لا تتصرّف بهذه المعاملة وأبلغ الهندسة المالية بمعرّف الدفعة.",
    "txn.history": "السجل",
    "txn.historyLabel": "تغيّرات الحالة",
    "txn.approvals": "الموافقات",
    "txn.approvalsEmpty": "لم يحتج أي إجراء على هذه المعاملة إلى موافقة.",
    "txn.approvalsEmpty.body": "بقيت ضمن الحدود التي تؤتمتها سياستك، فلم يحتج أحد إلى اعتمادها.",
    "txn.approvalsInbox": "فتح قائمة الموافقات",
    "txn.audit": "سجل التدقيق",
    "txn.auditEmpty": "لم يحدث شيء لهذه المعاملة بعد.",
    "txn.auditEmpty.body": "سيُسجَّل هنا كل ترحيل وعكس واعتماد عليها فور حدوثه.",
    "txn.transition": "تغيير الحالة",
    "txn.transitionTo": "الانتقال إلى",
    "txn.transitionSubmit": "نقل",
    "txn.transitionNone": "لا يوجد انتقال مسموح من هذه الحالة.",
    "txn.failureCode": "رمز الفشل",
    "txn.reverse": "عكس",
    "txn.reverseBody":
      "العكس لا يحذف شيئًا، بل يفتح معاملة ثانية تُرحّل القيد المعاكس وتبقى الاثنتان في السجل.",
    "txn.reverseSubmit": "عكس هذه المعاملة",
    "txn.reverseConfirm": "هل تعكس هذه المعاملة؟ سيُرحّل قيد معاكس وتبقى الاثنتان في السجل.",
    "txn.approvalRaised": "طُلبت موافقة",
    "txn.approvalRaisedBody":
      "لم يحدث شيء بعد. الطلب في انتظار من يملك البتّ فيه ضمن قائمة الموافقات.",
    "txn.moved": "انتقلت إلى {state}.",
    "txn.reversedAs": "رُحّل القيد العكسي بالمعرّف {id}.",
    "txn.statement": "فتح كشف الحساب",

    "open.title": "فتح معاملة",
    "open.intro": "المال يتحرك بتشغيل نوع معاملة. اختر النوع وأدخل معاملاته، ويُرحّل الدفتر الوصفة.",
    "open.headline": "{count} نوع معاملة جاهز للتشغيل.",
    "open.headlineGated": "{count} نوع معاملة جاهز للتشغيل؛ {gated} منها يحتاج موافقة أولاً.",
    "open.headlineEmpty": "لم يُنشر أي نوع معاملة بعد.",
    "open.type": "نوع المعاملة",
    "open.financial": "تُرحّل قيدًا",
    "open.nonFinancial": "بلا قيد",
    "open.approval": "تحتاج موافقة",
    "open.payout": "صرف",
    "open.clientMoney": "أموال العملاء",
    "open.key": "مفتاح المعاملة",
    "open.keyHint": "المفتاح الطبيعي لهذه المعاملة. إعادة استخدامه تُعيد المعاملة نفسها.",
    "open.gross": "المبلغ الإجمالي",
    "open.args": "المعاملات",
    "open.argsHint": "ما تحتاجه هذه المعاملة لترحيل قيدها. اترك الحقل فارغًا ليُؤخذ الافتراضي من الوصفة.",
    "open.argsNone": "هذا النوع لا يأخذ معاملات.",
    "open.argAccountHint": "رمز الحساب",
    "arg.amountMinor": "المبلغ",
    "arg.grossMinor": "العمولة الإجمالية",
    "arg.netMinor": "الصافي",
    "arg.taxMinor": "الضريبة",
    "arg.feeMinor": "الرسوم",
    "arg.channelMinor": "حصة القناة",
    "arg.premiumMinor": "القسط",
    "arg.flatFeeMinor": "رسوم ثابتة",
    "arg.withholdingMinor": "ضريبة الاستقطاع",
    "arg.baseCommissionPpm": "نسبة العمولة (جزء بالمليون)",
    "arg.channelSharePpm": "نسبة حصة القناة (جزء بالمليون)",
    "arg.taxPpm": "نسبة الضريبة (جزء بالمليون)",
    "arg.incomeAccount": "حساب الإيراد",
    "arg.expenseAccount": "حساب المصروف",
    "arg.receivableAccount": "حساب المدينين",
    "arg.payableAccount": "حساب الدائنين",
    "arg.cashAccount": "حساب النقد",
    "arg.creditAccount": "الحساب الدائن",
    "arg.debitAccount": "الحساب المدين",
    "arg.deferredAccount": "حساب الإيراد المؤجل",
    "arg.liabilityAccount": "حساب الالتزام",
    "arg.memo": "بيان",
    "open.submit": "فتح المعاملة",
    "open.confirm": "هل تفتح هذه المعاملة؟ سيتم الترحيل إلى الدفتر.",
    "open.opened": "فُتحت المعاملة",
    "open.catalogue": "دليل الأنواع",
    "open.catalogueCaption": "أنواع المعاملات المتاحة لهذه المؤسسة",
    "open.catalogueEmpty": "لا توجد أنواع معاملات بعد",
    "open.catalogueEmptyBody": "لا يمكن فتح أي معاملة قبل نشر نوع لهذه المؤسسة.",
    "open.code": "الرمز",
    "open.openedAs": "فُتحت بالمعرّف {id}.",
    "open.openRecord": "فتحها",

    "period.title": "إقفال الفترة",
    "period.intro":
      "تُقفل الفترة عندما تنجح فحوصها. ابدأ بالإقفال المبدئي: يوقف الترحيل الاعتيادي ويسمح بالتسويات المسبّبة.",
    "period.headlineNone": "لم يتم اختيار فترة بعد.",
    "period.headlineBlocked": "{code} لديها {count} فحصًا لا يزال يمنع الإقفال.",
    "period.headlineReady": "{code} جاهزة للإقفال.",
    "period.headlineState": "{code} حالتها {state}.",
    "period.code": "الفترة",
    "period.checks": "الفحوص",
    "period.checksCaption": "فحوص إقفال هذه الفترة",
    "period.check": "الفحص",
    "check.trial_balance_zero": "المدين يساوي الدائن",
    "check.batches_match_lines": "كل دفعة تطابق سطورها",
    "check.no_pending_external": "لا شيء ينتظر مزوّدًا",
    "check.no_open_client_money_breach": "لا مخالفة مفتوحة في أموال العملاء",
    "period.detail": "التفصيل",
    "period.ok": "ناجح",
    "period.fail": "فاشل",
    "period.blocked": "لا يمكن إقفال هذه الفترة بعد",
    "period.blockedBody": "لم تنجح الفحوص أدناه. عالج ما تشير إليه ثم أقفل.",
    "period.closedBy": "أقفلها",
    "period.closedNow": "الفترة {code} أصبحت {state}.",
    "period.reopened": "الفترة {code} مفتوحة من جديد.",
    "period.close": "إقفال",
    "period.closeSoft": "إقفال مبدئي",
    "period.closeHard": "إقفال نهائي",
    "period.closeSoftConfirm": "إقفال مبدئي لهذه الفترة؟ يتوقف الترحيل الاعتيادي وتبقى التسويات المسبّبة ممكنة.",
    "period.closeHardConfirm": "إقفال نهائي لهذه الفترة؟ لن تُرحّل بعده إلا القيود العكسية.",
    "period.reopen": "إعادة فتح",
    "period.reopenConfirm": "إعادة فتح هذه الفترة؟ يستأنف الترحيل ويُلغى الإقفال.",
    "period.recent": "الفترات",
    "period.recentCaption": "الفترات المحاسبية الأخيرة",
    "period.noneRecent": "لم يتم إقفال أي فترة بعد.",
    "period.noneRecent.body": "تظهر الفترة هنا بعد إقفالها. الإقفال يقفل دفترها ليتسنى إصدار الأرصدة.",
    "period.noneSelected": "لم يتم اختيار فترة.",
    "period.noneSelectedBody":
      "اختر فترة من القائمة أدناه، أو ابحث عنها بالرمز، لعرض فحوصها وإقفالها.",
    "period.lookup": "بحث عن فترة",

    "ye.title": "إقفال نهاية السنة",
    "ye.intro":
      "قيد واحد يصفّر كل حسابات الإيرادات والمصروفات في الأرباح المحتجزة. السطور تُقرأ من الدفتر ولا تُكتب يدويًا: ما تراه هنا هو ما يُرحّل.",
    "ye.headlineEmpty": "السنة المالية {year} ليس فيها ما يُقفل.",
    "ye.headline": "صافي السنة المالية {year} هو {amount}.",
    "ye.year": "السنة المالية",
    "ye.preview": "القيد الذي سيُرحّل",
    "ye.previewCaption": "سطور إقفال السنة المالية",
    "ye.income": "الإيرادات",
    "ye.expense": "المصروفات",
    "ye.net": "نتيجة السنة",
    "ye.retained": "إلى {account}",
    "ye.account": "الحساب",
    "ye.side": "الجانب",
    "ye.amount": "المبلغ",
    "ye.side.debit": "مدين",
    "ye.side.credit": "دائن",
    "ye.nothing": "لا شيء للإقفال",
    "ye.nothingBody": "لا يحمل أي حساب إيراد أو مصروف رصيدًا لهذه السنة، فلا قيد إقفال.",
    "ye.post": "ترحيل الإقفال",
    "ye.postConfirm":
      "هل يُرحّل إقفال نهاية السنة؟ يحتاج موافقة مقعد ثانٍ، وبعد تسويته تستقر نتيجة السنة في الأرباح المحتجزة.",
    "ye.posted": "أُقفلت السنة المالية {year}. النتيجة الآن في {account}.",
    "ye.prereq": "أقفل كل أشهر السنة أولًا",
    "ye.prereqBody":
      "قيد نهاية السنة يُرحّل في أشهر مقفلة. أقفل كل شهر إقفالًا مبدئيًا من شاشة إقفال الفترة ثم عد إلى هنا.",
    "ye.toPeriods": "إلى إقفال الفترة",

    "mj.title": "قيد يدوي",
    "mj.intro":
      "قيد يُكتب يدويًا لما لا يغطيه نوع معاملة — استحقاق أو تصحيح أو إعادة تصنيف. لا يُرحّل بكلمة محرّره وحده: يوافق عليه مقعد ثانٍ.",
    "mj.reason": "سبب هذا القيد",
    "mj.reasonHint": "عشرة أحرف على الأقل. هو أول ما يقرأه المدقّق.",
    "mj.lines": "السطور",
    "mj.account": "الحساب",
    "mj.accountHint": "أربعة أرقام",
    "mj.memo": "بيان",
    "mj.side": "الجانب",
    "mj.amount": "المبلغ",
    "mj.debit": "مدين",
    "mj.credit": "دائن",
    "mj.addLine": "إضافة سطر",
    "mj.removeLine": "حذف هذا السطر",
    "mj.totalDebit": "مجموع المدين",
    "mj.totalCredit": "مجموع الدائن",
    "mj.difference": "الفرق",
    "mj.balanced": "القيد متوازن.",
    "mj.unbalanced": "المدين والدائن غير متطابقين بعد، فلا يمكن الإرسال.",
    "mj.submit": "إرسال للموافقة",
    "mj.submitConfirm": "هل يُرسل هذا القيد للموافقة؟ يُرحّل إلى الدفتر فور موافقة مقعد ثانٍ.",
    "mj.sent": "أُرسل للموافقة. يُرحّل عند موافقة مقعد ثانٍ.",
    "mj.settled": "رُحّل بالمعرّف {id}.",
    "mj.forbidden":
      "حسابات أموال العملاء وحقوق الملكية خارج المتناول هنا: أموال العملاء تتحرك بأنواع معاملات خاصة بها، وحقوق الملكية تتحرك عند إقفال نهاية السنة.",
    "period.rebuild": "مطابقة الأرصدة مع الدفتر",
    "period.rebuildBody":
      "الدفتر هو المصدر وجدول الأرصدة نسخة مشتقة منه. هذا الفحص يقرأ كل السطور ويبيّن مواضع الاختلاف. لا يكتب شيئًا ولا يحرّك مالًا، وهو الجواب على فحص يخالف الدفتر.",
    "period.rebuildConfirm": "هل تُعاد قراءة الدفتر كاملًا؟ لا يُكتب شيء، لكن الأمر قد يستغرق وقتًا.",
    "period.rebuildSubmit": "تشغيل الفحص",
    "period.checked": "فُحص {count} رصيدًا، وكلها مطابقة للدفتر.",
    "period.driftTable": "فحص الأرصدة",
    "period.driftCaption": "مقارنة الأرصدة المخزّنة بالدفتر",
    "period.driftedTitle": "{count} من {total} رصيدًا تخالف الدفتر",
    "period.driftedBody":
      "الرصيد المخزّن يختلف عن الدفتر في الحسابات أدناه. الدفتر هو المصدر: لم يتغيّر أي مال هنا، ولا ينبغي فرض الإقفال قبل تطابقها.",
    "period.driftOnly": "تُعرض الحسابات المختلفة فقط.",
    "period.stored": "المخزّن",
    "period.rebuiltCol": "من الدفتر",

    "account.title": "كشف حساب",
    "account.intro": "كل سطر رُحّل إلى هذا الحساب والرصيد الذي تركه.",
    "account.headlineNone": "أدخل رقم حساب لعرض كشفه.",
    "account.headlineDrift": "الرصيد المخزَّن للحساب {code} يختلف عن دفتر اليومية.",
    "account.headline": "يُقفل الحساب {code} على {amount}.",
    "account.code": "الحساب",
    "account.opening": "الرصيد الافتتاحي",
    "account.closing": "الرصيد الختامي",
    "account.balance": "الرصيد المخزّن",
    "account.from": "من",
    "account.to": "إلى",
    "account.lookup": "بحث عن حساب",
    "account.hint": "رقم الحساب من دليل الحسابات، مثال 1000",
    "account.pick": "اختر حسابًا",
    "account.browse": "تصفّح دليل الحسابات",
    "account.pickBody": "أدخل رقم الحساب أعلاه لعرض كشفه.",
    "account.lines": "الكشف",
    "account.linesCaption": "سطور القيد لهذا الحساب",
    "account.running": "الرصيد الجاري",
    "account.txn": "المعاملة",
    "account.empty": "لا سطور في هذه الفترة",
    "account.emptyBody": "لم يُرحّل شيء إلى هذا الحساب بين هذين التاريخين.",
    "account.drift": "الرصيد المخزّن يخالف الدفتر",
    "account.driftBody":
      "يُقفل الكشف على رقم ويحمل المخزون رقمًا آخر. الدفتر هو المصدر. أعد بناء المخزون من شاشة إقفال الفترة.",

    "recon.title": "التسوية",
    "recon.intro": "طابق كشف الطرف المقابل مع ما سوّيناه. لا ترحيل هنا — المطابقة حكم، وتُسجّل كذلك.",
    "recon.headlineNone": "{count} تشغيلة تسوية حديثة. اختر واحدة لعرض تفاصيلها.",
    "recon.headlineOpen": "لدى {process} {count} فرقًا بانتظار قرار.",
    "recon.headlineMatched": "طابقت {process} بالكامل — لا شيء بانتظار قرار.",
    "recon.process": "العملية",
    "recon.period": "الفترة",
    "recon.counterparty": "الطرف المقابل",
    "recon.counterpartyHint": "معرّف شركة التأمين أو الشريك أو المزوّد الذي جاء منه هذا الكشف. اتركه فارغًا لمطابقة الفترة كاملة.",
    "recon.tolerance": "حد التسامح",
    "recon.propose": "دع المساعد يقترح مطابقات للمتبقّي",
    "recon.proposeHint": "الاقتراحات لا تُرحّل أبدًا، ويظل كل اقتراح بحاجة إلى تأكيد شخص.",
    "recon.file": "ملف الكشف",
    "recon.fileHint":
      "ارفع الملف الذي أرسله المصرف أو شركة التأمين: CAMT.053 أو MT940 أو OFX. تُقرأ الصيغة من الملف نفسه، فاسم الملف لا يهم. اتركه فارغًا إن كنت ستلصق السطور بدلًا من ذلك.",
    "recon.fileOr": "أو الصق السطور",
    "recon.fileUnreadable": "هذا الملف ليس كشفًا بصيغة نقرؤها. ارفع تصديرًا بصيغة CAMT.053 أو MT940 أو OFX، أو الصق السطور أدناه.",
    "recon.lines": "سطور الكشف",
    "recon.linesHint":
      "الصق الكشف كما صُدِّر — سطر لكل صف، والأعمدة بهذا الترتيب: المرجع، المبلغ، مرجعنا، التاريخ، الوصف. الأول والثاني وحدهما مطلوبان. فواصل أو علامات جدولة، وصف العناوين مقبول.",
    "recon.linesPlaceholder": "INS-8891, 1500.55, TXN-01, 2026-08-01, قسط أغسطس",
    "recon.linesRead": "قُرئ {count} سطرًا، وتعذّر {rejected}.",
    "recon.linesCaption": "سطور الكشف كما قُرئت",
    "recon.linesMore": "…و{count} أخرى، وجميعها ستُسوّى.",
    "recon.linesRejected": "هذه الصفوف لم تُقرأ. صحّحها أو احذفها — التشغيل يجب أن يرى الكشف كاملًا.",
    "recon.linesRow": "الصف {row}",
    "recon.lineAmount": "المبلغ",
    "recon.lineOurRef": "مرجعنا",
    "recon.linePostedAt": "التاريخ",
    "recon.lineDescription": "الوصف",
    "recon.start": "بدء التشغيل",
    "recon.startConfirm": "هل تبدأ هذه التسوية؟",
    "recon.runs": "عمليات التشغيل",
    "recon.runsCaption": "أحدث عمليات التسوية",
    "recon.noRuns": "لا توجد عمليات تسوية بعد.",
    "recon.noRuns.body": "تقارن العملية كشف البنك بدفتر الأستاذ. ابدأ واحدة من شاشة الحسابات لترى الفروقات هنا.",
    "recon.run": "التشغيل",
    "recon.matched": "مطابَق",
    "recon.variance": "فروقات",
    "recon.varianceMinor": "مبلغ الفروقات",
    "recon.open": "بانتظار قرار",
    "recon.matches": "المطابقات",
    "recon.matchesCaption": "المطابقات المقترحة والمقرّرة في هذا التشغيل",
    "recon.statementRef": "سطر الكشف",
    "recon.txn": "المعاملة",
    "recon.delta": "الفرق",
    "recon.method": "الطريقة",
    "recon.confidence": "الثقة",
    "recon.decidedBy": "قرّرها",
    "recon.decide": "قرار",
    "recon.confirm": "تأكيد",
    "recon.reject": "رفض",
    "recon.reasonCode": "السبب",
    "recon.reasonCodeHint": "يُسجَّل باسمك على المطابقة. اذكر ما أقنعك.",
    "recon.confirmConfirm": "تأكيد هذه المطابقة؟ سيُسجَّل اسمك وسببك.",
    "recon.rejectConfirm": "رفض هذه المطابقة؟ سيُسجَّل اسمك وسببك.",
    "recon.noMatches": "لا مطابقات بعد",
    "recon.noMatchesBody": "لم يُنتج هذا التشغيل ما يُقرَّر فيه.",
    "recon.aiProposed": "اقترحه المساعد",
    "recon.lookup": "فتح تشغيل",
    "recon.runId": "معرّف التشغيل",
    "recon.started": "بدأ التشغيل {id}: {matched} مطابقة و{variances} فرقًا.",
    "recon.decided": "سُجّلت المطابقة على أنها {decision}.",
    "recon.close": "إغلاق التشغيل",
    "recon.closeConfirm":
      "إغلاق هذا التشغيل؟ لا يُغلق إلا إذا لم يبقَ شيء بانتظار قرار، ويُسجَّل اسمك على ذلك.",
    "recon.closed": "أُغلق التشغيل {id}.",
    "recon.writeOff": "شطب الفرق المتبقي",
    "recon.writeOffIntro":
      "يُزيل فرقًا صغيرًا من الحساب الذي يحمله، كمعاملة: قيدان متوازنان، وسببك مسجَّل، وموافقة شخص ثانٍ قبل الترحيل.",
    "recon.writeOffAmount": "المبلغ المراد شطبه",
    "recon.writeOffAmountHint": "مُعبَّأ بفرق هذا التشغيل. غيّره لشطب جزء منه.",
    "recon.writeOffAmountInvalid": "أدخل مبلغًا أكبر من صفر للشطب.",
    "recon.writeOffDirection": "اتجاه الفرق",
    "recon.writeOffShortfall": "دفعوا أقل مما سجّلنا",
    "recon.writeOffSurplus": "دفعوا أكثر مما سجّلنا",
    "recon.writeOffAccount": "الحساب الذي يحمله",
    "recon.writeOffAccountHint": "1100 عمولات مستحقة، 1300 تسوية مزود الدفع، 2100 مستحقات الشركاء.",
    "recon.writeOffReason": "السبب",
    "recon.writeOffReasonHint": "عشرة أحرف على الأقل، وهو كل ما سيجده المدقّق. اذكر ما كان عليه الفرق.",
    "recon.writeOffConfirm":
      "شطب هذا الفرق؟ يُرحَّل قيد باسمك بعد موافقة شخص ثانٍ، ولا يمكن التراجع عنه — بل عكسه فقط.",
    "recon.wroteOff": "سُجّل الشطب {id}.",
    "recon.writeOffApproval": "الشطب بانتظار مراجعة ثانية",
    "recon.writeOffApprovalBody":
      "لم يُرحَّل شيء بعد. الشطب يحتاج دائمًا موافقة شخص غيرك، وهو الآن في قائمة الموافقات.",
    "recon.approvalsInbox": "فتح الموافقات",
    "recon.pick": "اختر تشغيلًا",
    "recon.pickBody": "ابدأ تشغيلًا أعلاه أو افتح واحدًا بمعرّفه.",
    "recon.linesInvalid": "الصق الكشف قبل بدء التشغيل.",
    "recon.unmatched": "غير مطابق",
    "recon.unmatchedRefs": "سطور كشف بلا معاملة",
    "recon.unmatchedTxns": "معاملات بلا سطر كشف",
    "recon.evidence": "حزمة الأدلة",
    "recon.evidenceIntro": "تجمع هذا التشغيل ومطابقاته في أرشيف واحد مُحسوب البصمة يمكن تسليمه لجهة رقابية أو مدقق.",
    "recon.evidenceBuild": "إنشاء حزمة الأدلة",
    "recon.evidenceBuildConfirm": "إنشاء حزمة أدلة لهذا التشغيل؟",
    "recon.evidenceReady": "تم إنشاء الحزمة، {count} ملف.",
    "recon.evidenceFailed": "تعذّر تخزين الأرشيف.",
    "recon.evidenceStateReady": "جاهزة",
    "recon.evidenceStateFailed": "فشلت",
    "recon.evidenceHash": "بصمة الحزمة",
    "recon.evidenceRequestedBy": "أعدّها",
    "recon.evidenceDownload": "تنزيل الحزمة",
    "recon.evidencePipeline": "كيف أُنشئت",
    "recon.evidenceDocuments": "المستندات المجمّعة",
    "recon.evidenceStepRun": "التُقط التشغيل",
    "recon.evidenceStepMatches": "التُقطت المطابقات",
    "recon.evidenceStepSummary": "أُنشئ الملخص",
    "recon.evidenceRunIdInvalid": "افتح تشغيلًا قبل إنشاء حزمة أدلته.",

    "method.deterministic": "مطابقة تامة",
    "method.tolerance": "ضمن حد التسامح",
    "method.ai_proposed": "المساعد",
    "process.insurer": "شركة التأمين",
    "process.psp": "مزوّد الدفع",
    "process.client_money": "أموال العملاء",
    "process.partner": "الشريك",
    "process.media": "الإعلام",
    "match.proposed": "مقترحة",
    "match.confirmed": "مؤكدة",
    "match.rejected": "مرفوضة",
    "match.unmatched": "غير مطابقة",
    "side.debit": "مدين",
    "side.credit": "دائن",
    "state.open": "مفتوحة",
    "state.soft_closed": "مقفلة مبدئيًا",
    "state.hard_closed": "مقفلة نهائيًا",
    "state.running": "قيد التشغيل",
    "state.review": "قيد المراجعة",
    "state.closed": "مقفلة",
    "state.initiated": "بدأت",
    "state.validated": "تم التحقق",
    "state.authorized": "مُصرّح بها",
    "state.executing": "قيد التنفيذ",
    "state.pending_external": "بانتظار طرف ثالث",
    "state.settled": "مسوّاة",
    "state.reversing": "قيد العكس",
    "state.reversed": "معكوسة",
    "state.adjusting": "قيد التسوية",
    "state.adjusted": "مسوّاة تعديليًا",
    "state.failed": "فشلت",
    "state.rejected": "مرفوضة",
    "state.expired": "منتهية"
  }
};

export type Label = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The pack answers first (CLAUDE.md §14): `process.insurer` is an industry noun
 * and a tenant selling something else calls that counterparty a supplier. Every
 * other key here is platform vocabulary, which no pack has an opinion on, so
 * the consult costs one lookup and changes nothing for the default pack.
 */
export function labelIn(locale: string, pack?: string): Label {
  const table = LABELS[locale] ?? LABELS.en!;
  const packed = vocabulary(pack, locale);
  return (key, vars) => {
    const text = pseudoText(locale, packed(key) ?? table[key] ?? LABELS.en![key] ?? key);
    return vars
      ? text.replace(/\{(\w+)\}/g, (whole, name: string) => String(vars[name] ?? whole))
      : text;
  };
}

/**
 * A close check as the accountant reading it says it. The ledger names checks
 * for itself — `no_pending_external@2026-08` — and the close screen printed
 * exactly that, key, period suffix and all, in the blocking banner and in every
 * row of the checks table. The period is already the heading above both.
 */
export function checkName(name: string, l: Label): string {
  const key = name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
  const said = l(`check.${key}`);
  return said === `check.${key}` ? humanise(key) : said;
}

// Hero headlines: each is a pure function of a screen's already-loaded data,
// feeding the dynamic <h1> per the orbit-console pattern. No ✦, none of this
// is an agent's finding (CLAUDE.md §11) — it's the loader's own numbers said
// back in a sentence.

export function openHeadline(types: readonly { approval: string | null }[], l: Label): string {
  if (types.length === 0) return l("open.headlineEmpty");
  const gated = types.filter((type) => type.approval).length;
  return gated > 0
    ? l("open.headlineGated", { count: types.length, gated })
    : l("open.headline", { count: types.length });
}

export function txnHeadline(
  txn: { type: string; state: string; grossMinor: number; currency: string },
  l: Label,
  locale: string
): string {
  return l("txn.headline", {
    type: txn.type,
    amount: formatMoney(txn.grossMinor, txn.currency, locale),
    state: l(`state.${txn.state}`)
  });
}

export function periodHeadline(
  period: { code: string; state: string } | null,
  failed: number,
  l: Label
): string {
  if (!period) return l("period.headlineNone");
  if (failed > 0) return l("period.headlineBlocked", { code: period.code, count: failed });
  if (period.state === "open") return l("period.headlineReady", { code: period.code });
  return l("period.headlineState", { code: period.code, state: l(`state.${period.state}`) });
}

export function yearEndHeadline(
  year: string,
  preview: { netMinor: number; currency: string; closingLines: readonly unknown[] },
  l: Label,
  locale: string
): string {
  if (preview.closingLines.length === 0) return l("ye.headlineEmpty", { year });
  return l("ye.headline", { year, amount: formatMoney(preview.netMinor, preview.currency, locale) });
}

export function accountHeadline(
  statement: { accountCode: string; closingMinor: number } | null,
  currency: string,
  drift: boolean,
  l: Label,
  locale: string
): string {
  if (!statement) return l("account.headlineNone");
  if (drift) return l("account.headlineDrift", { code: statement.accountCode });
  return l("account.headline", {
    code: statement.accountCode,
    amount: formatMoney(statement.closingMinor, currency, locale)
  });
}

export function reconHeadline(
  summary: { process: string; open: number } | null,
  runsCount: number,
  l: Label
): string {
  if (!summary) return l("recon.headlineNone", { count: runsCount });
  if (summary.open > 0) return l("recon.headlineOpen", { process: summary.process, count: summary.open });
  return l("recon.headlineMatched", { process: summary.process });
}
