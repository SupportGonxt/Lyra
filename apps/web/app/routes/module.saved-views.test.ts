import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { loader } from "./module";

// docs/27 "saved views are written, listed, and never applied", closed — the
// loader is now the reader `GET /v1/analytics/saved-views?route=` was built
// for. ui.md §7.0 has the full contract.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function savedView(overrides: Partial<{ id: string; name: string; isDefault: boolean; queryJson: string }>) {
  return {
    id: "sv_1",
    name: "A view",
    isDefault: false,
    queryJson: "{}",
    ...overrides
  };
}

/** Answers the saved-views call with `views`, and the list call with `rows`. */
function stub(views: ReturnType<typeof savedView>[], rows: unknown[] = []) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes("/v1/analytics/saved-views") ? { data: views } : { data: rows };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    );
  });
}

function args(url: string, module: string, resource: string): any {
  return {
    request: new Request(url),
    params: { module, resource },
    context: { get: () => ({ env, ctx: {} }) }
  };
}

describe("the list loader's saved views", () => {
  it("asks for this resource tab's own route, not a bespoke screen path", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
      );
    });
    await loader(args("https://web.test/ledger/txns", "ledger", "txns"));
    const savedViewsCall = seen.find((u) => u.includes("/v1/analytics/saved-views"));
    expect(savedViewsCall).toContain("route=%2Fledger%2Ftxns");
  });

  it("pre-applies the isDefault view on a pristine first load", async () => {
    stub([savedView({ id: "sv_default", isDefault: true, queryJson: JSON.stringify({ state: "fanned_out" }) })]);
    const result = await loader(args("https://web.test/distribution/quote-requests", "distribution", "quote-requests"));
    expect(result.activeView).toBe("sv_default");
    expect(result.query.state).toBe("fanned_out");
  });

  it("does not override a filter the reader already chose", async () => {
    stub([savedView({ id: "sv_default", isDefault: true, queryJson: JSON.stringify({ state: "fanned_out" }) })]);
    const result = await loader(
      args("https://web.test/distribution/quote-requests?state=open", "distribution", "quote-requests")
    );
    expect(result.activeView).toBeNull();
    expect(result.query.state).toBe("open");
  });

  // The default view used to be inescapable: choosing "All" dropped `view` from
  // the URL, which is pristine, which re-applied the default.
  it("lets the reader opt out of the default with an empty ?view=", async () => {
    stub([savedView({ id: "sv_default", isDefault: true, queryJson: JSON.stringify({ state: "fanned_out" }) })]);
    const result = await loader(
      args("https://web.test/distribution/quote-requests?view=", "distribution", "quote-requests")
    );
    expect(result.activeView).toBeNull();
    expect(result.query.state).toBeUndefined();
  });

  it("applies an explicitly chosen view via ?view=", async () => {
    stub([
      savedView({ id: "sv_a", queryJson: JSON.stringify({ state: "open" }) }),
      savedView({ id: "sv_b", queryJson: JSON.stringify({ state: "complete" }) })
    ]);
    const result = await loader(
      args("https://web.test/distribution/quote-requests?view=sv_b", "distribution", "quote-requests")
    );
    expect(result.activeView).toBe("sv_b");
    expect(result.query.state).toBe("complete");
  });

  it("drops a queryJson key this tab does not recognise instead of forwarding it", async () => {
    // packages/core/src/seed/analytics.ts: the /orbit/renewals view is exactly
    // this shape — {"status":"raised","withinDays":30} where the tab's filter
    // is `state`, not `status`, and `withinDays` names no column at all.
    stub([savedView({ id: "sv_stale", isDefault: true, queryJson: JSON.stringify({ status: "raised", withinDays: 30 }) })]);
    const result = await loader(args("https://web.test/orbit/renewals", "orbit", "renewals"));
    expect(result.activeView).toBe("sv_stale");
    expect(result.query.status).toBeUndefined();
    expect(result.query.withinDays).toBeUndefined();
  });

  it("still renders the list when the actor may not read saved views at all", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/analytics/saved-views")) {
        return Promise.resolve(
          new Response(JSON.stringify({ title: "Not permitted", status: 403 }), {
            status: 403,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
      );
    });
    const result = await loader(args("https://web.test/distribution/quote-requests", "distribution", "quote-requests"));
    expect(result.savedViews).toEqual([]);
    expect(result.activeView).toBeNull();
  });
});
