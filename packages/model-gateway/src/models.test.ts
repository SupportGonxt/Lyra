import { describe, expect, it } from "vitest";
import type { ModelDef } from "./models.js";
import { CATALOGUE, CLOUD_ROUTES, ONPREM_ROUTES, EMBED_MODEL, fallbackChain, resolveModel, costMicro } from "./models.js";

// Temporarily patches CATALOGUE (module-level mutable object) for the duration
// of `run`, then restores the exact original keys/values/order. Lets us force
// catalogue shapes (missing tool-capable model, reordered entries) that don't
// occur in the real table, without touching the source file.
function withPatchedCatalogue(patch: () => void, run: () => void): void {
  const original = { ...CATALOGUE };
  const originalKeys = Object.keys(CATALOGUE);
  try {
    patch();
    run();
  } finally {
    for (const k of Object.keys(CATALOGUE)) delete (CATALOGUE as Record<string, ModelDef>)[k];
    for (const k of originalKeys) (CATALOGUE as Record<string, ModelDef>)[k] = original[k]!;
  }
}

describe("CATALOGUE", () => {
  it("claude-opus-5: anthropic, tool-capable", () => {
    const d = CATALOGUE["claude-opus-5"]!;
    expect(d.provider).toBe("anthropic");
    expect(d.model).toBe("claude-opus-5");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(15_000);
    expect(d.outPer1k).toBe(75_000);
    expect(d.maxTokens).toBe(64_000);
  });

  it("claude-sonnet-5: anthropic, tool-capable", () => {
    const d = CATALOGUE["claude-sonnet-5"]!;
    expect(d.provider).toBe("anthropic");
    expect(d.model).toBe("claude-sonnet-5");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(3_000);
    expect(d.outPer1k).toBe(15_000);
    expect(d.maxTokens).toBe(64_000);
  });

  it("claude-haiku-4-5: anthropic, tool-capable", () => {
    const d = CATALOGUE["claude-haiku-4-5"]!;
    expect(d.provider).toBe("anthropic");
    expect(d.model).toBe("claude-haiku-4-5-20251001");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(800);
    expect(d.outPer1k).toBe(4_000);
    expect(d.maxTokens).toBe(32_000);
  });

  it("llama-3.3-70b: workers-ai, tool-capable", () => {
    const d = CATALOGUE["llama-3.3-70b"]!;
    expect(d.provider).toBe("workers-ai");
    expect(d.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(290);
    expect(d.outPer1k).toBe(2_250);
    expect(d.maxTokens).toBe(8_192);
  });

  it("llama-3.1-8b: workers-ai, no tools", () => {
    const d = CATALOGUE["llama-3.1-8b"]!;
    expect(d.provider).toBe("workers-ai");
    expect(d.model).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
    expect(d.tools).toBe(false);
    expect(d.inPer1k).toBe(28);
    expect(d.outPer1k).toBe(226);
    expect(d.maxTokens).toBe(8_192);
  });

  it("bge-m3: workers-ai embed, no tools", () => {
    const d = CATALOGUE["bge-m3"]!;
    expect(d.provider).toBe("workers-ai");
    expect(d.model).toBe("@cf/baai/bge-m3");
    expect(d.tools).toBe(false);
    expect(d.inPer1k).toBe(12);
    expect(d.outPer1k).toBe(0);
    expect(d.maxTokens).toBe(8_192);
  });

  it("internal-chat: openai-compat, tool-capable, zero cost", () => {
    const d = CATALOGUE["internal-chat"]!;
    expect(d.provider).toBe("openai-compat");
    expect(d.model).toBe("internal-chat");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(0);
    expect(d.outPer1k).toBe(0);
    expect(d.maxTokens).toBe(32_000);
  });

  it("internal-embed: openai-compat, no tools, zero cost", () => {
    const d = CATALOGUE["internal-embed"]!;
    expect(d.provider).toBe("openai-compat");
    expect(d.model).toBe("internal-embed");
    expect(d.tools).toBe(false);
    expect(d.inPer1k).toBe(0);
    expect(d.outPer1k).toBe(0);
    expect(d.maxTokens).toBe(8_192);
  });

  it("ox-alpha: openai-compat OpenRouter model, tool-capable, zero cost", () => {
    const d = CATALOGUE["ox-alpha"]!;
    expect(d.provider).toBe("openai-compat");
    expect(d.model).toBe("stealth/ox-alpha");
    expect(d.tools).toBe(true);
    expect(d.inPer1k).toBe(0);
    expect(d.outPer1k).toBe(0);
    expect(d.maxTokens).toBe(131_072);
  });
});

describe("EMBED_MODEL", () => {
  it("pins cloud and on-prem embed keys", () => {
    expect(EMBED_MODEL.cloud).toBe("bge-m3");
    expect(EMBED_MODEL.onprem).toBe("internal-embed");
  });
});

describe("resolveModel: base routing", () => {
  it("resolves fast to CLOUD_ROUTES.fast", () => {
    expect(resolveModel("fast").key).toBe(CLOUD_ROUTES.fast);
    expect(resolveModel("fast").key).toBe("llama-3.1-8b");
  });

  it("resolves standard to CLOUD_ROUTES.standard", () => {
    expect(resolveModel("standard").key).toBe(CLOUD_ROUTES.standard);
    expect(resolveModel("standard").key).toBe("llama-3.3-70b");
  });

  it("resolves reasoning to CLOUD_ROUTES.reasoning", () => {
    expect(resolveModel("reasoning").key).toBe(CLOUD_ROUTES.reasoning);
    expect(resolveModel("reasoning").key).toBe("llama-3.3-70b");
  });

  it("resolves every tier on-prem via ONPREM_ROUTES with no override", () => {
    for (const tier of ["fast", "standard", "reasoning"] as const) {
      const def = resolveModel(tier, { onPrem: true });
      expect(def.key).toBe(ONPREM_ROUTES[tier]);
      expect(def.key).toBe("internal-chat");
      expect(def.provider).toBe("openai-compat");
    }
  });
});

describe("resolveModel: overrides", () => {
  it("honors a valid override that is not on-prem", () => {
    const def = resolveModel("fast", { overrides: { fast: "claude-sonnet-5" } });
    expect(def.key).toBe("claude-sonnet-5");
    expect(def.provider).toBe("anthropic");
  });

  it("falls back to the base tier route when the override key is unknown", () => {
    const def = resolveModel("standard", { overrides: { standard: "no-such-model" } });
    expect(def.key).toBe(CLOUD_ROUTES.standard);
    expect(def.key).toBe("llama-3.3-70b");
  });

  it("ignores an override for a different tier", () => {
    const def = resolveModel("fast", { overrides: { standard: "claude-opus-5" } });
    expect(def.key).toBe(CLOUD_ROUTES.fast);
  });
});

describe("resolveModel: on-prem pin vs override", () => {
  it("pins on-prem tenants internal even against a cloud-only override", () => {
    const def = resolveModel("reasoning", { onPrem: true, overrides: { reasoning: "claude-opus-5" } });
    expect(def.key).toBe("internal-chat");
    expect(def.provider).toBe("openai-compat");
  });

  it("honors the override when it is already an openai-compat (on-prem) model", () => {
    const def = resolveModel("reasoning", { onPrem: true, overrides: { reasoning: "internal-embed" } });
    expect(def.key).toBe("internal-embed");
    expect(def.provider).toBe("openai-compat");
    expect(def.tools).toBe(false);
  });
});

describe("resolveModel: needsTools", () => {
  it("returns the same model unchanged when it already has tools", () => {
    const def = resolveModel("standard", { needsTools: true });
    expect(def.key).toBe("llama-3.3-70b");
    expect(def.tools).toBe(true);
  });

  it("upgrades to a different same-provider model when the base has no tools", () => {
    expect(CATALOGUE["llama-3.1-8b"]!.tools).toBe(false);
    const def = resolveModel("fast", { needsTools: true });
    expect(def.key).toBe("llama-3.3-70b");
    expect(def.provider).toBe("workers-ai");
    expect(def.tools).toBe(true);
  });

  it("upgrades an on-prem tools-less override within the same provider", () => {
    const def = resolveModel("reasoning", {
      onPrem: true,
      overrides: { reasoning: "internal-embed" },
      needsTools: true
    });
    expect(def.key).toBe("ox-alpha");
    expect(def.provider).toBe("openai-compat");
    expect(def.tools).toBe(true);
  });

  it("throws when no catalogue entry on the provider supports tools", () => {
    withPatchedCatalogue(
      () => {
        delete (CATALOGUE as Record<string, ModelDef>)["llama-3.3-70b"];
      },
      () => {
        expect(() => resolveModel("fast", { needsTools: true })).toThrow(
          "no tool-capable model for provider workers-ai"
        );
      }
    );
  });

  it("skips a tools:false same-provider entry that sorts before the tools:true one", () => {
    // Reorders the workers-ai group so two tools:false entries (llama-3.1-8b,
    // bge-m3) precede the sole tools:true one (llama-3.3-70b) in iteration
    // order. Pins that the upgrade search checks `d.tools`, not merely
    // `d.provider === def.provider` — a provider-only match would stop at the
    // first (tools:false) workers-ai entry instead.
    withPatchedCatalogue(
      () => {
        const seventy = CATALOGUE["llama-3.3-70b"]!;
        delete (CATALOGUE as Record<string, ModelDef>)["llama-3.3-70b"];
        CATALOGUE["llama-3.3-70b"] = seventy;
      },
      () => {
        const def = resolveModel("fast", { needsTools: true });
        expect(def.key).toBe("llama-3.3-70b");
        expect(def.tools).toBe(true);
      }
    );
  });
});

describe("costMicro", () => {
  const cheap: ModelDef = { provider: "workers-ai", model: "m", inPer1k: 100, outPer1k: 200, maxTokens: 10, tools: false };
  const other: ModelDef = { provider: "anthropic", model: "n", inPer1k: 3_000, outPer1k: 15_000, maxTokens: 10, tools: true };

  it("charges only inPer1k when tokensOut is zero", () => {
    // 500 * 100 / 1000 = 50, exact — pins tokensIn * inPer1k against a swap to outPer1k.
    expect(costMicro(cheap, 500, 0)).toBe(50);
  });

  it("charges only outPer1k when tokensIn is zero", () => {
    // 500 * 200 / 1000 = 100, exact.
    expect(costMicro(cheap, 0, 500)).toBe(100);
  });

  it("sums both legs for a different model's pricing", () => {
    // (1000 * 3000 + 500 * 15000) / 1000 = (3_000_000 + 7_500_000) / 1000 = 10_500
    expect(costMicro(other, 1000, 500)).toBe(10_500);
  });

  it("rounds a fractional micro-USD result up, never down", () => {
    // (1 * 100 + 1 * 200) / 1000 = 0.3 -> ceil 1
    expect(costMicro(cheap, 1, 1)).toBe(1);
    // 1 token in at 28/1k (llama-3.1-8b) = 0.028 -> ceil 1
    expect(costMicro(CATALOGUE["llama-3.1-8b"]!, 1, 0)).toBe(1);
  });

  it("returns zero for zero usage", () => {
    expect(costMicro(cheap, 0, 0)).toBe(0);
  });
});

// docs/27 F36. The golden set (evals/provider-fallback) holds the full chain
// per tier; these hold the three properties that make it a *fallback* rather
// than a longer retry.
describe("fallbackChain", () => {
  it("leads with the routing decision and then crosses providers", () => {
    const chain = fallbackChain("standard");
    expect(chain[0]!.key).toBe(CLOUD_ROUTES.standard);
    expect(new Set(chain.map((d) => d.provider)).size).toBe(chain.length);
    expect(chain.length).toBeGreaterThan(1);
  });

  it("is the primary alone on-prem, whatever the tenant override asks for", () => {
    const chain = fallbackChain("reasoning", { onPrem: true, overrides: { reasoning: "claude-opus-5" } });
    expect(chain).toHaveLength(1);
    expect(chain[0]!.provider).toBe("openai-compat");
  });

  it("drops links this deployment holds no credentials for", () => {
    expect(fallbackChain("standard", { configured: ["workers-ai"] }).map((d) => d.key)).toEqual([
      CLOUD_ROUTES.standard
    ]);
  });

  // Never empty: a call that fails against its own model reports something an
  // operator can act on; "no provider" reports nothing.
  it("keeps the primary rather than returning nothing when no link is configured", () => {
    expect(fallbackChain("standard", { configured: [] })).toHaveLength(1);
  });

  it("keeps every link tool-capable when the request carries tools", () => {
    for (const def of fallbackChain("fast", { needsTools: true })) expect(def.tools).toBe(true);
  });
});
