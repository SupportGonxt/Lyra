import { and, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { FREQUENCY_CAP_PER_WEEK } from "./signal-outreach.js";
import {
  QUIET_FROM_HOUR,
  QUIET_UNTIL_HOUR,
  tenantPatternProblem,
  type BannedClaim,
  type BrandKit,
  type ComplianceFinding,
  type Ctx
} from "@lyra/core";

// docs/modules/signal.md §2.1: "Brand kit enforcement: tenant tokens,
// banned-claims list". The pre-flight itself is pure and DB-free on purpose (the
// model-gateway eval harness scores the same function), so *loading* the kit is
// this file's job and the only thing that touches the database.
//
// A kit is tenant-wide — one row — and it is additive: it says what else must be
// true, never whether the built-in regulator-shaped rules run.

/** How many of each list is honoured. A kit is a short list of house rules, not
 *  a corpus; an unbounded one would put an unbounded scan in front of every
 *  generation. */
export const KIT_LIST_MAX = 50;

/** The empty kit: what a tenant that has configured nothing runs on. */
export const EMPTY_KIT: BrandKit = { requiredPhrases: [], forbiddenWords: [], bannedClaims: [] };

function strings(raw: string | null, max = KIT_LIST_MAX): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * The tenant's banned claims, with any pattern the engine will not run dropped.
 *
 * A rejected pattern is dropped rather than allowed to fail the load: the kit is
 * configuration, and one bad row should cost that rule, not every generation the
 * tenant makes. The same `tenantPatternProblem` the pre-flight uses decides, so
 * what is loaded and what is enforced cannot disagree.
 */
export function bannedClaimsFrom(raw: string | null): BannedClaim[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BannedClaim[] = [];
  for (const entry of parsed.slice(0, KIT_LIST_MAX)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { pattern?: unknown; isRegex?: unknown; note?: unknown; severity?: unknown };
    if (typeof row.pattern !== "string" || typeof row.note !== "string") continue;
    const claim: BannedClaim = {
      pattern: row.pattern,
      note: row.note,
      ...(row.isRegex === true ? { isRegex: true } : {}),
      ...(row.severity === "block" ? { severity: "block" as const } : {})
    };
    if (tenantPatternProblem(claim)) continue;
    out.push(claim);
  }
  return out;
}

/** The tenant's kit, or the empty kit when it has configured none. */
export async function brandKitFor(ctx: Ctx): Promise<BrandKit> {
  const [row] = await ctx.db
    .select()
    .from(schema.signalBrandKits)
    .where(eq(schema.signalBrandKits.tenantId, ctx.tenantId))
    .limit(1);
  if (!row) return EMPTY_KIT;
  return {
    requiredPhrases: strings(row.requiredPhrasesJson),
    forbiddenWords: strings(row.forbiddenWordsJson),
    bannedClaims: bannedClaimsFrom(row.bannedClaimsJson)
  };
}

/** Whether a kit would change any verdict — the admin screen's "is this real?". */
export function kitIsEmpty(kit: BrandKit): boolean {
  return kit.requiredPhrases.length === 0 && kit.forbiddenWords.length === 0 && kit.bannedClaims.length === 0;
}

/* ------------------------------------------------------- the guardrail record */

/**
 * What was actually checked before a campaign went live (docs/modules/signal.md
 * §2.1, and the admin screen's guardrail table).
 *
 * The seed wrote `brandKit: "pass"` and `bannedClaims: "pass"` as bare strings
 * for campaigns it had created itself, and nothing computed either value — so
 * every campaign a real team launched showed a guardrail table saying "pass"
 * and an empty fault list beside it. This computes the record from the tenant's
 * own kit and its creatives' actual verdicts, so the two agree.
 *
 * `not-configured` and `unchecked` are deliberately distinct from `pass`: a
 * campaign running with no brand kit, or with no cleared creative yet, is a gap
 * an operator should see rather than a tick nobody earned.
 */
export interface GuardrailCheck {
  brandKit: "pass" | "flagged" | "not-configured" | "unchecked";
  bannedClaims: "pass" | "flagged" | "blocked" | "unchecked";
  /** The kit version the check ran against, so a later edit is visible. */
  brandKitVersion: number | null;
  frequencyCapPerWeek: number;
  quietHours: { from: string; to: string; tz: string };
  checkedAt: number;
}

function findingsOf(raw: string | null): ComplianceFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { findings?: unknown };
    return Array.isArray(parsed.findings) ? (parsed.findings as ComplianceFinding[]) : [];
  } catch {
    return [];
  }
}

const BRAND_RULES = new Set(["brand_forbidden_word", "brand_required_phrase_missing"]);
const CLAIM_RULES = new Set(["tenant_banned_claim", "comparison_claim_requires_source", "no_guarantee_of_cover"]);

export async function guardrailRecordFor(ctx: Ctx, campaignId: string): Promise<GuardrailCheck> {
  const kit = await brandKitFor(ctx);
  const [kitRow] = await ctx.db
    .select({ version: schema.signalBrandKits.version })
    .from(schema.signalBrandKits)
    .where(eq(schema.signalBrandKits.tenantId, ctx.tenantId))
    .limit(1);

  const creatives = await ctx.db
    .select({ status: schema.signalCreatives.complianceStatus, notes: schema.signalCreatives.complianceNotesJson })
    .from(schema.signalCreatives)
    .where(and(eq(schema.signalCreatives.tenantId, ctx.tenantId), eq(schema.signalCreatives.campaignId, campaignId)));

  const findings = creatives.flatMap((c) => findingsOf(c.notes));

  const brandKit: GuardrailCheck["brandKit"] = kitIsEmpty(kit)
    ? "not-configured"
    : findings.some((f) => BRAND_RULES.has(f.rule))
      ? "flagged"
      : "pass";

  const bannedClaims: GuardrailCheck["bannedClaims"] = creatives.length === 0
    ? "unchecked"
    : creatives.some((c) => c.status === "blocked")
      ? "blocked"
      : findings.some((f) => CLAIM_RULES.has(f.rule) || f.severity === "block")
        ? "flagged"
        : "pass";

  return {
    brandKit,
    bannedClaims,
    brandKitVersion: kitRow?.version ?? null,
    frequencyCapPerWeek: FREQUENCY_CAP_PER_WEEK,
    quietHours: {
      from: `${String(QUIET_FROM_HOUR).padStart(2, "0")}:00`,
      to: `${String(QUIET_UNTIL_HOUR).padStart(2, "0")}:00`,
      tz: ctx.policy.timezone ?? "UTC"
    },
    checkedAt: ctx.now
  };
}
