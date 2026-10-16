import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SEC-008: fast local gate against committed credentials. gitleaks in
// .github/workflows/security.yml is the deep scan; this one fails in <1s so a
// developer never gets to `git push` with a token in the diff.

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();

// ponytail: canonical vendor formats, not "any high-entropy string" — the
// entropy heuristic is gitleaks' job and it false-positives on hashes/base64
// fixtures. Add a pattern here when a new provider's token shape ships.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Cloudflare API token (cfat_)", /cfat_[A-Za-z0-9_-]{20,}/],
  ["Cloudflare API token (v1.0-)", /v1\.0-[A-Za-z0-9]{20,}/],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["Private key header", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
];

// Synthetic tokens that exist so a test can prove they get destroyed. Keyed on
// the exact literal, not file:line — line numbers drift, and a real leaked
// credential will never equal one of these strings.
const ALLOWLIST = new Set([
  // packages/model-gateway/src/gateway.test.ts — "destroys secrets rather than
  // placeholding them"; the scrubber fixture must look like a real token.
  "cfat_Z7kFeYokfDSr9qwDsORFNMcH7rhl",
  // packages/model-gateway/evals/compliance/cases.jsonl cmp-05 — the eval
  // proves a key-shaped string in model output gets blocked.
  "sk-ant-abcd1234efgh5678ijkl",
  // apps/api/src/onprem/s3.test.ts — the SigV4 signer is pinned on its canonical
  // request and credential scope, so the fixture has to be a well-formed key id.
  // This is AWS's **own published example** from the SigV4 documentation, not a
  // credential, and its secret pair is the equally published
  // `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
  "AKIAIOSFODNN7EXAMPLE",
]);

const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|woff2?|ttf|otf|zip|gz|wasm)$/;

// Files whose whole purpose is to contain token-shaped fixtures: this gate
// itself, and the scrubber's test (its PEM-header fixture is byte-identical
// to a real one, so a literal allowlist cannot hold it).
const SKIP_FILES = ["apps/api/src/security.test.ts", "packages/model-gateway/src/scrub.test.ts"];

const TRACKED = execSync("git ls-files apps packages", {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\n")
  .filter((f) => f && !SKIP.test(f) && !SKIP_FILES.some((s) => f.endsWith(s)));

describe("no committed secrets", () => {
  it("enumerates tracked source files", () => {
    expect(TRACKED.length).toBeGreaterThan(0);
  });

  it("finds no secret-shaped strings under apps/ and packages/", () => {
    const hits: string[] = [];

    for (const file of TRACKED) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), "utf8");
      } catch {
        continue; // deleted-but-tracked, or unreadable
      }
      if (text.includes("\u0000")) continue; // binary

      text.split("\n").forEach((line, i) => {
        for (const [label, pattern] of SECRET_PATTERNS) {
          const m = line.match(pattern);
          if (m && !ALLOWLIST.has(m[0])) hits.push(`${file}:${i + 1}: ${label}`);
        }
      });
    }

    expect(hits, `secret-shaped strings found:\n${hits.join("\n")}`).toEqual([]);
  });
});
