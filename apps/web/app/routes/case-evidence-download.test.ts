import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { loader } from "./case-evidence-download";

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function loaderArgs(bundleId = "evb_1"): LoaderFunctionArgs {
  return {
    request: new Request(`https://web.test/axis/cases/cas_1/evidence-bundles/${bundleId}/download`),
    context: { get: () => ({ env, ctx: null }) },
    params: { id: "cas_1", bundleId }
  } as unknown as LoaderFunctionArgs;
}

describe("case evidence download loader", () => {
  it("proxies the bundle bytes with the API's content-type", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    let requestedUrl = "";
    vi.stubGlobal("fetch", (input: URL | string) => {
      requestedUrl = String(input);
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=bundle.zip" }
        })
      );
    });

    const response = await loader(loaderArgs());

    expect(requestedUrl).toBe("https://api.test/v1/axis/cases/cas_1/audit-bundle/evb_1/download");
    expect(response.headers.get("content-type")).toBe("application/zip");
    // application/zip is outside the render-safe allowlist, so disposition is
    // forced to attachment — but the upstream filename must survive that, or
    // the browser falls back to guessing a name for the download.
    expect(response.headers.get("content-disposition")).toBe('attachment; filename=bundle.zip');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("encodes the bundle id rather than splicing it raw into the upstream path", async () => {
    let requestedUrl = "";
    vi.stubGlobal("fetch", (input: URL | string) => {
      requestedUrl = String(input);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await loader(loaderArgs("evb/1 a"));

    expect(requestedUrl).toBe("https://api.test/v1/axis/cases/cas_1/audit-bundle/evb%2F1%20a/download");
  });

  // Regression: a raw `Response` here drops the security headers withHeaders
  // (apps/api/src/mw.ts) normally sets, and this loader was also missing
  // cache-control: no-store outright (present on the sibling axis-document-file loader).
  it("sets the security headers apps/api's withHeaders would have set", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=bundle.zip" }
        })
    );

    const res = await loader(loaderArgs());

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("forces attachment for a content-type outside the render-safe allowlist, even if upstream said inline", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/html", "content-disposition": "inline" }
        })
    );

    const res = await loader(loaderArgs());

    expect(res.headers.get("content-disposition")).toBe("attachment");
  });
});
