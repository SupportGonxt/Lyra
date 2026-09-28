import { preflightCreative, unprocessable, type Ctx } from "@lyra/core";
import { disclosureScope, presentDisclosure, wordingRefOf } from "./compliance-disclosure.js";
import { complianceNotes } from "./signal-creative.js";

// docs/17 SIG-013 / SIG-015, ADR-0108 — the write side of the disclosure lane
// for every creative that does not come out of generateCreatives: a person's
// edit, a hand-written creative, a reviewer's verdict. Wired as the creatives
// resource's beforeWrite, which crud.ts runs *before* the approval gate, so
// neither an approver nor the tenant's auto-approve allowlist reaches a row
// this refuses. Nothing here reads ctx.policy: no setting turns it off.

const TEXT_FIELDS = ["contentRef", "productLine", "locale", "kind"] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function creativePreflightGuard(
  ctx: Ctx,
  values: Record<string, unknown>,
  existing: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  const pick = (k: string): unknown => (k in values ? values[k] : existing?.[k]);

  // An image creative's contentRef is a file id, not copy: there is no text to
  // carry a disclosure, so the text lane does not apply (ADR-0108).
  if (pick("kind") === "image") return values;

  // The product line decides which disclosure is mandatory. Clearing it would
  // turn a hard block into a soft flag, so once set it can change, never go.
  if (existing && str(existing.productLine) && "productLine" in values && !str(values.productLine)) {
    throw unprocessable("a creative's product line can be changed but not removed", { productLine: "required" });
  }

  const text = String(pick("contentRef") ?? "");
  const locale = str(pick("locale")) ?? "en";
  const scope = await disclosureScope(ctx, str(pick("productLine")), locale);
  const result = preflightCreative(text, scope);

  if (result.lane === "hard_block") {
    if (values.complianceStatus === "passed") {
      throw unprocessable("the product line's mandatory disclosure is not in the copy verbatim", {
        contentRef: "disclosure_missing"
      });
    }
    return { ...values, complianceStatus: "blocked", complianceNotesJson: complianceNotes(ctx.now, result) };
  }

  // Not blocked: the verdict stays the reviewer's. Only refresh the "why" when
  // the copy it describes changed and the reviewer did not write one.
  const touched = !existing || TEXT_FIELDS.some((k) => k in values);
  if (touched && !("complianceNotesJson" in values)) {
    return { ...values, complianceNotesJson: complianceNotes(ctx.now, result) };
  }
  return values;
}

/**
 * On the transition to `passed` — the publish — record that the disclosure was
 * presented, through the same DISCLOSURE-PRESENT path the compliance route
 * uses, so the audit trail links creative -> wording row -> version -> hash.
 */
export async function recordCreativeDisclosure(
  ctx: Ctx,
  row: Record<string, unknown>,
  before: Record<string, unknown> | null
): Promise<void> {
  if (row.complianceStatus !== "passed" || before?.complianceStatus === "passed") return;
  if (row.kind === "image") return;
  const scope = await disclosureScope(ctx, str(row.productLine), str(row.locale) ?? "en");
  const d = scope.disclosure;
  if (!d || !String(row.contentRef ?? "").includes(d.wording)) return;
  const wordingRef = wordingRefOf(d);
  await presentDisclosure(
    ctx,
    {
      subjectRef: `signal_creative:${String(row.id)}`,
      key: d.key,
      locale: d.locale,
      wording: d.wording,
      wordingRef,
      channel: "signal",
      idempotencyKey: `signal-creative-publish:${String(row.id)}:${wordingRef}`
    },
    "signal.creative.publish"
  );
}
