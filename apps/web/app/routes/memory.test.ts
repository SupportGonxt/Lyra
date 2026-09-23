import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error";
import { cloudflare } from "../context";

// ADR-0085. The resource route behind MemoryPanel. Fixtures are in the shape
// apps/api/src/routes/notes.ts and crud.ts actually send (ui.md §4 rule 10),
// and the refusal paths are tested as the reader who is refused (sighting 6):
// a panel is decoration on a record, so a 403 from any one call must thin the
// panel, never take the record screen down.

const api = vi.fn();
vi.mock("../api.server", async () => {
  const { ApiError } = await import("../api-error");
  return { api: (...args: unknown[]) => api(...args), ApiError };
});

const { loader, action, assemble } = await import("./memory");

function context() {
  const env = { API_ORIGIN: "http://api.test" };
  return { get: (key: unknown) => (key === cloudflare ? { env } : undefined) } as never;
}

const forbidden = () =>
  new ApiError({ title: "Forbidden", status: 403 }, "req_1");

const NOTE = {
  subject: "customer:cu_1",
  note: { id: "nte_1", bodyMd: "Fleet renewal. See [[pol_1|motor]].", version: 3, authorRef: "user:us_1", updatedAt: 1_700_000_000_000 }
};
const LINKS = {
  to: "customer:cu_1",
  links: [{ fromRef: "policy:pol_1", updatedAt: 1_700_000_000_500, module: "axis", resource: "policies", id: "pol_1" }],
  names: { "policy:pol_1": "MTR-0001" }
};
const GRAPH = {
  subject: "customer:cu_1",
  nodes: [
    { ref: "customer:cu_1", depth: 0, module: "core", resource: "customers", id: "cu_1" },
    { ref: "policy:pol_1", depth: 1, module: "axis", resource: "policies", id: "pol_1" }
  ],
  edges: [{ from: "customer:cu_1", to: "policy:pol_1" }],
  truncated: false,
  names: { "customer:cu_1": "Falcon Freight", "policy:pol_1": "MTR-0001" }
};
const MEMORIES = {
  data: [
    {
      id: "mem_1",
      subjectRef: "customer:cu_1",
      kind: "preference",
      contentJson: { preferredChannel: "whatsapp" },
      provenance: "stated_by_customer",
      sensitivity: "low",
      purposesJson: ["orbit.reply"],
      expiry: null,
      createdAt: 1_699_000_000_000
    }
  ]
};

function respond(overrides: Record<string, unknown> = {}) {
  api.mockImplementation(async (path: string) => {
    for (const [prefix, value] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    if (path.startsWith("/v1/core/notes")) return NOTE;
    if (path.startsWith("/v1/core/links")) return LINKS;
    if (path.startsWith("/v1/core/graph")) return GRAPH;
    if (path.startsWith("/v1/core/memories")) return MEMORIES;
    throw new Error(`unexpected ${path}`);
  });
}

const load = async (query: string) =>
  (await (await loader({ request: new Request(`http://web.test/memory?${query}`), params: {}, context: context() } as never)).json()) as ReturnType<typeof assemble> & { available: boolean };

beforeEach(() => {
  api.mockReset();
});

describe("assemble", () => {
  it("names every record the panel shows and knows where each opens", () => {
    const panel = assemble(NOTE, LINKS, GRAPH, MEMORIES.data);
    expect(panel.links).toEqual([{ ref: "policy:pol_1", name: "MTR-0001", href: "/axis/policies/pol_1", updatedAt: 1_700_000_000_500 }]);
    expect(panel.graph.nodes[0]).toMatchObject({ ref: "customer:cu_1", name: "Falcon Freight", href: "/admin/customers/cu_1" });
    // Body links are written with any spelling; the panel knows them by id.
    expect(panel.known.pol_1).toEqual({ name: "MTR-0001", href: "/axis/policies/pol_1" });
  });
});

describe("loader", () => {
  it("asks every call for the canonical subject and the memories under both spellings", async () => {
    respond();
    const panel = await load("subject=cu_1&depth=2");
    expect(panel.available).toBe(true);
    const paths = api.mock.calls.map((call) => call[0] as string);
    expect(paths).toContain("/v1/core/notes?subject=cu_1");
    expect(paths).toContain("/v1/core/graph?subject=customer%3Acu_1&depth=2");
    expect(paths).toContain("/v1/core/links?to=customer%3Acu_1");
    expect(paths.find((p) => p.startsWith("/v1/core/memories"))).toBe(
      "/v1/core/memories?subjectRef=customer%3Acu_1%2Ccu_1&sort=createdAt&order=desc&limit=50"
    );
    expect(panel.memories).toHaveLength(1);
  });

  it("is unavailable, not a crash, for a reader refused the note", async () => {
    respond({ "/v1/core/notes": forbidden() });
    const panel = await load("subject=cu_1");
    expect(panel).toEqual({ available: false, status: 403 });
  });

  it("drops only the memories half for a reader without the settings read", async () => {
    respond({ "/v1/core/memories": forbidden() });
    const panel = await load("subject=cu_1");
    expect(panel.available).toBe(true);
    expect(panel.memories).toBeNull();
    expect(panel.links).toHaveLength(1);
  });

  it("refuses a request with no subject", async () => {
    const res = await loader({ request: new Request("http://web.test/memory"), params: {}, context: context() } as never);
    expect(res.status).toBe(400);
  });
});

describe("action", () => {
  const post = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return action({ request: new Request("http://web.test/memory", { method: "POST", body }), params: {}, context: context() } as never);
  };

  it("saves with the version the editor loaded", async () => {
    api.mockResolvedValue(NOTE);
    const out = await post({ intent: "save", subject: "cu_1", bodyMd: "hi", version: "3" });
    expect(api).toHaveBeenCalledWith("/v1/core/notes?subject=cu_1", expect.objectContaining({ method: "PUT", body: { bodyMd: "hi", version: 3 } }));
    expect(out).toEqual({ ok: true });
  });

  it("answers a 409 as a conflict the panel can explain", async () => {
    api.mockRejectedValue(new ApiError({ title: "Conflict", status: 409 }, "req_2"));
    expect(await post({ intent: "save", subject: "cu_1", bodyMd: "hi", version: "1" })).toEqual({ conflict: true });
  });

  it("forgets one memory through the memories resource", async () => {
    api.mockResolvedValue(undefined);
    expect(await post({ intent: "forget", id: "mem_1" })).toEqual({ ok: true });
    expect(api).toHaveBeenCalledWith("/v1/core/memories/mem_1", expect.objectContaining({ method: "DELETE" }));
  });
});
