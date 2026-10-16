import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.server", () => ({ api: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { labelsIn, loader } from "./north-compliance-posture";

const fakeContext = () => ({ get: () => ({ env: {} }) }) as never;
const call = () => loader({ request: new Request("https://lyra.test/north/compliance-posture"), context: fakeContext() } as never);

describe("north-compliance-posture loader", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the posture from the API rather than composing it here", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      controls: [{ key: "ai_logging", evidence: "live", value: "9,021 AI runs logged", source: "ai_audit" }]
    });
    const result = (await call()) as { controls: { key: string }[] };
    const url = vi.mocked(api).mock.calls[0]?.[0] as string;
    expect(url).toBe("/v1/north/compliance-posture");
    expect(result.controls).toHaveLength(1);
  });

  it("gives a reader without the permission an empty posture, not a crash", async () => {
    // `readable()` answers null on 403 — the screen exists for `tenant.compliance`,
    // and the taper is the empty state rather than a stack trace.
    vi.mocked(api).mockResolvedValueOnce(null);
    const result = (await call()) as { controls: unknown[] };
    expect(result.controls).toEqual([]);
  });
});

describe("north-compliance-posture labels", () => {
  it("names every control docs/12 §5 lists, in both locales", () => {
    // A missing key renders as the raw key inside a table, and this screen's
    // whole value is that a reader can tell counted evidence from a document.
    const keys = [
      "tenancy_isolation",
      "consent_enforcement",
      "disclosure",
      "ai_logging",
      "verification",
      "breach",
      "retention"
    ];
    for (const locale of ["en", "ar"] as const) {
      const l = labelsIn(locale);
      for (const key of keys) {
        expect(l(`control.${key}`)).not.toBe(`control.${key}`);
      }
    }
  });

  it("spells the two kinds of evidence differently, because they are different", () => {
    const en = labelsIn("en");
    expect(en("evidence.live")).not.toBe(en("evidence.on_file"));
    const ar = labelsIn("ar");
    expect(ar("evidence.live")).not.toBe(ar("evidence.on_file"));
  });
});
