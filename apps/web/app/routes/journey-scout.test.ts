import { describe, expect, it, vi } from "vitest";

vi.mock("../api.server", () => ({ api: vi.fn(), asRouteError: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { labelsIn, loader, matchesLine, pickWhitespace, rankForLine } from "./journey-scout";

/** One element of GET /v1/scout/whitespaces/commentary, in the server's shape. */
const ws = (whitespaceId: string, category: string | null, extra: Record<string, unknown> = {}) => ({
  whitespaceId,
  category,
  status: "candidate",
  commentary: `${category ?? "?"} is under-served.`,
  why: ["Demand signals behind this candidate: 4"],
  ai: null,
  suppressed: false,
  ...extra
});

describe("rankForLine", () => {
  it("puts the carried product line's whitespace first and keeps the rest in order", () => {
    const rows = [ws("a", "Home contents"), ws("b", "EV motor cover"), ws("c", null), ws("d", "Motor fleet")];
    expect(rankForLine(rows, "motor").map((r) => r.whitespaceId)).toEqual(["b", "d", "a", "c"]);
    expect(rankForLine(rows, "").map((r) => r.whitespaceId)).toEqual(["a", "b", "c", "d"]);
  });

  it("matches on the category, never on a missing one", () => {
    expect(matchesLine("EV motor cover", "motor")).toBe(true);
    expect(matchesLine(null, "motor")).toBe(false);
    expect(matchesLine("Home", "")).toBe(false);
  });
});

describe("pickWhitespace", () => {
  // The step always took rows[0], so the reader never chose what Marketing
  // would draft against. The choice now lives in the URL.
  it("takes the one the reader chose, else the top-ranked", () => {
    const rows = [ws("a", "Home"), ws("b", "Motor")];
    expect(pickWhitespace(rows, "b")?.whitespaceId).toBe("b");
    expect(pickWhitespace(rows, "gone")?.whitespaceId).toBe("a");
    expect(pickWhitespace(rows, "")?.whitespaceId).toBe("a");
    expect(pickWhitespace([], "a")).toBeNull();
  });
});

describe("loader", () => {
  const args = (search: string) =>
    ({
      request: new Request(`https://lyra.test/journey/scout${search}`),
      context: { get: () => ({ env: {} }) },
      params: {}
    }) as never;

  it("reads the briefing it was handed and the whitespace the reader chose", async () => {
    const calls = vi.mocked(api);
    calls.mockReset();
    calls.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/scout/whitespaces/commentary")) {
        return { data: [ws("a", "Home"), ws("b", "EV motor cover"), ws("s", "Thin", { suppressed: true })] };
      }
      if (path === "/v1/north/briefings/brf_1") return { id: "brf_1", date: "2026-08-12", audience: "exec" };
      throw new Error(`unexpected ${path}`);
    });
    const result = await loader(args("?productLine=motor&briefingId=brf_1&whitespaceId=a"));
    expect(result.rows.map((r) => r.whitespaceId)).toEqual(["b", "a"]);
    expect(result.chosenId).toBe("a");
    expect(result.briefing).toMatchObject({ id: "brf_1", date: "2026-08-12" });
  });

  it("walks on without the briefing when the reader may not read it", async () => {
    const { ApiError } = await import("../api-error");
    const calls = vi.mocked(api);
    calls.mockReset();
    calls.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/scout/whitespaces/commentary")) return { data: [ws("a", "Home")] };
      throw new ApiError({ title: "forbidden", status: 403 }, "req_1");
    });
    const result = await loader(args("?briefingId=brf_1"));
    expect(result.briefing).toBeNull();
    expect(result.rows).toHaveLength(1);
  });
});

describe("labels", () => {
  it("name every whitespace status in both languages", () => {
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      for (const status of ["candidate", "validating", "validated", "parked"]) {
        expect(l(`status.${status}`)).not.toBe(`status.${status}`);
      }
    }
  });
});
