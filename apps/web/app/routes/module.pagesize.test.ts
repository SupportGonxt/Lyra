import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { PAGE_SIZES, loader, pageSizeIn } from "./module";

// Every list screen paged 50 rows at a time and offered no way to say
// otherwise, while the API has taken a `limit` since it was written
// (apps/api/src/http.ts ListQuery). docs/ui.md §7.6.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Records the API URLs the loader asks for and answers every one with a page. */
function capture(): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  });
  return seen;
}


function args(url: string): any {
  return {
    request: new Request(url),
    params: { module: "admin", resource: "users" },
    context: { get: () => ({ env, ctx: {} }) }
  };
}

describe("pageSizeIn", () => {
  it("takes a size the picker actually offers", () => {
    for (const size of PAGE_SIZES) {
      expect(pageSizeIn(new URLSearchParams(`limit=${size}`))).toBe(size);
    }
  });

  it("ignores anything else rather than passing it to the API", () => {
    // A hand-typed `?limit=10000` is not a page size, it is a way to ask the
    // API for the whole tenant; the API caps it, and this refuses it first.
    expect(pageSizeIn(new URLSearchParams("limit=10000"))).toBeNull();
    expect(pageSizeIn(new URLSearchParams("limit=0"))).toBeNull();
    expect(pageSizeIn(new URLSearchParams("limit=fifty"))).toBeNull();
    expect(pageSizeIn(new URLSearchParams())).toBeNull();
  });
});

describe("the list loader", () => {
  it("asks the API for the size the actor chose", async () => {
    // Two calls now leave the loader: the list itself, and the saved-views
    // lookup (docs/27 "saved views are written, listed, and never applied").
    // The size only ever belongs on the list call, so find it by its own path
    // rather than assume which one fired first.
    const seen = capture();
    await loader(args("https://web.test/admin/users?limit=100"));
    expect(seen.find((url) => url.includes("/v1/core/users"))).toContain("limit=100");
  });

  it("says nothing about limit when nobody chose one", async () => {
    const seen = capture();
    await loader(args("https://web.test/admin/users"));
    expect(seen.find((url) => url.includes("/v1/core/users"))).not.toContain("limit=");
  });
});
