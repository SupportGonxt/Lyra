import { describe, expect, it } from "vitest";
import { LABELS, coverage, labelsIn, providerTone, roleName, securityLede, signInMethod } from "./admin-security";

// The security posture screen is read-only by design (MFA is a platform floor,
// not tenant policy), so there is no action reducer to test. What can go wrong
// is the arithmetic — a tenant with nobody required reading as 0% covered — and
// the risk signal on a provider that signs people in without a second factor.

describe("coverage", () => {
  it("reads full when the floor applies to nobody", () => {
    // A tenant of partners and customers only. Zero of zero is covered, not a
    // division by zero and not a 0% alarm.
    expect(coverage({ required: 0, enrolled: 0 })).toBe(100);
  });

  it("reads full when everyone required has enrolled", () => {
    expect(coverage({ required: 7, enrolled: 7 })).toBe(100);
  });

  it("rounds a partial coverage to a whole percent", () => {
    expect(coverage({ required: 3, enrolled: 1 })).toBe(33);
    expect(coverage({ required: 8, enrolled: 7 })).toBe(88);
  });

  it("reads empty when nobody required has enrolled", () => {
    expect(coverage({ required: 4, enrolled: 0 })).toBe(0);
  });
});

describe("providerTone", () => {
  it("warns only on a provider that is live and cannot assert a second factor", () => {
    expect(providerTone({ enabled: true, mfaAsserted: false })).toBe("warning");
  });

  it("stays quiet on a live provider that does assert one", () => {
    expect(providerTone({ enabled: true, mfaAsserted: true })).toBe("success");
  });

  it("does not warn about a disabled provider — it cannot sign anyone in", () => {
    expect(providerTone({ enabled: false, mfaAsserted: false })).toBe("neutral");
    expect(providerTone({ enabled: false, mfaAsserted: true })).toBe("neutral");
  });
});

describe("securityLede", () => {
  const l = labelsIn("en");

  it("reports the coverage gap when it can name it", () => {
    const posture = { mfa: { required: 8, enrolled: 7, gaps: [{}], gapsWithheld: false }, sso: { gaps: [] } } as never;
    expect(securityLede(posture, l)).toBe("1 people still need a second factor (88% coverage).");
  });

  it("defers to the withheld notice when it cannot name the gap", () => {
    const posture = { mfa: { required: 8, enrolled: 7, gaps: [], gapsWithheld: true }, sso: { gaps: [] } } as never;
    expect(securityLede(posture, l)).toBe(LABELS.en?.gapsWithheld);
  });

  it("falls to the SSO gap once the second-factor floor is met", () => {
    const posture = { mfa: { required: 3, enrolled: 3, gaps: [], gapsWithheld: false }, sso: { gaps: [{}] } } as never;
    expect(securityLede(posture, l)).toBe("1 sign-in provider let people in without asserting a second factor.");
  });

  it("reads all-clear when nothing is outstanding", () => {
    const posture = { mfa: { required: 0, enrolled: 0, gaps: [], gapsWithheld: false }, sso: { gaps: [] } } as never;
    expect(securityLede(posture, l)).toBe(LABELS.en?.introClear);
  });
});

describe("labelsIn", () => {
  it("has the same keys in both locales", () => {
    expect(Object.keys(LABELS.ar!).sort()).toEqual(Object.keys(LABELS.en!).sort());
  });

  it("never leaves an Arabic value empty or copied from the English", () => {
    for (const [key, english] of Object.entries(LABELS.en!)) {
      const arabic = LABELS.ar![key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(english);
    }
  });

  it("interpolates the unit into a measurement", () => {
    expect(labelsIn("en")("hours", { n: "12" })).toBe("12 hours");
    expect(labelsIn("en")("attempts", { n: "8" })).toBe("8 attempts");
    expect(labelsIn("ar")("hours", { n: "12" })).toContain("12");
  });

  it("falls back to the English table for an unknown locale", () => {
    expect(labelsIn("fr")("title")).toBe(LABELS.en!.title);
  });
});

// The people-outside-the-floor table printed `orbit.partners` under ROLES and
// `password` under SIGN-IN METHOD — the grant key and the database column, at
// an administrator deciding who to chase.
describe("what the gaps table says about a person", () => {
  const l = labelsIn("en");

  it("names a role the way the org chart does", () => {
    expect(roleName("orbit.partners", { "orbit.partners": "Partner manager" })).toBe("Partner manager");
  });

  it("still reads as words for a role nobody renamed", () => {
    expect(roleName("orbit.partners", {})).toBe("Orbit partners");
  });

  it("says how someone signs in", () => {
    expect(signInMethod("password", l)).toBe("Password");
    expect(signInMethod("oidc", l)).toBe("Single sign-on");
  });

  it("says something readable for a method nobody spelled", () => {
    expect(signInMethod("webauthn", l)).toBe("Webauthn");
  });
});
