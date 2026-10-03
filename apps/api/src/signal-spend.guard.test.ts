import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import { REGISTRY } from "./crud.js";
import { signalRoutes } from "./routes/signal.js";
import "./resources.js";

// docs/19 §4.8: MEDIA-SPEND is "actual spend recorded from channel API", and
// for months the only thing that posted one was the seed — every live write
// (CSV import, ad-platform pull, demo tick, hand-keyed CRUD) wrote signal_spend
// and nothing else, so a simulated month showed AED 214k of spend in SIGNAL
// and AED 0 on the P&L. The accrual now lives in `recordSpend`
// (engines/signal-spend-import.ts). This holds the tree to it: a signal_spend
// write anywhere else is a write that can skip the ledger.
//
// Partitioned, not counted (CLAUDE.md: a guard that selects its own subjects
// must assert it selected all of them): every file that writes the table is
// either the seam or excluded for a named reason, and the leftover is empty.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SEAM = "apps/api/src/engines/signal-spend-import.ts";
const EXCLUDED: Record<string, string> = {
  // Provisioning, not a live write: seeded history is carried by the seed's
  // own monthly MEDIA-SPEND (`histmod:media-spend:<month>`), and recordSpend
  // treats any row it did not book as a floor it accrues on top of.
  "packages/core/src/seed/history-modules.ts": "seed: history rows, accrued monthly by the seed itself",
  "packages/core/src/seed/signal.ts": "seed: the demo tenant's opening rows, a floor to recordSpend",
  // Generated CRUD writes `r.table`, which this scan cannot follow; the second
  // describe below holds those writes to the hand-written shadow routes.
  "apps/api/src/resources.ts": "CRUD registration: its writes are shadowed, asserted below"
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });

/**
 * A read names the table in one of a few positions — `.from(t)`, a join,
 * `scoped(ctx, t, …)`, `must(ctx, t, …)` — and a column as `t.column`. Any
 * other use of the table itself (`.insert(t)`, `.update(t)`, a helper such as
 * the seed's `insertNew(db, tenant, t, …)`, a CRUD registration) can write it,
 * so it counts as a writer until named. Allowlisting reads, not listing
 * writes: a new way to write is caught without anyone teaching this test it.
 */
const READ_POSITION = /(?:\.from|Join|scoped|must|one|getTableColumns)\(\s*(?:ctx,\s*)?$/;

/**
 * Comments and plain string literals out, so prose ("spend over binds") and
 * labels (`"spend"`) are not read as uses of an alias named `spend`.
 */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

function writesSpend(raw: string): boolean {
  const src = code(raw);
  const aliases = [...src.matchAll(/(\w+)\s*=\s*schema\.signalSpend(?![\w.])/g)].map((m) => m[1]!);
  const table = new RegExp(`(?<![\\w.])(?:schema\\.signalSpend${aliases.map((a) => `|${a}`).join("")})(?![\\w.])`, "g");
  for (const m of src.matchAll(table)) {
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    const aliasing = /\b\w+\s*=\s*$/.test(before) && m[0] === "schema.signalSpend";
    const declaring = /^\s*=(?!=)/.test(src.slice(m.index + m[0].length));
    if (!aliasing && !declaring && !READ_POSITION.test(before)) return true;
  }
  return /\b(insert\s+into|update|delete\s+from)\s+[`"']?signal_spend\b/i.test(src);
}

describe("signal_spend is written only through recordSpend", () => {
  const sources = ["apps", "packages"].flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f));
  const writers = sources.filter((f) => writesSpend(readFileSync(join(ROOT, f), "utf8")));

  it("finds the seam itself — a guard that matches nothing proves nothing", () => {
    expect(writers).toContain(SEAM);
  });

  it("finds no other writer, outside the named exclusions", () => {
    const leftover = writers.filter((f) => f !== SEAM && !(f in EXCLUDED));
    expect(leftover).toEqual([]);
  });

  it("every exclusion still names a file that writes the table", () => {
    expect(Object.keys(EXCLUDED).filter((f) => !writers.includes(f))).toEqual([]);
  });
});

describe("the generated CRUD writes for spend are shadowed", () => {
  // Generated CRUD writes `r.table` directly, which no source scan above can
  // see. Hand-written routes mount first (index.ts), so every write method the
  // resource declares must have a hand-written route on the same path.
  const spend = REGISTRY.find((r) => r.table === schema.signalSpend);
  const has = (method: string, path: string) => signalRoutes.routes.some((r) => r.method === method && r.path === path);

  it("is registered at all", () => {
    expect(spend?.path).toBe("spend");
  });

  it("create and update go through routes/signal.ts", () => {
    const missing = [
      ...(spend?.perms.create ? [["POST", "/spend"]] : []),
      ...(spend?.perms.update && !spend.immutable ? [["PATCH", "/spend/:id"], ["PUT", "/spend/:id"]] : [])
    ].filter(([m, p]) => !has(m!, p!));
    expect(missing).toEqual([]);
  });

  it("declares no delete, which would drop a row and leave its accrual standing", () => {
    expect(spend?.perms.remove).toBeUndefined();
  });

  it("carries no write hooks, which a shadowed write would never run", () => {
    expect([spend?.beforeWrite, spend?.afterWrite]).toEqual([undefined, undefined]);
  });
});
