// docs/27 F40. `purpose` decides whether a regulated claim is a warning or a
// block, so a caller-supplied free string is a caller-supplied safety switch.
// This registry is the governed vocabulary: a purpose is a known slug bound to
// exactly one module, and anything else is treated as the most dangerous case.
//
// Adding a purpose is a deliberate act. The pair (module, purpose) must match
// how the call is actually made, because `module` comes from a trusted row
// (the ai_agents record) while `purpose` comes from the request body — the
// mismatch check is what makes the body untrusted in practice, not just in
// principle.

export interface PurposeDef {
  /** The one module allowed to use this purpose. */
  module: string;
  /**
   * Output reaches someone outside the tenant's own staff — a customer, a
   * public feed, a regulator. Regulated claims block here; internally they warn.
   */
  customerFacing: boolean;
}

export const PURPOSES: Record<string, PurposeDef> = {
  // dist — quoting and distribution. Every one of these is read by a buyer.
  "quote.explain": { module: "dist", customerFacing: true },
  "dist.quote.explain": { module: "dist", customerFacing: true },
  "quote.compare": { module: "dist", customerFacing: true },
  "dist.nbo.propose": { module: "dist", customerFacing: true },

  // axis — case work. Staff-facing; extraction never leaves the desk.
  "axis.case.copilot": { module: "axis", customerFacing: false },
  "axis.document.extract": { module: "axis", customerFacing: false },
  "axis.document.embed": { module: "axis", customerFacing: false },
  "axis.dev.extract_sample": { module: "axis", customerFacing: false },
  "axis.fnol.triage": { module: "axis", customerFacing: false },
  "axis.claim.reserve_recommend": { module: "axis", customerFacing: false },
  "axis.claim.fraud_score": { module: "axis", customerFacing: false },
  "axis.case.sla_predict": { module: "axis", customerFacing: false },
  // UBI repricing proposes a premium delta a human endorses (engines/telematics.ts).
  // Staff-facing: the proposal never leaves the desk until an endorsement is approved.
  "axis.policy.ubi_reprice": { module: "axis", customerFacing: false },

  // orbit — conversations. A draft reply is customer-facing the moment it is
  // sent, and the send path is the same row, so it is customer-facing here.
  "conversation.reply": { module: "orbit", customerFacing: true },
  "orbit.conversation.reply": { module: "orbit", customerFacing: true },
  "orbit.renewal.draft_reply": { module: "orbit", customerFacing: true },
  "orbit.renewal.draft_outreach": { module: "orbit", customerFacing: true },
  "renewal.outreach_draft": { module: "orbit", customerFacing: true },
  "orbit.message.embed": { module: "orbit", customerFacing: false },
  "orbit.message.recall": { module: "orbit", customerFacing: false },

  // signal — marketing. Generation produces drafts, and docs/modules/signal.md
  // §3 puts the customer-facing boundary at publish: "Creative Generator …
  // no (drafts)" / "Compliance Pre-flight … blocks publish". Blocking here
  // would delete a whole batch over one bad line and rob the soft-flag lane of
  // the very draft a human is meant to inspect (engines/signal-creative.ts).
  "creative.generate": { module: "signal", customerFacing: false },
  "creative.variant": { module: "signal", customerFacing: false },
  "creative.image_generate": { module: "signal", customerFacing: false },
  "aeo.draft": { module: "signal", customerFacing: false },
  // The targeting pool a whitespace or a scenario is aimed at. Internal, and
  // structurally so: the model is handed suppressed aggregate counts, never a
  // customer row, and its proposal is validated against those counts before it
  // becomes a rule (src/audience-brief.ts).
  "audience.suggest": { module: "signal", customerFacing: false },
  // The three-option campaign plan a promotion argues: notes, probabilities and
  // the reasons behind them (src/campaign-plan.ts). Internal — a human funds the
  // option, and the copy that ships is governed by creative.generate.
  "campaign.plan": { module: "signal", customerFacing: false },
  // Personalised acquisition outreach (engines/signal-outreach.ts). The draft
  // itself is internal — it is groundedness-checked, compliance-checked and
  // approval-gated before anything is sent, and the send is the consequential
  // act (signal.outreach_send), not this call.
  "outreach.draft": { module: "signal", customerFacing: false },

  // scout — market intelligence. Internal analysis.
  "market.scan": { module: "scout", customerFacing: false },
  "radar.summarise": { module: "scout", customerFacing: false },
  "whitespace.describe": { module: "scout", customerFacing: false },
  // The brief a promoted whitespace hands SIGNAL. Internal: a human reviews the
  // campaign and the creative generator's own purpose governs the copy that ships.
  "whitespace.brief": { module: "scout", customerFacing: false },
  "scout.signal.embed": { module: "scout", customerFacing: false },
  "scout.signal.similar": { module: "scout", customerFacing: false },

  // north — executive briefing. Internal.
  "briefing.generate": { module: "north", customerFacing: false },
  "exec.briefing": { module: "north", customerFacing: false },

  // ledger — reconciliation proposals. Never leave finance.
  "recon.match": { module: "ledger", customerFacing: false },
  // Per-message language + sentiment analysis on inbound ORBIT conversations
  // (engines/orbit-signal.ts). Internal: it annotates the conversation for
  // routing and churn scoring, it never talks to the customer.
  "conversation.signal": { module: "orbit", customerFacing: false },

  // core — platform-wide.
  "output.review": { module: "core", customerFacing: false },
  "knowledge.embed": { module: "core", customerFacing: false },

  // analytics — docs/05 "ask a question in words" (src/analytics-ask.ts,
  // ADR-0088). Staff-facing: the reply is a report definition the reader
  // inspects, edits and runs themselves; the model never sees a data row.
  "analytics.ask": { module: "analytics", customerFacing: false },

  // ADR-0073 — the command center loop. Staff-facing by construction: the
  // surface sits behind the session, and every consequential action it touches
  // becomes a proposal for a human, never an execution. The loop is
  // cross-module by design, so the purpose is registered once per module it
  // can run agents from — the (module, purpose) pair stays exact.
  "command.center": { module: "ai", customerFacing: false },
  "axis.command.center": { module: "axis", customerFacing: false },
  "orbit.command.center": { module: "orbit", customerFacing: false },
  "signal.command.center": { module: "signal", customerFacing: false },
  "scout.command.center": { module: "scout", customerFacing: false },
  "north.command.center": { module: "north", customerFacing: false },
  "ledger.command.center": { module: "ledger", customerFacing: false },
  "dist.command.center": { module: "dist", customerFacing: false }
};

export interface PurposeResolution {
  customerFacing: boolean;
  /** Guardrail flags to attach to the audit row. Empty when the pair is known-good. */
  flags: string[];
}

/**
 * Fail closed. An unregistered purpose, or a purpose used from the wrong
 * module, is treated as customer-facing — the strict reading — and flagged so
 * the audit log shows which call went through the unknown path.
 */
export function resolvePurpose(module: string, purpose: string): PurposeResolution {
  const def = PURPOSES[purpose];
  if (!def) return { customerFacing: true, flags: ["unknown_purpose"] };
  if (def.module !== module) return { customerFacing: true, flags: ["purpose_module_mismatch"] };
  return { customerFacing: def.customerFacing, flags: [] };
}

/** True when the pair is registered and used from its own module. */
export function isKnownPurpose(module: string, purpose: string): boolean {
  return PURPOSES[purpose]?.module === module;
}
