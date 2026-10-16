// docs/12-security-compliance.md §5 is a **control → evidence** map, and it ends
// by claiming something that was not true:
//
//   "NORTH surfaces a live 'Compliance posture' tile for tenant.compliance from
//    these signals."
//
// There was no such tile — the only "posture" in the tree was a security one
// (MFA/SSO enrolment) on /admin/security. This is the map, made computable.
//
// The design rule that matters, and the reason this is not a list of seven green
// ticks: **two kinds of evidence are not the same kind of thing.** A number the
// platform can count right now is live. A runbook and drill minutes are
// documents on file — real evidence, and not something a query can verify. A
// tile that painted both the same colour would be claiming to have checked
// something it never read, which is the exact failure this register keeps
// finding. So every row says which kind it is, and a control nothing can attest
// to says so instead of glowing.

/** Which of §5's controls a reader is looking at, and where its evidence lives. */
export type PostureEvidence = "live" | "on_file" | "unattested";

export interface PostureControl {
  /** Stable key; the UI labels it, never the wire. */
  key: PostureControlKey;
  evidence: PostureEvidence;
  /** A figure or short fact, already formatted for reading. Never a promise. */
  value: string;
  /** Where the evidence is, so a sceptic can go and look. */
  source: string;
}

export type PostureControlKey =
  | "tenancy_isolation"
  | "consent_enforcement"
  | "disclosure"
  | "ai_logging"
  | "verification"
  | "breach"
  | "retention";

/** What the platform can actually count, at the moment the tile is read. */
export interface PostureInputs {
  /** Customers holding a consent record — consent is enforced at the boundary. */
  consentRows: number;
  /** Rows in the AI audit trail: logging is on, and it is not empty. */
  aiAuditRows: number;
  /** Disclosure presentations recorded (docs/19: presenting is the auditable act). */
  disclosures: number;
  /**
   * Briefings published. Every one passed the grounding gate on the way out,
   * but a briefing the narrator never grounded reads as ungrounded
   * (`north-grounding.test.ts`), so this counts briefings rather than claiming
   * each of their claims was verified.
   */
  briefings: number;
  /** The tenant's retention cadence, or "never" — `never` is a choice, not a fault. */
  retentionCadence: string;
  /** The last time retention actually purged, or null if it never has. */
  lastPurgedAt: number | null;
  /** Whether a real screening provider is configured rather than the stub. */
  screeningConfigured: boolean;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/**
 * §5's seven controls, each with the strongest evidence the platform can produce.
 *
 * Order is §5's order, so a reader comparing the tile with the doc is not
 * re-reading a table to find their place.
 */
export function buildCompliancePosture(input: PostureInputs): PostureControl[] {
  const controls: PostureControl[] = [
    {
      key: "tenancy_isolation",
      // The evidence §5 names is a CI test report — a document, and the guards
      // it describes run in the build rather than in this tenant's data.
      evidence: "on_file",
      value: "Enforced by the tenant guard on every query",
      source: "docs/12 §1; CI report"
    },
    {
      key: "consent_enforcement",
      evidence: "live",
      value: plural(input.consentRows, "customer with a consent record", "customers with a consent record"),
      source: "core_consents; suppression propagation test"
    },
    {
      key: "disclosure",
      evidence: "live",
      value: plural(input.disclosures, "disclosure presented", "disclosures presented"),
      source: "compliance disclosures; ranking snapshots"
    },
    {
      key: "ai_logging",
      evidence: "live",
      value: plural(input.aiAuditRows, "AI run logged", "AI runs logged"),
      source: "ai_audit; exportable"
    },
    {
      key: "verification",
      evidence: "live",
      value: plural(input.briefings, "briefing published", "briefings published"),
      source: "north briefings; grounding gate"
    },
    {
      key: "breach",
      // A runbook and drill minutes cannot be counted. Saying so is the honest
      // row; a green tick here would attest to a document nothing read.
      evidence: "on_file",
      value: "Runbook written; drill minutes on file",
      source: "docs/12 §5; incident runbook"
    },
    {
      key: "retention",
      // `never` is the default and it is a *decision* the tenant makes, not a
      // failure — so it reads as the choice it is, and the last purge is only
      // claimed when there has been one.
      evidence: "live",
      value:
        input.retentionCadence === "never"
          ? "Scheduled purges are off — the tenant has not set a cadence"
          : input.lastPurgedAt === null
            ? `Cadence ${input.retentionCadence}; nothing purged yet`
            : `Cadence ${input.retentionCadence}; last purge ${new Date(input.lastPurgedAt).toISOString().slice(0, 10)}`,
      source: "compliance_retention runs; policy.retention.schedule"
    }
  ];
  return controls.map((control) =>
    // Screening is the one control whose *provider* can be a stub. §5 does not
    // list it, and it is folded into disclosure rather than given a row of its
    // own — but a stub provider is worth saying out loud on a posture a
    // compliance officer reads, so it downgrades nothing and appears in the
    // source line.
    control.key === "disclosure" && !input.screeningConfigured
      ? { ...control, source: `${control.source}; screening runs a labelled stub` }
      : control
  );
}
