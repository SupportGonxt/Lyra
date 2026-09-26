import { describe, expect, it } from "vitest";
import { scaleRows, type ResponseRollup } from "./signal.shared";

// ADR-0091. The cockpit reads GET /v1/signal/responses/rollup at three scales;
// this is the fold from its counts to the rows a reader compares.

describe("scaleRows", () => {
  const rollup: ResponseRollup = [
    { key: "cmp_small", counts: { lead: 2, replied: 1 } },
    { key: "cmp_big", counts: { lead: 10, delivered: 9, read: 7, replied: 3, bind: 1, opted_out: 1 } },
    { key: "cmp_orphan", counts: { replied: 1 } }
  ];

  it("names each row, rates replies against sends, and puts the biggest first", () => {
    expect(scaleRows(rollup, { cmp_big: "Motor second look" })).toEqual([
      { key: "cmp_big", name: "Motor second look", sent: 10, read: 7, replied: 3, replyPct: 30, binds: 1, optedOut: 1 },
      { key: "cmp_small", name: null, sent: 2, read: 0, replied: 1, replyPct: 50, binds: 0, optedOut: 0 },
      // A reply with no send in the window has no rate to state.
      { key: "cmp_orphan", name: null, sent: 0, read: 0, replied: 1, replyPct: null, binds: 0, optedOut: 0 }
    ]);
  });

  it("keeps the top rows only when asked", () => {
    expect(scaleRows(rollup, {}, 1).map((r) => r.key)).toEqual(["cmp_big"]);
  });
});
