import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A gated action is a promise to whoever reads the approval catalogue: this
// action needs a person. When nothing calls `gate()` with the key, the entry is
// decorative — the catalogue says the platform protects something it does not.
//
// This is the third of the inverses, beside `spec.routes.test.ts` (a link with no
// screen) and `rbac.reachability.test.ts` (a permission with no requirement):
// **an approval policy with no caller.**
//
// It exists because the population was verified **by hand, once, and nowhere
// else** (TECHNOLOGY-GAP-REGISTER §5). rbac has two guards over it; the catalogue
// that decides what a human must approve had none. A hand check is not a guard —
// it is a guard that ran before the sixty-fifth key was added.
//
// The trap it is written to avoid, and the reason for the assertions at the foot:
// **the first pass at this check compared two counts** — 64 `policy({` against 45
// `policyKey:` — and concluded nineteen entries were dead. They were not. A
// counts-vs-counts comparison is not a reachability check, and a guard that
// selects its own subjects must assert it selected them rather than assume it.

const API_SRC = join(import.meta.dirname);
const CORE_SRC = join(API_SRC, "..", "..", "..", "packages", "core", "src");
const CATALOGUE = join(CORE_SRC, "approvals.ts");

/**
 * Every `.ts`/`.tsx` in the repository outside approvals.ts itself, excluding tests.
 *
 * **Scope is the whole repo, and the first version of this guard got that wrong in a
 * way worth recording.** It scanned `apps/api` and `packages/core` — the two trees that
 * *call* `gate()` — and reported **sixteen orphaned policies**. Every one was a false
 * positive, because a key is also named where the platform *describes* the action:
 * `packages/ledger/src/types.ts` gives each txn type its policy key
 * (`["PAYOUT-INSTRUCT", true, "ledger.payout", …]`), and `apps/web/app/policy.ts`
 * carries its label. Neither tree calls a gate; both name the key.
 *
 * A guard that selects its own subjects must assert it selected them — and
 * `sources.length > 100` was **a floor, not a contract**. `CLAUDE.md` says it in as
 * many words: *"never assert a count is large enough."* The assertions below name the
 * trees that must be present instead.
 */
function productionSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "build" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\./.test(entry)) continue;
      if (full === CATALOGUE) continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  // The repository root — two levels above apps/api/src.
  walk(join(API_SRC, "..", "..", ".."));
  return out;
}

/** The keys the catalogue declares. */
function declaredKeys(): string[] {
  const text = readFileSync(CATALOGUE, "utf8");
  return [...text.matchAll(/policy\(\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("every approval policy is reachable", () => {
  const sources = productionSources();
  const keys = declaredKeys();

  it("found the catalogue and the sources it is guarding", () => {
    // The population assertions the rbac guard's own header insists on: a guard
    // that selects nothing passes in perpetuity. These are floors **and** a
    // cross-check — if the catalogue's shape changes so this regex stops matching,
    // `keys` empties and this fails rather than reporting a clean sweep.
    expect(keys.length).toBeGreaterThan(50);
    // **A contract, not a floor.** Each tree that names a policy key must be in the
    // population, because dropping one is precisely how the first version of this
    // guard manufactured sixteen false positives: `packages/ledger` describes each
    // txn type's policy, and `apps/web` labels it. Neither calls a gate; both are
    // evidence that the key is real.
    const paths = sources.map((s) => s.path);
    for (const tree of ["/apps/api/", "/apps/web/", "/packages/core/", "/packages/ledger/"]) {
      expect(paths.some((p) => p.includes(tree)), `population is missing ${tree}`).toBe(true);
    }
    // Every key is a dotted path; one that is not means the extraction drifted.
    expect(keys.filter((k) => !/^[a-z]+\.[a-z_]+$/.test(k))).toEqual([]);
  });

  it("has a gate() caller for every declared key", () => {
    const orphans = keys.filter((key) => {
      // A word boundary, not a substring: `axis.bind` must not be satisfied by
      // `axis.bind_group`.
      const pattern = new RegExp(`(?<![\\w.])${key.replace(/\./g, "\\.")}(?![\\w.])`);
      return !sources.some((s) => pattern.test(s.text));
    });

    expect(orphans, `approval policies nothing calls:\n${orphans.join("\n")}`).toEqual([]);
  });
});
