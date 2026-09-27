# ADR-0101 — SCOUT's first external source (RSS/Atom) and selling a data product

**Date:** 2026-09-27
**Status:** Accepted
**Builds on:** ADR-0078 (external signal sources are proposed one at a time),
docs/modules/scout.md §2.1 and §2.5, docs/19 §4.9 and §5.2 F, CLAUDE.md §4 and §12
**Closes:** docs/30-module-review.md SCOUT items 1 and 2

## Context

docs/30 recorded two SCOUT gaps. `subscribeToDataProduct` and
`deliverDataProduct` (`apps/api/src/engines/billing.ts`) had been built and
tested and nothing called them — no route, no screen, so a data product could
be defined and published and never sold. And ADR-0078 named a news/regulatory
RSS reader as the first external adapter to propose, on the grounds that a
publisher's own feed is offered for reading, carries no personal data by
construction and needs no vendor contract — but left it unaccepted.

## Decision

### 1. The RSS/Atom reader is accepted, on these terms

`apps/api/src/engines/scout-rss.ts`, registered by `sourcesFor` as
`external.rss` (`external: true`) only for a tenant that configured a feed.

- **Vendor.** None. The tenant names the publishers; LYRA contracts with no one.
  docs/02 §9 is not widened: a feed is a public document, not a service.
- **Where it is configured.** `moduleConfig.scout.settings.rssFeeds` — a list of
  URLs or `{url, kind: "news" | "regulatory"}` — through `moduleSettings`, the
  seam every per-module knob uses, edited with the existing module-config
  endpoint. No credential is supported, so none needs to live anywhere.
- **What may enter.** https only; no user-info in the URL; no IP literal,
  single-label host or private suffix (`.local`, `.internal`, …). At most 20
  feeds, 1 MB and 100 items per feed. The parser accepts no DTD: any
  `<!DOCTYPE` or `<!ENTITY` refuses the whole feed, and only the five predefined
  entities and numeric references are decoded, so nothing can expand. From each
  item it keeps title, link, guid and date; a news item also keeps a 500-character
  excerpt with markup stripped; a regulatory item keeps no excerpt (what it says
  is counsel's to read — docs/12 — and it is recorded `state: "unread"`, as the
  seed already models). Author and byline are never read.
- **What may leave.** One `GET` per feed per harvest, with a generic user-agent
  and an `Accept` header — no cookie, no credential, no tenant identifier, no
  body. Redirects are not followed (a 3xx is a failed feed), so the request
  goes only where the tenant pointed it.
- **Politeness and robots.** The nightly harvest is the only scheduled caller,
  so a feed is read once a night plus whenever a person presses harvest. The
  reader never follows an item's link, so it is not a crawler and does not
  consult `robots.txt`; a feed is the publisher's own syndication offer.
- **Failure.** One feed failing is logged and costs that feed only; the
  source-health panel shows the silence.
- **Dedupe.** Through the one harvest write path, keyed
  `rss:<host>/<guid | link | title>`, so a re-run records nothing twice.

Search-trend connectors, review scraping and competitor page monitors remain
refused until their own decision, as ADR-0078 says.

### 2. Selling a data product is two routes over the existing billing engine

- `POST /v1/scout/data-products/{id}/subscribe` `{providerId, feeMinor}` — the
  contract. The fee per delivery is recorded on the subscriber entry, so the
  price is approved once, here, under a new policy
  `scout.data_product_subscribe` (decider `scout:data_products:publish`, dual
  control at or above 10,000.00 in the tenant currency, auto-approvable by a
  tenant allowlist like any non-payout policy). It posts `DPROD-SUB` (⊘) and
  audits the consent basis. Subscribing a current subscriber re-prices them and
  keeps the day they joined.
- `POST /v1/scout/data-products/{id}/deliver` `{providerId}` — executes the
  contract. It builds the cut the product's definition names, lets the
  existing `DPROD-DELIVER` precondition refuse it when the smallest delivered
  cell is under the floor, bills the subscribed fee through the existing
  `SUB-INVOICE`/`SUB-RECOG` legs (income 4060), and writes the artefact to the
  export register with `subject_ref = scout_data_product:<id>` — the key the
  screen's delivery log already filtered on (and that `GET
  /v1/analytics/exports` ignored until now). No second approval: the
  subscription is the standing authorisation, as a subscription invoice run is.

Both require an `Idempotency-Key` and the publish permission. The cut:

- one builder, `source: "dist_quote_requests"`, with an optional `line`; a
  product over any other source is refused by name rather than delivered as
  something it does not define;
- windows `trailing_<n>_day|month`; measures `requests`, `bindRateBps`,
  `medianQuotedPremiumMinor`; dimensions read from the request's normalised
  inputs, anything missing or non-scalar grouped as `unknown`;
- a product whose consent basis starts `consent:` reads only requests carrying a
  recorded consent;
- every cell under the higher of the product's floor and the module's is
  dropped whole and only counted — suppressed, not rounded.

A subscription written before fees were recorded (the seeded ones) has no fee,
and delivery refuses it rather than invent a price; subscribing again sets one.

## Consequences

- The billing functions have a caller, and the data-products screen can add a
  subscriber and deliver to one; both refusals (approval queue, thin cut) come
  back as the API's own problem.
- The admin screen says external fetching is on when it is, instead of a notice
  that no source leaves.
- `delivery: "report"` and `"api"` produce the same JSON cut in the register;
  a rendered report format is a later choice, not assumed here.
- Builders for `scout_panel_bench` and `dist_quote_responses` products are not
  written; those products refuse delivery with a named reason.
