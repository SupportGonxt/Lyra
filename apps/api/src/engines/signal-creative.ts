import { id as newId, schema } from "@lyra/db";
import {
  appendDisclosure,
  checkCompliance,
  emit,
  preflightCreative,
  sha256Hex,
  type Ctx,
  type ComplianceFinding,
  type ComplianceResult,
  type CreativePreflight,
  type DisclosureRef
} from "@lyra/core";
import { promptNouns, type Gateway, type PromptNouns } from "@lyra/model-gateway";
import { disclosureScope } from "./compliance-disclosure.js";

// docs/modules/signal.md §2.1 + §8 acceptance: "Brief -> 20 compliant ar/en
// variants -> publish to Meta+Google in < 1 hour with human review only at the
// flag lane." This engine is the generation half only — brief in, N variants
// persisted to `signal_creatives`, each compliance-checked and audited. The
// publish-to-Meta/Google connector is credential-blocked and out of scope; a
// creative lands here at most "review-ready", never "published" (there is no
// `publishedAt` column on this table to even set).
//
// The Compliance Pre-flight check itself (checkCompliance) lives in
// packages/core/src/signal-compliance.ts — pure and DB-free, so
// packages/model-gateway/evals/signal scores the exact same function.

// "image" is a storage-side kind only — it never goes through generateCreatives'
// copy prompt, just generateCreativeImage below. `kind` has no CHECK constraint
// (schema/signal.ts's comment lists ad|lp|email|social|video_script for the
// text pathway), so adding this needs no migration.
export type CreativeKind = "ad" | "lp" | "email" | "social" | "video_script" | "image";
export type CreativeLocale = "en" | "ar";

export interface CreativeBrief {
  /** Null for a creative not yet attached to a campaign (e.g. drafted ahead of launch). */
  campaignId?: string | null;
  kind: CreativeKind;
  /** What the ad is about and the angle to take — the human-authored input. */
  brief: string;
  /** The campaign plan, flattened to sentences: the chosen option's angle and
   *  offer, and the bands the audience is made of. Absent for a creative
   *  briefed by hand, which is why it is optional rather than empty. */
  context?: string[];
  /** ADR-0108 / docs/17 SIG-013: the product line whose mandatory disclosure
   *  every variant carries. Absent = unscoped. */
  productLine?: string | null;
  /** Groups variants that are A/B siblings of the same slot; defaults to none. */
  variantGroup?: string | null;
  /** Defaults to both — CLAUDE.md rule 7, ar/en from day one, native prompts not translation. */
  locales?: CreativeLocale[];
  /** Defaults to 20 per the acceptance criterion, split evenly across locales. */
  count?: number;
}

export { checkCompliance, type ComplianceFinding, type ComplianceResult };

/** CLAUDE.md rule 14: the industry noun comes from the tenant's domain pack, so
 *  the same generator writes for a lender or a retailer without an edit. The
 *  prohibitions do not — they are compliance copy (docs/12) and hold whatever
 *  is being sold. */
function systemPrompt(nouns: PromptNouns): string {
  return (
    `You write short marketing creative copy for a ${nouns.domain} brand. One variant per line, no ` +
    "numbering, no surrounding quotes. Never claim a guarantee of cover or acceptance, and never " +
    "claim to be the cheapest or best against the whole market without a named source. Write " +
    "natively in the requested language — never a translation of a draft in another language."
  );
}

export function buildPrompt(opts: {
  brief: string;
  locale: CreativeLocale;
  count: number;
  nouns: PromptNouns;
  context?: string[];
}): {
  system: string;
  user: string;
} {
  const language = opts.locale === "ar" ? "Arabic" : "English";
  // The plan goes above the brief: it says who is being written for and on what
  // angle, and a model reading top-down should have that before the subject.
  const context = opts.context?.length ? `${opts.context.join("\n")}\n\n` : "";
  return {
    system: systemPrompt(opts.nouns),
    user: `${context}Brief: ${opts.brief}\n\nWrite ${opts.count} distinct variants in ${language}, one per line.`
  };
}

/** One variant per line — the same "raw prose, not a claim parser" posture as
 *  narrator.ts's extractNumbers. Returns however many lines the model actually
 *  wrote; callers see the real count rather than a padded or truncated one. */
export function parseVariants(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface GeneratedVariant {
  id: string;
  locale: CreativeLocale;
  text: string;
  complianceStatus: CreativePreflight["status"];
  complianceFindings: ComplianceFinding[];
  /** The tenant wording appended to this variant, at the version appended. */
  disclosure: DisclosureRef | null;
  aiAuditId: string;
}

/** The inspectable "why" stored on a creative (docs/15 §4): the pre-flight's
 *  lane, findings and which disclosure version it was judged against. Null for
 *  a clean creative with no disclosure lane — the pre-ADR-0108 shape. */
export function complianceNotes(checkedAt: number, result: CreativePreflight): string | null {
  if (!result.findings.length && !result.disclosure) return null;
  return JSON.stringify({
    checkedAt,
    lane: result.lane,
    findings: result.findings,
    disclosure: result.disclosure
  });
}

export interface GenerateCreativesResult {
  variants: GeneratedVariant[];
  /** One gateway call per locale, so one audit id per locale — CLAUDE.md rule 3. */
  auditIds: string[];
}

/**
 * Thrown when generation fails after earlier locales already wrote rows.
 *
 * There is no transaction around the locale loop and there cannot be one: each
 * locale is its own model call, and the rows from the first are committed before
 * the second is made. A bare throw would tell the caller "nothing happened"
 * while `signal_creatives` holds drafts and `ai_audit_log` holds the call that
 * made them, so every count downstream — the response, the tray, the audit
 * after-state — would disagree with the database. This carries the committed
 * work out with the failure; `cause` still holds what actually broke.
 */
export class PartialCreativesError extends Error {
  readonly partial: GenerateCreativesResult;

  constructor(partial: GenerateCreativesResult, cause: unknown) {
    super("creative generation failed after some variants were written", { cause });
    this.name = "PartialCreativesError";
    this.partial = partial;
  }
}

/**
 * Brief -> generate per locale (packages/model-gateway, standard tier, module
 * "signal" — docs §3 "Creative Generator: standard, no (drafts)") -> compliance
 * pre-flight per variant -> persist to `signal_creatives`. A flagged variant is
 * still written (so the queue is inspectable, docs §2.1 "soft-flag lane to
 * human Compliance Reviewer") with `complianceStatus: "flagged"`, never
 * `"passed"` — nothing here sets `"passed"` on a variant that failed the check,
 * so a flagged draft cannot be silently mistaken for one clear to publish.
 */
export async function generateCreatives(
  ctx: Ctx,
  gateway: Gateway,
  brief: CreativeBrief
): Promise<GenerateCreativesResult> {
  const locales = brief.locales ?? (["en", "ar"] as const);
  const total = brief.count ?? 20;
  const base = Math.floor(total / locales.length);
  const remainder = total % locales.length;

  const variants: GeneratedVariant[] = [];
  const auditIds: string[] = [];

  for (let i = 0; i < locales.length; i++) {
    const locale = locales[i]!;
    const n = base + (i < remainder ? 1 : 0);
    if (n === 0) continue;

    try {
      await generateLocale(ctx, gateway, brief, locale, n, variants, auditIds);
    } catch (cause) {
      // Nothing written yet: the caller wants the real error, not an empty
      // partial it has to unwrap. Something written: see PartialCreativesError.
      if (variants.length === 0 && auditIds.length === 0) throw cause;
      throw new PartialCreativesError({ variants, auditIds }, cause);
    }
  }

  return { variants, auditIds };
}

/** One locale: one gateway call, then a row per line it wrote. Split out so the
 *  caller can tell "this locale failed" from "the whole batch failed". */
async function generateLocale(
  ctx: Ctx,
  gateway: Gateway,
  brief: CreativeBrief,
  locale: CreativeLocale,
  n: number,
  variants: GeneratedVariant[],
  auditIds: string[]
): Promise<void> {
  {
    const { system, user } = buildPrompt({
      brief: brief.brief,
      locale,
      count: n,
      nouns: promptNouns(ctx.policy.domainPack),
      ...(brief.context?.length ? { context: brief.context } : {})
    });
    const res = await gateway.complete(ctx, {
      module: "signal",
      purpose: "creative.generate",
      tier: "standard",
      ...(brief.campaignId ? { subjectRef: brief.campaignId } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
    auditIds.push(res.auditId);

    // SIG-013: appended after generation, deterministically — no prompt
    // changes, and nothing the model writes can drop or paraphrase it.
    const scope = await disclosureScope(ctx, brief.productLine ?? null, locale);

    for (const drafted of parseVariants(res.text)) {
      const text = appendDisclosure(drafted, scope.disclosure);
      const compliance = preflightCreative(text, scope);
      const id = newId("crv", ctx.now);

      await ctx.db.insert(schema.signalCreatives).values({
        id,
        tenantId: ctx.tenantId,
        campaignId: brief.campaignId ?? null,
        kind: brief.kind,
        locale,
        productLine: brief.productLine ?? null,
        // ponytail: contentRef stores the generated text inline, mirroring
        // narrator.ts's narrativeRef — nothing in this codebase uploads real R2
        // bytes yet (see analyticsExports' fileId: null). Swap for a real R2
        // key the day something writes bytes to R2 for real.
        contentRef: text,
        variantGroup: brief.variantGroup ?? null,
        complianceStatus: compliance.status,
        complianceNotesJson: complianceNotes(ctx.now, compliance),
        performanceJson: null,
        generatedBy: "ai",
        aiAuditId: res.auditId,
        createdAt: ctx.now,
        updatedAt: ctx.now
      });

      // docs/30 SIGNAL 4: a flagged draft waits for a human reviewer; the
      // bus is how that reviewer's queue hears of it.
      if (compliance.status === "flagged") {
        await emit(ctx, {
          module: "signal",
          type: "signal.creative.flagged",
          subject: id,
          data: { creativeId: id, campaignId: brief.campaignId ?? null, rules: compliance.findings.map((f) => f.rule) }
        });
      }

      variants.push({
        id,
        locale,
        text,
        complianceStatus: compliance.status,
        complianceFindings: compliance.findings,
        disclosure: compliance.disclosure,
        aiAuditId: res.auditId
      });
    }
  }
}

export interface ImageBrief {
  campaignId?: string | null;
  /** What to depict — the human-authored input, screened by gateway.generateImage's checkInput. */
  prompt: string;
  locale?: CreativeLocale;
  /** Same shape as CreativeBrief.context: the plan's angle/offer and the
   *  audience's bands, flattened to sentences — creativeContextLines. Absent
   *  for an image briefed by hand, same as the text path. */
  context?: string[];
}

/**
 * Wraps the caller's raw prompt (what to depict) with a professional-agency
 * quality bar and, when present, the same plan/audience context the copy
 * generator reads — so the hero image targets the same angle and bands as
 * the ad text next to it, instead of illustrating the subject in a vacuum.
 * Never drops or reorders the raw prompt: it is a single unbroken sentence,
 * so a scan for the literal brief still finds it.
 */
export function buildImagePrompt(brief: ImageBrief): string {
  const context = brief.context?.length ? `${brief.context.join("\n")}\n\n` : "";
  return (
    `${context}Depict: ${brief.prompt}\n\n` +
    "Render this as hero-grade marketing photography from a top creative agency: " +
    "cinematic, directional lighting; a considered, uncluttered composition with a clear focal " +
    "subject; a cohesive, on-brand color palette; sharp focus and realistic detail; genuine, " +
    "unposed-looking emotion on any faces shown. Make it scroll-stopping and premium, not generic " +
    "stock-photo or AI-slop imagery — no warped hands, extra limbs, garbled text, or watermarks. " +
    "If the context above names a specific audience, compose and style the scene so that audience " +
    "sees themselves in it."
  );
}

export interface GeneratedImage {
  id: string;
  fileId: string;
  r2Key: string;
  contentType: string;
  bytes: Uint8Array;
  aiAuditId: string;
}

/**
 * ADR-0060. Brief -> gateway.generateImage (module "signal", purpose
 * "creative.image_generate") -> bytes to R2 + a `files` row, same pattern as
 * analytics.ts's storeExport() -> a `signal_creatives` row of kind "image"
 * whose contentRef is the file id, not inline text. No checkCompliance here:
 * that scanner reads generated ad copy for banned claims, and there is no
 * generated text on this path to scan.
 */
export async function generateCreativeImage(
  ctx: Ctx,
  gateway: Gateway,
  bucket: R2Bucket | undefined,
  brief: ImageBrief
): Promise<GeneratedImage> {
  const res = await gateway.generateImage(ctx, {
    module: "signal",
    purpose: "creative.image_generate",
    ...(brief.campaignId ? { subjectRef: brief.campaignId } : {}),
    prompt: buildImagePrompt(brief)
  });

  if (!bucket) throw new Error("FILES bucket not bound");

  const id = newId("crv", ctx.now);
  const fileId = newId("file", ctx.now);
  const ext = res.contentType === "image/png" ? "png" : "bin";
  const r2Key = `signal-creatives/${ctx.tenantId}/${fileId}.${ext}`;
  await bucket.put(r2Key, res.bytes, { httpMetadata: { contentType: res.contentType } });

  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "signal_creative_image",
    subjectRef: id,
    sha256: await sha256Hex(res.bytes),
    sizeBytes: res.bytes.length,
    contentType: res.contentType,
    piiLevel: "none",
    createdAt: ctx.now,
    deletedAt: null
  });

  await ctx.db.insert(schema.signalCreatives).values({
    id,
    tenantId: ctx.tenantId,
    campaignId: brief.campaignId ?? null,
    kind: "image",
    locale: brief.locale ?? "en",
    contentRef: fileId,
    variantGroup: null,
    complianceStatus: "passed",
    complianceNotesJson: null,
    performanceJson: null,
    generatedBy: "ai",
    aiAuditId: res.auditId,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });

  return { id, fileId, r2Key, contentType: res.contentType, bytes: res.bytes, aiAuditId: res.auditId };
}
