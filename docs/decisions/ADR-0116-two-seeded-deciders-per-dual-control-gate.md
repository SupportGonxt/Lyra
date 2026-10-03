# ADR-0116 — Every dual-control gate has two seeded deciders

**Date:** 2026-10-03
**Status:** Accepted
**Builds on:** docs/06 §1 (role catalogue), docs/19 §7 (approvals), ADR-0106
(finance.controller as the second seat on a reinsurance cession), ADR-0101
(a data-product subscription is the contract), CLAUDE.md §4 (human in the loop)

## Context

A role-adoption simulation took the seeded staff personas (`PEOPLE`,
`packages/core/src/seed.ts`) as the only people in a tenant, leaving out the
all-roles demo login. It found approval gates that could never clear.

`decide()` (`packages/core/src/approvals.ts`) refuses an approval from its
own requester whenever dual control applies. When the role that raises a gate
also holds the gate's `decide` permission, and only one seeded persona holds
it, that person's own requests wait for someone who does not exist. Before this
change:

- **AXIS:** `axis.bind`, `axis.bind_group`, `axis.endorse` and
  `axis.claim_settlement` were decidable only by `axis.lead` (omar.farouk),
  who also raises them.
- **`axis.escrow_release`** (dual control `always`) was worse. Both
  `axis:escrow:reconcile`, which raises it, and `axis:escrow:approve` belonged
  to `axis.admin` alone, so the only reconciler was the only approver.
- **SIGNAL:** `signal.budget_commit` was decidable only by `signal.lead`.
- **SCOUT:** `scout.data_product_subscribe` was decidable by no seeded persona.
  Both the subscribe route and the decision require
  `scout:data_products:publish`, and only `scout.admin` held it.
- **Compliance:** `compliance.erasure`, `compliance.legal_hold_release` and
  `compliance.shariah_certify` were decidable only by `tenant.compliance`.
- **AI:** `ai.autonomy_raise` and `ai.budget_raise` were decidable only by
  `tenant.admin`. Their routes require the same verb that decides them.

The demo tenant only appeared to work because the all-roles administrator
was approving everything.

## Decision

1. **A guard holds the invariant.**
   `packages/core/src/approvals.deciders.test.ts` covers every approval policy
   a seeded tenant reaches: a seeded persona works in its module or can decide
   it. Each such policy needs two distinct seeded deciders, not counting the
   demo admin, or a named exception with its reason. The test checks every
   policy as in scope or out of scope, so none is skipped. An exception fails
   the test as soon as it gains a second decider. A "self-decidable" exception
   is checked to really have `dualControl: "never"`.

2. **Staffing first: seat a second holder of an existing role.** Where the
   role model already places the decision correctly, the fix is a persona,
   not a grant. This follows the two finance controllers, who are seeded for
   exactly this reason:
   - `suhail.hamdan`, `axis.admin`. The role is listed in docs/06 §1 and
     already holds `axis:*:*`.
   - `kareem.shamsi`, `signal.admin`.
   - `basma.darwish`, `scout.admin`, who owns publishing per
     docs/modules/scout.md §6 ("SCOUT Admin").
   - `ziad.habsi`, a second `tenant.admin`. rbac.ts says the AI budget, prompt
     and agent writes "belong to no other tenant role", and that
     `tenant.compliance` "must not also be the party that authors what it
     reviews". So the second AI decider has to be another tenant admin.
   - `asma.qasim`, a second `tenant.compliance`. For Shariah certification,
     the policy's own rationale settles the count: "A board is by definition
     more than one person, so a single signature is not a board ruling"
     (approvals.ts). Erasure and legal-hold release are the officer's duties
     under docs/12 and docs/06 §1, and nothing there gives them to the admin.

3. **Two grants, where a persona alone could not fix it.**
   - **`finance.controller` gains `axis:escrow:read` and
     `axis:escrow:approve`.** Escrow release moves money out, so the
     controller is the natural countersigner. This follows ADR-0106, which
     made the controller "the second seat on [a cession] beside axis.admin —
     reads the treaty, signs the amount". The controller does not get
     `:reconcile`, so it can never be the requester it approves.
   - **`tenant.admin` gains `scout:data_products:publish`.** ADR-0101 makes
     the subscription the contract that fixes a provider's fee. `tenant.admin`
     already signs the tenant's other contracts (`dist:agreements:sign`, where
     "drafter and signer are two people or the countersignature proves
     nothing"). docs/06 §1 also puts module admin within tenant admin. Without
     this grant, a lone SCOUT admin's sale above the threshold had nobody to
     countersign it. The grant also lets a tenant admin publish a data product
     and see SCOUT drafts. That widening is accepted here.

4. **Exceptions that remain.**
   - `axis.claim_reserve`, `axis.claim_payment` and `axis.claim_exgratia`:
     rbac.ts (design §A.2) keeps `:reserve` and `:pay` away from the roles
     that hold `:reserve_approve` and `:pay_approve`. The single decider,
     axis.admin, is therefore never the agent or lead who raised the request.
   - `orbit.renewal_offer`: dual control `never`, so its single holder may
     decide.

5. **Deployed tenants.** New personas reach a tenant provisioned earlier
   through `ensureSeedPeople` (`POST /v1/auth/demo/resync-roles`). That path
   is idempotent by email, and a test in seed.test.ts covers the backfill.
   The two grants arrive through `resyncSystemRolePermissions` in the same
   call.

## Consequences

- The demo tenant has 23 named personas, up from 18 (`/v1/auth/demo/personas`
  after a resync).
- A new approval policy, or a role change that leaves a gate with one
  decider, fails the guard. The author must seat a second decider or name the
  exception and its reason.
