# ADR-0100 — Ad platforms are channels behind one seam

Date: 2026-09-27 · Status: accepted

## Context

docs/30 SIGNAL 5 asked for an ad-platform seam with Google and Meta adapters.
docs/modules/signal.md §2.2 and §5 already name "Google/Meta APIs via
connectors" and a "connector framework (Google, Meta built-in)". CLAUDE.md §13
treats ad networks as channels, not management suites, so no ADR is needed to
*use* them. This ADR records the choices the docs leave open.

Before this change, spend reached `signal_spend` only through CRUD or the CSV
import. A budget move the autopilot made (`signal_budget_moves`) changed
nothing outside LYRA.

## Decision

1. **The seam.** `AdPlatform` in `packages/core/src/seams.ts` has two methods.
   `pullSpend(window)` returns daily rows per platform campaign.
   `adjustDailyBudget(campaign, deltaMinor, currency)` moves one campaign's
   daily budget. The arithmetic every adapter shares is in
   `packages/core/src/ad-platform.ts`: exact decimal and micros conversion to
   minor units, the currency exponent, and reading the connector config.
   The contract test is `@seam:H10` (first-party connectors, docs/16 H10).
2. **Accounts are connector rows.** An ad account is a row in
   `orbit_channel_connectors` on transport `ads`, with provider `google-ads`
   or `meta-ads`. Its secrets are sealed like every other connector
   (ADR-0093), and the platform Channels tab creates it.
   - Google needs `developerToken`, `clientId`, `clientSecret` and
     `refreshToken`, and exchanges the refresh token for an access token on
     each call.
   - Meta needs a system-user `accessToken`, sent in the Authorization
     header and never in a URL.
   - The config holds `campaigns: { "<platform campaign id>": "<LYRA
     campaign id>" }` and optionally a `channel`. The defaults are
     `google_search` and `meta`, the channel names the seed and the
     autopilot already use.

   No migration was needed.
3. **Pull.** Spend is pulled through `recordSpend`, the same write the CSV
   import uses, with `source: "api"`.
   - A restated day is corrected, not doubled.
   - Several platform campaigns that map to one LYRA campaign are summed.
   - An unmapped platform campaign is recorded as channel-level spend.

   The pull runs on the first scheduler tick of the UTC day, just before the
   autopilot's daily evaluation, over the last three whole days, because
   platforms restate recent days. `POST /v1/signal/spend/pull` runs the same
   pull on demand, over at most 31 days.
4. **Push happens only after the `signal.budget_move` gate.**
   - A move the gate passes at commit (within the bound, or on the tenant's
     auto-approve list) is pushed right away.
   - A move that waits for approval is pushed when
     `signal.approval.decided` arrives, and only after `gate()` spends that
     approval. The consumer calls the same gate as the autopilot, so it
     cannot push a move that the gate would refuse.
   - A move still marked `pending` is refused by `pushBudgetMove` itself.
   - The CRUD reversal, already behind the gate, emits
     `signal.budget-moves.updated`, and the consumer reverses exactly the
     legs that were pushed.
5. **What a push changes on the platform.**
   - The move's `amountMinor` is sized against the autopilot's 7-day
     window, so the daily budget moves by `amountMinor / windowDays`.
   - The decrease leg always runs first. If it fails, the increase is held
     back (`skipped`), so a failure never creates new spend that nobody
     approved.
   - A channel with no connected account is left alone.
   - A LYRA campaign mapped to several platform campaigns is not pushed,
     because a budget is never split by guess. The same goes for a Google
     shared budget and for a Meta campaign whose budget is set on its ad
     sets.
   - Each leg is marked in the audit log (`signal.budget_move.pushed` with
     subject `budget-moves:<id>#<channel>#<apply|reverse>`), so pushing the
     same move twice moves nothing the second time. The readable outcome,
     including the budget before and after, is kept on the move's
     `evidenceJson` under `platformPush` / `platformUndo`, because the audit
     chain stores only hashes.
6. **No connector, no change.** A tenant with no active `ads` connector gets
   no network call, no audit row and no approval spent.

## Consequences

- Version pins: Google Ads `v21` and Graph `v23.0`. Either can be overridden
  per connector with `config.apiVersion`. Both providers retire versions,
  so a pin that ages out fails loudly as a `pull_failed` or `push_failed`
  row, never silently.
- Push failures are recorded and not retried. The approval has already been
  spent, so a retry would ask for a new one. An operator sees the failure on
  the move.
- Not built:
  - value-based bidding exports and conversion uploads (signal.md §2.2);
  - creative publishing (§8 clause 1);
  - TikTok;
  - an OAuth consent flow in the admin screen. Tokens are pasted as sealed
    secrets, the same as the WhatsApp and Mailgun connectors.
