import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB } from "@lyra/core/jobs";
import { ROLES, expand } from "@lyra/core/rbac";
import { ar, en } from "./i18n";
import { DESK_ONLY, PHONE_ROUTE, phoneJobsFor } from "./jobs";

// Mobile parity for the web home's "your jobs" strip. Both read one table
// (@lyra/core/jobs); what is the phone's own is which jobs have a screen here
// and the words for them. Every job must be on one side of that line, so a
// job added to the table cannot quietly never reach the phone.

const APP = join(import.meta.dirname, "..", "app");
const ids = Object.keys(JOB);

/** `/j/queue?filter=sla` → app/j/queue.tsx; `/m/admin` → app/m/[nav]/index.tsx. */
function screenExists(route: string): boolean {
  const path = route.split("?")[0]!;
  if (/^\/m\/[\w-]+$/.test(path)) return existsSync(join(APP, "m", "[nav]", "index.tsx"));
  return existsSync(join(APP, `${path}.tsx`)) || existsSync(join(APP, path, "index.tsx"));
}

describe("every job is a phone job or desk-only", () => {
  it("puts each job on exactly one side", () => {
    const mapped = Object.keys(PHONE_ROUTE);
    expect(ids.filter((id) => !mapped.includes(id) && !DESK_ONLY.includes(id as never))).toEqual([]);
    expect(mapped.filter((id) => DESK_ONLY.includes(id as never))).toEqual([]);
    expect(mapped.length + DESK_ONLY.length).toBe(ids.length);
  });

  for (const [id, entry] of Object.entries(PHONE_ROUTE)) {
    it(`${id} opens a screen this app has, worded in en and ar`, () => {
      expect(screenExists(entry!.route), entry!.route).toBe(true);
      expect(en[`job.${id}` as keyof typeof en], `en job.${id}`).toBeTruthy();
      expect(ar[`job.${id}` as keyof typeof ar], `ar job.${id}`).toBeTruthy();
    });
  }
});

describe("phoneJobsFor", () => {
  const seat = (role: string) => ({ roles: [role], permissions: expand(ROLES[role] ?? []) });

  it("gives a seat its phone jobs in the table's order", () => {
    expect(phoneJobsFor(seat("north.exec")).map((one) => one.route)).toEqual(["/j/brief", "/j/boardpack", "/j/decisions"]);
  });

  it("drops a job whose phone screen needs a permission the seat lacks", () => {
    // The web's /approvals is the actor's own inbox; the phone's approvals
    // screen reads the queue behind core:approvals:read (personas.ts).
    const noQueue = { roles: ["tenant.compliance"], permissions: ["core:audit:read", "compliance:dsar:read"] };
    expect(phoneJobsFor(noQueue).map((one) => one.route)).toEqual(["/j/audit", "/j/requests"]);
  });

  it("lists a screen two jobs share once", () => {
    const routes = phoneJobsFor(seat("orbit.lead")).map((one) => one.route);
    expect(routes.filter((route) => route === "/j/threads")).toHaveLength(1);
  });

  it("offers nothing to a seat with no phone job", () => {
    expect(phoneJobsFor(seat("dev.admin"))).toEqual([]);
    expect(phoneJobsFor({ roles: [], permissions: [] })).toEqual([]);
  });

  it("carries the catalogue key it is worded by", () => {
    expect(phoneJobsFor(seat("north.exec"))[0]?.labelKey).toBe("job.brief");
  });
});
