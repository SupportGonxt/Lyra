import { verifyGroundedness } from "./narrator-verify.js";
// docs/modules/signal.md §2.1/§8 Compliance Pre-flight (CLAUDE.md rule 11's
// inspectable "why"): every generated creative gets checked before it can be
// marked review-ready. Pure and DB-free like momentum.ts/narrator-verify.ts so
// both apps/api's signal-creative engine and this package's own eval harness
// (packages/model-gateway/evals/signal) score the identical function.

export type ComplianceRule =
  | "comparison_claim_requires_source"
  | "no_guarantee_of_cover"
  | "tenant_banned_claim"
  | "brand_forbidden_word"
  | "brand_required_phrase_missing";

export interface ComplianceFinding {
  rule: ComplianceRule | DisclosureReason;
  excerpt: string;
  note: string;
  /**
   * A tenant's own rule may block outright; a built-in one only flags. The
   * default is `flag`, so nothing that was advisory becomes blocking by
   * accident — a `block` has to have been configured as one.
   */
  severity?: "block" | "flag";
}

export interface ComplianceResult {
  status: "passed" | "flagged" | "blocked";
  findings: ComplianceFinding[];
}

/**
 * The tenant's own house rules (docs/modules/signal.md §2.1: "brand kit
 * enforcement: tenant tokens, banned-claims list"). Passed in rather than read,
 * because this file is deliberately pure and DB-free — the API engine and the
 * model-gateway eval harness score the identical function, and a check that
 * queried the database could not be an eval.
 *
 * These are **additive**: a tenant configures what else must be true, never
 * whether the built-ins run. Both are regulator-shaped ("never publishable in
 * this form"), so a tenant cannot switch them off — the same line SIG-015 draws
 * for disclosures.
 */
export interface BrandKit {
  /** Phrases the brand always runs. Absent copy is flagged for a human. */
  requiredPhrases: readonly string[];
  /** Words this brand never uses. */
  forbiddenWords: readonly string[];
  /** The tenant's own banned claims. */
  bannedClaims: readonly BannedClaim[];
}

export interface BannedClaim {
  /** A literal phrase by default; a pattern only when `isRegex` says so. */
  pattern: string;
  isRegex?: boolean;
  note: string;
  severity?: "block" | "flag";
}

/**
 * Tenant-supplied patterns run on every generation, so a catastrophic
 * backtracking pattern would hang the worker rather than fail it — the repo has
 * already paid for one ReDoS (`stripFence`). Two cheap bounds, applied when the
 * kit is loaded rather than at match time: the pattern is length-capped, and a
 * nested quantifier (`(a+)+`, the shape that explodes) is refused outright.
 */
export const TENANT_PATTERN_MAX = 200;
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/** Does this tenant pattern look safe to run on every generation? */
export function tenantPatternProblem(claim: BannedClaim): string | null {
  if (claim.pattern.length === 0) return "empty pattern";
  if (claim.pattern.length > TENANT_PATTERN_MAX) return `pattern longer than ${TENANT_PATTERN_MAX} characters`;
  if (claim.isRegex) {
    if (NESTED_QUANTIFIER.test(claim.pattern)) return "nested quantifier (a catastrophic-backtracking shape)";
    try {
      new RegExp(claim.pattern);
    } catch {
      return "not a valid regular expression";
    }
  }
  return null;
}

/** Escape a literal phrase so a tenant's "10%" is a phrase, not a regex. */
function literal(phrase: string): RegExp {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** The tenant's own rules as findings. Skipped wholesale when no kit is set. */
function kitFindings(text: string, kit: BrandKit | null | undefined): ComplianceFinding[] {
  if (!kit) return [];
  const out: ComplianceFinding[] = [];
  for (const claim of kit.bannedClaims) {
    if (tenantPatternProblem(claim)) continue;
    const re = claim.isRegex ? new RegExp(claim.pattern, "i") : literal(claim.pattern);
    const m = text.match(re);
    if (m) out.push({ rule: "tenant_banned_claim", excerpt: m[0], note: claim.note, severity: claim.severity ?? "flag" });
  }
  for (const word of kit.forbiddenWords) {
    if (!word) continue;
    const m = text.match(literal(word));
    if (m) {
      out.push({
        rule: "brand_forbidden_word",
        excerpt: m[0],
        note: `The brand kit lists "${word}" as a word this brand does not use.`,
        severity: "flag"
      });
    }
  }
  for (const phrase of kit.requiredPhrases) {
    if (!phrase || text.includes(phrase)) continue;
    out.push({
      rule: "brand_required_phrase_missing",
      excerpt: "",
      note: `The brand kit requires the phrase "${phrase}", which this copy does not carry.`,
      severity: "flag"
    });
  }
  return out;
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
export function checkCompliance(text: string, kit?: BrandKit | null): ComplianceResult {
  const findings: ComplianceFinding[] = [];
  for (const b of BANNED_CLAIMS) {
    const m = text.match(b.re);
    if (m) findings.push({ rule: b.rule, excerpt: m[0], note: b.note });
  }
  findings.push(...kitFindings(text, kit));
  if (findings.some((f) => f.severity === "block")) return { status: "blocked", findings };
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
  if (compliance.status !== "passed") return { ok: false, why: compliance.findings[0]!.note };
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
export function preflightCreative(text: string, scope: DisclosureScope, kit?: BrandKit | null): CreativePreflight {
  const claims = checkCompliance(text, kit);
  const verdict = checkDisclosure(text, scope);
  const findings = [...claims.findings];
  if (verdict.reason) {
    const excerpt = verdict.reason === "disclosure_missing" && scope.disclosure ? scope.disclosure.key : "";
    // A missing mandatory disclosure is a hard block because it is a regulatory
    // omission, not a matter of taste — the one built-in that outranks a flag.
    findings.push({ rule: verdict.reason, excerpt, note: DISCLOSURE_NOTES[verdict.reason], severity: verdict.lane === "hard_block" ? "block" : "flag" });
  }
  const blocked = verdict.lane === "hard_block" || findings.some((f) => f.severity === "block");
  const lane = blocked ? "hard_block" : findings.length ? "soft_flag" : null;
  const status = lane === "hard_block" ? "blocked" : lane === "soft_flag" ? "flagged" : "passed";
  return { status, lane, findings, disclosure: verdict.disclosure };
}
