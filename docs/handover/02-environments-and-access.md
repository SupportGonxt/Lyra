# 02 — Environments and Access

**Audience:** anyone who needs to run, reach, or deploy LYRA.
**Read [`01-system-overview.md`](01-system-overview.md) first** — this document
assumes you know what `lyra-api` and `lyra-web` are.

Describes commit `c7f1f57` on `main` (2026-08-18). Previous revision described
`8afd07d` (2026-08-13); [`README.md` §7](README.md#7-revision-history) lists what
changed in between, and which work is still on unmerged branches.

> **No secret values appear in this document, and none should ever be added to
> it.** Every secret below is named, and the command that sets it is given. The
> values live in Cloudflare (as worker secrets), in GitHub (as Actions secrets),
> or in an operator's `.env` file on the on-prem host. If you need a value, ask
> the account owner — see §8.

---

## 1. The environments at a glance

| Environment | URL | Deploy command | Who can deploy |
|---|---|---|---|
| **Local dev** | <http://localhost:5173> (web), <http://localhost:8787> (API, wrangler default) | `pnpm dev` | Anyone with the repo |
| **Local on-prem twin** | `https://${LYRA_DOMAIN}` via Caddy (whatever you set in `ops/.env`) | `pnpm onprem:up` | Anyone with Docker |
| **E2E / test stack** | <http://localhost:5173> web, <http://localhost:8797> API | `pnpm e2e` (starts and stops it) | Anyone with the repo |
| **Staging** | <https://staging.lyra.vantax.co.za> · API <https://api-staging.lyra.vantax.co.za> | Automatic on push to `main` (`.github/workflows/deploy.yml`); manually `pnpm deploy:staging` | Anyone who can merge to `main`; manual deploy needs a Cloudflare token or `wrangler login` |
| **Production** | <https://lyra.vantax.co.za> · API <https://api.lyra.vantax.co.za> | GitHub Actions `deploy` workflow, **manual dispatch only**; manually `pnpm deploy:prod` | Dispatch requires approval from `Reshigan` on the `production` GitHub Environment, branch `main` only |

Worker, database and bucket names are fixed by the wrangler configs and must not
be renamed casually — CI, the migration commands and the DNS routes all key off
them:

| | Production | Staging |
|---|---|---|
| API worker | `lyra-api` | `lyra-api-staging` |
| Web worker | `lyra-web` | `lyra-web-staging` |
| D1 database | `lyra` | `lyra-staging` |
| Queue | `lyra-events` | `lyra-events-staging` |
| R2 buckets | `lyra-files`, `lyra-exports`, `lyra-logs` | same with `-staging` |
| Vectorize | `lyra-vec-kb`, `lyra-vec-market`, `lyra-vec-convo` | same with `-staging` |
| Cron | `*/5 * * * *` | `*/15 * * * *` |

Both accounts have `workers_dev: false` — the `*.workers.dev` hostnames are dead
surface. DNS cutover for both custom domains was confirmed live on 2026-08-10.

---

## 2. Local development

### 2.1 First run

```sh
corepack enable                # pnpm version is pinned by packageManager
pnpm install
cp .env.example .env.local     # set AUTH_SECRET at minimum
pnpm dev                       # turbo dev: wrangler dev for apps/api, react-router dev for apps/web
```

`pnpm dev` runs `turbo run dev`, which fans out to `wrangler dev` for
[`apps/api`](../../apps/api) and `react-router dev` for
[`apps/web`](../../apps/web). **No Cloudflare account is required** — `wrangler
dev` uses local simulators for D1, KV, R2, Queues and Durable Objects, stored
under `.wrangler/` in the repo. Delete that directory to reset local state.

Two routes need no credentials and are the fastest way to confirm the API is up:

```sh
curl http://localhost:8787/health        # {"ok":true,"environment":"...","ts":...}
curl http://localhost:8787/openapi.json
```

### 2.2 Database and seed data

Local schema work uses libSQL as a plain file, not the wrangler simulator:

```sh
pnpm db:generate                                  # drizzle-kit generate -> packages/db/migrations
LIBSQL_URL=file:./.data/lyra.db pnpm db:migrate   # apply them
DATABASE_URL=file:./.data/lyra.db pnpm seed       # seed the GONXT demo tenant
```

Note the two different variable names for the same connection string: drizzle
reads `LIBSQL_URL`, the seed CLI
([`packages/core/src/seed-cli.ts`](../../packages/core/src/seed-cli.ts)) reads
`DATABASE_URL` (and `DATABASE_AUTH_TOKEN`). This is deliberate and is documented
in [`scripts/lyra-onprem.ts`](../../scripts/lyra-onprem.ts), which sets both.

**Migrations are forward-only. Never edit one that has been applied.**

### 2.3 Tests

```sh
pnpm test        # vitest across the workspace
pnpm typecheck   # tsc --noEmit per package
pnpm lint        # eslint — see the known failure below
pnpm check       # all three in order, the same gates as CI
pnpm e2e         # Playwright: wipes, migrates and seeds a temp DB, then runs the journeys
pnpm eval        # model-gateway golden-set evals
pnpm mutation    # Stryker on packages/core and packages/model-gateway
pnpm smoke:staging  # hits live staging, see §4.4
```

`pnpm e2e` runs [`e2e/global-setup.ts`](../../e2e/global-setup.ts) first (which
resets the fixture database) and then Playwright, which starts its own API on
port **8797** and web on **5173** — see
[`playwright.config.ts`](../../playwright.config.ts) and
[`e2e/env.ts`](../../e2e/env.ts). It does not touch your `pnpm dev` stack's data.

**Known failure: `pnpm lint` currently fails in every package.** ESLint 9
resolves its flat config from the package it is invoked in and only
[`packages/config`](../../packages/config) has an `eslint.config.js`. This is a
recorded gap in the root [`README.md`](../../README.md), not a broken checkout.
Do not "fix" it by disabling the gate.

---

## 3. The on-prem twin (local or customer-hosted)

The Docker stack is [`ops/docker-compose.yml`](../../ops/docker-compose.yml).
There is no `infra/onprem/` and never will be — ADR-0010. Older text referring
to it was corrected 2026-08-27; `docs/IMPLEMENTATION.md` still shows the old
path where it quotes the M0-era `package.json`, which is a record of what was
written then, not a live instruction.

```sh
pnpm lyra onprem init          # writes ops/.env from .env.example, generating fresh secrets
$EDITOR ops/.env               # set LYRA_DOMAIN, APP_ORIGIN, ACME_EMAIL
pnpm onprem:up                 # docker compose -f ops/docker-compose.yml up -d
pnpm lyra onprem migrate       # drizzle migrations against LIBSQL_URL
pnpm lyra onprem seed          # seed the GONXT demo tenant (--password to override)
pnpm lyra onprem smoke         # check llm / llm-vllm / embed reachability + one chat round trip
pnpm onprem:down               # stop it
```

`pnpm lyra onprem init` generates values for `AUTH_SECRET`,
`MINIO_ROOT_PASSWORD` and `RENDER_TOKEN` and refuses to overwrite an existing
`ops/.env` — see `GENERATE` in
[`scripts/lyra-onprem.ts`](../../scripts/lyra-onprem.ts). `ops/.env` is
gitignored (`.env` and `.env.*` are excluded in
[`.gitignore`](../../.gitignore)); it must never be committed or pasted into a
ticket.

The `migrate` service runs migrations against libSQL before `app` and `worker`
start, so the explicit `onprem migrate` above is only needed when you are
running the stack against an external database. **Only `caddy` publishes a
port**; every other service stays on the internal Docker network.

Optional profiles:

```sh
docker compose -f ops/docker-compose.yml --profile gpu up -d            # vLLM instead of Ollama
docker compose -f ops/docker-compose.yml --profile observability up -d  # bundled OTEL stack
```

Upgrade path is pull tag → migrate → rolling restart; the app is stateless.

**Current on-prem limitations** (from the root [`README.md`](../../README.md)
and the `ponytail:` notes in
[`apps/api/src/node.ts`](../../apps/api/src/node.ts)): `redis`, `minio`,
`qdrant` and `render` are in the compose file but nothing in `apps/api` calls
them yet. Because the KV stand-in is an in-process `Map`, **run exactly one
`app` replica** until Redis is wired, or login throttling counts per container
instead of per estate.

---

## 4. Cloudflare: staging and production

### 4.1 What deploys automatically

[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml):

- **`checks`** — calls [`ci.yml`](../../.github/workflows/ci.yml) via
  `workflow_call` with `secrets: inherit`. That is the full gate:
  lint, typecheck, test, web build, evals, e2e, mutation.
- **`staging`** — runs on every push to `main`, after `checks`. Uses the
  `staging` GitHub Environment. Applies `wrangler d1 migrations apply
  lyra-staging --env staging --remote`, then deploys the API, then the web
  worker.
- **`production`** — `workflow_dispatch` only. Uses the `production` GitHub
  Environment, which requires a review from `Reshigan` and restricts deploys to
  the `main` branch. Applies `wrangler d1 migrations apply lyra --remote`, then
  `wrangler deploy`, then `pnpm --filter @lyra/web run deploy`.

`can_admins_bypass` on the production environment is still `true` — a repo-admin
override that is not removable on the current plan tier. Treat the approval gate
as procedural, not cryptographic.

### 4.2 Deploying by hand

Only do this when CI cannot. You need either `wrangler login` (an OAuth session
tied to your Cloudflare account) or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in your environment.

```sh
# staging
cd apps/api
pnpm exec wrangler d1 migrations apply lyra-staging --env staging --remote
pnpm exec wrangler deploy --env staging
cd ../web && pnpm run deploy:staging

# or both workers at once, from the repo root
pnpm deploy:staging

# production — migrations first, always
cd apps/api
pnpm exec wrangler d1 migrations apply lyra --remote
pnpm exec wrangler deploy
cd ../web && pnpm run deploy

# or from the repo root
pnpm deploy:prod
```

The web deploy is `pnpm build && wrangler deploy -c build/server/wrangler.json`
— React Router emits its own wrangler config into `build/server/`, so you cannot
deploy `apps/web` without building first. `deploy:staging` sets
`CLOUDFLARE_ENV=staging` before the build for the same reason.

### 4.3 Known deploy problem — read before your first push

The `staging` job in CI has been **failing since the CI Cloudflare API token
lost two scopes**. The error is:

```
A request to the Cloudflare API (/zones/.../workers/routes) failed.
Authentication error [code: 10000]
```

The token is missing **Zone → Workers Routes → Edit** and **Zone → Read**. The
current workaround has been deploying staging from the maintainer's local
`wrangler` OAuth session, which carries both. **This is a workaround, not a
fix** — until the CI token is re-scoped, every push to `main` leaves staging
stale behind a green `checks` run. Full detail in
[`docs/25-go-live-checklist.md`](../25-go-live-checklist.md) §4.

### 4.4 Verifying a deploy

```sh
curl https://api-staging.lyra.vantax.co.za/health
curl https://api.lyra.vantax.co.za/health
pnpm smoke:staging     # scripts/lyra-staging.ts
```

`pnpm smoke:staging` does unauthenticated `api:health`, `web:root-redirect` and
`web:login` checks, then signs in and does one authenticated read per module
(AXIS, ORBIT, SIGNAL, SCOUT, NORTH, LEDGER, COMPLIANCE) plus the approvals gate
and the analytics export surface. There is also
`pnpm e2e:live` ([`playwright.live.config.ts`](../../playwright.live.config.ts))
for running the Playwright journeys against a deployed environment.

---

## 5. Where configuration lives

**Unchanged since the first edition of this pack.** Neither wrangler config, nor
the on-prem compose stack, nor the secret list moved between `a295218` and
`c7f1f57` — the work in that window was web screens and ledger revenue lines,
and none of it added a binding, a var or a secret. If you read this section on
2026-08-13 you can skip it.

| What | Where | Notes |
|---|---|---|
| Worker bindings, vars, routes, crons (API) | [`apps/api/wrangler.jsonc`](../../apps/api/wrangler.jsonc) | Production at the top level, staging under `env.staging` |
| Worker bindings, vars, routes (web) | [`apps/web/wrangler.jsonc`](../../apps/web/wrangler.jsonc) | Only three vars; the web worker holds no secrets |
| The binding contract in code | [`apps/api/src/env.ts`](../../apps/api/src/env.ts) | The `Env` interface. Read this to know what a binding is *for* |
| Local dev env | `.env.local` (gitignored), keys listed in [`.env.example`](../../.env.example) | |
| On-prem env | `ops/.env` (gitignored), generated by `pnpm lyra onprem init` | Compose fails hard (`:?`) if a required key is missing |
| CI secrets | GitHub repo settings → Secrets and variables → Actions | Only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| Zone/account-level Cloudflare config | [`infra/cloudflare/`](../../infra/cloudflare) | Terraform. **Status: drafted, never applied.** R2 lifecycle, WAF, Turnstile |
| Per-tenant configuration | The database (brand, locales, autonomy policy, domain pack, entitlements) | Changed through the app's Settings and Platform Admin surfaces, not through config files |

Two things worth knowing about the vars:

- **Production `apps/api` runs `ENVIRONMENT: "demo"`, deliberately.** That
  un-gates the one-click persona sign-in, the demo clock and the reseed routes
  (`demoOnly()` in [`apps/api/src/auth.ts`](../../apps/api/src/auth.ts) throws a
  404 only when `ENVIRONMENT` is `"production"`). This is correct while the
  deployment is a showcase carrying seeded data. **The day a real tenant lands
  on it, flip that var to `"production"` and redeploy.** Password sign-in is
  unaffected either way. Tracked as an open item in
  [`docs/25-go-live-checklist.md`](../25-go-live-checklist.md) §6.
- The `apps/web` `ENVIRONMENT` var says `"production"` and is currently read by
  nothing outside tests. Do not use it to infer the API's mode.

---

## 6. Secrets

**Never write a secret value into this repository, a ticket, a chat message, or
this pack.** Everything below is a *name*.

### 6.1 Cloudflare worker secrets (`lyra-api` only)

Set with `wrangler secret put`, never in `wrangler.jsonc` — the day one lands in
that file it is in git.

```sh
cd apps/api
pnpm exec wrangler secret put ANTHROPIC_API_KEY --env staging
pnpm exec wrangler secret put ANTHROPIC_API_KEY            # production
pnpm exec wrangler secret list --env staging               # names only, never values
```

| Secret | Purpose | Consequence if missing |
|---|---|---|
| `FIELD_KEY` | Field-level encryption for regulated PII (ADR-0032, docs/12 §1) | `fieldKey()` in [`env.ts`](../../apps/api/src/env.ts) throws — the write fails rather than storing an Emirates ID in the clear. **Set on both staging and production as of 2026-08-10** |
| `ANTHROPIC_API_KEY` | The `anthropic` model-gateway provider | That provider is unavailable; tenants fall back to Workers AI |
| `OPENAI_COMPAT_API_KEY` | The `openai-compat` provider, when the endpoint requires auth | Same |
| `TURNSTILE_SECRET` | Verifies Turnstile challenges on the two public forms (portal lead capture, public DSAR intake) | No secret, no challenge — the app degrades silently by design ([`apps/api/src/turnstile.ts`](../../apps/api/src/turnstile.ts)). Not currently set; the Terraform that provisions the widget has never been applied |

`FIELD_KEY` was generated with `openssl rand -base64 32` piped into `wrangler
secret put`. Use the same shape if it is ever rotated, and rotate it only with a
re-encryption plan — existing ciphertext does not re-key itself.

The web worker has **no** secrets. It never talks to a provider, only to the API
over a session cookie the browser owns.

### 6.2 GitHub Actions secrets

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Every `wrangler` step in `deploy.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | Same |

Worker runtime secrets are **not** GitHub secrets. They are set out of band with
`wrangler secret put`, which is why `deploy.yml` carries a standing instruction
not to add `set -x`, `echo` or `--verbose` to its steps.

`CLOUDFLARE_API_TOKEN` is currently flagged for rotation
([`docs/25-go-live-checklist.md`](../25-go-live-checklist.md) §4) *and* is
missing the two scopes described in §4.3. Rotating it is the natural moment to
re-grant them.

### 6.3 On-prem secrets (Docker env)

Set in `ops/.env`, consumed by [`ops/docker-compose.yml`](../../ops/docker-compose.yml).
The three the CLI generates are marked; the rest are operator-supplied.

| Key | Notes |
|---|---|
| `AUTH_SECRET` | Generated by `lyra onprem init`. Compose hard-fails without it. Note: nothing in `apps/api` reads it today — sessions are opaque tokens hashed into the `sessions` table, not HMAC-signed — so it is currently a reserved requirement, not a live one |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Password generated. Compose hard-fails without either |
| `RENDER_TOKEN` | Generated. Auth for the browserless render service |
| `LIBSQL_AUTH_TOKEN` | Optional; empty by default for the in-stack libSQL |
| `OPENAI_COMPAT_API_KEY` | Optional; the in-stack `llm` service needs none |
| `ANTHROPIC_API_KEY` | Only if an on-prem tenant is allowed to reach a hosted provider, which defeats the point of on-prem for most customers |
| `LYRA_LICENCE` | Licence token, if issued |

Non-secret but hard-required: `LYRA_DOMAIN`, `APP_ORIGIN`, `ACME_EMAIL`. The
full key list is [`.env.example`](../../.env.example).

### 6.4 What to do if a secret leaks

Rotate first, investigate second. `wrangler secret put` with a new value takes
effect on the next request without a redeploy. Cloudflare API tokens are rotated
in the Cloudflare dashboard and then updated in the GitHub Actions secret. For
an on-prem estate, edit `ops/.env` and restart the `app` and `worker` services.
Then follow the incident path in
[`03-operations-runbook.md`](03-operations-runbook.md).

Note that the model gateway already redacts Cloudflare, Anthropic, OpenAI and
AWS token shapes, bearer tokens, private keys and JWTs *before* a prompt reaches
a provider ([`packages/model-gateway/src/scrub.ts`](../../packages/model-gateway/src/scrub.ts)),
flagging `secret_in_prompt` in the audit log. A `secret_in_prompt` flag in the
AI audit log is a leak report — treat it as one.

---

## 7. Demo and seed users

### 7.1 The GONXT tenant

Every environment that has been seeded carries one fictional tenant, **GONXT**,
created by `seed()` in
[`packages/core/src/seed.ts`](../../packages/core/src/seed.ts). Its slug is
`gonxt` and every user's email is `<first>.<last>@gonxt.ae`.

| Email | Name | Role key |
|---|---|---|
| `amina.saleh@gonxt.ae` | Amina Saleh | `tenant.admin` |
| `khalid.rashed@gonxt.ae` | Khalid Al Rashed | `tenant.compliance` (locale `ar` — use this account to test RTL) |
| `ziad.habsi@gonxt.ae` | Ziad Habsi | `tenant.admin` |
| `asma.qasim@gonxt.ae` | Asma Qasim | `tenant.compliance` |
| `layla.hassan@gonxt.ae` | Layla Hassan | `axis.agent` |
| `omar.farouk@gonxt.ae` | Omar Farouk | `axis.lead` |
| `suhail.hamdan@gonxt.ae` | Suhail Hamdan | `axis.admin` |
| `sara.nasser@gonxt.ae` | Sara Al Nasser | `orbit.agent` |
| `yusuf.karim@gonxt.ae` | Yusuf Karim | `orbit.retention` |
| `dana.aziz@gonxt.ae` | Dana Aziz | `orbit.partners` |
| `hind.saqr@gonxt.ae` | Hind Al Saqr | `orbit.admin` |
| `noor.jamal@gonxt.ae` | Noor Jamal | `signal.lead` |
| `kareem.shamsi@gonxt.ae` | Kareem Shamsi | `signal.admin` |
| `tariq.mansour@gonxt.ae` | Tariq Mansour | `scout.lead` |
| `basma.darwish@gonxt.ae` | Basma Darwish | `scout.admin` |
| `hala.zayed@gonxt.ae` | Hala Zayed | `north.exec` |
| `rana.hadid@gonxt.ae` | Rana Hadid | `north.analyst` |
| `faisal.omar@gonxt.ae` | Faisal Omar | `finance.controller` |
| `nadia.rahman@gonxt.ae` | Nadia Rahman | `finance.controller` |
| `mona.idris@gonxt.ae` | Mona Idris | `finance.analyst` |
| `raed.samir@gonxt.ae` | Raed Samir | `dev.admin` |
| `yasmin.faris@gonxt.ae` | Yasmin Faris | `provider.viewer` |

There are **two** finance controllers on purpose: money-out is dual control, and
you cannot demo or test a four-eyes approval with one account. The same reason
puts `axis.admin` beside `axis.lead`: the lead requests binds, endorsements and
claim settlements, and may not decide his own under dual control. Every
dual-control gate has two seeded deciders for the same reason — the second
tenant admin, compliance officer and the SIGNAL and SCOUT admins are there so
a requester is never the only one who can approve (ADR-0116,
`packages/core/src/approvals.deciders.test.ts`).

Twelve of these are also fixed constants for the automated journeys — see
`PERSONAS` in [`e2e/env.ts`](../../e2e/env.ts).

### 7.2 The seeded password

All seeded users share one password, defined as `DEFAULT_PASSWORD` in
[`packages/core/src/seed.ts`](../../packages/core/src/seed.ts). Read it from
that constant; it is not reproduced here.

Two safeguards are built in:

- `seed()` **refuses to run against a `production` environment unless an
  explicit password is passed** — it throws "refusing to seed production with
  the built-in demo password".
- The password is overridable, "so a real deployment never ships a known
  password": pass `SEED_PASSWORD` to the CLI, or `--password` to
  `pnpm lyra onprem seed`.

Retiring the seed override on any customer-facing deployment is an open item in
[`docs/25-go-live-checklist.md`](../25-go-live-checklist.md).

### 7.3 One-click persona sign-in

Where `ENVIRONMENT` is anything other than `"production"` — which today includes
**live production**, see §5 — two extra routes exist:

- `GET /v1/auth/demo/personas` — lists the seeded personas with their role keys
- `POST /v1/auth/demo/login` — signs in by email alone, no password

The login screen renders these as buttons. On a real deployment they return 404,
enforced by `demoOnly()` in [`apps/api/src/auth.ts`](../../apps/api/src/auth.ts).
If a customer ever asks "why can anyone log in as my finance controller", the
answer is this var, and the fix is flipping it.

### 7.4 Seeding an environment

```sh
# local file DB
DATABASE_URL=file:./.data/lyra.db pnpm seed

# on-prem stack
pnpm lyra onprem seed --password '<chosen password>'

# richer history for demos (longer trends, more closed periods)
pnpm --filter @lyra/core seed:history
```

`seed()` uses the real wall clock rather than the fixed test clock, so the
demo's rolling windows ("this week", "last month") are populated relative to
today. A fixture seeded a year ago looks empty; reseed before a demo.

**Do not run a seed against a database holding real tenant data.**

---

## 8. Getting access

| System | What you need it for | Ask |
|---|---|---|
| **GitHub** — `Reshigan/Lyra` | Everything: code, CI, deploy dispatch | The repository owner, `Reshigan` (reshigan@vantax.co.za) |
| **GitHub `production` Environment** | Approving a production deploy | Same. You must be added as a required reviewer; today the only reviewer is `Reshigan` |
| **Cloudflare account** | Worker logs, D1 console, R2, secrets, Queues, DLQ | The account owner. Account ID is recorded in [`infra/cloudflare/README.md`](../../infra/cloudflare/README.md); request a user invite, not the ID |
| **Cloudflare API token** | Deploying from a workstation | Prefer `wrangler login` (OAuth, tied to your own account) over being handed a shared token. If you genuinely need a token, request one scoped for your task only |
| **DNS for `vantax.co.za`** | Only for a hostname change; both LYRA hosts are already cut over | The domain owner — same account. Do not change DNS to work around a deploy problem |
| **On-prem host** | Running or supporting a customer estate | The customer's own operations team. LYRA staff do not hold standing access to a customer's on-prem estate; that is the point of on-prem |

Practical advice: **request access on day one**, then use the local stack while
you wait. Everything in [`06-test-scripts.md`](06-test-scripts.md) can be
rehearsed against `pnpm dev` with a seeded database, and nothing in this pack
requires production access to learn.

### 8.1 Least privilege

- Read-only Cloudflare access is enough for almost all support work. Ask for
  Workers logs and D1 read before asking for anything that can deploy.
- Do not use a shared login. Every action in Cloudflare and GitHub should be
  attributable to a person.
- Wrangler tokens should be scoped to the smallest set of permissions that does
  the job. The scope list for the Terraform token (deliberately separate from
  the deploy token) is documented in
  [`infra/cloudflare/README.md`](../../infra/cloudflare/README.md) §1 —
  widening the deploy token to cover Terraform is explicitly the wrong move.

---

## 9. Quick reference card

```
LOCAL          pnpm install && pnpm dev
               http://localhost:5173   web
               http://localhost:8787   api  (/health, /openapi.json are public)
               DATABASE_URL=file:./.data/lyra.db pnpm seed

ON-PREM        pnpm lyra onprem init && pnpm onprem:up
               pnpm lyra onprem migrate && pnpm lyra onprem seed
               pnpm lyra onprem smoke

STAGING        https://staging.lyra.vantax.co.za
               https://api-staging.lyra.vantax.co.za/health
               auto-deploys on push to main; pnpm smoke:staging to verify

PRODUCTION     https://lyra.vantax.co.za
               https://api.lyra.vantax.co.za/health
               GitHub Actions -> deploy -> Run workflow, approved by Reshigan

SIGN IN        <first>.<last>@gonxt.ae  — password is DEFAULT_PASSWORD in
               packages/core/src/seed.ts. On demo environments the login
               screen also offers one-click persona buttons.
```

---

**Next:** [`03-operations-runbook.md`](03-operations-runbook.md) — deploys,
rollbacks, monitoring, backups and incident response.
