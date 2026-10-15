# ADR-0122 — A modelled observation is a signal of its own kind

**Status:** accepted (2026-10-01)
**Supersedes:** nothing. **Amends:** ADR-0078 (the signal-source seam), ADR-0118 (Aletheia as a
grounded provider).
**Touches:** `SIGNAL_SOURCE_KINDS`, `packages/db/src/schema/scout.ts`, `apps/api/src/engines/aletheia-sentinel.ts`,
`apps/api/src/engines/scout-ingest.ts`, `apps/api/src/index.ts`.

## Context

docs/27 F51 and docs/30 recorded the SCOUT sentinel as absent. What was absent, when read closely,
was two different things.

The first half exists and is right: `scout-watch.ts` compares a window of `scout_signals` to the window
before it and notifies the SCOUT leads about what moved. Its own header is honest about its limit —
it is a *read*, it persists nothing, and a finding it raises tonight cannot be told apart from the same
finding tomorrow, because a window scored against the window before it is a derivation rather than a
record.

The second half does not exist: nothing can say whether a value is **out of band for a business this
size**. The watch's only baseline is the tenant's own recent history, so a motor panel winning 12% of
its quotes reads as "12%, same as last month" to the watch and as a serious underperformance to
anybody who knows the band.

Aletheia has exactly that baseline — per business function, per KPI, by size band
(`cortex0/insights.py`, `FindingsEngine`). Its own coverage already names 19 industries and 19 business
models, and **neither is the business this platform is being deployed into**: the `insurance` industry
it ships describes a *carrier* (combined ratio, solvency), while YallaCompare is a *distributor*
(panel win rate, commission per policy, renewal retention). So the domain pack was missing too, and
without it Aletheia's only answer for this tenant would have been a carrier's answer.

## Decision

**1. `model` is a signal source kind.** Aletheia's findings enter SCOUT as `scout_signals` rows with
`source: "model"` and `sourceRef: "aletheia:<finding id>"`. They are not filed under `news`: a
modelled reading is an observation *about* the market, not a report somebody published, and the
Clusterer weighting a press release the same as an out-of-band reading is precisely the confusion the
source dimension exists to prevent.

Reusing `scout_signals` rather than opening a parallel table is the point of the decision. The
Clusterer, the whitespace candidates, the Bench Builder and the watch all read that one table, so an
Aletheia finding becomes a first-class market observation the day it lands — and the dedupe the
harvester already performs on `(source, sourceRef)` is what makes the nightly run idempotent instead
of a second copy.

**2. The adapter maps, it does not invent.** `ALETHEIA_METRIC_MAP` names, for each LYRA figure, a
business function and a KPI that Aletheia's `BUSINESS_FUNCTIONS` actually defines. This matters
because `kpi_findings` **skips a KPI it does not know** (`insights.py:126-128`), so an invented name
returns a confident empty answer rather than an error. The map is small for the same reason: a mapping
that covers four KPIs honestly is worth more than one that covers twenty and is wrong about twelve.
Money crosses the boundary in currency units, not LYRA's minor units, because a benchmark in major
units scored against minor units reads as a hundredfold overrun.

**3. A metric that was not measured is not sent.** `marketMetrics` omits a missing figure rather than
defaulting it to zero, because to a benchmark engine a fabricated zero is a real, extreme reading — a
CAC of zero is the best CAC there is.

**4. Gated and non-fatal.** The sentinel stands down with `no-endpoint` when `ALETHEIA_URL` is unset,
and names a transport or HTTP failure in `errors` rather than throwing, so a deployed Aletheia that is
down costs a night's findings and not the nightly tick.

**5. The insurance-distribution domain pack.**
`cortex0/business.py` gains the `insurance_distribution` industry (12 KPIs), the matching
`BusinessModel`, `cortex0/dynamic_rules.py` gains 10 causal edges, and the pack is held by tests that
would have caught what it found: an industry **naming a KPI nobody defines** is a silent hole in the
framework, and adding the pack surfaced three such holes that already existed — `manufacturing_industrial`
referencing a signal `energy_price` that no signal defines, `fmcg` listing the KPI `brand_equity` among
its *theories*, and `agriculture_food` doing the same with the signal `commodity_price` in its KPI slot.

## Consequences

- Aletheia's findings are weighted by severity (`neg` 5 → `pos` 1) rather than by a made-up magnitude,
  so a negative finding moves the Clusterer more than a positive one without pretending to a precision
  the finding does not carry.
- `POST /v1/scout/feed` now accepts `model` among its source kinds, since it validates against
  `SIGNAL_SOURCE_KINDS`. An integrator may therefore hand-post a modelled observation; that is
  consistent with the seam rather than a leak through it.
- The pack raises Aletheia's coverage from 19 to 20 industries and from 19 to 20 business models, and
  the knowledge platform's source count from 142 to 156. The one test that asserted 142 was updated
  with the reason written beside it.
- `source: "model"` is now a value a stored row can hold. A reader that switches exhaustively on
  source kinds without a default will fail loudly on it, which is the intended outcome.

## Alternatives considered

**Post the metrics and act on the HTTP status.** Rejected: Aletheia answers 200 with
`findings: []` for metrics it cannot place, so status tells you nothing about whether the question was
understood. The adapter records `asked` next to `findings` for exactly that reason.

**Have the sentinel call `/reason` instead of `/insights`.** `/reason` evaluates Aletheia's generated
rules over *its own* facts and returns anomalies and causal risks; `/insights` takes a caller's metrics
and scores them against size-band benchmarks. Only the latter answers "is this out of band for a
business our size", which is the question the watch cannot answer.

**A dedicated `scout_findings` table.** Rejected: it would need its own clustering, weighting and
whitespace path, and the second pipeline would drift from the first within a release.
