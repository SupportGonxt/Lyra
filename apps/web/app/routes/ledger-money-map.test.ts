import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMoney } from "@lyra/ui";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { LABELS, labelsIn, layoutMap, loader, moneyMapHeadline } from "./ledger-money-map";

// Two things are worth pinning here: what the loader is willing to ask the API
// for (a role that cannot read client money still gets the map), and the
// arithmetic that turns six figures into a diagram. Everything else on the
// screen is the API's numbers rendered as-is.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Replies keyed by a substring of the URL — every call here carries a query string. */
function stubFetchByUrl(replies: Array<[string, Response]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    const match = replies.find(([part]) => url.includes(part));
    return Promise.resolve(match ? match[1].clone() : json({ data: [] }));
  });
  return calls;
}

function me(permissions: string[]) {
  return json({ actor: {}, permissions, roles: [], nav: [] });
}

const MAP = {
  periodCode: "2026-06",
  currency: "AED",
  asOf: 1,
  nodes: [],
  links: [],
  carriedMinor: 0
};

function loaderArgs(search = ""): LoaderFunctionArgs {
  return {
    request: new Request(`https://web.test/ledger/money-map${search}`),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as LoaderFunctionArgs;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loader", () => {
  it("refuses without the journal permission, and does not call the report", async () => {
    const calls = stubFetchByUrl([["/v1/me", me(["ledger:client_money:read"])]]);

    expect(await loader(loaderArgs())).toEqual({ denied: true });
    expect(calls.some((url) => url.includes("value-flow"))).toBe(false);
  });

  it("draws the map for a role that cannot read client money, and hides the bar", async () => {
    const calls = stubFetchByUrl([
      ["/v1/me", me(["ledger:journals:read"])],
      ["/reports/value-flow?", json(MAP)]
    ]);

    const loaded = await loader(loaderArgs());

    expect(loaded).toMatchObject({ denied: false, clientMoney: null });
    expect(calls.some((url) => url.includes("client-money"))).toBe(false);
  });

  it("asks for lines only when a node is open, and passes the period through", async () => {
    const calls = stubFetchByUrl([
      ["/v1/me", me(["ledger:journals:read"])],
      ["/reports/value-flow?", json(MAP)],
      ["/value-flow/lines", json({ node: "tax", periodCode: "2026-06", currency: "AED", totalMinor: 0, lines: [] })]
    ]);

    await loader(loaderArgs("?period=2026-06"));
    expect(calls.some((url) => url.includes("value-flow/lines"))).toBe(false);

    const opened = await loader(loaderArgs("?period=2026-06&node=tax"));
    const lines = calls.find((url) => url.includes("value-flow/lines"));
    expect(lines).toContain("period=2026-06");
    expect(lines).toContain("node=tax");
    expect(opened).toMatchObject({ drilled: { node: "tax" } });
  });

  // The file has to be the answer to the question on screen: the download
  // carries the same period and currency the map was read with, and ends on a
  // separator so the view only names the format.
  it("hands the view an export address carrying the filters it read the map with", async () => {
    stubFetchByUrl([
      ["/v1/me", me(["ledger:journals:read"])],
      ["/reports/value-flow?", json(MAP)]
    ]);

    const loaded = await loader(loaderArgs("?period=2026-06&currency=aed"));
    expect(loaded).toMatchObject({ denied: false });
    const url = (loaded as { exportUrl: string }).exportUrl;
    expect(url.startsWith("https://api.test/v1/ledger/reports/value-flow/export?")).toBe(true);
    expect(url).toContain("period=2026-06");
    expect(url).toContain("currency=AED");
    expect(url.endsWith("&")).toBe(true);
  });

  it("still ends on a separator when no filter was given", async () => {
    stubFetchByUrl([
      ["/v1/me", me(["ledger:journals:read"])],
      ["/reports/value-flow?", json(MAP)]
    ]);

    const loaded = await loader(loaderArgs());
    expect((loaded as { exportUrl: string }).exportUrl).toBe(
      "https://api.test/v1/ledger/reports/value-flow/export?"
    );
  });
});

describe("layoutMap", () => {
  const map = {
    periodCode: "2026-06",
    currency: "AED",
    asOf: 1,
    carriedMinor: 20_000,
    nodes: [
      { key: "premium-in", amountMinor: 100_000, drill: { accountCodes: ["1010"], side: "debit", txnTypes: [] } },
      { key: "insurer-remittance", amountMinor: 70_000, drill: { accountCodes: ["2010"], side: "debit", txnTypes: [] } },
      { key: "commission-retained", amountMinor: 10_000, drill: { accountCodes: ["2010"], side: "debit", txnTypes: [] } },
      { key: "still-held", amountMinor: 20_000 },
      { key: "partner-share", amountMinor: 4_000, drill: { accountCodes: ["2100"], side: "credit", txnTypes: [] } },
      { key: "tax", amountMinor: 1_000, drill: { accountCodes: ["2200"], side: "credit", txnTypes: [] } },
      { key: "net", amountMinor: 5_000, drill: { accountCodes: ["4000"], side: "credit", txnTypes: [] } }
    ],
    links: [
      { from: "premium-in", to: "insurer-remittance", amountMinor: 70_000 },
      { from: "premium-in", to: "commission-retained", amountMinor: 10_000 },
      { from: "premium-in", to: "still-held", amountMinor: 20_000 },
      { from: "commission-retained", to: "partner-share", amountMinor: 4_000 },
      { from: "commission-retained", to: "tax", amountMinor: 1_000 },
      { from: "commission-retained", to: "net", amountMinor: 5_000 }
    ]
  };

  it("puts every column on one scale, so a slice never looks like the whole", () => {
    const laid = layoutMap(map, 800, 400);
    const at = (key: string) => laid.nodes.find((n) => n.key === key)!;

    expect(at("premium-in").x).toBe(0);
    expect(at("insurer-remittance").x).toBe(at("still-held").x);
    expect(at("tax").x).toBeGreaterThan(at("insurer-remittance").x);
    // 1,000 out of 100,000 — a per-column scale would have drawn it as tall as
    // the premium it came out of.
    expect(at("tax").height).toBeLessThan(at("premium-in").height / 50);
  });

  it("uses up a node's face exactly: what leaves it equals what it holds", () => {
    const laid = layoutMap(map, 800, 400);
    const premium = laid.nodes.find((n) => n.key === "premium-in")!;
    const out = laid.links.filter((l) => l.from === "premium-in").reduce((s, l) => s + l.width, 0);

    expect(out).toBeCloseTo(premium.height, 5);
  });

  it("leaves out a node with nothing in it, and the ribbons that would dangle from it", () => {
    const empty = {
      ...map,
      nodes: map.nodes.map((n) => (n.key === "tax" ? { ...n, amountMinor: 0 } : n))
    };

    const laid = layoutMap(empty, 800, 400);
    expect(laid.nodes.some((n) => n.key === "tax")).toBe(false);
    expect(laid.links.some((l) => l.to === "tax")).toBe(false);
  });

  it("marks the remainder node as having nothing to open", () => {
    const laid = layoutMap(map, 800, 400);
    expect(laid.nodes.find((n) => n.key === "still-held")!.drillable).toBe(false);
    expect(laid.nodes.find((n) => n.key === "premium-in")!.drillable).toBe(true);
  });
});

describe("moneyMapHeadline", () => {
  const l = labelsIn("en");

  it("puts a client-money breach above everything else", () => {
    expect(moneyMapHeadline(MAP, [{ currency: "AED" }, { currency: "ZAR" }], l, "en")).toBe(
      "2 currency breach(es) in client money."
    );
  });

  it("says the map's own net figure when nothing is breached", () => {
    const withNet = { ...MAP, nodes: [{ key: "net", amountMinor: 5_000 }] };
    expect(moneyMapHeadline(withNet, [], l, "en")).toBe(
      `Net to the business for 2026-06: ${formatMoney(5_000, "AED", "en")}.`
    );
  });

  it("falls back to the empty-period copy when there is no net node", () => {
    expect(moneyMapHeadline(MAP, [], l, "en")).toBe("Nothing was posted in this period");
  });
});

describe("ledger-money-map labelsIn", () => {
  it("translates every English key into Arabic", () => {
    const missing = Object.keys(LABELS.en!).filter((key) => !(key in LABELS.ar!));
    expect(missing).toEqual([]);
  });
});
