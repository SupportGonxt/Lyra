# ADR-0088 — Ask in words compiles to a definition, never to figures; AI is reported through the same semantic layer

**Date:** 2026-09-23
**Status:** Accepted
**Context:** docs/05 §analytics ("ask a question in words → compiled to a visible,
editable query"), docs/17 ANL-009, docs/15 §4 (patterns 6 and 7), CLAUDE.md §3,
§11, §14; `apps/api/src/engines/report.ts`, `apps/api/src/routes/analytics.ts`

## Context

Three things were missing together.

- **No report builder.** `GET /v1/analytics/datasets`
  (`apps/api/src/routes/analytics.ts`, "What a report builder can offer the
  user") had no web caller; `apps/web/app/modules/analytics.ts:9-12` said
  authoring a definition "belongs to a builder screen", and none existed. A
  report could be run and exported but only created through the API.
- **ANL-009 unbuilt.** Nothing turned a question into a definition.
- **AI was not reportable.** `DATASETS` held one AI table (`aiSpend`, over
  `ai_audit_log`). Runs, suggestion outcomes, guardrail trips and eval scores
  were answerable only through the bespoke `/v1/ai/*` endpoints the AI console
  reads, so "is AI any good here, and what does it cost" was not a report
  anyone could build, save or schedule.

docs/15 §4 already has the pattern: **6. Semantic everything** — "natural
language … compiled to visible, editable structured filters — the compilation
shown, so trust builds" — with **7. Explain-on-hover** for the why. No new
pattern is added; this ADR records how the surface maps onto those two and the
decisions the specs leave open.

## Decision

1. **The model names things; it never sees or returns data.** Purpose
   `analytics.ask` (module `analytics`, staff-facing,
   `packages/model-gateway/src/purposes.ts`) is given the caller's catalogue —
   the same `catalogueFor(ctx)` that answers `/datasets`, so it is never shown
   a dataset the builder would not offer — and returns a definition plus a
   one-sentence why. `POST /v1/analytics/ask` runs nothing and writes no
   `report_runs` row; the gateway writes the one `ai_audit_log` row
   (tenant, module, purpose, actor).
2. **One schema.** `ReportDefinitionSchema` moved to
   `packages/core/src/report-definition.ts`. `/run`, `/reports`, `/exports` and
   the ask parser (`parseAnalyticsAsk`) validate against it, so a definition a
   model wrote is held to exactly the bounds a hand-built one is.
3. **Refuse, never guess.** The parser accepts a key, or an exact
   (case-insensitive) label, from the one dataset the reply names; anything else
   — an unknown or cross-dataset key, a bad op, a sort on the period with no
   grain, a missing why — is a 422 `ask_refused` with a reason code. The web
   words the refusal itself from the code; the model's prose (one language,
   unverified) never reaches the page. There is no deterministic fallback,
   unlike `whitespace.brief`: a guessed query shown under a ✦ is worse than
   none.
4. **Loaded, not run.** The compiled definition renders as a quiet ghost line
   under an `AgentBadge` whose `why=` is the model's reason (pattern 7), with a
   link that loads it into the builder. The builder runs a preview only when its
   link says `run=1`; the ask link does not. The reader reads, edits and presses
   Preview. No modal, no toast, no auto-run (CLAUDE.md §11).
5. **Gate.** `/ask` requires `analytics:reports:run`, not a new
   `analytics:ai:invoke`. The call returns a definition over datasets the caller
   may already query, the tenant's AI budget and kill switch still apply in the
   gateway, and a new permission would need a role-table change and a
   resync for every deployed tenant (sighting 9's shape) for no narrower grant.
6. **AI datasets mirror the endpoints they generalise.** `aiRuns` and
   `aiSuggestions` on `ai:runs:read` (what `/v1/ai/suggestions/acceptance`
   gates on — `ai:suggestions:read` is held by every module seat and would
   widen an aggregate across users), `aiGuardrails` on `ai:audit:read` (the
   CRUD read), `aiEvals` on `ai:evals:read`, `aiSpend` unchanged on
   `ai:budgets:read`. Rates are a new pair of registry-owned aggregates,
   `count_if` / `pct_if` with a literal `when` predicate — never request text,
   the same rule as `column`. `api.test.ts` now compiles every metric of every
   dataset, because the column walk cannot see inside a predicate.
7. **The AI operations dashboard is its own screen,** `/admin/ai/analytics`,
   linked from the admin tools list beside the budget and cost explorer — not a
   tab in `/admin/ai/console`. The console is operational control (kill
   switches, autonomy, runs, 1.5k lines); this is read-only reporting gated
   per dataset, and every figure on it is a builder link. It calls only
   `POST /v1/analytics/run`.

## Consequences

- The eval (`packages/model-gateway/evals/analytics-ask`) scores the parser over
  canned replies, the posture every non-live suite in `evals/run.ts` takes. It
  says nothing about how well a real model picks datasets. A live twin in
  `evals/live.ts` is the next step and is deliberately not added here: the
  `eval-live` job gates every push to `main`, and a first live threshold should
  be set from measured runs, not guessed in the PR that introduces it.
- The dashboard runs eleven definitions per view, each an ad-hoc run that writes
  a `report_runs` row. A saved system dashboard read through
  `/dashboards/:id/data` would write none; that needs a seeded dashboard row and
  is left for when the view count makes the rows noise.
- `aiGuardrails` cannot be split by module: `ai_guardrail_events` has no module
  column and the engine does not join. Recorded as a `ponytail:` on the dataset.
- Measure and split labels come from the registry in English where no screen or
  pack word exists; an Arabic reader of the builder sees English measure names
  for most business datasets. Dataset names and every AI figure on the
  dashboard are translated.
- Costs are shown in USD from `cost_micro`, as the cost explorer does.
