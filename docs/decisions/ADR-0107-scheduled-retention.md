# ADR-0107 — Scheduled retention, off unless a tenant chooses a cadence

Date: 2026-09-27 · Status: accepted

## Context

docs/30 Compliance 5: retention ran only when a compliance officer pressed
`POST /v1/compliance/retention/run`, and only for `messages`. docs/12 §3 and
docs/03 §Retention & residency name four record classes: conversations (24m),
files (7y for policy documents), `ai_audit_log` (7y) and consent (indefinite).
`policy_json.retention` already carried `filesYears` and `aiAuditYears`, and
nothing read them.

## Decision

1. **One engine, two doors.** `apps/api/src/engines/compliance-retention.ts`
   holds the classes, their floors, the legal-hold check and the purge. The
   route and the nightly sweep both call `runRetention`, so they cannot
   disagree about a cutoff or a hold.
2. **Classes.** The cutoff is the later of the floor and the tenant's policy.
   - `messages` (`orbit_messages`): floor 24m, `messagesMonths`. It is hard
     deleted. The conversation row stays, because QA scores, handovers and
     deflections are keyed on it.
   - `files` (`core_files`): floor 84m, `filesYears`. The R2 object is
     deleted and the row is tombstoned with `deleted_at`, the platform's soft
     delete. Without a bound object store the class refuses: a tombstone over
     a live object would record an erasure that did not happen.
   - `ai_audit` (`ai_audit_log`): floor 84m, `aiAuditYears`. It is hard
     deleted. This log is kept for seven years, not forever, and it is not the
     hash-chained `core_audit_log`, which is never purged.
   - `consent` is kept indefinitely, so it is not a class and a request naming
     it is a 400.
3. **Holds.** An open hold freezes any row it names. A hold can name the
   record (`file:<id>`), its subject (`policy:<id>`, `claim:<id>`,
   `conversation:<id>`) or the customer; a customer hold reaches every one of
   that customer's conversations.
4. **Cadence.** `policy_json.retention.schedule` is one of `never | daily |
   weekly | monthly`, and the default is **`never`**. A purge is irreversible
   and needs no approval (ADR-0002). A tenant that never configured retention
   has not asked for one, so the clock deletes nothing until the tenant sets a
   cadence through the tenant policy. The manual run is unchanged.
5. **The sweep.** It runs in the nightly window after the backup, so that
   night's copy still holds what the sweep removes. A class is due when its
   last *successful* run is a cadence ago, less an hour of slack for tick
   drift. It then runs batch after batch while more remains (at most 20
   batches). Each batch writes its own `compliance_retention_runs` row and
   `compliance.retention.run` audit entry. A class that throws is recorded as
   a `failed` run (`compliance.retention.failed`) and the other classes still
   run. A failed run does not count toward the cadence, so the next night
   tries again.

## Consequences

- No tenant loses data on deploy. Each tenant opts in by setting
  `retention.schedule`.
- There is no settings screen for the cadence yet. It is set through the
  tenant policy (`PATCH /v1/core/tenants/:id`).
- The erasure-completeness job (PLAT-038) is still separate. File retention
  removes the object and the row's reachability. It does not reach copies in
  exports or backups, which age out on their own lifecycle (docs/10 §6).
