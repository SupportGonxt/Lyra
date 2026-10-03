import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// docs/27 F14 follow-up. `clientMoneyReceipt` could clear the premium the bind
// booked on 1200 only if its caller passed `clearsReceivableAccount`, and no
// caller ever did — a parameter no caller passes (CLAUDE.md, dead seams). So
// 1200 was debited at every bind and credited by nothing. The fix is one
// builder, `premiumReceiptLines` (packages/ledger/src/premium-receipt.ts), that
// asks the ledger what is open and clears it. This holds every source file to
// routing a premium receipt through it.
//
// It selects its own subjects, so it partitions them (CLAUDE.md, "a guard that
// selects its own subjects must assert that it selected all of them"): every
// file naming a premium-receipt type, every non-literal `buildRecipe(` call and
// every mention of the clearing arguments is either checked or excluded for a
// named reason, and the leftover bucket must be empty. Exclusions that no
// longer match anything fail too, so the list cannot rot into a free pass.

const REPO = join(import.meta.dirname, "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/agents/src", "packages"].map((r) => join(REPO, r));
const RECEIPT_TYPES = ["CM-RECEIPT", "PREM-COLLECT", "PREM-INSTALMENT"];

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "migrations") return [];
        const path = join(dir, e.name);
        if (e.isDirectory()) return walk(path);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [path] : [];
      });

const SOURCES = [...new Set(ROOTS.flatMap(walk))].map((path) => ({
  file: relative(REPO, path),
  text: readFileSync(path, "utf8")
}));

/** Files that name a receipt type for a reason other than building one. */
const NAMES_A_RECEIPT_TYPE: Record<string, string> = {
  "packages/ledger/src/recipes.ts": "declares the recipes the builder calls",
  "packages/ledger/src/types.ts": "declares the transaction type registry",
  "packages/ledger/src/premium-receipt.ts": "is the builder",
  "packages/core/src/seed/history.ts": "writes seeded rows directly; seeded binds book no 1200 leg, so there is nothing to clear",
  "packages/core/src/seed/ledger.ts": "writes seeded rows directly; seeded binds book no 1200 leg, so there is nothing to clear"
};

/** Files that call `buildRecipe(<expression>)` and so could build any type. */
const DYNAMIC_BUILD: Record<string, string> = {
  "packages/ledger/src/premium-receipt.ts": "is the builder",
  "apps/api/src/routes/ledger.ts": "the generic money endpoint; premium receipts branch to premiumReceiptLines first"
};

/** The clearing arguments are the builder's to decide, nobody else's. */
const CLEARING_ARGS = /\b(clearsReceivableAccount|clearsReceivableMinor|receivableDims)\b/;
const MAY_NAME_CLEARING = new Set(["packages/ledger/src/recipes.ts", "packages/ledger/src/premium-receipt.ts"]);

describe("every premium receipt goes through premiumReceiptLines", () => {
  it("builds no premium receipt from a literal type outside the builder", () => {
    const literal = new RegExp(`buildRecipe\\(\\s*["'](${RECEIPT_TYPES.join("|")})["']`);
    const offenders = SOURCES.filter((s) => literal.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("classifies every file that names a receipt type", () => {
    const named = new RegExp(`["'](${RECEIPT_TYPES.join("|")})["']`);
    const files = SOURCES.filter((s) => named.test(s.text)).map((s) => s.file);
    const builders = files.filter((f) => SOURCES.find((s) => s.file === f)!.text.includes("premiumReceiptLines("));
    const unclassified = files.filter((f) => !(f in NAMES_A_RECEIPT_TYPE) && !builders.includes(f));
    expect(unclassified).toEqual([]);
    // The engine that collects instalments is one of the builders, not an exception.
    expect(builders).toContain("apps/api/src/engines/premium-financing.ts");
    const stale = Object.keys(NAMES_A_RECEIPT_TYPE).filter((f) => !files.includes(f));
    expect(stale).toEqual([]);
  });

  it("lets a dynamic buildRecipe call exist only where premium receipts branch away first", () => {
    const dynamic = /buildRecipe\(\s*(?!["'])[A-Za-z_]/;
    const files = SOURCES.filter((s) => dynamic.test(s.text.replace(/^\s*(\*|\/\/).*$/gm, ""))).map((s) => s.file);
    const callers = files.filter((f) => f !== "packages/ledger/src/recipes.ts");
    expect(callers.filter((f) => !(f in DYNAMIC_BUILD))).toEqual([]);
    for (const f of callers) {
      const text = SOURCES.find((s) => s.file === f)!.text;
      if (f === "packages/ledger/src/premium-receipt.ts") continue;
      expect(text, `${f} must route premium receipts to the builder`).toMatch(/isPremiumReceipt\(/);
      expect(text, `${f} must route premium receipts to the builder`).toMatch(/premiumReceiptLines\(/);
    }
    expect(Object.keys(DYNAMIC_BUILD).filter((f) => !callers.includes(f))).toEqual([]);
  });

  it("leaves the clearing arguments to the builder", () => {
    const offenders = SOURCES.filter((s) => !MAY_NAME_CLEARING.has(s.file) && CLEARING_ARGS.test(s.text)).map(
      (s) => s.file
    );
    expect(offenders).toEqual([]);
  });

  it("calls the receipt recipe directly nowhere but the registry", () => {
    const offenders = SOURCES.filter(
      (s) => s.file !== "packages/ledger/src/recipes.ts" && /\bclientMoneyReceipt\(/.test(s.text)
    ).map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
