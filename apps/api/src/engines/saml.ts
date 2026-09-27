import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { unauthorized } from "@lyra/core";

// ADR-0097. SAML 2.0 Web SSO, service-provider side: an AuthnRequest out over
// the HTTP-Redirect binding, a Response back over HTTP-POST. Verification is
// xml-crypto's (Exclusive C14N, XML-DSig); everything this file decides is read
// from the XML that signature actually covered (`getSignedReferences`), never
// from the document the attacker also shaped — which is the whole defence
// against signature wrapping and comment truncation (ADR-0001).

const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG = "http://www.w3.org/2000/09/xmldsig#";
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
/** SHA-1 is refused outright; these are what current IdPs sign with. */
const SIGNATURE_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"
]);
/** Clock skew tolerated either side of an assertion's window. */
const SKEW_MS = 3 * 60_000;

const EMAIL_ATTRIBUTES = ["email", "mail", "emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"];
const NAME_ATTRIBUTES = [
  "displayName",
  "name",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
];

export interface SamlExpectations {
  /** The IdP's signing certificate or public key, PEM. Never taken from the response. */
  certificate: string;
  idpIssuer: string;
  spEntityId: string;
  acsUrl: string;
  /** The AuthnRequest ID this sign-in started with; anything else is a replay. */
  requestId: string;
  now: number;
}

export interface SamlIdentity {
  nameId: string;
  email?: string;
  name?: string;
  sessionIndex?: string;
}

const refuse = (why: string) => unauthorized(`SAML response refused: ${why}`);

function parse(xml: string): Document {
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level, msg) => {
        if (level !== "warning") throw new Error(msg);
      }
    }).parseFromString(xml, "text/xml");
  } catch (err) {
    throw refuse(`not well-formed XML (${String(err instanceof Error ? err.message : err).slice(0, 80)})`);
  }
  if (!doc.documentElement) throw refuse("not well-formed XML");
  return doc;
}

const children = (el: Element, ns: string, local: string): Element[] =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === 1)
    .map((n) => n as unknown as Element)
    .filter((n) => n.namespaceURI === ns && n.localName === local);
const child = (el: Element | undefined, ns: string, local: string): Element | undefined => (el ? children(el, ns, local)[0] : undefined);
const all = (el: Document | Element, ns: string, local: string): Element[] => Array.from(el.getElementsByTagNameNS(ns, local) as ArrayLike<Element>);
const time = (el: Element | undefined, attr: string): number | null => {
  const v = el?.getAttribute(attr);
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw refuse(`${attr} is not a time`);
  return t;
};

function decode(b64: string): string {
  let binary: string;
  try {
    binary = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw refuse("SAMLResponse is not base64");
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/**
 * Verify the signature on `signed` (the Assertion or the Response) and return
 * the assertion as it was signed. The reference must point at the element the
 * Signature sits in, and exactly one reference may be signed.
 */
function signedAssertion(xml: string, root: Element, assertion: Element, certificate: string): Element {
  const candidates = [assertion, root]
    .map((parent) => ({ parent, signature: child(parent, DSIG, "Signature") }))
    .filter((c): c is { parent: Element; signature: Element } => !!c.signature);
  if (!candidates.length) throw refuse("the assertion is not signed");

  for (const { parent, signature } of candidates) {
    const method = child(child(signature, DSIG, "SignedInfo"), DSIG, "SignatureMethod")?.getAttribute("Algorithm") ?? "";
    if (!SIGNATURE_ALGORITHMS.has(method)) throw refuse(`signature algorithm ${method || "(none)"} is not accepted`);
    const references = all(child(signature, DSIG, "SignedInfo")!, DSIG, "Reference");
    const id = parent.getAttribute("ID");
    if (references.length !== 1 || !id || references[0]!.getAttribute("URI") !== `#${id}`) {
      throw refuse("the signature does not cover the element it is in");
    }

    // Only the configured key: getCertFromKeyInfo stays the no-op default, so a
    // key embedded in the response is never trusted.
    const sig = new SignedXml({ publicCert: certificate });
    // As text: xml-crypto parses with its own DOM, never ours.
    sig.loadSignature(signature.toString());
    let valid = false;
    try {
      valid = sig.checkSignature(xml);
    } catch {
      valid = false;
    }
    if (!valid) throw refuse("the signature does not verify against the configured certificate");

    const signedRefs = sig.getSignedReferences();
    if (signedRefs.length !== 1) throw refuse("exactly one signed reference is accepted");
    const signedRoot = parse(signedRefs[0]!).documentElement!;
    if (signedRoot.getAttribute("ID") !== id) throw refuse("the signed element is not the one presented");
    if (parent === assertion) return signedRoot;
    const inner = all(signedRoot, ASSERTION, "Assertion");
    if (inner.length !== 1) throw refuse("the signed response must hold exactly one assertion");
    return inner[0]!;
  }
  throw refuse("the assertion is not signed");
}

function attribute(assertion: Element, names: readonly string[]): string | undefined {
  for (const attr of all(assertion, ASSERTION, "Attribute")) {
    const name = attr.getAttribute("Name") ?? "";
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    const value = child(attr, ASSERTION, "AttributeValue")?.textContent?.trim();
    if (value) return value;
  }
  return undefined;
}

export async function verifySamlResponse(samlResponse: string, e: SamlExpectations): Promise<SamlIdentity> {
  const xml = decode(samlResponse);
  // Entity expansion and external entities both arrive by a DTD; a SAML
  // response never needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw refuse("a DOCTYPE is not accepted");
  const doc = parse(xml);
  const root = doc.documentElement!;
  if (root.namespaceURI !== PROTOCOL || root.localName !== "Response") throw refuse("not a SAML Response");

  const status = child(child(root, PROTOCOL, "Status"), PROTOCOL, "StatusCode")?.getAttribute("Value");
  if (status !== SUCCESS) throw refuse(`the IdP answered status ${status ?? "(none)"}`);
  if (all(doc, ASSERTION, "EncryptedAssertion").length) throw refuse("encrypted assertions are not supported");
  const assertions = all(doc, ASSERTION, "Assertion");
  if (assertions.length !== 1) throw refuse(`exactly one assertion is accepted, found ${assertions.length}`);
  const destination = root.getAttribute("Destination");
  if (destination && destination !== e.acsUrl) throw refuse("Destination is not this service's ACS");
  const outerReply = root.getAttribute("InResponseTo");
  if (outerReply && outerReply !== e.requestId) throw refuse("InResponseTo does not match this sign-in");

  // From here on, only what was signed.
  const assertion = signedAssertion(xml, root, assertions[0]!, e.certificate);

  if (child(assertion, ASSERTION, "Issuer")?.textContent?.trim() !== e.idpIssuer) throw refuse("issuer does not match the provider");

  const conditions = child(assertion, ASSERTION, "Conditions");
  const notBefore = time(conditions, "NotBefore");
  const notOnOrAfter = time(conditions, "NotOnOrAfter");
  if (notBefore !== null && notBefore > e.now + SKEW_MS) throw refuse("the assertion is not yet valid (NotBefore)");
  if (notOnOrAfter !== null && notOnOrAfter <= e.now - SKEW_MS) throw refuse("the assertion has expired (NotOnOrAfter)");
  const audiences = all(assertion, ASSERTION, "Audience").map((a) => a.textContent?.trim());
  if (!audiences.includes(e.spEntityId)) throw refuse("audience is not this service");

  const subject = child(assertion, ASSERTION, "Subject");
  const bearer = subject && children(subject, ASSERTION, "SubjectConfirmation").find((s) => s.getAttribute("Method") === BEARER);
  const data = child(bearer, ASSERTION, "SubjectConfirmationData");
  if (!data) throw refuse("no bearer subject confirmation");
  if (data.getAttribute("Recipient") !== e.acsUrl) throw refuse("recipient is not this service's ACS");
  if (data.getAttribute("InResponseTo") !== e.requestId) throw refuse("InResponseTo does not match this sign-in");
  const confirmUntil = time(data, "NotOnOrAfter");
  if (confirmUntil === null || confirmUntil <= e.now - SKEW_MS) throw refuse("the subject confirmation has expired (NotOnOrAfter)");

  // textContent of the *signed* NameID: canonical XML carries no comments, so
  // there is no text node for a truncation to stop at.
  const nameIdEl = child(subject, ASSERTION, "NameID");
  const nameId = nameIdEl?.textContent?.trim();
  if (!nameId) throw refuse("no NameID");
  const email = attribute(assertion, EMAIL_ATTRIBUTES) ?? (nameIdEl?.getAttribute("Format") === EMAIL_FORMAT ? nameId : undefined);
  const name = attribute(assertion, NAME_ATTRIBUTES);
  const sessionIndex = child(assertion, ASSERTION, "AuthnStatement")?.getAttribute("SessionIndex") ?? undefined;
  return {
    nameId,
    ...(email ? { email: email.toLowerCase() } : {}),
    ...(name ? { name } : {}),
    ...(sessionIndex ? { sessionIndex } : {})
  };
}

/* ------------------------------------------------------------ AuthnRequest */

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The HTTP-Redirect binding: deflate-raw, base64, one query parameter. Unsigned, as most IdPs accept. */
export async function authnRequestUrl(o: {
  ssoUrl: string;
  requestId: string;
  spEntityId: string;
  acsUrl: string;
  relayState: string;
  now: number;
}): Promise<string> {
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" xmlns:saml="${ASSERTION}" ID="${attr(o.requestId)}" Version="2.0"` +
    ` IssueInstant="${new Date(o.now).toISOString()}" Destination="${attr(o.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${attr(o.acsUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
    `<saml:Issuer>${attr(o.spEntityId)}</saml:Issuer><samlp:NameIDPolicy AllowCreate="true"/></samlp:AuthnRequest>`;
  const deflated = new Uint8Array(await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const url = new URL(o.ssoUrl);
  url.searchParams.set("SAMLRequest", btoa(String.fromCharCode(...deflated)));
  url.searchParams.set("RelayState", o.relayState);
  return url.toString();
}

/** SP metadata for the IdP administrator: entity id, ACS, and that assertions must be signed. */
export function spMetadata(spEntityId: string, acsUrl: string): string {
  return (
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${attr(spEntityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${PROTOCOL}">` +
    `<md:NameIDFormat>${EMAIL_FORMAT}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${attr(acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>`
  );
}
