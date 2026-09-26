# 04 — API Platform (gateway, conventions, auth, events, webhooks)

Base: `https://api.{tenant-domain}/v1` (cloud) · `https://{host}/api/v1` (on-prem).
Gateway = apps/api (Hono). OpenAPI 3.1 generated from zod route schemas into
packages/sdk (typed TS client + docs site at /dev/docs).

## 1. Conventions

- JSON only; `snake_case` wire format; ULIDs; money as integer minor units +
  `currency`; times as epoch ms UTC; locales BCP-47 (`en`, `ar`, `ar-AE`).
- Errors: RFC 9457 problem+json `{type, title, status, detail, trace_id}`.
- Pagination: cursor (`?cursor=&limit=`, max 100). Filtering: RSQL-lite
  (`?filter=status==active;line==motor`). Sparse fields `?fields=`.
- Idempotency: `Idempotency-Key` header honored on all POSTs for 24h.
- Versioning: URL major (/v1); additive changes free; breaking → /v2 + 12m sunset.
- Rate limits (per key): interactive 60 rpm, server 600 rpm, burst ×2; DO-based
  counters; 429 with `Retry-After`. AI endpoints also metered in tokens.

## 2. AuthN

- **Users:** session (HTTP-only cookie) via better-auth; SSO: OIDC (Azure AD,
  Google), SAML for enterprise; MFA (TOTP/WebAuthn) enforced for staff roles.
- **Machines:** API keys `qvk_live_...`/`qvk_test_...` (hashed at rest, prefix
  lookup), scoped to tenant + module + permissions; OAuth2 client-credentials for
  partner apps (ORBIT embedded).
- **Staff/admin surfaces:** additionally behind Cloudflare Access (cloud) /
  Caddy forward-auth + OIDC (on-prem).

## 3. AuthZ

RBAC: permission strings `module:resource:action` (e.g. `axis:cases:approve`,
`north:briefings:read`). Roles bundle permissions (docs/06 §1). ABAC overlays:
team scope, data sensitivity (PII fields masked unless `core:pii:view`),
consequential actions require `*:approve` + approval-engine flow. Every check
via `can(actor, perm, subject)` in packages/core — no ad-hoc checks.

## 4. Surface map (summary; full OpenAPI in packages/sdk)

- `/v1/core`: tenants(self), users, roles, customers, consents, files (signed
  R2 upload/download), notifications, search (typeahead across spine).
- `/v1/axis`: cases, quotes, documents(+extract), tasks, approvals, policies,
  escrow-batches, sops, metrics.
- `/v1/orbit`: conversations (+`/ws` upgrade to AgentRoom DO), messages,
  renewals, journeys, partners, partner sandbox, quotes (embedded flow:
  `POST /orbit/embedded/quotes` → `POST /orbit/embedded/binds`).
- `/v1/signal`: campaigns, audiences(+estimate), creatives(+generate),
  experiments, budget-moves, aeo-pages, attribution.
- `/v1/scout`: signals(ingest), clusters, whitespaces, panel-bench,
  experiments, data-products.
- `/v1/north`: metrics, snapshots(query), briefings, anomalies, scenarios(run),
  boardpacks, decisions.
- `/v1/ai`: chat completions proxy for tenant apps (policy-scoped), embeddings.
- `/v1/admin` (staff): tenant config, entitlements, keys, webhooks, dlq, flags,
  ai-budget, audit export.

## 5. Realtime

WebSocket per conversation (ORBIT DO) and per user notification channel
(`/v1/realtime` DO). Server-sent events fallback. Presence + typing for agent
console. NORTH briefing page uses SSE for live metric ticks.

## 6. Webhooks (outbound)

Tenant registers endpoints per event type; HMAC-SHA256 signature header
`Lyra-Signature: t=..,v1=..`; retries 8× exponential ≤ 24h; per-endpoint
secret rotation; delivery log queryable; replay from admin console.

## 7. Event catalogue (bus + webhooks share types)

```
core.customer.created|updated|erased      core.consent.updated
axis.case.created|status_changed          axis.document.extracted
axis.quote.added                          axis.policy.issued
axis.approval.requested|decided           axis.policy.broker_fee_charged
orbit.conversation.started|handover|closed
orbit.renewal.due|offered|accepted|lost   orbit.partner.txn
signal.campaign.launched|paused           signal.experiment.concluded
signal.budget.moved                       signal.creative.flagged
scout.whitespace.promoted                 scout.bench.updated
north.anomaly.detected                    north.briefing.published
ai.budget.threshold                       platform.key.rotated
dist.referral.qualified                   dist.referral.settled
ledger.recon.completed                    ledger.settlement.approved|paid
compliance.disclosure.presented
dist.quote.expired                        orbit.message.received|status
```
Envelope: `{id, ts, tenant_id, module, type, actor, subject, data, v:1}`.

## 8. SDK & Dev experience

`@lyra/sdk` (TS) generated per release; sandbox tenant + `qvk_test_` keys
return deterministic fixtures; Postman/Bruno collection exported from OpenAPI;
`/dev` portal (docs/09) hosts docs, keys, logs, webhook tester, mock partner.
