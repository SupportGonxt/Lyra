import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authnRequestUrl, verifySamlResponse, type SamlExpectations } from "./saml.js";
import { samlFixture } from "../saml-fixture.js";

// ADR-0097 (lifting ADR-0001's seam). The test vectors ADR-0001 made a
// condition of turning SAML on: comment truncation on the NameID, signature
// wrapping, an unsigned or tampered assertion, entity expansion, a SHA-1
// signature — alongside the ordinary audience, recipient, issuer, replay and
// time-window checks. Each is built by signing a real response with a real key
// and then attacking it, not by asserting on a hand-written fixture.

const idp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = idp.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE_PEM = idp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const OTHER_PRIVATE_PEM = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const NOW = Date.parse("2026-09-27T10:00:00Z");
const expect_: SamlExpectations = {
  certificate: PUBLIC_PEM,
  idpIssuer: "https://idp.gonxt.test/saml",
  spEntityId: "https://api.lyra.test/v1/auth/sso/idp_1/metadata",
  acsUrl: "https://api.lyra.test/v1/auth/sso/idp_1/acs",
  requestId: "_req_abc",
  now: NOW
};
const { assertionXml, responseXml, signedResponse, b64 } = samlFixture({ ...expect_, privateKey: PRIVATE_PEM });

describe("verifySamlResponse accepts", () => {
  it("a response whose assertion is signed by the configured key", async () => {
    const out = await verifySamlResponse(b64(signedResponse()), expect_);
    expect(out).toEqual({ nameId: "layla@gonxt.ae", email: "layla@gonxt.ae", name: "Layla Hassan", sessionIndex: "_s1" });
  });

  it("a response signed as a whole, reading the assertion inside what was signed", async () => {
    const out = await verifySamlResponse(b64(signedResponse({}, { target: "response" })), expect_);
    expect(out.nameId).toBe("layla@gonxt.ae");
  });
});

describe("verifySamlResponse refuses (ADR-0001's vectors)", () => {
  const refuses = async (xml: string, reason: RegExp, e: Partial<SamlExpectations> = {}) =>
    expect(verifySamlResponse(b64(xml), { ...expect_, ...e })).rejects.toMatchObject({ status: 401, detail: expect.stringMatching(reason) });

  it("comment truncation: the NameID is read whole, never up to the comment", async () => {
    // The IdP signed "admin@gonxt.ae.evil.test" for the attacker's own account.
    // A comment is invisible to exclusive C14N, so the signature still holds;
    // a parser that reads the first text node would see "admin@gonxt.ae".
    const signed = signedResponse({ nameId: "admin@gonxt.ae.evil.test", attributes: { email: "admin@gonxt.ae.evil.test" } });
    const attacked = signed.replace("admin@gonxt.ae.evil.test</saml:NameID>", "admin@gonxt.ae<!---->.evil.test</saml:NameID>");
    expect(attacked).not.toBe(signed);
    const out = await verifySamlResponse(b64(attacked), expect_);
    expect(out.nameId).toBe("admin@gonxt.ae.evil.test");
  });

  it("signature wrapping: a second, unsigned assertion is refused, never read", async () => {
    const signed = signedResponse();
    const evil = assertionXml("_evil", { nameId: "admin@gonxt.ae", attributes: { email: "admin@gonxt.ae" } });
    await refuses(signed.replace("<saml:Assertion", `${evil}<saml:Assertion`), /exactly one assertion/i);
    // …and the signed original tucked somewhere else, the evil one in its place.
    const tucked = signed.replace(/<saml:Assertion[\s\S]*<\/saml:Assertion>/, (orig) => `<samlp:Extensions>${orig}</samlp:Extensions>${evil}`);
    await refuses(tucked, /exactly one assertion|not signed/i);
  });

  it("an unsigned response, or one signed by another key", async () => {
    await refuses(responseXml(assertionXml("_a1")), /not signed/i);
    await refuses(signedResponse({}, { key: OTHER_PRIVATE_PEM }), /signature/i);
  });

  it("an assertion edited after signing", async () => {
    await refuses(signedResponse().replace("layla@gonxt.ae</saml:NameID>", "admin@gonxt.ae</saml:NameID>"), /signature/i);
  });

  it("a DOCTYPE, which is how entity expansion arrives", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "xx">]>${signedResponse()}`;
    await refuses(xml, /DOCTYPE/i);
  });

  it("a SHA-1 signature", async () => {
    await refuses(signedResponse({}, { algorithm: "sha1" }), /algorithm/i);
  });

  it("the wrong issuer, audience or recipient", async () => {
    await refuses(signedResponse({ issuer: "https://someone.else/saml" }), /issuer/i);
    await refuses(signedResponse({ audience: "https://another-sp.test" }), /audience/i);
    await refuses(signedResponse({ recipient: "https://attacker.test/acs" }), /recipient/i);
  });

  it("an answer to a request this service did not make (replay)", async () => {
    await refuses(signedResponse({ inResponseTo: "_someone_elses" }), /InResponseTo/i);
  });

  it("an expired or not-yet-valid assertion, beyond the clock skew", async () => {
    await refuses(signedResponse({ notOnOrAfter: NOW - 5 * 60_000 }), /expired|NotOnOrAfter/i);
    await refuses(signedResponse({ notBefore: NOW + 10 * 60_000 }), /NotBefore|not yet/i);
  });

  it("a failed status from the IdP", async () => {
    await refuses(signedResponse({ status: "urn:oasis:names:tc:SAML:2.0:status:Responder" }), /status/i);
  });
});

describe("authnRequestUrl", () => {
  it("redirects to the IdP with a deflated AuthnRequest naming this SP and its ACS", async () => {
    const url = new URL(
      await authnRequestUrl({ ssoUrl: "https://idp.gonxt.test/sso?tenant=1", requestId: "_req_abc", spEntityId: expect_.spEntityId, acsUrl: expect_.acsUrl, relayState: "rs1", now: NOW })
    );
    expect(url.origin + url.pathname).toBe("https://idp.gonxt.test/sso");
    expect(url.searchParams.get("tenant")).toBe("1");
    expect(url.searchParams.get("RelayState")).toBe("rs1");
    const inflated = await new Response(
      new Blob([Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    ).text();
    expect(inflated).toContain('ID="_req_abc"');
    expect(inflated).toContain(`AssertionConsumerServiceURL="${expect_.acsUrl}"`);
    expect(inflated).toContain(`<saml:Issuer>${expect_.spEntityId}</saml:Issuer>`);
  });
});
