// Named exceptions to "one documented permission per operation", shared by the
// RBAC-order guard (rbac-order.guard.test.ts) and the month simulation's matrix
// (sim/month.ts) so the two cannot disagree about what is a finding.

/**
 * Operations whose real rule is "any one of several permissions", which the
 * spec's single scope cannot say. Each names the family and why; a caller
 * holding any member legitimately passes to validation.
 */
export const ANY_OF: Record<string, { family: string[]; why: string }> = {
  "GET /v1/scout/config": {
    family: ["scout:signals:read", "scout:data_products:read", "scout:panel_bench:read"],
    why: "the k-anonymity floor every SCOUT reader's screen needs"
  },
  "POST /v1/ai/runs": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/ai/runs/stream": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/ai/command/runs": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/axis/cases/{id}/transition": { family: ["axis:cases:update", "axis:cases:approve"], why: "the permission depends on the target state" },
  "POST /v1/axis/claims/{id}/transition": {
    family: ["axis:claims:update", "axis:claims:triage", "axis:claims:approve", "axis:claims:close", "axis:claims:reopen", "axis:claims:recover"],
    why: "the permission depends on the target state"
  },
  "POST /v1/axis/cases/bulk": { family: ["axis:cases:update", "axis:cases:assign"], why: "per-action, checked per row" },
  "POST /v1/core/api-keys": { family: ["core:api_keys:create", "dev:keys_test:issue", "dev:keys_live:issue"], why: "a test key and a live key need different grants" },
  "POST /v1/ledger/txn/{type}": { family: ["ledger:txns:create", "ledger:journals:draft"], why: "a drafter may originate a gated transaction" },
  "GET /v1/orbit/portal-links/{kind}/{id}": { family: ["orbit:renewals:read", "orbit:conversations:read"], why: "a renewal link and a feedback link" }
};

/**
 * Operations that also need a second permission the spec's single scope cannot
 * say: holding the documented one and still getting a 403 is the rule working.
 */
export const ALSO_NEEDS: Record<string, { permission: string; why: string }> = {
  "POST /v1/axis/documents/{id}/reveal": { permission: "core:pii:view", why: "revealing a document shows personal data" },
  "POST /v1/orbit/drafts/sweep": { permission: "orbit:conversations:reply", why: "a draft is a reply the actor could send" }
};
