import { id, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";

// Post-flight checks (docs/02 §4, docs/12 §5). Cheap deterministic rules only —
// a classifier call to police a classifier call is a cost spiral. Anything
// subtler belongs in the offline eval suite (docs/13).

export type Severity = "info" | "warn" | "block";

export interface GuardrailHit {
  rule: string;
  severity: Severity;
  detail?: string;
}

/** Claims we may not let a model make on our behalf without a stored source. */
const REGULATED = [
  /\bguarantee(?:d|s)?\b/i,
  /\bwe (?:will|shall) (?:pay|cover|reimburse)\b/i,
  /\bapproved by (?:the )?(?:central bank|insurance authority|regulator)\b/i,
  /\byou are (?:fully )?covered\b/i,
  /\brisk[- ]free\b/i,
  /\bno (?:exclusions|deductible|excess)\b/i,
  // ar (docs/27 F46), one entry per English rule above rather than a loose set:
  // this floor decides whether a sentence may reach a customer, and it was
  // English-only while half the product's locales are Arabic — an Arabic
  // promise to pay was not warned about, it was not seen.
  //
  // No `\b` anywhere below. JS word boundaries are defined against [A-Za-z0-9_],
  // so every Arabic letter is a non-word character and `\bضمان\b` matches in
  // places nothing sensible does. The alternations are written out instead.
  /نضمن|مضمون(?:ة|ًا)?/,
  /س(?:ندفع|نغطي|نعوّض|نعوض)|سنقوم\s+ب(?:دفع|تغطية|تعويض)/,
  /معتمد(?:ة)?\s+من\s+(?:قِبل\s+|قبل\s+)?(?:المصرف\s+المركزي|البنك\s+المركزي|هيئة\s+التأمين|الجهة\s+التنظيمية)/,
  /مغط(?:ى|اة)\s+بالكامل/,
  /خالي(?:ة)?\s+من\s+المخاطر/,
  // "بدون تحمل" / "لا توجد استثناءات". Note the negation is required: the
  // nouns themselves (استثناءات, تحمل) are ordinary policy vocabulary and
  // appear in the schedule of every compliant Arabic quote we send.
  /(?:لا\s+توجد|بدون|من\s+دون|دون)\s+(?:استثناءات|أي\s+استثناءات|تحمّل|تحمل|خصم)/
];

const JAILBREAK = [
  /ignore (?:all )?(?:previous|prior|above) instructions/i,
  /\bdisregard (?:your|the) (?:system )?prompt\b/i,
  /\breveal (?:your )?(?:system )?prompt\b/i,
  /\bpretend you are (?:not|no longer)\b/i,
  /\bdeveloper mode\b/i,
  // ar. Lyra ships en+ar (CLAUDE.md §7), so an English-only pattern set is a
  // guard with a hole the size of half the product's locales.
  /تجاهل\s+(?:كل\s+)?(?:التعليمات|الأوامر)/,
  /(?:اكشف|أظهر)\s+(?:عن\s+)?(?:موجه|تعليمات)\s*(?:النظام)?/,
  /تظاهر\s+أنك/,
  // docs/27 F46. The Arabic set mirrored three of the five English patterns and
  // stopped; "developer mode" and "forget your instructions" are the two the
  // golden set walked straight through. `انسَ` carries a fatha the keyboard
  // often drops, so both spellings.
  /وضع\s+المطور/,
  /(?:انسَ|انس|تناسَ)\s+(?:كل\s+)?(?:التعليمات|الأوامر)/
];

/** Placeholders the model invented rather than echoed — a sign it is hallucinating PII. */
const PLACEHOLDER = /\[\[[A-Z_]+_\d+\]\]/g;

/** Classified intent slugs (e.g. "claim.first_notice") a renewal/upsell push is a mismatch against. */
const NON_RENEWAL_INTENT = /^(?:claim|complaint|cancel)\b/i;

/** Signs the reply pushed renewal/upsell content regardless of what was asked. */
const RENEWAL_PUSH = [
  /\brenew(?:al|als|s|ing)?\b/i,
  /\bupgrade (?:your|to)\b/i,
  /\b(?:home|motor|life) (?:offer|bundle)\b/i,
  /\bcross-?sell\b/i
];

export interface PostCheckInput {
  text: string;
  /** Placeholders we actually issued, so an invented one is detectable. */
  issued: ReadonlySet<string>;
  /** Purposes where an unsourced regulated claim is a block, not a warning. */
  customerFacing?: boolean;
  /** The customer's classified intent this turn (e.g. "claim.first_notice"), so a reply that talks past it is detectable. */
  intent?: string;
}

export function checkOutput(input: PostCheckInput): GuardrailHit[] {
  const hits: GuardrailHit[] = [];

  for (const re of REGULATED) {
    const m = input.text.match(re);
    if (m) {
      hits.push({
        rule: "regulated_claim",
        severity: input.customerFacing ? "block" : "warn",
        detail: m[0]
      });
      break;
    }
  }

  for (const token of input.text.match(PLACEHOLDER) ?? []) {
    if (!input.issued.has(token)) {
      hits.push({ rule: "hallucinated_placeholder", severity: "warn", detail: token });
      break;
    }
  }

  // The model repeating a secret back means one reached it despite the scrubber.
  if (/\b(?:sk-ant-|cfat_|AKIA)[A-Za-z0-9_-]{8,}/.test(input.text)) {
    hits.push({ rule: "secret_in_output", severity: "block" });
  }

  // A claim/complaint/cancel intent answered with a renewal/upsell push is a
  // topic mismatch, not a text-only pattern — the seed narrative
  // (packages/core/src/seed/orbit.ts) is the canonical example this catches.
  if (input.intent && NON_RENEWAL_INTENT.test(input.intent) && RENEWAL_PUSH.some((re) => re.test(input.text))) {
    hits.push({ rule: "intent_mismatch", severity: "warn", detail: input.intent });
  }

  return hits;
}

/**
 * Screens a turn before it reaches the model.
 *
 * Severity is a property of provenance, not of the sentence. Text a signed-in
 * human typed is warned about — staff probe the assistant, and refusing them
 * teaches nothing. Text nobody in this tenant authored on purpose — a tool
 * result, a retrieved document, a harvested page — carries the operator's
 * authority into the prompt without the operator's intent, so a jailbreak
 * pattern there blocks. Callers that splice third-party content into a turn
 * pass `untrusted` (gateway.complete does it for role=tool automatically;
 * anything embedding retrieved text into a user turn must say so).
 */
export function checkInput(text: string, opts: { untrusted?: boolean } = {}): GuardrailHit[] {
  for (const re of JAILBREAK) {
    if (re.test(text)) {
      return [
        { rule: "prompt_injection", severity: opts.untrusted ? "block" : "warn", detail: re.source.slice(0, 40) }
      ];
    }
  }
  return [];
}

export function blocked(hits: readonly GuardrailHit[]): boolean {
  return hits.some((h) => h.severity === "block");
}

/** Persist trips so Compliance can see them without reading model transcripts. */
export async function recordGuardrails(
  ctx: Ctx,
  hits: readonly GuardrailHit[],
  opts: { runId?: string; subjectRef?: string } = {}
): Promise<void> {
  if (!hits.length) return;
  await ctx.db.insert(schema.aiGuardrailEvents).values(
    hits.map((h, i) => ({
      id: id("gre", ctx.now + i),
      tenantId: ctx.tenantId,
      runId: opts.runId ?? null,
      rule: h.rule,
      severity: h.severity,
      detail: h.detail ?? null,
      subjectRef: opts.subjectRef ?? null,
      ts: ctx.now
    }))
  );
}
