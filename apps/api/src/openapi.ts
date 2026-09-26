import { getTableColumns } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { BY_MODULE } from "./resources.js";
import { DATASETS } from "./engines/report.js";
import type { Resource } from "./crud.js";

// The spec is generated from the same resource table the router is built from,
// so it cannot describe an endpoint that does not exist. Hand-written entries
// below cover the module routers, which are not CRUD.

interface Op {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  /** Omitted when the endpoint is authenticated but scoped to the caller itself. */
  permission?: string;
  /** True only for the handful of endpoints that run before a session exists. */
  public?: boolean;
  tag: string;
  requestBody?: boolean;
}

/** Endpoints that are not generated CRUD. Kept beside the routers they describe. */
const HAND_WRITTEN: Op[] = [
  { method: "post", path: "/v1/auth/login", summary: "Password login, returns a session cookie", tag: "auth", requestBody: true, public: true },
  { method: "post", path: "/v1/auth/logout", summary: "End the current session", tag: "auth", public: true },
  // Marked public because they run against a session that has deliberately not
  // cleared the second-factor gate — they are not reachable without a session.
  { method: "post", path: "/v1/auth/mfa/enrol", summary: "Start TOTP enrolment; returns the secret once", tag: "auth", public: true },
  { method: "post", path: "/v1/auth/mfa/enrol/confirm", summary: "Confirm TOTP enrolment; returns single-use recovery codes once", tag: "auth", requestBody: true, public: true },
  { method: "post", path: "/v1/auth/mfa/verify", summary: "Clear the second factor with a TOTP or recovery code", tag: "auth", requestBody: true, public: true },
  { method: "post", path: "/v1/auth/mfa/disable", summary: "Remove the second factor (refused for staff roles)", tag: "auth", requestBody: true, public: true },
  // Demo deployments only: both answer 404 when ENVIRONMENT is production.
  { method: "get", path: "/v1/auth/demo/personas", summary: "Seeded demo personas offered as one-click sign-in (non-production only)", tag: "auth", public: true },
  { method: "post", path: "/v1/auth/demo/login", summary: "Sign in as a seeded demo persona without a password (non-production only)", tag: "auth", requestBody: true, public: true },
  { method: "post", path: "/v1/auth/demo/clock", summary: "Advance the simulated clock used by non-production timestamps (non-production only)", tag: "auth", requestBody: true, public: true },
  { method: "post", path: "/v1/auth/demo/seed", summary: "Seed one demo tenant with its personas and starting data (non-production only)", tag: "auth", public: true },
  { method: "post", path: "/v1/auth/demo/resync-roles", summary: "Refresh the demo tenant's system role permissions, chart of accounts, seeded personas, tax rules and seeded event names to match the compiled tables (non-production only)", tag: "auth", public: true },
  // Enterprise sign-in. Public because a browser walks these before any session exists.
  { method: "get", path: "/v1/auth/sso/discover", summary: "Which identity provider, if any, owns an email domain", tag: "auth", public: true },
  { method: "get", path: "/v1/auth/sso/{id}/start", summary: "Redirect to the provider's authorization endpoint (OIDC + PKCE)", tag: "auth", public: true },
  { method: "get", path: "/v1/auth/sso/{id}/callback", summary: "Verify the id_token, link or provision the account, issue a session", tag: "auth", public: true },
  // `GET /v1/me` is the whole bootstrap: actor, tenant, roles, permissions,
  // entitlements, policy and the labelled navigation, in one round trip. There
  // is deliberately no separate nav or permissions endpoint to fall out of step
  // with it.
  { method: "get", path: "/v1/me", summary: "Bootstrap: actor, tenant, roles, permissions, entitlements, policy and navigation", tag: "me" },
  { method: "patch", path: "/v1/me", summary: "Update the caller's own profile", tag: "me", requestBody: true },
  { method: "post", path: "/v1/me/password", summary: "Change the caller's password; other sessions are revoked", tag: "me", requestBody: true },
  { method: "get", path: "/v1/me/sessions", summary: "The caller's active sessions, newest first", tag: "me" },
  { method: "delete", path: "/v1/me/sessions/{id}", summary: "Revoke one of the caller's sessions", tag: "me" },
  { method: "get", path: "/v1/me/inbox", summary: "Notifications and approvals waiting on the caller", tag: "me" },
  { method: "get", path: "/v1/me/lens", summary: "The caller's lens: role default workspace or their own learned adaptation", tag: "me" },
  { method: "post", path: "/v1/me/lens/usage", summary: "Record an interaction with a view/filter/pin, nudging its lens weight", tag: "me", requestBody: true },
  { method: "post", path: "/v1/me/lens/reset", summary: "Discard learned adaptation and revert to the role default lens", tag: "me" },
  // The gate keeps the request it stopped; once approved, the person who asked
  // finishes it with one call, replayed in their own session (the gate and
  // every permission check run again). Once, and only by the requester.
  { method: "get", path: "/v1/me/approvals/ready", summary: "The caller's requests that are approved and waiting for them to finish", tag: "me" },
  { method: "post", path: "/v1/me/approvals/{id}/finish", summary: "Finish an approved request: replay what the gate stopped, in the requester's own session", tag: "me" },
  { method: "post", path: "/v1/me/approvals/{id}/decide", summary: "Approve or reject a pending approval (permission comes from the approval policy)", tag: "me", requestBody: true },
  { method: "post", path: "/v1/me/notifications/{id}/read", summary: "Mark one of the caller's notifications read", tag: "me" },

  // docs/15 ambient AI grammar: a live channel for quiet chips ("your report is
  // ready") without a modal or a page reload. Server-Sent Events, one stream per
  // caller; `?since=<eventId>` resumes after a reconnect.
  { method: "get", path: "/v1/realtime", summary: "Server-Sent Events stream of the caller's own live updates", tag: "realtime" },

  // Both mint a credential the client may not choose, so neither can be the
  // generated create — a CRUD body would ask the caller for the very column the
  // server owns. Each returns its plaintext once and never again.
  { method: "post", path: "/v1/core/api-keys", summary: "Mint an API key; the plaintext is returned once and never again", permission: "core:api_keys:create", tag: "core", requestBody: true },
  { method: "post", path: "/v1/core/webhooks", summary: "Register a webhook; the signing secret is generated server-side and returned once", permission: "core:webhooks:write", tag: "core", requestBody: true },

  // Not the generated delete either: the key has `revokedAt`, not `deletedAt`,
  // so generic CRUD delete would hard-delete it. This sets `revokedAt` instead.
  { method: "delete", path: "/v1/core/api-keys/{id}", summary: "Revoke an API key; the row is kept for audit, the key stops authenticating", permission: "core:api_keys:revoke", tag: "core" },

  // ADR-0089, docs/16 H11: per-record memory. Each read is gated twice — the
  // notes permission and the read permission of the record the note is about —
  // and every other record a response names is filtered by its own read.
  { method: "get", path: "/v1/core/notes", summary: "Read the markdown note on one record (`?subject=<ref>`); `note` is null when none is written", permission: "core:notes:read", tag: "core" },
  { method: "put", path: "/v1/core/notes", summary: "Write the note on one record (`?subject=<ref>`, body `{bodyMd, version}`); 409 when someone saved since `version`; [[wikilinks]] become links", permission: "core:notes:write", tag: "core", requestBody: true },
  { method: "get", path: "/v1/core/links", summary: "Backlinks: the notes that link to one record (`?to=<ref>`), with their names and where each opens", permission: "core:notes:read", tag: "core" },
  { method: "get", path: "/v1/core/graph", summary: "The records linked to one record within `depth` 1 or 2 hops (`?subject=<ref>&depth=`), capped at 40 nodes", permission: "core:notes:read", tag: "core" },
  { method: "get", path: "/v1/core/notes/export", summary: "Download the notes the caller may read as an Obsidian vault (application/zip, one `<Type>/<name>.md` per note)", permission: "core:notes:read", tag: "core" },

  { method: "post", path: "/v1/core/webhooks/{id}/rotate", summary: "Rotate a webhook's signing secret to a fresh, server-generated one", permission: "core:webhooks:write", tag: "core" },

  // Per-module configuration (docs/05 module independence): each module's
  // enabled flag, autonomy override, model tier and free-form settings.
  { method: "get", path: "/v1/core/modules/config", summary: "Every module's effective configuration — enabled flag, autonomy override, model tier and settings", permission: "core:settings:read", tag: "core" },
  { method: "patch", path: "/v1/core/modules/{module}/config", summary: "Update one module's configuration; absent keys fall through to the tenant-wide defaults", permission: "core:settings:update", tag: "core", requestBody: true },

  // The escape hatch out of the approval gate, so the write path validates what
  // the seed never had to: an unknown policy key is a 400 rather than an inert
  // entry, and a `neverAutoApprove` policy is refused outright (docs/19 §7).
  { method: "get", path: "/v1/core/audit-log/export", summary: "The audit chain as CSV, oldest first with every hash; narrowed by q (action text) and from/to (ms); capped at 50,000 rows; the export is itself audited", permission: "core:audit:export", tag: "core" },
  { method: "get", path: "/v1/core/settings/auto-approve", summary: "The tenant's auto-approve allowlist and every approval policy, marking which the floor lets a tenant automate", permission: "core:settings:read", tag: "core" },
  { method: "patch", path: "/v1/core/settings/auto-approve", summary: "Add or remove approval policy keys from the tenant's auto-approve allowlist; never-auto-approve policies are refused", permission: "core:settings:update", tag: "core", requestBody: true },

  // SQL aggregate for the 360 screen's Position card — never a paged read.
  { method: "get", path: "/v1/core/customers/{id}/position", summary: "Financial position: premium, commission and settled claims summed per currency", permission: "core:customers:read", tag: "core" },

  // Capture: multipart in, stored file + document row out. The generated CRUD
  // create takes a `fileId` a phone has no way to produce.
  { method: "post", path: "/v1/axis/documents/upload", summary: "Upload a captured document (multipart: caseId, docType, file) and file it against a case", permission: "axis:documents:upload", tag: "axis", requestBody: true },

  // `verifiedBy` and `verifiedAt` are evidence that a named person looked at the
  // file at a known time, so they come from the session and the clock. No body.
  { method: "post", path: "/v1/axis/documents/{id}/verify", summary: "Mark a document verified; the verifier and the time are stamped server-side", permission: "axis:documents:verify", tag: "axis" },

  // docs/04 §4 "documents(+extract)": structures a document's already-OCR'd
  // text into named fields via the model gateway (packages/model-gateway/src/extract.ts).
  { method: "post", path: "/v1/axis/documents/{id}/extract", summary: "Structure a document's raw text into named fields via the model gateway", permission: "axis:documents:extract", tag: "axis", requestBody: true },

  // docs/12 §1-2: identifier fields are sealed in the column (ADR-0032), so the
  // only way back to the plaintext is this door — `core:pii:view` on top of the
  // read permission, and an audit row per opening.
  { method: "post", path: "/v1/axis/documents/{id}/reveal", summary: "Open the sealed identifier fields of an extraction (requires core:pii:view; audited)", permission: "axis:documents:read", tag: "axis" },

  // Atomic swap: the target SOP goes active and whatever else held that title
  // + kind is retired in the same transaction, so there is never a moment with
  // two active versions of the same procedure (routes/axis.ts).
  { method: "post", path: "/v1/axis/sops/{id}/publish", summary: "Publish an SOP version, retiring whichever version of the same SOP was active", permission: "axis:sops:write", tag: "axis" },

  // docs/27 F4. Issuance: one BIND transaction, version 1 of the schedule, and
  // the `axis.policy.issued` event the rest of the platform services. Distinct
  // from the generic policies create, which writes a row and nothing else.
  { method: "post", path: "/v1/axis/quote-responses/{id}/bind", summary: "Bind an accepted quote response into a policy at version 1", permission: "axis:policies:bind", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/bind", summary: "Bind a draft policy, issuing version 1", permission: "axis:policies:bind", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/referrals/{id}/decide", summary: "Accept, decline, or counter an open underwriting-authority referral", permission: "axis:policies:decide_referral", tag: "axis", requestBody: true },

  // docs/18 C3. Group & SME brokerage: a census-based scheme binds through its
  // own transaction (BIND-GROUP, dual control) rather than the individual
  // bind's; the advisory fee is a second, separate accrual on top of it.
  { method: "post", path: "/v1/axis/policies/{id}/bind-group", summary: "Bind a group/SME scheme, posting a BIND-GROUP commission accrual (dual control)", permission: "axis:policies:bind", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/broker-fee", summary: "Post a FEE-BROK brokerage/advisory fee accrual on a policy", permission: "axis:policies:bind", tag: "axis", requestBody: true },

  // docs/27 F5. Mid-term change: the preview prices it and writes nothing, the
  // endorse appends a priced version and moves the pro-rated money.
  { method: "post", path: "/v1/axis/policies/{id}/endorse/preview", summary: "Price a mid-term change without writing anything", permission: "axis:policies:endorse", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/endorse", summary: "Endorse a policy, appending a priced version", permission: "axis:policies:endorse", tag: "axis", requestBody: true },

  // docs/27 F5. Usage-based insurance: a device/integration posts raw sensor
  // points against its own series (machine authority, never `:endorse`), and
  // a reprice turns what has accrued since the last version into a priced
  // endorsement through the same approval gate as a manual one.
  { method: "post", path: "/v1/axis/policies/{id}/telemetry", summary: "Ingest a batch of sensor points against this cover", permission: "axis:policies:telemetry", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/reprice", summary: "Reprice a cover from its telemetry, endorsing it if the price moved", permission: "axis:policies:endorse", tag: "axis" },

  // docs/27 F5 part 2. The ways cover stops. Cancellation refunds the unearned
  // share and claws the matching commission; NTU unwinds a contract that never
  // went on risk; lapse and reinstatement are the unpaid-instalment pair.
  { method: "post", path: "/v1/axis/policies/{id}/cancel/preview", summary: "Price a cancellation without writing anything", permission: "axis:policies:cancel", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/cancel", summary: "Cancel a policy, refunding the unearned premium", permission: "axis:policies:cancel", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/ntu", summary: "Mark a policy not-taken-up, clawing back the whole commission", permission: "axis:policies:ntu", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/lapse", summary: "Lapse a policy for an unpaid instalment", permission: "axis:policies:lapse", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/policies/{id}/reinstate", summary: "Put cover back on risk after arrears are cleared", permission: "axis:policies:reinstate", tag: "axis", requestBody: true },

  // docs/27 group D. Opens a premium-financing plan on a bound policy — how
  // the premium is collected, not the risk or price on the contract.
  { method: "post", path: "/v1/axis/policies/{id}/premium-financing-plan", summary: "Open a premium-financing plan on a bound policy", permission: "axis:policies:finance", tag: "axis", requestBody: true },

  // A policy may hold only one live plan, so a plan opened against the wrong
  // contract needs a way out. Cancelling un-earns the commission by reversal.
  { method: "post", path: "/v1/axis/policies/{id}/premium-financing-plan/cancel", summary: "Cancel a policy's live premium-financing plan", permission: "axis:policies:finance", tag: "axis", requestBody: true },

  // docs/27 F27. The contract the customer can actually hold. AXIS issues and
  // attaches it to the version it describes; ORBIT delivers it.
  { method: "post", path: "/v1/axis/policies/{id}/documents", summary: "Issue a policy document for a version and attach it", permission: "axis:policies:document", tag: "axis", requestBody: true },

  // docs/27 F5. The endorsement history of one contract, and next year's
  // contract born from this one.
  { method: "get", path: "/v1/axis/policies/{id}/versions", summary: "The endorsement history of this policy, newest first", permission: "axis:policies:read", tag: "axis" },
  { method: "post", path: "/v1/axis/policies/{id}/renew", summary: "Bind a successor term and close the prior one", permission: "axis:policies:renew", tag: "axis", requestBody: true },

  // docs/27 F23. Claim money in both directions: paying out of the insurer's
  // float, and what a third party gives back afterwards.
  { method: "post", path: "/v1/axis/claims/coverage-check", summary: "Cover in force on the incident date, without writing anything", permission: "axis:claims:register", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/claims/{id}/transition", summary: "Move a claim through its state machine", permission: "axis:claims:update", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/claims/{id}/reserves", summary: "Append a reserve movement on one head", permission: "axis:claims:reserve", tag: "axis", requestBody: true },
  { method: "get", path: "/v1/axis/claims/{id}/reserves", summary: "The reserve history of this claim, newest first", permission: "axis:claims:read", tag: "axis" },
  { method: "post", path: "/v1/axis/claims/{id}/reserve-recommendation", summary: "Suggest and write an AI-recommended reserve from comparable closed claims", permission: "axis:claims:reserve", tag: "axis" },
  { method: "post", path: "/v1/axis/claims/{id}/fraud-score", summary: "Score a claim for SIU referral and queue a referral above threshold", permission: "axis:siu:write", tag: "axis" },
  { method: "post", path: "/v1/axis/cases/{id}/sla-predict", summary: "Estimate SLA breach probability and time-to-breach for a case", permission: "axis:cases:read", tag: "axis" },
  { method: "post", path: "/v1/axis/claims/{id}/payments", summary: "Pay a claim out of the funded float", permission: "axis:claims:pay", tag: "axis", requestBody: true },
  { method: "get", path: "/v1/axis/claims/{id}/payments", summary: "The payments made on this claim, newest first", permission: "axis:claims:read", tag: "axis" },
  { method: "post", path: "/v1/axis/claims/{id}/recoveries", summary: "Open a recovery against a settled claim", permission: "axis:claims:recover", tag: "axis", requestBody: true },
  { method: "get", path: "/v1/axis/claims/{id}/recoveries", summary: "The recoveries being pursued on this claim, newest first", permission: "axis:claims:read", tag: "axis" },
  { method: "post", path: "/v1/axis/recoveries/{id}/receipt", summary: "Record money recovered, net of the handling fee", permission: "axis:claims:recover", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/recoveries/{id}/writeoff", summary: "Abandon pursuit and write the outstanding recovery off", permission: "axis:claims:recover", tag: "axis", requestBody: true },

  // docs/27 F13. The manual capture path onto the one quote table, and the
  // desk's ruling-out of an answer it will not take forward.
  { method: "post", path: "/v1/axis/cases/{id}/transition", summary: "Move a case through its state machine", permission: "axis:cases:update", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/cases/{id}/quotes", summary: "Key a quote received off-panel onto the case, as a quote response", permission: "axis:quotes:create", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/quote-responses/{id}/decline", summary: "Rule a quote out, recording why", permission: "axis:quotes:create", tag: "axis", requestBody: true },

  { method: "post", path: "/v1/dist/quote-requests/shop", summary: "Shop one risk to every eligible offering and collect provider quotes", permission: "dist:quote_requests:create", tag: "dist", requestBody: true },
  { method: "get", path: "/v1/dist/quote-requests/{id}/comparison", summary: "Ranked comparison across the responses received", permission: "dist:quote_requests:read", tag: "dist" },
  { method: "post", path: "/v1/dist/quote-requests/{id}/share", summary: "Share the comparison with the customer over their consented channel", permission: "dist:quote_requests:share", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/quote-requests/{id}/select", summary: "Record the quote the customer chose", permission: "dist:quote_requests:select", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/commission-entries/accrue", summary: "Accrue the commission split between the provider, us and the channel", permission: "dist:commissions:adjust", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/commission-entries/{id}/clawback", summary: "Claw back an accrued commission after a cancellation", permission: "dist:commissions:adjust", tag: "dist", requestBody: true },
  { method: "get", path: "/v1/dist/commission-entries/statement", summary: "Commission statement for a channel over a period", permission: "dist:commissions:read", tag: "dist" },
  { method: "post", path: "/v1/dist/next-best-offers/propose", summary: "Rank cross-sell and upsell offers for a customer", permission: "dist:offers:surface", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/next-best-offers/{id}/surface", summary: "Record that an offer was shown, and where", permission: "dist:offers:override", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/next-best-offers/{id}/decide", summary: "Record the customer's decision on a surfaced offer", permission: "dist:offers:override", tag: "dist", requestBody: true },

  // docs/18 C5. Banking product referrals: cost-per-lead qualifies (REFERRAL-QUAL),
  // cost-per-approved-account settles against it (REFERRAL-SETL) once the
  // partner's statement confirms the outcome.
  { method: "post", path: "/v1/dist/referrals/qualify", summary: "Record a qualified referral lead/approval event (REFERRAL-QUAL)", permission: "dist:commissions:adjust", tag: "dist", requestBody: true },
  { method: "post", path: "/v1/dist/referrals/settle", summary: "Settle a qualified referral's revenue against the partner's statement (REFERRAL-SETL)", permission: "dist:commissions:settle", tag: "dist", requestBody: true },

  { method: "post", path: "/v1/ledger/txn/{type}", summary: "Open a transaction of the given type and run its opening postings", permission: "ledger:txns:create", tag: "ledger", requestBody: true },
  { method: "get", path: "/v1/ledger/txn/{id}", summary: "One transaction with its state, transitions and journal batches", permission: "ledger:txns:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/txn-types", summary: "Every transaction type and the states it may move through", permission: "ledger:txns:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/txn/{id}/transition", summary: "Advance a transaction through its state machine", permission: "ledger:txns:authorize", tag: "ledger", requestBody: true },
  { method: "post", path: "/v1/ledger/txn/{id}/reverse", summary: "Post a compensating reversal, leaving the original intact", permission: "ledger:txns:reverse", tag: "ledger", requestBody: true },
  // Singular `period`, deliberately: `/v1/ledger/periods/{id}` is the generated
  // CRUD record, and the enriched `{period, checks}` view used to sit on it and
  // swallow it (src/ledger.test.ts). This entry named the plural path, so it
  // documented the wrong handler.
  { method: "get", path: "/v1/ledger/period/{code}", summary: "One accounting period and its close checklist", permission: "ledger:periods:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/periods/{code}/close", summary: "Soft or hard close a period (dual control)", permission: "ledger:periods:close", tag: "ledger", requestBody: true },
  { method: "post", path: "/v1/ledger/periods/{code}/reopen", summary: "Reopen a soft-closed period", permission: "ledger:periods:close", tag: "ledger" },
  { method: "get", path: "/v1/ledger/year-end/{year}", summary: "The entry that would zero income and expense into retained earnings", permission: "ledger:journals:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/year-end/{year}", summary: "Post the year-end close (dual control)", permission: "ledger:periods:year_end", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/trial-balance", summary: "Trial balance as at a moment", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/pnl", summary: "Profit and loss for a period", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/balance-sheet", summary: "Balance sheet as at a moment", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/cash-flow", summary: "Statement of cash flows (IFRS, IAS 7 indirect) for a window", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/aged", summary: "Aged receivables or payables by counterparty", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/commission", summary: "Commission earned, clawed back and payable by channel", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/client-money", summary: "Client money sufficiency: what is held against what is owed", permission: "ledger:client_money:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/bordereaux", summary: "Outbound bordereaux: per-policy premium and commission for a provider and period", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/value-flow", summary: "Money Map: premium in, remitted, retained, split and still held for a period", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/value-flow/lines", summary: "The journal lines behind one Money Map node", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/reports/chart-of-accounts", summary: "The chart of accounts with current balances", permission: "ledger:journals:read", tag: "ledger" },
  // One handler for every report above. The permission is the report's own —
  // `ledger:journals:read` for all of them except client-money, which needs
  // `ledger:client_money:read`. Two reports are downloadable without a
  // `/reports/*` JSON route of their own: `account-statement` (name the account
  // with `?code=`) and `value-flow`, the money map.
  { method: "get", path: "/v1/ledger/reports/{report}/export", summary: "Render any ledger report to xlsx, pdf, csv or json", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/accounts/{code}/statement", summary: "Every line that hit one account, in order", permission: "ledger:journals:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/accounts/{code}/balance", summary: "One account's balance as at a moment", permission: "ledger:journals:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/balances/rebuild", summary: "Rebuild cached balances from the journal lines", permission: "ledger:journals:post", tag: "ledger", requestBody: true },
  { method: "post", path: "/v1/ledger/recon/runs", summary: "Match an imported statement against the ledger", permission: "ledger:recon:run", tag: "ledger", requestBody: true },
  { method: "get", path: "/v1/ledger/recon/runs/{id}", summary: "One reconciliation run with its matches and exceptions", permission: "ledger:recon:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/recon/matches/{id}/decide", summary: "Confirm or reject a proposed match", permission: "ledger:recon:confirm", tag: "ledger", requestBody: true },
  { method: "post", path: "/v1/ledger/recon/runs/{id}/close", summary: "Close a reconciliation run once nothing is left open", permission: "ledger:recon:confirm", tag: "ledger" },
  { method: "post", path: "/v1/ledger/recon/runs/{id}/evidence-bundle", summary: "Assemble a reconciliation run's evidence as a signed, hash-manifested bundle", permission: "ledger:recon:export", tag: "ledger" },
  { method: "get", path: "/v1/ledger/recon/runs/{id}/evidence-bundle/download", summary: "Download an assembled recon evidence bundle", permission: "ledger:recon:export", tag: "ledger" },

  // Invoking an agent is authorised per module, so the scope below is the core
  // module's; an AXIS agent needs axis:ai:invoke, and so on for each module.
  { method: "post", path: "/v1/ai/runs", summary: "Run an agent through the gateway, budgeted and audited (needs the agent module's :ai:invoke)", permission: "core:ai:invoke", tag: "ai", requestBody: true },
  // The bare `/runs/{id}` is the generated CRUD record (a flat row); this is the
  // second, enriched view and so it gets a second path.
  // docs/27 F35. Same body as /v1/ai/runs; the response is text/event-stream
  // (`delta`, `done`, `error`) rather than JSON, and the run is a single
  // completion with no tool loop — see routes/ai.ts for why those are separate.
  { method: "post", path: "/v1/ai/runs/stream", summary: "Run an agent and stream the answer as server-sent events (needs the agent module's :ai:invoke)", permission: "core:ai:invoke", tag: "ai", requestBody: true },
  { method: "get", path: "/v1/ai/runs/{id}/detail", summary: "One agent run with its tool calls and audit trail", permission: "ai:runs:read", tag: "ai" },
  { method: "get", path: "/v1/ai/budget", summary: "Remaining AI budget for the period", permission: "ai:budgets:read", tag: "ai" },
  { method: "post", path: "/v1/ai/budget/limits", summary: "Set per-module AI spend limits", permission: "ai:budgets:write", tag: "ai", requestBody: true },
  { method: "post", path: "/v1/ai/suggestions", summary: "Record a suggestion shown to the current user", permission: "ai:suggestions:read", tag: "ai", requestBody: true },
  { method: "post", path: "/v1/ai/suggestions/{id}/outcome", summary: "Record whether the current user accepted, edited or dismissed it", permission: "ai:suggestions:read", tag: "ai", requestBody: true },
  { method: "get", path: "/v1/ai/suggestions/acceptance", summary: "Acceptance rate by surface and module", permission: "ai:runs:read", tag: "ai" },
  // ADR-0073 — the command center.
  { method: "post", path: "/v1/ai/command/runs", summary: "Run the bounded multi-round command loop; consequential tools become proposals, never executions", permission: "core:ai:invoke", tag: "ai", requestBody: true },
  { method: "get", path: "/v1/ai/command/proposals", summary: "List command-center proposals by state (default: proposed)", permission: "ai:command:read", tag: "ai" },
  { method: "post", path: "/v1/ai/command/proposals/{id}/dismiss", summary: "Dismiss a proposal — an explicit human decision", permission: "ai:command:read", tag: "ai", requestBody: true },
  { method: "post", path: "/v1/ai/command/proposals/{id}/action", summary: "Execute a proposal through the module's real engine path; the approval gate fires there", permission: "core:approvals:decide", tag: "ai", requestBody: true },
  // The killswitch is `pause`, not `write`: compliance may pull it mid-incident
  // without also being able to reconfigure the agent. A reason is required.
  { method: "post", path: "/v1/ai/agents/{key}/pause", summary: "Pause an agent", permission: "ai:agents:pause", tag: "ai", requestBody: true },
  { method: "post", path: "/v1/ai/agents/{key}/resume", summary: "Resume a paused agent", permission: "ai:agents:write", tag: "ai" },
  { method: "post", path: "/v1/ai/agents/{key}/autonomy", summary: "Change an agent's autonomy level", permission: "ai:agents:write", tag: "ai", requestBody: true },
  { method: "get", path: "/v1/ai/kill-switches", summary: "Which AI kill switches are engaged: global, tenant, per module", permission: "ai:agents:read", tag: "ai" },
  { method: "post", path: "/v1/ai/pause", summary: "Pause AI for the tenant, or for one module (docs/12 §4)", permission: "ai:killswitch:use", tag: "ai", requestBody: true },
  { method: "post", path: "/v1/ai/resume", summary: "Release the tenant or module AI pause", permission: "ai:agents:write", tag: "ai", requestBody: true },
  { method: "get", path: "/v1/ai/audit", summary: "Every model call, prompt hash and cost", permission: "ai:audit:read", tag: "ai" },
  { method: "get", path: "/v1/ai/audit/spend", summary: "Spend rolled up by module and purpose", permission: "ai:budgets:read", tag: "ai" },

  // The three compliance runs and the bundle they produce. The matching CRUD
  // creates are shadowed by handlers that only ever 400: a screening's query
  // hash and a bundle's manifest are evidence, and evidence a caller can type
  // is not evidence (routes/compliance.ts).
  { method: "post", path: "/v1/compliance/screenings/run", summary: "Screen a customer or name against the watchlists and record the hashed query", permission: "compliance:screenings:run", tag: "compliance", requestBody: true },
  { method: "post", path: "/v1/compliance/evidence-bundles/export", summary: "Assemble an evidence bundle and record its manifest and hash", permission: "compliance:evidence:export", tag: "compliance", requestBody: true },
  { method: "get", path: "/v1/compliance/evidence-bundles/{id}/download", summary: "Download an assembled evidence bundle", permission: "compliance:evidence:read", tag: "compliance" },
  { method: "post", path: "/v1/compliance/retention/run", summary: "Run a retention class and record what it purged", permission: "compliance:retention:run", tag: "compliance", requestBody: true },

  // docs/16 H8 Shariah-board review lane, docs/27 F45. Submitting asks the
  // board a question; certifying answers it and is gated on
  // `compliance.shariah_certify` (dual control, never auto-approvable). The
  // ruling is refused through the generic product CRUD, so these are the only
  // way into `core_products.takaful_json.shariah`.
  { method: "post", path: "/v1/compliance/shariah/submit", summary: "Put a takaful product's terms in front of the Shariah board", permission: "compliance:shariah:read", tag: "compliance", requestBody: true },
  { method: "post", path: "/v1/compliance/shariah/certify", summary: "Record the Shariah board's ruling on a takaful product", permission: "compliance:shariah:certify", tag: "compliance", requestBody: true },
  { method: "get", path: "/v1/compliance/shariah/{productId}", summary: "A takaful product's structure and the standing Shariah ruling on it", permission: "compliance:shariah:read", tag: "compliance" },

  // docs/18 C7. Sponsored placement is gated on a disclosure shown first
  // (docs/19 §AD-PLACEMENT requires DISCLOSURE-PRESENT); this records the hash
  // of the exact wording shown, not the wording itself, as the evidence.
  { method: "post", path: "/v1/compliance/disclosures/present", summary: "Record that a required disclosure was shown, hashing the wording as evidence", permission: "compliance:disclosures:present", tag: "compliance", requestBody: true },

  // The dataset list carries no permission of its own: it returns only the
  // datasets the caller may already read, so an empty list is the answer for
  // someone with no analytics rights at all.
  { method: "get", path: "/v1/analytics/datasets", summary: "Semantic layer the report builder may offer this caller", tag: "analytics" },
  { method: "get", path: "/v1/analytics/reports", summary: "Saved reports the caller may run, newest first", permission: "analytics:reports:read", tag: "analytics" },
  { method: "post", path: "/v1/analytics/reports", summary: "Save a report; it inherits the dataset's permission, never one from the body", permission: "analytics:reports:write", tag: "analytics", requestBody: true },
  { method: "get", path: "/v1/analytics/reports/{id}", summary: "One saved report definition", permission: "analytics:reports:read", tag: "analytics" },
  { method: "patch", path: "/v1/analytics/reports/{id}", summary: "Edit a saved report (system reports must be cloned first)", permission: "analytics:reports:write", tag: "analytics", requestBody: true },
  { method: "delete", path: "/v1/analytics/reports/{id}", summary: "Delete a saved report", permission: "analytics:reports:write", tag: "analytics" },
  { method: "post", path: "/v1/analytics/reports/{id}/run", summary: "Run a saved report", permission: "analytics:reports:run", tag: "analytics", requestBody: true },
  { method: "post", path: "/v1/analytics/run", summary: "Run an ad-hoc report definition without saving it", permission: "analytics:reports:run", tag: "analytics", requestBody: true },
  { method: "post", path: "/v1/analytics/ask", summary: "Compile a question in words into a report definition over the caller's own catalogue (gateway purpose analytics.ask, audited); runs nothing, 422 ask_refused rather than a guess", permission: "analytics:reports:run", tag: "analytics", requestBody: true },
  { method: "get", path: "/v1/analytics/runs/{id}", summary: "A completed run with its rows, totals and truncation flag", permission: "analytics:reports:read", tag: "analytics" },
  { method: "post", path: "/v1/analytics/exports", summary: "Render a run to xlsx, pdf, csv or json", permission: "analytics:exports:create", tag: "analytics", requestBody: true },
  { method: "get", path: "/v1/analytics/exports", summary: "The caller's recent exports and their state", permission: "analytics:exports:create", tag: "analytics" },
  { method: "get", path: "/v1/analytics/exports/{id}/download", summary: "Download a rendered export", permission: "analytics:exports:download", tag: "analytics" },
  { method: "get", path: "/v1/analytics/feed/{dataset}", summary: "Incremental NDJSON feed of one dataset for a warehouse or BI tool", permission: "analytics:exports:create", tag: "analytics" },
  { method: "get", path: "/v1/analytics/schedules", summary: "Report schedules and their next run", permission: "analytics:schedules:read", tag: "analytics" },
  { method: "post", path: "/v1/analytics/schedules", summary: "Schedule a report to run and deliver on a cron", permission: "analytics:schedules:write", tag: "analytics", requestBody: true },
  { method: "post", path: "/v1/analytics/schedules/{id}/pause", summary: "Pause a schedule", permission: "analytics:schedules:write", tag: "analytics" },
  { method: "post", path: "/v1/analytics/schedules/{id}/resume", summary: "Resume a paused schedule", permission: "analytics:schedules:write", tag: "analytics" },
  { method: "delete", path: "/v1/analytics/schedules/{id}", summary: "Delete a schedule", permission: "analytics:schedules:write", tag: "analytics" },
  { method: "get", path: "/v1/analytics/dashboards", summary: "Dashboards the caller may open", permission: "analytics:dashboards:read", tag: "analytics" },
  { method: "post", path: "/v1/analytics/dashboards", summary: "Create a dashboard from a set of report tiles", permission: "analytics:dashboards:write", tag: "analytics", requestBody: true },
  { method: "get", path: "/v1/analytics/dashboards/{id}/data", summary: "Every tile on a dashboard in one call", permission: "analytics:dashboards:read", tag: "analytics" },
  { method: "get", path: "/v1/analytics/saved-views", summary: "The caller's saved list views", permission: "analytics:saved_views:read", tag: "analytics" },
  { method: "post", path: "/v1/analytics/saved-views", summary: "Save the current filters and columns of a list", permission: "analytics:saved_views:write", tag: "analytics", requestBody: true },
  { method: "delete", path: "/v1/analytics/saved-views/{id}", summary: "Delete a saved view", permission: "analytics:saved_views:write", tag: "analytics" },
  { method: "get", path: "/v1/analytics/unit-economics", summary: "Cost, revenue and margin per unit of work", permission: "analytics:reports:read", tag: "analytics" },
  { method: "get", path: "/v1/analytics/usage", summary: "Per-tenant storage and daily egress bytes", permission: "analytics:reports:read", tag: "analytics" },

  // Onboarding. The rows are readable as CRUD (`core/onboarding-steps`,
  // `dist/partner-agreements`) and moved only from here: a step's state and a
  // partner's stage are the output of a process, never a field a caller sets.
  { method: "post", path: "/v1/onboarding/steps", summary: "Generate an onboarding checklist from a template for a partner, channel or member of staff", permission: "core:onboarding:write", tag: "onboarding", requestBody: true },
  { method: "get", path: "/v1/onboarding/steps", summary: "One subject's checklist and which steps are blocking a given stage", permission: "core:onboarding:read", tag: "onboarding" },
  { method: "post", path: "/v1/onboarding/steps/{id}/complete", summary: "Clear a step, attaching the evidence its kind requires", permission: "core:onboarding:write", tag: "onboarding", requestBody: true },
  { method: "post", path: "/v1/onboarding/steps/{id}/fail", summary: "Record that a step came back negative, with the reason", permission: "core:onboarding:write", tag: "onboarding", requestBody: true },
  // Waiving lets something go live unproven, so it is dual-control and never
  // auto-approvable (approvals.ts `core.onboarding_waive`).
  { method: "post", path: "/v1/onboarding/steps/{id}/waive", summary: "Waive a required step (dual control; the waiver is recorded against it)", permission: "core:onboarding:waive", tag: "onboarding", requestBody: true },
  // J-X3: the one onboarding route with no session — a developer signs up,
  // gets a prospect-stage partner and a sandbox-scoped key back, same day.
  { method: "post", path: "/v1/onboarding/partners/signup", summary: "Self-service partner signup: creates a prospect-stage partner and mints a sandbox API key", tag: "onboarding", requestBody: true, public: true },
  { method: "post", path: "/v1/onboarding/partners/{id}/advance", summary: "Advance a partner one stage, refused while a step gating it is open", permission: "orbit:partners:update", tag: "onboarding" },
  { method: "post", path: "/v1/onboarding/partners/{id}/suspend", summary: "Stop trading with a partner without unwinding their diligence", permission: "orbit:partners:update", tag: "onboarding", requestBody: true },
  { method: "post", path: "/v1/onboarding/partners/{id}/resume", summary: "Resume trading with a suspended partner", permission: "orbit:partners:update", tag: "onboarding" },
  { method: "post", path: "/v1/onboarding/partners/{id}/terminate", summary: "End a partnership; the record and its agreements stay readable", permission: "orbit:partners:update", tag: "onboarding", requestBody: true },
  { method: "post", path: "/v1/onboarding/agreements", summary: "Draft the next version of a partner agreement", permission: "dist:agreements:write", tag: "onboarding", requestBody: true },
  { method: "post", path: "/v1/onboarding/agreements/{id}/send", summary: "Send a drafted agreement for signature", permission: "dist:agreements:write", tag: "onboarding" },

  // Orbit. The AgentRoom Durable Object holds a conversation's in-memory turn
  // state and checkpoints it to orbit_messages/orbit_conversations (docs/02 §4).
  { method: "post", path: "/v1/orbit/conversations/{id}/turns", summary: "Append a turn to a conversation, checkpointed to orbit_messages", permission: "orbit:messages:send", tag: "orbit", requestBody: true },
  { method: "post", path: "/v1/orbit/conversations/{id}/reply", summary: "Send a reply out over the conversation's channel connector", permission: "orbit:messages:send", tag: "orbit", requestBody: true },
  // The inbound half of the same seam (routes/channels.ts, ADR-0037). Called by
  // the provider, not by an integrator: the URL is pasted into Meta's or
  // Mailgun's console, and the adapter's own HMAC check is the authentication —
  // so both are public by shape (mw.ts `/v1/channels/*`), like /v1/portal/*.
  // Documented rather than hidden because a tenant setting a connector up needs
  // the callback URL, and the router-walk test in api.test.ts treats an
  // undocumented /v1 route as an omission.
  { method: "get", path: "/v1/channels/{connectorId}/webhook", summary: "Provider subscription handshake; echoes the challenge when the verify token matches", tag: "orbit", public: true },
  { method: "post", path: "/v1/channels/{connectorId}/webhook", summary: "Provider webhook delivery: signature-verified inbound messages and delivery receipts", tag: "orbit", requestBody: true, public: true },
  { method: "post", path: "/v1/orbit/renewals/sweep", summary: "Force the renewal sweep now (also runs on the scheduled tick)", permission: "orbit:renewals:update", tag: "orbit" },
  { method: "post", path: "/v1/orbit/routing/sweep", summary: "Force the routing sweep now — SLA breach escalation and absence reassignment (also runs on the scheduled tick)", permission: "orbit:conversations:assign", tag: "orbit" },
  { method: "post", path: "/v1/orbit/drafts/sweep", summary: "Force the AI reply-draft sweep now — drafts a pending agent_ai reply for every conversation waiting on us (also runs on the scheduled tick)", permission: "orbit:ai:invoke", tag: "orbit" },
  { method: "post", path: "/v1/orbit/kb/search", summary: "What the knowledge base has on a question, best answer first (POST so a customer's own words stay out of access logs)", permission: "orbit:kb:read", tag: "orbit", requestBody: true },
  { method: "post", path: "/v1/orbit/kb/articles/{id}/publish", summary: "Publish a knowledge-base article and embed it — the act that makes it answerable to a customer", permission: "orbit:kb:publish", tag: "orbit" },
  { method: "post", path: "/v1/orbit/conversations/{id}/deflect", summary: "Try to answer this conversation's question from the knowledge base; the result says whether it did", permission: "orbit:ai:invoke", tag: "orbit", requestBody: true },
  { method: "post", path: "/v1/orbit/conversations/{id}/macro", summary: "Send a canned reply into the conversation, in the language the conversation is in", permission: "orbit:conversations:reply", tag: "orbit", requestBody: true },
  { method: "post", path: "/v1/orbit/journeys/sweep", summary: "Force the journey advance step now — elapsed waits, closed tasks and lifted quiet-hours deferrals (also runs on the scheduled tick)", permission: "orbit:journeys:publish", tag: "orbit" },
  { method: "post", path: "/v1/orbit/journeys/{id}/trigger", summary: "Enrol a cohort in a journey by hand; the normal path is the event bus", permission: "orbit:journeys:publish", tag: "orbit", requestBody: true },
  { method: "post", path: "/v1/orbit/partners/{id}/quotes", summary: "Request a partner pricing quote (sandbox partners get clearly-marked synthetic pricing)", permission: "orbit:partners:read", tag: "orbit", requestBody: true },
  // Staff read the hosted-page link so they can send it; gated on the same read
  // permission as the row it points at, because a link is as sensitive as the row.
  { method: "get", path: "/v1/orbit/portal-links/{kind}/{id}", summary: "The tenant-branded public link for a renewal (one-tap accept) or a closed conversation (CSAT)", permission: "orbit:renewals:read", tag: "orbit" },

  // Signal. Brief in, N compliance-checked ar/en variants out — the
  // Meta/Google publish half is credential-blocked and out of scope.
  { method: "post", path: "/v1/signal/campaigns/{id}/plan", summary: "Plan a campaign in three ranked options, each with a probability of success and the reasons behind it, suggesting and linking a targeting pool when the campaign has none", permission: "signal:campaigns:update", tag: "signal", requestBody: true },
  { method: "post", path: "/v1/signal/audiences/suggest", summary: "Propose a targetable audience for a subject from k-anonymous attribute counts, with the reason each band was chosen (docs/17 \u00a7SIG-025; protected attributes excluded per \u00a7SIG-034)", permission: "signal:audiences:estimate", tag: "signal", requestBody: true },
  { method: "post", path: "/v1/signal/creatives/generate", summary: "Generate ad-copy variants from a brief, compliance-checked and audited per locale", permission: "signal:creatives:generate", tag: "signal", requestBody: true },
  { method: "post", path: "/v1/signal/creatives/image", summary: "Generate a hero/post image from a prompt (ADR-0060); stores bytes to R2 and returns a data URL for immediate preview", permission: "signal:creatives:generate", tag: "signal", requestBody: true },
  { method: "get", path: "/v1/signal/creatives/{id}/image", summary: "Re-stream a previously generated creative image's bytes", permission: "signal:creatives:read", tag: "signal" },
  { method: "post", path: "/v1/signal/autopilot/pause", summary: "Pause the budget autopilot kill switch", permission: "signal:autopilot:pause", tag: "signal" },
  { method: "post", path: "/v1/signal/autopilot/resume", summary: "Resume the budget autopilot", permission: "signal:autopilot:pause", tag: "signal" },

  // Scout. Cold-start whitespace from real AXIS quote demand vs. own policy
  // coverage (docs/8 clause 1); wording diffs and the negotiation pack both
  // feed the panel-bench negotiation workflow (docs §2.3, §2.5).
  { method: "post", path: "/v1/scout/whitespaces/compute", summary: "Run the whitespace sweep now against real quote demand vs. policy coverage", permission: "scout:whitespaces:promote", tag: "scout" },
  { method: "get", path: "/v1/scout/whitespaces/commentary", summary: "Why each live whitespace is whitespace: the cached one-line commentary plus the evidence it was grounded against, for every candidate at once (the Radar's hover prefetch)", permission: "scout:whitespaces:read", tag: "scout" },
  { method: "get", path: "/v1/scout/whitespaces/{id}/commentary", summary: "One candidate's commentary, evidence and AI provenance", permission: "scout:whitespaces:read", tag: "scout" },
  { method: "post", path: "/v1/scout/whitespaces/{id}/promote-to-signal", summary: "Promote a whitespace into a draft SIGNAL campaign with AI-drafted brief and creative variants (approval-gated, idempotent, nothing sent)", permission: "scout:whitespaces:promote", tag: "scout" },
  { method: "post", path: "/v1/scout/signals/similar", summary: "Nearest signals to a phrase, from the market embedding index", permission: "scout:signals:read", tag: "scout", requestBody: true },
  { method: "post", path: "/v1/scout/signals/harvest", summary: "Run the Harvester: every registered signal source, plus any fed items, recorded once per (source, sourceRef)", permission: "scout:signals:ingest", tag: "scout", requestBody: true },
  { method: "get", path: "/v1/scout/sources", summary: "The registered signal sources — id, kind, and whether the adapter leaves LYRA (none do today, ADR-0078)", permission: "scout:signals:read", tag: "scout" },
  { method: "post", path: "/v1/scout/clusters/sweep", summary: "Run the Clusterer over the persisted signal corpus: places each signal against the market embedding index, re-scores momentum, stamps cluster ids", permission: "scout:clusters:build", tag: "scout" },
  { method: "post", path: "/v1/scout/panel-bench/sweep", summary: "Run the Bench Builder: rebuild every provider x line x month cell from the panel's own quote outcomes", permission: "scout:panel_bench:build", tag: "scout" },
  { method: "get", path: "/v1/scout/watch", summary: "Competitor and regulatory watch: each watched subject's window scored against the one before it", permission: "scout:signals:read", tag: "scout" },
  { method: "get", path: "/v1/scout/config", summary: "The tenant's resolved SCOUT k-anonymity floor", permission: "scout:signals:read", tag: "scout" },
  { method: "post", path: "/v1/scout/wording-diff", summary: "Word-level diff of two coverage-wording texts (PDF extraction deferred, see ADR-0016)", permission: "scout:panel_bench:read", tag: "scout", requestBody: true },
  { method: "get", path: "/v1/scout/panel-bench/negotiation-pack", summary: "Bench + whitespace negotiation pack as a downloadable PDF", permission: "scout:whitespaces:promote", tag: "scout" },

  // North. The daily briefing and the board pack are both real assembly + AI
  // pipelines, gated ahead of generic CRUD so neither accepts a fabricated body.
  { method: "post", path: "/v1/north/briefings/generate", summary: "Generate an executive briefing from live metric snapshots, numeric claims verified against the input", permission: "north:briefings:generate", tag: "north", requestBody: true },
  { method: "post", path: "/v1/north/boardpacks", summary: "Assemble a board pack PDF from the latest briefing, period metrics and open decisions", permission: "north:boardpacks:generate", tag: "north", requestBody: true },
  { method: "get", path: "/v1/north/boardpacks/{id}/file", summary: "Download the rendered board pack PDF", permission: "north:boardpacks:read", tag: "north" },
  // Guarded on `write` on purpose: the drafter asks, and the
  // `dist.agreement_sign` approval — decided by `dist:agreements:sign` — binds.
  { method: "post", path: "/v1/onboarding/agreements/{id}/sign", summary: "Countersign an agreement (dual control; supersedes the previous version)", permission: "dist:agreements:write", tag: "onboarding", requestBody: true },

  // Settlement. Nothing here writes `state`, `net_minor` or a journal line
  // directly: a payout is the output of four verbs, each with its own approval.
  { method: "post", path: "/v1/settlement/runs", summary: "Draft a counterparty's commission settlement for a period (arithmetic only, nothing posts)", permission: "dist:commissions:settle", tag: "settlement", requestBody: true },
  { method: "get", path: "/v1/settlement/settlements/{id}", summary: "One settlement with its totals and state", permission: "dist:commissions:read", tag: "settlement" },
  { method: "get", path: "/v1/settlement/settlements/{id}/lines", summary: "The entries behind the total, with the agreement terms applied", permission: "dist:commissions:read", tag: "settlement" },
  { method: "post", path: "/v1/settlement/settlements/{id}/approve", summary: "Approve the number and accrue it (dual control; the runner may not self-approve)", permission: "dist:commissions:settle", tag: "settlement" },
  // Approving the amount and releasing the cash are two decisions by two
  // people, so the payout carries its own policy rather than reusing the accrual's.
  { method: "post", path: "/v1/settlement/settlements/{id}/pay", summary: "Release the payout and post it, with the bank/PSP reference that proves it (a second signature, held by a controller)", permission: "ledger:payouts:approve", tag: "settlement", requestBody: true },
  { method: "post", path: "/v1/settlement/settlements/{id}/dispute", summary: "Mark a settlement disputed with the counterparty's reason", permission: "dist:commissions:settle", tag: "settlement", requestBody: true },
  { method: "post", path: "/v1/settlement/settlements/{id}/reopen", summary: "Reopen a disputed settlement so the period can be restated", permission: "dist:commissions:settle", tag: "settlement", requestBody: true },
  { method: "get", path: "/v1/settlement/settlements/{id}/statement", summary: "Remittance advice as pdf, xlsx, csv or json", permission: "dist:commissions:read", tag: "settlement" },

  // Staff. Joining, moving and leaving each touch permissions, credentials and
  // other people's open work at once, so each is one transaction with one audit
  // entry rather than four PATCHes an operator might do three of.
  { method: "post", path: "/v1/staff/invitations", summary: "Create a staff account with its roles, teams and joiner checklist", permission: "core:users:create", tag: "staff", requestBody: true },
  { method: "post", path: "/v1/staff/users/{id}/onboarding", summary: "Re-run the joiner checklist for an account that already exists", permission: "core:onboarding:write", tag: "staff", requestBody: true },
  // Refused outright when it would grant a permission the caller does not hold:
  // role assignment is otherwise a privilege-escalation path.
  { method: "post", path: "/v1/staff/users/{id}/roles", summary: "Add or remove roles; never grants what the caller lacks", permission: "core:roles:assign", tag: "staff", requestBody: true },
  { method: "post", path: "/v1/staff/users/{id}/offboard", summary: "Revoke every credential and reassign every open item to a named owner", permission: "core:users:update", tag: "staff", requestBody: true },
  // Id and display name only: a person picker is not a reason to hand out the
  // staff directory.
  { method: "get", path: "/v1/staff/users", summary: "People picker for assignment surfaces: id and display name only", permission: "core:users:read", tag: "staff" },
  { method: "post", path: "/v1/staff/delegations", summary: "Delegate the authority to approve for a window (itself approved)", permission: "core:delegations:write", tag: "staff", requestBody: true },
  { method: "get", path: "/v1/staff/delegations", summary: "Who currently holds whose authority", permission: "core:delegations:read", tag: "staff" },
  { method: "post", path: "/v1/staff/delegations/{id}/revoke", summary: "Revoke a delegation; handing your own authority back needs no administrator", permission: "core:delegations:write", tag: "staff", requestBody: true },
  { method: "post", path: "/v1/staff/delegations/expire", summary: "Sweep delegations whose window has closed (also runs on the scheduled tick)", permission: "core:delegations:write", tag: "staff" },
  { method: "post", path: "/v1/north/snapshotter/run", summary: "Force the NORTH metric snapshot and anomaly scan now (also runs on the scheduled tick)", permission: "north:snapshots:run", tag: "north" },
  { method: "post", path: "/v1/signal/autopilot/run", summary: "Force the SIGNAL budget autopilot pass now", permission: "signal:autopilot:run", tag: "signal" },
  { method: "post", path: "/v1/axis/cases/import", summary: "Bulk-import cases from CSV (AXIS-001). Per-row honest: the response names every line that failed and why; duplicate refs are counted, not errors", permission: "axis:cases:create", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/cases/bulk", summary: "Bulk actions on cases — assign, reprioritise, close, tag (AXIS-007). Per-row permission checks and audit; the response names every case that failed and why", permission: "axis:cases:update", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/signal/outreach/run", summary: "Run the acquisition outreach sweep now — draft, consent-gate, approval-gate, send, and record the lead touch (also runs on the nightly tick)", permission: "signal:outreach:send", tag: "signal" },
  { method: "post", path: "/v1/signal/spend/import", summary: "Import spend actuals from CSV (day, campaignId, channel, amountMinor, currency, impressions, clicks, conversions). Per-line honest; a (campaign, channel, day) already held is corrected, not doubled", permission: "signal:spend:write", tag: "signal", requestBody: true },
  { method: "get", path: "/v1/signal/responses/rollup", summary: "Responses to outreach (delivered, read, replied, lead, bind, opted out) counted per campaign, audience or person: ?level=campaign|audience|customer&since=", permission: "signal:campaigns:read", tag: "signal" },
  { method: "get", path: "/v1/signal/attribution/funnel", summary: "The acquisition funnel aggregated per campaign and channel for a window — impressions, clicks, visits, leads, binds and value", permission: "signal:attribution:read", tag: "signal" },
  // Demo deployments only: answers 404 when ENVIRONMENT is production.
  { method: "post", path: "/v1/signal/demo/spend-tick", summary: "Insert a spend row per channel per live campaign, keyed off the simulated clock (non-production only)", permission: "signal:autopilot:run", tag: "signal" },

  // docs/25 admin_security. Read-only truth about the platform MFA floor and
  // who currently sits outside it (routes/core.ts).
  { method: "get", path: "/v1/core/security-posture", summary: "MFA enrolment and session posture for the tenant's people, against the estate-wide floor", permission: "core:settings:read", tag: "core" },
  // Reuses the real delivery path with a hand-built envelope, same signature
  // scheme production events use (routes/core.ts developer console tester).
  { method: "post", path: "/v1/core/webhooks/{id}/test", summary: "Send a signed test delivery to a webhook, without a queued event behind it", permission: "core:webhooks:read", tag: "core" },

  // NORTH explorer and data health (routes/north.ts). Explorer reads a fixed
  // set of columns off north_snapshots only, never a client SQL string.
  { method: "get", path: "/v1/ledger/recon/statement-formats", summary: "Bank statement formats the importer can read (CAMT.053, MT940, OFX)", permission: "ledger:recon:read", tag: "ledger" },
  { method: "get", path: "/v1/ledger/fx-revaluation", summary: "What a period-end FX revaluation of open foreign balances would post (docs/19 §5.3)", permission: "ledger:journals:read", tag: "ledger" },
  { method: "post", path: "/v1/ledger/fx-revaluation", summary: "Post the period-end FX revaluation; idempotent per period", permission: "ledger:journals:post", tag: "ledger" },
  { method: "post", path: "/v1/north/snapshots/{id}/verify", summary: "Attest to a computed metric snapshot, so a SUCCESS-FEE may be charged on it (docs/19 §11.10)", permission: "north:metrics:write", tag: "north", requestBody: true },
  { method: "post", path: "/v1/north/explore", summary: "Query north_snapshots by metric keys, grain and period", permission: "north:snapshots:read", tag: "north", requestBody: true },
  { method: "get", path: "/v1/north/journeys", summary: "Journey health: each documented journey's funnel from the audit log, ?days= window", permission: "north:metrics:read", tag: "north" },
  { method: "get", path: "/v1/north/data-health", summary: "Staleness per metric, computed live from the snapshot table", permission: "north:metrics:read", tag: "north" },
  // docs/27 F50. Reads closed snapshots only and answers with a band per
  // period plus the fit that produced it; no model is in this path.
  { method: "get", path: "/v1/north/forecast", summary: "Project a metric forward from its closed snapshots — damped Holt, p10/p50/p90, with the fitted parameters", permission: "north:forecasts:read", tag: "north" },

  // AXIS copilot and developer sandbox (routes/axis.ts).
  { method: "post", path: "/v1/axis/cases/{id}/copilot", summary: "Answer a question about a case, grounded only in its own documents, events and tasks", permission: "axis:cases:read", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/dev/extract-sample", summary: "Developer console: run field extraction against pasted text, no document row created", permission: "dev:sandbox:use", tag: "axis", requestBody: true },
  { method: "get", path: "/v1/axis/documents/{id}/file", summary: "Stream a document's underlying file", permission: "axis:documents:read", tag: "axis" },

  // Bordereaux (routes/axis.ts, docs/27 §E). Outbound totals our own ledger for
  // the period; inbound stores a counterparty's raw lines for reconciliation.
  { method: "post", path: "/v1/axis/bordereaux", summary: "Generate an outbound bordereau from ledger data, or store an inbound one's raw lines (idempotent per period)", permission: "axis:bordereaux:generate", tag: "axis", requestBody: true },
  { method: "post", path: "/v1/axis/bordereaux/{id}/reconcile", summary: "Match an inbound bordereau's lines against our policies by policy number", permission: "axis:bordereaux:reconcile", tag: "axis" },

  // Platform console (routes/platform.ts, ADR-0028/ADR-0029). Cross-tenant,
  // gated on admin:* / core:impersonate:use rather than a tenant permission —
  // there is no tenant to scope most of these against.
  { method: "get", path: "/v1/platform/flags", summary: "Every feature flag and its rollout", permission: "admin:flags:read", tag: "platform" },
  { method: "post", path: "/v1/platform/flags", summary: "Create a feature flag, disabled by default", permission: "admin:flags:write", tag: "platform", requestBody: true },
  // Flipping `enabled` is dual-control (core.flag_toggle); a rollout-percent
  // nudge on its own is not.
  { method: "patch", path: "/v1/platform/flags/{id}", summary: "Update a flag's rollout or enable it (enabling gates on the core.flag_toggle approval)", permission: "admin:flags:write", tag: "platform", requestBody: true },
  { method: "post", path: "/v1/platform/ai/kill", summary: "Throw the global AI kill switch — one click, no approval (docs/12 §4)", permission: "admin:flags:write", tag: "platform", requestBody: true },
  { method: "post", path: "/v1/platform/ai/release", summary: "Release the global AI kill switch (gates on the core.flag_toggle approval)", permission: "admin:flags:write", tag: "platform" },

  { method: "get", path: "/v1/platform/ops/overview", summary: "Outbox backlog, DLQ depth and pending approvals, per tenant", permission: "admin:diagnostics:read", tag: "platform" },
  { method: "get", path: "/v1/platform/slo", summary: "Every SLO definition with its actual and burn percent over its window", permission: "admin:diagnostics:read", tag: "platform" },
  { method: "get", path: "/v1/platform/impersonation", summary: "The caller's own live impersonation sessions", permission: "core:impersonate:use", tag: "platform" },
  { method: "post", path: "/v1/platform/impersonation/start", summary: "Start impersonating a user (dual control; never auto-approved)", permission: "core:impersonate:use", tag: "platform", requestBody: true },
  { method: "post", path: "/v1/platform/impersonation/{id}/end", summary: "End one of the caller's own impersonation sessions", permission: "core:impersonate:use", tag: "platform" },
  { method: "get", path: "/v1/platform/incidents", summary: "Outage incidents across every tenant, newest first", permission: "admin:diagnostics:read", tag: "platform" },
  { method: "get", path: "/v1/platform/deployments", summary: "Deployment history, newest first", permission: "admin:diagnostics:read", tag: "platform" },

  // The public comparison site (routes/portal.ts). No session exists yet, so
  // both are public by shape (mw.ts `/v1/portal/*`).
  { method: "get", path: "/v1/portal/{tenantSlug}/site", summary: "A tenant's public storefront: brand and active products", tag: "portal", public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/leads", summary: "Submit a quote lead from the public storefront; rate-limited per email", tag: "portal", requestBody: true, public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/track", summary: "Record an acquisition touch (impression, click or visit) from the public tracking pixel; rate-limited per IP. A lead or bind must be signed (ADR-0092): x-lyra-key-id (a tenant webhook id), x-lyra-timestamp, x-lyra-signature v1=HMAC-SHA256(secret, `${timestamp}.${body}`); a replayed eventId is answered 200 with duplicate: true", tag: "portal", requestBody: true, public: true },
  // J-C1 self-serve. The visitor has no session, so the one-time token from the
  // lead response is the credential on all three (ADR-0043).
  { method: "get", path: "/v1/portal/{tenantSlug}/quote-requests/{id}", summary: "Re-open a self-serve comparison with the one-time token", tag: "portal", public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/quote-requests/{id}/accept", summary: "Customer accepts a quoted offer; converts the request, does not bind cover", tag: "portal", requestBody: true, public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/quote-requests/{id}/documents", summary: "Upload a supporting document against a self-serve quote (multipart)", tag: "portal", requestBody: true, public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/quote-requests/{id}/reprice", summary: "Indicative re-price of the same panel with moved rating criteria; persists nothing and binds nothing", tag: "portal", requestBody: true, public: true },
  // Self-registration. Writes a customer record at kyc_status=pending and
  // nothing else — no user, no session, no key — so the reply carries no handle.
  { method: "post", path: "/v1/portal/{tenantSlug}/registrations", summary: "Self-registration from the public storefront (person or business); records a pending customer, grants no access", tag: "portal", requestBody: true, public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/privacy-requests", summary: "Data subject lodges an access/erasure/rectification request (J-C4); recorded unverified, staff verify before fulfilment", tag: "portal", requestBody: true, public: true },
  // J-C3 one-tap renewal and J-C2's CSAT tap: hosted, tenant-branded pages
  // opened from a messaged link. The credential is the link's derived token
  // (routes/portal.ts §portalLinkToken) — no session, so public by shape.
  { method: "get", path: "/v1/portal/{tenantSlug}/renewals/{id}", summary: "Open a renewal offer with its link token (reference, expiry and state only)", tag: "portal", public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/renewals/{id}/accept", summary: "Customer accepts a renewal in one tap; records the decision, does not bind or charge", tag: "portal", requestBody: true, public: true },
  { method: "get", path: "/v1/portal/{tenantSlug}/feedback/{id}", summary: "Whether a closed conversation can still be rated, and its rating if already given", tag: "portal", public: true },
  { method: "post", path: "/v1/portal/{tenantSlug}/feedback/{id}", summary: "Submit the CSAT rating (1-5) for a closed conversation; one rating per conversation", tag: "portal", requestBody: true, public: true },

  // Cross-resource search (routes/search.ts, docs/24 Phase 2 item 10). Fans out
  // over every registered resource's searchable columns, filtered again by the
  // searcher's own read permission on each hit.
  { method: "get", path: "/v1/search", summary: "Search across every resource the caller may read", permission: "core:search:read", tag: "search" },

  // Batch ref resolution (routes/names.ts). No permission of its own: each ref
  // is gated by the caller's read permission on the resource it points at, and
  // a ref that resolves to nothing is simply absent from the response.
  { method: "get", path: "/v1/names", summary: "Resolve up to 200 record refs (`cu_…`, `user:us_…`) to display names, per resource read permission", tag: "search" },

  // The other half of the same problem (routes/directory.ts, ADR-0047): names
  // out of refs above, refs out of names here, so an assignment field can be a
  // picker instead of a box a person types a ULID into. Two columns, capped,
  // masked, tenant-scoped; no permission of its own.
  { method: "get", path: "/v1/directory", summary: "List assignable staff and team refs (`?kind=user|team`) for the current tenant", tag: "search" }
];

/**
 * `sessionCookie` is the name a client actually has to send. It is a parameter
 * rather than a read of `env` because packages/sdk generates the client from
 * this document at build time with no environment at all: the generated SDK must
 * describe the default, while the document a deployment serves must describe
 * that deployment. Staging renames the cookie (`SESSION_COOKIE`) so its browsers
 * do not share one with production, and a spec that still said `lyra_session`
 * there was one line of documentation that did not match the server.
 *
 * The default duplicates `COOKIE` in auth.ts rather than importing it — pulling
 * auth.ts in would drag Hono, zod and @lyra/db into the SDK's build for one
 * string. api.test.ts asserts the two agree, so the duplicate cannot drift.
 */
export function openapi(sessionCookie = "lyra_session"): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};

  for (const [module, resources] of Object.entries(BY_MODULE)) {
    for (const res of resources) {
      const name = schemaName(module, res.path);
      schemas[name] = tableSchema(res);
      const base = `/v1/${module}/${res.path}`;
      const ref = { $ref: `#/components/schemas/${name}` };

      put(paths, base, "get", {
        tags: [module],
        summary: `List ${res.path}`,
        parameters: [
          q("limit", "integer", "Page size, max 200"),
          q("cursor", "string", "Opaque keyset cursor from the previous page"),
          q("q", "string", "Free-text search across indexed columns"),
          q("sort", "string", "Column name, prefix with - for descending")
        ],
        security: perm(res.perms.read),
        responses: page(ref)
      });

      if (res.perms.create) {
        put(paths, base, "post", {
          tags: [module],
          summary: `Create a ${singular(res.path)}`,
          security: perm(res.perms.create),
          requestBody: { required: true, content: { "application/json": { schema: ref } } },
          responses: { "201": ok(ref), ...errors(res.approval?.create) }
        });
      }

      const item = `${base}/{id}`;
      put(paths, item, "get", {
        tags: [module],
        summary: `Fetch one ${singular(res.path)}`,
        parameters: [idParam()],
        security: perm(res.perms.read),
        responses: { "200": ok(ref), ...errors() }
      });
      if (res.perms.update && !res.immutable) {
        put(paths, item, "patch", {
          tags: [module],
          summary: `Update a ${singular(res.path)}`,
          parameters: [idParam()],
          security: perm(res.perms.update),
          requestBody: { required: true, content: { "application/json": { schema: ref } } },
          responses: { "200": ok(ref), ...errors(res.approval?.update) }
        });
      }
      if (res.perms.remove && !res.immutable) {
        put(paths, item, "delete", {
          tags: [module],
          summary: `Soft-delete a ${singular(res.path)}`,
          parameters: [idParam()],
          security: perm(res.perms.remove),
          responses: { "204": { description: "Deleted" }, ...errors(res.approval?.remove) }
        });
        // Same condition crud.ts uses to mount it: delete is soft where the
        // table carries `deletedAt`, and a soft delete has an undo.
        if ("deletedAt" in getTableColumns(res.table)) {
          put(paths, `${item}/restore`, "post", {
            tags: [module],
            summary: `Restore a soft-deleted ${singular(res.path)}`,
            parameters: [idParam()],
            security: perm(res.perms.remove),
            responses: { "200": ok(ref), ...errors() }
          });
        }
      }
    }
  }

  for (const op of HAND_WRITTEN) {
    put(paths, op.path, op.method, {
      tags: [op.tag],
      summary: op.summary,
      ...(pathParams(op.path).length ? { parameters: pathParams(op.path) } : {}),
      ...(op.requestBody
        ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } }
        : {}),
      // An endpoint with no permission is still authenticated — it is scoped to
      // the caller. Only the pre-session auth endpoints carry no security at all.
      ...(op.public ? {} : { security: op.permission ? perm(op.permission) : perm() }),
      responses: { "200": ok({ type: "object" }), ...errors() }
    });
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Lyra API",
      version: "1.0.0",
      description:
        "Aggregator platform API. Every endpoint is tenant-scoped, permission-checked and audited. " +
        "Errors are RFC 9457 problem documents. Money is integer minor units with an ISO-4217 code; " +
        "rates are parts per million."
    },
    servers: [{ url: "https://api.lyra.vantax.co.za" }, { url: "http://localhost:8787" }],
    tags: [
      ...Object.keys(BY_MODULE).map((m) => ({ name: m })),
      { name: "auth" },
      { name: "me" },
      // Cross-module processes: each spans more than one module's tables, so it
      // is its own tag rather than filed under whichever module it touches most.
      { name: "onboarding" },
      { name: "settlement" },
      { name: "staff" },
      { name: "platform" },
      { name: "portal" },
      { name: "search" }
    ],
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: sessionCookie },
        apiKey: { type: "http", scheme: "bearer", description: "Partner API key" }
      },
      schemas: {
        ...schemas,
        Problem: {
          type: "object",
          description: "RFC 9457",
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" },
            code: { type: "string" }
          }
        },
        Dataset: {
          type: "object",
          description: "A reportable dataset in the semantic layer",
          properties: {
            key: { type: "string", enum: Object.keys(DATASETS) },
            module: { type: "string" },
            dimensions: { type: "array", items: { type: "object" } },
            metrics: { type: "array", items: { type: "object" } }
          }
        }
      }
    }
  };
}

/* ------------------------------------------------------------------ helpers */

function tableSchema(res: Resource): Record<string, unknown> {
  const cols = getTableColumns(res.table) as Record<string, SQLiteColumn>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, col] of Object.entries(cols)) {
    properties[key] = columnSchema(key, col, res);
    if (col.notNull && !col.hasDefault && !SYSTEM.has(key) && !res.actorColumns?.includes(key)) required.push(key);
  }
  return { type: "object", properties, required };
}

const SYSTEM = new Set(["id", "tenantId", "createdAt", "updatedAt", "deletedAt"]);

function columnSchema(key: string, col: SQLiteColumn, res: Resource): Record<string, unknown> {
  if (res.actorColumns?.includes(key)) {
    return { type: "string", readOnly: true, description: "Set from the authenticated session; refused in a request body" };
  }
  const pii = res.pii && key in res.pii ? { description: "PII — masked unless the actor holds core:pii:view" } : {};
  if (key.endsWith("Json")) return { type: "string", description: "JSON document, stored as text", ...pii };
  if (key.endsWith("Minor")) return { type: "integer", description: "Minor units of the row's currency", ...pii };
  if (key.endsWith("Ppm")) return { type: "integer", description: "Parts per million; 12.5% = 125000", ...pii };
  if (key.endsWith("At") || key === "ts") return { type: "integer", description: "Epoch milliseconds", ...pii };
  const enumValues = (col as { enumValues?: readonly string[] }).enumValues;
  switch (col.dataType) {
    case "number":
      return { type: "integer", ...pii };
    case "boolean":
      return { type: "boolean", ...pii };
    default:
      return { type: "string", ...(enumValues?.length ? { enum: [...enumValues] } : {}), ...pii };
  }
}

function put(paths: Record<string, Record<string, unknown>>, path: string, method: string, op: unknown): void {
  (paths[path] ??= {})[method] = op;
}

function perm(permission?: string): { session: string[] }[] {
  // OpenAPI has no field for "which permission" — the scope list is where an
  // integrator looks, so the permission string goes there verbatim.
  const scopes = permission ? [permission] : [];
  return [{ session: scopes }, { apiKey: scopes } as unknown as { session: string[] }];
}

/** Every `{name}` in a hand-written path becomes a required string parameter. */
function pathParams(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) =>
    name === "id"
      ? idParam()
      : { name, in: "path", required: true, schema: { type: "string" }, description: "Key" }
  );
}

function q(name: string, type: string, description: string): Record<string, unknown> {
  return { name, in: "query", required: false, schema: { type }, description };
}

function idParam(): Record<string, unknown> {
  return { name: "id", in: "path", required: true, schema: { type: "string" }, description: "ULID" };
}

function ok(schema: unknown): Record<string, unknown> {
  return { description: "Success", content: { "application/json": { schema } } };
}

function page(ref: unknown): Record<string, unknown> {
  return {
    "200": {
      description: "A page of rows",
      content: {
        "application/json": {
          schema: {
            type: "object",
            // `cursor`, matching what the lister actually returns (http.ts Page):
            // opaque, passed back as `?cursor=`, absent once the last page is read.
            properties: { data: { type: "array", items: ref }, cursor: { type: "string" } }
          }
        }
      }
    },
    ...errors()
  };
}

function errors(approvalPolicy?: string): Record<string, unknown> {
  const problem = { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } };
  return {
    "400": { description: "Invalid request", ...problem },
    "401": { description: "No valid session", ...problem },
    "403": {
      description: approvalPolicy ? `Forbidden, or approval required (${approvalPolicy})` : "Forbidden",
      ...problem
    },
    "404": { description: "Not found, or not in this tenant", ...problem },
    "409": { description: "Conflict", ...problem },
    "429": { description: "Rate limited", ...problem }
  };
}

function schemaName(module: string, path: string): string {
  const pascal = path.split("-").map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  return `${module[0]!.toUpperCase()}${module.slice(1)}${pascal}`;
}

function singular(path: string): string {
  const word = path.replace(/-/g, " ");
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}
