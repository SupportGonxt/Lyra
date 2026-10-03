import { and, eq, like, sql } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { applyPpm } from "../commission.js";
import { computeChainHash } from "../audit.js";
import { DAY, HOUR, MINUTE } from "./context.js";
import {
  BASE,
  insertChunked,
  monthCode,
  monthStartOf,
  nextMonthStart,
  postAll,
  premiumFor,
  type Posting
} from "./history.js";
import type { CoreDb } from "../context.js";
import { measureBook, windowPeriods } from "./north-book.js";

// docs/19, docs/modules/* — the year of operating history the ledger implies.
//
// `history.ts` writes the money: a year of premium collected, commission earned
// and insurer remitted. That leaves every other screen reading a fortnight of
// fixtures against a book with a past. This writes the rest of the year — the
// contracts those premiums bought, the claims against them, the quotes they came
// from, the campaigns that sourced them, the partner statements that settled
// them — from the *same* deterministic curve, so a policy's premium is the
// premium its PREM-COLLECT collected and no screen contradicts another.
//
// Called alongside `seedHistory`, never inside it: the two report separately and
// either can be re-run on its own.
//
// Every money-affecting row here goes through `postAll` (the one money path in
// the backfill), so the two ledger invariants hold by construction:
//   * each batch balances — asserted in `postAll`, per posting;
//   * client money (1010) never falls below the liability it segregates (2010),
//     because the only postings that touch either move both legs together, and
//     a claim is *funded* into client money before it is paid out of it.
//
// Idempotent and deterministic: no `Math.random()`, no `Date.now()`, every row
// keyed by a natural key that is read back before insert. Row ids are not
// reproducible across runs (`id()` carries a random suffix), so a re-run matches
// on the natural key and remaps its planned ids onto the ids already in the DB.

/** Two contracts a trading day, matching `history.ts`'s two sales. */
const SALES_PER_DAY = 2;
/** An annual motor term and a quarterly one, so the year contains real renewals. */
const TERM_DAYS = [365, 91] as const;

const SIGNAL_SOURCES = ["search", "quotes", "abandonment", "reviews", "news", "regulatory"] as const;
const CLUSTER_THEMES = [
  "EV cover gaps",
  "SME cyber appetite",
  "Domestic worker health",
  "Fleet telematics pricing",
  "Travel medical top-up",
  "Renters contents"
] as const;
const SPEND_CHANNELS = ["search", "social"] as const;
const PARTNERS = ["hist:partner:alpha", "hist:partner:beta"] as const;
const FINANCIER = "hist:financier:crescent";

export interface ModuleHistoryOptions {
  /** How many days back from `now` to write. */
  days: number;
  /** The clock. Never `Date.now()` inside, so a re-run is deterministic. */
  now: number;
  /** Actor for the postings — a finance/ops user id where one is known. */
  postedBy?: string | undefined;
}

export interface ModuleHistoryResult {
  txns: number;
  batches: number;
  periodsCreated: number;
  /** Rows written by this run, keyed by physical table name. All zero on a re-run. */
  rows: Record<string, number>;
}

/* -------------------------------------------------------------- determinism */

/** FNV-ish, deliberately tiny: a stable spread with no random source. */
function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1_000_003;
  return h;
}

function pick<T>(list: readonly T[], key: string): T {
  return list[hashOf(key) % list.length]!;
}

/**
 * A well-mixed number from a key.
 *
 * `hashOf` is a 31-multiply over a short string and stays close to linear in a
 * numeric key — good enough for `% n`, wrong for a sort key and wrong for two
 * axes that must not correlate. Ordering the book by `hashOf` alone banded it by
 * row order, which reads as a perfect block partition rather than as a book.
 * This is the standard 32-bit avalanche finaliser over it: still no random
 * source, still reproducible, but two keys that differ in one character land
 * nowhere near each other.
 */
function scatter(key: string): number {
  let x = hashOf(key) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const dayKeyOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** Mon–Fri. Business-day weighting beats brute volume for a believable chart. */
const isBusinessDay = (at: number): boolean => {
  const d = new Date(at).getUTCDay();
  return d >= 1 && d <= 5;
};

/* ------------------------------------------------------------------- shapes */

interface Refs {
  customers: readonly string[];
  users: readonly string[];
  providers: readonly string[];
  channels: readonly { id: string; kind: string; ppm: number }[];
  offerings: readonly { id: string; productId: string; providerId: string; line: string; ppm: number }[];
}

interface Reserve {
  seq: number;
  amountMinor: number;
  previousMinor: number;
  basis: string;
  confidence: number | null;
  setAt: number;
  txnKey: string;
}

interface ClaimPlan {
  claimNo: string;
  incidentAt: number;
  reportedAt: number;
  approvedAt: number;
  fundAt: number;
  payAt: number;
  closedAt: number;
  notifiedMinor: number;
  settleMinor: number;
  excessMinor: number;
  paidMinor: number;
  status: string;
  paid: boolean;
  reserves: Reserve[];
  payTxnKey: string;
}

interface Instalment {
  seq: number;
  dueAt: number;
  amountMinor: number;
  state: string;
}

interface FinancePlan {
  instalments: Instalment[];
  missedStreak: number;
  state: string;
  feeMinor: number;
  at: number;
  txnKey: string;
}

interface PolicyPlan {
  ref: string;
  dayKey: string;
  dayIndex: number;
  sale: number;
  at: number;
  endAt: number;
  termDays: number;
  policyNo: string;
  customerId: string;
  providerId: string;
  productId: string;
  offeringId: string;
  channelId: string;
  channelKind: string;
  line: string;
  commissionPpm: number;
  premiumMinor: number;
  taxMinor: number;
  grossMinor: number;
  commissionMinor: number;
  status: string;
  lapsedAt: number | null;
  renewedFromRef: string | null;
  renewalSeq: number;
  ownerRef: string;
  claim: ClaimPlan | null;
  finance: FinancePlan | null;
  /** Weekly telemetry instants, empty unless this contract is usage-priced. */
  telemetry: number[];
}

interface Month {
  code: string;
  start: number;
  end: number;
  /** Clamped into the window: campaigns and statements never start before it. */
  from: number;
  to: number;
}

interface Plan {
  policies: PolicyPlan[];
  months: Month[];
  postings: Posting[];
  /** Month codes that carry telemetry, so a usage meter exists for every point. */
  meterMonths: string[];
  spend: { code: string; day: string; ts: number; channel: string; amountMinor: number }[];
}

/* ---------------------------------------------------------------- the plan */

function build(days: number, now: number, refs: Refs, postedBy: string): Plan {
  const first = now - days * DAY;
  const postings: Posting[] = [];
  /** A posting the clock has not reached yet has not happened. */
  const push = (p: Posting): void => {
    if (p.at <= now) postings.push(p);
  };

  const months: Month[] = [];
  for (let start = monthStartOf(first); start <= now; start = nextMonthStart(start)) {
    const end = nextMonthStart(start) - 1;
    months.push({ code: monthCode(start), start, end, from: Math.max(start, first), to: Math.min(end, now) });
  }

  /* ------------------------------------------------- contracts, oldest first */
  const policies: PolicyPlan[] = [];
  const byRef = new Map<string, PolicyPlan>();
  const successorOf = new Set<string>();

  for (let dayIndex = days; dayIndex >= 1; dayIndex--) {
    const midnight = new Date(now - dayIndex * DAY).setUTCHours(0, 0, 0, 0);
    const dayKey = dayKeyOf(midnight);
    for (let sale = 0; sale < SALES_PER_DAY; sale++) {
      const ref = `${dayKey}:${sale}`;
      // The same instant, premium and commission `history.ts` collected: the
      // contract and its money are two views of one event, not two fixtures.
      const at = midnight + (9 + sale * 3) * HOUR;
      const premiumMinor = premiumFor(dayIndex, sale);
      const taxMinor = applyPpm(premiumMinor, 50_000);
      const commissionMinor = applyPpm(premiumMinor, 150_000);
      const termDays = TERM_DAYS[sale]!;
      const offering = pick(refs.offerings, `off:${ref}`);
      const channel = pick(refs.channels, `chan:${ref}`);

      // A quarterly term rolls over from the term that ended today. One in five
      // rollovers is lost, so the predecessor ends `expired` rather than
      // `renewed` and the retention number has something to measure.
      const predRef = sale === 1 ? `${dayKeyOf(midnight - termDays * DAY)}:${sale}` : null;
      const pred = predRef === null ? undefined : byRef.get(predRef);
      const chained = pred !== undefined && hashOf(`renew:${predRef}`) % 5 !== 0;
      if (chained && predRef !== null) successorOf.add(predRef);

      const plan: PolicyPlan = {
        ref,
        dayKey,
        dayIndex,
        sale,
        at,
        endAt: at + termDays * DAY,
        termDays,
        policyNo: `HIST-${dayKey}-${sale}`,
        customerId: chained && pred ? pred.customerId : pick(refs.customers, `cust:${ref}`),
        providerId: offering.providerId,
        productId: offering.productId,
        offeringId: offering.id,
        channelId: channel.id,
        channelKind: channel.kind,
        line: offering.line,
        commissionPpm: offering.ppm > 0 ? offering.ppm : 150_000,
        premiumMinor,
        taxMinor,
        grossMinor: premiumMinor + taxMinor,
        commissionMinor,
        status: "active",
        lapsedAt: null,
        renewedFromRef: chained ? predRef : null,
        renewalSeq: chained && pred ? pred.renewalSeq + 1 : 0,
        ownerRef: pick(refs.users, `own:${ref}`),
        claim: null,
        finance: null,
        telemetry: []
      };
      policies.push(plan);
      byRef.set(ref, plan);
    }
  }

  /* ------------------------------------------------------- the state machine */
  // POLICY_TRANSITIONS (packages/core/src/lifecycle.ts) is the authority: the
  // only hops taken here are active->renewed, active->expired and active->lapsed.
  for (const p of policies) {
    if (successorOf.has(p.ref)) {
      p.status = "renewed";
      continue;
    }
    const lapseAt = p.at + 45 * DAY;
    if (hashOf(`lapse:${p.ref}`) % 23 === 0 && lapseAt < Math.min(now, p.endAt)) {
      p.status = "lapsed";
      p.lapsedAt = lapseAt;
    } else if (p.endAt <= now) {
      p.status = "expired";
    }
  }

  /* ------------------------------- what happened to each contract, and its money */
  const meterMonths = new Set<string>();

  for (const p of policies) {
    if (p.lapsedAt !== null) {
      // ⊘ (docs/19 §4): a state change carrying no money still gets a
      // transaction, so the contract's history is one auditable sequence.
      push({
        type: "LAPSE",
        idempotencyKey: `histmod:lapse:${p.ref}`,
        correlationId: `history:policy:${p.ref}`,
        actorKind: "system",
        actorId: "scheduler",
        grossMinor: 0,
        amounts: {},
        at: p.lapsedAt,
        lines: []
      });
    }

    /* ----------------------------------------------------------------- claims */
    const reportedAt = p.at + 30 * DAY + 6 * HOUR;
    if (hashOf(`claim:${p.ref}`) % 8 === 0 && p.status !== "lapsed" && reportedAt + 2 * HOUR <= now) {
      const claimNo = `HCL-${p.dayKey}-${p.sale}`;
      const notifiedMinor = applyPpm(p.premiumMinor, 1_800_000);
      const settleMinor = applyPpm(p.premiumMinor, 1_400_000);
      const excessMinor = 50_000;
      const paidMinor = settleMinor - excessMinor;
      const r1At = reportedAt + 2 * HOUR;
      const r2At = reportedAt + 5 * DAY;
      const approvedAt = reportedAt + 7 * DAY;
      // Offset off the hour so a claim payment never shares an instant with a
      // premium collection: the invariant walk then has one unambiguous order.
      const fundAt = reportedAt + 8 * DAY + 37 * MINUTE;
      const payAt = fundAt + 2 * HOUR;
      const closedAt = payAt + 3 * DAY;
      const correlationId = `history:claim:${claimNo}`;

      const reserves: Reserve[] = [
        {
          seq: 1,
          amountMinor: notifiedMinor,
          previousMinor: 0,
          basis: "ai_recommended",
          confidence: 55 + (hashOf(`conf:${p.ref}`) % 40),
          setAt: r1At,
          txnKey: `histmod:claim-reserve:${claimNo}:1`
        }
      ];
      if (r2At <= now) {
        reserves.push({
          seq: 2,
          amountMinor: settleMinor,
          previousMinor: notifiedMinor,
          basis: "assessor",
          confidence: null,
          setAt: r2At,
          txnKey: `histmod:claim-reserve:${claimNo}:2`
        });
      }

      // CLAIM_TRANSITIONS: reported -> assessing -> approved -> settled -> closed.
      const status =
        closedAt <= now
          ? "closed"
          : payAt <= now
            ? "settled"
            : approvedAt <= now
              ? "approved"
              : r2At <= now
                ? "assessing"
                : "reported";

      p.claim = {
        claimNo,
        incidentAt: p.at + 30 * DAY,
        reportedAt,
        approvedAt,
        fundAt,
        payAt,
        closedAt,
        notifiedMinor,
        settleMinor,
        excessMinor,
        paidMinor,
        status,
        paid: payAt <= now,
        reserves,
        payTxnKey: `histmod:claim-pay:${claimNo}`
      };

      for (const r of reserves) {
        push({
          type: "CLAIM-RESERVE",
          idempotencyKey: r.txnKey,
          correlationId,
          actorKind: r.basis === "ai_recommended" ? "system" : "user",
          actorId: r.basis === "ai_recommended" ? "reserve-model" : p.ownerRef,
          grossMinor: r.amountMinor,
          amounts: { reserve: r.amountMinor, delta: r.amountMinor - r.previousMinor },
          at: r.setAt,
          lines: []
        });
      }
      push({
        type: "CLAIM-APPROVE",
        idempotencyKey: `histmod:claim-approve:${claimNo}`,
        correlationId,
        actorKind: "user",
        actorId: p.ownerRef,
        grossMinor: settleMinor,
        amounts: { agreed: settleMinor, excess: excessMinor },
        at: approvedAt,
        lines: []
      });
      // The insurer funds the payment into client money *before* it leaves, so
      // 1010 rises before it falls and the client-money floor is never crossed.
      push({
        type: "CLAIM-FUND",
        idempotencyKey: `histmod:claim-fund:${claimNo}`,
        correlationId,
        actorKind: "provider",
        actorId: p.providerId,
        grossMinor: paidMinor,
        amounts: { gross: paidMinor, net: paidMinor, tax: 0 },
        at: fundAt,
        lines: [
          { code: "1010", side: "debit", amountMinor: paidMinor, memo: `Claim float received ${claimNo}` },
          { code: "2010", side: "credit", amountMinor: paidMinor, memo: `Owed to claimant ${claimNo}` }
        ]
      });
      push({
        type: "CLAIM-PAY",
        idempotencyKey: p.claim.payTxnKey,
        correlationId,
        actorKind: "user",
        actorId: p.ownerRef,
        grossMinor: paidMinor,
        amounts: { gross: paidMinor, net: paidMinor, tax: 0 },
        at: payAt,
        lines: [
          { code: "2010", side: "debit", amountMinor: paidMinor, memo: `Claimant settled ${claimNo}` },
          { code: "1010", side: "credit", amountMinor: paidMinor, memo: `Claim paid out ${claimNo}` }
        ]
      });
      push({
        type: "CLAIM-CLOSE",
        idempotencyKey: `histmod:claim-close:${claimNo}`,
        correlationId,
        actorKind: "user",
        actorId: p.ownerRef,
        grossMinor: paidMinor,
        amounts: { paid: paidMinor, recovered: 0 },
        at: closedAt,
        lines: []
      });
    }

    /* ------------------------------------------------- premium finance (docs/19 §9) */
    if (p.termDays === 365 && hashOf(`fin:${p.ref}`) % 11 === 0) {
      const count = 4;
      const per = Math.floor(p.grossMinor / count);
      const instalments: Instalment[] = [];
      let missedStreak = 0;
      for (let i = 0; i < count; i++) {
        const dueAt = p.at + (i + 1) * 30 * DAY;
        const amountMinor = i === count - 1 ? p.grossMinor - per * (count - 1) : per;
        const state = dueAt > now ? "due" : hashOf(`miss:${p.ref}:${i}`) % 7 === 0 ? "missed" : "paid";
        if (state === "missed") missedStreak += 1;
        else if (state === "paid") missedStreak = 0;
        instalments.push({ seq: i + 1, dueAt, amountMinor, state });
      }
      const feeMinor = applyPpm(p.grossMinor, 25_000);
      const at = p.at + HOUR + 41 * MINUTE;
      p.finance = {
        instalments,
        missedStreak,
        state:
          missedStreak >= 2
            ? "defaulted"
            : instalments.every((i) => i.state === "paid")
              ? "completed"
              : "active",
        feeMinor,
        at,
        txnKey: `histmod:fin-cmsn:${p.ref}`
      };
      // Only the arrangement fee touches our book: the financier collected the
      // premium, and `history.ts` already booked that collection in full.
      const taxMinor = applyPpm(feeMinor, 50_000);
      push({
        type: "FIN-CMSN",
        idempotencyKey: p.finance.txnKey,
        correlationId: `history:policy:${p.ref}`,
        actorKind: "system",
        actorId: "scheduler",
        grossMinor: feeMinor,
        amounts: { gross: feeMinor, net: feeMinor - taxMinor, tax: taxMinor },
        at,
        lines: [
          { code: "1150", side: "debit", amountMinor: feeMinor, memo: `Finance fee receivable ${p.ref}` },
          { code: "4080", side: "credit", amountMinor: feeMinor - taxMinor, memo: `Finance fee earned ${p.ref}` },
          { code: "2200", side: "credit", amountMinor: taxMinor, memo: `Output tax on fee ${p.ref}` }
        ]
      });
    }

    /* ----------------------------------- usage-priced contracts (docs/16 H6) */
    if (p.termDays === 365 && hashOf(`ubi:${p.ref}`) % 37 === 0) {
      for (let t = p.at + 7 * DAY; t <= Math.min(p.endAt, now); t += 7 * DAY) {
        p.telemetry.push(t);
        meterMonths.add(monthCode(t));
      }
    }
  }

  // `axis_telemetry_points.txnId` is NOT NULL, so a batch of points needs a
  // transaction to belong to: one ⊘ meter reading a month, not one a point.
  for (const code of [...meterMonths].sort()) {
    const month = months.find((m) => m.code === code);
    if (!month) continue;
    push({
      type: "USAGE-METER",
      idempotencyKey: `histmod:usage-meter:${code}`,
      correlationId: `history:usage:${code}`,
      actorKind: "system",
      actorId: "telemetry-ingest",
      grossMinor: 0,
      amounts: { period: 0 },
      at: month.to,
      lines: []
    });
  }

  /* ----------------------------------------------------------- the marketing */
  const spend: Plan["spend"] = [];
  for (const m of months) {
    let total = 0;
    for (let midnight = monthStartOf(m.from); midnight <= m.to; midnight += DAY) {
      if (midnight < m.from || !isBusinessDay(midnight)) continue;
      for (const channel of SPEND_CHANNELS) {
        const day = dayKeyOf(midnight);
        const amountMinor = 40_000 + (hashOf(`spend:${channel}:${day}`) % 61) * 1_000;
        spend.push({ code: m.code, day, ts: midnight + 23 * HOUR, channel, amountMinor });
        total += amountMinor;
      }
    }
    if (total > 0) {
      const taxMinor = applyPpm(total, 50_000);
      push({
        type: "MEDIA-SPEND",
        idempotencyKey: `histmod:media-spend:${m.code}`,
        correlationId: `history:campaign:${m.code}`,
        actorKind: "system",
        actorId: "signal-autopilot",
        grossMinor: total,
        amounts: { gross: total, net: total - taxMinor, tax: taxMinor },
        at: m.to,
        lines: [
          { code: "5100", side: "debit", amountMinor: total, memo: `Media spend ${m.code}` },
          { code: "2250", side: "credit", amountMinor: total, memo: `Media payable ${m.code}` }
        ]
      });
    }
  }

  /* ------------------------------------------- partner revenue share (docs/19 §10) */
  for (const m of months) {
    const premium = policies
      .filter((p) => p.at >= m.start && p.at <= m.end)
      .reduce((n, p) => n + p.premiumMinor, 0);
    if (premium === 0) continue;
    PARTNERS.forEach((partner, i) => {
      const gross = applyPpm(premium, 60_000 + i * 20_000);
      push({
        type: "RSHARE-ACCR",
        idempotencyKey: `histmod:rshare-accr:${partner}:${m.code}`,
        correlationId: `history:settlement:${partner}:${m.code}`,
        actorKind: "system",
        actorId: "scheduler",
        grossMinor: gross,
        amounts: { gross, net: gross, tax: 0 },
        at: m.to,
        lines: [
          { code: "5400", side: "debit", amountMinor: gross, memo: `Partner share ${partner} ${m.code}` },
          { code: "2100", side: "credit", amountMinor: gross, memo: `Payable to ${partner} ${m.code}` }
        ]
      });
      push({
        type: "RSHARE-SETL",
        idempotencyKey: `histmod:rshare-setl:${partner}:${m.code}`,
        correlationId: `history:settlement:${partner}:${m.code}`,
        actorKind: "user",
        actorId: postedBy,
        grossMinor: gross,
        amounts: { gross, net: gross, tax: 0 },
        at: m.end + 5 * DAY,
        lines: [
          { code: "2100", side: "debit", amountMinor: gross, memo: `Payable cleared ${partner} ${m.code}` },
          { code: "1000", side: "credit", amountMinor: gross, memo: `Paid ${partner} ${m.code}` }
        ]
      });
    });
  }

  return { policies, months, postings, meterMonths: [...meterMonths].sort(), spend };
}

/* ------------------------------------------------------------ the reference data */

/**
 * How many people the year's contracts belong to. The core seed writes exactly
 * one customer — Rania Haddad, the demo's hero — so without a book behind her
 * every one of a year's ~730 contracts, quotes and conversations landed on her.
 * At two sales a trading day this is roughly four contracts a customer over the
 * year, which is what a broker's book actually looks like.
 */
const HISTORY_CUSTOMERS = 180;

const GIVEN = [
  "Rania", "Omar", "Layla", "Yousef", "Mariam", "Khalid", "Noura", "Faisal",
  "Hessa", "Tariq", "Salma", "Bilal", "Dana", "Ahmed", "Reem", "Saeed",
  "Amina", "Nasser", "Huda", "Jamal"
] as const;
const FAMILY = [
  "Haddad", "Al Mansoori", "Nasser", "Al Balushi", "Rahman", "Al Suwaidi",
  "Karim", "Al Blooshi", "Farouk", "Al Zaabi", "Sultan", "Al Hammadi"
] as const;
const BUSINESS = [
  "Trading", "Logistics", "Contracting", "Holdings", "Motors", "Clinic"
] as const;

/** Arabic in one home in four. The row's `locale` and its `language:` tag are
 *  the same draw, so the tag can never contradict the record it sits on. */
const localeOf = (key: string): string => (hashOf(`loc:${key}`) % 4 === 0 ? "ar" : "en");

/* ---------------------------------------------------- targeting attributes */

// The book's targeting attributes, as `axis:value` tags on the axes the
// `insurance-gulf` pack declares (packages/core/src/targeting.ts, ADR-0071).
// `countAttributes` reads exactly this field, so without them SIGNAL's audience
// proposal has no cells to reason over and SCOUT's whitespace radar no segments
// to compare — the seam works and has nothing to work on.
//
// Deliberate, not random. The marginals are a plausible UAE motor book: Dubai
// and Abu Dhabi carry it, the northern emirates are thin. The joint is the
// interesting part — Sharjah is 28 customers with nobody above the middle
// income quintile, which is a real gap for a whitespace to find rather than
// noise. Six cells sit below DEFAULT_K_FLOOR on purpose (four emirates, the
// youngest and oldest age bands) so the floor visibly binds instead of never
// being reached.
//
// No protected axis appears here, by construction: nothing tags nationality,
// residency, gender or religion. See PROTECTED_AXES.

/** Counts sum to HISTORY_CUSTOMERS: the whole book lives somewhere. */
const EMIRATES: readonly (readonly [string, number])[] = [
  ["dubai", 74], ["abu-dhabi", 46], ["sharjah", 28], ["ajman", 12],
  ["ras-al-khaimah", 11], ["fujairah", 6], ["umm-al-quwain", 3]
];

/** Counts sum to the 150 persons. A company has no age band. */
const AGE_BANDS: readonly (readonly [string, number])[] = [
  ["25-34", 48], ["35-44", 52], ["45-54", 29], ["55+", 12], ["18-24", 9]
];

/** How far up the income ranking an emirate carries its residents. Relative
 *  only — `scatter` spans four of these steps, so it is a lean, not a partition. */
const EMIRATE_INCOME: Record<string, number> = {
  "abu-dhabi": 4, dubai: 3, "ras-al-khaimah": 2,
  sharjah: 1, ajman: 1, fujairah: 1, "umm-al-quwain": 1
};
const INCOME_LEAN = 0x4000_0000;

/** Life stages an age band plausibly holds; repeats weight the draw. */
const LIFESTAGE: Record<string, readonly string[]> = {
  "18-24": ["single"],
  "25-34": ["single", "couple", "couple"],
  "35-44": ["couple", "family", "family", "family"],
  "45-54": ["family", "family", "empty-nest"],
  "55+": ["empty-nest"]
};

/** Deal `bands` out over `members` in scattered order, so each value lands on
 *  exactly its stated count. A member past the last band keeps no value. */
function spread(
  axis: string,
  bands: readonly (readonly [string, number])[],
  members: readonly number[]
): Map<number, string> {
  const order = [...members].sort((a, b) => scatter(`${axis}:${a}`) - scatter(`${axis}:${b}`) || a - b);
  const out = new Map<number, string>();
  let at = 0;
  for (const [value, count] of bands)
    for (let n = 0; n < count && at < order.length; n++) out.set(order[at++]!, value);
  return out;
}

/** One tag list per customer index, in row order. */
function attributeTags(): string[][] {
  const all = Array.from({ length: HISTORY_CUSTOMERS }, (_, i) => i);
  const persons = all.filter((i) => !isBusiness(i));
  const region = spread("region", EMIRATES, all);
  const age = spread("ageband", AGE_BANDS, persons);

  // Income quintile is a quintile: exactly a fifth of the book per band, with
  // the emirate lean showing up in the *joint* rather than in the marginal. A
  // skewed "quintile" would be a lie about what the word means.
  const lean = (i: number): number =>
    (EMIRATE_INCOME[region.get(i) ?? ""] ?? 1) * INCOME_LEAN + scatter(`income:${i}`);
  const ranked = [...persons].sort((a, b) => lean(a) - lean(b) || a - b);
  const per = Math.max(1, Math.floor(persons.length / 5));

  const quintile = new Map<number, number>();
  ranked.forEach((i, n) => quintile.set(i, Math.min(5, Math.floor(n / per) + 1)));

  return all.map((i) => {
    const tags = [`language:${localeOf(String(i).padStart(3, "0"))}`];
    const emirate = region.get(i);
    if (emirate) tags.push(`region:${emirate}`);
    // A company has no age band, life stage or household income quintile, and
    // inventing them is exactly what a buyer notices first.
    if (isBusiness(i)) return tags;
    const band = age.get(i);
    if (!band) return tags;
    const stages = LIFESTAGE[band] ?? [];
    tags.push(`ageband:${band}`, `incomequintile:${quintile.get(i) ?? 1}`);
    if (stages.length) tags.push(`lifestage:${stages[scatter(`lifestage:${i}`) % stages.length]!}`);
    return tags;
  });
}

/** Roughly one in six is a company — SME motor fleets and group medical are
 *  half the demo's product lines, and a person cannot hold either. */
const isBusiness = (i: number): boolean => i % 6 === 5;

/**
 * The customers the year's contracts belong to, written once and matched on
 * email thereafter (row ids are not reproducible across runs). A tenant that
 * already has customers keeps them: they join the book rather than replace it.
 */
async function seedCustomers(
  db: CoreDb,
  tenantId: string,
  first: number,
  pid: (prefix: string, key: string) => string,
  remap: Map<string, string>,
  counts: Record<string, number>
): Promise<void> {
  const tags = attributeTags();
  const rows = Array.from({ length: HISTORY_CUSTOMERS }, (_, i) => {
    const key = String(i).padStart(3, "0");
    const business = isBusiness(i);
    const given = GIVEN[hashOf(`given:${key}`) % GIVEN.length]!;
    const family = FAMILY[hashOf(`family:${key}`) % FAMILY.length]!;
    const name = business ? `${family} ${BUSINESS[hashOf(`biz:${key}`) % BUSINESS.length]!}` : `${given} ${family}`;
    return {
      id: pid("cu", key),
      tenantId,
      type: business ? "business" : "person",
      nameJson: JSON.stringify({ en: name }),
      emailsJson: JSON.stringify([`hist.${key}@example.ae`]),
      phonesJson: JSON.stringify([`+9715${String(2_000_000 + hashOf(`tel:${key}`) % 7_999_999)}`]),
      nationalIdHash: null,
      registrationNo: business ? `AE-${100_000 + hashOf(`reg:${key}`) % 899_999}` : null,
      taxId: business ? `TRN${100_000_000_000_000 + hashOf(`trn:${key}`) % 899_999}` : null,
      country: "AE",
      kycStatus: hashOf(`kyc:${key}`) % 17 === 0 ? "pending" : "verified",
      consentId: null,
      tagsJson: JSON.stringify(tags[i]!),
      ltvCached: null,
      riskFlagsJson: null,
      locale: localeOf(key),
      // The book predates the window: these people were customers before the
      // year of history opened, which is why they have a year of history.
      createdAt: first,
      updatedAt: first,
      deletedAt: null
    };
  });
  await insertNew(
    db,
    tenantId,
    schema.customers,
    "core_customers",
    rows,
    sql<string>`json_extract(emails_json, '$[0]')`,
    (r) => JSON.parse(r.emailsJson)[0] as string,
    remap,
    counts
  );
}

/**
 * The spine the history hangs off. Reads what the core seed already wrote and
 * falls back to synthetic refs so the generator also runs against a bare tenant
 * (the invariant tests do exactly that).
 *
 * ponytail: falls back rather than inserting the missing spine — an unseeded
 * tenant gets history whose provider/offering refs point nowhere. Upgrade path:
 * call `seed()` first, which is what the CLI does. Customers are the exception:
 * `seedCustomers` writes those, because one customer is not a book.
 */
async function loadRefs(db: CoreDb, tenantId: string): Promise<Refs> {
  const fill = <T>(got: readonly T[], n: number, make: (i: number) => T): T[] =>
    got.length > 0 ? [...got] : Array.from({ length: n }, (_, i) => make(i));

  const customers = (
    await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.tenantId, tenantId))
      .limit(HISTORY_CUSTOMERS * 2)
  ).map((r) => r.id);
  const users = (
    await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.tenantId, tenantId)).limit(4)
  ).map((r) => `user:${r.id}`);
  const channels = (
    await db
      .select({ id: schema.distChannels.id, kind: schema.distChannels.kind, ppm: schema.distChannels.defaultCommissionPpm })
      .from(schema.distChannels)
      .where(eq(schema.distChannels.tenantId, tenantId))
      .limit(4)
  ).map((r) => ({ id: r.id, kind: r.kind, ppm: r.ppm ?? 0 }));
  const products = await db
    .select({ id: schema.products.id, line: schema.products.line })
    .from(schema.products)
    .where(eq(schema.products.tenantId, tenantId));
  const lineOf = new Map(products.map((p) => [p.id, p.line]));
  // Capped at four: bordereau headers are one per provider per month, and the
  // whole point of the budget is that a year stays inside D1's limits.
  const offerings = (
    await db
      .select({
        id: schema.distOfferings.id,
        productId: schema.distOfferings.productId,
        providerId: schema.distOfferings.providerId,
        ppm: schema.distOfferings.baseCommissionPpm
      })
      .from(schema.distOfferings)
      .where(eq(schema.distOfferings.tenantId, tenantId))
      .limit(4)
  ).map((r) => ({ ...r, line: lineOf.get(r.productId) ?? "motor", ppm: r.ppm }));

  const LINES = ["motor", "health", "travel", "property"];
  const filledOfferings = fill(offerings, 4, (i) => ({
    id: `hist:offering:${i}`,
    productId: `hist:product:${i}`,
    providerId: `hist:provider:${i % 2}`,
    line: LINES[i]!,
    ppm: 150_000
  }));

  return {
    customers: fill(customers, HISTORY_CUSTOMERS, (i) => `hist:customer:${String(i).padStart(3, "0")}`),
    users: fill(users, 3, (i) => `user:hist:staff:${i}`),
    channels: fill(channels, 3, (i) => ({
      id: `hist:channel:${["direct", "broker", "embed"][i]}`,
      kind: i === 0 ? "b2c" : "b2b",
      ppm: i === 0 ? 0 : 300_000
    })),
    offerings: filledOfferings,
    providers: [...new Set(filledOfferings.map((o) => o.providerId))]
  };
}

/* --------------------------------------------------------------- the writer */

/** D1 binds at most 100 parameters per statement; size the chunk off the row. */
function chunkFor(row: Record<string, unknown>): number {
  return Math.max(1, Math.floor(90 / Math.max(1, Object.keys(row).length)));
}

/**
 * Insert the rows whose natural key is not in the table yet, and remember the
 * remap for the ones that were: a re-run's planned ids differ from the ids
 * already stored (`id()` is not reproducible), so every child reference has to
 * be resolved through `remap` before it is written.
 */
async function insertNew<T extends { id: string }>(
  db: CoreDb,
  tenantId: string,
  table: any,
  name: string,
  rows: readonly T[],
  keyCol: ReturnType<typeof sql<string>>,
  keyOf: (row: T) => string,
  remap: Map<string, string>,
  counts: Record<string, number>
): Promise<void> {
  counts[name] = counts[name] ?? 0;
  if (rows.length === 0) return;

  const have = new Map<string, string>();
  for (const row of await db.select({ k: keyCol, id: table.id }).from(table).where(eq(table.tenantId, tenantId))) {
    have.set(row.k, row.id);
  }

  const fresh: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    // A collision inside one run would surface as an opaque UNIQUE failure
    // hundreds of rows later; say which key instead.
    if (seen.has(key)) throw new Error(`seedModuleHistory: duplicate ${name} key ${key}`);
    seen.add(key);
    const existing = have.get(key);
    if (existing !== undefined) {
      if (existing !== row.id) remap.set(row.id, existing);
      continue;
    }
    fresh.push(row);
  }

  await insertChunked((batch) => db.insert(table).values(batch), fresh, chunkFor(fresh[0] ?? rows[0]!));
  counts[name] += fresh.length;
}

export async function seedModuleHistory(
  db: CoreDb,
  tenantId: string,
  options: ModuleHistoryOptions
): Promise<ModuleHistoryResult> {
  const { days, now } = options;
  if (days < 1) throw new Error("seedModuleHistory: days must be at least 1");
  const postedBy = options.postedBy ? `user:${options.postedBy}` : "system:backfill";

  let seq = 0;
  const nid = (prefix: string): string => id(prefix, now + seq++);

  const counts: Record<string, number> = {};
  const remap = new Map<string, string>();
  /** Planned id for a logical entity, stable within a run. */
  const planned = new Map<string, string>();
  const pid = (prefix: string, key: string): string => {
    const k = `${prefix}:${key}`;
    let v = planned.get(k);
    if (v === undefined) {
      v = nid(prefix);
      planned.set(k, v);
    }
    return v;
  };
  /** Resolve a planned id onto whatever is actually in the DB. */
  const R = (planId: string): string => remap.get(planId) ?? planId;

  /* -------------------------------------------------------------- the book */
  // Written before the refs are read, because the refs are what it writes.
  await seedCustomers(db, tenantId, now - days * DAY, pid, remap, counts);
  const refs = await loadRefs(db, tenantId);
  const plan = build(days, now, refs, postedBy);

  /* ------------------------------------------------------------- the money */
  const posted = await postAll(db, tenantId, plan.postings, { now, postedBy, nid });
  // `history.ts` posts the premium and the commission for these same refs in a
  // pass of its own, so its transactions are in the ledger but never in this
  // pass's map. Read them back once: without this every `history:*` lookup
  // below resolved to null and the money links were silently left empty.
  const sibling = new Map<string, string>();
  for (const row of await db
    .select({ id: schema.ledgerTxns.id, key: schema.ledgerTxns.idempotencyKey })
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, tenantId), like(schema.ledgerTxns.idempotencyKey, "history:%")))) {
    sibling.set(row.key, row.id);
  }
  const txn = (key: string): string | null => posted.txnIds.get(key) ?? sibling.get(key) ?? null;

  const claims = plan.policies.filter((p): p is PolicyPlan & { claim: ClaimPlan } => p.claim !== null);
  const financed = plan.policies.filter((p): p is PolicyPlan & { finance: FinancePlan } => p.finance !== null);

  /* ------------------------------------------------------ DIST: the shopping */
  // One converted comparison per contract plus one that did not bind, so bind
  // rate and panel response rate have a denominator.
  const lostRequests = plan.policies.filter((p) => p.sale === 0 && isBusinessDay(p.at));
  const responders = Math.min(3, refs.offerings.length);

  /* --------------------------------------------------- the shops still open */
  // A bound contract's case is finished: it issued. Every queue a human opens —
  // the board's lanes (apps/web/app/routes/axis-board.tsx), the quote desk's
  // OPEN_CASE_STATUSES, the exception queue's STUCK_CASE_STATUSES — reads the
  // states *before* `issued`, so with the whole year issued they were empty.
  // The work in them is the shops that have not bound: recent ones are live,
  // and anything older than the window never bound and was cancelled.
  const OPEN_SHOP_DAYS = 18;
  const PIPELINE = ["intake", "quoting", "awaiting_docs", "review", "approval", "failed"] as const;
  const shopAt = (p: PolicyPlan): number => new Date(p.at).setUTCHours(14, 0, 0, 0);
  const openShops = lostRequests.filter((p) => shopAt(p) >= now - OPEN_SHOP_DAYS * DAY);
  // Oldest first, so a shop open a fortnight sits further down the pipeline
  // than one opened this morning — and every lane gets cards.
  const laneOf = new Map(
    openShops.map((p, i) => [
      p.ref,
      PIPELINE[PIPELINE.length - 1 - Math.floor((i * PIPELINE.length) / openShops.length)]!
    ])
  );

  await insertNew(
    db,
    tenantId,
    schema.distQuoteRequests,
    "dist_quote_requests",
    [
      ...plan.policies.map((p) => ({
        id: pid("qrq", p.ref),
        tenantId,
        caseId: null,
        customerId: p.customerId,
        channelId: p.channelId,
        productId: p.productId,
        inputsJson: JSON.stringify({ histRef: p.ref, line: p.line, sumInsuredMinor: p.premiumMinor * 40 }),
        consentId: null,
        fanoutCount: responders,
        respondedCount: responders,
        bestOfferingId: p.offeringId,
        bestPremiumMinor: p.premiumMinor,
        currency: BASE,
        sharedWithCustomerAt: p.at - HOUR,
        portalTokenHash: null,
        state: "converted",
        expiresAt: p.at + 30 * DAY,
        createdAt: p.at - 2 * HOUR,
        updatedAt: p.at
      })),
      ...lostRequests.map((p) => ({
        id: pid("qrq", `${p.dayKey}:lost`),
        tenantId,
        caseId: null,
        customerId: pick(refs.customers, `lost:${p.dayKey}`),
        channelId: p.channelId,
        productId: p.productId,
        inputsJson: JSON.stringify({ histRef: `${p.dayKey}:lost`, line: p.line }),
        consentId: null,
        fanoutCount: 2,
        respondedCount: 1,
        bestOfferingId: null,
        bestPremiumMinor: null,
        currency: BASE,
        sharedWithCustomerAt: null,
        portalTokenHash: null,
        // A shop whose case is still on the board has not expired yet.
        state: laneOf.has(p.ref) ? "fanned_out" : "expired",
        expiresAt: shopAt(p) + 20 * DAY,
        createdAt: shopAt(p),
        updatedAt: Math.min(now, shopAt(p) + 20 * DAY)
      }))
    ],
    sql<string>`json_extract(inputs_json, '$.histRef')`,
    (r) => JSON.parse(r.inputsJson).histRef as string,
    remap,
    counts
  );

  const responseRows = [
    ...plan.policies.flatMap((p) => {
      const base = refs.offerings.findIndex((o) => o.id === p.offeringId);
      return Array.from({ length: responders }, (_, i) => {
        const offering = refs.offerings[(base + i) % refs.offerings.length]!;
        const premiumMinor = i === 0 ? p.premiumMinor : p.premiumMinor + applyPpm(p.premiumMinor, 80_000 * i);
        const commissionMinor = applyPpm(premiumMinor, offering.ppm > 0 ? offering.ppm : 150_000);
        return {
          id: pid("qrs", `${p.ref}:${i}`),
          tenantId,
          requestId: R(pid("qrq", p.ref)),
          offeringId: offering.id,
          providerId: offering.providerId,
          state: "quoted",
          premiumMinor,
          taxMinor: applyPpm(premiumMinor, 50_000),
          feesMinor: 0,
          currency: BASE,
          commissionPpm: offering.ppm > 0 ? offering.ppm : 150_000,
          commissionMinor,
          channelCommissionMinor: p.channelKind === "b2b" ? applyPpm(commissionMinor, 300_000) : 0,
          coverageJson: JSON.stringify({ excessMinor: 50_000, limitMinor: premiumMinor * 60 }),
          priceRank: i + 1,
          valueScore: 60 + (hashOf(`vs:${p.ref}:${i}`) % 35),
          rationaleKey: i === 0 ? "dist.rationale.best_value" : null,
          declineReason: null,
          latencyMs: 400 + (hashOf(`lat:${p.ref}:${i}`) % 2600),
          validUntil: p.at + 30 * DAY,
          rawRef: null,
          selectedAt: i === 0 ? p.at : null,
          createdAt: p.at - 2 * HOUR + (i + 1) * MINUTE,
          updatedAt: p.at - 2 * HOUR + (i + 1) * MINUTE
        };
      });
    }),
    ...lostRequests.flatMap((p) => {
      const at = new Date(p.at).setUTCHours(14, 0, 0, 0);
      const base = hashOf(`lost:${p.dayKey}`) % refs.offerings.length;
      return Array.from({ length: Math.min(2, refs.offerings.length) }, (_, i) => {
        const offering = refs.offerings[(base + i) % refs.offerings.length]!;
        const quoted = i === 0;
        return {
          id: pid("qrs", `${p.dayKey}:lost:${i}`),
          tenantId,
          requestId: R(pid("qrq", `${p.dayKey}:lost`)),
          offeringId: offering.id,
          providerId: offering.providerId,
          state: quoted ? "quoted" : "timeout",
          premiumMinor: quoted ? p.premiumMinor + applyPpm(p.premiumMinor, 220_000) : null,
          taxMinor: 0,
          feesMinor: 0,
          currency: BASE,
          commissionPpm: null,
          commissionMinor: null,
          channelCommissionMinor: null,
          coverageJson: null,
          priceRank: quoted ? 1 : null,
          valueScore: null,
          rationaleKey: null,
          declineReason: quoted ? null : "no_response_within_sla",
          latencyMs: quoted ? 900 : 30_000,
          validUntil: at + 14 * DAY,
          rawRef: null,
          selectedAt: null,
          createdAt: at + (i + 1) * MINUTE,
          updatedAt: at + (i + 1) * MINUTE
        };
      });
    })
  ];
  await insertNew(
    db,
    tenantId,
    schema.distQuoteResponses,
    "dist_quote_responses",
    responseRows,
    sql<string>`request_id || '|' || offering_id`,
    (r) => `${r.requestId}|${r.offeringId}`,
    remap,
    counts
  );

  /* ---------------------------------------------------------- AXIS: the work */
  await insertNew(
    db,
    tenantId,
    schema.axisCases,
    "axis_cases",
    [
      ...plan.policies.map((p) => ({
        id: pid("cas", p.ref),
        tenantId,
        ref: `HC-${p.dayKey}-${p.sale}`,
        kind: p.renewalSeq > 0 ? "renewal_ops" : "bind",
        customerId: p.customerId,
        productLine: p.line,
        channelId: p.channelId,
        quoteRequestId: R(pid("qrq", p.ref)),
        // It bound a contract, so it reached the end of the machine.
        status: "issued",
        slaDueAt: p.at + DAY,
        ownerRef: p.ownerRef,
        teamId: null,
        priority: "normal",
        source: p.channelKind === "b2c" ? "web" : "partner",
        riskScore: hashOf(`risk:${p.ref}`) % 100,
        valueMinor: p.grossMinor,
        currency: BASE,
        metaJson: null,
        closedAt: p.at,
        createdAt: p.at - 2 * HOUR,
        updatedAt: p.at,
        deletedAt: null
      })),
      ...lostRequests.map((p) => {
        const at = shopAt(p);
        const lane = laneOf.get(p.ref) ?? null;
        return {
          id: pid("cas", `${p.dayKey}:shop`),
          tenantId,
          ref: `HC-${p.dayKey}-shop`,
          // One in five is a group scheme, so the quote desk's ?kind=group_medical
          // bid screen has something to bid on.
          kind: hashOf(`kind:${p.dayKey}`) % 5 === 0 ? "group_medical" : "quote",
          customerId: pick(refs.customers, `lost:${p.dayKey}`),
          productLine: p.line,
          channelId: p.channelId,
          quoteRequestId: R(pid("qrq", `${p.dayKey}:lost`)),
          // Off the board once the shop expired without binding.
          status: lane ?? "cancelled",
          slaDueAt: at + 3 * DAY,
          ownerRef: p.ownerRef,
          teamId: null,
          priority: (["low", "normal", "normal", "high", "urgent"] as const)[hashOf(`pri:${p.dayKey}`) % 5]!,
          source: p.channelKind === "b2c" ? "web" : "partner",
          riskScore: hashOf(`risk:${p.dayKey}:shop`) % 100,
          valueMinor: p.grossMinor,
          currency: BASE,
          metaJson: null,
          closedAt: lane === null ? Math.min(now, at + 20 * DAY) : null,
          createdAt: at,
          updatedAt: lane === null ? Math.min(now, at + 20 * DAY) : at + HOUR,
          deletedAt: null
        };
      })
    ],
    sql<string>`ref`,
    (r) => r.ref,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.axisPolicies,
    "axis_policies",
    plan.policies.map((p) => ({
      id: pid("pol", p.ref),
      tenantId,
      caseId: R(pid("cas", p.ref)),
      customerId: p.customerId,
      providerId: p.providerId,
      productId: p.productId,
      offeringId: p.offeringId,
      channelId: p.channelId,
      policyNo: p.policyNo,
      startAt: p.at,
      endAt: p.endAt,
      premiumMinor: p.premiumMinor,
      currency: BASE,
      commissionMinor: p.commissionMinor,
      docsJson: null,
      escrowBatchId: null,
      paymentPlanJson: null,
      // ponytail: forward pointer written from the planned version id. Correct
      // whenever head and version land together, which is every run that
      // completes; a run killed between the two inserts leaves it dangling.
      // Upgrade path: re-point it in a second pass keyed on (policy, seq).
      currentVersionId: pid("pvr", p.ref),
      versionSeq: 1,
      taxMinor: p.taxMinor,
      feesMinor: 0,
      grossMinor: p.grossMinor,
      renewedFromPolicyId: p.renewedFromRef === null ? null : R(pid("pol", p.renewedFromRef)),
      renewalSeq: p.renewalSeq,
      inceptedAt: p.at,
      lapsedAt: p.lapsedAt,
      cancelledAt: null,
      cancelReasonCode: null,
      cancelEffectiveAt: null,
      statusReason: p.status === "lapsed" ? "non_payment" : null,
      lastTxnId: txn(`history:prem-collect:${p.ref}`),
      status: p.status,
      createdAt: p.at,
      updatedAt: p.lapsedAt ?? (p.endAt <= now ? p.endAt : p.at)
    })),
    sql<string>`provider_id || '|' || policy_no`,
    (r) => `${r.providerId}|${r.policyNo}`,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.axisPolicyVersions,
    "axis_policy_versions",
    plan.policies.map((p) => ({
      id: pid("pvr", p.ref),
      tenantId,
      policyId: R(pid("pol", p.ref)),
      versionSeq: 1,
      endorsementNo: null,
      reason: p.renewalSeq > 0 ? "renewal_rollover" : "issue",
      reasonCode: null,
      effectiveFrom: p.at,
      effectiveTo: p.endAt,
      premiumMinor: p.premiumMinor,
      taxMinor: p.taxMinor,
      feesMinor: 0,
      commissionMinor: p.commissionMinor,
      currency: BASE,
      premiumDeltaMinor: 0,
      proRataDays: p.termDays,
      termsJson: JSON.stringify({ line: p.line, excessMinor: 50_000, limitMinor: p.premiumMinor * 60 }),
      ratingJson: null,
      quoteResponseId: R(pid("qrs", `${p.ref}:0`)),
      txnId: txn(`history:prem-collect:${p.ref}`),
      approvalId: null,
      documentFileId: null,
      deliveredAt: p.at + 30 * MINUTE,
      deliveryRef: null,
      state: "effective",
      issuedBy: postedBy,
      issuedAt: p.at,
      supersededAt: null,
      createdAt: p.at,
      updatedAt: p.at
    })),
    sql<string>`policy_id || '|' || version_seq`,
    (r) => `${r.policyId}|${r.versionSeq}`,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.axisClaims,
    "axis_claims",
    claims.map((p) => ({
      id: pid("clm", p.claim.claimNo),
      tenantId,
      policyId: R(pid("pol", p.ref)),
      customerId: p.customerId,
      caseId: R(pid("cas", p.ref)),
      claimNo: p.claim.claimNo,
      incidentAt: p.claim.incidentAt,
      reportedAt: p.claim.reportedAt,
      amountMinor: p.claim.notifiedMinor,
      settledMinor: p.claim.paid ? p.claim.settleMinor : null,
      currency: BASE,
      status: p.claim.status,
      fnolJson: JSON.stringify({ peril: "collision", reportedVia: "orbit" }),
      assessorRef: null,
      policyVersionId: R(pid("pvr", p.ref)),
      coverageState: "in_force",
      coverageCheckedAt: p.claim.reportedAt + HOUR,
      coverageJson: JSON.stringify({ excessMinor: p.claim.excessMinor }),
      perilCode: "collision",
      causeCode: "third_party",
      catCode: null,
      reserveMinor: p.claim.reserves[p.claim.reserves.length - 1]!.amountMinor,
      paidMinor: p.claim.paid ? p.claim.paidMinor : 0,
      recoveredMinor: 0,
      excessMinor: p.claim.excessMinor,
      handlerRef: p.ownerRef,
      slaDueAt: p.claim.reportedAt + 10 * DAY,
      fraudScore: hashOf(`fraud:${p.claim.claimNo}`) % 45,
      siuState: null,
      complexity: p.claim.settleMinor > 250_000 ? "complex" : "standard",
      reopenedAt: null,
      closedAt: p.claim.status === "closed" ? p.claim.closedAt : null,
      lastTxnId: txn(p.claim.payTxnKey),
      createdAt: p.claim.reportedAt,
      updatedAt: p.claim.status === "closed" ? p.claim.closedAt : p.claim.reportedAt
    })),
    sql<string>`claim_no`,
    (r) => r.claimNo,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.axisClaimReserves,
    "axis_claim_reserves",
    claims.flatMap((p) =>
      p.claim.reserves.map((r) => ({
        id: pid("crs", `${p.claim.claimNo}:${r.seq}`),
        tenantId,
        claimId: R(pid("clm", p.claim.claimNo)),
        seq: r.seq,
        head: "indemnity",
        amountMinor: r.amountMinor,
        previousMinor: r.previousMinor,
        deltaMinor: r.amountMinor - r.previousMinor,
        currency: BASE,
        basis: r.basis,
        rationale: r.basis === "ai_recommended" ? "Comparable collision claims on this cover" : "Assessor report",
        evidenceJson: null,
        confidence: r.confidence,
        aiAuditId: r.basis === "ai_recommended" ? R(pid("aia", `reserve:${p.claim.claimNo}`)) : null,
        approvalId: null,
        txnId: txn(r.txnKey),
        setBy: r.basis === "ai_recommended" ? "agent:reserve" : p.ownerRef,
        setAt: r.setAt,
        createdAt: r.setAt
      }))
    ),
    sql<string>`claim_id || '|' || head || '|' || seq`,
    (r) => `${r.claimId}|${r.head}|${r.seq}`,
    remap,
    counts
  );

  const paidClaims = claims.filter((p) => p.claim.paid && txn(p.claim.payTxnKey) !== null);
  await insertNew(
    db,
    tenantId,
    schema.axisClaimPayments,
    "axis_claim_payments",
    paidClaims.map((p) => ({
      id: pid("cpy", p.claim.claimNo),
      tenantId,
      claimId: R(pid("clm", p.claim.claimNo)),
      kind: "final",
      payeeKind: "claimant",
      payeeRef: p.customerId,
      payeeSealed: null,
      amountMinor: p.claim.paidMinor,
      currency: BASE,
      method: "eft",
      txnId: txn(p.claim.payTxnKey)!,
      approvalId: R(pid("apr", `claim:${p.claim.claimNo}`)),
      state: "paid",
      failureCode: null,
      requestedBy: p.ownerRef,
      requestedAt: p.claim.fundAt,
      paidAt: p.claim.payAt,
      createdAt: p.claim.fundAt,
      updatedAt: p.claim.payAt
    })),
    sql<string>`txn_id`,
    (r) => r.txnId,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.distCommissionEntries,
    "dist_commission_entries",
    plan.policies.map((p) => {
      const channelCommissionMinor = p.channelKind === "b2b" ? applyPpm(p.commissionMinor, 300_000) : 0;
      const taxMinor = applyPpm(p.commissionMinor, 50_000);
      return {
        id: pid("cme", p.ref),
        tenantId,
        policyId: R(pid("pol", p.ref)),
        offeringId: p.offeringId,
        providerId: p.providerId,
        channelId: p.channelId,
        rateId: null,
        kind: p.renewalSeq > 0 ? "renewal" : "new_business",
        premiumMinor: p.premiumMinor,
        grossCommissionMinor: p.commissionMinor,
        channelCommissionMinor,
        netCommissionMinor: p.commissionMinor - channelCommissionMinor - taxMinor,
        taxMinor,
        currency: BASE,
        earnedOn: "issue",
        earnedAt: p.at,
        reversalOf: null,
        providerSettlementId: null,
        channelSettlementId: null,
        txnId: txn(`history:cmsn-accr:${p.ref}`),
        // `history.ts` accrues the commission and never collects it, so the
        // entry says accrued: the ledger and the statement agree.
        state: "accrued",
        createdAt: p.at,
        updatedAt: p.at
      };
    }),
    sql<string>`policy_id || '|' || kind`,
    (r) => `${r.policyId}|${r.kind}`,
    remap,
    counts
  );

  /* ------------------------------------------------------ LEDGER: the plans */
  await insertNew(
    db,
    tenantId,
    schema.ledgerPaymentPlans,
    "ledger_payment_plans",
    financed.map((p) => ({
      id: pid("pln", p.ref),
      tenantId,
      subjectRef: R(pid("pol", p.ref)),
      financierRef: FINANCIER,
      totalMinor: p.grossMinor,
      currency: BASE,
      instalments: p.finance.instalments.length,
      scheduleJson: JSON.stringify(p.finance.instalments),
      state: p.finance.state,
      missedStreak: p.finance.missedStreak,
      createdAt: p.finance.at,
      updatedAt: Math.min(now, p.finance.instalments[p.finance.instalments.length - 1]!.dueAt)
    })),
    sql<string>`subject_ref`,
    (r) => r.subjectRef,
    remap,
    counts
  );

  const settlementRows = plan.months.flatMap((m) =>
    PARTNERS.flatMap((partner) => {
      const accr = txn(`histmod:rshare-accr:${partner}:${m.code}`);
      if (accr === null) return [];
      const setl = txn(`histmod:rshare-setl:${partner}:${m.code}`);
      const gross = plan.postings.find((p) => p.idempotencyKey === `histmod:rshare-accr:${partner}:${m.code}`)!.grossMinor;
      return [
        {
          id: pid("stl", `${partner}:${m.code}`),
          tenantId,
          counterpartyKind: "partner",
          counterpartyRef: partner,
          period: m.code,
          grossMinor: gross,
          adjustmentsMinor: 0,
          netMinor: gross,
          currency: BASE,
          statementFileId: null,
          state: setl === null ? "approved" : "paid",
          disputeReason: null,
          externalRef: setl === null ? null : `BANK-${m.code}-${partner.slice(-5)}`,
          paidVia: setl === null ? null : "bank_transfer",
          approvedBy: postedBy,
          txnId: setl ?? accr,
          createdAt: m.to,
          updatedAt: setl === null ? m.to : m.end + 5 * DAY
        }
      ];
    })
  );
  await insertNew(
    db,
    tenantId,
    schema.ledgerSettlements,
    "ledger_settlements",
    settlementRows,
    sql<string>`counterparty_kind || '|' || counterparty_ref || '|' || period`,
    (r) => `${r.counterpartyKind}|${r.counterpartyRef}|${r.period}`,
    remap,
    counts
  );

  /* --------------------------------------------------- AXIS: the bordereaux */
  const bordereaux = plan.months.flatMap((m) =>
    refs.providers.flatMap((providerId) => {
      const rows = plan.policies.filter((p) => p.providerId === providerId && p.at >= m.start && p.at <= m.end);
      if (rows.length === 0) return [];
      const closed = m.end <= now;
      return [
        {
          key: `${providerId}|${m.code}`,
          rows,
          row: {
            id: pid("bdx", `${providerId}:${m.code}`),
            tenantId,
            direction: "outbound",
            counterpartyKind: "provider",
            counterpartyId: providerId,
            kind: "premium",
            period: m.code,
            currency: BASE,
            lineCount: rows.length,
            grossPremiumMinor: rows.reduce((n, p) => n + p.grossMinor, 0),
            commissionMinor: rows.reduce((n, p) => n + p.commissionMinor, 0),
            claimsPaidMinor: 0,
            reserveMinor: 0,
            varianceMinor: 0,
            state: closed ? "closed" : "generated",
            fileId: null,
            sourceFileId: null,
            escrowBatchId: null,
            generatedBy: postedBy,
            generatedAt: m.to,
            closedAt: closed ? m.end + 5 * DAY : null,
            createdAt: m.to,
            updatedAt: closed ? m.end + 5 * DAY : m.to
          }
        }
      ];
    })
  );
  await insertNew(
    db,
    tenantId,
    schema.axisBordereaux,
    "axis_bordereaux",
    bordereaux.map((b) => b.row),
    sql<string>`direction || '|' || counterparty_id || '|' || kind || '|' || period`,
    (r) => `${r.direction}|${r.counterpartyId}|${r.kind}|${r.period}`,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.axisBordereauLines,
    "axis_bordereau_lines",
    bordereaux.flatMap((b) =>
      b.rows.map((p, i) => ({
        id: pid("bdl", `${b.key}:${i}`),
        tenantId,
        bordereauId: R(b.row.id),
        lineNo: i + 1,
        policyId: R(pid("pol", p.ref)),
        policyVersionId: R(pid("pvr", p.ref)),
        claimId: null,
        externalRef: null,
        riskRef: p.policyNo,
        effectiveFrom: p.at,
        effectiveTo: p.endAt,
        grossPremiumMinor: p.grossMinor,
        taxMinor: p.taxMinor,
        netPremiumMinor: p.premiumMinor,
        commissionMinor: p.commissionMinor,
        claimsPaidMinor: 0,
        reserveMinor: 0,
        currency: BASE,
        matchState: "matched",
        varianceMinor: 0,
        rawJson: null,
        createdAt: b.row.createdAt,
        updatedAt: b.row.updatedAt
      }))
    ),
    sql<string>`bordereau_id || '|' || line_no`,
    (r) => `${r.bordereauId}|${r.lineNo}`,
    remap,
    counts
  );

  /* --------------------------------------------------- AXIS: usage telemetry */
  await insertNew(
    db,
    tenantId,
    schema.axisTelemetryPoints,
    "axis_telemetry_points",
    plan.policies.flatMap((p) =>
      p.telemetry.flatMap((at) => {
        const txnId = txn(`histmod:usage-meter:${monthCode(at)}`);
        if (txnId === null) return [];
        return [
          {
            id: pid("tlp", `${p.ref}:${at}`),
            tenantId,
            subjectRef: `policy:${R(pid("pol", p.ref))}`,
            source: "telematics:obd:score",
            at,
            value: 62 + (hashOf(`ubi:${p.ref}:${at}`) % 33),
            txnId,
            createdAt: at
          }
        ];
      })
    ),
    sql<string>`subject_ref || '|' || source || '|' || at`,
    (r) => `${r.subjectRef}|${r.source}|${r.at}`,
    remap,
    counts
  );

  // Built before the clusters so each cluster can be written with the number of
  // signals that will actually point at it. `size` is the cell the k-anonymity
  // floor measures (apps/api/src/engines/scout-whitespace.ts `cellSize`), so a
  // cluster seeded at 0 suppresses every whitespace hanging off it.
  const signalsPerTheme = new Map<string, number>();
  const signalRows: {
    id: string;
    tenantId: string;
    source: string;
    sourceRef: string;
    payloadJson: string;
    embeddingRef: null;
    clusterId: string;
    weight: number;
    observedAt: number;
    createdAt: number;
  }[] = [];
  for (let dayIndex = days; dayIndex >= 1; dayIndex--) {
    const midnight = new Date(now - dayIndex * DAY).setUTCHours(0, 0, 0, 0);
    if (!isBusinessDay(midnight)) continue;
    const dayKey = dayKeyOf(midnight);
    for (let i = 0; i < 2; i++) {
      const sourceRef = `hist:signal:${dayKey}:${i}`;
      const theme = pick(CLUSTER_THEMES, sourceRef);
      signalsPerTheme.set(theme, (signalsPerTheme.get(theme) ?? 0) + 1);
      signalRows.push({
        id: pid("sig", sourceRef),
        tenantId,
        source: pick(SIGNAL_SOURCES, sourceRef),
        sourceRef,
        payloadJson: JSON.stringify({ term: theme, volume: 40 + (hashOf(sourceRef) % 900) }),
        embeddingRef: null,
        clusterId: R(pid("scl", theme)),
        weight: 1 + (hashOf(`w:${sourceRef}`) % 4),
        observedAt: midnight + (10 + i * 5) * HOUR,
        createdAt: midnight + (10 + i * 5) * HOUR
      });
    }
  }
  /* -------------------------------------------------------- SCOUT: the radar */
  await insertNew(
    db,
    tenantId,
    schema.scoutClusters,
    "scout_clusters",
    CLUSTER_THEMES.map((theme, i) => ({
      id: pid("scl", theme),
      tenantId,
      theme,
      summary: `${theme}: demand visible in ${SIGNAL_SOURCES[i % SIGNAL_SOURCES.length]} signals across the year.`,
      momentumScore: 30 + (hashOf(`mom:${theme}`) % 65),
      size: signalsPerTheme.get(theme) ?? 0,
      firstSeen: now - days * DAY,
      lastSeen: now,
      trailJson: JSON.stringify(
        plan.months.map((m) => ({ period: m.code, score: 20 + (hashOf(`trail:${theme}:${m.code}`) % 75) }))
      ),
      updatedAt: now
    })),
    sql<string>`theme`,
    (r) => r.theme,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.scoutSignals,
    "scout_signals",
    signalRows,
    sql<string>`source_ref`,
    (r) => r.sourceRef,
    remap,
    counts
  );

  const WHITESPACE_STATES = ["candidate", "validating", "validated", "parked"];
  await insertNew(
    db,
    tenantId,
    schema.scoutWhitespaces,
    "scout_whitespaces",
    plan.months.map((m, i) => {
      const theme = CLUSTER_THEMES[i % CLUSTER_THEMES.length]!;
      const status = WHITESPACE_STATES[i % WHITESPACE_STATES.length]!;
      return {
        id: pid("wsp", m.code),
        tenantId,
        description: `${theme} — unserved segment surfaced in ${m.code}`,
        category: refs.offerings[i % refs.offerings.length]!.line,
        clusterId: R(pid("scl", theme)),
        evidenceRefsJson: JSON.stringify([`hist:signal:${dayKeyOf(m.from)}:0`]),
        demandEstimate: 200 + (hashOf(`dem:${m.code}`) % 1800),
        competitionScore: hashOf(`comp:${m.code}`) % 100,
        status,
        owner: pick(refs.users, `wsp:${m.code}`),
        promotedAt: status === "validated" ? m.from + 12 * DAY : null,
        createdAt: m.from + 3 * DAY,
        updatedAt: Math.min(now, m.from + 20 * DAY)
      };
    }),
    sql<string>`description`,
    (r) => r.description,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.scoutPanelBench,
    "scout_panel_bench",
    plan.months.flatMap((m) =>
      refs.providers.map((providerId) => {
        const sold = plan.policies.filter((p) => p.providerId === providerId && p.at >= m.start && p.at <= m.end);
        return {
          id: pid("pnb", `${providerId}:${m.code}`),
          tenantId,
          providerId,
          line: "motor",
          period: m.code,
          ourPriceIdx: 9_400 + (hashOf(`opi:${providerId}:${m.code}`) % 1_200),
          marketPriceIdx: 10_000,
          winRate: 20 + (hashOf(`win:${providerId}:${m.code}`) % 60),
          volume: sold.length,
          coverageGapsJson: null,
          updatedAt: m.to
        };
      })
    ),
    sql<string>`provider_id || '|' || line || '|' || period`,
    (r) => `${r.providerId}|${r.line}|${r.period}`,
    remap,
    counts
  );

  /* ------------------------------------------------------ SIGNAL: the market */
  const OBJECTIVES = ["acq", "renewal", "xsell"];
  await insertNew(
    db,
    tenantId,
    schema.signalCampaigns,
    "signal_campaigns",
    plan.months.map((m, i) => ({
      id: pid("cmp", m.code),
      tenantId,
      name: `History ${m.code}`,
      objective: OBJECTIVES[i % OBJECTIVES.length]!,
      audienceId: null,
      channelsJson: JSON.stringify([...SPEND_CHANNELS]),
      budgetJson: JSON.stringify({ capMinor: 2_500_000, currency: BASE }),
      state: m.end <= now ? "ended" : "live",
      guardrailChecksJson: JSON.stringify([{ name: "compliance_review", ok: true }]),
      autonomyLevel: "act_with_approval",
      startAt: m.from,
      endAt: m.end,
      ownerRef: pick(refs.users, `cmp:${m.code}`),
      createdAt: m.from,
      updatedAt: m.to,
      deletedAt: null
    })),
    sql<string>`name`,
    (r) => r.name,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.signalCreatives,
    "signal_creatives",
    plan.months.flatMap((m) =>
      [0, 1].map((i) => ({
        id: pid("crv", `${m.code}:${i}`),
        tenantId,
        campaignId: R(pid("cmp", m.code)),
        kind: i === 0 ? "ad" : "email",
        locale: "en",
        contentRef: `hist:creative:${m.code}:${i}`,
        variantGroup: `hist:${m.code}`,
        complianceStatus: "passed",
        complianceNotesJson: null,
        performanceJson: JSON.stringify({ ctr: 90 + (hashOf(`ctr:${m.code}:${i}`) % 400) }),
        generatedBy: i === 0 ? "ai" : "human",
        aiAuditId: i === 0 ? R(pid("aia", `creative:${m.code}`)) : null,
        createdAt: m.from + i * HOUR,
        updatedAt: m.from + i * HOUR
      }))
    ),
    sql<string>`content_ref`,
    (r) => r.contentRef,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.signalSpend,
    "signal_spend",
    plan.spend.map((s) => ({
      id: pid("spd", `${s.code}:${s.channel}:${s.day}`),
      tenantId,
      campaignId: R(pid("cmp", s.code)),
      channel: s.channel,
      day: s.day,
      amountMinor: s.amountMinor,
      currency: BASE,
      impressions: s.amountMinor * 4,
      clicks: Math.floor(s.amountMinor / 900),
      conversions: Math.floor(s.amountMinor / 42_000),
      source: "api",
      ts: s.ts
    })),
    sql<string>`campaign_id || '|' || channel || '|' || day`,
    (r) => `${r.campaignId}|${r.channel}|${r.day}`,
    remap,
    counts
  );

  /* ----------------------------------------------------- ORBIT: the customer */
  await insertNew(
    db,
    tenantId,
    schema.orbitRenewals,
    "orbit_renewals",
    plan.policies
      .filter((p) => p.termDays === 91)
      .map((p) => {
        const offeredAt = p.endAt - 30 * DAY;
        const state =
          p.status === "renewed" ? "accepted" : p.status === "expired" ? "lost" : offeredAt <= now ? "offered" : "scheduled";
        return {
          id: pid("rnw", p.ref),
          tenantId,
          policyRef: R(pid("pol", p.ref)),
          customerId: p.customerId,
          expiryAt: p.endAt,
          churnScore: hashOf(`churn:${p.ref}`) % 100,
          strategy: hashOf(`strat:${p.ref}`) % 3 === 0 ? "human" : "auto_requote",
          requotesJson: null,
          state,
          outcomeReason: state === "lost" ? "price" : null,
          ownerRef: p.ownerRef,
          offeredAt: offeredAt <= now ? offeredAt : null,
          decidedAt: p.endAt <= now ? p.endAt : null,
          createdAt: Math.min(now, p.endAt - 45 * DAY),
          updatedAt: Math.min(now, p.endAt)
        };
      }),
    sql<string>`policy_ref || '|' || expiry_at`,
    (r) => `${r.policyRef}|${r.expiryAt}`,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.orbitConversations,
    "orbit_conversations",
    claims.map((p) => ({
      id: pid("cnv", p.claim.claimNo),
      tenantId,
      customerId: p.customerId,
      channel: "whatsapp",
      externalRef: `hist:conv:${p.claim.claimNo}`,
      connectorId: null,
      doId: null,
      state: "closed",
      assigneeRef: p.ownerRef,
      teamId: null,
      csat: 3 + (hashOf(`csat:${p.claim.claimNo}`) % 3),
      summary: `Claim ${p.claim.claimNo} status enquiry, resolved.`,
      lang: "en",
      intent: "claim_status",
      sentiment: -20 + (hashOf(`sent:${p.claim.claimNo}`) % 90),
      firstResponseMs: 20_000 + (hashOf(`frt:${p.claim.claimNo}`) % 400_000),
      lastMessageAt: p.claim.reportedAt + 2 * HOUR,
      closedAt: p.claim.reportedAt + 3 * HOUR,
      priority: 2,
      slaPolicyKey: null,
      requireSkillsJson: null,
      queuedAt: p.claim.reportedAt,
      assignedAt: p.claim.reportedAt + 20 * MINUTE,
      firstResponseDueAt: p.claim.reportedAt + HOUR,
      resolutionDueAt: p.claim.reportedAt + DAY,
      frtBreachedAt: null,
      resolutionBreachedAt: null,
      reopenCount: 0,
      createdAt: p.claim.reportedAt,
      updatedAt: p.claim.reportedAt + 3 * HOUR
    })),
    sql<string>`external_ref`,
    (r) => r.externalRef,
    remap,
    counts
  );

  await insertNew(
    db,
    tenantId,
    schema.orbitMessages,
    "orbit_messages",
    claims.flatMap((p) =>
      [0, 1].map((i) => ({
        id: pid("msg", `${p.claim.claimNo}:${i}`),
        tenantId,
        conversationId: R(pid("cnv", p.claim.claimNo)),
        role: i === 0 ? "customer" : "agent_ai",
        modality: "text",
        content:
          i === 0
            ? `Any update on ${p.claim.claimNo}?`
            : `Your claim ${p.claim.claimNo} is with the assessor. We will confirm the agreed amount.`,
        attachmentsJson: null,
        redactionsJson: null,
        aiAuditId: null,
        deliveryStatus: "delivered",
        externalRef: `hist:msg:${p.claim.claimNo}:${i}`,
        ts: p.claim.reportedAt + (i + 1) * 30 * MINUTE
      }))
    ),
    sql<string>`external_ref`,
    (r) => r.externalRef,
    remap,
    counts
  );

  /* ------------------------------------------------------ CORE: the approvals */
  // docs/19 §6 / CLAUDE.md rule 4: a claim payment, a live campaign and a
  // finance arrangement are consequential, so each carries a decided approval.
  const approvalRows = [
    ...paidClaims.map((p) => ({
      id: pid("apr", `claim:${p.claim.claimNo}`),
      tenantId,
      subjectRef: `claim:${p.claim.claimNo}`,
      policyKey: "axis.claim.pay",
      module: "axis",
      requestedBy: p.ownerRef,
      requestedAt: p.claim.fundAt - HOUR,
      decidedBy: pick(refs.users, `dec:${p.claim.claimNo}`),
      decision: "approved",
      reason: null,
      contextJson: JSON.stringify({ amountMinor: p.claim.paidMinor, currency: BASE }),
      decidedAt: p.claim.fundAt,
      delegationId: null
    })),
    ...plan.months.map((m) => ({
      id: pid("apr", `campaign:${m.code}`),
      tenantId,
      subjectRef: `campaign:History ${m.code}`,
      policyKey: "signal.campaign.launch",
      module: "signal",
      requestedBy: pick(refs.users, `cmp:${m.code}`),
      requestedAt: m.from - HOUR,
      decidedBy: pick(refs.users, `dec:cmp:${m.code}`),
      decision: "approved",
      reason: null,
      contextJson: JSON.stringify({ capMinor: 2_500_000, currency: BASE }),
      decidedAt: m.from,
      delegationId: null
    })),
    ...financed.map((p) => ({
      id: pid("apr", `plan:${p.ref}`),
      tenantId,
      subjectRef: `plan:${p.policyNo}`,
      policyKey: "ledger.payment_plan.open",
      module: "ledger",
      requestedBy: p.ownerRef,
      requestedAt: p.finance.at - HOUR,
      decidedBy: pick(refs.users, `dec:plan:${p.ref}`),
      decision: "approved",
      reason: null,
      contextJson: JSON.stringify({ totalMinor: p.grossMinor, instalments: p.finance.instalments.length }),
      decidedAt: p.finance.at,
      delegationId: null
    })),
    ...settlementRows.map((s) => ({
      id: pid("apr", `settlement:${s.counterpartyRef}:${s.period}`),
      tenantId,
      subjectRef: `settlement:${s.counterpartyRef}:${s.period}`,
      policyKey: "ledger.settlement.pay",
      module: "ledger",
      requestedBy: "system:backfill",
      requestedAt: s.createdAt,
      decidedBy: postedBy,
      decision: "approved",
      reason: null,
      contextJson: JSON.stringify({ netMinor: s.netMinor, currency: BASE }),
      decidedAt: s.createdAt + HOUR,
      delegationId: null
    }))
  ];
  await insertNew(
    db,
    tenantId,
    schema.approvals,
    "core_approvals",
    approvalRows,
    sql<string>`subject_ref || '|' || policy_key`,
    (r) => `${r.subjectRef}|${r.policyKey}`,
    remap,
    counts
  );

  /* ------------------------------------------------------------ the AI spine */
  const aiRows = [
    // The nightly NORTH briefing: the one AI run that happens every single day.
    ...Array.from({ length: days }, (_, i) => {
      const midnight = new Date(now - (days - i) * DAY).setUTCHours(0, 0, 0, 0);
      const dayKey = dayKeyOf(midnight);
      return {
        id: pid("aia", `briefing:${dayKey}`),
        tenantId,
        module: "north",
        purpose: "briefing",
        model: "@cf/meta/llama-3.1-8b-instruct",
        provider: "workers-ai",
        tier: "standard",
        inputHash: `hist:north:${dayKey}`,
        outputHash: null,
        tokensIn: 1_800 + (hashOf(`ti:${dayKey}`) % 900),
        tokensOut: 320 + (hashOf(`to:${dayKey}`) % 260),
        costMicro: 400 + (hashOf(`cm:${dayKey}`) % 900),
        latencyMs: 1_200 + (hashOf(`lm:${dayKey}`) % 2_400),
        toolCallsJson: null,
        guardrailFlagsJson: null,
        actorRef: "system:scheduler",
        subjectRef: `briefing:${dayKey}`,
        outcome: "ok",
        ts: midnight + 5 * HOUR
      };
    }),
    ...claims.map((p) => ({
      id: pid("aia", `reserve:${p.claim.claimNo}`),
      tenantId,
      module: "axis",
      purpose: "claim_reserve",
      model: "claude-sonnet-4",
      provider: "anthropic",
      tier: "reasoning",
      inputHash: `hist:reserve:${p.claim.claimNo}`,
      outputHash: null,
      tokensIn: 2_400 + (hashOf(`ri:${p.claim.claimNo}`) % 1_500),
      tokensOut: 400 + (hashOf(`ro:${p.claim.claimNo}`) % 300),
      costMicro: 3_000 + (hashOf(`rc:${p.claim.claimNo}`) % 4_000),
      latencyMs: 2_000 + (hashOf(`rl:${p.claim.claimNo}`) % 3_000),
      toolCallsJson: JSON.stringify([{ name: "axis.comparable_claims", ok: true }]),
      guardrailFlagsJson: null,
      actorRef: "agent:reserve",
      subjectRef: `claim:${p.claim.claimNo}`,
      outcome: "ok",
      ts: p.claim.reportedAt + 90 * MINUTE
    })),
    ...plan.months.map((m) => ({
      id: pid("aia", `creative:${m.code}`),
      tenantId,
      module: "signal",
      purpose: "creative_draft",
      model: "claude-sonnet-4",
      provider: "anthropic",
      tier: "standard",
      inputHash: `hist:creative:${m.code}`,
      outputHash: null,
      tokensIn: 900 + (hashOf(`ci:${m.code}`) % 600),
      tokensOut: 700 + (hashOf(`co:${m.code}`) % 500),
      costMicro: 1_500 + (hashOf(`cc:${m.code}`) % 2_000),
      latencyMs: 1_800 + (hashOf(`cl:${m.code}`) % 2_000),
      toolCallsJson: null,
      guardrailFlagsJson: JSON.stringify([{ name: "no_regulated_claim", ok: true }]),
      actorRef: "agent:creative",
      subjectRef: `campaign:History ${m.code}`,
      outcome: "ok",
      ts: m.from
    }))
  ];
  await insertNew(
    db,
    tenantId,
    schema.aiAuditLog,
    "ai_audit_log",
    aiRows,
    sql<string>`purpose || '|' || coalesce(subject_ref, '') || '|' || ts`,
    (r) => `${r.purpose}|${r.subjectRef ?? ""}|${r.ts}`,
    remap,
    counts
  );

  /* ---------------------------------------------------------- the audit trail */
  // Chain hashes are written blank and computed by the re-chain pass below:
  // the chain is ordered by (ts, id), and a year of back-dated rows lands
  // *before* the tip the core seed left, so every hash after them changes.
  const auditRows = [
    ...plan.policies.map((p) => ({
      id: pid("aud", `bind:${p.ref}`),
      tenantId,
      actorRef: p.ownerRef,
      action: "axis.policy.bind",
      subjectRef: `policy:${p.policyNo}`,
      beforeHash: null,
      afterHash: null,
      prevHash: null,
      chainHash: "",
      ip: null,
      ua: null,
      ts: p.at
    })),
    ...plan.policies
      .filter((p) => p.lapsedAt !== null)
      .map((p) => ({
        id: pid("aud", `lapse:${p.ref}`),
        tenantId,
        actorRef: "system:scheduler",
        action: "axis.policy.lapse",
        subjectRef: `policy:${p.policyNo}`,
        beforeHash: null,
        afterHash: null,
        prevHash: null,
        chainHash: "",
        ip: null,
        ua: null,
        ts: p.lapsedAt!
      })),
    ...paidClaims.map((p) => ({
      id: pid("aud", `claimpay:${p.claim.claimNo}`),
      tenantId,
      actorRef: p.ownerRef,
      action: "axis.claim.pay",
      subjectRef: `claim:${p.claim.claimNo}`,
      beforeHash: null,
      afterHash: null,
      prevHash: null,
      chainHash: "",
      ip: null,
      ua: null,
      ts: p.claim.payAt
    })),
    ...plan.months.map((m) => ({
      id: pid("aud", `campaign:${m.code}`),
      tenantId,
      actorRef: pick(refs.users, `cmp:${m.code}`),
      action: "signal.campaign.launch",
      subjectRef: `campaign:History ${m.code}`,
      beforeHash: null,
      afterHash: null,
      prevHash: null,
      chainHash: "",
      ip: null,
      ua: null,
      ts: m.from
    })),
    ...settlementRows.map((s) => ({
      id: pid("aud", `settlement:${s.counterpartyRef}:${s.period}`),
      tenantId,
      actorRef: postedBy,
      action: "ledger.settlement.pay",
      subjectRef: `settlement:${s.counterpartyRef}:${s.period}`,
      beforeHash: null,
      afterHash: null,
      prevHash: null,
      chainHash: "",
      ip: null,
      ua: null,
      ts: s.updatedAt
    }))
  ];
  await insertNew(
    db,
    tenantId,
    schema.auditLog,
    "core_audit_log",
    auditRows,
    sql<string>`action || '|' || coalesce(subject_ref, '') || '|' || ts`,
    (r) => `${r.action}|${r.subjectRef ?? ""}|${r.ts}`,
    remap,
    counts
  );
  counts["core_audit_log_rechained"] = await rechainAudit(db, tenantId);

  // NORTH's row-backed metrics, measured again now the contracts exist: the
  // ledger pass measured the same window before there was a policy to count,
  // and a core-seeded month this window overlaps was measured over the core
  // book alone (seed/north-book.ts).
  const book = await measureBook(db, tenantId, windowPeriods(days, now), {
    currency: BASE,
    nid,
    insert: (rows) => insertChunked((chunk) => db.insert(schema.northSnapshots).values(chunk), rows, 8)
  });
  counts["north_snapshots"] = book.written;

  return {
    txns: posted.txns,
    batches: posted.batches,
    periodsCreated: posted.periodsCreated,
    rows: counts
  };
}

/**
 * Recompute the tenant's hash chain in `(ts, id)` order — the order `chainFor`
 * reads and `verifyChain` checks.
 *
 * Back-dating into an append-only chain is the one thing it is not built for:
 * the rows are still append-only in the product, but a *backfill* inserts a year
 * before the existing tip, and every `prev_hash` after the insertion point is
 * then wrong. Rather than leaving a chain the daily R2 anchor would report as
 * broken (apps/api/src/engines/anchor.ts), the pass rewrites the links. It only
 * writes rows whose hash actually changes, so a second run updates nothing.
 */
async function rechainAudit(db: CoreDb, tenantId: string): Promise<number> {
  const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
  rows.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let prevHash: string | null = null;
  let rewritten = 0;
  for (const row of rows) {
    const chainHash = await computeChainHash({ ...row, prevHash });
    if (row.prevHash !== prevHash || row.chainHash !== chainHash) {
      await db.update(schema.auditLog).set({ prevHash, chainHash }).where(eq(schema.auditLog.id, row.id));
      rewritten += 1;
    }
    prevHash = chainHash;
  }
  return rewritten;
}
