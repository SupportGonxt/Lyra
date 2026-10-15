import type { GroundingFact, GroundingProof, ModelRequest, Provider, ProviderEnv, ProviderResult } from "../types.js";

// ADR-0118. Aletheia (cortex0) is a deterministic grounded-intelligence engine,
// not an LLM: it assembles an answer from a fact graph instead of sampling
// tokens, and returns a proof payload (answer + epistemic coverage + facts +
// contradictions + ood). This adapter calls its native proof endpoint so the
// provenance reaches the caller rather than being reduced to prose.
//
// No `stream`/`embed`: the engine does neither, and the gateway's `oneChunk`
// serves a streamed request as a single chunk — slower, never wrong.

interface ProofPayload {
  query?: string;
  answer?: string;
  epistemic_coverage?: { ratio?: number; state?: string };
  facts_retrieved?: { fact_id?: string; entity?: string; attribute?: string; value?: unknown; source?: string }[];
  contradictions?: string[];
  ood?: boolean;
  sampling_used?: boolean;
  error?: { message?: string };
}

function base(env: ProviderEnv): string {
  if (!env.ALETHEIA_URL) throw new Error("aletheia: ALETHEIA_URL missing");
  return env.ALETHEIA_URL.replace(/\/$/, "");
}

/**
 * The Aletheia tenant to address, in priority order: the tenant the gateway
 * stamped on the request (ADR-0118 per-tenant mapping), the `cortex0/{tenant}`
 * model slug, then `ALETHEIA_TENANT`, then a single-tenant default.
 */
function tenantOf(req: ModelRequest, model: string, env: ProviderEnv): string {
  if (req.tenantId) return req.tenantId;
  if (model.startsWith("cortex0/")) return model.slice("cortex0/".length);
  return env.ALETHEIA_TENANT || "lyra";
}

/** The grounded query is the last user turn — the question, not the transcript. */
function queryOf(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === "user") return req.messages[i]!.content;
  }
  return "";
}

function toGrounding(p: ProofPayload): GroundingProof {
  const ratio = clamp(p.epistemic_coverage?.ratio ?? 0);
  const raw = p.epistemic_coverage?.state ?? "insufficient";
  const state: GroundingProof["state"] =
    raw === "complete" || raw === "partial" ? raw : "insufficient";
  const facts: GroundingFact[] = (p.facts_retrieved ?? []).map((f) => ({
    factId: f.fact_id ?? "",
    entity: f.entity ?? "",
    attribute: f.attribute ?? "",
    value: f.value,
    source: f.source ?? ""
  }));
  return {
    epistemicCoverage: ratio,
    state,
    facts,
    contradictions: p.contradictions ?? [],
    ood: p.ood === true,
    samplingUsed: p.sampling_used === true
  };
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export const aletheia: Provider = {
  name: "aletheia",

  async complete(req: ModelRequest, model: string, env: ProviderEnv): Promise<ProviderResult> {
    const query = queryOf(req);
    if (!query.trim()) throw new Error("aletheia: no user query to ground");

    const doFetch = env.fetch ?? fetch;
    const url = `${base(env)}/api/${encodeURIComponent(tenantOf(req, model, env))}/chat?q=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (env.ALETHEIA_TOKEN) headers["authorization"] = `Bearer ${env.ALETHEIA_TOKEN}`;

    const res = await doFetch(url, { method: "GET", headers });
    const json = (await res.json()) as ProofPayload;
    if (!res.ok) throw new Error(`aletheia ${res.status}: ${json.error?.message ?? "request failed"}`);

    const grounding = toGrounding(json);
    // Refuse-to-guess becomes the gateway's refusal path: an out-of-distribution
    // or insufficient answer must not surface an empty string as if it were a
    // grounded one. The caller reads `grounding` to see exactly what is missing.
    const refused = grounding.ood || grounding.state === "insufficient";

    return {
      text: refused ? "" : (json.answer ?? ""),
      toolCalls: [],
      // A graph lookup, not a token sample: zero tokens, zero cost (ADR-0118).
      tokensIn: 0,
      tokensOut: 0,
      finishReason: refused ? "refusal" : "stop",
      grounding
    };
  }
};
