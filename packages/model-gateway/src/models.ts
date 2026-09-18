import type { ProviderName, Tier } from "./types.js";

// The routing table. Changing a model is a one-line edit here, never in a
// caller — callers only ever ask for a tier.

export interface ModelDef {
  provider: ProviderName;
  model: string;
  /** micro-USD per 1,000 tokens. costMicro on ai_audit_log is micro-USD. */
  inPer1k: number;
  outPer1k: number;
  maxTokens: number;
  tools: boolean;
}

export const CATALOGUE: Record<string, ModelDef> = {
  "claude-opus-5": { provider: "anthropic", model: "claude-opus-5", inPer1k: 15_000, outPer1k: 75_000, maxTokens: 64_000, tools: true },
  "claude-sonnet-5": { provider: "anthropic", model: "claude-sonnet-5", inPer1k: 3_000, outPer1k: 15_000, maxTokens: 64_000, tools: true },
  "claude-haiku-4-5": { provider: "anthropic", model: "claude-haiku-4-5-20251001", inPer1k: 800, outPer1k: 4_000, maxTokens: 32_000, tools: true },
  "llama-3.3-70b": { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inPer1k: 290, outPer1k: 2_250, maxTokens: 8_192, tools: true },
  "llama-3.1-8b": { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct-fast", inPer1k: 28, outPer1k: 226, maxTokens: 8_192, tools: false },
  "bge-m3": { provider: "workers-ai", model: "@cf/baai/bge-m3", inPer1k: 12, outPer1k: 0, maxTokens: 8_192, tools: false },
  // OpenRouter is OpenAI-compatible at the HTTP layer, so it fits the same
  // provider adapter as on-prem vLLM/Ollama, but with a hosted model slug.
  "ox-alpha": { provider: "openai-compat", model: "stealth/ox-alpha", inPer1k: 0, outPer1k: 0, maxTokens: 131_072, tools: true },
  // On-prem: whatever vLLM serves. Cost is the tenant's own hardware, so zero.
  "internal-chat": { provider: "openai-compat", model: "internal-chat", inPer1k: 0, outPer1k: 0, maxTokens: 32_000, tools: true },
  "internal-embed": { provider: "openai-compat", model: "internal-embed", inPer1k: 0, outPer1k: 0, maxTokens: 8_192, tools: false }
};

/**
 * Cloud default: Workers AI on every tier. No third-party key to hold, no egress,
 * and the AI binding is already in the Worker. The Anthropic adapter stays wired
 * up and reachable through a tenant override for the tiers that later need it.
 */
export const CLOUD_ROUTES: Record<Tier, string> = {
  fast: "llama-3.1-8b",
  standard: "llama-3.3-70b",
  reasoning: "llama-3.3-70b"
};

/** On-prem tenants send nothing to a third party — every tier goes internal. */
export const ONPREM_ROUTES: Record<Tier, string> = {
  fast: "internal-chat",
  standard: "internal-chat",
  reasoning: "internal-chat"
};

export const EMBED_MODEL = { cloud: "bge-m3", onprem: "internal-embed" } as const;

export interface ImageModelDef {
  provider: ProviderName;
  model: string;
  /** micro-USD per image — one round trip, no input/output token split (ADR-0060). */
  costMicroPerImage: number;
}

// Cloudflare's published FLUX.1 [schnell] price is $0.0000528 per step at the
// model's fixed 4 steps — the same $0.000211/image quoted in Workers AI
// pricing docs at the time of writing. Re-check against current pricing if
// the catalogue price and Cloudflare's invoiced usage ever diverge.
export const IMAGE_CATALOGUE: Record<string, ImageModelDef> = {
  "flux-schnell": { provider: "workers-ai", model: "@cf/black-forest-labs/flux-1-schnell", costMicroPerImage: 211 }
};

export const IMAGE_MODEL = { cloud: "flux-schnell" } as const;

export interface RouteOptions {
  /** PolicyJson.dataResidency === "on-prem" pins every tier internal. */
  onPrem?: boolean;
  /** Tenant override: tier -> catalogue key. Unknown keys are ignored, not obeyed. */
  overrides?: Partial<Record<Tier, string>>;
  /** The request carries tools, so a model without tool support cannot serve it. */
  needsTools?: boolean;
  /** ModelRequest.modelKey: names a CATALOGUE entry directly, skipping tier/override lookup. */
  modelKey?: string;
}

export function resolveModel(tier: Tier, opts: RouteOptions = {}): ModelDef & { key: string } {
  const base = opts.onPrem ? ONPREM_ROUTES : CLOUD_ROUTES;
  const override = opts.overrides?.[tier];
  let key =
    opts.modelKey && CATALOGUE[opts.modelKey] ? opts.modelKey : override && CATALOGUE[override] ? override : base[tier];
  let def = CATALOGUE[key];
  if (!def) throw new Error(`no model for tier ${tier}`);

  // ponytail: an on-prem tenant with a cloud override is a data-residency breach,
  // so the pin wins over the override rather than the other way round.
  if (opts.onPrem && def.provider !== "openai-compat") {
    key = ONPREM_ROUTES[tier];
    def = CATALOGUE[key]!;
  }

  // Silently dropping tools would look like the model ignoring an instruction.
  // Upgrade within the same provider instead, and let the cost land where it must.
  if (opts.needsTools && !def.tools) {
    const upgrade = Object.entries(CATALOGUE).find(([, d]) => d.provider === def!.provider && d.tools);
    if (!upgrade) throw new Error(`no tool-capable model for provider ${def.provider}`);
    return { key: upgrade[0], ...upgrade[1] };
  }

  return { key, ...def };
}

/**
 * docs/27 F36. Ordered alternatives per tier, consulted only when the primary
 * provider has failed every retry. Keys, not providers: a fallback has to name
 * a model, and "the same tier at another vendor" is a judgement about capability
 * that belongs in this table beside the routes it mirrors.
 *
 * The chain builder drops any entry sharing the primary's provider, so a list
 * may safely mention the same vendor more than once for different tiers — what
 * it may never do is serve as a second attempt at the vendor that just failed,
 * which is exactly what the three identical retries were.
 */
export const CLOUD_FALLBACKS: Record<Tier, string[]> = {
  fast: ["claude-haiku-4-5", "ox-alpha"],
  standard: ["claude-sonnet-5", "ox-alpha"],
  reasoning: ["claude-opus-5", "ox-alpha"]
};

export interface ChainOptions extends RouteOptions {
  /**
   * Providers this deployment actually holds credentials or bindings for.
   * Omitted means "assume everything" (tests and the pure routing question);
   * the gateway always passes the real set, because a link with no API key is
   * not a fallback, it is a guaranteed second failure and a wasted second of
   * a customer's wait.
   */
  configured?: readonly ProviderName[];
}

/**
 * The ordered list of models a single logical call may be served by: the
 * routing decision first, then cross-provider alternatives.
 *
 * Two invariants the eval (evals/provider-fallback) holds and this function
 * exists to make checkable:
 *
 * 1. **On-prem never falls back off-prem.** An outage is not a reason to send a
 *    tenant's prompts to a third party, so an on-prem chain is the primary
 *    alone. `resolveModel` already pins the primary internal even against a
 *    tenant override; this is the same rule applied to the recovery path, which
 *    is where a residency breach would otherwise be invisible.
 * 2. **One link per provider.** Re-asking the vendor that just failed is the
 *    defect, not the fix.
 *
 * Never empty: if filtering by `configured` would remove everything, the
 * primary stays, so the call fails against its own model with its own error
 * rather than against "no provider", which tells an operator nothing.
 */
export function fallbackChain(tier: Tier, opts: ChainOptions = {}): (ModelDef & { key: string })[] {
  const primary = resolveModel(tier, opts);
  if (opts.onPrem) return [primary];

  const seen = new Set<ProviderName>([primary.provider]);
  const chain = [primary];
  // The tier's own cloud route leads the candidates, not just the declared
  // alternatives. A tenant override or a `modelKey` moves the *primary* off it,
  // and without this the platform default — the one model we know is bound,
  // priced and exercised — would be the single route a fallback could never
  // reach. It is skipped by the provider de-dupe whenever it *is* the primary.
  for (const key of [CLOUD_ROUTES[tier], ...CLOUD_FALLBACKS[tier]]) {
    const def = CATALOGUE[key];
    if (!def) continue;
    if (seen.has(def.provider)) continue;
    if (opts.needsTools && !def.tools) continue;
    seen.add(def.provider);
    chain.push({ key, ...def });
  }

  if (!opts.configured) return chain;
  const usable = chain.filter((d) => opts.configured!.includes(d.provider));
  return usable.length ? usable : [primary];
}

/** micro-USD, rounded up so a tenant is never under-billed against its budget. */
export function costMicro(def: ModelDef, tokensIn: number, tokensOut: number): number {
  return Math.ceil((tokensIn * def.inPer1k + tokensOut * def.outPer1k) / 1000);
}
