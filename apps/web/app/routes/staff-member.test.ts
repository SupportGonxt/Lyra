import { describe, expect, it } from "vitest";
import { LABELS, memberLabelsIn, memberLede } from "./staff-member";

// The line under a member's name and status: how many roles they hold, and —
// once onboarding is actually readable — how much of the required checklist
// has cleared. Both numbers come straight off the loader, nothing invented.

describe("memberLede", () => {
  const l = memberLabelsIn("en");

  it("names the role count alone when there is no onboarding checklist to read", () => {
    expect(memberLede(["role_a", "role_b"], [], l)).toBe("2 roles held.");
  });

  it("adds onboarding progress once steps are visible, counting only required ones", () => {
    const steps = [
      { required: true, state: "done" },
      { required: true, state: "waived" },
      { required: true, state: "pending" },
      { required: false, state: "pending" }
    ] as never[];
    expect(memberLede(["role_a"], steps, l)).toBe(
      "1 role held. 2 of 3 required onboarding steps cleared."
    );
  });

  it("holds every Arabic key against the same English keys", () => {
    expect(Object.keys(LABELS.ar ?? {}).sort()).toEqual(Object.keys(LABELS.en ?? {}).sort());
  });
});

/**
 * A staff row is invited|active|suspended, and the badge under the name said
 * `admin.status.active` on live — a key in no catalogue in either language,
 * printed verbatim, while the directory two clicks away said "Active" for the
 * same column. The three words now live in detail-kit's SHARED table, which is
 * the resolver both screens already go through.
 */
describe("the state a member is in", () => {
  it("says the word in English, not the key", () => {
    const l = memberLabelsIn("en");
    expect(l("status.invited")).toBe("Invited");
    expect(l("status.active")).toBe("Active");
    expect(l("status.suspended")).toBe("Suspended");
  });

  it("says it in Arabic for an Arabic reader", () => {
    const l = memberLabelsIn("ar");
    expect(l("status.invited")).toBe("مدعو");
    expect(l("status.active")).toBe("سارية");
    expect(l("status.suspended")).toBe("موقوف");
  });

  it("resolves every state the column can hold", () => {
    const l = memberLabelsIn("en");
    for (const state of ["invited", "active", "suspended"]) {
      expect(l(`status.${state}`)).not.toBe(`status.${state}`);
    }
  });
});
