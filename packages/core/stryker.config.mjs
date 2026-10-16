/**
 * Run from the repo root (see root package.json's "mutation" script) — the
 * sandbox mirrors whatever the current working directory is, and core.test.ts
 * / commission.test.ts / seed.test.ts read ../../db/migrations, a sibling
 * package. Running from packages/core directly leaves that path dangling.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import { changedSources } from "../../scripts/stryker-changed.mjs";

// Never mutated, whether the run is whole-tree or diff-scoped.
const excluded = [
  "!packages/core/src/**/*.test.ts",
  // side-effecting CLI entrypoints, no exported logic to test. Everything either
  // of them decides without a network lives in a sibling module that IS mutated
  // (seed-history-cli.ts -> seed-history-d1.ts); if one of these grows a branch,
  // move the branch out rather than widening this list.
  "!packages/core/src/seed-cli.ts",
  "!packages/core/src/seed-history-cli.ts",
  // no unit coverage in this package; exercised indirectly via apps/api
  "!packages/core/src/crypto.ts",
  "!packages/core/src/totp.ts",
  "!packages/core/src/onboarding-templates.ts",
  // The demo/e2e fixture dataset — ~27k of this package's ~31k source lines,
  // and it is literal data, not behaviour. Stryker classifies 98% of its
  // mutants static (seed.ts alone: 1,852 mutants, 1,821 of them static; a
  // single touched fixture file, seed/ledger.ts at 1,914 lines, was enough to
  // put a diff-scoped run past 2h), because a module-level table only executes
  // while its file loads, so each mutant costs a full re-run of the suite.
  // Mutating it measured nothing and cost everything: every run that included
  // seed/ was killed by the runner ceiling, so the gate reported no score at
  // all. Out of the mutate set, the 70% break threshold applies to the ~6.8k
  // mutants of real domain logic and actually reports a number.
  //
  // WHAT THIS LEAVES UNGATED BY MUTATION SCORE: the seed dataset itself. Its
  // correctness rests on packages/core/src/seed/*.test.ts (which do run under
  // `pnpm test`) and on the e2e journeys that consume the fixture. If seed/
  // ever grows real branching logic, move that logic out of seed/ rather than
  // dropping this exclusion.
  "!packages/core/src/seed.ts",
  "!packages/core/src/seed/**"
];

const changed = changedSources("packages/core/src");

export default {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  reporters: ["html", "clear-text", "progress"],
  coverageAnalysis: "perTest",
  tempDirName: "packages/core/.stryker-tmp",
  // **The upgrade path this file's sibling comment in ci.yml prescribed and
  // nobody had taken.** Stryker 9 dropped the git-diff selector and kept
  // `incremental`, which caches each mutant's result so a later run re-tests only
  // the mutants whose *covering tests* changed.
  //
  // Why it is worth having: a push to `main` scopes mutation to
  // `github.event.before` — on a merge commit that is `HEAD^1`, the pre-merge tip,
  // so the deploy re-mutates the **whole PR** even though the PR's own mutation job
  // already tested exactly those files via `origin/<base>...`. For a large change
  // set that duplication is what parks the deploy: 89abd6e was the merge of a
  // 286-file change set, and its `mutation (core)` ran past 54 minutes against a
  // 60-minute ceiling before it was cancelled.
  //
  // The file deliberately does **not** live in `tempDirName` above: Stryker wipes
  // the temp dir at the start of every run, so a cache kept there would be deleted
  // before it could be restored.
  //
  // Stryker discards the file, with a warning and a full run, when the config or
  // the test suite no longer matches it. A stale cache therefore costs time, never
  // correctness — which is the property that makes it safe to wire to CI.
  incremental: true,
  incrementalFile: "packages/core/.stryker-incremental.json",
  ignorePatterns: [
    "apps",
    "packages/agents",
    "packages/config",
    "packages/model-gateway",
    "packages/sdk",
    "packages/ui",
    "packages/db/src",
    "docs",
    "infra",
    "e2e",
    // Playwright writes and deletes trace files here while a run is in flight;
    // the sandbox copy races them and dies on ENOENT. Nothing here is mutated.
    "test-results",
    "reports"
  ],
  // With STRYKER_SINCE set (the `mutation` job in .github/workflows/ci.yml) the
  // run covers only the files a change touched; unset, it is the full sweep.
  // Scoping alone was never enough — one 1,914-line fixture file in the diff
  // reproduced the whole-tree stall — hence the seed/ exclusion above.
  // **`null` and `[]` are different answers, and this ternary used to conflate
  // them.** `changed` is `null` when `STRYKER_SINCE` is unset or unresolvable — the
  // fail-closed case, which must widen to the whole tree. It is `[]` when the diff
  // touched nothing in this package — which means there is nothing to mutate.
  //
  // **`[]` is truthy in JavaScript**, so `changed ? [...changed, ...excluded] : …`
  // took the *first* branch and produced `excluded` alone: pure negation patterns,
  // which Stryker resolves against `**/*`. A commit touching no core source
  // therefore mutated the entire package — ~6.8k mutants, hours, against a
  // 60-minute job ceiling — instead of nothing. `allowEmpty: true` below states the
  // intent exactly ("a commit that touches no source in this package has nothing to
  // mutate"); the code did not implement it.
  //
  // The consequence was not theoretical: both deploy jobs are `needs: checks`, so
  // **any merge to main that touched no `packages/core/src/*.ts` file parked the
  // deploy on a gate that could not finish**, and staging and production never ran.
  mutate:
    changed === null
      ? ["packages/core/src/**/*.ts", ...excluded]
      : changed.length > 0
        ? [...changed, ...excluded]
        : [],
  vitest: { dir: "packages/core" },
  thresholds: { high: 80, low: 70, break: 70 },
  // A commit that touches no source in this package has nothing to mutate.
  allowEmpty: true
};
