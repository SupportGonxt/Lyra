import { describe, expect, it } from "vitest";
import { aletheia } from "./aletheia.js";
import type { ModelRequest, ProviderEnv } from "../types.js";

// ADR-0118. The adapter's whole job is to keep the proof payload (epistemic
// coverage + facts + ood) instead of reducing Aletheia's answer to prose, and
// to turn "I won't guess" into the gateway's refusal path rather than an empty
// answer that looks grounded.

function req(lastUser = "what is our revenue?"): ModelRequest {
  return {
    module: "north",
    purpose: "briefing.narrate",
    tier: "reasoning",
    messages: [
      { role: "system", content: "You answer from the tenant fact graph." },
      { role: "user", content: lastUser }
    ]
  };
}

function env(payload: unknown, url = "http://cortex0:8000"): ProviderEnv {
  const fetchMock: typeof fetch = async (input) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...(target.startsWith(url) ? {} : {})
    });
  };
  return { ALETHEIA_URL: url, fetch: fetchMock };
}

const completeProof = {
  query: "what is our revenue?",
  answer: "Total revenue is R26,057,181,587.",
  epistemic_coverage: { ratio: 1.0, matched: 1, required: 1, state: "complete" },
  facts_retrieved: [
    { fact_id: "F1", entity: "Acme", attribute: "revenue", value: 26057181587.0, source: "VBRK.NETWR" }
  ],
  contradictions: [],
  confidence: 0.95,
  ood: false,
  sampling_used: false
};

describe("aletheia.complete", () => {
  it("parses the proof payload into grounding and returns the answer", async () => {
    const out = await aletheia.complete(req(), "cortex0/lyra", env(completeProof));
    expect(out.text).toBe("Total revenue is R26,057,181,587.");
    expect(out.finishReason).toBe("stop");
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
    expect(out.grounding).toMatchObject({
      epistemicCoverage: 1,
      state: "complete",
      ood: false,
      samplingUsed: false,
      facts: [
        { factId: "F1", entity: "Acme", attribute: "revenue", value: 26057181587.0, source: "VBRK.NETWR" }
      ]
    });
  });

  it("targets the tenant named by the model slug", async () => {
    const calls: string[] = [];
    const e = env(completeProof);
    const original = e.fetch!;
    e.fetch = async (input) => {
      calls.push(typeof input === "string" ? input : String(input));
      return original!(input);
    };
    await aletheia.complete(req(), "cortex0/acme", e);
    expect(calls[0]).toContain("/api/acme/chat?q=");
  });

  it("prefers the tenant the gateway stamped over the model slug", async () => {
    const calls: string[] = [];
    const e = env(completeProof);
    const original = e.fetch!;
    e.fetch = async (input) => {
      calls.push(typeof input === "string" ? input : String(input));
      return original!(input);
    };
    await aletheia.complete({ ...req(), tenantId: "t_7" }, "cortex0/acme", e);
    expect(calls[0]).toContain("/api/t_7/chat?q=");
  });

  it("turns out-of-distribution into a refusal, not an empty answer", async () => {
    const out = await aletheia.complete(req(), "cortex0/lyra", env({ ...completeProof, ood: true, answer: "" }));
    expect(out.text).toBe("");
    expect(out.finishReason).toBe("refusal");
    expect(out.grounding?.ood).toBe(true);
  });

  it("turns insufficient coverage into a refusal with the gap recorded", async () => {
    const out = await aletheia.complete(
      req(),
      "cortex0/lyra",
      env({ ...completeProof, epistemic_coverage: { ratio: 0.4, state: "insufficient" }, answer: "" })
    );
    expect(out.finishReason).toBe("refusal");
    expect(out.grounding?.state).toBe("insufficient");
    expect(out.grounding?.epistemicCoverage).toBe(0.4);
  });

  it("fails loudly on a non-2xx instead of guessing", async () => {
    const bad: ProviderEnv = {
      ALETHEIA_URL: "http://cortex0:8000",
      fetch: async () => new Response(JSON.stringify({ error: { message: "tenant unknown" } }), { status: 404 })
    };
    await expect(aletheia.complete(req(), "cortex0/lyra", bad)).rejects.toThrow(/404/);
  });

  it("requires ALETHEIA_URL", async () => {
    await expect(aletheia.complete(req(), "cortex0/lyra", {})).rejects.toThrow("ALETHEIA_URL missing");
  });

  it("requires a user query to ground", async () => {
    const noUser: ModelRequest = { ...req(), messages: [{ role: "system", content: "nothing to ask" }] };
    await expect(aletheia.complete(noUser, "cortex0/lyra", env(completeProof))).rejects.toThrow("no user query");
  });
});
