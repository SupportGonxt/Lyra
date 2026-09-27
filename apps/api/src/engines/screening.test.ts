import { describe, expect, it } from "vitest";
import { openSanctions, screeningFor, stubScreening } from "./screening.js";

// ADR-0095. The screening seam had one implementation that consulted nothing.
// A real list now sits behind it for the kinds OpenSanctions covers; the stub
// still answers where no list is configured, and says so on every hit.

type Call = { url: string; auth: string | null; body: any };

function stubFetch(status: number, reply: unknown) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const results = (...rows: Array<{ id: string; caption: string; score: number; match: boolean; datasets?: string[] }>) => ({
  responses: { q: { status: 200, results: rows.map((r) => ({ schema: "Person", datasets: ["un_sc_sanctions"], ...r })) } }
});

describe("openSanctions", () => {
  it("asks the sanctions collection for a person by name and the identifiers that narrow it", async () => {
    const { f, calls } = stubFetch(200, results());
    const provider = openSanctions({ apiKey: "k-1", fetch: f });
    await provider.screen({ kind: "sanctions", name: "jane doe", identifiers: { birthDate: "1980-02-01", nationality: "ae", note: "ignored" } });
    expect(calls[0]!.url).toBe("https://api.opensanctions.org/match/sanctions");
    expect(calls[0]!.auth).toBe("ApiKey k-1");
    expect(calls[0]!.body).toEqual({
      queries: { q: { schema: "Person", properties: { name: ["jane doe"], birthDate: ["1980-02-01"], nationality: ["ae"] } } }
    });
  });

  it("reads PEPs from the peps collection, a company as a Company, and a self-hosted yente by its URL", async () => {
    const { f, calls } = stubFetch(200, results());
    await openSanctions({ apiKey: "k", baseUrl: "http://yente:8000/", fetch: f }).screen({ kind: "pep", name: "acme llc", identifiers: { entityType: "company" } });
    expect(calls[0]!.url).toBe("http://yente:8000/match/peps");
    expect(calls[0]!.body.queries.q.schema).toBe("Company");
  });

  it("is a hit when the list says match, and carries what matched", async () => {
    const { f } = stubFetch(200, results({ id: "Q1", caption: "Jane Doe", score: 0.93, match: true }, { id: "Q2", caption: "J. Dough", score: 0.4, match: false }));
    const out = await openSanctions({ apiKey: "k", fetch: f }).screen({ kind: "sanctions", name: "jane doe", identifiers: {} });
    expect(out.result).toBe("hit");
    expect(out.hits).toEqual([
      { listRef: "opensanctions:Q1", matchedName: "Jane Doe", matchPct: 93, note: "un_sc_sanctions", stub: false }
    ]);
  });

  it("is inconclusive on a close score the list would not call, and clear on nothing close", async () => {
    const close = stubFetch(200, results({ id: "Q3", caption: "Jane Do", score: 0.74, match: false }));
    expect((await openSanctions({ apiKey: "k", fetch: close.f }).screen({ kind: "sanctions", name: "jane doe", identifiers: {} })).result).toBe("inconclusive");
    const far = stubFetch(200, results({ id: "Q4", caption: "Someone Else", score: 0.2, match: false }));
    expect(await openSanctions({ apiKey: "k", fetch: far.f }).screen({ kind: "sanctions", name: "jane doe", identifiers: {} })).toEqual({ result: "clear", hits: [] });
  });

  it("never reads a failed call as clear", async () => {
    const { f } = stubFetch(503, { detail: "down" });
    await expect(openSanctions({ apiKey: "k", fetch: f }).screen({ kind: "sanctions", name: "jane doe", identifiers: {} })).rejects.toMatchObject({ status: 502 });
  });
});

describe("screeningFor", () => {
  it("uses the list for sanctions and PEPs once a key or a self-hosted URL is set, and the labelled stub otherwise", () => {
    expect(screeningFor({}, "sanctions")).toBe(stubScreening);
    expect(screeningFor({ OPENSANCTIONS_API_KEY: "k" }, "sanctions").name).toBe("opensanctions");
    expect(screeningFor({ OPENSANCTIONS_URL: "http://yente:8000" }, "pep").name).toBe("opensanctions");
    // Adverse media and fraud are not what the list covers.
    expect(screeningFor({ OPENSANCTIONS_API_KEY: "k" }, "adverse_media")).toBe(stubScreening);
  });
});
