import { describe, expect, it } from "vitest";
import { appendDisclosure, checkDisclosure, preflightCreative, type MandatoryDisclosure } from "./signal-compliance.js";

// docs/17 SIG-013 / SIG-015, ADR-0108. The wording is fixture wording: the
// tenant's compliance team supplies the real text (CLAUDE.md guardrail — we
// never write regulatory copy), so nothing here asserts on what it says, only
// on whether it is there verbatim.

const WORDING = "FIXTURE-DISCLOSURE: tenant-supplied wording v3.";
const disclosure: MandatoryDisclosure = {
  id: "dwd_1",
  version: 3,
  key: "motor_ad",
  productLine: "motor",
  locale: "en",
  wording: WORDING
};
const scoped = { productLine: "motor", disclosure, tenantConfigured: true };

describe("appendDisclosure", () => {
  it("appends the wording verbatim after the copy", () => {
    expect(appendDisclosure("Cover in minutes.", disclosure)).toBe(`Cover in minutes.\n\n${WORDING}`);
  });

  it("does not append a second copy when the wording is already there", () => {
    const once = appendDisclosure("Cover in minutes.", disclosure);
    expect(appendDisclosure(once, disclosure)).toBe(once);
  });

  it("leaves the copy alone when no disclosure applies", () => {
    expect(appendDisclosure("Cover in minutes.", null)).toBe("Cover in minutes.");
  });
});

describe("checkDisclosure", () => {
  it("clears copy that carries the configured wording verbatim", () => {
    expect(checkDisclosure(`Cover in minutes.\n\n${WORDING}`, scoped)).toEqual({
      lane: "clear",
      reason: null,
      disclosure: { id: "dwd_1", version: 3, key: "motor_ad" }
    });
  });

  it("hard-blocks copy missing the configured wording", () => {
    expect(checkDisclosure("Cover in minutes.", scoped)).toEqual({
      lane: "hard_block",
      reason: "disclosure_missing",
      disclosure: { id: "dwd_1", version: 3, key: "motor_ad" }
    });
  });

  it("hard-blocks a paraphrase: verbatim means verbatim", () => {
    expect(checkDisclosure("Cover in minutes. fixture-disclosure: tenant-supplied wording v3", scoped).lane).toBe(
      "hard_block"
    );
  });

  it("soft-flags a product line with no disclosure configured (ADR-0108: a human affirms none is required)", () => {
    expect(checkDisclosure("Cover in minutes.", { productLine: "travel", disclosure: null, tenantConfigured: true })).toEqual({
      lane: "soft_flag",
      reason: "disclosure_unconfigured",
      disclosure: null
    });
  });

  it("soft-flags a creative with no product line once the tenant configures any disclosure", () => {
    expect(checkDisclosure("Cover in minutes.", { productLine: null, disclosure: null, tenantConfigured: true })).toEqual({
      lane: "soft_flag",
      reason: "disclosure_unscoped",
      disclosure: null
    });
  });

  it("has no lane for an unscoped creative of a tenant with no disclosure configured at all", () => {
    expect(checkDisclosure("Cover in minutes.", { productLine: null, disclosure: null, tenantConfigured: false })).toEqual({
      lane: "clear",
      reason: null,
      disclosure: null
    });
  });
});

describe("preflightCreative", () => {
  it("passes clean copy carrying its disclosure", () => {
    const r = preflightCreative(`Cover in minutes.\n\n${WORDING}`, scoped);
    expect(r.status).toBe("passed");
    expect(r.lane).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.disclosure).toEqual({ id: "dwd_1", version: 3, key: "motor_ad" });
  });

  it("blocks — not flags — a missing disclosure, even when a banned claim is also present", () => {
    const r = preflightCreative("The cheapest cover.", scoped);
    expect(r.status).toBe("blocked");
    expect(r.lane).toBe("hard_block");
    expect(r.findings.map((f) => f.rule)).toEqual(["comparison_claim_requires_source", "disclosure_missing"]);
  });

  it("flags an unconfigured product line into the human review lane", () => {
    const r = preflightCreative("Cover in minutes.", { productLine: "travel", disclosure: null, tenantConfigured: true });
    expect(r.status).toBe("flagged");
    expect(r.lane).toBe("soft_flag");
    expect(r.findings.map((f) => f.rule)).toEqual(["disclosure_unconfigured"]);
  });

  it("keeps the banned-claim soft flag when the disclosure is present", () => {
    const r = preflightCreative(`The cheapest cover.\n\n${WORDING}`, scoped);
    expect(r.status).toBe("flagged");
    expect(r.lane).toBe("soft_flag");
  });
});
