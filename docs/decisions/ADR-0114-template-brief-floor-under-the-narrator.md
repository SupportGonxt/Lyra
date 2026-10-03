# ADR-0114 — The morning brief has a template floor under the narrator

Date: 2026-10-03 · Status: accepted

Context: docs/06 J-E1 ("the 7am read"), docs/30 NORTH gap 1, docs/15 §4
(one ✦ per AI artifact), CLAUDE.md rules 3, 7, 14 and "AI features are
eval-first".

## Context

`nightlyBriefing` (`apps/api/src/engines/narrator.ts`) wrote the day's exec
brief only through the model gateway. With no model configured (local,
on-prem) or through an outage, the scheduled tick logged "nightly briefing
failed" and wrote nothing; after a simulated month the newest exec brief was
31 days old and `/north/brief` presented it as the morning's read. A kill
switch or budget refusal was worse: the gateway returns it as a response, and
its text was stored as the brief. The nightly also dated the brief yesterday,
so it narrated the day before yesterday, and it wrote English only.

## Decision

1. **A deterministic template is the floor.** `composeTemplateBrief`
   (`apps/api/src/engines/north-brief-template.ts`) writes the brief from the
   same snapshot the model would read plus the open, unowned anomalies, from
   en and ar catalogues, with numbers, money, durations and dates formatted by
   `Intl` for the brief's locale. It has no industry nouns of its own; metric
   names come from the tenant's definitions in the brief's locale.
   `generateBriefing` falls back to it when the model call throws, refuses,
   errors or answers nothing. The row says `generatedBy: "template"`,
   `aiAuditId: null`, `status: "review"`: its figures are copied from stored
   values, so there is nothing for the numeric-claims verifier to catch. A
   person still publishes it. No column was added; `generated_by` existed.
2. **Only English is narrated by the model.** The narrator's prompt and the
   NORTH eval are English. Any other locale gets the template in that locale
   rather than English prose stored under a locale it is not in. An Arabic
   narration needs its eval case first.
3. **The nightly writes one exec brief per tenant locale, dated today.** In
   the 02:00Z window, just after the snapshotter closes yesterday, NORTH on.
   Locales are `policy.locales` limited to the template's catalogues (English
   when that leaves nothing). Idempotent per (tenant, exec, locale, date), and
   the existing unique key backs that up. Dated today, it narrates yesterday,
   which is the shape of the seed's own briefs.
4. **The screen says what day a brief is from.** `/north/brief` prints the
   brief's date, and says plainly when it is more than a day old. A template
   brief carries no ✦ and says no model wrote it.

## Consequences

- A morning with no model still has a brief in every tenant language.
- `POST /v1/north/briefings/generate` answers 201 with a template brief, not a
  500, when the model is unavailable; the response now carries `generatedBy`,
  and `auditId` may be null.
- The web compares a brief's date with the web clock (or `?asOf=`), not the
  API's simulated clock: on a sim deployment with a clock offset the stale
  notice reads against real time.
