import { afterEach, describe, expect, it, vi } from "vitest";
import { qdrantIndex, toQdrantFilter } from "./qdrant.js";

// ADR on-prem vector: Qdrant standing in for Vectorize. The adapter answers the
// VectorizeIndex shape (upsert + query) the app already calls.

describe("toQdrantFilter", () => {
  it("maps a flat equality filter to a must list", () => {
    expect(toQdrantFilter({ kind: "policy_wording" })).toEqual({
      must: [{ key: "kind", match: { value: "policy_wording" } }]
    });
  });

  it("unwraps a Vectorize $eq value", () => {
    expect(toQdrantFilter({ n: { $eq: 5 } })).toEqual({ must: [{ key: "n", match: { value: 5 } }] });
  });
});

describe("qdrantIndex", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("upserts points with vector and payload", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ result: { status: "completed" } }), { status: 200 });
    });

    const index = qdrantIndex({ url: "http://qdrant:6333/", collection: "kb" });
    await index.upsert([{ id: "v1", values: [0.1, 0.2], metadata: { kind: "policy_wording" } }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://qdrant:6333/collections/kb/points?wait=true");
    expect(calls[0]!.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      points: [{ id: "v1", vector: [0.1, 0.2], payload: { kind: "policy_wording" } }]
    });
  });

  it("searches with vector, limit and filter, and maps matches", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.vector).toEqual([0.1, 0.2]);
      expect(body.limit).toBe(5);
      expect(body.filter).toEqual({ must: [{ key: "kind", match: { value: "policy_wording" } }] });
      return new Response(
        JSON.stringify({ result: [{ id: "v1", score: 0.9, payload: { kind: "policy_wording" } }] }),
        { status: 200 }
      );
    });

    const index = qdrantIndex({ url: "http://qdrant:6333", collection: "kb" });
    const out = await index.query([0.1, 0.2], { topK: 5, filter: { kind: "policy_wording" }, returnMetadata: true });
    expect(out.matches).toEqual([{ id: "v1", score: 0.9, metadata: { kind: "policy_wording" } }]);
  });
});
