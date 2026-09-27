// docs/30 Ledger 5, ADR-0105. The pure half of inbound bordereau
// reconciliation: the lines a counterparty sent us against the records we
// hold for the same period, with no database and no clock.
//
// The rules, each one tested in bordereau-match.test.ts:
// - Lines group by (reference, currency). A reference is compared trimmed and
//   case-insensitively; it is reported in the spelling first seen (theirs if
//   they sent it). Currency is part of the key, so nothing is ever summed or
//   compared across currencies: the same reference in AED on their side and
//   USD on ours is two discrepancies, each true in its own currency.
// - Both sides are summed within a group before comparing. A policy may carry
//   an original line and an endorsement line on either side; the sums are what
//   must agree. A reference they listed more than once is flagged `duplicate`
//   so a match on sums never hides it, and a line sent twice by mistake reads
//   as double what we hold — a variance, not a match.
// - `matched`: every compared field agrees within the tolerance. `variance`:
//   both sides hold the reference and some field does not. `missing_ours`:
//   only they hold it. `missing_theirs`: only we do.
// - `toleranceMinor` (default 0) is an absolute allowance in the group's own
//   currency's minor units, applied per field to the summed group — it exists
//   for rounding between two systems' per-line tax arithmetic, not as a
//   materiality threshold. It never turns a missing line into a match, and the
//   true delta is always reported whether or not it was absorbed.
// - `varianceMinor` is theirs less ours on the kind's primary field (gross
//   premium, or claims paid for a claims bordereau); a missing side counts as
//   zero, so missing_ours is +theirs and missing_theirs is −ours.

export type AmountField = "grossPremiumMinor" | "commissionMinor" | "claimsPaidMinor" | "reserveMinor";
export type MatchState = "matched" | "variance" | "missing_ours" | "missing_theirs";

/** Which amounts each bordereau kind compares, the primary one first. */
export const FIELDS_BY_KIND: Record<"premium" | "claims" | "combined", AmountField[]> = {
  premium: ["grossPremiumMinor", "commissionMinor"],
  claims: ["claimsPaidMinor", "reserveMinor"],
  combined: ["grossPremiumMinor", "commissionMinor", "claimsPaidMinor", "reserveMinor"]
};

export interface MatchLine {
  /** Their bordereau line id, or our record id (a commission entry, a claim). */
  id: string;
  ref: string;
  currency: string;
  amounts: Partial<Record<AmountField, number>>;
}

export interface MatchSide {
  ids: string[];
  amounts: Partial<Record<AmountField, number>>;
}

export interface MatchGroup {
  ref: string;
  currency: string;
  state: MatchState;
  theirs: MatchSide;
  ours: MatchSide;
  deltas: Partial<Record<AmountField, number>>;
  varianceMinor: number;
  duplicate: boolean;
}

export interface CurrencyTotal {
  currency: string;
  matched: number;
  variance: number;
  missingOurs: number;
  missingTheirs: number;
  theirsMinor: number;
  oursMinor: number;
  varianceMinor: number;
}

export interface MatchOptions {
  fields: AmountField[];
  toleranceMinor?: number;
}

interface Bucket {
  ref: string;
  currency: string;
  theirs: MatchLine[];
  ours: MatchLine[];
}

const normalise = (ref: string) => ref.trim().toUpperCase();

function side(lines: MatchLine[], fields: AmountField[]): MatchSide {
  const amounts: Partial<Record<AmountField, number>> = {};
  for (const field of fields) amounts[field] = lines.reduce((sum, line) => sum + (line.amounts[field] ?? 0), 0);
  return { ids: lines.map((line) => line.id), amounts };
}

export function matchBordereau(theirs: MatchLine[], ours: MatchLine[], options: MatchOptions): { groups: MatchGroup[]; totals: CurrencyTotal[] } {
  const tolerance = options.toleranceMinor ?? 0;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new RangeError("tolerance must be a whole number of minor units, zero or more");
  const { fields } = options;
  const primary = fields[0]!;

  const buckets = new Map<string, Bucket>();
  const bucket = (line: MatchLine) => {
    const key = `${normalise(line.ref)}\u0000${line.currency}`;
    let found = buckets.get(key);
    if (!found) {
      found = { ref: line.ref.trim(), currency: line.currency, theirs: [], ours: [] };
      buckets.set(key, found);
    }
    return found;
  };
  for (const line of theirs) bucket(line).theirs.push(line);
  for (const line of ours) bucket(line).ours.push(line);

  const keys = [...buckets.keys()].sort();
  const groups: MatchGroup[] = keys.map((key) => {
    const b = buckets.get(key)!;
    const t = side(b.theirs, fields);
    const o = side(b.ours, fields);
    const deltas: Partial<Record<AmountField, number>> = {};
    for (const field of fields) deltas[field] = (t.amounts[field] ?? 0) - (o.amounts[field] ?? 0);
    const state: MatchState =
      b.ours.length === 0
        ? "missing_ours"
        : b.theirs.length === 0
          ? "missing_theirs"
          : fields.every((field) => Math.abs(deltas[field] ?? 0) <= tolerance)
            ? "matched"
            : "variance";
    return {
      ref: b.ref,
      currency: b.currency,
      state,
      theirs: t,
      ours: o,
      deltas,
      varianceMinor: deltas[primary] ?? 0,
      duplicate: b.theirs.length > 1
    };
  });

  const totals = new Map<string, CurrencyTotal>();
  for (const group of groups) {
    const total = totals.get(group.currency) ?? {
      currency: group.currency,
      matched: 0,
      variance: 0,
      missingOurs: 0,
      missingTheirs: 0,
      theirsMinor: 0,
      oursMinor: 0,
      varianceMinor: 0
    };
    if (group.state === "matched") total.matched++;
    else if (group.state === "variance") total.variance++;
    else if (group.state === "missing_ours") total.missingOurs++;
    else total.missingTheirs++;
    total.theirsMinor += group.theirs.amounts[primary] ?? 0;
    total.oursMinor += group.ours.amounts[primary] ?? 0;
    total.varianceMinor += group.varianceMinor;
    totals.set(group.currency, total);
  }

  return { groups, totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}
