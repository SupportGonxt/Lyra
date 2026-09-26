// docs/30 SIGNAL gap 3: an audience rule as rows instead of hand-typed JSON.
// It offers exactly the leaves outreach resolves (apps/api/src/engines/
// signal-outreach.ts audienceRuleProblem, ADR-0091) and posts the same JSON;
// a stored rule it cannot show stays in the JSON view, untouched.

export const RULE_ROWS = 4;

export const RULE_WHAT = ["tag", "reason", "score"] as const;
export type RuleWhat = (typeof RULE_WHAT)[number];
export const RULE_REASONS = ["quote_expired", "no_policy"] as const;

export interface RuleRow {
  what: RuleWhat | "";
  value: string;
}

const LEAF: Record<RuleWhat, { field: string; op: string }> = {
  tag: { field: "tagsJson", op: "contains" },
  reason: { field: "prospect.reason", op: "eq" },
  score: { field: "prospect.score", op: "gte" }
};

/** The rows a stored rule shows as, or null when it holds anything the builder cannot. */
export function ruleRows(stored: unknown): { join: "all" | "any"; rows: RuleRow[] } | null {
  let def = stored;
  if (def === undefined || def === null || def === "") return { join: "all", rows: pad([]) };
  if (typeof def === "string") {
    try {
      def = JSON.parse(def) as unknown;
    } catch {
      return null;
    }
  }
  const o = def as { all?: unknown; any?: unknown };
  const join = Array.isArray(o.any) ? "any" : "all";
  const leaves = (join === "any" ? o.any : o.all) as unknown;
  if (!Array.isArray(leaves) || leaves.length > RULE_ROWS) return null;
  const rows: RuleRow[] = [];
  for (const leaf of leaves as { field?: unknown; op?: unknown; value?: unknown }[]) {
    const what = RULE_WHAT.find((w) => LEAF[w].field === leaf?.field && LEAF[w].op === leaf?.op);
    if (!what) return null;
    rows.push({ what, value: String(leaf.value ?? "") });
  }
  return { join, rows: pad(rows) };
}

function pad(rows: RuleRow[]): RuleRow[] {
  return [...rows, ...Array.from({ length: RULE_ROWS - rows.length }, () => ({ what: "" as const, value: "" }))];
}

/** The rule the builder's rows describe; null when no row was filled. */
export function ruleFromForm(form: FormData, name: string): Record<string, unknown> | null {
  const leaves: { field: string; op: string; value: string | number }[] = [];
  for (let i = 0; i < RULE_ROWS; i++) {
    const what = String(form.get(`${name}.${i}.what`) ?? "") as RuleWhat | "";
    const value = String(form.get(`${name}.${i}.value`) ?? "").trim();
    if (!what || !value || !(what in LEAF)) continue;
    leaves.push({ ...LEAF[what], value: what === "score" ? Number(value) : value });
  }
  if (!leaves.length) return null;
  return { [form.get(`${name}.join`) === "any" ? "any" : "all"]: leaves };
}
