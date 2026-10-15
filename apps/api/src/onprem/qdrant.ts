import type { VectorizeIndex } from "../env.js";

// docs/11 §3 — the on-prem vector adapter: Qdrant standing in for Vectorize.
// The rest of the app talks to a VectorizeIndex-shaped object (`upsert` +
// `query`); this file answers that shape with Qdrant's REST API. node.ts binds
// VEC_KB / VEC_MARKET / VEC_CONVO here when `QDRANT_URL` is set — unbound,
// retrieval falls back to the deterministic lexical scorer (orbit-kb.ts), so
// vectors are a quality upgrade, never a hard dependency.

export interface QdrantIndexOptions {
  url: string;
  collection: string;
  fetch?: typeof fetch;
}

/** Vectorize's flat `{ field: value }` filter to Qdrant's `must` list — equality only. */
export function toQdrantFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const must = Object.entries(filter).map(([key, value]) => ({
    key,
    match: { value: value && typeof value === "object" && "$eq" in value ? (value as { $eq: unknown }).$eq : value }
  }));
  return { must };
}

export function qdrantIndex(options: QdrantIndexOptions): VectorizeIndex {
  const base = options.url.replace(/\/$/, "");
  const collection = encodeURIComponent(options.collection);
  const doFetch = options.fetch ?? fetch;

  return {
    async upsert(vectors) {
      if (vectors.length === 0) return;
      const res = await doFetch(`${base}/collections/${collection}/points?wait=true`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          points: vectors.map((v) => ({
            id: v.id,
            vector: v.values,
            ...(v.metadata ? { payload: v.metadata } : {})
          }))
        })
      });
      if (!res.ok) throw new Error(`qdrant upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },

    async query(vector, opts) {
      const body: Record<string, unknown> = {
        vector,
        limit: opts.topK,
        ...(opts.returnMetadata ? { with_payload: true } : {})
      };
      if (opts.filter && Object.keys(opts.filter).length) body["filter"] = toQdrantFilter(opts.filter);

      const res = await doFetch(`${base}/collections/${collection}/points/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`qdrant query ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { result?: { id: string; score: number; payload?: Record<string, unknown> }[] };
      return {
        matches: (json.result ?? []).map((r) => ({
          id: r.id,
          score: r.score,
          ...(r.payload ? { metadata: r.payload } : {})
        }))
      };
    }
  };
}
