# ADR-0087 — A tenant can switch a module off

Date: 2026-09-23 · Status: accepted

## Context

`PATCH /v1/core/modules/:module/config` stored `enabled`, `autonomy` and
`modelTier` per module, and `moduleSettings()` resolved them, but nothing read
`enabled` (docs/27, 2026-09-23; docs/30 §0). A tenant therefore could not run
LYRA with a module off: its routes answered, its screens rendered, its nav entry
stayed. The only real module gate was the licence — `entitledGrants`
(packages/core/src/entitlements.ts), which subtracts an unlicensed module's
permissions from every actor at authentication, so its routes refuse and the
`/v1/me` nav, built from permissions, drops it.

## Decision

`enabled: false` goes through **that same subtraction**. `entitledGrants` takes
the tenant's `policy.moduleConfig` beside its entitlements, and a gated module
(`axis`, `orbit`, `signal`, `scout`, `north`) that is unlicensed **or** switched
off loses its permissions for every session and API key. One mechanism answers
both "was it bought" and "is it on", so a switched-off module refuses its API,
disappears from the rail and the module switcher, and its shell screens refuse —
with no second gate to drift from the first.

Core is never gated, so the tenant administrator who switched a module off can
switch it back (`/admin/automation`, "Modules switched on"). Only licensed
modules are offered there; an unlicensed one is off by entitlement, not by
choice.

## Consequences

- Scheduled sweeps and event consumers still run for a switched-off module's
  tables. They read and write data nobody can see until it is switched back on;
  stopping them per module is the next step (docs/30 §3, item 2).
- `autonomy` and `modelTier` in `moduleConfig` are still read by nothing and are
  not offered in the UI (docs/27).
- Cross-module features that write another module's tables directly (ORBIT →
  `axis_cases`, SCOUT → `signal_campaigns`) do not yet ask whether the other
  module is on (docs/30, ORBIT gap 5).
