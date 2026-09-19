import { describe, expect, it } from "vitest";
import { extractNumbers, normalizeDigits, verifyGroundedness } from "./narrator-verify.js";

describe("verifyGroundedness", () => {
  it("passes text whose numbers all trace back to the context", () => {
    const result = verifyGroundedness(
      "The claim is valued at 5000 AED and was opened on 2026-01-05.",
      ["Case CAS-1: kind claim, status review, priority high, opened 2026-01-05, value 5000 AED."]
    );
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it("flags a number the context never gave it", () => {
    const result = verifyGroundedness(
      "The claim is valued at 99999 AED.",
      ["Case CAS-1: kind claim, status review, priority high, opened 2026-01-05, value 5000 AED."]
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([99999]);
  });

  it("passes text with no numeric claims at all", () => {
    const result = verifyGroundedness("This case looks routine.", ["Case CAS-1: kind claim, status review."]);
    expect(result).toEqual({ ok: true, mismatches: [] });
  });
});

// docs/27 F46. The failure this pins is not "Arabic scores worse" — it is that
// an unreadable sentence scored *clean*. Before normalisation an Arabic-Indic
// briefing yielded zero numbers, so `mismatches` was empty and every verifier
// built on `extractNumbers` reported ok for any fabrication in it. A golden per
// separator, because an ICU or hand-written renderer emits each of them.
describe("numbers written in Arabic", () => {
  it.each([
    ["Arabic-Indic digits", "١٢٣٤٥", 12345],
    ["Extended Arabic-Indic digits", "۱۲۳۴۵", 12345],
    ["the Arabic decimal separator", "٨٧٫٥", 87.5],
    ["the Arabic thousands separator", "١٢٬٣٤٥", 12345]
  ])("reads %s", (_name, written, expected) => {
    expect(extractNumbers(written)).toEqual([expected]);
  });

  it("does not let a bidi mark split one number into two", () => {
    // Intl interleaves U+200F with Arabic currency output; left in, "١٢٣٤٥"
    // arrives as two numbers that each match nothing in the snapshot.
    expect(extractNumbers("‏١٢٣‏٤٥ درهم")).toEqual([12345]);
  });

  it("reads a sentence that mixes both scripts, as a translated briefing does", () => {
    expect(extractNumbers("بلغ 12345 درهمًا على ١٥٢٣ وثيقة")).toEqual([12345, 1523]);
  });

  it("leaves Latin digits and ordinary punctuation exactly as they were", () => {
    expect(normalizeDigits("1,234.50 on 2026-01-05")).toBe("1,234.50 on 2026-01-05");
  });

  // docs/27 F42 and F46 are one finding seen from two ends: the renderer and
  // the verifier have to agree about what a digit is. This is the join — the
  // exact string `Intl` puts on an ar-SA screen, handed to the function the
  // briefing gate runs on. The UI half is pinned in packages/ui/src/ui.test.ts.
  it("reads back exactly what an ar-SA screen renders", () => {
    expect(extractNumbers(new Intl.NumberFormat("ar-SA").format(1523))).toEqual([1523]);
    expect(
      extractNumbers(new Intl.NumberFormat("ar-SA", { style: "currency", currency: "AED" }).format(1234.5))
    ).toEqual([1234.5]);
  });

  it("catches a fabrication stated in Arabic digits", () => {
    const context = ["Case CAS-1: value 5000 AED."];
    expect(verifyGroundedness("قيمة هذه القضية ٥٠٠٠ درهم.", context).ok).toBe(true);
    expect(verifyGroundedness("قيمة هذه القضية ٨٢٠٠ درهم.", context)).toEqual({
      ok: false,
      mismatches: [8200]
    });
  });
});
