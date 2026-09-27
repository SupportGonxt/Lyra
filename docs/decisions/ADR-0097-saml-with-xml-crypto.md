# ADR-0097 — SAML sign-in, verified by xml-crypto

Date: 2026-09-27 · Status: accepted · Supersedes ADR-0001

## Context

ADR-0001 kept `kind: "saml"` as a seam. Three reasons:

- Verifying a SAML response is XML canonicalisation plus XML-DSig over a
  document the attacker also shapes.
- The known failures (comment truncation, signature wrapping, entity
  expansion) are authentication bypasses.
- Workers had no XML stack.

It set two conditions for turning SAML on: a second ADR naming an approved,
maintained verification library, and test vectors for those attacks in the
suite. The user approved SAML on 2026-09-27 (docs/30 Admin 5), and this ADR
meets both conditions.

## Decision

1. **Library: `xml-crypto` 6.x** (MIT).
   - It is maintained by the node-saml organisation, the same people behind
     passport-saml and node-saml; 6.3.2 was released 2026-09-24.
   - It does Exclusive C14N and XML-DSig.
   - Its v6 API exposes `getSignedReferences()`: the canonical XML of exactly
     what the signature covered. Its default `getCertFromKeyInfo` is a no-op,
     so a key embedded in the response is never trusted.
   - Parsing is done with `@xmldom/xmldom` 0.9.
   - Both run under `nodejs_compat`. This was checked by running the engine
     inside `wrangler dev` (workerd), not only in Node.
2. **Read only what was signed.** `engines/saml.ts` verifies the Signature in
   the Assertion or the Response, then re-parses the signed reference. Issuer,
   audience, recipient, `InResponseTo`, the time windows, the NameID and the
   attributes are all read from that, never from the posted document.
3. **Refused outright:**
   - any DOCTYPE or ENTITY (the entity-expansion vector);
   - more or fewer than one Assertion (signature wrapping);
   - a Signature whose single Reference does not point at the element it sits
     in;
   - more than one signed reference;
   - SHA-1 (RSA-SHA256/512 only);
   - `EncryptedAssertion` (not supported yet);
   - a non-Success status;
   - a Destination other than this ACS.
4. **Comment truncation cannot happen.** The NameID is the `textContent` of
   the *canonical* signed XML, which carries no comments. The test signs
   `admin@gonxt.ae.evil.test`, inserts `<!---->`, and reads the whole address
   back.
5. **Flow.**
   - `GET /v1/auth/sso/{id}/start` sends an unsigned AuthnRequest over
     HTTP-Redirect. Its ID and a RelayState are stored single-use in KV for
     ten minutes, exactly like OIDC state.
   - `POST /v1/auth/sso/{id}/acs` spends the RelayState before verifying.
     The Response must answer that request's ID, so an IdP-initiated or
     replayed response finds nothing.
   - Linking, JIT provisioning and the session are OIDC's own `linkOrCreate`
     and `issueSession`, with the NameID as the subject.
   - `GET /v1/auth/sso/{id}/metadata` publishes SP metadata for the IdP
     administrator.
6. **Configuration.** `ssoUrl` (https) and `certificate` on the provider row,
   both editable on the Sign-in providers screen. The certificate is a PEM
   public key or certificate, or the bare base64 that IdP metadata carries.

## Consequences

- Entra ID, Okta, OneLogin, ADFS and Google Workspace can federate over SAML.
- Not supported: IdP-initiated sign-in (no request to answer), encrypted
  assertions, signed AuthnRequests and Single Logout. Each is additive. An
  IdP that insists on one needs its own change.
- Two new dependencies in `apps/api`: `xml-crypto` and `@xmldom/xmldom`.
  `@xmldom/xmldom` was already in the tree through the root overrides.
