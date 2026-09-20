import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every test in ledger.test.ts stands up a real libsql database and runs the
    // migrations in `beforeEach` — the invariants here are property-shaped
    // (every recipe in the catalogue, fuzzed; a posting is one write or none)
    // and they are asserted against the actual SQL, which is the whole point of
    // them (CLAUDE.md §12: ledger invariants are property-tested and may not be
    // relaxed to make a test pass).
    //
    // That costs 0.4-2.8s each on an idle machine and comfortably more than
    // vitest's 5s default on a busy one: four of them timed out at 5s under
    // `pnpm test` — where turbo runs nine packages at once — while passing in
    // 74/74 when the package is run alone. A suite that depends on what else is
    // running is a Sev-2 flake, and the budget, not the invariant, is what was
    // wrong. This raises only the clock: no assertion changes, and a genuine
    // hang still fails, six times slower.
    testTimeout: 30_000
  }
});
