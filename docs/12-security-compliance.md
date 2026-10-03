# 12 — Security, Privacy & AI Governance

This document is engineering-facing. Legal copy and regulatory positions must
be confirmed by counsel; nothing here is legal advice. Target regimes: UAE
PDPL (45/2021 + Exec Regs 33/2024), CBUAE Insurance Brokers' Regulation
(2025) and related e-insurance/telemarketing rules; extensible rulepacks for
KSA (PDPL/SAMA) and Egypt (151/2020, FRA).

## 1. Security baseline

- AuthN per docs/04 §2; MFA mandatory for staff; session binding to device;
  admin surfaces behind Cloudflare Access / OIDC forward-auth.
- Encryption: TLS 1.2+ everywhere; at rest via platform (D1/R2/KV) and
  disk-encryption prereq on-prem; field-level encryption (libsodium sealed
  boxes, key in secret store) for national IDs and bank details; PANs never
  stored (PSP tokenization only).
- Secrets: wrangler secrets / Docker env from vault; 90-day rotation policy;
  no secrets in code, logs, or AI prompts (prompt-scrubber test in CI).
- Input handling: zod at every boundary; SSRF-safe fetch wrapper (connector
  framework allowlists hosts); file uploads AV-scanned (on-prem: clamav
  sidecar; cloud: scan worker) and content-type sniffed.
- Tenant isolation: `withTenant` enforced by lint rule + runtime guard;
  cross-tenant test suite in CI; dedicated-D1 for enterprise.
- Audit: `core_audit_log` + `ai_audit_log` append-only; hash-chained daily
  anchors stored to R2 EXPORTS for tamper evidence.
- Vulnerability management: dep audit weekly; image scanning; responsible-
  disclosure page; pen test before GA and annually.
  Advisories with no patched release are ignored in `pnpm.auditConfig`
  only when no production tree (api, web, workers) reaches them, each
  re-checked when a patch ships: GHSA-86w9-cpqp-85rv (node-forge) and
  GHSA-vfj7-8cjw-p6xm (braces), both reached only through Expo's developer
  CLI under apps/mobile (2026-10-03).

## 2. Privacy engineering (PDPL-aligned)

- **Consent as infrastructure:** `core_consents` immutable ledger; every
  outbound send, profiling job, audience build, and data-product aggregate
  checks purposes at runtime (not at design time only). Consent withdrawal
  propagates < 15 min (event `core.consent.updated` → suppression everywhere).
- Purpose limitation: model-gateway requires `purpose`; purposes map to
  consent categories; mismatches are hard errors.
- Minimisation: PII masked by default in UIs (reveal = permission + audit);
  AI prompts receive minimum necessary fields (context builders whitelist
  fields per purpose).
- Rights: access/erasure/portability workflows (J-C4) with SLA tracking;
  erasure = hard delete + tombstone + downstream purge (vectors, caches,
  exports) — verified by an erasure-completeness job.
- Breach readiness: incident runbook with 72-hour notification checklist,
  contact tree, evidence preservation steps; tabletop exercise quarterly.
- Cross-border: tenant `data_residency` policy gates provider selection
  (e.g., force on-prem/in-region model tier), file storage region hints,
  and blocks non-compliant connectors with a clear admin explanation.
- DPO support: consent registry search, processing-activity register export
  (generated from the purposes map), DPIA template pack in /docs/legal (stub).

## 3. Broker-regulation controls (CBUAE-oriented feature set)

- Disclosure logging: every customer-facing quote ranking carries the declared
  criteria snapshot; telemarketing rules encoded as journey guardrails (quiet
  hours, contact frequency, opt-out honoring) that cannot be configured below
  regulatory floors.
- Client-money support: AXIS escrow reconciliation with evidence bundles.
- Record-keeping: retention policies per record class (policy docs 7y default,
  conversations 24m default — tenant-tunable above floors).
- Conduct: FNOL guidance scripts are informational; claims decisions are
  explicitly out of scope (UI copy enforced from this doc's phrasing).
- Audit-on-demand: signed export bundles (PDF + JSONL + hash manifest).

## 4. AI governance

- **Human accountability:** consequential actions (registry-flagged) require
  approval unless tenant-allowlisted; the allowlist itself requires
  tenant.compliance sign-off and is audit-logged.
- **Disclosure:** AI interlocutors identify as AI on first contact per
  conversation and on request; ✦AgentBadge marks AI-generated artifacts.
- **Traceability:** every model call logged (docs/03 ai_audit_log); briefs
  and reports carry generation metadata; evidence links resolve to source
  queries.
- **Verification:** NORTH's number-verification gate (docs/modules/north §2.2)
  is a platform pattern — any numeric claim in generated prose must match a
  structured source or the artifact fails closed.
- **Evaluation:** packages/model-gateway/evals — golden sets per task
  (extraction ar/en, CX quality ar/en, compliance classifier, brief accuracy);
  thresholds gate provider/model changes; drift monitors sample production
  weekly; Arabic/English parity is a tracked metric, not an aspiration.
- **Bias & fairness:** pricing-adjacent models (churn, LTV, bind-probability)
  exclude protected attributes; proxy audits quarterly; findings logged with
  remediation owners.
- **Red-teaming:** prompt-injection suite runs in CI against agent tools
  (tool-call escapes, exfil attempts, jailbreak library); connectors treat all
  external content as untrusted data, never instructions.
- **Kill switches:** per-agent, per-module, per-tenant, global — all one
  click, all logged, all tested monthly.

## 5. Compliance evidence map (for audits & the pitch)

Control → evidence: tenancy isolation → CI test report; consent enforcement →
suppression propagation test; disclosure → ranking snapshots; AI logging →
ai_audit_log export; verification → brief gate test results; breach → runbook
+ drill minutes; retention → policy config + purge job logs. NORTH surfaces a
live "Compliance posture" tile for tenant.compliance from these signals.
