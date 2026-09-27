# 02 — System Architecture

One codebase, two homes. Cloud is Cloudflare-native; on-prem is a Docker twin
with capability flags. Modules are vertical slices over a shared core.

## 1. Topology (cloud)

```
                      ┌──────────────────────────────────────────────┐
   consumer web ─────▶│  apps/web  (React Router v7 on Workers)      │
   role workspaces ──▶│  SSR + islands; tenant-branded per domain    │
                      └───────────────┬──────────────────────────────┘
   mobile (Expo) ───────────────┐     │
   partner systems ──────────┐  │     │
                             ▼  ▼     ▼
                      ┌──────────────────────────────────────────────┐
                      │  apps/api  (Hono on Workers) — API Gateway   │
                      │  authn/z · tenancy · rate limit · OpenAPI    │
                      │  routers: /axis /orbit /signal /scout /north │
                      └───┬────────┬──────────┬───────────┬──────────┘
                          │        │          │           │
        ┌─────────┐  ┌────▼───┐ ┌──▼─────┐ ┌──▼──────┐ ┌──▼───────────┐
        │   D1    │  │  KV    │ │  R2    │ │ Queues  │ │ Durable Objs │
        │ core DB │  │ config │ │ files  │ │ events  │ │ agent rooms, │
        │ (+shards│  │ flags  │ │ docs   │ │ + jobs  │ │ ws, rate ctr │
        └─────────┘  └────────┘ └────────┘ └────┬────┘ └──────┬───────┘
                                                │             │
                              ┌─────────────────▼─┐   ┌───────▼────────┐
                              │ Workflows          │   │ model-gateway  │
                              │ long-running orchs │   │ AI Gateway →   │
                              │ (renewal cycles,   │   │ Workers AI /   │
                              │  briefing builds)  │   │ Anthropic API /│
                              └───────────────────┘    │ on-prem vLLM   │
                                                       └───────┬────────┘
                                              ┌────────────────▼───┐
                                              │ Vectorize (RAG)    │
                                              └────────────────────┘
```

Also: Analytics Engine (product + AI telemetry), Logpush → R2, Cloudflare
Access (staff/admin surfaces), Turnstile (public forms), Images (logo/media),
Email Workers or provider (Resend) for transactional mail, Browser Rendering
(PDF board packs, page snapshots for SIGNAL/SCOUT).

## 2. Multi-tenancy

- **Model:** shared-schema with `tenant_id` on every row (default), plus
  **dedicated D1 database per tenant** for enterprise/regulated tenants
  (binding resolved per-request via tenant registry in KV). Same Drizzle schema.
- Tenant resolution: hostname → KV `tenant:byDomain:{host}` → tenant record
  (id, plan, entitlements, brand, policy flags, db binding name, region hints).
- Entitlements: module on/off, seat counts, AI budget (tokens/day), feature
  flags. Enforced in gateway middleware; UI reads the same object to hide/disable.
- Isolation tests are part of CI (attempt cross-tenant read must fail).

## 3. Module = vertical slice

Each module owns: router (`apps/api/src/modules/<m>`), UI area
(`apps/web/app/routes/<m>.*`), agents (`apps/agents/<m>`), tables prefixed
`<m>_` in packages/db, events it emits/consumes, its own **Admin console** and
**Dev console** routes (see docs/09). Cross-module communication only via the
event bus; shared reads via core views (e.g. `core_customers`).

## 4. Agent runtime

- **Durable Object per conversation/agent-session** (`AgentRoom`): holds
  transcript state, tool-call ledger, WebSocket to clients, handover state.
- **Workflows** for multi-step, long-horizon jobs (renewal campaign over 30
  days; nightly NORTH briefing build; SCOUT weekly market crawl) — durable,
  retried, resumable.
- Tools registry (packages/core/tools): typed tool defs with `consequential`
  flag, RBAC scope, and per-tenant enablement. Agents can only call registered
  tools; every call logged to `ai_audit_log` with input/output hashes.
- Guardrails pipeline in model-gateway: PII redaction (pre), policy classifier
  (pre+post), grounding check for regulated statements (post), Arabic/English
  parity sampling (offline eval).

## 5. Model gateway (packages/model-gateway)

Single interface: `complete(req: ModelRequest): ModelResponse` where req carries
`{tenant, module, purpose, tier, messages/tools, maxTokens, locale}`.

Providers (priority per env + tenant policy):
- `workers-ai` — @cf/meta Llama family for cheap/fast tiers, embeddings
  (`@cf/baai/bge-m3` for AR/EN), rerankers.
- `anthropic` — Claude via **Cloudflare AI Gateway** (caching, retries, cost
  logging, per-tenant keys) for reasoning/agentic tiers.
- `openai-compat` — on-prem vLLM/Ollama endpoint (same adapter class).

Tiers: `fast` (classification, extraction), `standard` (chat, drafting),
`reasoning` (simulations, briefing synthesis). Tenant policy maps tier→provider
(e.g. on-prem tenant: all tiers→internal). Budget metering per tenant/day in a
Durable Object counter; hard stop + admin alert at 100%.

Embeddings + RAG: Vectorize indexes per tenant namespace: `kb` (product/policy
docs), `market` (SCOUT corpus), `convo` (ORBIT summaries). On-prem: Qdrant.

## 6. Eventing

Queue `lyra-events`, JSON envelope
`{id, ts, tenantId, module, type, actor, subject, data, v}`.
Core event types in docs/04 §7. Consumers are idempotent (dedupe on `id` in
`core_event_inbox`). Dead-letter queue with admin replay UI (Platform Admin).

## 7. Environments

`local` (wrangler dev + miniflare, local D1/KV/R2) → `staging` → `prod`.
Separate Cloudflare accounts for staging/prod. Preview deployments per PR
(workers versions + preview URLs). Data: staging seeded with synthetic tenant
"Aldebaran Insurance"; never copy prod data down.

## 8. On-prem twin (summary; full spec docs/11)

Docker Compose: `app` (Node 22 running the same Hono/React Router builds via
@react-router/node + workerd-compatible shims), `libsql` (SQLite server) or
file volume, `minio` (R2 API-compatible), `redis` (queues via BullMQ adapter),
`qdrant` (vectors), `vllm` or `ollama` (internal LLM), `caddy` (TLS).
Capability flags: `WORKFLOWS=inline`, `BROWSER_RENDER=playwright-container`,
`ANALYTICS=clickhouse-optional|logs`. Feature parity matrix in docs/11 §6.

## 9. Approved third-party services

Cloudflare platform · Anthropic API (via AI Gateway) · Resend (email) ·
Twilio or Unifonic (WhatsApp/SMS — tenant choice; Unifonic preferred for GCC) ·
Sentry (errors) · Stripe (platform billing only, not consumer payments) ·
OpenSanctions (sanctions/PEP screening, ADR-0095).
Anything else requires an ADR.

## 10. Performance & scale targets

API p95 < 150ms (non-AI) at edge; agent first-token < 1.5s (cloud standard
tier); web LCP < 2.0s on 4G; 10k concurrent ORBIT conversations per tenant via
DO sharding; D1: keep hot tables < 10GB/tenant-shard, archive to R2 parquet
(SCOUT/NORTH analytics read from R2 via Workers with DuckDB-wasm offline jobs).

## 11. Extension seams

Future-horizon seams (docs/16) are part of this architecture: Channel,
SpeechProvider, IdentityVerifier, DataInConnector, TimeseriesIngest,
AutonomyEnvelope, extension manifest, rulepacks, core_memories. Interfaces
live in packages/core/seams; each ships with a contract test tagged
`@seam:Hx`. Treat them as public API internally — versioned, documented,
never bypassed.
