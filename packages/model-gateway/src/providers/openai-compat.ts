import type { EmbedRequest, ModelRequest, Provider, ProviderEnv, ProviderResult, ProviderStreamChunk, ToolCall, Usage } from "../types.js";
import { sseData, sseJson } from "./sse.js";

// The on-prem twin (docs/02 §8): vLLM or Ollama behind an OpenAI-shaped API on
// the tenant's own network. No key leaves the estate; no request leaves the VPC.

interface ChatResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}
interface StreamDelta {
  choices?: { delta?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
interface EmbedResponseBody {
  data?: { embedding: number[] }[];
  usage?: { prompt_tokens?: number };
  error?: { message?: string };
}

const FINISH: Record<string, ProviderResult["finishReason"]> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "refusal"
};

function headers(env: ProviderEnv): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (env.OPENAI_COMPAT_API_KEY) h["authorization"] = `Bearer ${env.OPENAI_COMPAT_API_KEY}`;
  return h;
}

function base(env: ProviderEnv): string {
  if (!env.OPENAI_COMPAT_URL) throw new Error("openai-compat: OPENAI_COMPAT_URL missing");
  return env.OPENAI_COMPAT_URL.replace(/\/$/, "");
}

export const openaiCompat: Provider = {
  name: "openai-compat",

  async complete(req: ModelRequest, model: string, env: ProviderEnv): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      messages: req.messages.map((m) =>
        m.role === "tool"
          ? { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" }
          : { role: m.role, content: m.content }
      )
    };
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }
    if (req.responseSchema) {
      body["response_format"] = { type: "json_schema", json_schema: req.responseSchema };
    }

    const doFetch = env.fetch ?? fetch;
    const res = await doFetch(`${base(env)}/chat/completions`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify(body)
    });
    const json = (await res.json()) as ChatResponse;
    if (!res.ok) throw new Error(`openai-compat ${res.status}: ${json.error?.message ?? "request failed"}`);

    const choice = json.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `tc_${i}`,
      name: c.function?.name ?? "",
      args: safeParse(c.function?.arguments)
    }));

    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      finishReason: FINISH[choice?.finish_reason ?? "stop"] ?? "stop"
    };
  },

  /**
   * docs/27 F35. The same request with `stream: true`, read as SSE.
   *
   * `stream_options.include_usage` asks for the usage block vLLM and OpenRouter
   * otherwise omit from a streamed response — without it every streamed call
   * would be billed on an estimate, and the budget ledger would drift from the
   * invoice in one direction only.
   */
  async *stream(req: ModelRequest, model: string, env: ProviderEnv): AsyncGenerator<ProviderStreamChunk> {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      messages: req.messages.map((m) =>
        m.role === "tool"
          ? { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" }
          : { role: m.role, content: m.content }
      )
    };
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }

    const doFetch = env.fetch ?? fetch;
    const res = await doFetch(`${base(env)}/chat/completions`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify(body)
    });
    if (!res.ok || !res.body) throw new Error(`openai-compat ${res.status}: stream request failed`);

    for await (const payload of sseData(res.body)) {
      const json = sseJson<StreamDelta>(payload);
      if (!json) continue;
      const choice = json.choices?.[0];
      const out: ProviderStreamChunk = {};
      if (choice?.delta?.content) out.delta = choice.delta.content;
      if (choice?.finish_reason) out.finishReason = FINISH[choice.finish_reason] ?? "stop";
      if (json.usage) {
        out.tokensIn = json.usage.prompt_tokens ?? 0;
        out.tokensOut = json.usage.completion_tokens ?? 0;
      }
      if (out.delta || out.finishReason || out.tokensIn != null) yield out;
    }
  },

  async embed(req: EmbedRequest, model: string, env: ProviderEnv): Promise<{ vectors: number[][]; usage: Usage }> {
    const doFetch = env.fetch ?? fetch;
    const res = await doFetch(`${base(env)}/embeddings`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ model, input: req.texts })
    });
    const json = (await res.json()) as EmbedResponseBody;
    if (!res.ok) throw new Error(`openai-compat ${res.status}: ${json.error?.message ?? "request failed"}`);
    return {
      vectors: (json.data ?? []).map((d) => d.embedding),
      usage: { tokensIn: json.usage?.prompt_tokens ?? 0, tokensOut: 0, costMicro: 0 }
    };
  }
};

/** A model can emit malformed JSON args; a bad tool call must not kill the response. */
function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _unparsed: raw };
  }
}
