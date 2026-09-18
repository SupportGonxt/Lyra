import type { EmbedRequest, ModelRequest, Provider, ProviderEnv, ProviderResult, ProviderStreamChunk, ToolCall, Usage } from "../types.js";
import { sseData, sseJson } from "./sse.js";

// Cloudflare Workers AI via the `AI` binding — no key, no egress, runs beside
// the Worker. Default provider for every tier (docs/02 §5).

interface RunResult {
  // Under `response_format: json_schema` the model's answer comes back already
  // parsed — an object, not a string — so this is deliberately `unknown`.
  response?: unknown;
  result?: { response?: unknown };
  tool_calls?: { name: string; arguments?: Record<string, unknown> }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  data?: number[][];
  /** flux-1-schnell's response shape: base64-encoded PNG bytes. */
  image?: string;
}

/** `atob` is a Workers-global; no Buffer in this runtime. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function textOf(out: RunResult): string {
  const raw =
    out.response && typeof out.response === "object" && "response" in out.response
      ? (out.response as { response?: unknown }).response
      : (out.response ?? out.result?.response);
  if (typeof raw === "string") return raw;
  if (raw === undefined || raw === null) return "";
  // Every caller of a schema'd completion parses the text back to JSON
  // (extract.ts, fraud.ts, reserve.ts, sla.ts, triage.ts), and the guardrails
  // in between are string checks — so re-serialise rather than hand an object
  // downstream as if it were text.
  return JSON.stringify(raw);
}

export const workersAi: Provider = {
  name: "workers-ai",

  async complete(req: ModelRequest, model: string, env: ProviderEnv): Promise<ProviderResult> {
    if (!env.AI) throw new Error("workers-ai: AI binding missing");
    const input: Record<string, unknown> = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2
    };
    if (req.tools?.length) {
      input["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }
    if (req.responseSchema) {
      input["response_format"] = { type: "json_schema", json_schema: req.responseSchema };
    }

    const out = (await env.AI.run(model, input)) as RunResult;
    const text = textOf(out);
    const toolCalls: ToolCall[] = (out.tool_calls ?? []).map((c, i) => ({
      id: `tc_${i}`,
      name: c.name,
      args: c.arguments ?? {}
    }));

    return {
      text,
      toolCalls,
      // Workers AI omits usage on some models; estimate rather than bill zero.
      tokensIn: out.usage?.prompt_tokens ?? estimate(req.messages.map((m) => m.content).join(" ")),
      tokensOut: out.usage?.completion_tokens ?? estimate(text),
      finishReason: toolCalls.length ? "tool_calls" : "stop"
    };
  },

  /**
   * docs/27 F35. Workers AI streams by returning a `ReadableStream` of SSE from
   * the same binding rather than a JSON object, so the only difference from
   * `complete` is `stream: true` and who parses the body.
   *
   * Tools are deliberately not sent here. A streamed tool call arrives as
   * fragments of a JSON argument string that have to be reassembled before they
   * mean anything, and a half-parsed argument to a consequential tool is the
   * one failure mode this codebase least wants — so the agent loop's
   * tool-bearing rounds go through `complete()` and only the answer streams.
   * This is a real limit, written down rather than discovered later.
   */
  async *stream(req: ModelRequest, model: string, env: ProviderEnv): AsyncGenerator<ProviderStreamChunk> {
    if (!env.AI) throw new Error("workers-ai: AI binding missing");
    const out = (await env.AI.run(model, {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      stream: true
    })) as unknown;

    // Not every model honours `stream: true`; one that answers with the plain
    // object is served as a single chunk rather than as an error.
    if (!(out instanceof ReadableStream)) {
      const text = textOf(out as RunResult);
      yield { delta: text, tokensOut: estimate(text), finishReason: "stop" };
      return;
    }

    let text = "";
    for await (const payload of sseData(out as ReadableStream<Uint8Array>)) {
      const json = sseJson<{ response?: string }>(payload);
      if (!json?.response) continue;
      text += json.response;
      yield { delta: json.response };
    }
    yield {
      tokensIn: estimate(req.messages.map((m) => m.content).join(" ")),
      tokensOut: estimate(text),
      finishReason: "stop"
    };
  },

  async embed(req: EmbedRequest, model: string, env: ProviderEnv): Promise<{ vectors: number[][]; usage: Usage }> {
    if (!env.AI) throw new Error("workers-ai: AI binding missing");
    const out = (await env.AI.run(model, { text: req.texts })) as RunResult;
    const vectors = out.data ?? [];
    if (vectors.length !== req.texts.length) {
      throw new Error(`workers-ai embed: expected ${req.texts.length} vectors, got ${vectors.length}`);
    }
    return {
      vectors,
      usage: { tokensIn: estimate(req.texts.join(" ")), tokensOut: 0, costMicro: 0 }
    };
  },

  async generateImage(prompt: string, model: string, env: ProviderEnv): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (!env.AI) throw new Error("workers-ai: AI binding missing");
    const out = (await env.AI.run(model, { prompt })) as RunResult;
    if (!out.image) throw new Error("workers-ai: no image in response");
    return { bytes: base64ToBytes(out.image), contentType: "image/png" };
  }
};

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}
