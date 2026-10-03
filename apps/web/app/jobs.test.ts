import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { ROLES, TENANT_ROLE_KEYS, expand, isInternalRole, isKnownPermission } from "@lyra/core/rbac";
import routes from "./routes";
import { JOB, jobsFor, type Job } from "./jobs";
import { WORKSPACES, workspaceFor } from "./modules/index";
import { tabOf } from "./modules/spec";
import { availableShellsForRoles } from "./routing";
import { LABELS as HOME_LABELS } from "./routes/home";

// The home "your jobs" strip is a table of doors. Each guard below holds one
// promise that table makes, and each one first proves it looked at every row:
// a guard that selects its own subjects must account for all of them
// (CLAUDE.md, "the recurring defect: dead seams").

const ALL_JOBS: readonly Job[] = Object.values(JOB);
const REPO = join(import.meta.dirname, "..", "..", "..");

/* --------------------------------------------------- is it a real screen? */

const GENERIC = new Set(["routes/module.tsx", "routes/record.tsx"]);

function flatten(entries: readonly RouteConfigEntry[], prefix = ""): Array<{ path: string; file: string }> {
  return entries.flatMap((entry) => {
    const full = entry.path ? [prefix, entry.path].filter(Boolean).join("/") : prefix;
    if (entry.children) return flatten(entry.children, full);
    return [{ path: entry.index ? prefix : full, file: entry.file }];
  });
}

const bespoke = flatten(routes)
  .filter((r) => !GENERIC.has(r.file))
  .map((r) => `/${r.path}`);

/** A literal bespoke route, or a tab the generic module screen answers for. */
function screenFor(path: string): "bespoke" | "tab" | null {
  const segments = path.split("/").filter(Boolean);
  const matches = (pattern: string) => {
    const p = pattern.split("/").filter(Boolean);
    return p.length === segments.length && p.every((seg, i) => seg.startsWith(":") || seg === segments[i]);
  };
  // `/ledger/reports/pnl` is `/ledger/reports/:report`: a literal job path
  // filling a bespoke route's parameter is that screen.
  if (bespoke.some(matches)) return "bespoke";
  const [module, resource, ...rest] = path.split("/").filter(Boolean);
  const spec = workspaceFor(`/${module ?? ""}`);
  if (!spec || rest.length) return null;
  if (!resource) return "tab";
  return tabOf(spec, resource) ? "tab" : null;
}

describe("every job opens a real screen", () => {
  it("classifies every job as a bespoke route or a workspace tab", () => {
    const unresolved = ALL_JOBS.filter((one) => screenFor(one.path) === null).map((one) => one.path);
    expect(unresolved, "these jobs point at no route and no tab").toEqual([]);
  });

  it("names, for a tab or a spec link, the permission that screen gates on", () => {
    const disagree: string[] = [];
    for (const one of ALL_JOBS) {
      if (one.permission !== null && !isKnownPermission(one.permission)) {
        disagree.push(`${one.path}: ${one.permission} is not a permission`);
        continue;
      }
      // What the workspace specs say gates this path. A bespoke screen with no
      // spec link states its own check in its loader; the table names it.
      const said = WORKSPACES.flatMap((spec) => [
        ...spec.tabs.filter((tab) => `${spec.path}/${tab.key}` === one.path).map((tab) => tab.read),
        ...(spec.links ?? [])
          .filter((link) => link.href.split("?")[0] === one.path && link.permission)
          .map((link) => link.permission!)
      ]);
      if (said.length && !said.includes(one.permission ?? "")) {
        disagree.push(`${one.path}: table says ${one.permission}, specs say ${said.join(" | ")}`);
      }
    }
    expect(disagree).toEqual([]);
  });
});

// Every rbac role decided, and every role opening its own jobs, are the
// table's own business: packages/core/src/jobs.test.ts.

/* ------------------------------------------------------- what home will say */

describe("every job has words in both languages", () => {
  for (const locale of ["en", "ar"]) {
    it(`home labels every job in ${locale}`, () => {
      const missing = ALL_JOBS.filter((one) => !HOME_LABELS[locale]?.[`job.${one.id}`]).map((one) => one.id);
      expect(missing).toEqual([]);
    });
  }
});

/* ------------------------------------------- the adoption script's job list */

/**
 * scripts/role-adoption.mjs keys its JOBS by seat, and home keys its strip by
 * role. A seat's role comes from the seed's PEOPLE table; the demo seat holds
 * every internal tenant role (seed.ts ensureDemoAdmin). Read as source on
 * purpose: importing the script would launch a browser.
 */
function seatRoles(): Map<string, string[]> {
  const seed = readFileSync(join(REPO, "packages/core/src/seed.ts"), "utf8");
  const people = seed.slice(seed.indexOf("const PEOPLE"), seed.indexOf("];", seed.indexOf("const PEOPLE")));
  const seats = new Map<string, string[]>();
  for (const [, local, role] of people.matchAll(/local: "([\w.]+)", name: "[^"]*", role: "([\w.]+)"/g)) {
    seats.set(`${local}@gonxt.ae`, [role!]);
  }
  seats.set("demo@gonxt.ae", TENANT_ROLE_KEYS.filter(isInternalRole));
  return seats;
}

function scriptJobs(): { seats: Map<string, string[]>; tuples: number; seatKeys: number } {
  const script = readFileSync(join(REPO, "scripts/role-adoption.mjs"), "utf8");
  const block = script.slice(script.indexOf("const JOBS = {"), script.indexOf("\n};", script.indexOf("const JOBS = {")));
  const seats = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of block.split("\n")) {
    const seat = /^\s*"([^"]+@[^"]+)": \[/.exec(line);
    if (seat) seats.set(seat[1]!, (current = []));
    for (const [, path] of line.matchAll(/\["[^"]+", "[^"]+", "([^"]+)"\]/g)) current?.push(path!);
  }
  return {
    seats,
    // Raw counts, to prove the parse above saw every seat and every tuple.
    tuples: (block.match(/\["[^"]+", "[^"]+", "\//g) ?? []).length,
    seatKeys: (block.match(/"[^"]+@[^"]+": \[/g) ?? []).length
  };
}

/**
 * Script jobs a seat's strip deliberately does not carry, and why. Empty: if
 * a measured job ever leaves the table, it is named here or the guard fails.
 */
const NOT_ON_HOME: ReadonlyMap<string, string> = new Map();

describe("the adoption script measures what home offers", () => {
  const roles = seatRoles();
  const { seats, tuples, seatKeys } = scriptJobs();

  it("read every seat and every job in the script", () => {
    expect(seats.size).toBe(seatKeys);
    expect([...seats.values()].flat().length).toBe(tuples);
    expect(tuples).toBeGreaterThan(0);
  });

  it("knows the role of every seat the script signs in as", () => {
    expect([...seats.keys()].filter((email) => !roles.has(email))).toEqual([]);
  });

  it("puts every measured job on that seat's home strip, or says why not", () => {
    const off: string[] = [];
    for (const [email, paths] of seats) {
      const held = roles.get(email) ?? [];
      const permissions = expand(held.flatMap((role) => ROLES[role] ?? []));
      const shown = jobsFor(held, permissions, availableShellsForRoles(held)).map((one) => one.path);
      for (const path of paths) {
        if (!shown.includes(path) && !NOT_ON_HOME.has(`${email} ${path}`)) off.push(`${email} ${path}`);
      }
    }
    expect(off).toEqual([]);
  });
});
