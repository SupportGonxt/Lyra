import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A Ctx never carries the Worker env: `ctxFor` does not set one. SIGNAL's
// first-contact send read `(ctx as Ctx & { env })`.env, found nothing in
// production, and so could not open a connector's sealed secrets — while its
// tests passed, because the fixture put the env on the ctx (the fixture
// supplying what production lacked, CLAUDE.md sighting 6). Pass env
// explicitly; this holds every source file to it.

const SRC = join(import.meta.dirname);
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
  );

describe("no reader takes the Worker env off a Ctx", () => {
  it("finds no cast that grafts env onto Ctx, in source or tests", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("ctx-env.guard.test.ts"))
      .filter((f) => /Ctx\s*&\s*\{\s*env\??:/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
