import { verifyGroundedness } from "./narrator-verify.js";
// docs/modules/signal.md §2.1/§8 Compliance Pre-flight (CLAUDE.md rule 11's
// inspectable "why"): every generated creative gets checked before it can be
// marked review-ready. Pure and DB-free like momentum.ts/narrator-verify.ts so
// both apps/api's signal-creative engine and this package's own eval harness
// (packages/model-gateway/evals/signal) score the identical function.

export interface ComplianceFinding {
  rule: "comparison_claim_requires_source" | "no_guarantee_of_cover" | DisclosureReason;
  excerpt: string;
  note: string;
}

export interface ComplianceResult {
  status: "passed" | "flagged";
  findings: ComplianceFinding[];
}

const BANNED_CLAIMS: Array<{ re: RegExp; rule: ComplianceFinding["rule"]; note: string }> = [
  {
    rule: "comparison_claim_requires_source",
    re: /\b(cheapest|lowest price|best in the uae|best in the market)\b/i,
    note: "A superlative against the whole market needs a source (panel size, published pricing) or it must be dropped."
  },
  {
    rule: "no_guarantee_of_cover",
    re: /\b(guaranteed?|100% accepted|always accepted)\b/i,
    note: "Acceptance is the underwriter's decision, not ours. Never publishable in this form."
  },
  // ar (docs/27 F46). SIGNAL publishes Arabic creative — the seed's own
  // offerings carry `nameAr` — and this pre-flight read none of it, so an
  // Arabic superlative reached review-ready with a `passed` badge on it.
  //
  // Separate entries rather than an alternation bolted onto the English ones,
  // because `\b` cannot be reused: JS word boundaries are ASCII-defined, and an
  // Arabic word has none. The `note` stays in English on purpose — it is the
  // reviewer-facing "why" (docs/15 §4), and the reviewer reads it in the shell
  // catalogue's language, not the creative's.
  {
    rule: "comparison_claim_requires_source",
    re: /الأرخص|الأقل\s+سعرًا|الأفضل\s+في\s+(?:السوق|الإمارات|المنطقة)|رقم\s+١\s+في\s+السوق/,
    note: "A superlative against the whole market needs a source (panel size, published pricing) or it must be dropped."
  },
  {
    rule: "no_guarantee_of_cover",
    re: /مضمون(?:ة|ًا)?|قبول\s+(?:مضمون|مؤكد)|(?:١٠٠|100)\s*٪?%?\s*(?:قبول|مقبول)|قبول\s+(?:١٠٠|100)\s*[٪%]|نقبل\s+الجميع/,
    note: "Acceptance is the underwriter's decision, not ours. Never publishable in this form."
  }
];

/** The inspectable "why" behind a creative's compliance badge — the ✦ marker's
 *  rationale for this artifact (docs/15 rule 11), same shape as the seed's real
 *  `complianceNotesJson.findings`. Runs after generation, never blocks it. */
export function checkCompliance(text: string): ComplianceResult {
  const findings: ComplianceFinding[] = [];
  for (const b of BANNED_CLAIMS) {
    const m = text.match(b.re);
    if (m) findings.push({ rule: b.rule, excerpt: m[0], note: b.note });
  }
  return findings.length ? { status: "flagged", findings } : { status: "passed", findings: [] };
}

/**
 * The gate a personal acquisition draft passes before it can be queued
 * (ADR-0091, evals/outreach-draft): every number it states — a date, a price, a
 * percentage — must be in the evidence it was written from, and it must pass the
 * same pre-flight every creative does. Either failing drops the draft.
 */
export function checkOutreachDraft(text: string, evidenceLines: string[]): { ok: boolean; why: string | null } {
  const grounded = verifyGroundedness(text, evidenceLines);
  if (!grounded.ok) return { ok: false, why: `states ${grounded.mismatches.join(", ")}, which the evidence does not` };
  const compliance = checkCompliance(text);
  if (compliance.status === "flagged") return { ok: false, why: compliance.findings[0]!.note };
  return { ok: true, why: null };
}

/* ------------------------------------------------ mandatory disclosures */

// docs/17 SIG-013 / SIG-015, ADR-0108. A product line's mandatory disclosure is
// the tenant's own wording (compliance_disclosure_wordings) — never ours; this
// only decides whether it is present, verbatim. The lane is deliberately a
// function of the text and the configured wording alone: it takes no policy,
// no autonomy level and no module setting, so no tenant configuration can turn
// it off (SIG-015). What a tenant configures is *what* must appear, not
// *whether* the check runs.

export type DisclosureReason = "disclosure_missing" | "disclosure_unconfigured" | "disclosure_unscoped";

/** One active tenant wording for a (product line, locale). */
export interface MandatoryDisclosure {
  id: string;
  version: number;
  key: string;
  productLine: string;
  locale: string;
  wording: string;
}

export interface DisclosureScope {
  /** The creative's product line; null for a creative nobody scoped. */
  productLine: string | null;
  /** The active wording for that line in the creative's locale, if any. */
  disclosure: MandatoryDisclosure | null;
  /** Whether the tenant has configured any mandatory disclosure at all. */
  tenantConfigured: boolean;
}

export interface DisclosureRef {
  id: string;
  version: number;
  key: string;
}

export interface DisclosureVerdict {
  lane: "clear" | "hard_block" | "soft_flag";
  reason: DisclosureReason | null;
  disclosure: DisclosureRef | null;
}

const DISCLOSURE_NOTES: Record<DisclosureReason, string> = {
  disclosure_missing:
    "The product line's mandatory disclosure is not in the copy verbatim. Hard block: restore the wording exactly as configured.",
  disclosure_unconfigured:
    "No mandatory disclosure is configured for this product line in this language. A compliance reviewer must affirm none is required.",
  disclosure_unscoped:
    "The creative names no product line, so no disclosure can be matched to it. A compliance reviewer must decide which applies."
};

const refOf = (d: MandatoryDisclosure): DisclosureRef => ({ id: d.id, version: d.version, key: d.key });

/** Appends the wording after the copy, once. Deterministic and post-generation,
 *  so no prompt changes and nothing a model writes can drop it. */
export function appendDisclosure(text: string, disclosure: MandatoryDisclosure | null): string {
  if (!disclosure || text.includes(disclosure.wording)) return text;
  return `${text}\n\n${disclosure.wording}`;
}

export function checkDisclosure(text: string, scope: DisclosureScope): DisclosureVerdict {
  if (scope.disclosure) {
    const disclosure = refOf(scope.disclosure);
    return text.includes(scope.disclosure.wording)
      ? { lane: "clear", reason: null, disclosure }
      : { lane: "hard_block", reason: "disclosure_missing", disclosure };
  }
  if (scope.productLine) return { lane: "soft_flag", reason: "disclosure_unconfigured", disclosure: null };
  if (scope.tenantConfigured) return { lane: "soft_flag", reason: "disclosure_unscoped", disclosure: null };
  return { lane: "clear", reason: null, disclosure: null };
}

export interface CreativePreflight {
  status: "passed" | "flagged" | "blocked";
  lane: "hard_block" | "soft_flag" | null;
  findings: ComplianceFinding[];
  disclosure: DisclosureRef | null;
}

/** The whole pre-flight a creative passes: the banned-claim scan plus the
 *  disclosure lane. A hard block outranks any soft flag. */
export function preflightCreative(text: string, scope: DisclosureScope): CreativePreflight {
  const claims = checkCompliance(text);
  const verdict = checkDisclosure(text, scope);
  const findings = [...claims.findings];
  if (verdict.reason) {
    const excerpt = verdict.reason === "disclosure_missing" && scope.disclosure ? scope.disclosure.key : "";
    findings.push({ rule: verdict.reason, excerpt, note: DISCLOSURE_NOTES[verdict.reason] });
  }
  const lane = verdict.lane === "hard_block" ? "hard_block" : findings.length ? "soft_flag" : null;
  const status = lane === "hard_block" ? "blocked" : lane === "soft_flag" ? "flagged" : "passed";
  return { status, lane, findings, disclosure: verdict.disclosure };
}
