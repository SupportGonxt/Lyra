// docs/modules/axis.md §2.2: "Census normaliser: any-format employee lists →
// canonical census with age-banding, salary bands, dependents; diff view against
// prior year."
//
// Nothing implemented it. A group scheme could be *bound* (`BIND-GROUP`) and
// `group_medical` was a case kind, but there was no canonical census: no column
// detection, no banding, and therefore nothing to diff a renewal against.
//
// Three decisions shape everything below.
//
// **An age is meaningless without a date.** A scheme renews on a date and prices
// the lives as they are *then*, so `age` alone is accepted only alongside an
// `asOf`, and a date of birth is preferred because it can be re-aged against any
// renewal date. A census silently aged at import time would be wrong at the next
// renewal and nobody would know why.
//
// **A band is declared here, not inferred from the data.** If bands came from the
// file, last year's and this year's would band differently and every life would
// appear to have moved.
//
// **A row that cannot be read is named, never dropped.** The bordereaux importer
// set that precedent ("every bad line named"): a census quietly one life short is
// a scheme priced on the wrong number of people.

/** One band: the inclusive upper bound and the word a reader sees. */
export interface CensusBand {
  readonly max: number;
  /** What the band is called in a prompt, a schedule or a screen. */
  readonly key: string;
}

/** Ages, as a group-medical scheme tiers them. The last band is open-ended. */
export const AGE_BANDS: readonly CensusBand[] = [
  { max: 17, key: "0-17" },
  { max: 29, key: "18-29" },
  { max: 39, key: "30-39" },
  { max: 49, key: "40-49" },
  { max: 59, key: "50-59" },
  { max: 64, key: "60-64" },
  { max: Number.POSITIVE_INFINITY, key: "65+" }
];

/** Annual salary tiers, in **minor units** — the units every amount here uses. */
export const SALARY_BANDS: readonly CensusBand[] = [
  { max: 5_000_00, key: "under-5k" },
  { max: 15_000_00, key: "5k-15k" },
  { max: 30_000_00, key: "15k-30k" },
  { max: 60_000_00, key: "30k-60k" },
  { max: Number.POSITIVE_INFINITY, key: "60k+" }
];

/** Which band a number falls in. Null when it is below the first band's floor. */
export function bandOf(bands: readonly CensusBand[], value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  for (const band of bands) if (value <= band.max) return band.key;
  return null;
}

/* ------------------------------------------------------------- the columns */

/**
 * What each canonical field is called in the wild.
 *
 * Matched case- and separator-insensitively, so `Date of Birth`, `date_of_birth`
 * and `DOB` are one thing. The lists stay short on purpose: a fuzzy match that
 * guesses wrong is worse than a named refusal, because a misread `salary` column
 * silently bands every life into the wrong tier.
 */
const ALIASES: Record<CensusField, readonly string[]> = {
  memberRef: ["memberref", "memberid", "employeeno", "employeenumber", "staffno", "staffid", "id", "ref"],
  name: ["name", "fullname", "membername", "employeename", "employee", "staffname"],
  dateOfBirth: ["dateofbirth", "dob", "birthdate", "birthday"],
  age: ["age", "ageyears", "years"],
  salary: ["salary", "annualsalary", "basicsalary", "grosssalary", "ctc", "annualpackage", "package"],
  dependents: ["dependents", "dependants", "dependentscount", "dependantscount", "numberofdependents", "noofdependents", "family", "familysize"],
  relationship: ["relationship", "relation", "membertype", "type", "category"]
};

export type CensusField = "memberRef" | "name" | "dateOfBirth" | "age" | "salary" | "dependents" | "relationship";

/** Header → canonical field, for the columns this file actually has. */
export type CensusMapping = Partial<Record<CensusField, string>>;

const fold = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess the mapping from a header row.
 *
 * A field matched twice is left **unmapped** rather than assigned to whichever
 * came first: two columns that both look like a salary is exactly the file where
 * guessing produces a plausible wrong answer.
 */
export function detectColumns(headers: readonly string[]): { mapping: CensusMapping; ambiguous: CensusField[] } {
  const mapping: CensusMapping = {};
  const ambiguous: CensusField[] = [];
  const claimed = new Set<string>();

  for (const [field, aliases] of Object.entries(ALIASES) as [CensusField, readonly string[]][]) {
    const matches = headers.filter((header) => aliases.includes(fold(header)));
    if (matches.length === 1) {
      mapping[field] = matches[0]!;
      claimed.add(matches[0]!);
    } else if (matches.length > 1) {
      ambiguous.push(field);
    }
  }
  // A header claimed by one field cannot also serve another (an explicit mapping
  // is checked by the caller; this keeps detection from contradicting itself).
  for (const field of Object.keys(mapping) as CensusField[]) {
    if (claimed.has(mapping[field]!) === false) delete mapping[field];
  }
  return { mapping, ambiguous };
}

/* ------------------------------------------------------------- the census */

export interface CensusMember {
  /** Stable across years: the explicit reference, else the name folded. */
  readonly memberRef: string;
  readonly name: string;
  /** Age at `asOf`. Null when the row gave neither an age nor a usable date. */
  readonly age: number | null;
  readonly ageBand: string | null;
  /** Annual salary in minor units. Null when the column was absent or blank. */
  readonly salaryMinor: number | null;
  readonly salaryBand: string | null;
  readonly dependents: number;
  readonly relationship: string | null;
}

export interface CensusProblem {
  /** 1-based, counting the header as row 1 — what a spreadsheet shows. */
  readonly row: number;
  readonly reason: string;
}

export interface Census {
  readonly asOf: number;
  readonly members: readonly CensusMember[];
  /** Every row that could not be read, named. Never silently dropped. */
  readonly problems: readonly CensusProblem[];
  readonly mapping: CensusMapping;
}

export interface CensusOptions {
  /** The date the ages are taken at — a renewal date, in practice. */
  asOf: number;
  /** Overrides for `detectColumns`, for a file whose headers are unusual. */
  mapping?: CensusMapping;
  /** Set when the table has no header row and the caller knows the order. */
  headerless?: boolean;
}

const MS_PER_YEAR = 365.2425 * 86_400_000;

/** Whole years between a date of birth and the date the census is taken at. */
export function ageAt(dateOfBirth: number, asOf: number): number {
  return Math.floor((asOf - dateOfBirth) / MS_PER_YEAR);
}

const intOf = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const text = raw.trim().replace(/[,\s]/g, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : null;
};

/**
 * A salary written the many ways a payroll export writes one.
 *
 * A bare number is **major units** — `12000` in a salary column is twelve
 * thousand, not twelve thousand fils — because that is what a spreadsheet holds.
 * A value with a currency marker or a decimal is read the same way and then
 * scaled, and anything that still looks like minor units has to say so.
 */
export function salaryMinorOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim().replace(/[,\s]/g, "").replace(/^(aed|usd|sar|egp)/i, "");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function dateOf(raw: string | undefined): number | null {
  if (raw === undefined || !raw.trim()) return null;
  const text = raw.trim();
  // ISO first, then the day-first form the region writes, then anything the
  // engine will take. A date parsed by a locale guess is a wrong age.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) return Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Any-format employee list → a canonical census.
 *
 * Rows are positional: `rows[0]` is the header unless `headerless` is set and the
 * caller supplied a mapping. Every refusal carries the row number a reader can
 * find in their spreadsheet.
 */
export function normaliseCensus(rows: readonly (readonly string[])[], opts: CensusOptions): Census {
  const problems: CensusProblem[] = [];
  if (!rows.length) return { asOf: opts.asOf, members: [], problems: [{ row: 0, reason: "the list is empty" }], mapping: {} };

  const headers = opts.headerless ? [] : rows[0]!.map((h) => String(h ?? ""));
  const body = opts.headerless ? rows : rows.slice(1);
  const detected = opts.headerless ? { mapping: {}, ambiguous: [] as CensusField[] } : detectColumns(headers);
  const mapping: CensusMapping = { ...detected.mapping, ...(opts.mapping ?? {}) };

  for (const field of detected.ambiguous) {
    // Named, not guessed: two salary columns is a file a human must resolve.
    if (!(field in (opts.mapping ?? {}))) problems.push({ row: 1, reason: `two columns look like \`${field}\`; name the right one` });
  }
  if (!mapping.name && !mapping.memberRef) {
    return { asOf: opts.asOf, members: [], problems: [...problems, { row: 1, reason: "no column looks like a name or a member reference" }], mapping };
  }

  const at = (row: readonly string[], field: CensusField): string | undefined => {
    const column = mapping[field];
    if (column === undefined) return undefined;
    const index = headers.indexOf(column);
    return index >= 0 ? row[index] : undefined;
  };

  const members: CensusMember[] = [];
  const seen = new Map<string, number>();
  body.forEach((row, index) => {
    const rowNumber = index + (opts.headerless ? 1 : 2);
    if (row.every((cell) => !String(cell ?? "").trim())) return; // a blank line is not a member

    const name = String(at(row, "name") ?? "").trim();
    const ref = String(at(row, "memberRef") ?? "").trim();
    if (!name && !ref) {
      problems.push({ row: rowNumber, reason: "no name and no member reference" });
      return;
    }
    const memberRef = ref || name.toLowerCase().replace(/\s+/g, " ");
    // A duplicate reference would diff against itself next year and show one
    // life as both added and removed.
    const duplicate = seen.get(memberRef);
    if (duplicate !== undefined) {
      problems.push({ row: rowNumber, reason: `member reference \`${memberRef}\` already used on row ${duplicate}` });
      return;
    }
    seen.set(memberRef, rowNumber);

    // An age is preferred from a date of birth, because it can be re-aged at the
    // next renewal; a bare `age` is only trusted with the census's own date.
    const born = dateOf(at(row, "dateOfBirth"));
    const stated = intOf(at(row, "age"));
    let age: number | null = null;
    if (born !== null) age = ageAt(born, opts.asOf);
    else if (stated !== null) age = stated;
    if (age !== null && (age < 0 || age > 120)) {
      problems.push({ row: rowNumber, reason: `age ${age} is not a person` });
      return;
    }

    const salaryMinor = salaryMinorOf(at(row, "salary"));
    const dependents = intOf(at(row, "dependents"));
    if (dependents !== null && (dependents < 0 || dependents > 30)) {
      problems.push({ row: rowNumber, reason: `${dependents} dependents is not a household` });
      return;
    }

    members.push({
      memberRef,
      name: name || ref,
      age,
      ageBand: age === null ? null : bandOf(AGE_BANDS, age),
      salaryMinor,
      salaryBand: salaryMinor === null ? null : bandOf(SALARY_BANDS, salaryMinor),
      dependents: dependents ?? 0,
      relationship: String(at(row, "relationship") ?? "").trim() || null
    });
  });

  return { asOf: opts.asOf, members, problems, mapping };
}

/* -------------------------------------------------------------- the roll-up */

export interface CensusRollup {
  readonly lives: number;
  /** Members per age band, in `AGE_BANDS` order. Absent bands are present at 0. */
  readonly byAgeBand: Record<string, number>;
  readonly bySalaryBand: Record<string, number>;
  readonly dependents: number;
  /** Mean dependents per member, to one decimal. Null for an empty census. */
  readonly averageDependents: number | null;
  /** Members with neither an age nor a salary — a row a scheme cannot price. */
  readonly unpriced: number;
}

export function rollupCensus(census: Census): CensusRollup {
  const byAgeBand: Record<string, number> = {};
  const bySalaryBand: Record<string, number> = {};
  for (const band of AGE_BANDS) byAgeBand[band.key] = 0;
  for (const band of SALARY_BANDS) bySalaryBand[band.key] = 0;

  let dependents = 0;
  let unpriced = 0;
  for (const member of census.members) {
    if (member.ageBand) byAgeBand[member.ageBand] = (byAgeBand[member.ageBand] ?? 0) + 1;
    if (member.salaryBand) bySalaryBand[member.salaryBand] = (bySalaryBand[member.salaryBand] ?? 0) + 1;
    dependents += member.dependents;
    if (member.ageBand === null || member.salaryBand === null) unpriced += 1;
  }
  const lives = census.members.length;
  return {
    lives,
    byAgeBand,
    bySalaryBand,
    dependents,
    averageDependents: lives ? Math.round((dependents / lives) * 10) / 10 : null,
    unpriced
  };
}

/* ----------------------------------------------------------------- the diff */

export interface CensusDiff {
  readonly added: readonly CensusMember[];
  readonly removed: readonly CensusMember[];
  /** Lives whose age or salary band moved between the two censuses. */
  readonly moved: readonly { readonly memberRef: string; readonly name: string; readonly from: string; readonly to: string; readonly what: "age" | "salary" }[];
  readonly dependentsChanged: readonly { readonly memberRef: string; readonly name: string; readonly from: number; readonly to: number }[];
  /** Lives in both, unchanged in every banded dimension. */
  readonly unchanged: number;
}

/**
 * This year's census against last year's.
 *
 * A band change is reported as **movement**, not as a removal and an addition: a
 * member who aged from 39 to 40 is the same person and a scheme reading the diff
 * has to see them that way, or every birthday looks like churn.
 */
export function diffCensus(prior: Census, current: Census): CensusDiff {
  const before = new Map(prior.members.map((member) => [member.memberRef, member]));
  const after = new Map(current.members.map((member) => [member.memberRef, member]));

  const added = current.members.filter((member) => !before.has(member.memberRef));
  const removed = prior.members.filter((member) => !after.has(member.memberRef));
  const moved: CensusDiff["moved"][number][] = [];
  const dependentsChanged: CensusDiff["dependentsChanged"][number][] = [];
  let unchanged = 0;

  for (const member of current.members) {
    const was = before.get(member.memberRef);
    if (!was) continue;
    if (was.ageBand !== member.ageBand) {
      moved.push({ memberRef: member.memberRef, name: member.name, from: was.ageBand ?? "unknown", to: member.ageBand ?? "unknown", what: "age" });
    }
    if (was.salaryBand !== member.salaryBand) {
      moved.push({ memberRef: member.memberRef, name: member.name, from: was.salaryBand ?? "unknown", to: member.salaryBand ?? "unknown", what: "salary" });
    }
    if (was.dependents !== member.dependents) {
      dependentsChanged.push({ memberRef: member.memberRef, name: member.name, from: was.dependents, to: member.dependents });
    }
    if (was.ageBand === member.ageBand && was.salaryBand === member.salaryBand && was.dependents === member.dependents) unchanged += 1;
  }

  return { added, removed, moved, dependentsChanged, unchanged };
}
