# ADR-0118 — Aletheia (cortex0) as a grounded model-gateway provider

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** NXT / goNXT engineering

## Context

NORTH's narrator is held to "100% of numeric claims machine-verified against the
metric layer" (`narrator-verify.ts`), and every analytics "ask-in-words" answer
must be traceable. That is a *post-hoc verification of an LLM's prose*: the model
samples a plausible sentence, then we check its numbers. Vantax Aletheia (`cortex0`,
`VantaX-Org/vantax-aletheia`) is a deterministic **Grounded Structural Intelligence**
engine that assembles answers from a fact graph instead of sampling tokens, and
returns a *proof payload* — `answer` + `epistemic_coverage` + `facts_retrieved`
(with `source` provenance) + `contradictions` + `ood` + `sampling_used: false`. It
speaks an OpenAI-compatible API and a native proof API, and self-learns benchmarks
and causal edges from a tenant's own history.

This ADR adds Aletheia as a **model-gateway provider** so every grounded call still
passes through the one front door (scrub → guardrails → budget → audit), and its
epistemic state is carried on the response instead of being discarded.

## Decision

1. Add a new `aletheia` provider to `packages/model-gateway` (`PROVIDERS`), implemented
   as `providers/aletheia.ts`. It is reached by routing a tier/model at it, exactly like
   the other providers — callers never import it directly.
2. The adapter calls Aletheia's **native proof endpoint**
   `GET {ALETHEIA_URL}/api/{tenant}/chat?q=<query>` and returns the full proof, not
   the OpenAI drop-in's text-only shape. The query is the request's last `user` turn.
3. It carries the proof on a new optional `grounding` field threaded through
   `ProviderResult` → `ModelResponse` (and, when wired, into the audit trail). Shape:

   ```ts
   interface GroundingProof {
     epistemicCoverage: number;            // 0..1
     state: "complete" | "partial" | "insufficient";
     facts: { factId; entity; attribute; value; source }[];
     contradictions: string[];
     ood: boolean;                          // refuse-to-guess
     samplingUsed: boolean;                 // must be false
   }
   ```

4. **Refuse-to-guess becomes the finish reason.** When `ood === true` or `state ===
   "insufficient"`, the adapter returns empty text with `finishReason: "refusal"` and
   the `grounding` explaining *why* — the gateway's existing refusal path then keeps the
   empty answer out of the product, and the epistemic gap is available to the caller
   instead of a hallucinated number.
5. Cost is zero (internal engine — graph lookup + SNN, no token metering), matching
   `internal-chat`. `tokensIn/out` are reported as 0; the catalogue price is 0.
6. Aletheia does not stream or embed; `stream()`/`embed()` are deliberately absent, so
   the gateway serves a streamed call as one chunk (`oneChunk`) — slower, never wrong.

## Consequences

- **Positive:** grounded answers with provenance, an explicit epistemic boundary, and
  a refusal path that the narrator/analytics can branch on (`complete`/`partial`/
  `insufficient`). This is the architectural form of the existing "verify every number"
  requirement, and it self-learns from YallaCompare's own history.
- **Negative / risk:** a second runtime to deploy and secure (TLS, `ALETHEIA_TOKEN`,
  audit). Aletheia is not yet in the `docs/02 §9` approved-services list; it is a VantaX
  internal product, but this ADR is what makes the addition explicit.

## Open questions (follow-ups, not in this change)

- **Per-tenant mapping.** ✅ *Implemented.* The gateway stamps `ctx.tenantId` onto the
  outbound `ModelRequest` (`gateway.ts` preflight), and the adapter prefers `req.tenantId`
  over the model slug / `ALETHEIA_TENANT`. Asserted by `aletheia.test.ts` ("prefers the
  tenant the gateway stamped over the model slug").
- **Persisting `grounding`.** ✅ *Implemented.* `ai_audit_log.grounding_json` (migration
  `0049_ordinary_diamondback.sql`) stores provenance only — `{epistemicCoverage, state,
  facts[{factId, entity, attribute, source}], contradictions, ood, samplingUsed}` — never
  the fact values, which stay in Aletheia's fact graph (`groundingAuditJson` in
  `gateway.ts`). Asserted by `gateway.test.ts` ("aletheia grounding is audited").
- **Wiring the narrator.** ✅ *Implemented.* `verifyGroundedClaims` (`core/src/narrator-verify.ts`)
  verifies a grounded answer against its own assembled facts (prose numbers must be fact values;
  `ood`/`insufficient` fails closed). `engines/narrator.ts` uses it when `res.grounding` is present
  instead of the snapshot regex gate. Asserted by `narrator-verify.test.ts` and
  `engines/narrator.test.ts` ("verifies a grounded answer against its assembled facts").
- **Self-learning ingest.** ✅ *Implemented.* `engines/aletheia-ingest.ts` posts the tenant's
  grand-total `north_snapshots` (one flat series per metric key, period-ordered) to Aletheia's
  `/api/{tenant}/learn`, wired into the nightly cron after the snapshotter and gated on
  `ALETHEIA_URL`. Asserted by `aletheia-ingest.test.ts`.
- **Brief provenance UI.** ✅ *Implemented.* `GET /v1/north/briefings/:id/grounding`
  (`routes/north.ts`) returns the stored grounding; the NORTH brief (`north-brief.tsx`) renders a
  "grounded" badge with coverage % and fact count (en + ar), asserted by `north-grounding.test.ts`.
- **Still open.** Running an Aletheia instance with insurance-domain knowledge so the facts *are*
  the snapshot values.

## Verification

- `pnpm --filter @lyra/model-gateway test` — `providers/aletheia.test.ts` asserts the proof
  is parsed into `grounding`, `ood`/`insufficient` become `refusal`, and a malformed payload
  fails loudly rather than returning a guessed answer.
- `pnpm --filter @lyra/model-gateway typecheck`.
