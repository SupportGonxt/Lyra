import { describe, expect, it } from "vitest";
import { JOB, JOBS_BY_ROLE, NO_JOBS, SHELLED_MODULES, jobsFor, opens } from "./jobs";
import { availableShellsForRoles } from "./lens";
import { ROLES, expand } from "./rbac";

// The role -> jobs table both the web home strip and the phone's menu read.
// The surface-specific guards (real web routes, real phone screens, labels)
// live beside each app; what is the table's own business is held here.

describe("every role is decided", () => {
  const roles = Object.keys(ROLES);

  it("puts every rbac role in JOBS_BY_ROLE or NO_JOBS, never both, never neither", () => {
    expect(roles.filter((role) => !(role in JOBS_BY_ROLE) && !(role in NO_JOBS))).toEqual([]);
    expect(roles.filter((role) => role in JOBS_BY_ROLE && role in NO_JOBS)).toEqual([]);
  });

  it("names no role rbac does not have", () => {
    expect([...Object.keys(JOBS_BY_ROLE), ...Object.keys(NO_JOBS)].filter((role) => !(role in ROLES))).toEqual([]);
  });

  for (const [role, jobs] of Object.entries(JOBS_BY_ROLE)) {
    it(`${role} can open every one of its own jobs`, () => {
      const shown = jobsFor([role], expand(ROLES[role] ?? []), availableShellsForRoles([role]));
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.filter((one) => !shown.includes(one)).map((one) => one.path)).toEqual([]);
    });
  }
});

describe("opens", () => {
  it("needs the screen's permission", () => {
    expect(opens(JOB.webhooks, ["core:webhooks:read"], [])).toBe(true);
    expect(opens(JOB.webhooks, [], [])).toBe(false);
  });

  it("needs the module shell a shelled screen renders in, and only then", () => {
    expect(opens(JOB.exceptions, ["axis:cases:read"], ["north"])).toBe(false);
    expect(opens(JOB.exceptions, ["axis:cases:read"], ["axis"])).toBe(true);
    expect(opens(JOB.quoteRequests, ["dist:quote_requests:read"], [])).toBe(true);
  });

  it("opens a job with no permission to every seat", () => {
    expect(opens(JOB.approvals, [], [])).toBe(true);
  });
});

describe("jobsFor", () => {
  const everything = expand(["*:*:*"]);

  it("keeps table order and lists a shared path once", () => {
    const shown = jobsFor(["finance.controller", "tenant.admin"], everything, [...SHELLED_MODULES]);
    expect(shown[0]).toBe(JOB.approvals);
    expect(shown.filter((one) => one.path === JOB.approvals.path)).toHaveLength(1);
  });

  it("offers nothing to a seat whose roles have no strip", () => {
    expect(jobsFor(["customer"], everything, [...SHELLED_MODULES])).toEqual([]);
  });

  it("skips a role the seat does not hold", () => {
    expect(jobsFor(["dev.admin"], everything, []).map((one) => one.id)).toEqual(["developer", "apiKeys", "webhooks"]);
  });
});
