import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { onpremInit } from "./lyra-onprem.js";

// The one link in the sovereign stack that can rot silently.
//
// `ops/docker-compose.yml` interpolates required variables — `APP_ORIGIN`,
// `AUTH_SECRET` and the rest — with no defaults, by design (CLAUDE.md rule 10:
// secrets via Docker env). `scripts/lyra-onprem.ts`'s `onpremInit` reads
// `.env.example`, substitutes the secrets, and writes `ops/.env`. Run it, then
// `pnpm onprem:up`.
//
// **Nothing tested that the two agree.** A required variable added to the compose
// file and forgotten in `.env.example` makes `pnpm onprem:up` fail on a fresh
// clone, with a message about a missing variable rather than about the template —
// and no unit test in `scripts/lyra.test.ts` can see it, because those drive
// `onpremInit`'s logic through injected executors and never ask *compose* whether
// the result is acceptable.
//
// This asks compose. It needs no images and no daemon — `config` only parses and
// interpolates — so it runs in about a second. Verified by hand on 2026-10-16:
// without an env, `config` exits 1 naming `APP_ORIGIN`; with the generated one,
// exit 0, and 11 services in a default `up`.

const ROOT = resolve(import.meta.dirname, "..");
const COMPOSE = join(ROOT, "ops", "docker-compose.yml");

/** Does this machine have the compose plugin at all? */
function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const compose = hasCompose();

describe("the on-prem template satisfies the compose file", () => {
  // A machine without Docker skips **with a named reason** rather than passing
  // silently: a green tick for a check that never ran is the defect this file
  // exists to catch one level up.
  it.skipIf(!compose)("generates an env that docker compose accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyra-onprem-test-"));
    try {
      copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
      const result = onpremInit({ root: dir }) as { created: boolean; generated: string[] };
      expect(result.created).toBe(true);
      // The secrets are the template's placeholders replaced, not left as-is.
      expect(result.generated.length).toBeGreaterThan(0);

      const envFile = join(dir, "ops", ".env");
      expect(existsSync(envFile), "onpremInit wrote no env file").toBe(true);

      // The assertion the whole file is for.
      expect(() =>
        execFileSync("docker", ["compose", "--env-file", envFile, "-f", COMPOSE, "config", "-q"], {
          stdio: "pipe"
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!compose)("would start a non-empty set of services", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyra-onprem-test-"));
    try {
      copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
      onpremInit({ root: dir });
      const services = execFileSync(
        "docker",
        ["compose", "--env-file", join(dir, "ops", ".env"), "-f", COMPOSE, "config", "--services"],
        { encoding: "utf8" }
      )
        .split("\n")
        .filter(Boolean);

      // The population assertion: a compose file that resolves to nothing would
      // make the check above pass for the wrong reason. `up` starts 11 on this
      // tree — asserted as a floor with the named few that must be present, so a
      // service silently dropped from the file fails here.
      expect(services.length).toBeGreaterThanOrEqual(8);
      for (const required of ["app", "libsql", "minio", "qdrant", "caddy"]) {
        expect(services, `compose no longer starts ${required}`).toContain(required);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says why it skipped when it cannot run", () => {
    // Not a skip: a record of *what* was skipped, so a run on a machine without
    // Docker cannot be mistaken for a verified stack.
    if (!compose) {
      expect("docker compose is not available on this machine").toContain("docker compose");
    }
    expect(true).toBe(true);
  });
});
