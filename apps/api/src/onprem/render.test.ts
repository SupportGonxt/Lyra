import { afterEach, describe, expect, it, vi } from "vitest";
import { renderBinding } from "./render.js";

// ADR on-prem render: the browserless container standing in for Cloudflare
// Browser Rendering. The adapter answers the virtual `browser-rendering/v1/pdf`
// host the export engine already talks to.

describe("renderBinding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps /v1/pdf onto browserless /pdf with the html and options", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response("PDFBYTES", { status: 200, headers: { "content-type": "application/pdf" } });
    });

    const binding = renderBinding({ url: "http://render:3000/", token: "secret" });
    const res = await binding.fetch(
      new Request("https://browser-rendering/v1/pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: "<html>مرحبا</html>", pdfOptions: { landscape: false, printBackground: true } })
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://render:3000/pdf?token=secret");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      html: "<html>مرحبا</html>",
      options: { landscape: false, printBackground: true }
    });
    expect(await res.text()).toBe("PDFBYTES");
  });

  it("fails closed for the pdf-to-image screenshot verb", async () => {
    const binding = renderBinding({ url: "http://render:3000", token: "secret" });
    const res = await binding.fetch(
      new Request("https://browser-rendering/v1/screenshot", {
        method: "POST",
        body: JSON.stringify({ pdf: "BASE64", page: 1 })
      })
    );
    expect(res.status).toBe(501);
  });

  it("404s an unknown render endpoint", async () => {
    const binding = renderBinding({ url: "http://render:3000" });
    const res = await binding.fetch(new Request("https://browser-rendering/v1/unknown"));
    expect(res.status).toBe(404);
  });
});
