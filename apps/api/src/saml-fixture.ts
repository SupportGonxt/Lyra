import { SignedXml } from "xml-crypto";

// Test-only: a SAML IdP in miniature. Builds a Response for the given
// expectations and signs it the way real IdPs do (enveloped, exclusive C14N),
// so tests attack a genuinely signed document. Imported by tests alone.

export interface Build {
  nameId?: string;
  issuer?: string;
  audience?: string;
  recipient?: string;
  inResponseTo?: string;
  notBefore?: number;
  notOnOrAfter?: number;
  status?: string;
  attributes?: Record<string, string>;
}

export interface SignOptions {
  target?: "assertion" | "response";
  key?: string;
  algorithm?: "sha256" | "sha1";
}

export function samlFixture(e: { idpIssuer: string; spEntityId: string; acsUrl: string; requestId: string; now: number; privateKey: string }) {
  const iso = (ms: number) => new Date(ms).toISOString();

  function assertionXml(id: string, b: Build = {}): string {
    const attrs = Object.entries(b.attributes ?? { email: "layla@gonxt.ae", displayName: "Layla Hassan" })
      .map(([k, v]) => `<saml:Attribute Name="${k}"><saml:AttributeValue>${v}</saml:AttributeValue></saml:Attribute>`)
      .join("");
    return (
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(e.now)}">` +
      `<saml:Issuer>${b.issuer ?? e.idpIssuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${b.nameId ?? "layla@gonxt.ae"}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData InResponseTo="${b.inResponseTo ?? e.requestId}" Recipient="${b.recipient ?? e.acsUrl}" NotOnOrAfter="${iso(b.notOnOrAfter ?? e.now + 300_000)}"/>` +
      `</saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(b.notBefore ?? e.now - 60_000)}" NotOnOrAfter="${iso(b.notOnOrAfter ?? e.now + 300_000)}">` +
      `<saml:AudienceRestriction><saml:Audience>${b.audience ?? e.spEntityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(e.now)}" SessionIndex="_s1"/>` +
      `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
      `</saml:Assertion>`
    );
  }

  function responseXml(assertion: string, b: Build = {}): string {
    return (
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${iso(e.now)}" Destination="${e.acsUrl}" InResponseTo="${b.inResponseTo ?? e.requestId}">` +
      `<saml:Issuer>${b.issuer ?? e.idpIssuer}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="${b.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>` +
      assertion +
      `</samlp:Response>`
    );
  }

  function sign(xml: string, opts: SignOptions = {}): string {
    const sha1 = opts.algorithm === "sha1";
    const sig = new SignedXml({
      privateKey: opts.key ?? e.privateKey,
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
      signatureAlgorithm: sha1 ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
    });
    const target = opts.target ?? "assertion";
    sig.addReference({
      xpath: target === "assertion" ? "//*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: sha1 ? "http://www.w3.org/2000/09/xmldsig#sha1" : "http://www.w3.org/2001/04/xmlenc#sha256"
    });
    sig.computeSignature(xml, {
      location: {
        reference: target === "assertion" ? "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']" : "/*[local-name(.)='Response']/*[local-name(.)='Issuer']",
        action: "after"
      }
    });
    return sig.getSignedXml();
  }

  const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
  const signedResponse = (b: Build = {}, opts: SignOptions = {}) => sign(responseXml(assertionXml("_a1", b), b), opts);
  return { assertionXml, responseXml, sign, signedResponse, b64 };
}
