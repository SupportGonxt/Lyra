import type { BrowserBinding } from "../engines/export/render.js";

// docs/11 §3 — the on-prem render adapter: the browserless/chromium container
// standing in for Cloudflare Browser Rendering. The rest of the app talks to a
// virtual `https://browser-rendering/v1/...` host through the `BrowserBinding`
// contract (engines/export/render.ts); this file answers that contract with
// browserless's own `/pdf` endpoint. node.ts binds `BROWSER` here when
// `RENDER_URL` is set — unbound, Arabic PDFs fall back to the in-process writer
// (ADR-0115) and vision extraction fails closed with "no browser binding".

export interface RenderBindingOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
}

export function renderBinding(options: RenderBindingOptions): BrowserBinding {
  const base = options.url.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const auth = options.token ? `?token=${encodeURIComponent(options.token)}` : "";

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/v1/pdf") {
        const body = (await req.json()) as { html?: string; pdfOptions?: { landscape?: boolean; printBackground?: boolean } };
        const res = await doFetch(`${base}/pdf${auth}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            html: body.html ?? "",
            options: {
              landscape: body.pdfOptions?.landscape ?? true,
              printBackground: body.pdfOptions?.printBackground ?? true
            }
          })
        });
        // Pass the bytes and the status through untouched: the caller renders
        // res.arrayBuffer() and treats a non-2xx as its own failure.
        return res;
      }

      if (url.pathname === "/v1/screenshot") {
        // Vision extraction rasterizes a PDF page. Browserless's /screenshot
        // renders HTML, not a PDF page, so this verb needs a browserless
        // function — fail closed rather than return a wrong image.
        return new Response("on-prem vision rendering (pdf to image) is not wired to the render service", {
          status: 501,
          headers: { "content-type": "text/plain" }
        });
      }

      return new Response("unknown render endpoint", { status: 404 });
    }
  };
}
