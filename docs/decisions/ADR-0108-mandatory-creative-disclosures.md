# ADR-0108 — Mandatory disclosures on every SIGNAL creative, and no publish without them

Date: 2026-09-28 · Status: accepted

## Context

docs/17 SIG-013 ("mandatory disclosures auto-appended per product line") and
SIG-015 ("no creative can publish without passing pre-flight; bypass is
impossible by configuration"). `compliance_disclosures` existed, but it is the
*presentation log* — a snapshot of wording that was shown — not a place a
tenant configures what must be shown. The creative engine
(`apps/api/src/engines/signal-creative.ts`) and the pre-flight
(`packages/core/src/signal-compliance.ts`) never read any disclosure, and a
creative carried no product line to key one by, so an ad could be cleared in a
regulated market with no mandatory disclosure on it.

## Decision

1. **Where the wording lives.** A new table, `compliance_disclosure_wordings`
   (migration `disclosure_scope`): tenant, product line, locale, key, wording,
   version, status. One *active* row per (product line, locale), enforced by a
   partial unique index. The tenant's compliance team writes the text through
   the generic `/v1/compliance/disclosure-wordings` resource
   (`compliance:disclosure_wordings:read|write`, granted by the existing
   `compliance:*:*` wildcards). The platform never writes regulatory copy; the
   tests use fixture wording. A wording change bumps `version` server-side.
2. **Where the creative says which line it is.** `signal_creatives.product_line`
   (nullable, same migration). `POST /v1/signal/creatives/generate` takes an
   optional `productLine`.
3. **Append deterministically, after generation.** The engine appends the
   active wording for the creative's line *and locale* verbatim after the
   model's copy. No prompt changes, so no eval moves; nothing a model writes can
   drop or paraphrase it. A locale with no wording for the line is not given
   another language's.
4. **The disclosure lane** (`checkDisclosure` / `preflightCreative` in
   `packages/core/src/signal-compliance.ts`), judged on the verbatim substring:
   - wording configured, present → clear;
   - wording configured, absent (including after a person edits it out) →
     **hard block**, reason `disclosure_missing`, status `blocked`;
   - product line named, **no wording configured** → **soft flag**, reason
     `disclosure_unconfigured`, into the human review lane;
   - no product line, tenant has configured any wording → soft flag,
     `disclosure_unscoped`;
   - no product line, tenant has configured none → no lane (pre-ADR behaviour).
   A hard block outranks every soft flag.
5. **No bypass by configuration (SIG-015).** The lane takes the text and the
   configured wording and nothing else — no policy, autonomy level or module
   setting. On the write side it is the creatives resource's `beforeWrite`,
   which `crud.ts` runs *before* the approval gate, so neither an approver nor
   the `autoApprove` allowlist reaches a row it refuses: any write asking for
   `complianceStatus: "passed"` on hard-blocked copy is a 422 with
   `errors: { contentRef: "disclosure_missing" }`, on create and update alike.
   A product line, once set, may change but not be cleared — clearing it would
   turn the hard block into a soft flag. The integration test sets every
   plausible switch (`autoApprove`, `autonomyDefault`, free-form
   `moduleConfig.signal.settings`, a disabled compliance module) and asserts the
   422 still holds.
6. **Unconfigured lines soft-flag rather than pass.** Silence is not
   compliance: a tenant that has not configured a line has not said the line
   needs nothing. The flag puts the creative in front of a human reviewer, and
   that reviewer clearing it (under `signal.creative_publish`) *is* the
   affirmation that none is required. A standing "none required" record per
   line was considered and deferred: it is a configuration row that silences a
   check, which is the shape SIG-015 forbids unless it is itself approved and
   audited, and nothing needs it yet.
7. **Publishing records the presentation.** The transition to `passed` calls
   the same DISCLOSURE-PRESENT engine the compliance route uses
   (`apps/api/src/engines/compliance-disclosure.ts`, extracted from
   `routes/compliance.ts`): a `compliance_disclosures` row with
   `subjectRef: signal_creative:<id>`, `channel: signal`, the wording's hash and
   `wordingRef: compliance_disclosure_wording:<id>@v<version>`, plus the audit
   row, event and non-financial txn. Idempotent per (creative, wording version).
8. **Images are out of the text lane.** An image creative's `contentRef` is a
   file id; there is no copy to carry the wording. Disclosures on imagery are a
   rendering concern for the design set and are not addressed here.

## Consequences

- The studio shows which disclosure (key, version) was appended and, when
  flagged or blocked, the lane's reason in en and ar; the generate form takes a
  product line. Compliance configures wordings under Compliance → Mandatory
  disclosures.
- Existing creatives have no product line and tenants have no wordings, so
  nothing already stored changes lane until a tenant configures one.
- Follow-ups, not built: inheriting the product line from the campaign; a
  picker of configured lines instead of free text; disclosure placement on
  image creatives.
