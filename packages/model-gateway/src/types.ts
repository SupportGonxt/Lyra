import { z } from "zod";

// docs/02 §5. One interface for every model call in the product, so budget,
// audit and guardrails cannot be bypassed by calling a provider directly.

export const TIERS = ["fast", "standard", "reasoning"] as const;
export type Tier = (typeof TIERS)[number];

export const PROVIDERS = ["workers-ai", "anthropic", "openai-compat", "stub"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const Message = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  /** Set on role=tool so the provider adapter can thread the result back. */
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  /**
   * This turn carries third-party text the tenant did not author — retrieved
   * documents, harvested pages, partner payloads — spliced into a user turn.
   * role=tool is untrusted implicitly; anything else must say so, because the
   * gateway cannot tell an operator's sentence from a corpus excerpt.
   * Stripped before the provider call: it steers guardrails, not the model.
   */
  untrusted: z.boolean().optional()
});
export type Message = z.infer<typeof Message>;

export const ToolDef = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema for the arguments. */
  parameters: z.record(z.string(), z.unknown()),
  /** Consequential tools may not run without an approval (CLAUDE.md rule 4). */
  consequential: z.boolean().default(false)
});
export type ToolDef = z.infer<typeof ToolDef>;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelRequest {
  module: string;
  /** Stable slug: what this call is for. Lands in ai_audit_log and the budget key. */
  purpose: string;
  tier: Tier;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  locale?: string;
  /** What the answer is about — an id the audit trail can join on. */
  subjectRef?: string;
  /** The customer's classified intent this turn, so a reply that talks past it is detectable. */
  intent?: string;
  /** Ask the provider for a JSON object matching this schema. */
  responseSchema?: Record<string, unknown>;
  /** Skip the PII scrubber. Only for prompts built from already-public text. */
  unscrubbed?: boolean;
  /** Stops a runaway retry loop from re-billing the tenant. */
  idempotencyKey?: string;
  /**
   * Vision input, page-rendered document images (AXIS §G.5). Only the Anthropic
   * adapter reads this today — see docs/decisions/ADR-0036.
   */
  images?: { data: string; mimeType: string; page?: number }[];
  /**
   * Bypasses tier routing to name a CATALOGUE key directly, still subject to the
   * on-prem residency pin in resolveModel. For calls (like vision extraction)
   * that need a specific model's capability, not "whatever this tier resolves
   * to today."
   */
  modelKey?: string;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  provider: ProviderName;
  tier: Tier;
  usage: Usage;
  latencyMs: number;
  finishReason: "stop" | "length" | "tool_calls" | "refusal" | "error";
  /** Guardrail rules that fired. Empty on a clean call. */
  flags: string[];
  /** ai_audit_log row id — the handle for explainability surfaces. */
  auditId: string;
}

export interface EmbedRequest {
  module: string;
  purpose: string;
  texts: string[];
  /** bge-m3 handles ar+en in one space, so we do not shard by locale. */
  locale?: string;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  provider: ProviderName;
  usage: Usage;
}

export interface ImageRequest {
  module: string;
  purpose: string;
  /** The creative brief. Screened by checkInput before the provider call (ADR-0060). */
  prompt: string;
  /** What the image is about — an id the audit trail can join on. */
  subjectRef?: string;
}

export interface ImageResponse {
  /** Raw image bytes — the caller writes them to R2 and hashes them. */
  bytes: Uint8Array;
  contentType: string;
  model: string;
  provider: ProviderName;
  usage: Usage;
  /** Guardrail rules that fired on the prompt. Empty on a clean call. */
  flags: string[];
  /** ai_audit_log row id — the handle for explainability surfaces. */
  auditId: string;
}

/** What every provider adapter must implement. Adding one is a new file, not a branch. */
export interface Provider {
  name: ProviderName;
  complete(req: ModelRequest, model: string, env: ProviderEnv): Promise<ProviderResult>;
  embed?(req: EmbedRequest, model: string, env: ProviderEnv): Promise<{ vectors: number[][]; usage: Usage }>;
  /** Only Workers AI implements this today (ADR-0060) — optional so other adapters need no stub method. */
  generateImage?(prompt: string, model: string, env: ProviderEnv): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * docs/27 F35. Incremental completion. Optional, and deliberately so: an
   * adapter that cannot stream is served by `Gateway.stream` calling
   * `complete` and emitting one chunk, so a provider without this is slower
   * rather than unavailable, and the surface above never has two shapes.
   */
  stream?(req: ModelRequest, model: string, env: ProviderEnv): AsyncIterable<ProviderStreamChunk>;
}

/**
 * One step of a streamed completion. Everything but `delta` is optional and
 * arrives when the provider says so — usually on the last chunk, which is why
 * the gateway estimates tokens rather than requiring them.
 */
export interface ProviderStreamChunk {
  delta?: string;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: ToolCall[];
  finishReason?: ModelResponse["finishReason"];
}

/** What `Gateway.stream` yields. */
export type StreamEvent =
  | { type: "delta"; text: string }
  /** Terminal. `response` is the same shape `complete()` returns, audit id and all. */
  | { type: "done"; response: ModelResponse };

export interface ProviderResult {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  finishReason: ModelResponse["finishReason"];
}

/**
 * Bindings and secrets the adapters need. Values arrive from wrangler secrets or
 * Docker env — never from the database, never from a prompt.
 */
export interface ProviderEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  ANTHROPIC_API_KEY?: string;
  /** Cloudflare AI Gateway base, so cost logging and caching apply. */
  AI_GATEWAY_URL?: string;
  /** on-prem vLLM/Ollama, e.g. http://vllm:8000/v1 */
  OPENAI_COMPAT_URL?: string;
  OPENAI_COMPAT_API_KEY?: string;
  fetch?: typeof fetch;
  /** Analytics Engine dataset (docs/10 §2): AI-usage metrics, one point per call. */
  TELEMETRY?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
}
