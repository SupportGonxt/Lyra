# ADR-0096 — SCIM 2.0 provisioning

Date: 2026-09-27 · Status: accepted

## Context

docs/30 Admin 5 asked for SCIM provisioning, and after it SAML. Until now, an
enterprise tenant's joiners and leavers were typed into `/admin/staff` by
hand. So a person disabled in Entra ID or Okta kept their LYRA sign-in until
someone remembered to remove it. The user approved the work on 2026-09-27.
SCIM is a protocol, not a service: it needs no new dependency (docs/02 §9).

## Decision

1. **`/v1/scim/v2`** (RFC 7643/7644) serves:
   - `ServiceProviderConfig`;
   - `Users`: list, get, create, PUT, PATCH, DELETE;
   - `Groups`: list, get, PATCH.

   Every response and every refusal is `application/scim+json`, in SCIM's
   error shape with its `scimType`, because that is what an IdP connector
   parses.
2. **The caller is an API key.** No new credential. A tenant administrator
   mints an ordinary key whose scopes are the permissions a person doing the
   same job would need:
   - `core:users:read|create|update`
   - `core:roles:read|assign`

   Keys are already scoped, rotated (90-day nudge), audited and
   entitlement-filtered.
3. **Users.**
   - `userName` is the email. It is lower-cased, and it must be unique in the
     tenant; a duplicate gets SCIM `uniqueness`.
   - A provisioned person is `active` with `authProvider: "oidc"` and no
     password: the IdP vouches for them, and they sign in through it.
   - `active: false` (PATCH or PUT) and `DELETE` both *suspend*. Nothing is
     deleted, so the person's audit trail, approvals and notes stay
     attributable. `auth.ts` refuses a suspended user on every request, so
     deactivation takes effect on the next call.
   - Seats are enforced (`assertSeatAvailable`).
   - Filters: `userName eq` and `externalId eq`. Anything else is
     `invalidFilter`, never "return everyone".
   - Attributes this service does not store are ignored, not refused. IdPs
     send far more than any one service keeps.
4. **Groups are the tenant's roles**, with `displayName` = role key.
   - A Group PATCH changes membership only. Creating, renaming or deleting a
     role answers `mutability`, because roles are the administrator's to
     define.
   - Adding a member is a role grant, held to the same escalation guard as a
     person granting it (`assertCanGrant`): the key must hold every permission
     the role confers.
   - Each change is audited and emits `core.staff.roles_changed`, exactly as
     `/admin/staff` does.

## Consequences

- Entra ID, Okta and OneLogin can provision against the tenant with a bearer
  API key.
- The key that can grant `axis.lead` must itself hold `axis.lead`'s
  permissions. An administrator who wants the IdP to manage a role must mint
  a key wide enough for it. That is deliberate: a narrower default would
  make SCIM a route around the escalation guard.
- SAML sign-in remains ADR-0001's seam until its own ADR names a
  verification library.
