import { eq, inArray } from "drizzle-orm";
import { id } from "@lyra/db";
import { PaymentPlanWrite, schema } from "@lyra/db";
import {
  autoApproveProblem,
  badRequest,
  can,
  canClaimTransition,
  canPolicyTransition,
  checkKAnonymity,
  CUSTOMER_PII,
  DEFAULT_K_FLOOR,
  emit,
  gate,
  isClaimState,
  isPolicyState,
  scoped,
  sealFields
} from "@lyra/core";
import { SENSITIVE_EXTRACTION_FIELDS } from "@lyra/model-gateway";
import { fieldKey } from "./env.js";
import { register, type Resource } from "./crud.js";
import { gatewayFor } from "./mw.js";
import { embedUpsert } from "./engines/vectorize.js";
import { assertCanGrant, bundleOf } from "./engines/staff.js";
import { onExperimentConcluded } from "./engines/scout-validate.js";
import { must } from "./rows.js";
import {
  dashboardVisible,
  exportVisible,
  reportRunVisible,
  reportVisible,
  savedViewVisible
} from "./routes/analytics.js";

// Every table the API exposes as CRUD, in one list. A table that is missing here
// has no HTTP surface at all, which is the intended default for anything the
// platform writes and nobody edits (audit rows, outbox, idempotency keys).
//
// Read the columns as: path, table, id prefix, module, permissions. Anything a
// resource needs beyond CRUD lives in its module router (routes/*.ts).

const r = (
  path: string,
  table: Resource["table"],
  idPrefix: string,
  module: Resource["module"],
  perms: Resource["perms"],
  extra: Partial<Resource> = {}
): Resource => ({ path, table, idPrefix, module, perms, ...extra });

/** read/create/update/delete off one permission stem, the common case. */
const rcud = (stem: string) => ({
  read: `${stem}:read`,
  create: `${stem}:create`,
  update: `${stem}:update`,
  remove: `${stem}:delete`
});

/** read + a single write permission — the shape most config tables use. */
const rw = (stem: string) => ({
  read: `${stem}:read`,
  create: `${stem}:write`,
  update: `${stem}:write`,
  remove: `${stem}:write`
});

/** read + a single `:update` permission — for stems that never coined `:write`. */
const ru = (stem: string) => ({
  read: `${stem}:read`,
  create: `${stem}:update`,
  update: `${stem}:update`,
  remove: `${stem}:update`
});

const ro = (perm: string) => ({ read: perm });

/* -------------------------------------------------------------------- core */

export const CORE = register(
  r("tenants", schema.tenants, "tn", "core", {
    read: "core:tenants:read",
    update: "core:tenants:update"
  }, {
    // `policyJson` is replaced wholesale here, and one of its fields is the
    // auto-approve allowlist — the documented way out of the approval gate.
    // The settings endpoint that owns the list validates what goes in it; this
    // path reaches the same array, and a guard on only one of two doors is not
    // a guard. Same rule, same function (packages/core/src/approvals.ts): no
    // unknown key, and nothing docs/19 §7 puts a floor under.
    beforeWrite: (_ctx, values) => {
      const policy = values.policyJson;
      let parsed: unknown = policy;
      if (typeof policy === "string") {
        try {
          parsed = JSON.parse(policy);
        } catch {
          throw badRequest("policyJson is not valid JSON");
        }
      }
      if (parsed && typeof parsed === "object") {
        const list = (parsed as { autoApprove?: unknown }).autoApprove;
        if (list !== undefined) {
          if (!Array.isArray(list)) throw badRequest("policy.autoApprove must be an array");
          const problem = autoApproveProblem(list);
          if (problem) throw badRequest(problem);
        }
      }
      return values;
    }
  }),
  r("users", schema.users, "us", "core", rcud("core:users"), {
    searchable: ["name", "email"],
    pii: { email: "email", phone: "phone", name: "name" },
    // ...and never comes back out either. Refusing a credential in the body
    // while `GET /users/:id` returned it was half a defence: the hash is what an
    // offline cracker wants, and `mfa_secret` is the second factor itself —
    // anyone who read it could mint valid codes forever.
    secretColumns: ["passwordHash", "mfaSecret", "mfaRecoveryJson"],
    // A credential must never round-trip through a CRUD body — not the password
    // hash, not the TOTP secret, and not the recovery codes that bypass it.
    beforeWrite: (_ctx, values) => {
      const { passwordHash: _p, mfaSecret: _m, mfaRecoveryJson: _r, ...rest } = values;
      return rest;
    }
  }),
  r("roles", schema.roles, "rl", "core", {
    read: "core:roles:read",
    create: "core:roles:update",
    update: "core:roles:update",
    remove: "core:roles:update"
  }, {
    // Editing the role IS the grant: core:roles:assign is guarded below, but a
    // role whose permissionsJson can be widened freely turns core:roles:update
    // into `*:*:*`. Same boundary, one step earlier — and it applies to the
    // whole resulting set, so a role carrying authority the editor lacks is
    // read-only to them rather than a way to launder it.
    beforeWrite: (ctx, values, existing) => {
      if (values.permissionsJson === undefined) return values;
      const key = String(values.key ?? (existing as { key?: string } | undefined)?.key ?? "");
      // bundleOf, not JSON.parse: an empty list falls back to the compiled table
      // for that key, so `permissionsJson: "[]"` cannot smuggle a built-in role
      // past the check by looking like a role with no authority at all.
      assertCanGrant(ctx, bundleOf({ id: "", key, permissionsJson: String(values.permissionsJson) }), key);
      return values;
    }
  }),
  r("user-roles", schema.userRoles, "ur", "core", {
    read: "core:roles:read",
    create: "core:roles:assign",
    remove: "core:roles:assign"
  }, {
    // core:roles:assign lets an actor assign roles, not grant authority they
    // don't hold themselves — same boundary inviteStaff/changeRoles enforce.
    beforeWrite: async (ctx, values) => {
      const role = await must(ctx, schema.roles, values.roleId as string, "role");
      assertCanGrant(ctx, bundleOf(role), role.key);
      return values;
    }
  }),
  r("teams", schema.teams, "tm", "core", rw("core:teams"), { searchable: ["name"] }),
  r("customers", schema.customers, "cu", "core", rcud("core:customers"), {
    searchable: ["nameJson", "emailsJson", "phonesJson"],
    pii: CUSTOMER_PII
  }),
  // Consent is evidence. It can be granted and withdrawn, never edited.
  r("consents", schema.consents, "cs", "core", {
    read: "core:consents:read",
    create: "core:consents:create"
  }, { immutable: true }),
  r("products", schema.products, "prd", "core", rw("core:products"), { searchable: ["name", "code"] }),
  r("providers", schema.providers, "prv", "core", rw("core:providers"), { searchable: ["name", "code"] }),
  r("files", schema.files, "fil", "core", {
    read: "core:files:read",
    create: "core:files:create",
    remove: "core:files:delete"
    // ponytail: no filename column exists — files are found by what they are
    // attached to. Add a `filename` column and put it here when someone needs
    // to search by the name the browser uploaded.
  }, { searchable: ["subjectRef"] }),
  r("approvals", schema.approvals, "apr", "core", ro("core:approvals:read")),
  r("mandates", schema.mandates, "mnd", "core", ru("core:settings")),
  r("identity-verifications", schema.identityVerifications, "idv", "core", ro("core:customers:read")),
  r("memories", schema.memories, "mem", "core", ru("core:settings")),
  r("lenses", schema.lenses, "lns", "core", ru("core:settings")),
  r("rulepacks", schema.rulepacks, "rpk", "core", {
    read: "compliance:rulepacks:read",
    create: "compliance:rulepacks:apply",
    update: "compliance:rulepacks:apply"
  }),
  // No `create` here on purpose: minting a key generates a plaintext that is
  // shown once and never stored, so generated CRUD (which would want the client
  // to supply `prefix` and `keyHash`) cannot serve it. POST /v1/core/api-keys
  // lives in routes/core.ts; same for DELETE — a key has `revokedAt`, not
  // `deletedAt`, so generic CRUD's delete would hard-delete the row instead of
  // revoking it. List and record still come from here.
  r("api-keys", schema.apiKeys, "key", "core", {
    read: "core:api_keys:read"
  }, {
    // The hash is the whole verification test: `sha256(presented) === keyHash`.
    // Handing it out turns a read permission into an offline oracle for guessing
    // a live key. The plaintext is shown once at mint and nowhere else.
    secretColumns: ["keyHash"]
  }),
  // The client secret is never here: the row names a worker secret, it does not
  // hold one (routes/sso.ts).
  r("identity-providers", schema.identityProviders, "idp", "core", rw("core:identity_providers"), {
    searchable: ["name", "emailDomain"]
  }),
  // `secret` is the raw HMAC signing key, not a hash of one: whoever reads it
  // can forge a delivery the receiver will verify as ours. It is writable (a
  // tenant sets or rotates it) and never readable back.
  r("webhooks", schema.webhooks, "whk", "core", rw("core:webhooks"), { secretColumns: ["secret"] }),
  r("webhook-deliveries", schema.webhookDeliveries, "whd", "core", ro("core:webhooks:read")),
  r("notifications", schema.notifications, "ntf", "core", ro("core:notifications:read"), {
    // The inbox in routes/me.ts filters to the addressee; the generic list must
    // not be the back door that shows every user's notifications tenant-wide.
    rowVisible: (ctx, row) => row.userId === ctx.actor.id
  }),
  r("audit-log", schema.auditLog, "aud", "core", ro("core:audit:read"), { immutable: true }),
  r("event-dlq", schema.eventDlq, "dlq", "core", ro("admin:dlq:read")),
  // Read-only here on purpose. A checklist step is generated from a template and
  // moved by the onboarding engine (routes/onboarding.ts); letting CRUD PATCH
  // `state` would let anyone with write permission mark their own diligence done
  // and skip the waiver approval entirely.
  r("onboarding-steps", schema.onboardingSteps, "obs", "core", ro("core:onboarding:read"), {
    searchable: ["key", "subjectRef"]
  }),
  // Same reason: a delegation moves the authority to approve, so it is created
  // and revoked through routes/staff.ts where the delegate's permissions are
  // checked against the delegator's. CRUD only reads.
  r("delegations", schema.delegations, "dlg", "core", ro("core:delegations:read")),
  r("message-templates", schema.messageTemplates, "tpl", "core", rw("core:templates"), {
    searchable: ["key", "channel"]
  }),
  // i18n.ts's translator() merges these over the static CATALOGUES at request
  // time; CRUD here is only how a tenant admin edits the override rows.
  r("locale-overrides", schema.localeOverrides, "loc", "core", rw("core:locale_overrides"), {
    searchable: ["locale", "key"]
  })
);

/* -------------------------------------------------------------------- dist */

export const DIST = register(
  r("channels", schema.distChannels, "chn", "dist", rw("dist:channels"), {
    searchable: ["name", "key"],
    approval: { create: "dist.partner_activate" }
  }),
  r("offerings", schema.distOfferings, "off", "dist", rw("dist:offerings"), {
    searchable: ["name", "code"],
    approval: { update: "dist.offering_publish" }
  }),
  // Rates are effective-dated evidence of what was agreed. Supersede, never edit.
  r("commission-rates", schema.distCommissionRates, "cr", "dist", {
    read: "dist:rates:read",
    create: "dist:rates:write"
  }, { immutable: true, actorColumns: ["createdBy"], approval: { create: "dist.rate_change" } }),
  r("quote-requests", schema.distQuoteRequests, "qr", "dist", {
    read: "dist:quote_requests:read",
    create: "dist:quote_requests:create",
    update: "dist:quote_requests:create"
  }),
  r("quote-responses", schema.distQuoteResponses, "qs", "dist", ro("dist:quote_requests:read")),
  // `state`, `channelSettlementId` and `txnId` are settlement-engine-owned:
  // resetting them via a generic PATCH would unstick an already-paid entry
  // and let it sweep into a second settlement run (double payment). The one
  // legitimate adjustment path is POST /commission-entries/:id/clawback
  // (routes/dist.ts), which reverses with a new row rather than editing the
  // original in place and is itself gated on `dist.commission_adjust` — a
  // generic `update` here would be a second, unguarded door onto the same
  // gate (same bug class as ADR-0023, settlements and partner-agreements).
  r("commission-entries", schema.distCommissionEntries, "ce", "dist", ro("dist:commissions:read")),
  r("next-best-offers", schema.distNextBestOffers, "nb", "dist", {
    read: "dist:offers:read",
    update: "dist:offers:override"
  }),
  // A version of the terms, superseded rather than edited — the same discipline
  // as `commission-rates`, and for the same reason: a commission dispute is
  // settled by reading the version that was active on the sale date. Draft,
  // send-for-signature and sign all go through routes/onboarding.ts, whose
  // `signAgreement` enforces the dual-control `dist.agreement_sign` approval —
  // a generic create here would let `dist:agreements:write` alone insert a row
  // already `state: "active"`, skipping that gate entirely (same bug class as
  // ADR-0023 and the settlements CRUD door: docs/decisions/).
  r("partner-agreements", schema.distPartnerAgreements, "pag", "dist", ro("dist:agreements:read"))
);

/* -------------------------------------------------------------------- axis */

/** Complaint lifecycle (docs/27 §D.8). closed is terminal. */
const COMPLAINT_TRANSITIONS: Record<string, string[]> = {
  received: ["investigating", "escalated", "closed"],
  investigating: ["awaiting_customer", "resolved", "escalated", "closed"],
  awaiting_customer: ["investigating", "resolved", "escalated", "closed"],
  resolved: ["closed", "escalated"],
  escalated: ["resolved", "closed"],
  closed: []
};

/** SIU referral lifecycle (docs/27 §D.8). closed is terminal. */
const SIU_TRANSITIONS: Record<string, string[]> = {
  open: ["investigating", "closed"],
  investigating: ["substantiated", "unsubstantiated", "closed"],
  substantiated: ["closed"],
  unsubstantiated: ["closed"],
  closed: []
};

/**
 * docs/27 F27. `POLICY_TRANSITIONS` and `CLAIM_TRANSITIONS` (@lyra/core
 * lifecycle.ts) were enforced by the dedicated engines — `transitionClaim`,
 * `axis-lifecycle.ts` — and by nothing here, which left generic CRUD as a
 * second writable path around the same contract: a reported claim could be
 * PATCHed straight to `settled`, a cancelled policy revived. The maps are
 * imported rather than restated so the two doors cannot drift, which is the
 * failure the neighbouring hand-written `COMPLAINT_TRANSITIONS` risks.
 *
 * Shaped like the `beforeWrite` guards directly below, and like `invoices` in
 * the ledger registry: the check belongs where every writer passes.
 */
function guardState(
  field: string,
  legal: (from: never, to: never) => boolean,
  known: (s: string) => boolean,
  noun: string,
  reserved: (to: string) => string | null = () => null
) {
  return (values: Record<string, unknown>, existing: Record<string, unknown> | null | undefined) => {
    if (!existing) return values;
    const to = values[field];
    if (typeof to !== "string") return values;
    const from = existing[field] as string;
    if (to === from) return values;
    const why = reserved(to);
    if (why) throw badRequest(why);
    if (!known(to)) throw badRequest(`${to} is not a ${noun} state`);
    if (!legal(from as never, to as never)) throw badRequest(`a ${noun} cannot move ${from} -> ${to}`);
    return values;
  };
}

const guardClaimState = guardState(
  "status",
  canClaimTransition,
  isClaimState,
  "claim",
  // Money owns these two (engines/axis-claims.ts `settlementTarget`), so the
  // CRUD door may not hand them out even where the machine allows the hop.
  (to) =>
    to === "settling" || to === "settled"
      ? `move a claim to ${to} by requesting a payment, not by editing it`
      : null
);

const guardPolicyState = guardState("status", canPolicyTransition, isPolicyState, "policy");

export const AXIS = register(
  r("cases", schema.axisCases, "cas", "axis", rcud("axis:cases"), { searchable: ["ref"] }),
  // docs/27 F13: `dist_quote_responses` is the single source of quote truth.
  // This table is history — readable so old cases still render, but the write
  // doors are gone: a hand-keyed quote goes through POST /v1/axis/cases/:id/quotes
  // (routes/axis.ts), which files it beside the panel's own answers.
  r("quotes", schema.axisQuotes, "qt", "axis", ro("axis:quotes:read")),
  r("documents", schema.axisDocuments, "doc", "axis", {
    read: "axis:documents:read",
    create: "axis:documents:upload",
    update: "axis:documents:verify"
  }, {
    // The extract route is not the only door to this column: a human correcting
    // the Emirates ID the model misread writes through here. Sealing sits on the
    // write, not on one caller of it (docs/12 §1, ADR-0032). Already-sealed
    // values pass through untouched, so the common correction — a different
    // field, with the sealed one carried along unchanged — re-seals nothing.
    beforeWrite: async (_ctx, values, _existing, env) => {
      if (typeof values.extractionJson !== "string") return values;
      let parsed: unknown;
      try {
        parsed = JSON.parse(values.extractionJson);
      } catch {
        throw badRequest("extractionJson is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw badRequest("extractionJson must be an object of fields");
      }
      const sealed = await sealFields(
        fieldKey(env),
        parsed as Record<string, unknown>,
        SENSITIVE_EXTRACTION_FIELDS
      );
      return { ...values, extractionJson: JSON.stringify(sealed) };
    }
  }),
  r("tasks", schema.axisTasks, "tsk", "axis", rw("axis:tasks"), { actorColumns: ["createdBy"] }),
  r("case-approvals", schema.axisApprovals, "cap", "axis", ro("axis:cases:approve")),
  r("policies", schema.axisPolicies, "pol", "axis", {
    read: "axis:policies:read",
    create: "axis:policies:create",
    update: "axis:policies:update"
  }, {
    searchable: ["policyNo"],
    // ponytail: the create is gated, the update is not — ADR-0067. `paymentPlanJson` and
    // `premiumMinor` are both writable through PATCH with only
    // `axis:policies:update`, so a bound policy's instalment schedule — what
    // decides whether cover lapses unpaid — changes without a second pair of
    // eyes (CLAUDE.md §12). Left as it is deliberately in this wave: widening
    // the gate to `update` puts every routine field edit through approval, so
    // the fix is a field-level gate (`approval.updateFields`) rather than a
    // blanket one, and that is a crud.ts change with its own tests.
    approval: { create: "axis.bind", amountField: "premiumMinor" },
    // The shape crud.ts generates for a `*Json` column stops at "object, array
    // or string" (see `isJsonColumn`), so without this the sweep's own input is
    // whatever a caller typed. Validated here rather than in the shape because
    // that is where the other JSON columns are checked (`extractionJson` above).
    beforeWrite: (_ctx, values, existing) => {
      guardPolicyState(values, existing);
      if (values.paymentPlanJson === undefined || values.paymentPlanJson === null) return values;
      const raw = values.paymentPlanJson;
      let parsed: unknown = raw;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw badRequest("paymentPlanJson is not valid JSON");
        }
      }
      // `PaymentPlanWrite`, not the sweep's own `PaymentPlanJson`: that one
      // defaults every field so the sweep can read a partial plan, which at a
      // write door means `{"foo":"bar"}` stores as a plan with lapse-on-missed
      // silently off.
      const plan = PaymentPlanWrite.safeParse(parsed);
      if (!plan.success) throw badRequest("paymentPlanJson is not a payment plan the lapse sweep can read");
      // The parsed value, not the raw one: `graceDays` has a `.default(0)` that
      // only lands if the normalised object is what gets stored. crud.ts
      // stringifies a `*Json` object on the way to the column.
      return { ...values, paymentPlanJson: plan.data };
    }
  }),
  r("escrow-batches", schema.axisEscrowBatches, "esc", "axis", {
    read: "axis:escrow:read",
    update: "axis:escrow:reconcile"
  }, {
    // The batch has no `amountMinor`; what is released is what was received,
    // so the reviewer sees `receivedMinor` rather than nothing.
    approval: { update: "axis.escrow_release", amountField: "receivedMinor" }
  }),
  r("sops", schema.axisSops, "sop", "axis", rw("axis:sops"), { actorColumns: ["createdBy"] }),
  r("ops-policies", schema.axisOpsPolicies, "opl", "axis", rw("axis:ops_policies"), {
    actorColumns: ["updatedBy"]
  }),
  r("process-events", schema.axisProcessEvents, "pev", "axis", ro("axis:metrics:read"), { immutable: true }),
  r("claims", schema.axisClaims, "clm", "axis", {
    read: "axis:claims:read",
    create: "axis:claims:create",
    update: "axis:claims:update"
  }, {
    approval: { update: "axis.claim_settlement", amountField: "settledMinor" },
    beforeWrite: (_ctx, values, existing) => guardClaimState(values, existing)
  }),
  r("complaints", schema.axisComplaints, "cmp", "axis", {
    read: "axis:complaints:read",
    create: "axis:complaints:write",
    update: "axis:complaints:write"
  }, {
    // Ex-gratia redress is consequential (docs/27 §D.8): dual control via
    // axis.claim_exgratia, gated only when redressMinor actually changes —
    // r.approval.update would gate every PATCH, including plain state moves.
    beforeWrite: async (ctx, values, existing) => {
      if (!existing) return values;
      const from = existing.state as string;
      const to = values.state as string | undefined;
      if (typeof to === "string" && to !== from && !(COMPLAINT_TRANSITIONS[from] ?? []).includes(to)) {
        throw badRequest(`a complaint cannot move ${from} -> ${to}`);
      }
      const redress = values.redressMinor as number | undefined;
      if (typeof redress === "number" && redress > 0) {
        await gate(ctx, {
          policyKey: "axis.claim_exgratia",
          subjectRef: `complaints:${existing.id}`,
          amountMinor: redress
        });
      }
      return values;
    }
  }),
  r("siu-referrals", schema.axisSiuReferrals, "siu", "axis", {
    read: "axis:siu:read",
    create: "axis:siu:write",
    update: "axis:siu:write"
  }, {
    beforeWrite: (_ctx, values, existing) => {
      if (!existing) return values;
      const from = existing.state as string;
      const to = values.state as string | undefined;
      if (typeof to === "string" && to !== from && !(SIU_TRANSITIONS[from] ?? []).includes(to)) {
        throw badRequest(`a SIU referral cannot move ${from} -> ${to}`);
      }
      return values;
    },
    // "unsubstantiated" is the referral's clear intent: the linked claim's
    // siuState flag (set when the referral opened) comes back down with it.
    afterWrite: async (ctx, row) => {
      if (row.state !== "unsubstantiated") return;
      await ctx.db
        .update(schema.axisClaims)
        .set({ siuState: null })
        .where(scoped(ctx, schema.axisClaims, eq(schema.axisClaims.id, row.claimId as string)));
    }
  }),
  r("referrals", schema.axisReferrals, "rfl", "axis", ro("axis:policies:decide_referral")),
  // Read-only for the same reason as payments/settlements above:
  // engines/telematics.ts's TelematicsIngest is the sole doorway (POST
  // /v1/axis/policies/:id/telemetry) — it is the only writer that enforces the
  // cover-term bounds, dedups against what is already stored, and stamps the
  // TELEM-INGEST transaction id every row carries. A generic create would let
  // a caller insert a point with an arbitrary `at`, an arbitrary `value` and a
  // `txnId` pointing at nothing — which then feeds a reprice. This is the point
  // that most matters here: a writable telemetry table is a writable premium.
  r("telemetry-points", schema.axisTelemetryPoints, "telp", "axis", ro("axis:policies:read")),
  // Read-only: the only writers are POST /v1/axis/bordereaux (generate) and
  // POST /v1/axis/bordereaux/:id/reconcile (engines/axis-bordereaux.ts) —
  // both enforce the idempotent-per-period / inbound-one-shot rules a
  // generic create/update would bypass.
  r("bordereaux", schema.axisBordereaux, "bdx", "axis", ro("axis:bordereaux:read")),
  r("bordereau-lines", schema.axisBordereauLines, "bdxl", "axis", ro("axis:bordereaux:read"))
);

/* ------------------------------------------------------------------- orbit */

/** Legal renewal lifecycle (renewal-campaign.ts's resolved()). accepted/lost are terminal. */
const RENEWAL_TRANSITIONS: Record<string, string[]> = {
  scheduled: ["offered", "accepted", "lost"],
  offered: ["accepted", "lost"],
  accepted: [],
  lost: []
};

export const ORBIT = register(
  r("conversations", schema.orbitConversations, "cnv", "orbit", {
    read: "orbit:conversations:read",
    create: "orbit:conversations:reply",
    update: "orbit:conversations:assign"
  }),
  r("messages", schema.orbitMessages, "msg", "orbit", {
    read: "orbit:messages:read",
    create: "orbit:messages:send"
    // The column is `content`; `body` named nothing, so every message body was
    // readable without `core:pii:view` — a masking rule that masked no column.
  }, {
    immutable: true,
    // docs/modules/orbit.md §4 screen 7 "transcript search (redaction-aware)".
    // `content` is PII, so routes/search.ts only searches it for an actor
    // holding core:pii:view and masks it for everyone else — a redaction-aware
    // search is exactly a search that skips the column it cannot show.
    searchable: ["content"],
    pii: { content: "text" },
    // `ts` is the message's own arrival time; no caller — including the
    // generic "New — Messages" panel, which has no field for it — has a
    // reason to pick it by hand. The server's clock is authoritative.
    serverColumns: ["ts"],
    fixed: (ctx) => ({ ts: ctx.now })
  }),
  r("renewals", schema.orbitRenewals, "rnw", "orbit", {
    read: "orbit:renewals:read",
    update: "orbit:renewals:update"
  }, {
    // `accepted`/`lost` are terminal per renewal-campaign.ts's own `resolved()`
    // check — without this, a generic PATCH could reopen a closed renewal
    // (state back to "scheduled") after RenewalWorkflow has already finished,
    // leaving a "scheduled" row nothing will ever advance again.
    beforeWrite: (_ctx, values, existing) => {
      const from = existing!.state as string;
      const to = values.state;
      if (typeof to === "string" && to !== from && !(RENEWAL_TRANSITIONS[from] ?? []).includes(to)) {
        throw badRequest(`a renewal cannot move ${from} -> ${to}`);
      }
      return values;
    }
  }),
  r("journeys", schema.orbitJourneys, "jrn", "orbit", rw("orbit:journeys"), { actorColumns: ["createdBy"] }),
  r("journey-runs", schema.orbitJourneyRuns, "jrr", "orbit", ro("orbit:journeys:read")),
  // No generic `update`: stage/status/sandboxFlag/goLiveAt are advancePartner()'s
  // (blockingSteps() + dist.partner_activate on "live") — a raw PATCH would let
  // an actor self-activate straight to live, or reverse a suspend/terminate,
  // skipping both. Same door as ADR-0023, settlements, partner-agreements,
  // commission-entries, periods. Profile-field edits need a dedicated route
  // when a test demands one.
  r("partners", schema.orbitPartners, "ptn", "orbit", {
    read: "orbit:partners:read",
    create: "orbit:partners:create"
  }, { searchable: ["name"], approval: { create: "dist.partner_activate" } }),
  r("partner-txns", schema.orbitPartnerTxns, "ptx", "orbit", ro("orbit:partners:read")),
  r("handover-notes", schema.orbitHandoverNotes, "hnd", "orbit", rw("orbit:handover")),
  r("qa-scores", schema.orbitQaScores, "qas", "orbit", {
    read: "orbit:qa:read",
    create: "orbit:qa:score"
  }, { actorColumns: ["scoredBy"] }),
  // The routing engine (engines/orbit-routing.ts) reads all five of these and
  // nothing else wrote them, so every tenant's queue routed to nobody. A
  // supervisor runs the roster and the rules; an agent flips their own
  // availability.
  r("teams", schema.orbitTeams, "otm", "orbit", rw("orbit:teams")),
  r("team-members", schema.orbitTeamMembers, "tmm", "orbit", rw("orbit:teams")),
  r("sla-policies", schema.orbitSlaPolicies, "slp", "orbit", rw("orbit:teams")),
  r("routing-rules", schema.orbitRoutingRules, "rr", "orbit", rw("orbit:teams")),
  // ponytail: any agent may write any presence row, as leads legitimately mark
  // a colleague away. Narrow to self-or-lead if that is ever abused.
  r("agent-presence", schema.orbitAgentPresence, "ap", "orbit", {
    read: "orbit:presence:read",
    create: "orbit:presence:write",
    update: "orbit:presence:write"
  }),
  r("channel-connectors", schema.orbitChannelConnectors, "ccn", "orbit", {
    read: "orbit:channels:read",
    create: "orbit:channels:write",
    update: "orbit:channels:write",
    remove: "orbit:channels:write"
  }, {
    secretColumns: ["secretsJson"],
    // Mirrors axis.documents' extractionJson precedent: the client posts
    // plaintext secrets in the real secretsJson column (crud.ts's strict
    // per-column schema has no room for a synthetic `secrets` field) and this
    // seals every value before it lands in SQLite.
    //
    // Both wire forms have to come through here. crud.ts's `*Json` shape
    // accepts an object, an array or a string, and `serialize` stringifies the
    // object straight into the column — so skipping the non-string case (the
    // idiomatic one for this CRUD layer) stored access tokens in cleartext with
    // a 201 and no warning. Non-string *values* are refused rather than stored:
    // `ConnectorSecrets` is Record<string, string>, and sealFields only seals
    // strings, so a nested value would travel through unsealed just as quietly.
    beforeWrite: async (_ctx, values, _existing, env) => {
      const raw = values.secretsJson;
      if (raw === undefined) return values;
      let parsed: unknown = raw;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw badRequest("secretsJson is not valid JSON");
        }
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw badRequest("secretsJson must be an object of provider secrets");
      }
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.some(([, v]) => typeof v !== "string")) throw badRequest("secretsJson values must be strings");
      const sealed = await sealFields(fieldKey(env), Object.fromEntries(entries), entries.map(([k]) => k));
      return { ...values, secretsJson: JSON.stringify(sealed) };
    }
  })
);

/* ------------------------------------------------------------------ signal */

/**
 * Legal campaign lifecycle (schema/signal.ts's `state` comment:
 * draft|review|scheduled|live|paused|ended). `ended` is terminal — without
 * this, a generic PATCH could resurrect an ended campaign straight back to
 * `live` (spend resuming with no launch approval re-checked) or jump `live`
 * back to `draft`/`review` as if it had never gone out. `draft -> live`
 * direct is intentionally legal (J-M1: a simple campaign skips the formal
 * review/scheduled steps and launches in one PATCH).
 */
const CAMPAIGN_TRANSITIONS: Record<string, string[]> = {
  draft: ["review", "scheduled", "live", "ended"],
  review: ["draft", "scheduled", "live", "ended"],
  scheduled: ["review", "live", "ended"],
  live: ["paused", "ended"],
  paused: ["live", "ended"],
  ended: []
};

export const SIGNAL = register(
  r("audiences", schema.signalAudiences, "aud", "signal", {
    read: "signal:audiences:read",
    create: "signal:audiences:create",
    update: "signal:audiences:create"
  }, { actorColumns: ["createdBy"] }),
  r("campaigns", schema.signalCampaigns, "cmp", "signal", {
    read: "signal:campaigns:read",
    create: "signal:campaigns:create",
    update: "signal:campaigns:update"
  }, {
    searchable: ["name"],
    // No amountField: a campaign's budget lives in `budgetJson` (per channel,
    // per period), not in a scalar column, and `amountField` reads one column.
    // The launch approval shows the campaign, not a number.
    approval: { update: "signal.campaign_launch" },
    // `existing` is null on create (a new campaign has no prior state to
    // transition from) — the table only constrains the update path.
    beforeWrite: (_ctx, values, existing) => {
      if (!existing) return values;
      const from = existing.state as string;
      const to = values.state;
      if (typeof to === "string" && to !== from && !(CAMPAIGN_TRANSITIONS[from] ?? []).includes(to)) {
        throw badRequest(`a campaign cannot move ${from} -> ${to}`);
      }
      return values;
    }
  }),
  r("creatives", schema.signalCreatives, "crv", "signal", {
    read: "signal:creatives:read",
    create: "signal:creatives:generate",
    update: "signal:creatives:approve"
  }, { approval: { update: "signal.creative_publish" } }),
  r("signal-experiments", schema.signalExperiments, "exp", "signal", {
    read: "signal:experiments:read",
    create: "signal:experiments:create",
    update: "signal:experiments:decide"
  }),
  r("budget-moves", schema.signalBudgetMoves, "bmv", "signal", {
    read: "signal:budget_moves:read",
    update: "signal:budget_moves:approve"
  }, { approval: { update: "signal.budget_move", amountField: "amountMinor" } }),
  r("aeo-pages", schema.signalAeoPages, "aeo", "signal", rw("signal:aeo")),
  r("attribution-events", schema.signalAttributionEvents, "atr", "signal", ro("signal:attribution:read"), {
    immutable: true
  }),
  r("spend", schema.signalSpend, "spd", "signal", ro("signal:spend:read"), {
    // F62 groundwork: spend lands on the bus as signal.spend.recorded, so
    // NORTH's snapshotter can eventually consume the event instead of
    // querying this module's table directly (CLAUDE.md rule 6).
    afterWrite: async (ctx, row) => {
      await emit(ctx, {
        module: "signal",
        type: "signal.spend.recorded",
        subject: String(row.id),
        data: {
          campaignId: row.campaignId,
          channel: row.channel,
          day: row.day,
          amountMinor: row.amountMinor,
          currency: row.currency,
          conversions: row.conversions
        }
      });
    }
  }),
  // The acquisition outreach ledger (engines/signal-outreach.ts). Read-only:
  // rows are written by the sweep and stamped converted by the loop-back —
  // a hand edit would forge the very proof the cockpit shows.
  r("outreach", schema.signalOutreach, "otr", "signal", ro("signal:outreach:read"), {
    immutable: true
  })
);

/* ------------------------------------------------------------------- scout */

// data-products.subscribersJson: array of { providerId, since, suspendedAt? }
// (see packages/core/src/seed/scout.ts). Malformed/absent reads as "no active
// subscribers" rather than throwing — this gates visibility, not data
// integrity. A subscriber entry with suspendedAt set has had that provider's
// access revoked, so it's excluded even while the product stays published.
function activeSubscriberIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is { providerId: string; suspendedAt?: number } =>
          typeof x === "object" && x !== null && typeof (x as { providerId?: unknown }).providerId === "string" && (x as { suspendedAt?: unknown }).suspendedAt == null
      )
      .map((x) => x.providerId);
  } catch {
    return [];
  }
}

export const SCOUT = register(
  r(
    "signals",
    schema.scoutSignals,
    "sig",
    "scout",
    { read: "scout:signals:read", create: "scout:signals:ingest" },
    {
      // packages/core/src/seed/scout.ts: "Embeddings live in Vectorize; the
      // seed records the id the harvester would have written" — this is that
      // harvester step, run on every ingested signal instead of only in seed data.
      beforeWrite: async (ctx, values, _existing, env) => {
        const payload = values.payloadJson;
        const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
        const embeddingRef = await embedUpsert(ctx, gatewayFor(env), env.VEC_MARKET, {
          module: "scout",
          purpose: "scout.signal.embed",
          id: id("vec", ctx.now),
          text,
          metadata: { tenantId: ctx.tenantId, source: values.source }
        });
        return embeddingRef ? { ...values, embeddingRef } : values;
      }
    }
  ),
  r("clusters", schema.scoutClusters, "clu", "scout", ro("scout:clusters:read")),
  r(
    "whitespaces",
    schema.scoutWhitespaces,
    "wsp",
    "scout",
    {
      read: "scout:whitespaces:read",
      update: "scout:whitespaces:promote"
    },
    { approval: { update: "scout.whitespace_promote" } }
  ),
  r("panel-bench", schema.scoutPanelBench, "pnb", "scout", ro("scout:panel_bench:read"), {
    // docs/modules/scout.md §2.5 — a bench row is one provider x line x
    // period cut; below the k-anonymity floor it names the one counterparty
    // behind it, so it is hidden (404) rather than served thin.
    rowVisible: ((_ctx, row) =>
      checkKAnonymity(row.volume as number, DEFAULT_K_FLOOR).allowed) as NonNullable<Resource["rowVisible"]>
  }),
  r("scout-experiments", schema.scoutExperiments, "sxp", "scout", {
    read: "scout:experiments:read",
    create: "scout:experiments:create",
    update: "scout:experiments:decide"
  }, {
    // The validation loop-back (engines/scout-validate.ts): a concluded
    // experiment stamps its whitespace validated/parked and emits the event
    // the radar reads. Fired from afterWrite so the CRUD update path — the
    // only way an experiment concludes — always carries the verdict through.
    afterWrite: async (ctx, row, action) => {
      if (action !== "update") return;
      await onExperimentConcluded(ctx, row as unknown as { id: string; whitespaceId: string; state: string; resultsJson: string | null });
    }
  }),
  r("data-products", schema.scoutDataProducts, "dtp", "scout", {
    read: "scout:data_products:read",
    create: "scout:data_products:create",
    update: "scout:data_products:publish"
  }, {
    // ROLE-028 (ADR-0025): provider.viewer only has scout:data_products:read,
    // so without this it sees every draft/suspended product tenant-wide, not
    // just what's published. Publishers (scout:data_products:publish) still
    // see drafts, they're the ones authoring them.
    //
    // A provider.viewer whose grant carries providerIds (core_users.providerId
    // set — see grantsFor in @lyra/core) is further scoped to products their
    // own provider subscribed to (subscribersJson). A provider.viewer with no
    // providerId recorded falls back to the pre-existing published-only view
    // rather than being locked out, since not every viewer has been assigned
    // a provider yet.
    rowVisible: ((ctx, row) => {
      if (row.status !== "published") {
        return can(ctx.actor, "scout:data_products:publish", { tenantId: ctx.tenantId, module: "scout" });
      }
      const providerIds = ctx.actor.grants.flatMap((g) => g.scope?.providerIds ?? []);
      if (providerIds.length === 0) return true;
      const subscribers = activeSubscriberIds(row.subscribersJson as string | null);
      return subscribers.some((id) => providerIds.includes(id));
    }) as NonNullable<Resource["rowVisible"]>
  })
);

/* ------------------------------------------------------------------- north */

export const NORTH = register(
  r("metrics", schema.northMetrics, "mtr", "north", rw("north:metrics")),
  r("snapshots", schema.northSnapshots, "snp", "north", ro("north:snapshots:read"), {
    immutable: true,
    // A snapshot is `{metricKey, value}` and nothing else: the name a person
    // reads and the unit that makes the number mean anything both live on the
    // metric definition. Without them the list printed `gwp … 74300000`.
    decorate: async (ctx, rows) => {
      const keys = [...new Set(rows.map((row) => String(row.metricKey ?? "")))].filter(Boolean);
      if (!keys.length) return rows;
      const defs = (await ctx.db
        .select({
          key: schema.northMetrics.key,
          nameJson: schema.northMetrics.nameJson,
          unit: schema.northMetrics.unit,
          currency: schema.northMetrics.currency
        })
        .from(schema.northMetrics)
        .where(scoped(ctx, schema.northMetrics, inArray(schema.northMetrics.key, keys)))) as {
        key: string;
        nameJson: string;
        unit: string;
        currency: string | null;
      }[];
      const byKey = new Map(defs.map((def) => [def.key, def]));
      return rows.map((row) => {
        const def = byKey.get(String(row.metricKey ?? ""));
        return def
          ? { ...row, metricName: def.nameJson, unit: def.unit, currency: def.currency }
          : row;
      });
    }
  }),
  // No generic create: docs/modules/north.md §2.2's hallucination control (every
  // claim machine-verified against the metric layer) only runs inside
  // engines/narrator.ts's generateBriefing(), called from POST
  // /v1/north/briefings/generate (routes/north.ts). A generic create here would
  // let anyone holding north:briefings:generate POST an arbitrary narrativeRef
  // straight to "review" with no verification behind it.
  r("briefings", schema.northBriefings, "brf", "north", {
    read: "north:briefings:read",
    update: "north:briefings:approve"
  }),
  r("anomalies", schema.northAnomalies, "ano", "north", {
    read: "north:anomalies:read",
    update: "north:anomalies:assign"
  }),
  r("scenarios", schema.northScenarios, "scn", "north", {
    read: "north:scenarios:read",
    create: "north:scenarios:run",
    update: "north:scenarios:run"
  }),
  r("boardpacks", schema.northBoardpacks, "bpk", "north", {
    read: "north:boardpacks:read",
    create: "north:boardpacks:generate"
  }),
  r("decisions", schema.northDecisions, "dec", "north", rw("north:decisions")),
  r("alert_rules", schema.northAlertRules, "nar", "north", rw("north:alerts"))
);

/* ------------------------------------------------------------------ ledger */

/** Legal invoice lifecycle (docs/19). Anything else is a 400, not a shortcut. */
const INVOICE_TRANSITIONS: Record<string, string[]> = {
  draft: ["issued", "void"],
  issued: ["paid", "overdue", "void", "credited"],
  overdue: ["paid", "void", "credited"],
  paid: ["credited"],
  void: [],
  credited: []
};

export const LEDGER = register(
  // Read-only on purpose (CLAUDE.md §12). A transaction is opened by
  // POST /v1/ledger/txn/:type in routes/ledger.ts — state machine, idempotency
  // key, balanced journal. A generated create was a second mint for money rows
  // with client-supplied `state` and `grossMinor` and none of that.
  r("txns", schema.ledgerTxns, "txn", "ledger", ro("ledger:txns:read")),
  r("txn-transitions", schema.ledgerTxnTransitions, "txt", "ledger", ro("ledger:txns:read"), {
    immutable: true
  }),
  r("saga-steps", schema.ledgerSagaSteps, "sag", "ledger", ro("ledger:txns:read")),
  r("accounts", schema.ledgerAccounts, "acc", "ledger", rw("ledger:accounts")),
  // Posted journals are the record. They are reversed, never amended.
  r("journal-batches", schema.ledgerJournalBatches, "bat", "ledger", ro("ledger:journals:read"), {
    immutable: true
  }),
  r("journal-lines", schema.ledgerJournalLines, "jln", "ledger", ro("ledger:journals:read"), {
    immutable: true
  }),
  r("account-balances", schema.ledgerAccountBalances, "bal", "ledger", ro("ledger:accounts:read")),
  // `state` (plus `checklistJson`/`closedBy`/`closedAt`) is close-sequencing-owned:
  // a raw PATCH could jump straight to hard_closed from open, skipping the
  // soft-close-first rule and closeChecks() (trial balance / pending-external /
  // client-money-breach invariants) that POST /periods/:code/close enforces.
  // Same door as ADR-0023, settlements, partner-agreements, commission-entries.
  r("periods", schema.ledgerPeriods, "per", "ledger", ro("ledger:periods:read")),
  r("recon-runs", schema.ledgerReconRuns, "rcr", "ledger", {
    read: "ledger:recon:read",
    create: "ledger:recon:run"
  }),
  r("recon-matches", schema.ledgerReconMatches, "rcm", "ledger", {
    read: "ledger:recon:read",
    update: "ledger:recon:confirm"
  }, { signedMoneyColumns: ["deltaMinor"] }),
  r("client-money-checks", schema.ledgerClientMoneyChecks, "cmc", "ledger", ro("ledger:client_money:read"), {
    immutable: true
  }),
  r("subscriptions", schema.ledgerSubscriptions, "sub", "ledger", rw("admin:billing"), {
    // A subscription with no `next_invoice_at` is never invoiced at all: the
    // sweep filters on `next_invoice_at <= now` and in SQL a NULL comparison is
    // NULL, not true. So it gets a default — but not `start_at`, which for a
    // back-dated term (a migrated customer, a contract signed last quarter) has
    // the sweep catch up every period since, billing months somebody has already
    // invoiced by hand. Due now, or when the term starts if that is still ahead;
    // callers may still name their own date. Deliberately not the same rule
    // migration 0026 uses to backfill existing rows: a subscription created
    // here has no invoicing history to protect, so `MAX(startAt, ctx.now)` is
    // safe. 0026's rows may already have been invoiced by hand for periods
    // since `startAt`, so it floors at the first of next month instead of
    // `startAt` — using this simpler rule there would back-bill those periods
    // a second time. Don't collapse the two into one.
    beforeWrite: (ctx, values, existing) => {
      if (existing || values.nextInvoiceAt != null) return values;
      return { ...values, nextInvoiceAt: Math.max(values.startAt as number, ctx.now) };
    }
  }),
  r("invoices", schema.ledgerInvoices, "inv", "ledger", {
    read: "ledger:invoices:read",
    create: "ledger:invoices:create",
    update: "ledger:invoices:approve"
  }, {
    // An invoice is born a draft and walks its lifecycle; `ledger:invoices:approve`
    // may move it, not teleport it (a draft "paid" with no issue step would be a
    // money record nothing ever posted).
    beforeWrite: (_ctx, values, existing) => {
      if (!existing) {
        const { state: _s, ...rest } = values; // the server owns the initial state
        return rest;
      }
      const from = existing.state as string;
      const to = values.state;
      if (typeof to === "string" && to !== from && !(INVOICE_TRANSITIONS[from] ?? []).includes(to)) {
        throw badRequest(`an invoice cannot move ${from} -> ${to}`);
      }
      return values;
    }
  }),
  r("revenue-schedules", schema.ledgerRevenueSchedules, "rev", "ledger", ro("ledger:journals:read")),
  r("usage-meters", schema.ledgerUsageMeters, "usg", "ledger", ro("admin:billing:read")),
  // Read-only for the same reason: a payment is captured by its transaction
  // type with the idempotency key the PSP callback replays against (the web
  // ledger module says exactly this and renders no create form). The generated
  // create accepted a client-settable `state` with no gate at all.
  r("payments", schema.ledgerPayments, "pay", "ledger", ro("ledger:payments:read")),
  // Read-only for the same reason as payments above: engines/premium-financing.ts
  // owns writes now (POST /v1/axis/policies/:id/premium-financing-plan), with the
  // fx-rate pre-check and chained FIN-CMSN commission the generic create knew
  // nothing about. The generated create accepted an arbitrary schedule/state
  // with no ledger entries behind it at all.
  r("payment-plans", schema.ledgerPaymentPlans, "ppl", "ledger", ro("ledger:payments:read")),
  r("fx-rates", schema.ledgerFxRates, "fx", "ledger", rw("ledger:accounts"), { immutable: true }),
  r("tax-rules", schema.ledgerTaxRules, "tax", "ledger", rw("ledger:accounts")),
  // Read-only for the same reason as payments above: routes/settlement.ts is
  // the sole doorway (run/approve/pay/dispute/reopen, each its own approval).
  // The generic update accepted a client-settable `state`/`netMinor` gated on
  // nothing but the flat dist:commissions:settle permission — no dual control,
  // no ledger.partner_settlement pay-approval — so a well-aimed PATCH could
  // force a settlement straight to "paid".
  r("settlements", schema.ledgerSettlements, "stl", "ledger", ro("dist:commissions:read"))
);

/* ---------------------------------------------------------------------- ai */

export const AI = register(
  r("agents", schema.aiAgents, "agt", "ai", rw("ai:agents")),
  r("prompts", schema.aiPrompts, "prm", "ai", rw("ai:prompts"), {
    actorColumns: ["createdBy"],
    approval: { update: "ai.prompt_publish" }
  }),
  r("runs", schema.aiRuns, "run", "ai", ro("ai:runs:read"), { immutable: true }),
  r("tool-calls", schema.aiToolCalls, "tlc", "ai", ro("ai:runs:read"), { immutable: true }),
  r("suggestions", schema.aiSuggestions, "sug", "ai", {
    read: "ai:suggestions:read",
    update: "ai:suggestions:read"
  }),
  r("budgets", schema.aiBudgets, "bdg", "ai", rw("ai:budgets"), {
    approval: { update: "ai.budget_raise" }
  }),
  r("evals", schema.aiEvals, "evl", "ai", {
    read: "ai:evals:read",
    create: "ai:evals:run"
  }),
  r("knowledge-sources", schema.aiKnowledgeSources, "kns", "ai", rw("ai:prompts")),
  r("guardrail-events", schema.aiGuardrailEvents, "gre", "ai", ro("ai:audit:read"), { immutable: true }),
  // Content is never stored, only hashes — so this is safe to expose to auditors.
  r("ai-audit-log", schema.aiAuditLog, "aia", "ai", ro("ai:audit:read"), { immutable: true })
);

/* -------------------------------------------------------------- compliance */

export const COMPLIANCE = register(
  r("dsar-requests", schema.dsarRequests, "dsr", "compliance", {
    read: "compliance:dsar:read",
    create: "compliance:dsar:create",
    update: "compliance:dsar:fulfil"
  }),
  r("erasure-log", schema.erasureLog, "ers", "compliance", ro("compliance:dsar:read"), { immutable: true }),
  r("disclosures", schema.disclosures, "dsc", "compliance", ro("compliance:disclosures:read"), {
    immutable: true
  }),
  // Read-only here: these three are produced by run/export endpoints in
  // routes/compliance.ts, which hash and gather server-side. A generated
  // `create` would let a caller post the hash it wants.
  r("screenings", schema.screenings, "scr", "compliance", ro("compliance:screenings:read")),
  r("retention-runs", schema.retentionRuns, "ret", "compliance", ro("compliance:retention:read")),
  r("legal-holds", schema.legalHolds, "lgh", "compliance", rw("compliance:legal_holds"), {
    actorColumns: ["placedBy"],
    approval: { remove: "compliance.legal_hold_release" }
  }),
  r("evidence-bundles", schema.evidenceBundles, "evb", "compliance", ro("compliance:evidence:read"), {
    immutable: true,
    actorColumns: ["requestedBy"]
  }),
  r("incidents", schema.incidents, "inc", "compliance", rw("compliance:incidents"), {
    actorColumns: ["openedBy"]
  }),
  r("rulepack-applications", schema.rulepackApplications, "rpa", "compliance", {
    read: "compliance:rulepacks:read",
    create: "compliance:rulepacks:apply"
  }),
  r("policy-thresholds", schema.policyThresholds, "pth", "compliance", rw("compliance:thresholds"), {
    actorColumns: ["setBy"]
  })
);

/* --------------------------------------------------------------- analytics */

export const ANALYTICS = register(
  // The row rules live beside the module routes that also enforce them, so a
  // record read through generic CRUD and the same record read through
  // /v1/analytics/* cannot disagree.
  r("dashboards", schema.dashboards, "dsh", "analytics", rw("analytics:dashboards"), {
    searchable: ["name"],
    rowVisible: dashboardVisible as NonNullable<Resource["rowVisible"]>
  }),
  r("reports", schema.reports, "rpt", "analytics", rw("analytics:reports"), {
    searchable: ["name"],
    rowVisible: reportVisible as NonNullable<Resource["rowVisible"]>
  }),
  r("report-runs", schema.reportRuns, "rrn", "analytics", {
    read: "analytics:reports:read",
    create: "analytics:reports:run"
  }, { actorColumns: ["requestedBy"], rowVisible: reportRunVisible as NonNullable<Resource["rowVisible"]> }),
  r("exports", schema.analyticsExports, "exp", "analytics", {
    read: "analytics:exports:download",
    create: "analytics:exports:create"
  }, {
    immutable: true,
    actorColumns: ["requestedBy"],
    rowVisible: exportVisible as NonNullable<Resource["rowVisible"]>
  }),
  r("schedules", schema.analyticsSchedules, "sch", "analytics", rw("analytics:schedules"), {
    actorColumns: ["createdBy"]
  }),
  r("saved-views", schema.savedViews, "svw", "analytics", rw("analytics:saved_views"), {
    rowVisible: savedViewVisible as NonNullable<Resource["rowVisible"]>
  }),
  r("unit-economics", schema.unitEconomics, "uec", "analytics", ro("analytics:reports:read")),
  r("journey-events", schema.journeyEvents, "jev", "analytics", ro("analytics:reports:read"), {
    immutable: true
  })
);

/** Module base path -> its resources, used for mounting and for OpenAPI. */
export const BY_MODULE: Record<string, Resource[]> = {
  core: CORE,
  dist: DIST,
  axis: AXIS,
  orbit: ORBIT,
  signal: SIGNAL,
  scout: SCOUT,
  north: NORTH,
  ledger: LEDGER,
  ai: AI,
  compliance: COMPLIANCE,
  analytics: ANALYTICS
};
