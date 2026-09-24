# CLAUDE.md — Operating manual for Claude Code on LYRA

You are building LYRA, a multi-tenant AI platform. Read this file fully before
any work. Specs live in /docs; treat them as the source of truth. When a spec is
ambiguous, choose the simplest option consistent with docs/02-architecture.md and
record the decision in docs/decisions/ADR-NNNN.md (create the folder on first use).

## Repository layout (target)

```
/apps
  /web            # React Router v7 (framework mode) on Cloudflare Workers — all web UIs
  /mobile         # Expo (React Native) app
  /api            # Hono on Workers — API gateway + module routers
  /agents         # Durable Objects + Workflows: agent runtime, schedulers
/packages
  /core           # domain logic shared by modules (tenancy, RBAC, audit, events)
  /db             # Drizzle schema + migrations (SQLite dialect: D1 + libSQL)
  /model-gateway  # LLM/provider abstraction (Workers AI, Anthropic, vLLM/Ollama)
  /ui             # Constellation design system (React, Tailwind v4 tokens)
  /sdk            # typed client SDK (generated from OpenAPI) + webhooks helpers
  /config         # eslint, tsconfig, tailwind preset
/infra
  /cloudflare     # wrangler.jsonc per app, Terraform for accounts/zones (optional)
/ops              # on-prem stack (ADR-0010): docker-compose.yml, Caddyfile,
                  # Ollama/vLLM/TEI model services
/docs             # this pack
```

Package manager: **pnpm** (workspaces) + **turbo**. Node 22. TypeScript strict.

## Commands (keep these working at all times)

- `pnpm i` — install
- `pnpm dev` — turbo dev: web + api locally (wrangler dev with local D1/KV/R2)
- `pnpm test` — vitest unit + integration (uses miniflare/workers pool)
- `pnpm e2e` — Playwright against local stack
- `pnpm lint` / `pnpm typecheck`
- `pnpm db:generate` / `pnpm db:migrate` — Drizzle kit
- `pnpm deploy:staging` / `pnpm deploy:prod` — wrangler deploy (CI only for prod)
- `pnpm onprem:up` / `pnpm onprem:down` — docker compose -f ops/docker-compose.yml

## Development method — TDD, non-negotiable

LYRA is built test-first. The order is law:

1. **Acceptance first.** At the start of every milestone, encode that
   milestone's acceptance criteria (module doc §8 + journey J-IDs) as
   *failing* executable tests — Playwright specs tagged `@journey:J-XX` and
   integration specs tagged `@accept:Mx`. This failing suite IS the milestone
   backlog. CI runs it with `--allow-fail=accept` until the milestone closes.
2. **Red → Green → Refactor** for every unit of behaviour. No production code
   without a failing test that demands it. Commits should show test-first
   history (test commit or same-commit test+impl; reviewers reject impl-only
   diffs on new behaviour).
3. **Outside-in double loop:** start from the failing journey/acceptance test,
   drop down into unit cycles (packages/core, db, gateway), surface back up.
4. **AI features are eval-first.** Before writing any prompt, agent, or model
   integration: author the golden set + thresholds in
   packages/model-gateway/evals. The eval is the failing test. Prompt/agent
   changes that don't move a measured eval are refactors and must not change
   eval outputs.
5. **Bugs reproduce before they die.** Every bugfix starts with a failing
   regression test named after the issue.
6. **Contracts are tests.** OpenAPI schemas, event envelopes, webhook payloads
   and the SDK are verified by contract tests (consumer-driven for partner
   surfaces); breaking a contract test means a version bump, never a silent
   change.
7. **Quality ratchets:** mutation testing (Stryker) on packages/core and
   model-gateway with score ≥ 70% and raise-only; coverage is informational,
   mutation score gates. Flaky tests are Sev-2: quarantine + fix within 48h.

Full strategy: docs/13-testing-quality.md. Execution plan and
prompt playbook: docs/24-build-execution.md. Live target: lyra.vantax.co.za. If a spec and its acceptance test
disagree, fix the test to match the spec and note it in the PR — the spec
wins.

## Non-negotiable conventions

1. **Tenancy first.** Every table has `tenant_id`; every query goes through
   `withTenant(db, tenantId)` in packages/core. No raw cross-tenant queries.
2. **One schema, two homes.** Drizzle SQLite dialect only. Anything that works on
   D1 must work on libSQL in Docker. No D1-only SQL features without a shim.
3. **Model access only via packages/model-gateway.** Never call a provider SDK
   directly from app code. Every call carries: tenant, module, purpose, actor,
   and is written to `ai_audit_log`.
4. **Human-in-the-loop:** any action tagged `consequential: true` (pricing,
   claims guidance, regulated advice, outbound send, payment) requires an
   approval step unless tenant policy explicitly automates it AND the action
   type is on the tenant's `auto_approve` allowlist.
5. **Brand tokens, not brand strings.** UI reads name/logo/colors from tenant
   config. Hard-coded "LYRA" in a user-facing surface is a bug.
6. **Events over calls.** Modules integrate through the event bus (Queues topic
   `lyra-events`, envelope in docs/04-api.md §7). Direct cross-module imports
   are forbidden except from packages/core.
7. **RTL + i18n from day one.** All strings via i18n keys (en, ar to start).
   Logical CSS properties only (`margin-inline-start`, not `margin-left`).
8. **Accessibility:** WCAG 2.2 AA. Interactive elements keyboard-reachable,
   focus visible, contrast ≥ 4.5:1 body text.
9. **Migrations are forward-only** and reviewed. Never edit an applied migration.
10. **Secrets** via wrangler secrets / Docker env — never in code or docs.
11. **Ambient AI grammar (docs/15).** AI renders as ghost text, quiet chips
    and background drafts — never modals, never auto-send outside autonomy
    policy. Every AI artifact carries the single ✦ marker and an inspectable
    "why". New AI surfaces must map to a pattern in docs/15 §4 or add one via
    ADR.
12. **Transaction integrity (docs/19).** Anything that changes money or
    contractual state is a transaction with an idempotency key, a state machine,
    approvals and (if financial) balanced double-entry journal lines. Never
    write money-affecting state directly. Ledger invariants are property-tested
    and may not be relaxed to make a test pass.
13. **Self-sufficiency (docs/20).** The business runs inside Lyra. Do not add a
    third-party marketing/production/management tool to fill a gap — build the
    capability. Platform APIs (social networks, ad networks, insurers, PSPs) are
    channels and are allowed; management suites are not.
14. **Domain-pack vocabulary (docs/21).** Never hard-code industry nouns
    ("policy", "premium", "insurer") in UI strings or system prompts. Read them
    from the active domain pack so the same code sells outside insurance.
15. **Build to the seams (docs/16).** Reserved enums, interface seams and
    schema fields for future horizons are load-bearing: implement interfaces
    against the seam (e.g. `Channel`, `IdentityVerifier`, `AutonomyEnvelope`),
    never hard-code today's single case. Removing or bypassing a documented
    seam requires an ADR.

## Definition of done (every PR)

- Typecheck + lint + unit tests green; new logic has tests.
- If UI: story added to the design-system playground; mobile parity noted.
- If API: OpenAPI updated in packages/sdk; breaking changes versioned (/v1).
- If model behaviour: eval case added under packages/model-gateway/evals.
- Audit log entries verified for consequential actions.
- Docs touched if behaviour diverges from /docs (spec-first, code follows).

## Guardrails for you (Claude)

- Do not invent regulatory claims; compliance copy comes from docs/12 only.
- Do not add third-party services beyond the approved list in docs/02 §9
  without an ADR.
- Do not weaken tenancy, audit, or approval flows to make tests pass.
- Prefer boring technology; novelty needs an ADR.
- When context is missing, read the relevant /docs file before asking.

## Build order

Follow docs/14-roadmap.md milestones M0→M6. Do not start a milestone before the
previous one's acceptance checklist passes (checklists are in that file).

## Current status (2026-08-27)

The revenue-lines build (`docs/superpowers/specs/2026-08-16-revenue-lines-full-build-design.md`)
is merged through PR #34, nothing left on a branch. Production answers:
`curl https://api.lyra.vantax.co.za/health` returns 200
`{"ok":true,"environment":"demo",…}` — the path is `/health`, not `/v1/health` —
and `pnpm e2e:live` passed 18/18 against it.

Sightings 9 and 10 are both **fixed and verified live**. `10f858f` shipped the
seeded-persona backfill; `POST /v1/auth/demo/resync-roles` against production
then returned `"created":["hind.saqr@gonxt.ae","yasmin.faris@gonxt.ae"]` —
exactly the two predicted from source — and a second call returned `created:[]`,
so idempotency holds in production and not only in the unit test.
`/v1/auth/demo/personas` returns **18**. `c352551` shipped the three shell i18n
keys and the guard that finds the next one; `/center` now renders `✦ AGENT LOOP`
where it printed the raw key `nav.ai`.

Last full production sweep, 2026-08-27 on `0bb8e16`: **77 routes, 0 unswept**,
five flagged and all five verified false positives at source — `axis.bind` and
`north.admin` are approval/permission keys, `north.metrics.read` an agent tool
name, `signal.budget.moved` and `north.alert.triggered` event envelope `type`
fields on dev screens. Seam 8 holds (`/north/explorer` 200). `pnpm e2e:live`
passed 18/18.

`/v1/orbit/teams` is **not** a defect and never was sighting 9. Authenticated it
answers 200 with the seeded teams, `nameJson` a proper `{en, ar}` object. The
`{"data":[]}` that was recorded here for days was the unauthenticated 401 path,
which the note itself warned proves nothing — and it was then reasoned about
anyway, twice, through two different wrong causes.

Two claims that stood here for days and were both wrong: seed-history run
`32352805879` was recorded as blocked on a `production` Environment review —
it is `"conclusion":"success"`, completed 2026-08-20. And the production deploy
gate was recorded as needing a `workflow_dispatch` and the user's review; that
gate was removed 2026-08-22, `deploy.yml:66-70` says so in its own comment.
Read the workflow before describing what it does.

Production is on `31b88a9` (run 33066869556 green, `pnpm e2e:live` 18/18) and
`4fe7d42` is pushed and building. Everything from the empty-state ratchet
(`0cad1ef`..`61c2745`, 63 screens teaching one action), `9823033` (reference id
on every error state) and dead seam 15 (`d768164` + `8f29bda`) is live.
A push is a production release.

The friendliness pass added two guards worth naming, both the same shape as the
existing source-scanning ones. `31b88a9`: `AgentBadge`'s `why` is optional in
the primitive on purpose, so `components/agent-badge.why.test.ts` walks the real
`.tsx` sources and fails on any badge that neither passes `why=` nor carries a
`ponytail:` comment above it naming what explains instead — **an optional prop
encoding a documented obligation (docs/15 §4) needs a source guard, not a
type**. `4fe7d42`: 434 spec form fields carry 13 hints between them, which is
what makes per-field prose the wrong instrument — **when a field type is entered
in units its label cannot state, the hint belongs on the type**. `hintFor`
(`components/fields.tsx`) covers `json`, `rate` and `ratio` from three
`common.field.hint.*` keys both label resolvers fall through to; `money` is
excluded because every such field is named `…Minor`.

Two friendliness items are closed **by inspection** — do not re-open. Undo is
already honest everywhere: `signal-budget.tsx:399` implements it and every other
mention states plainly the action cannot be undone. And the first-run
affordance exists: `home.tsx:600` computes `barren` and line 992 renders a
titled `EmptyState` with a real door.

Running under a self-paced `/loop` toward the full roadmap (M0-M6) in
production. Loop iteration is autonomous; `pnpm deploy:prod` and any `git push`
stay gated on explicit user confirmation at the moment they would happen.

Changelog, demoted: #23-#26 landed groups A-E (162 commits, +46,782/-355) over
eighteen review rounds — unguarded-`Date`/NaN family closed, mutation score to
76.96% by testing builders and not only parsers (`893dd1f`), `stripFence` ReDoS
killed (`c0a2144`); #27-#29 the Horizon/Instrument UI pass (ADR-0068,
`packages/ui/src/flow.tsx`), ORBIT portals, SCOUT commentary, seeded history,
`/design`, the live quoter (ADR-0069/70); #30-#34 gap-fill and NORTH.

## Operational traps

`pnpm eval` cannot be invoked by script name in a worktree — the guard rejects
any command whose text contains `eval`. Run
`pnpm --filter @lyra/model-gateway exec tsx evals/run.ts`.

The same guard refuses commands it cannot statically prove stay inside the
worktree — compound `git … && …` chains, heredocs feeding `git commit -F -`,
`if`/loop blocks with a redirect — reporting "too complex to verify that it
stays inside the worktree". Use plain separate commands: write a long commit
message to a file, then `git commit -F <absolute-path>`.

Before `pnpm e2e` in a worktree, check nothing already listens on 5173/8797
(`lsof -nP -iTCP:5173 -iTCP:8797 -sTCP:LISTEN`). `reuseExistingServer` is on
locally, so a dev server left by the main checkout is silently reused and the
suite tests *that* tree against a DB this one seeded. It reads as thirteen
unrelated journey failures, not a wrong-server error.

The repo has no required status checks, so `gh pr merge --auto` merges
immediately instead of queuing behind them. Read `gh pr checks` and wait for
green yourself.

`@libsql/client` has **no** default busy timeout: a second writer on the same
`file:` database raises `SQLITE_BUSY` at 0ms rather than waiting. That is the
shape of an e2e spec that passes on a laptop and fails on a loaded CI runner,
and it is now set once in `makeLibsqlDb` (`packages/db/src/client-libsql.ts`)
where all seven callers route through. The knob is the client config field
`timeout`, **not** a URL query parameter — `@libsql/core` rejects an unknown
one outright (`URL_PARAM_NOT_SUPPORTED`, `config.js:52`) and accepts only `tls`
and `authToken`, so `?busy_timeout=5000` breaks every caller including the API
server.

A function returned from a vitest `beforeEach` is that hook's *teardown* and
gets invoked. `beforeEach(() => api.mockClear())` therefore calls the mock, and
a mock whose implementation rejects fails the test with its own rejection —
which reads as the code under test being broken. Use a braced body.

`pnpm test`, `typecheck` and `lint` never bundle, so **none of them can see a
server-only module reaching the client**. `apps/web/app/api.server.ts` is
stripped from the client build only for `loader`/`action`/`middleware`/`headers`;
a route that imports anything from it for use in a *component* fails the build
with "Server-only module referenced by client" and nothing before `pnpm
--filter @lyra/web build` says a word. `api-error.ts` exists for exactly this
(its own header says so) — import `ApiError`, `invalidFields` and `rejectedBy`
from there when the call site is a component. Run the web build before pushing
a route change, not just the three green checks.

`check`'s CI runner has failed `@lyra/model-gateway#test` on four consecutive
PRs (#41-#44, including a docs-only PR touching no source file, and surviving
a re-run on #44) with the identical signature: `Error: [vitest-worker]:
Timeout calling "onTaskUpdate"`, thrown from vitest's own birpc heartbeat
between a worker thread and the main process, while every test in the same
run reports passed (711/711, 26/26 files every time — never a real assertion
failure, never a different count). It reproduces only under `pnpm test`'s full
9-package concurrent turbo run on a loaded CI runner; running
`pnpm --filter @lyra/model-gateway test` alone, locally or as a targeted CI
step, has never reproduced it. This is CPU starvation on the RPC channel
itself, not a slow test — `testTimeout` (see the `SQLITE_BUSY`-shaped fix
above, and `packages/ledger/vitest.config.ts`) does not touch it, because
nothing in a single test is timing out. Confirmed root cause, not fixed:
narrowing this to a specific pool/concurrency knob needs it reproduced under
a measured load, not guessed at from inside an unrelated PR. Treat it as the
known shape of this one flake — 711/711 (or the current total) passed is the
tell — and do not spend more than the one standard re-run confirming it.

**Found, 2026-09-24 (PR #46, which failed it twice).** The load was the tests'
own fixtures. `guardrails.test.ts` built a freshly migrated libsql database
(~500 DDL statements) in a top-level `beforeEach` for all 81 tests, and 77 of
them are pure regex checks that never touch it. That file took 56s under the
concurrent run and `gateway.test.ts` took 44s. The migrated database is now
built only in the describes that use it (`guardrails.test.ts`, `kill.test.ts`).
guardrails dropped from 14.9s to 0.8s on an idle machine, and no assertion
changed. The shape to watch: a migrated-database fixture at file scope charges
every test in the file, and each new migration makes that charge grow.

## The recurring defect: dead seams

A dead seam is a declared contract nothing routes through: a web type assumed
rather than mirrored, a parameter no caller passes, a column holding something
other than what its name says. It tests green because the unit test calls the
function directly and the fixture mocks the assumption instead of the server.
Fix it at the seam every reader routes through, grep the call sites in the same
commit, verify on a deployed environment. Sixteen sightings so far.

1. `apps/web/app/components/whitespace-commentary.tsx`, typed against an assumed
   contract while the API was built in parallel, shared one field with what
   `GET /v1/scout/whitespaces/commentary` returns and rendered `undefined`
   everywhere. A web type mirroring an API type belongs beside a comment naming
   the file it mirrors, its fixture in the server's shape.
2. `91d1085`: `labelsFrom(LABELS)` has taken a domain pack all along; three
   routes called `labelsIn(locale)` and dropped it, so no pack could rename a
   noun on the quote desk, settlement or orbit-dev. A seam keyed `policyNo`
   whose callers spell it `issue.policyNo` is unreachable, not wrongly called.
3. NORTH, twice in one column (#32 `25f3f4f`, #33 `aae8be0`): `narrativeRef` is
   documented as the briefing prose (`packages/db/src/schema/north.ts:55`) but
   rows seeded before `f506bf7` hold a storage key `briefings/<tenant>/<id>.md`
   for which no bucket was ever bound, so the text exists nowhere; the journey
   step printed the key, the brief headlined its `<h1>` with it. The guard is
   now `narrative()` at `apps/web/app/routes/north-shared.tsx:171`, where both
   readers route. That uncovered what it masked (#34 `0536513`): NORTH narrates
   per audience *and* per locale, both screens took `rows[0]` — newest in any
   language — so an English reader got Arabic highlights. `chosen(rows, id,
   locale)` is the shared pick: newest in the reader's language, else newest at
   all, an explicit `?id=` winning. Invisible until the first fix was live.
4. Detail-route sweep, 2026-08-22, against `staging.lyra.vantax.co.za` — then
   serving a hand-deployed build three PRs old, see Deployment: `/admin/staff/:id` rendered
   the literal i18n key `admin.status.active` where the list screen beside it
   translated the same column. Fixed in the shared detail kit (`f4dfaa4`,
   `apps/web/app/routes/detail-kit.tsx`), not in the route that showed it.
5. Same sweep: `/journey/north?productLine=motor` printed a `briefings/….md` key
   as its narrative again and `/journey/north` printed a date as `1,990-08-12`,
   a year comma-grouped as a quantity. Both readers do route through
   `narrative()`, so this is that guard's limit: it decides by the *shape* of the
   value (`/^[\w/-]+\.md$/`), which holds only for shapes it was shown. The
   sharper reason, found later: the build answering that hostname predates the
   guard entirely. A seam guard green in the tree says nothing about the rows
   already in a database, and nothing at all about a hostname serving an older
   build — re-sweep the deployed environment after a contract fix, and confirm
   *which* build answered.
6. `f622a2e`, found by an eleven-persona sweep: `/journey/axis`, `/journey/north`
   and `/journey/scout` served HTTP 500 to every reader who is not a full tenant
   administrator. Journey routes sit outside the module shells on purpose — a
   cross-module journey any signed-in reader can walk — so
   `availableShellsForRoles` never gates them and the API is the only thing that
   says no. All three loaders called `api()` bare, and an `ApiError` is a crash
   to React Router. `asRouteError` (`apps/web/app/api.server.ts:19`) is the seam
   that already existed for exactly this, docstring and all, and
   `orbit-journey.tsx` already routed its three calls through it. Green in tests
   the whole time because unit tests call loaders with an administrator's
   context: the fixture supplied the permission the bug needed absent. When a
   route's failure mode is "the caller lacks a permission", the test has to
   *be* that caller.
7. The ORBIT routing desk printed `[object Object]` where three columns should
   hold text: teams' `nameJson`, team members' `skillsJson`, routing rules'
   `conditionsJson`. `Cell`'s `json` branch already existed and already routes a
   value through `readable()` — locale out of a localised name, join for a list,
   flatten for a small map — added when the customers list printed
   `{"en":"E2E Visitor"}`. These three declared `type: "text"` in `columns`
   while the `fields` entry directly beside them correctly said `"json"`: the
   write side right, the read side wrong, and nothing compared the two because
   both are valid `FieldType`s. The guard is
   `apps/web/app/modules/spec.json-columns.test.ts`, which walks the real
   `WORKSPACES` and fails on any `*Json` column not declared `json` — the shape
   `spec.routes.test.ts` already uses to break on a link with no screen. Two
   lessons worth more than the fix. A seam can be *present, correct and unused*:
   the renderer was right the whole time and no reader reached it, so grep for
   the declarations that should route through a seam, not only for its callers.
   And the route sweep missed all three because `sweep.mjs` signs in as
   `tenant.admin`, which resolves only to the `admin` shell (`lens.ts` — a
   cross-module read deliberately does not imply a shell, ADR-0054 being the one
   named exception), so every `/orbit/*` shell screen answered 403 and was never
   rendered. A sweep's coverage is bounded by its persona's shells; `[object
   Object]` was already one of its own CHECKS patterns and it still saw nothing.
8. `/north/explorer` served HTTP 500 to every reader, on every parameter
   combination, while its four sibling NORTH screens rendered. Its snapshots
   call asked for `limit=${WINDOW * 4}` = 360; `ListQuery.limit` is capped at
   `MAX_PAGE = 200` (`apps/api/src/http.ts:186,218`), so the API answered 400 —
   *not* a truncated page — and `readable()` (`north-shared.tsx`) swallowed only
   403 and 404, so the rethrown `ApiError` reached React Router as a crash. Two
   fixes, one commit: the loader now asks for `MAX_PAGE`, and `readable()`
   swallows any 4xx except 401 (a signed-out reader still needs the login
   redirect; a 5xx still rethrows). Green in CI the whole time because
   `north-explorer.test.ts` does `vi.mock("../api.server")` and resolves it with
   hand-made pages — the fixture supplied the success the bug needed absent, the
   same shape as sighting 6. Two lessons: a caller-side constant that feeds a
   server-side validated bound is a contract, so grep every `limit=` against
   `MAX_PAGE` (explorer was the only one over it); and a status allowlist in a
   swallow-helper is a seam that decides which failures become crashes — write
   it as "what must NOT be swallowed", not as a list of what may.

9. `10f858f`: `hind.saqr` and `yasmin.faris` are in `PEOPLE`
   (`packages/core/src/seed.ts`) and in no deployed tenant. `seed()` refuses a
   second call once "gonxt" exists, `seed-history.yml` backfills trading rows
   only (its own header says so), and nothing else writes staff — so that list
   reaches a deployed tenant **exactly once**, and both personas landed after
   this one was provisioned (`dec6b07` 2026-08-09, `ee2e5e9` 2026-08-10;
   everything from `71acde6` 2026-07-30 is live). `/demo/personas` enumerates
   users, so it can only ever show rows that were written. The seam that
   already answers this staleness three times is
   `/v1/auth/demo/resync-roles` — role permissions, chart of accounts, demo
   admin — and `ensureSeedPeople` is now the fourth beside them. The general
   shape: **a compiled table read only at provisioning time is a seam with one
   delivery**, so ask of every constant in `seed.ts` how a tenant seeded last
   month gets the version in the tree. ROLE-028 (ADR-0025) adds the sharp edge:
   an unscoped `provider.viewer` is a *wider* grant than the seeded one, so a
   backfill that cannot resolve the scope must create nothing.
10. `c352551`: `staff.tsx:488` binds `t = translator(locale)` — the shell
   catalogue — and calls `t("common.default")` and `t("common.choose")`, keys
   in no catalogue in either language, so the invite form's two select
   placeholders printed their own keys. Same shape as sighting 4
   (`admin.status.active`), and invisible to TypeScript because `t` takes a
   string. The guard is in `apps/web/app/i18n.test.ts`: every `t("…")` in a
   file binding `translator(` must exist in `en` (`ar` is already held to en's
   key set by the `Messages` type). It resolves shell-vs-route-local the way a
   reader does — by the name each file binds `translator(...)` to — so a route
   binding its own `labelsFrom(LABELS)` to `t` is correctly out of scope, which
   is what separated these two from four false positives (`north.admin` and
   `axis.bind` are permission scopes, `signal.budget.moved` a webhook topic).
   It found a third on its first run: `nav.ai`, printed in the ✦ eyebrow over
   the command center's own title. Then adding `common.choose` tripped
   `labels.shared.test.ts`, a guard already there, because `fnol-intake.tsx`
   had carried an identical local `choose` — two guards over the same catalogue
   disagreeing is the signal to delete the duplicate, not to rename around it.

11. `dd14993`, found by the rebuilt detail sweep against production: three of
   the five seeded settlements served HTTP 500 on `/ledger/settlements/:id`.
   `statementTable` calls `channelOf(counterpartyRef)`, a 400 on any ref not
   starting `channel:`, and three seeded rows are `counterpartyKind: "insurer"`
   with a `provider:{id}` ref — three provider settlements, three failing
   routes, counted at source rather than inferred. `settlement.tsx:318` carries
   a comment proving the list screen *knows* insurer rows exist, shows them, and
   links to a detail route that crashes on every one. The fix is not to widen
   `channelOf`: commission entries are keyed by `channelId`, so a provider
   settlement genuinely has no lines, and `statementTable` now gates the
   channel-only work on the `PAYABLE_KINDS` seam that already separates money-out
   from money-in. The reusable half is the loader: its swallow allowed 403 only,
   so a 400 became a crash — rewritten as **what must NOT be swallowed** (any
   4xx except 401), which is sighting 8's lesson applying a second time. When a
   list screen displays a row kind its detail path was never built for, the
   comment admitting it is the tell.
12. `dd14993` again: all four file-proxy routes had an *unreachable* error path.
   `apiFetch` throws on a non-2xx (`api.server.ts:67`), so
   `new Response(upstream.body, { status: upstream.status })` could only ever
   see a 2xx — the API's 404 for a missing R2 object became an unhandled
   `ApiError` and the reader got raw `Unexpected Server Error` under a 500.
   `axis-document-file`, `signal-creative-image`, `north-board-file` and
   `case-evidence-download` were identical, so the fix is one `proxyFile` in
   `api.server.ts` beside `fileProxyHeaders`, relaying the status with no body.
   The purest form of the defect yet: a declared contract (`status:
   upstream.status`) that nothing could route through, green in tests because
   every fixture returned 200. Grep for a helper's *throwing* contract, not only
   its return type — a caller reading `.status` off a function that throws on
   the interesting statuses is dead code that looks like error handling.

13. `6b7a794`, the defect from the other direction — a *screen with no link*.
   `/onboarding/:kind/:ref` is a fully implemented checklist that nothing in the
   app opens: every `/onboarding/` hit in the tree is a `/v1/onboarding/...` API
   call. `HIDDEN_ROUTES` (`apps/web/app/routing.ts`) is a map of route to *why it
   never appears in nav*, and most entries answer with a reachability claim —
   this one said "opened from that partner, channel or staff record" — but
   nothing ever verified one. `spec.routes.test.ts` breaks on a link with no
   screen; `routing.reachable.test.ts` is its missing inverse, checking that
   something *builds* each parameterised hidden path (a `:param` route can only
   be reached by code that constructs it, which is the thing that goes missing).
   It holds 13 claims and isolated exactly this one, no false positives. The
   opener is the seam that already existed: `recordLink` (`modules/spec.ts:146`),
   eight tabs already use it, `record.tsx` interpolates `{id}`. Two lessons. A
   guard that only checks one direction of a two-way contract leaves the other
   direction free to rot silently — write the inverse. And when a doc claims more
   than the code delivers, narrow the doc: staff onboarding stays unreachable
   (`/admin/staff` is bespoke, no workspace tab to hang a `recordLink` on), so
   the claim now says partners and channels, which is what the guard can hold.

14. `c5351d3`, the follow-on to sighting 11 and invisible until it shipped: the
   settlement detail loader carried **one flag for two unrelated facts**.
   `may.read` is whether the actor holds `dist:commissions:read` — the same
   scope the API gates `/lines` on (`routes/settlement.ts:64`), so the loader's
   own check was right — but the 4xx swallow returned `{ ...may, read: false }`
   and the render branch `!may.read || !lines` could not separate them. An
   administrator holding all 24 roles was told their roles did not include
   access. The swallow stays (sighting 8's shape is correct); only the lie is
   removed. The second half is the guard: **both sweeps scored this `ok [200]`**,
   because `sweepRoute` classifies on status and greps for non-prose, and a
   denial EmptyState is prose under a 200. The sweep signs in holding all 24
   roles, so a rendered permission wall is by construction a lie about *that*
   reader — `error.forbidden`'s prose is now a CHECK in `sweep-lib.mjs`. The
   general shape: **a boolean that answers two questions will eventually answer
   the wrong one**, and a sweep that classifies on status cannot see a screen
   that fails politely.

15. `d768164` + `8f29bda`, and the first found by asking "what does the API
   send that nothing reads?" rather than by a screen misbehaving. `Problem.errors`
   (RFC 9457, docs/04 §1) is the field-level validation map every API 400
   carries, keyed by the zod path joined with dots — **the same string the form
   posts as `name`** (`apps/api/src/http.ts:33`). It was dead at *both* ends: no
   web screen read it, and no API test asserted it, so a rejected create told the
   actor only that something was wrong and never which input. The narrowing point
   is the general shape behind sightings 8, 11 and 14 too: a loader or action that
   *rebuilds* an `ApiError`'s problem into a fresh literal or flattens it to a
   string is where the contract dies — not the render site, which is merely where
   the loss becomes visible. Here nothing was lost at the narrowing point (twenty
   actions already carried the whole problem through); the gap was that no render
   read it. The fix is at `FieldInput` (`components/fields.tsx`), the one component
   every spec-driven form renders inputs through, which already holds `field.name`
   — one optional prop covers every declared resource in every workspace via
   `module.tsx` and `record.tsx`. Two constraints worth keeping: the map's
   *values* are zod's own English and no API schema overrides them, so they are
   unshowable to an Arabic reader (CLAUDE.md §7) — only the key crosses, the
   wording is the screen's (`error.field`); and `fields.tsx` is deliberately
   translator-free, which is why `invalid` is a function and not the map.
   Bespoke (non-spec-driven) forms — `settings.tsx` 26 Fields, `staff.tsx` 17,
   `onboarding.tsx` 13 — put `name` on the inner `<input>` under a `<Field>`
   wrapper, so they have no shared seam and stay unmarked by choice.

16. Saved views are written, listed and never applied — found by asking what the
   API sends that nothing reads, the same question that found 15.
   `GET /v1/analytics/saved-views` takes a **`?route=` filter**
   (`routes/analytics.ts:658`) and orders **`isDefault` first** (`:662`): that
   pair is not incidental, it is exactly the question a list screen asks. No
   screen asks it. `module.tsx` renders every resource-tab list in the product —
   filters, columns, sort — and contains no reference to saved views, `route=`
   or `isDefault`; the web's only reader is the generic `/analytics/saved-views`
   tab, which lists the rows as records, so a reader can see that a saved view
   exists and can never apply one. The seed makes it concrete: six views, every
   one naming a real resource tab, three `isDefault: true` including the finance
   controller's private reconciliation queue. Recorded in docs/27 as a finding
   rather than fixed — applying `queryJson` is a coherent first step but
   `columnsJson` implies per-user column selection `module.tsx` does not have,
   so it wants a spec update first. One trap for whoever takes it: the `route`
   value is a *resource tab* path (`/ledger/txns`) and not the bespoke screen
   one segment away (`/ledger/transactions`, `ledger-open-txn.tsx`), and nothing
   compares either against the route tree.

The round that found 16 spent most of its time on the **guards themselves**, and
that is the lesson worth keeping: four of the tools written to find dead seams
were dead seams. `routing.reachable.test.ts` matched `opened from|linked from|
reached from` — the passive voice only — while `HIDDEN_ROUTES` writes a detail
route's claim in the active ("**opens** one policy … from the policies list"), so
16 of its 28 in-app claims were never checked; it reported green because it
asserted a floor, `expect(checkable.length).toBeGreaterThan(5)`, and **a floor is
not a contract**. It also never grepped the static half at all, though its own
header said static hrefs are greppable. `sweep.mjs` read one of the two files
that declare routes. `journey-permissions.test.ts` listed its three subjects by
hand and so covered exactly the three screens that already had the bug. The
general shape: **a guard that selects its own subjects — by matching prose, by
reading one source, by a hand-written list — must assert that it selected all of
them.** Partition the population into checked / excluded-for-a-named-reason and
require the leftover bucket to be empty; never assert a count is large enough.

One process lesson from the same round, cheap and repeatedly paid for: a
`pnpm typecheck` run *before* the last edits does not cover them. `9823033` was
committed green on a run that predated three of its own edits and left three
`TS2375` errors behind (`exactOptionalPropertyTypes` is on in the web tsconfig,
so `{ id: string | undefined }` is not assignable to `{ id?: string }`).
Re-run after every edit round, not once per session.

One more, from writing docs/29 rather than from a screen: its draft headline
("every posting hard-codes 5% tax") was wrong because citations inherited from a
summary were never opened — those literals live in `packages/core/src/seed/`
while the engines take `taxPpm` as a parameter all the way down
(`apps/api/src/engines/rating.ts:169`, `packages/ledger/src/recipes.ts:48`).
Open every `file:line` before publishing it.

## Deployment

A push to `main` fires `deploy.yml`: full CI, then **both** deploys — staging
(`staging.lyra.vantax.co.za` / `api-staging.lyra.vantax.co.za`) and production
(`lyra.vantax.co.za`). **lyra.vantax.co.za is production, not staging.** The
`staging` job is `if: github.event_name == 'push'`; the `production` job has
`needs: checks` and `environment: production` and *no* event condition, so it
runs on every green push as well as on `workflow_dispatch`. The required
reviewer that used to gate it was removed 2026-08-22 (`deploy.yml:66-70`); the
Environment's branch policy still restricts deployments to `main`. Both jobs
share concurrency group `deploy-deploy-refs/heads/main`,
`cancel-in-progress: false`, so production queues *behind* staging rather than
racing it.

So a push to `main` is a production release. There is no second gate between
the two, which is exactly why the `git push` confirmation is the one that
matters.

CI has a job that only runs on push, so **a green PR proves less than it
looks**: `eval-live` is `if: github.event_name != 'pull_request'`, reported
"skipping" on #29, then 401'd on `main` and took the staging deploy with it (run
32289549099) because a fallback treated `CLOUDFLARE_API_TOKEN` as a copy of
`CF_AI_TOKEN` — the account id is one value, the token is not, and a
deploy-scoped token cannot call `ai/run`. That fallback is gone (`99c64ab`) and
the gate passes real thresholds on every push. After any push to `main`, read
`gh run view <id> --json jobs`.

Verify a deploy with `pnpm e2e:live` — `playwright.live.config.ts` targets
https://lyra.vantax.co.za, `LIVE_BASE_URL` for staging. Those specs are
read-only by construction; never add a writing spec under `e2e/live`.

**A local `wrangler deploy` outranks the pipeline, and nothing in the pipeline
says so.** For two days `staging.lyra.vantax.co.za` served the *production*
build: both hostnames listed `manifest-f61f016b.js`, `/portal/demo` was 5416
bytes on both, and the chunk staging answered with,
`assets/journey-north-oot-d5sB.js`, still filtered highlights with
`typeof e === "string"` and rendered `{body:t.narrativeRef}` — pre-#32 source.
The staging run for #34 (`32369451060`, head `0536513`) had built
`assets/journey-north-CkYcefhK.js` and deployed version
`30653f65-0091-489e-bbc7-558b0aa42264` at 12:40, and a `curl` on that chunk
returned 302, so it was not in the manifest the hostname served.

The cause was not routing. `wrangler deployments list --name lyra-web-staging`
showed a *newer* version, `66a08a96-46ef-4d4f-b9de-c859937a14df` at 14:20:43,
and `wrangler versions view` on it reported `Source: Unknown (version_upload)`
with the correct staging bindings (`ENVIRONMENT ("staging")`,
`API_ORIGIN "https://api-staging.lyra.vantax.co.za"`). No workflow ran at 14:20
— `gh run list` jumps from 12:33 to the next day — so that version came from
someone's laptop, built from a tree at `ebae5a8`, which is exactly why its
assets matched production's byte for byte. A hand deploy silently reverted
staging past three merged PRs and left a green CI history behind it.

So: deploy staging by pushing to `main`, never by hand, and after any local
`wrangler deploy` check what the hostname then serves. Confirming a *route* is
the wrong first move — `wrangler deployments list` plus `wrangler versions view`
answer "which build is live, and who put it there" in one step, and the bindings
in that output are what prove the hostname is on the worker you think it is.

Four habits that cost. A green deploy job proves an upload happened, not that a
hostname serves it — compare the content-hashed chunk the build printed against
the one the served HTML links. Two SSR pages never `md5`-match, because the CSP
header carries a per-request `nonce-<hex>`; compare byte length instead.
Wrangler truncates its asset listing at 100 `+ /assets/…` lines, so a filename
missing from a log reporting `Uploaded 151 files` is not evidence. And "no later
CI run exists" does not rule out a later deploy: check the platform, not the
pipeline.


## Reference

`ui.md` at the repo root is the full UI inventory — every screen, its route,
layout, loader data, interactions, permission and approval gates, AI surfaces
and i18n/a11y obligations, plus Constellation and the Horizon/Instrument layout
language. Read it before changing a screen; keep it current as you would `/docs`.

`docs/27-feature-gap-register.md` is what eight domain experts found reading the
code as written, closed items marked not deleted; `docs/29-global-launch-readiness.md`
(`6cb9b22`) does the same for selling outside the UAE, `file:line` per claim:
three dead seams (`tenants.region` routes nothing, `invoiceNumber()` is a
reference not a statutory series, no PSP connector on any rail) and three
missing *dimensions* (tax treatment for Europe, tax jurisdiction for the US, a
legal entity to hang an invoice series on). Findings, not backlogs — each item
needs an ADR or spec update first.

`scripts/sweep.mjs` walks the 86 static routes. It signs in as the demo
administrator, reads only, and greps the rendered
`main` for text that is not prose: `[object Object]`, a bare `undefined`/`NaN`,
an untranslated i18n key, a storage key, a comma-grouped year, Arabic prose on
an English session. `SWEEP_BASE` picks the environment; false positives are
permission scopes, curl examples, bilingual-by-design screens, labels like
"Locale: ar", Arabic customer messages in seeded ORBIT threads.

The full false-positive set, from an 18-seat run on 2026-09-18 — 25 flags, all
seven of these, nothing else. Every one is a technical identifier a screen shows
on purpose, in a column whose header says so, and the check trips on them because
a module name is also an i18n namespace: `north.exec` and `north.admin` are role
keys (a saved dashboard's `rolesJson`, the permission grid); `axis.bind` a txn
type on the ledger transactions screen; `ledger.txns` a saved-query key
(`ledger.txns-by-state`) and a saved view's `route`; `north.metrics.read` an
agent tool name on the AI console; `north.alert.triggered` and
`signal.budget.moved` event-envelope `type` fields on dev screens. The last two
of those seven appear only since `/analytics` became a swept route.

76 of those 86 came from the literals in `routes.ts`; the other ten are the
**workspace landing pages**, which the generic `:module` catch-all serves and no
literal declares, so the sweep reported "77 routes, 0 unswept" having never
opened the front door of any workspace — `/analytics` and `/compliance` have no
bespoke screen at all and were swept by nothing. `routePatterns` now unions
`WORKSPACE_PATHS` (`routing.ts`) in. A route list derived from one of two
sources of truth is a dead seam in the tool that hunts for them.

The static sweep also measures **layout** (`layoutFindings`, ui.md §4.1): a
sentence printed twice, data starting below half the viewport, a screen over
four viewports with no in-page nav. It runs at 1440×900 with reduced motion
(the cold open otherwise covers the first capture); `SWEEP_ONLY` narrows it and
`CHROMIUM=/opt/pw-browsers/chromium` points it at a preinstalled browser. It
found 30 screens on its first run; a `Stat` counted as data only once it
carried `data-stat`, so check the detector's selector before a screen.

`scripts/sweep-detail.mjs` **exists** (`2add1ba`, rebuilt on the shared
`sweep-lib.mjs`) — the note that stood here saying it "was never committed and no
longer exists" was wrong, and detail routes are not unswept. It harvests the
routes behind an `:id` by following links rather than hard-coding ids, and now
iterates to a fixpoint (3 hops, capped per pattern) over the whole page rather
than one hop over `main`: 13/38 param patterns and 143 URLs became 22/38 and
282. An "unreached" pattern is not an unreachable screen — a harvest never
clicks, so a Link that appears only once a radar dot is selected
(`/scout/whitespace/:id`) cannot be found this way. `routing.reachable.test.ts`
answers "does anything build this path"; the sweep answers "did a reader walking
from the front door find one"; the two disagreeing is the signal.

`scripts/sweep-personas.mjs` runs the static sweep once per demo seat.
Sighting 7 is about which screens get *rendered*; sighting 6 is the half no
single-seat sweep can see, because the all-roles persona is precisely the one
reader a "500 to everyone who is not an administrator" bug cannot touch. The
per-seat question is therefore not "does it render" but **"when this reader is
refused, is it refused or does it crash"** — a 403 is a pass, a 500 is the
defect. Select a seat with `SWEEP_PERSONA=<email>`; never by the label, which
reads "all 24 roles" only while the seed grants exactly 24 (a fresh local seed
grants 25, and matching the text hung the sweep on a locator timeout that reads
as a broken login page).

`innerText` returns text as *rendered*, so a Constellation `Eyebrow` (uppercased
by CSS `text-transform`) reads back `AGENT LOOP`, not `Agent loop`. Asserting
the source casing says "the fix is not deployed" about a screen that is showing
it. Match case-insensitively when checking a live render against a catalogue
string.

`innerText` also means a sweep sees only what a *reader* sees, which is why the
permission-wall CHECK carries one documented exception: `/platform`. That
check's premise is "this persona holds every role, so a wall is a lie about it",
and the demo seat holds every **tenant** role, not every role — `me.ts:451`
gates the `/platform` rail item on `admin:diagnostics:read`, which `rbac.ts`
grants to `platform.*` only. The nav never offers it to a tenant reader and the
screen refusing it agrees.
