// docs/04 §3 + docs/06 §1. One authorization path: can(actor, perm, subject).
// Permission strings are `module:resource:action`; `*` is a wildcard segment.
// ABAC lives on the grant, never merged across roles — a team-scoped AXIS lead
// must not inherit the unscoped reach of a second role.

export type Permission = string;

export interface Scope {
  /** core_teams ids the grant is limited to. Empty/absent = tenant-wide. Canonical key: matches ScopeJson. */
  teamIds?: readonly string[];
  /** product lines the grant is limited to (motor, health, ...). */
  productLines?: readonly string[];
  /** modules the grant is limited to. */
  modules?: readonly string[];
  /**
   * core_providers ids the grant is limited to (ROLE-028: provider.viewer).
   * Deliberately NOT read by scopeAllows()/can() — Subject has no providerId
   * dimension, and wiring it into the generic fail-closed check would lock a
   * provider.viewer out of every *other* permission it holds the moment this
   * field is absent (the same class of bug axis.agent hit with teamIds).
   * Consumed directly by the data-products resource's rowVisible instead.
   */
  providerIds?: readonly string[];
}

export interface Grant {
  roleKey: string;
  permissions: readonly Permission[];
  scope?: Scope;
}

export type ActorKind = "user" | "agent" | "partner" | "system" | "customer";

export interface Actor {
  kind: ActorKind;
  /** user id, agent key, partner id, or "system". */
  id: string;
  tenantId: string;
  grants: readonly Grant[];
  /** Platform staff acting inside a tenant; every action is audit-logged. */
  impersonating?: boolean;
}

export interface Subject {
  tenantId: string;
  teamId?: string;
  productLine?: string;
  module?: string;
  /** "user:<id>" | "agent:<key>" — used by `*:own` style checks upstream. */
  ownerRef?: string;
}

/* ------------------------------------------------------------ permissions */

/** Full catalogue. Anything not listed here cannot be granted (validated below). */
export const PERMISSIONS = [
  // core / tenancy
  "core:tenants:read", "core:tenants:update",
  "core:users:read", "core:users:create", "core:users:update", "core:users:delete",
  "core:roles:read", "core:roles:update", "core:roles:assign",
  "core:teams:read", "core:teams:write",
  "core:customers:read", "core:customers:create", "core:customers:update", "core:customers:delete",
  "core:consents:read", "core:consents:create",
  "core:products:read", "core:products:write",
  "core:providers:read", "core:providers:write",
  "core:files:read", "core:files:create", "core:files:delete",
  "core:notifications:read",
  "core:search:read",
  // ADR-0089: the markdown note on a record and its [[links]]. Separate from
  // the record's own grant because writing about a customer is not editing
  // one — and a note is only ever shown to a reader who can also read the
  // record it is about (routes/notes.ts checks both).
  "core:notes:read", "core:notes:write",
  "core:pii:view",
  "core:audit:read", "core:audit:export",
  "core:approvals:read", "core:approvals:decide",
  // Onboarding a partner, a channel or a member of staff is the same checklist
  // shape, so it is one permission family. Waiving a required step is separate
  // from completing one: it is the power to let something go live unproven.
  "core:onboarding:read", "core:onboarding:write", "core:onboarding:waive",
  // "While I am away, my approvals go to them." Granting is separate from
  // reading because a delegation moves authority, not just visibility.
  "core:delegations:read", "core:delegations:write",
  "core:settings:read", "core:settings:update",
  "core:api_keys:read", "core:api_keys:create", "core:api_keys:revoke",
  "core:webhooks:read", "core:webhooks:write",
  "core:identity_providers:read", "core:identity_providers:write",
  "core:impersonate:use",
  "core:templates:read", "core:templates:write",
  "core:locale_overrides:read", "core:locale_overrides:write",

  // DIST — aggregator distribution: channels, offerings, commercials
  "dist:channels:read", "dist:channels:write", "dist:channels:suspend",
  "dist:offerings:read", "dist:offerings:write", "dist:offerings:publish", "dist:offerings:withdraw",
  "dist:rates:read", "dist:rates:write", "dist:rates:approve",
  // `dist:ai:invoke` is not listed here: the per-module invoke permissions are
  // declared together further down, and declaring it twice made the catalogue
  // 256 entries long while only 255 distinct permissions existed.
  // Pushing a comparison out to a customer and recording which quote won are
  // different acts: the first is outbound contact, the second closes the sale
  // and is the AXIS desk's daily work (docs/27 F13).
  "dist:quote_requests:read", "dist:quote_requests:create", "dist:quote_requests:share",
  "dist:quote_requests:select",
  "dist:commissions:read", "dist:commissions:adjust", "dist:commissions:settle",
  "dist:offers:read", "dist:offers:surface", "dist:offers:override",
  // The commercial agreement behind a partnership. Countersigning is separate
  // from drafting so the person who wrote the terms is not the one who binds
  // us to them.
  "dist:agreements:read", "dist:agreements:write", "dist:agreements:sign",

  // AXIS — operations
  "axis:cases:read", "axis:cases:create", "axis:cases:update", "axis:cases:assign",
  "axis:cases:approve", "axis:cases:delete",
  "axis:quotes:read", "axis:quotes:create", "axis:quotes:compare", "axis:quotes:approve",
  "axis:documents:read", "axis:documents:upload", "axis:documents:extract", "axis:documents:verify",
  "axis:tasks:read", "axis:tasks:write",
  // `axis:policies:create` still means "insert a policy row" through generic
  // CRUD; `axis:policies:bind` is the lifecycle verb that issues a contract
  // (docs/specs/gap-axis-design.md §A.1). Authority over the two differs.
  "axis:policies:read", "axis:policies:create", "axis:policies:update", "axis:policies:cancel",
  // `axis:policies:endorse` is the mid-term counterpart of `:bind` — it appends
  // a priced version to a contract that is already on risk (design §A.1). It is
  // not `:update`, which edits the row and moves no money.
  // The rest of the lifecycle verbs (design §A.1). Ending cover and putting it
  // back are distinct authorities: a desk that may cancel need not be the desk
  // that may reinstate, and NTU unwinds a contract nobody was ever on risk for.
  "axis:policies:bind", "axis:policies:endorse", "axis:policies:ntu", "axis:policies:lapse",
  "axis:policies:reinstate", "axis:policies:renew",
  // Opening a premium-financing plan on a bound policy (docs/27 group D):
  // its own lifecycle verb, distinct from `:endorse` — a financing plan
  // changes how the premium is collected, not the risk or price on the
  // contract.
  "axis:policies:finance",
  // Submitting sensor readings (docs/27 F5, UBI) is a machine/device authority,
  // not an underwriting one: a telematics device or fleet integration should be
  // able to post kilometres without also being able to change a price, and the
  // desk that approves a reprice has no reason to be a data ingest endpoint.
  // That separation is why this is not folded into `:endorse`.
  "axis:policies:telemetry",
  // Issuing the document a customer holds is its own authority (design §D.11):
  // a schedule or certificate is evidence of cover, so reissuing one is not
  // covered by `:read` and is not a side effect of `:bind`.
  "axis:policies:document",
  "axis:escrow:read", "axis:escrow:reconcile", "axis:escrow:approve",
  "axis:sops:read", "axis:sops:write",
  "axis:claims:read", "axis:claims:create", "axis:claims:update", "axis:claims:approve",
  // Claims split the handler from the approver (design §A.2): whoever sets a
  // reserve or requests a payment must not be the one who signs it off, so
  // `:reserve`/`:pay` and `:reserve_approve`/`:pay_approve` are separate verbs
  // and never granted to the same role.
  "axis:claims:register", "axis:claims:triage", "axis:claims:reserve",
  "axis:claims:reserve_approve", "axis:claims:pay", "axis:claims:pay_approve",
  "axis:claims:recover", "axis:claims:reopen", "axis:claims:close",
  "axis:metrics:read",
  "axis:ops_policies:read", "axis:ops_policies:write",
  "axis:bordereaux:read", "axis:bordereaux:generate", "axis:bordereaux:reconcile",
  // Referrals, complaints, SIU (docs/specs/gap-axis-design.md §A.1 task 14).
  // `:refer` is raising one (any bind can breach authority); `:decide_referral`
  // is closing it — never the same actor by policy, so kept as two verbs.
  "axis:policies:refer", "axis:policies:decide_referral",
  "axis:complaints:read", "axis:complaints:write", "axis:complaints:close",
  "axis:siu:read", "axis:siu:write", "axis:siu:decide",
  "axis:reports:read",

  // ORBIT — customer experience
  "orbit:conversations:read", "orbit:conversations:reply", "orbit:conversations:assign",
  "orbit:conversations:close",
  "orbit:messages:read", "orbit:messages:send",
  "orbit:renewals:read", "orbit:renewals:update", "orbit:renewals:approve",
  "orbit:journeys:read", "orbit:journeys:write", "orbit:journeys:publish",
  "orbit:partners:read", "orbit:partners:create", "orbit:partners:update", "orbit:partners:certify",
  "orbit:partner_keys:issue_test", "orbit:partner_keys:issue_live",
  "orbit:qa:read", "orbit:qa:score",
  "orbit:handover:read", "orbit:handover:write",
  "orbit:channels:read", "orbit:channels:write",
  "orbit:teams:read", "orbit:teams:write",
  "orbit:kb:read", "orbit:kb:write", "orbit:kb:publish",
  "orbit:macros:read", "orbit:macros:write",
  "orbit:presence:read", "orbit:presence:write",

  // SIGNAL — growth
  "signal:campaigns:read", "signal:campaigns:create", "signal:campaigns:update",
  "signal:campaigns:launch", "signal:campaigns:pause",
  "signal:audiences:read", "signal:audiences:create", "signal:audiences:estimate",
  "signal:creatives:read", "signal:creatives:generate", "signal:creatives:approve",
  "signal:creatives:publish",
  "signal:experiments:read", "signal:experiments:create", "signal:experiments:decide",
  "signal:budget_moves:read", "signal:budget_moves:approve", "signal:budget_moves:reverse",
  "signal:autopilot:pause", "signal:autopilot:run",
  "signal:aeo:read", "signal:aeo:write",
  "signal:attribution:read",
  "signal:spend:read",
  // Acquisition outreach (engines/signal-outreach.ts): reading the ledger is a
  // read; sending to a person is its own grant and gates on signal.outreach_send.
  "signal:outreach:read", "signal:outreach:send",

  // SCOUT — product intelligence
  "scout:signals:read", "scout:signals:ingest",
  // The Clusterer and the Bench Builder are sweeps, not CRUD: they rewrite a
  // whole table from evidence, so running one is its own grant and not implied
  // by reading what it produced (same split /whitespaces/compute already makes).
  "scout:clusters:read", "scout:clusters:build",
  "scout:whitespaces:read", "scout:whitespaces:promote",
  "scout:panel_bench:read", "scout:panel_bench:build",
  "scout:experiments:read", "scout:experiments:create", "scout:experiments:decide",
  "scout:data_products:read", "scout:data_products:create", "scout:data_products:publish",

  // NORTH — executive
  "north:metrics:read", "north:metrics:write",
  "north:snapshots:read", "north:snapshots:run",
  "north:briefings:read", "north:briefings:generate", "north:briefings:approve",
  "north:anomalies:read", "north:anomalies:assign",
  "north:scenarios:read", "north:scenarios:run",
  // A forecast is a forward-looking number with a company-level implication,
  // which is a materially different disclosure from `north:snapshots:read`'s
  // recorded fact (gap-north-design §B.3): whoever may read yesterday's policy
  // count does not thereby get next quarter's projected commission.
  "north:forecasts:read",
  "north:boardpacks:read", "north:boardpacks:generate",
  "north:decisions:read", "north:decisions:write",
  "north:alerts:read", "north:alerts:write",

  // ledger & money (docs/19)
  "ledger:txns:read", "ledger:txns:create", "ledger:txns:authorize", "ledger:txns:reverse",
  "ledger:journals:read", "ledger:journals:post",
  "ledger:accounts:read", "ledger:accounts:write",
  "ledger:periods:read", "ledger:periods:close",
  "ledger:recon:read", "ledger:recon:run", "ledger:recon:confirm", "ledger:recon:export",
  "ledger:invoices:read", "ledger:invoices:create", "ledger:invoices:approve",
  "ledger:payments:read", "ledger:payments:create", "ledger:payments:refund",
  "ledger:payouts:approve",
  "ledger:client_money:read", "ledger:client_money:transfer",
  // ledger — manual journals & equity (docs/27 F2, F3). Drafting is separated
  // from posting, and the three period acts that can rewrite a closed result
  // are separated from the routine close, so no single seat holds both halves.
  "ledger:journals:draft", "ledger:journals:void",
  "ledger:periods:force_close", "ledger:periods:reopen", "ledger:periods:year_end",

  // Running an agent is a per-module permission, not a global one: a marketer
  // who may invoke SIGNAL agents has no business invoking a LEDGER agent.
  "core:ai:invoke", "dist:ai:invoke", "axis:ai:invoke", "orbit:ai:invoke",
  "signal:ai:invoke", "scout:ai:invoke", "north:ai:invoke", "ledger:ai:invoke",

  // AI governance
  "ai:agents:read", "ai:agents:write", "ai:agents:pause",
  "ai:prompts:read", "ai:prompts:write",
  "ai:runs:read",
  "ai:suggestions:read",
  // ADR-0073: the command center. Reading proposals and the run timeline is
  // governance-adjacent; actioning a proposal rides the underlying module's
  // own permission (the gate fires there), never this one.
  "ai:command:read",
  "ai:budgets:read", "ai:budgets:write",
  "ai:evals:read", "ai:evals:run",
  "ai:audit:read",
  "ai:killswitch:use",

  // compliance
  "compliance:dsar:read", "compliance:dsar:create", "compliance:dsar:fulfil",
  "compliance:erasure:execute",
  "compliance:disclosures:read",
  "compliance:disclosures:present",
  "compliance:screenings:read", "compliance:screenings:run",
  "compliance:retention:read", "compliance:retention:run",
  "compliance:legal_holds:read", "compliance:legal_holds:write",
  "compliance:evidence:read", "compliance:evidence:export",
  "compliance:incidents:read", "compliance:incidents:write",
  "compliance:rulepacks:read", "compliance:rulepacks:apply",
  // docs/16 H8's "Shariah-board workflow (review lane like compliance
  // pre-flight)", docs/27 F45. In the compliance namespace and not AXIS's,
  // because that is what it is: a standing ruling on whether a product may be
  // sold at all, issued by a board that sits outside the underwriting desk. The
  // namespace also does the role wiring on its own — `compliance:*:read` and
  // `compliance:*:*` already grant these to the reader and officer roles, so a
  // Shariah lane arrives without a role-table edit and without ADR-0025's
  // unscoped-grant hazard.
  "compliance:shariah:read", "compliance:shariah:certify",
  "compliance:thresholds:read", "compliance:thresholds:write",

  // analytics & reporting
  "analytics:dashboards:read", "analytics:dashboards:write",
  "analytics:reports:read", "analytics:reports:write", "analytics:reports:run",
  "analytics:exports:create", "analytics:exports:download", "analytics:exports:unmasked",
  "analytics:schedules:read", "analytics:schedules:write",
  "analytics:saved_views:read", "analytics:saved_views:write",

  // developer surfaces
  "dev:consoles:read", "dev:sandbox:use", "dev:keys_test:issue", "dev:keys_live:issue",

  // platform staff only
  "admin:tenants:read", "admin:tenants:write",
  "admin:entitlements:write",
  "admin:billing:read", "admin:billing:write",
  "admin:dlq:read", "admin:dlq:replay",
  "admin:flags:read", "admin:flags:write",
  "admin:diagnostics:read"
] as const;

export type KnownPermission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** Read permissions for a module — the base every module role starts from. */
function readsOf(module: string): Permission[] {
  return PERMISSIONS.filter((p) => p.startsWith(`${module}:`) && p.endsWith(":read"));
}

/* ------------------------------------------------------------------ roles */

/**
 * docs/06 §1. `system: true` roles are provisioned into every tenant.
 *
 * `ai:suggestions:read` rides with every `<module>:ai:invoke`. It gates reading a
 * suggestion row *and* recording its outcome, so a persona that is shown an
 * ambient suggestion (docs/15 §4) cannot report back without it — and a surface
 * nobody can measure is a surface that can never be retired. It stops at roles
 * that only read finished artefacts (north.board) or only move money.
 *
 * By the same rule, `analytics:saved_views:read` and `analytics:schedules:read`
 * ride with their matching `:write`: a role that may create a saved view or a
 * schedule cannot manage the one it just created without being able to list it.
 * It stops there — roles that hold neither `:write` nor an `analytics:*` wildcard
 * have no tab to reach, and granting them the read would be a product decision,
 * not a fix.
 */
export const ROLES: Readonly<Record<string, readonly Permission[]>> = {
  /* platform (goNXT staff) */
  "platform.admin": ["*:*:*"],
  "platform.support": [
    "admin:diagnostics:read", "admin:dlq:read", "core:impersonate:use",
    "core:audit:read", "ai:runs:read", "ai:suggestions:read", "ai:command:read"
  ],
  "platform.engineer": ["admin:diagnostics:read", "admin:dlq:read", "admin:dlq:replay", "admin:flags:read", "admin:flags:write"],

  /* tenant-wide */
  "tenant.admin": [
    "core:*:*", "axis:*:read", "orbit:*:read", "signal:*:read", "scout:*:read",
    "north:*:read", "ledger:*:read", "ai:*:read", "analytics:*:*",
    // The tenant's AI operator. It already runs the agents (`ai:agents:write`)
    // and can stop them dead (`ai:killswitch:use`); the three writes below are
    // the rest of that same job and belong to no other tenant role:
    //   budgets — the spend ceiling, a finance/admin control (docs/19 §7 keeps
    //     money separate from operations, and this is the admin side of it);
    //   prompts — an agent's instructions, the same act as writing the agent;
    //   evals   — the gate a prompt change has to pass (docs/13 §EDD), so the
    //     role that may change a prompt must be able to prove it still passes.
    // tenant.compliance deliberately does not get these: it reads, audits and
    // pauses (`ai:evals:read`, `ai:agents:pause`) and must not also be the party
    // that authors what it reviews.
    "ai:agents:write", "ai:budgets:read", "ai:budgets:write",
    "ai:prompts:write", "ai:evals:run", "ai:killswitch:use",
    "compliance:*:read", "admin:billing:read",
    "dist:*:read", "dist:channels:write", "dist:offerings:write", "dist:offerings:publish",
    "dist:rates:write",
    // Binds the tenant to a partnership. Deliberately not held by
    // `orbit.partners`, who drafts the terms — drafter and signer are two
    // people or the countersignature proves nothing.
    "dist:agreements:sign"
  ],
  "tenant.compliance": [
    "core:audit:read", "core:audit:export", "core:consents:read", "core:customers:read",
    "core:pii:view", "core:approvals:read", "core:approvals:decide",
    "compliance:*:*", "ai:audit:read", "ai:runs:read", "ai:suggestions:read",
    "ai:command:read",
    // Reads the diligence trail behind anything that went live; may waive a
    // step that compliance itself owns, but never edit one.
    "core:onboarding:read", "core:onboarding:waive", "dist:agreements:read",
    "ai:agents:read", "ai:agents:pause",
    "ai:killswitch:use", "ai:evals:read",
    "signal:creatives:read", "signal:creatives:approve",
    "analytics:exports:create", "analytics:exports:download", "analytics:exports:unmasked",
    // A regulator asks for a customer's quote and policy trail (docs/06 J-CO1).
    // Without a readable dataset the export permission has nothing to export,
    // so the officer's core duty dead-ends. Read-only, and the unmasked path
    // still costs a justification and an approval.
    "analytics:reports:read", "analytics:reports:run",
    "axis:policies:read", "dist:quote_requests:read",
    "ledger:client_money:read", "ledger:journals:read",
    "core:notes:read"
  ],

  /* AXIS */
  "axis.agent": [
    ...readsOf("axis"), "axis:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "axis:cases:create", "axis:cases:update",
    "axis:quotes:create", "axis:quotes:compare",
    "axis:documents:upload", "axis:documents:extract",
    "axis:tasks:write", "axis:claims:create", "axis:claims:update",
    "axis:claims:register", "axis:claims:triage", "axis:claims:reserve",
    "axis:policies:refer", "axis:complaints:write",
    "core:customers:read", "core:customers:create", "core:customers:update",
    "core:consents:read", "core:consents:create", "core:files:read", "core:files:create",
    "core:search:read", "core:notifications:read", "ledger:txns:read",
    // docs/27 F13: the agent closes sales but does not decide what goes out to
    // a customer — `:select` without `:share`. Before F13 the desk wrote its own
    // `axis_quotes.winFlag`; now there is one table, so it needs dist's verb.
    "dist:ai:invoke", "dist:offerings:read", "dist:quote_requests:read", "dist:quote_requests:create",
    "dist:quote_requests:select", "dist:offers:read", "dist:offers:surface",
    "core:notes:read", "core:notes:write"
  ],
  "axis.lead": [
    ...readsOf("axis"), "axis:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "axis:cases:create", "axis:cases:update", "axis:cases:assign",
    "axis:cases:approve", "axis:quotes:create", "axis:quotes:compare", "axis:quotes:approve",
    "axis:documents:upload", "axis:documents:extract", "axis:documents:verify",
    "axis:tasks:write", "axis:policies:create", "axis:policies:bind",
    "axis:policies:endorse", "axis:policies:update", "axis:policies:cancel",
    "axis:policies:ntu", "axis:policies:lapse", "axis:policies:reinstate", "axis:policies:renew",
    "axis:policies:finance",
    "axis:policies:telemetry",
    "axis:policies:document",
    "axis:claims:create", "axis:claims:update", "axis:claims:approve", "axis:sops:write",
    // The lead handles claims end to end but does not sign off their own
    // payments — `pay_approve` stays with axis.admin (design §A.2).
    "axis:claims:register", "axis:claims:triage", "axis:claims:reserve",
    "axis:claims:pay", "axis:claims:recover", "axis:claims:reopen", "axis:claims:close",
    "axis:bordereaux:generate", "axis:bordereaux:reconcile",
    "axis:policies:refer", "axis:policies:decide_referral",
    "axis:complaints:write", "axis:complaints:close",
    "axis:siu:write", "axis:siu:decide",
    "core:customers:read", "core:customers:create", "core:customers:update", "core:pii:view",
    "core:consents:read", "core:consents:create", "core:files:read", "core:files:create",
    "core:search:read", "core:approvals:read", "core:approvals:decide",
    "ledger:txns:read", "analytics:reports:read", "analytics:reports:run",
    "analytics:exports:create", "analytics:exports:download",
    "analytics:saved_views:read", "analytics:saved_views:write",
    "dist:channels:read", "dist:offerings:read", "dist:rates:read",
    "dist:ai:invoke", "dist:quote_requests:read", "dist:quote_requests:create", "dist:quote_requests:share",
    "dist:quote_requests:select",
    "dist:commissions:read", "dist:offers:read", "dist:offers:surface", "dist:offers:override",
    "compliance:disclosures:present",
    "core:notes:read", "core:notes:write"
  ],
  "axis.admin": [
    "axis:*:*", "ai:suggestions:read", "core:customers:*", "core:products:*", "core:providers:*",
    "core:pii:view", "core:approvals:read", "core:approvals:decide", "core:files:*", "core:webhooks:read",
    "ledger:txns:read", "ledger:recon:read", "ledger:recon:run",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "dist:channels:*", "dist:offerings:*", "dist:quote_requests:*", "dist:offers:*",
    "dist:rates:read", "dist:commissions:read",
    "core:notes:read", "core:notes:write"
  ],

  /* ORBIT */
  "orbit.agent": [
    ...readsOf("orbit"), "orbit:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "orbit:conversations:reply", "orbit:conversations:close",
    "orbit:messages:send", "orbit:handover:write", "orbit:presence:write",
    // docs/06 J-C2: the agent's whole job is reading the customer's message
    // and the AI's drafted reply to it — both are `content`, PII-masked
    // without this grant (packages/core/src/pii.ts).
    "core:customers:read", "core:pii:view", "core:consents:read", "core:search:read", "core:files:read",
    "axis:policies:read", "axis:cases:read", "axis:cases:create",
    "core:notes:read", "core:notes:write"
  ],
  "orbit.lead": [
    ...readsOf("orbit"), "orbit:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "orbit:conversations:reply", "orbit:conversations:assign",
    "orbit:conversations:close", "orbit:messages:send", "orbit:handover:write",
    "orbit:qa:score", "orbit:renewals:update", "orbit:journeys:write",
    "orbit:presence:write", "orbit:teams:write",
    // The lead owns the wording the desk sends: knowledge-base articles and the
    // canned replies built from them (docs/27 F32). Publishing is separate from
    // writing because publishing is what makes an article answer a customer
    // unaccompanied.
    "orbit:kb:write", "orbit:kb:publish", "orbit:macros:write",
    "core:customers:read", "core:pii:view", "core:consents:read", "core:search:read",
    "core:approvals:read", "core:approvals:decide", "core:files:read",
    "axis:policies:read", "axis:cases:read", "axis:cases:create",
    "analytics:reports:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "analytics:saved_views:read", "analytics:saved_views:write",
    "core:notes:read", "core:notes:write"
  ],
  "orbit.retention": [
    ...readsOf("orbit"), "orbit:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "orbit:renewals:update", "orbit:conversations:reply",
    "orbit:messages:send",
    "core:customers:read", "core:consents:read", "core:search:read",
    // The desk that carries "Bind renewal" is this role's (renewal-desk.tsx),
    // so this role finishes the job — ADR-0054. Separation of duties stays
    // with the `axis.renew` approval policy, which is where it always lived.
    "axis:policies:read", "axis:policies:renew", "axis:quotes:create", "axis:quotes:compare",
    "analytics:reports:read", "analytics:reports:run",
    "dist:ai:invoke", "dist:offerings:read", "dist:quote_requests:create",
    "dist:offers:read",
    "core:notes:read", "core:notes:write"
  ],
  "orbit.partners": [
    ...readsOf("orbit"), "orbit:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "orbit:partners:create", "orbit:partners:update",
    "orbit:partners:certify", "orbit:partner_keys:issue_test",
    "ledger:txns:read", "analytics:reports:read", "analytics:reports:run",
    "dist:channels:read", "dist:channels:write", "dist:rates:read", "dist:commissions:read",
    "dist:offerings:read",
    // Runs partner and channel onboarding, but cannot waive a required step or
    // countersign the agreement they drafted — both are someone else's call.
    "core:onboarding:read", "core:onboarding:write",
    "dist:agreements:read", "dist:agreements:write",
    "compliance:screenings:read", "compliance:screenings:run",
    "core:notes:read", "core:notes:write"
  ],
  "orbit.admin": [
    "orbit:*:*", "ai:suggestions:read", "core:customers:*", "core:pii:view", "core:consents:*",
    "core:approvals:read", "core:approvals:decide", "core:files:*",
    "axis:policies:read", "axis:cases:read",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "core:notes:read", "core:notes:write"
  ],

  /* SIGNAL */
  "signal.marketer": [
    ...readsOf("signal"), "signal:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "signal:campaigns:create", "signal:campaigns:update",
    "signal:audiences:create", "signal:audiences:estimate",
    "signal:creatives:generate", "signal:aeo:write", "signal:experiments:create",
    "core:consents:read", "core:search:read", "core:files:read", "core:files:create",
    "analytics:reports:read", "analytics:reports:run",
    "core:notes:read", "core:notes:write"
  ],
  "signal.lead": [
    ...readsOf("signal"), "signal:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "signal:campaigns:create", "signal:campaigns:update",
    "signal:campaigns:launch", "signal:campaigns:pause",
    "signal:audiences:create", "signal:audiences:estimate",
    "signal:creatives:generate", "signal:creatives:publish",
    "signal:experiments:create", "signal:experiments:decide",
    "signal:budget_moves:approve", "signal:budget_moves:reverse", "signal:autopilot:pause", "signal:autopilot:run", "signal:aeo:write",
    "signal:outreach:send",
    "core:consents:read", "core:search:read", "core:approvals:read", "core:approvals:decide",
    "core:files:read", "core:files:create",
    "ledger:txns:read", "analytics:reports:read", "analytics:reports:run",
    "analytics:exports:create", "analytics:exports:download",
    "analytics:saved_views:read", "analytics:saved_views:write",
    "compliance:disclosures:present",
    "core:notes:read", "core:notes:write"
  ],
  "signal.admin": [
    "signal:*:*", "ai:suggestions:read", "core:consents:read", "core:files:*", "core:approvals:read",
    "core:approvals:decide", "ledger:txns:read",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "core:notes:read", "core:notes:write"
  ],

  /* SCOUT */
  "scout.pm": [
    ...readsOf("scout"), "scout:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "scout:experiments:create", "scout:whitespaces:promote",
    "core:products:read", "core:providers:read", "dist:offerings:read",
    "analytics:reports:read", "analytics:reports:run",
    "core:notes:read", "core:notes:write"
  ],
  "scout.lead": [
    ...readsOf("scout"), "scout:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "scout:experiments:create", "scout:experiments:decide",
    "scout:whitespaces:promote", "scout:data_products:create",
    // J-P2 (docs/06): the lead who ran the negotiation logs the agreed delta.
    // A rate is create-only evidence behind dist.rate_change — never
    // auto-approved, always dual control, decided by dist:rates:approve
    // (finance) — so writing one here proposes; it never sets a rate alone.
    "dist:rates:read", "dist:rates:write", "dist:offerings:read", "dist:channels:read",
    // A lead reruns the Clusterer and the Bench Builder; ingest stays admin.
    "scout:clusters:build", "scout:panel_bench:build",
    "core:products:read", "core:providers:read", "core:approvals:read", "core:approvals:decide",
    "analytics:reports:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "core:notes:read", "core:notes:write"
  ],
  "scout.admin": [
    "scout:*:*", "ai:suggestions:read", "core:products:*", "core:providers:*",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "core:notes:read", "core:notes:write"
  ],

  /* NORTH */
  "north.exec": [
    ...readsOf("north"), "north:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "north:anomalies:assign", "north:scenarios:run",
    "north:decisions:write", "north:boardpacks:generate", "north:snapshots:run",
    "axis:metrics:read", "signal:attribution:read", "signal:spend:read",
    "orbit:renewals:read", "scout:clusters:read", "ledger:txns:read",
    "dist:commissions:read", "dist:channels:read",
    "analytics:dashboards:read", "analytics:reports:read", "analytics:reports:run",
    "analytics:exports:create", "analytics:exports:download",
    "analytics:saved_views:read", "analytics:saved_views:write",
    "core:notes:read", "core:notes:write"
  ],
  "north.analyst": [
    ...readsOf("north"), "north:ai:invoke", "ai:suggestions:read", "ai:command:read",
    "north:metrics:write", "north:briefings:generate",
    "north:scenarios:run", "north:alerts:write",
    "axis:metrics:read", "signal:attribution:read", "signal:spend:read",
    "orbit:renewals:read", "scout:clusters:read", "ledger:journals:read",
    "analytics:dashboards:write", "analytics:reports:write", "analytics:reports:run",
    "analytics:exports:create", "analytics:exports:download",
    "analytics:schedules:read", "analytics:schedules:write",
    "analytics:saved_views:read", "analytics:saved_views:write",
    "core:notes:read", "core:notes:write"
  ],
  /** Board pack readers. Read-only by design — never grant write here. */
  "north.board": [
    "north:briefings:read", "north:boardpacks:read", "north:snapshots:read",
    // A board reads the projection: it is half of what a board pack is for.
    "north:forecasts:read",
    "north:decisions:read", "analytics:dashboards:read"
  ],
  "north.admin": [
    "north:*:*", "ai:suggestions:read", "analytics:*:*", "ledger:journals:read", "ledger:txns:read",
    "core:notes:read", "core:notes:write"
  ],

  /* finance — money movement is separated from operations by design (docs/19 §7) */
  "finance.analyst": [
    ...readsOf("ledger"), "ledger:ai:invoke", "ai:command:read", "ledger:recon:run", "ledger:recon:export", "ledger:invoices:create",
    // Drafts a manual journal but cannot post it — deliberately not
    // `ledger:journals:post`, which is the whole point of the split.
    "ledger:journals:draft",
    "analytics:reports:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "dist:commissions:read", "dist:rates:read", "dist:channels:read",
    "core:notes:read", "core:notes:write"
  ],
  "finance.controller": [
    "ledger:*:*", "core:approvals:read", "core:approvals:decide",
    "dist:commissions:*", "dist:rates:read", "dist:rates:approve", "dist:channels:read",
    // Settles against the terms, so must be able to read them.
    "dist:agreements:read", "core:onboarding:read",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "analytics:exports:unmasked", "compliance:disclosures:present", "compliance:evidence:read", "compliance:evidence:export",
    "core:notes:read", "core:notes:write"
  ],
  /**
   * Dual control needs a second seat that is only a second seat. The director
   * approves and posts what the analyst drafted, and cannot originate any of
   * it — no `ledger:txns:create`, no `ledger:journals:draft`, no bank import.
   * A tenant with a single finance seat therefore cannot post a manual journal,
   * force a close or reopen a period: that is separation of duties as a
   * property of the role graph, not a runtime check that can be configured off.
   */
  "finance.director": [
    ...readsOf("ledger"), "core:approvals:read", "core:approvals:decide",
    "ledger:journals:post", "ledger:periods:close", "ledger:periods:force_close",
    "ledger:periods:reopen", "ledger:periods:year_end", "ledger:payouts:approve",
    "ledger:invoices:approve", "ledger:client_money:transfer", "ledger:txns:reverse",
    "analytics:*:read", "analytics:reports:run", "analytics:exports:create", "analytics:exports:download",
    "core:notes:read"
  ],

  /* developer */
  "dev.developer": ["dev:consoles:read", "dev:sandbox:use", "dev:keys_test:issue", "core:webhooks:read"],
  "dev.admin": [
    "dev:consoles:read", "dev:sandbox:use", "dev:keys_test:issue", "dev:keys_live:issue",
    // `core:webhooks:read` was missing while `:write` was granted, so the
    // integrations role could not open the webhooks tab it is meant to run.
    "core:api_keys:read", "core:api_keys:create", "core:api_keys:revoke",
    "core:webhooks:read", "core:webhooks:write"
  ],

  /* external */
  "customer": [],
  "partner.developer": ["dev:sandbox:use", "dev:keys_test:issue", "orbit:partners:read"],
  "partner.manager": [
    "orbit:partners:read", "ledger:txns:read", "analytics:reports:read",
    "dist:channels:read", "dist:offerings:read", "dist:commissions:read", "dist:quote_requests:read"
  ],
  "provider.viewer": ["scout:data_products:read", "scout:panel_bench:read"]
};

export type RoleKey = keyof typeof ROLES;

/**
 * PLAT-013. Everyone inside the business carries a second factor; the rule is
 * the platform's and no tenant policy switch turns it off. Only accounts that
 * belong to someone else — a broker's developer, an underwriter's read-only
 * viewer, a customer — are outside it, because we do not run their identity.
 *
 * An account with no role at all is treated as staff: failing closed here costs
 * one enrolment, failing open costs an unprotected admin.
 */
const EXTERNAL_ROLE_PREFIXES = ["partner.", "provider.", "customer"];

export function requiresMfa(roleKeys: readonly string[]): boolean {
  // Any internal role means MFA; only a purely external account is exempt.
  // No roles at all fails closed to staff (see doc comment above).
  return roleKeys.length === 0 || roleKeys.some(isInternalRole);
}

/** Staff, as opposed to the portal roles a customer or partner signs in with. */
export function isInternalRole(roleKey: string): boolean {
  return !EXTERNAL_ROLE_PREFIXES.some((p) => roleKey.startsWith(p));
}

/** Roles provisioned into every new tenant (platform.* live outside tenants). */
export const TENANT_ROLE_KEYS: readonly string[] = Object.keys(ROLES).filter(
  (k) => !k.startsWith("platform.")
);

/* -------------------------------------------------------------- the check */

/** `axis:cases:read` matched against `axis:*:*`, `axis:cases:*`, `*:*:*`. */
function matches(granted: string, wanted: string): boolean {
  if (granted === wanted) return true;
  const g = granted.split(":");
  const w = wanted.split(":");
  if (g.length !== 3 || w.length !== 3) return false;
  return g.every((seg, i) => seg === "*" || seg === w[i]);
}

function scopeAllows(scope: Scope | undefined, subject: Subject | undefined): boolean {
  if (!scope) return true;
  if (scope.modules?.length && subject?.module && !scope.modules.includes(subject.module)) return false;
  if (scope.teamIds?.length) {
    // A team-scoped grant cannot act on a subject with no team — fail closed.
    if (!subject?.teamId || !scope.teamIds.includes(subject.teamId)) return false;
  }
  if (scope.productLines?.length) {
    if (!subject?.productLine || !scope.productLines.includes(subject.productLine)) return false;
  }
  return true;
}

/**
 * The only authorization path in the platform (docs/04 §3).
 * Tenant mismatch is denied before permissions are even consulted.
 */
export function can(actor: Actor, permission: Permission, subject?: Subject): boolean {
  if (subject && subject.tenantId !== actor.tenantId) return false;
  return actor.grants.some(
    (g) => g.permissions.some((p) => matches(p, permission)) && scopeAllows(g.scope, subject)
  );
}

/** Throwing variant for route handlers. */
export class ForbiddenError extends Error {
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`forbidden: ${permission}`);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

export function require_(actor: Actor, permission: Permission, subject?: Subject): void {
  if (!can(actor, permission, subject)) throw new ForbiddenError(permission);
}

/** Expand a role key to its permission bundle. Unknown role = no permissions. */
export function permissionsForRole(roleKey: string): readonly Permission[] {
  return ROLES[roleKey] ?? [];
}

/** Every concrete permission a wildcard bundle covers — for admin UI and tests. */
export function expand(bundle: readonly Permission[]): Permission[] {
  return PERMISSIONS.filter((p) => bundle.some((b) => matches(b, p)));
}

/** Guards role definitions and tenant-authored custom roles. */
export function isKnownPermission(p: string): p is KnownPermission {
  return PERMISSION_SET.has(p);
}

/** A wildcard is valid if it expands to at least one real permission. */
export function isValidGrantString(p: string): boolean {
  return isKnownPermission(p) || (p.split(":").length === 3 && PERMISSIONS.some((k) => matches(p, k)));
}
