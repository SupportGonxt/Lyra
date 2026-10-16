import { describe, expect, it } from "vitest";
import { buildCompliancePosture, type PostureControlKey, type PostureInputs } from "./compliance-posture.js";

// docs/12 §5's control → evidence map, made computable. The register's own
// lesson is that a surface claiming more than it can attest to is the expensive
// kind of wrong, so most of these tests are about what the tile *refuses* to say.

const base: PostureInputs = {
  consentRows: 1284,
  aiAuditRows: 9021,
  disclosures: 47,
  briefings: 12,
  retentionCadence: "monthly",
  lastPurgedAt: Date.UTC(2026, 8, 1),
  screeningConfigured: true
};

const byKey = (rows: ReturnType<typeof buildCompliancePosture>) =>
  Object.fromEntries(rows.map((row) => [row.key, row])) as Record<PostureControlKey, (typeof rows)[number]>;

describe("buildCompliancePosture", () => {
  it("covers every control docs/12 §5 names, in the order §5 lists them", () => {
    // A missing control is a silently narrowed posture, which is the failure
    // mode this whole module exists to avoid.
    expect(buildCompliancePosture(base).map((row) => row.key)).toEqual([
      "tenancy_isolation",
      "consent_enforcement",
      "disclosure",
      "ai_logging",
      "verification",
      "breach",
      "retention"
    ]);
  });

  it("says which evidence is live and which is a document on file", () => {
    const rows = byKey(buildCompliancePosture(base));
    expect(rows.tenancy_isolation.evidence).toBe("on_file");
    expect(rows.breach.evidence).toBe("on_file");
    expect(rows.ai_logging.evidence).toBe("live");
    expect(rows.retention.evidence).toBe("live");
  });

  it("reports a counted figure for the controls it can count", () => {
    const rows = byKey(buildCompliancePosture(base));
    expect(rows.ai_logging.value).toContain("9,021");
    expect(rows.consent_enforcement.value).toContain("1,284");
    expect(rows.verification.value).toContain("12");
  });

  it("reads retention's default as the tenant's choice rather than a fault", () => {
    // `never` is the shipped default (ADR-0107) — a tenant that has not chosen a
    // cadence has not failed an audit, and a tile that reddened here would train
    // people to ignore it.
    const rows = byKey(buildCompliancePosture({ ...base, retentionCadence: "never", lastPurgedAt: null }));
    expect(rows.retention.value).toContain("off");
    // No date is claimed: "last purge" is what a reader would take as "this has
    // run", and it has not. (The bare word "purges" legitimately appears — it is
    // the feature being described as off.)
    expect(rows.retention.value).not.toContain("last purge");
  });

  it("claims a last purge only when there has been one", () => {
    const rows = byKey(buildCompliancePosture({ ...base, lastPurgedAt: null }));
    expect(rows.retention.value).toContain("nothing purged yet");
  });

  it("names the stub when no screening provider is configured", () => {
    // A compliance officer reading "disclosure" deserves to know the screen
    // behind it is not a real one.
    const rows = byKey(buildCompliancePosture({ ...base, screeningConfigured: false }));
    expect(rows.disclosure.source).toContain("stub");
    expect(byKey(buildCompliancePosture(base)).disclosure.source).not.toContain("stub");
  });

  it("never marks a control green on evidence it has not read", () => {
    // The whole point: only live signals may carry `live`. This holds even when
    // every countable input is zero — nothing here can turn a document into a
    // verified fact.
    const empty = buildCompliancePosture({
      consentRows: 0,
      aiAuditRows: 0,
      disclosures: 0,
      briefings: 0,
      retentionCadence: "never",
      lastPurgedAt: null,
      screeningConfigured: false
    });
    for (const row of empty) {
      expect(["live", "on_file"]).toContain(row.evidence);
      expect(row.source.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
    }
    expect(empty.filter((row) => row.evidence === "on_file")).toHaveLength(2);
  });
});
