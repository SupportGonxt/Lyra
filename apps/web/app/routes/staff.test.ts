import { describe, expect, it } from "vitest";
import { LABELS, labelsIn, nameOf, staffLede, type Delegation, type StaffOption, type StaffUser } from "./staff";

// The delegations table printed `usr_D9KE953TO2YKYY5RK6BEA6RI2YQY` under FROM
// for the one row whose user fell off the end of the picker's option list —
// at whoever is deciding whether to revoke that delegation.
describe("nameOf", () => {
  const options = [{ id: "us_01KE9", name: "Omar Farouk" }] as StaffOption[];

  it("says the name the picker already knows", () => {
    expect(nameOf(options, "us_01KE9")).toBe("Omar Farouk");
  });

  it("falls back to the directory for someone the picker never loaded", () => {
    expect(nameOf(options, "us_01KE8", { us_01KE8: "Nadia Rahman" })).toBe("Nadia Rahman");
  });

  it("shortens a ref nobody could name rather than printing the whole ULID", () => {
    expect(nameOf(options, "us_01KE953T02YKYY5RK6BEA6R2YQZ").length).toBeLessThan(
      "us_01KE953T02YKYY5RK6BEA6R2YQZ".length
    );
  });
});

describe("staffLede", () => {
  const l = labelsIn("en");

  it("reads empty when no one matches", () => {
    expect(staffLede([], [], l)).toBe(LABELS.en?.introEmpty);
  });

  it("counts people and only the active delegations", () => {
    const users = [{}, {}] as StaffUser[];
    const delegations = [{ status: "active" }, { status: "revoked" }] as Delegation[];
    expect(staffLede(users, delegations, l)).toBe("2 people, 1 active delegation in place.");
  });
});

describe("staff labels", () => {
  it("translates every English key into Arabic", () => {
    const missing = Object.keys(LABELS.en!).filter((key) => !(key in LABELS.ar!));
    expect(missing).toEqual([]);
  });
});
