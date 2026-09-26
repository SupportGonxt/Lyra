import { verifyGroundedness } from "./narrator-verify.js";
// docs/modules/signal.md §2.1/§8 Compliance Pre-flight (CLAUDE.md rule 11's
// inspectable "why"): every generated creative gets checked before it can be
// marked review-ready. Pure and DB-free like momentum.ts/narrator-verify.ts so
// both apps/api's signal-creative engine and this package's own eval harness
// (packages/model-gateway/evals/signal) score the identical function.

export interface ComplianceFinding {
  rule: "comparison_claim_requires_source" | "no_guarantee_of_cover";
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
