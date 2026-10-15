# Architecture decision records

A record of decisions that diverge from `/docs`, add something the specs did not
sanction, or leave a question deliberately open. The specs stay the source of
truth; these files say where the code does not match them and why.

## When an ADR is required

CLAUDE.md names five triggers. If any applies, the PR does not land without one.

1. **A spec is ambiguous.** "When a spec is ambiguous, choose the simplest
   option consistent with docs/02-architecture.md and record the decision in
   docs/decisions/ADR-NNNN.md" (CLAUDE.md:4-6).
2. **A new AI surface.** "New AI surfaces must map to a pattern in docs/15 §4 or
   add one via ADR" (CLAUDE.md §11).
3. **A seam is removed or bypassed.** "Removing or bypassing a documented seam
   requires an ADR" (CLAUDE.md §15).
4. **A third-party service beyond the approved list.** "Do not add third-party
   services beyond the approved list in docs/02 §9 without an ADR"
   (CLAUDE.md, Guardrails).
5. **Novelty.** "Prefer boring technology; novelty needs an ADR"
   (CLAUDE.md, Guardrails).

An ADR is also the right place for a decision that is genuinely the product
owner's to make. Record the options and the trade-offs, mark the status `open`,
and do not pick.

## Numbering and format

- `ADR-NNNN-kebab-case-title.md`, zero-padded to four digits, allocated
  sequentially. Numbers are never reused, even if an ADR is superseded.
- Front matter: `Status`, `Date`, `Context` (the spec sections and CLAUDE.md
  clauses it touches), then `## Context`, `## Decision`, `## Consequences`.
- Statuses: `accepted`, `open` (the decision is not made), `superseded by
  ADR-NNNN`, `rejected`. Never delete an ADR — supersede it.
- Every factual claim about the code carries a `path:line` reference.
- Consequences include the negative ones. An ADR that only lists benefits is
  marketing, not a record.
- Compliance claims come from docs/12 only (CLAUDE.md, Guardrails). Quote it or
  say nothing.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](ADR-0001-saml-signature-verification.md) | SAML is a seam, not an implementation | accepted |
| [0002](ADR-0002-compliance-run-endpoints.md) | Screening, evidence export and retention are runs, not forms | accepted |
| [0003](ADR-0003-flat-url-scheme.md) | Flat `/{module}/{resource}/{id}` URLs, no `/m/` prefix | accepted |
| [0004](ADR-0004-react-router-8.md) | React Router 8, not 7 | accepted |
| [0005](ADR-0005-root-is-a-dashboard.md) | `/` is a dashboard, not a redirect into a module | accepted |
| [0006](ADR-0006-actor-columns-stamp-creation-only.md) | `actorColumns` stamps creation only, never a later action | accepted |
| [0007](ADR-0007-ai-suggestions-read-gates-writes.md) | `ai:suggestions:read` gates the suggestion writes too | accepted, with known debt |
| [0008](ADR-0008-finance-roles-and-suggestion-telemetry.md) | Finance roles can invoke LEDGER agents but cannot report on them | **open — question for the product owner** |
| [0009](ADR-0009-no-charting-library.md) | No charting library; SVG polyline and meter instead | accepted for now |
| [0010](ADR-0010-onprem-stack-lives-in-ops.md) | The on-prem stack lives in `ops/`, and there is no `infra/` | accepted |
| [0011](ADR-0011-nav-rail-text-labels.md) | The navigation rail carries text labels | accepted |
| [0012](ADR-0012-autopilot-bound-check-is-amount-only.md) | SIGNAL autopilot's bound check is amount-vs-bound only | accepted |
| [0013](ADR-0013-delete-exempt-records-use-state-transitions.md) | Six resources are delete-exempt by design; a `status`/`state` column is the only way out | accepted |
| [0014](ADR-0014-orbit-journey-builder-scope.md) | ORB-050 visual journey builder is out of scope for this go-live; ORB-051's frequency-cap floor is fixed instead | accepted |
| [0015](ADR-0015-signal-creative-generation-scope.md) | SIGNAL creative-variant generation wired to a route; Meta/Google publish deferred | accepted |
| [0016](ADR-0016-scout-wording-differ-scope.md) | SCOUT wording differ takes plain text; PDF extraction deferred | accepted |
| [0017](ADR-0017-north-chart-annotations-scope.md) | NORTH briefing/boardpack routes wired; Metric Explorer chart annotations deferred | accepted |
| [0018](ADR-0018-seam-hx-contract-tests.md) | SEAM-Hx: seam interfaces + `@seam:Hx` contract tests | accepted |
| [0019](ADR-0019-detox-onprem-live-execution-scope.md) | Mobile Detox and on-prem docker-compose: live execution deferred to a human operator | accepted |
| [0020](ADR-0020-signal-autopilot-holdout-duration-scope.md) | SIGNAL budget-autopilot 14-day holdout run: live-duration claim deferred to staging sign-off | accepted |
| [0021](ADR-0021-budget-counter-do-deferred.md) | BudgetCounter DO stays a reserved seam; D1-row budget enforcement is the real thing for go-live | accepted |
| [0022](ADR-0022-domain-pack-vocabulary-web-labels.md) | Domain-pack vocabulary substitutes at web label resolution | accepted |
| [0023](ADR-0023-role-granting-requires-holding-the-bundle.md) | Role-granting requires holding the bundle you grant | accepted, one follow-up unresolved |
| [0024](ADR-0024-north-metric-snapshotter-compute-registry.md) | NORTH Snapshotter computes metrics via a typed registry, not by executing `definition_sql_ref` | accepted, two formulas unresolved |
| [0025](ADR-0025-rbac-scope-provider-identity-for-role-028.md) | Scoping `provider.viewer` (ROLE-028) to its own provider org | **proposed — question for the product owner** |
| [0026](ADR-0026-visual-system-replacement.md) | Replace "Deep Field" palette/type with the mockup visual system | accepted, implemented |
| [0027](ADR-0027-impersonation-session-swap.md) | Impersonation is a time-boxed session swap, not a new authority | accepted |
| [0028](ADR-0028-feature-flags-global-table.md) | Feature flags are the first platform-global table | accepted |
| [0029](ADR-0029-platform-staff-cross-tenant-pattern.md) | Platform staff cross-tenant reads reuse the scheduler's per-tenant loop | accepted |
| [0030](ADR-0030-public-portal-surface.md) | A public, unauthenticated comparison-site surface | accepted |
| [0031](ADR-0031-nav-landmark-and-where-overlay.md) | Keep the persistent nav landmark; the design's "Where" overlay becomes ⌘K's first block | accepted, implemented |
| [0125](ADR-0125-a-placement-names-its-licence.md) | A placement names the market and the licence it was made under | accepted |
| [0127](ADR-0127-a-coverage-gap-and-a-coverage-term-are-two-facts.md) | A coverage gap and a coverage term are two facts, not one column | accepted |
| [0128](ADR-0128-a-contract-records-the-market-it-was-placed-in.md) | A contract records the market it was placed in | accepted |

*(0032–0124 are not indexed here; the table stopped being maintained at 0031.)*

## Spec edits these ADRs imply

Several ADRs record that a spec is now wrong. Per CLAUDE.md's definition of done
("Docs touched if behaviour diverges from /docs — spec-first, code follows"),
these edits are outstanding:

- docs/07 §3 — labelled rail, not icon-collapsible (ADR-0011); flat URL scheme,
  not `/m/{module}/{area}/{id}` (ADR-0003); `/` is a dashboard, not a per-role
  landing redirect (ADR-0005).
- docs/07 §2 — `ChartFrame`/echarts is not built (ADR-0009).
- CLAUDE.md:12, README.md:44, docs/IMPLEMENTATION.md:90 and :769-771 — React
  Router 8, not v7 (ADR-0004).
- CLAUDE.md:23-25 and :40, docs/11 §1, docs/IMPLEMENTATION.md:94 and :122,
  `.github/workflows/security.yml:95` — `ops/`, not `infra/onprem/`
  (ADR-0010).
