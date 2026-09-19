# ADR-0078 — SCOUT's external signal sources are proposed, not integrated

**Date:** 2026-09-19
**Status:** Proposed
**Builds on:** docs/02 §9 (approved third-party services), docs/02 §11 and
docs/16 (extension seams), ADR-0018 (seams declared before they are built),
docs/20 (self-sufficiency: platform APIs are channels, management suites are not)
**Relates to:** docs/27-feature-gap-register.md F51/F52

## Context

docs/modules/scout.md §2.1 names six signal sources. Three are internal —
quote requests, funnel abandonment, ORBIT conversation themes — and three are
not: search-trend connectors, app/review scraping via Browser Rendering, and
news/regulatory RSS with competitor page monitors. §5 names a connector
framework with built-ins (RSS, sitemap-diff, review sources, CSV/API ingest).

docs/27 F51 recorded that none of it existed: `scout_signals` was written only
by generic CRUD, `scout_clusters` and `scout_panel_bench` held seed rows, and
nothing watched a competitor or a regulator. The engines that close the
internal half of F51 ship with this ADR (`apps/api/src/engines/scout-ingest.ts`,
`scout-cluster.ts`, `scout-bench.ts`, `scout-watch.ts`).

The external half cannot ship the same way. Every one of those three sources is
a call to a third party:

- a search-trend connector is a third-party API (Google Trends, a SERP vendor,
  a keyword-volume vendor);
- app/review scraping means fetching app-store and review-site pages, which
  carries robots, rate-limit, terms-of-service and copyright obligations that
  are decisions about the business, not about this codebase;
- a news/regulatory RSS feed is a third-party publisher, and a competitor page
  monitor is an unsolicited crawl of a named competitor.

docs/02 §9's list is Cloudflare, Anthropic via AI Gateway, Resend, Twilio or
Unifonic, Sentry and Stripe. None of these is on it, and CLAUDE.md's guardrails
say plainly that anything else requires an ADR. Adding one quietly inside a
gap-closing change would be exactly the move that guardrail exists to prevent —
and the compliance surface (robots, ToS, personal data in review text, the
regulator's own terms) is larger than the engineering.

## Decision

**No SCOUT source fetches from outside LYRA in this build.** What ships is the
seam and the internal half:

1. `SignalSource` is declared in `packages/core/src/seams.ts`, beside `Channel`,
   `DataInConnector`, `IdentityVerifier` and `ChannelAdapter` — the file docs/02
   §11 names as the home of extension seams. It has `id`, `kind`, an explicit
   `external: boolean`, and `harvest(window)`.
2. Three adapters implement it, all `external: false`:
   `internal.quotes` and `internal.abandonment` read rows this workspace already
   holds; `internal.feed` returns what an integrator posted to
   `POST /v1/scout/signals/harvest`. A pasted regulator circular, an analyst's
   competitor note or a CSV of review snippets therefore reaches the Clusterer
   and the watch through exactly the path a crawled item will.
3. The registry is a read — `GET /v1/scout/sources` — and `/scout/admin` renders
   it with each adapter marked internal or external, so "nothing fetches from
   outside" is a claim the screen makes and a reader can check, not a silence.
4. The Clusterer, the Bench Builder and the watch are built against the
   *persisted* corpus, not against any particular source. They do not know or
   care which adapter wrote a row.

**Proposed, pending acceptance:** one external adapter at a time, each with its
own decision recorded here or in a successor ADR, naming the vendor, the legal
basis for the fetch, the crawl-politeness and robots behaviour, where the
credentials live, and what personal data the payload may contain. The first
candidate is a news/regulatory RSS reader, because a publisher's own feed is
the narrowest of the three: it is offered for reading, it carries no personal
data by construction, and it needs no vendor contract.

## Consequences

- F51's ingestion, clustering, bench and watch gaps close on internal data;
  the "no source ingestion" half of it closes only for internally-fed signals,
  and docs/27 records that distinction rather than claiming the whole item.
- Adding a real source later is an adapter file plus one line in `sourcesFor`
  (`apps/api/src/engines/scout-ingest.ts`). No engine, route, table or screen
  changes — `external: true` already renders. That is the seam earning its
  keep, and it is why this ADR does not park F51 whole.
- A tenant whose Radar is thin because it has no external demand data sees why:
  the source-health panel reports quiet sources and the registry says nothing
  external is registered.
- The k-anonymity floor, the audit log and the tenant scope apply to fed signals
  exactly as to harvested ones — there is one write path.
