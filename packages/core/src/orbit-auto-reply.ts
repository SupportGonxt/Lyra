import { AGENT_AUTONOMY } from "@lyra/db";
import { verifyGroundedness } from "./narrator-verify.js";
import { checkCompliance } from "./signal-compliance.js";

// ADR-0098 (docs/30 ORBIT 3). The gate a real-time ORBIT reply passes before it
// is *sent* rather than left as a draft. Pure and DB-free like
// signal-compliance.ts, so apps/api's auto-reply engine and the eval harness
// (packages/model-gateway/evals/orbit-auto-reply) score the identical function.
//
// A draft is read by a person before a customer sees it; an auto-reply is not.
// So the bar is the draft's groundedness rule plus everything a person would
// otherwise have caught at a glance. Failing any of these never drops the
// reply — the caller falls back to a draft, and a human decides.

export type AutoReplyRefusal = "empty" | "too_long" | "language" | "ungrounded" | "action_claim" | "compliance";

/** Long enough for the two-to-four sentences the service prompt asks for, and no more. */
export const AUTO_REPLY_MAX_CHARS = 1200;

/**
 * A sentence that says something has already been done. The replier has no tool
 * that acts — it can only talk — so any such claim is false by construction,
 * and a customer who reads "cancelled" will act on it.
 *
 * Verbs, not nouns: nothing here names an industry noun (CLAUDE.md §14).
 * "received" is deliberately absent — acknowledging a message is true.
 */
const DONE_VERBS =
  "cancel+ed|added|removed|changed|updated|amended|renewed|refunded|paid|processed|approved|issued|sent|submitted|booked|transferred|applied|settled|activated|reinstated|credited|waived|extended|upgraded";
const ACTION_CLAIMS: RegExp[] = [
  new RegExp(`\\b(?:i|we)(?:\\s+have|'ve)\\s+(?:just\\s+|now\\s+|already\\s+)?(?:${DONE_VERBS})\\b`, "i"),
  new RegExp(`\\b(?:has|have)\\s+(?:now\\s+|already\\s+)?been\\s+(?:${DONE_VERBS})\\b`, "i"),
  /\b(?:is|are)\s+now\s+(?:active|live|covered|insured|cancel+ed|renewed|confirmed)\b/i,
  // ar — `\b` is ASCII-defined in JS, so these carry no word boundaries
  // (the same reason signal-compliance.ts keeps its Arabic rules separate).
  /تم(?:ت)?\s+(?:بنجاح\s+)?(?:إلغاء|الغاء|إضافة|اضافة|تعديل|تجديد|استرداد|دفع|سداد|إصدار|اصدار|إرسال|ارسال|تحويل|الموافقة|اعتماد|تسوية|حذف|تحديث|تفعيل)/,
  /قمت\s+ب/,
  /(?:^|\s)(?:ألغيت|الغيت|أضفت|اضفت|أرسلت|ارسلت|جددت|عدلت|دفعت|حولت|فعّلت|فعلت)(?:\s|$|[.،!])/
];

const ARABIC_LETTER = /\p{Script=Arabic}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/** The script most of the letters are in. References like POL-2201 are Latin in both languages, which is why this counts, rather than asking "any Arabic at all". */
function dominantScript(text: string): "ar" | "latin" {
  const arabic = text.match(ARABIC_LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return arabic > latin ? "ar" : "latin";
}

export function checkAutoReply(
  text: string,
  contextLines: readonly string[],
  locale: string
): { ok: true; why: null } | { ok: false; why: AutoReplyRefusal } {
  const body = text.trim();
  if (!body) return { ok: false, why: "empty" };
  if (body.length > AUTO_REPLY_MAX_CHARS) return { ok: false, why: "too_long" };
  // An English answer sent into an Arabic conversation is worse than none (CLAUDE.md §7).
  const expected = locale.split("-")[0] === "ar" ? "ar" : "latin";
  if (dominantScript(body) !== expected) return { ok: false, why: "language" };
  if (!verifyGroundedness(body, [...contextLines]).ok) return { ok: false, why: "ungrounded" };
  if (ACTION_CLAIMS.some((re) => re.test(body))) return { ok: false, why: "action_claim" };
  if (checkCompliance(body).status === "flagged") return { ok: false, why: "compliance" };
  return { ok: true, why: null };
}

/**
 * Whether an agent's own autonomy lets it send without a person in between.
 * Only the two acting rungs of `AGENT_AUTONOMY` do; `act_with_approval` means
 * exactly what it says. Anything not on the ladder fails closed — the seed once
 * wrote `suggest_only`, a spelling on no ladder (ADR-0049).
 */
export function autonomyPermitsSend(level: string): boolean {
  const rung = (AGENT_AUTONOMY as readonly string[]).indexOf(level);
  return rung >= AGENT_AUTONOMY.indexOf("act_within_limits");
}
