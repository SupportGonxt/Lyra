# ADR-0112 — Value-based bidding signals go back through the ad-platform seam

Date: 2026-09-28 · Status: accepted

## Context

docs/17 SIG-032 asks for value-based bidding signals exported to connected ad
platforms, and docs/modules/signal.md §2.2 names "value-based bidding exports
to ad platforms (Google/Meta APIs via connectors)". ADR-0100 built the
`AdPlatform` seam (`@seam:H10`) and the Google Ads and Meta adapters on `ads`
connectors, and listed conversion upload as not built. Signed `lead`/`bind`
touches arrive on `/track` (ADR-0092), and `onBindIssued` writes a bind touch
for every attributed policy. Nothing sent a bind back, so the platforms could
only optimise on lead count. No click id was captured anywhere, so there was
nothing to match a bind on.

## Decision

1. **The seam grows one optional method.** `AdPlatform.uploadConversions(conversions,
   secrets, config)` answers `sent` or `failed` for each conversion. It sits
   beside two declarations: `conversionKeys`, the identifiers the platform
   matches on, and `conversionMaxAgeDays`, the oldest conversion it accepts.
   The method is optional, so an adapter without it receives nothing.
   `AdConversion` is a closed shape: conversion id (the bind touch id), time,
   value, currency, `gclid`, `fbclid`, `emailSha256`, `phoneSha256`. No other
   field exists on it, so no customer attribute can reach a bidder (SIG-034).
2. **Adapters.**
   - Google: `customers/{id}:uploadClickConversions` with `partialFailure:
     true`. It matches on `gclid` only, and the touch id is the `orderId`,
     which is Google's dedup key. A refused row is read from
     `partialFailureError` by index. The config needs `conversionActionId`.
     The window is 90 days. Enhanced conversions (hashed user data) are not
     implemented, so Google never receives a hash.
   - Meta: Conversions API `POST /{pixelId}/events`, with `event_id` as the
     touch id (Meta's dedup key) and `action_source: system_generated`.
     `user_data` holds only `fbc` (built as `fb.1.<ms>.<fbclid>`) and `em`/`ph`
     when supplied. `event_name` defaults to `Purchase`, and `config.conversionEvent`
     can change it. The config needs `pixelId`. The window is 7 days. Meta takes
     a batch whole or not at all, so a short acknowledgement marks the whole
     batch failed, and the next run offers it again.
   - Both adapters take `fetch` as a parameter, as the spend and budget calls
     already do. The token goes in the Authorization header, never in a URL.
3. **Click-id capture.** `signal_attribution_events` gains `gclid` and `fbclid`
   (migration `0044_touch_click_ids`, to be renumbered at integration).
   - Both `/track` bodies accept them: anonymous touches and signed lead/bind
     touches.
   - Values are held to URL-safe characters, at most 512 of them (`clickId`
     in core).
   - `onBindIssued` copies the click ids from the lead it credits. If the lead
     has none, it copies them from the newest touch by the same `anonId` that
     carried one.
4. **Value.** `moduleConfig.signal.settings.conversionValue` sets how a bind is
   valued:
   - `{basis: "commission"}` uses the `commissionMinor` of the policy that the
     bind's `subjectRef` names, in that policy's currency.
   - `{basis: "premium_rate", ratePpm}` uses the bind's value (the premium)
     × ratePpm / 1e6, in the touch's currency.
   - Unset or malformed means `none`, and the exporter **stands down
     entirely**: it reads no touch, makes no call and writes no row.
   - A bind whose basis gives no positive value is skipped as `no_value`.
5. **Consent.** A bind is sent only when its customer's current consent grants
   `marketing` (`currentConsent`; an expired row grants nothing).
   - A bind that names no customer has no consent to read, so it is skipped
     as `no_consent`.
   - Hashed email and phone are computed only when that consent also grants
     `dataSharing`. Email is trimmed and lower-cased. Phone is reduced to its
     digits. Both are SHA-256.
   - Of the identifiers, each platform receives only its own `conversionKeys`.
   - A bind left with none of them is skipped as `no_match_key`.
6. **Once per account.** `signal_conversion_exports` holds one row per (bind
   touch, connector), unique on `(tenant_id, touch_id, connector_id)`, with
   status, detail, value, currency, attempts, attempted_at and exported_at.
   - `sent` and `skipped` are final.
   - `failed` is offered again on the next run.
   - An account that cannot be reached (bad token, missing config) writes no
     rows. It is recorded as `signal.conversions.export_failed` in the audit
     log, and every bind is offered again next run.
   - A run that writes rows audits `signal.conversions.exported` with counts.
7. **When it runs.** It runs on the first scheduler tick of the UTC day,
   straight after the spend pull, and only where SIGNAL is on (the
   scheduler's `on("signal")` and the engine's own `moduleSettings` check). It
   can also be triggered on demand with `POST /v1/signal/conversions/export`
   (`signal:spend:write`, the same permission the spend pull takes).
   `GET /v1/signal/conversions/exports?status=&limit=` (`signal:attribution:read`)
   lists what happened to each bind.

## Consequences

- **The adapters are tested only against mocked `fetch` responses.** They
  follow the providers' documented request and response shapes. Neither has
  been run against a live Google Ads or Meta account.
- It is not an approval-gated action. Nothing about money or contract changes.
  What leaves the platform is governed by the consent checks above, and it is
  audited.
- Old binds that are already stored carry no click ids, so on Google only
  binds captured after this change can match. Meta can still match older
  binds that are within 7 days, through hashed identifiers, when consent
  allows.
- The storefront has to put `gclid`/`fbclid` from the landing URL on its
  `/track` touches. No web change is included here.
- Not built: Google enhanced conversions, conversion adjustments or
  restatements (for example a cancelled policy), TikTok, predicted-value
  bidding from a bind-probability or LTV model (SIG-027), and a settings
  screen for `conversionValue` (it is set through the existing
  `PATCH /v1/core/modules/signal/config` with `settings.conversionValue`).
