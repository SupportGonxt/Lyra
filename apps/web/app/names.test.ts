import { describe, expect, it } from "vitest";
import { refsIn, who } from "./names";

// The home screen's activity feed and approval strips read
// `ai_budget:signal` and `settlements:cedar-2512` to a tenant admin: /v1/names
// owns the refs that belong to a record, and an engine that numbers its own
// subjects is not one of those.
describe("who", () => {
  it("prefers the resolved name", () => {
    expect(who("usr_01ke953t000wtenzd6wy9tpya0", { usr_01ke953t000wtenzd6wy9tpya0: "Amina Saleh" })).toBe(
      "Amina Saleh"
    );
  });

  it("shortens an opaque id nobody named", () => {
    expect(who("exp_01ke953t000wtenzd6wy9tpya0", {})).toBe("exp_01ke…pya0");
  });

  it("says an engine's own subject as words", () => {
    expect(who("ai_budget:signal", {})).toBe("AI budget signal");
    expect(who("settlements:cedar-2512", {})).toBe("Settlements cedar-2512");
  });

  it("says a create by what it creates, not by its dedupe digest", () => {
    expect(
      who("commission-rates:new:2ea07245cc1fdac67c38cd4d675d490eab3d56b0105d612bd9a322a36fb7cc2c", {})
    ).toBe("New commission rates");
  });

  it("leaves a plain string alone", () => {
    expect(who("Cedar Motor Plus", {})).toBe("Cedar Motor Plus");
    expect(who(null, {})).toBeNull();
  });
});

describe("refsIn", () => {
  // docs/30 Analytics 4: a report grouped by channel printed the channel's id.
  it("collects every ref-shaped value, whichever column it sits in, and nothing else", () => {
    const rows = [{ channelId: "chn_01J8Z3K4Q5R6S7T8V9W0X1Y2Z3", gwp: 120, label: "Motor" }];
    expect(refsIn(rows)).toEqual(["chn_01J8Z3K4Q5R6S7T8V9W0X1Y2Z3"]);
  });
});
