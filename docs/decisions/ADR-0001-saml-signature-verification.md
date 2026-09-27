# ADR-0001 — SAML is a seam, not an implementation

- Status: superseded by ADR-0097 (2026-09-27)
- Date: 2026-07-30
- Context: docs/06 §2 (enterprise sign-in), CLAUDE.md §15 (build to the seams)

## Context

`core_identity_providers.kind` reserves `"saml"` alongside `"oidc"`, and the row
carries `sso_url` and `certificate` for it. Some enterprise buyers will not
federate any other way, so the field has to exist. The question is whether the
first release verifies a SAML response.

Verifying one means XML canonicalisation (Exclusive C14N), XML-dsig reference
resolution, and signature checking over a document the attacker also controls
the shape of. The known failure modes are not exotic: comment-truncation on the
`NameID`, signature-wrapping where a valid signature covers an element that is
not the assertion being read, and entity expansion. Workers has no XML parser
and no C14N implementation, so a from-scratch implementation would be exactly
the hand-rolled crypto that these attacks were written for. Getting it wrong is
an authentication bypass, not a bug.

## Decision

`kind: "saml"` is stored, listed and administered, and every sign-in route
refuses it with a 400 naming the reason. Only `kind: "oidc"` completes a
sign-in. OIDC covers Google Workspace, Microsoft Entra ID, Okta and Auth0, which
is the buyer set the seam was reserved for anyway.

Turning SAML on requires a second ADR that names an approved, maintained
signature-verification library (docs/02 §9 governs the dependency), plus test
vectors for comment-truncation and signature-wrapping in the acceptance suite.

## Consequences

- An IdP that speaks only SAML cannot be onboarded yet. The provider row can be
  created so the configuration is not lost, but `enabled` stays meaningless for
  it — the route refuses before it reads the flag.
- No new dependency, no XML parsing in the auth path.
- The OIDC path carries the whole burden, so it is the one that is tested:
  RS256-only, JWKS-verified, issuer/audience/expiry/nonce checked, PKCE, and
  single-use state (`apps/api/src/sso.test.ts`).
