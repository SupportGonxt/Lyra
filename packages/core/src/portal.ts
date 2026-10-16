// The vocabulary a partner's money panel is built from.
//
// It lived in three places and they disagreed: the schema documents eight states
// in a comment (`db/src/schema/dist.ts:261`), `engines/party-portals.ts` carried the
// same eight as `MONEY_STATES`, and the channel portal's screen had a `LADDER` of
// **six** — and a label table of six — which is how a `disputed` entry came to render
// the raw key `channel.money.disputed` **to an external partner** (the 2026-10-01
// sweep's PORTALS finding).
//
// **Two of those lists are the same fact and one is not**, which is why this lives
// here rather than being copied again:
//
//   - `MONEY_STATES` is the complete vocabulary — every state a commission entry can
//     hold. It is what a label table must cover, and what a guard must derive from.
//   - `MONEY_LADDER` is a **presentation** choice: the states shown as a proportional
//     ladder on the partner's page, which deliberately excludes `disputed` and
//     `written_off` (a dispute is not a stage money passes through, and a write-off is
//     the tenant's decision rather than the partner's news).
//
// They are not two spellings of one list, and the bug was caused by treating them as
// if they were.

/**
 * Every state a `dist_commission_entries` row can hold.
 *
 * Exported so a screen's label table can be **checked against** it rather than
 * hand-listed beside it: a guard whose population is a hand-written list cannot
 * notice a missing member of the real one.
 */
export const MONEY_STATES = [
  "accrued",
  "invoiced",
  "received",
  "payable",
  "paid",
  "clawed_back",
  "disputed",
  "written_off"
] as const;

export type MoneyState = (typeof MONEY_STATES)[number];

/**
 * The states shown as a proportional ladder — money's journey, in order.
 *
 * Deliberately not all of `MONEY_STATES`: see the note above. `computeLadder` in the
 * channel portal reads this, and the ladder's shares sum to the total the partner is
 * owed, which is why a state outside the journey would misstate it.
 */
export const MONEY_LADDER = ["accrued", "invoiced", "received", "payable", "paid", "clawed_back"] as const satisfies
  readonly MoneyState[];
