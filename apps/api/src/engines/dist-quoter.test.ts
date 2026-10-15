import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "@lyra/core";
import type { schema } from "@lyra/db";
import { quoteOne, type PanelEntry } from "./rating.js";
import { quoterFor } from "./dist-quoter.js";
import type { Env } from "../env.js";

// The live-underwriter half of the rating seam (docs/16 "build to the seams",
// ADR-0070). Every test here runs against a mock carrier stubbed into `fetch` —
// nothing in this file may reach a real host. What is being proven is not that
// a happy path works but that each way a carrier can misbehave lands on the
// engine's existing visible-error row instead of a number nobody underwrote.

const NOW = 1_760_000_000_000;
const ctx = { now: NOW } as unknown as Ctx;

const env = { CARRIER_FALCON_API_KEY: "sk-falcon-live-xyz" } as unknown as Env;

type OfferingRow = typeof schema.distOfferings.$inferSelect;
type ProviderRow = typeof schema.providers.$inferSelect;

function offeringRow(extra: Partial<OfferingRow> = {}): OfferingRow {
  return {
    id: "of_1",
    tenantId: "t1",
    productId: "pr_motor",
    providerId: "pv_falcon",
    code: "FAL-MOT-COMP",
    nameJson: JSON.stringify({ en: "Falcon Motor Comprehensive" }),
    currency: "AED",
    pricingMode: "api",
    ratingInputsJson: null,
    ratingTableJson: null,
    coverageJson: JSON.stringify({ excessMinor: 50_000, roadside: true }),
    eligibilityJson: null,
    baseCommissionPpm: 150_000,
    maxDiscountPpm: 0,
    minPremiumMinor: null,
    maxSumInsuredMinor: null,
    slaSeconds: 30,
    channelKeysJson: null,
    upsellOfOfferingId: null,
    crossSellTagsJson: null,
    status: "active",
    effectiveFrom: NOW - 1000,
    effectiveTo: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    deletedAt: null,
    ...extra
  } as OfferingRow;
}

function providerRow(quoteEndpointJson: string | null): ProviderRow {
  return {
    id: "pv_falcon",
    tenantId: "t1",
    name: "Falcon Insurance",
    kind: "insurer",
    isInternal: false,
    linesJson: null,
    integrationJson: JSON.stringify({ mode: "api" }),
    commissionJson: null,
    settlementTermsJson: null,
    currency: "AED",
    quoteEndpointJson,
    panelStatus: "active",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000
  } as ProviderRow;
}

const ENDPOINT = JSON.stringify({
  url: "https://api.falcon.example/quote",
  authRef: "CARRIER_FALCON_API_KEY"
});

function entry(endpoint: string | null = ENDPOINT, offering: Partial<OfferingRow> = {}): PanelEntry {
  return { offering: offeringRow(offering), provider: providerRow(endpoint) };
}

/** A carrier that answers whatever the test says, and records what it was asked. */
function carrier(reply: (req: { url: string; headers: Headers; body: any }) => unknown) {
  const spy = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const out = reply({
      url: String(input),
      headers: new Headers(init.headers as HeadersInit),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined
    });
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const QUOTED = {
  status: "quoted",
  premiumMinor: 214_500,
  taxMinor: 10_725,
  feesMinor: 2_500,
  currency: "AED",
  coverage: { excessMinor: 25_000, agencyRepair: true },
  breakdown: [{ label: "carrier.base", amountMinor: 214_500 }]
};

const price = (e: PanelEntry = entry(), inputs: Record<string, unknown> = { age: 34, market: "AE" }) =>
  quoteOne(ctx, e, inputs, quoterFor(env));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the http carrier quoter — the happy path", () => {
  it("prices an api offering against the carrier and returns a row a caller cannot tell from a table quote", async () => {
    carrier(() => QUOTED);
    const out = await price();
    expect(out).toMatchObject({
      offeringId: "of_1",
      providerId: "pv_falcon",
      state: "quoted",
      premiumMinor: 214_500,
      taxMinor: 10_725,
      feesMinor: 2_500,
      currency: "AED",
      coverage: { excessMinor: 25_000, agencyRepair: true },
      breakdown: [{ label: "carrier.base", amountMinor: 214_500 }]
    });
    // docs/05 §4: the comparison must not depend on how the number was obtained,
    // so every field the table branch fills is filled here too.
    expect(out.validUntil).toBeGreaterThan(NOW);
    expect(typeof out.latencyMs).toBe("number");
    expect(out.declineReason).toBeUndefined();
  });

  it("sends the offering's own code and the risk, and authenticates from the env binding the provider names", async () => {
    const spy = carrier(() => QUOTED);
    await price();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.falcon.example/quote");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe("Bearer sk-falcon-live-xyz");
    expect(JSON.parse(init.body as string)).toMatchObject({
      offeringCode: "FAL-MOT-COMP",
      currency: "AED",
      inputs: { age: 34, market: "AE" }
    });
  });

  it("never puts the credential anywhere the outcome can carry it to a log or an audit row", async () => {
    carrier(() => new Response("upstream exploded: key=sk-falcon-live-xyz", { status: 500 }));
    const out = await price();
    expect(JSON.stringify(out)).not.toContain("sk-falcon-live-xyz");
  });

  it("falls back to the offering's declared coverage when the carrier does not restate it", async () => {
    carrier(() => ({ status: "quoted", premiumMinor: 100_000 }));
    const out = await price();
    expect(out.coverage).toEqual({ excessMinor: 50_000, roadside: true });
    expect(out.taxMinor).toBe(0);
    expect(out.feesMinor).toBe(0);
  });

  it("honours a carrier's own validity window, but only a believable one", async () => {
    carrier(() => ({ ...QUOTED, validUntilMs: NOW + 3_600_000 }));
    expect((await price()).validUntil).toBe(NOW + 3_600_000);

    carrier(() => ({ ...QUOTED, validUntilMs: NOW - 1 }));
    expect((await price()).validUntil).toBeGreaterThan(NOW);

    carrier(() => ({ ...QUOTED, validUntilMs: 8_640_000_000_000_001 }));
    const far = (await price()).validUntil as number;
    expect(Number.isSafeInteger(far)).toBe(true);
    expect(new Date(far).toISOString()).toBeTruthy();
  });
});

describe("the http carrier quoter — every way a carrier fails", () => {
  it("degrades a carrier that never answers within the offering's SLA to a timeout row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
          })
      )
    );
    const out = await price(entry(ENDPOINT, { slaSeconds: 1 }));
    expect(out.state).toBe("timeout");
    expect(out.premiumMinor).toBeUndefined();
    expect(out.declineReason).toMatch(/timeout/i);
  });

  it("degrades a 5xx to a visible error rather than a fabricated number", async () => {
    carrier(() => new Response("gateway down", { status: 503 }));
    const out = await price();
    expect(out.state).toBe("error");
    expect(out.premiumMinor).toBeUndefined();
    expect(out.declineReason).toContain("503");
  });

  it("degrades a 4xx the same way — a rejected request is our bug, not a decline", async () => {
    carrier(() => new Response(JSON.stringify({ error: "bad schema" }), { status: 422 }));
    const out = await price();
    expect(out.state).toBe("error");
    expect(out.declineReason).toContain("422");
  });

  it("degrades an unreachable carrier without leaking the exception text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED https://api.falcon.example/quote token=sk-falcon-live-xyz`);
      })
    );
    const out = await price();
    expect(out.state).toBe("error");
    expect(JSON.stringify(out)).not.toContain("sk-falcon-live-xyz");
  });

  it("degrades a body that is not JSON at all", async () => {
    carrier(() => new Response("<html>maintenance</html>", { status: 200 }));
    const out = await price();
    expect(out.state).toBe("error");
    expect(out.premiumMinor).toBeUndefined();
  });

  it("degrades valid JSON that is the wrong shape", async () => {
    carrier(() => ({ status: "quoted", premiumMinor: "two hundred" }));
    expect((await price()).state).toBe("error");
  });

  it("degrades a quote with no premium at all — the one failure that must never become a number", async () => {
    carrier(() => ({ status: "quoted", taxMinor: 10_000, currency: "AED" }));
    const out = await price();
    expect(out.state).toBe("error");
    expect(out.premiumMinor).toBeUndefined();
    expect(out.declineReason).toMatch(/premium/i);
  });

  it("refuses a premium that is not a whole number of minor units", async () => {
    carrier(() => ({ status: "quoted", premiumMinor: 214_500.5 }));
    expect((await price()).state).toBe("error");
    carrier(() => ({ status: "quoted", premiumMinor: -1 }));
    expect((await price()).state).toBe("error");
  });

  it("refuses a quote priced in a currency the offering does not sell in", async () => {
    carrier(() => ({ ...QUOTED, currency: "USD" }));
    const out = await price();
    expect(out.state).toBe("error");
    expect(out.premiumMinor).toBeUndefined();
    expect(out.currency).toBe("AED");
    expect(out.declineReason).toMatch(/currency/i);
  });

  it("carries a carrier's decline through as a decline with its reason", async () => {
    carrier(() => ({ status: "declined", reason: "vehicle older than 12 years" }));
    const out = await price();
    expect(out.state).toBe("declined");
    expect(out.declineReason).toBe("vehicle older than 12 years");
    expect(out.premiumMinor).toBeUndefined();
  });

  it("carries a carrier's referral through as a referral", async () => {
    carrier(() => ({ status: "referred", reason: "manual underwriting required" }));
    const out = await price();
    expect(out.state).toBe("referred");
    expect(out.declineReason).toBe("manual underwriting required");
  });

  it("bounds and de-fangs the free text a carrier hands us before it is stored", async () => {
    carrier(() => ({ status: "declined", reason: `line one\nline two ${"x".repeat(400)}` }));
    const reason = (await price()).declineReason as string;
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).not.toContain("\n");
  });
});

describe("the http carrier quoter — configuration that must not reach the network", () => {
  const refused = async (endpoint: string | null, match: RegExp) => {
    const spy = carrier(() => QUOTED);
    const out = await price(entry(endpoint));
    expect(out.state).toBe("error");
    expect(out.declineReason).toMatch(match);
    expect(spy).not.toHaveBeenCalled();
  };

  it("refuses an api offering whose provider declares no quote endpoint", async () => {
    await refused(null, /endpoint/i);
  });

  it("refuses an unparseable endpoint config", async () => {
    await refused("{not json", /endpoint/i);
  });

  it("refuses an endpoint naming a wire format no adapter implements", async () => {
    await refused(JSON.stringify({ adapter: "soap-1.1", url: "https://api.falcon.example/quote" }), /adapter/i);
  });

  it("refuses a plaintext endpoint — a risk profile does not cross the internet in the clear", async () => {
    await refused(JSON.stringify({ url: "http://api.falcon.example/quote" }), /https/i);
  });

  it("refuses a loopback or link-local endpoint, so tenant-editable config cannot aim us inward", async () => {
    await refused(JSON.stringify({ url: "https://localhost:8787/v1/anything" }), /host/i);
    await refused(JSON.stringify({ url: "https://169.254.169.254/latest/meta-data/" }), /host/i);
    await refused(JSON.stringify({ url: "https://[::1]/quote" }), /host/i);
    await refused(JSON.stringify({ url: "https://vault.internal/quote" }), /host/i);
  });

  it("refuses an authRef that names a binding outside the carrier namespace", async () => {
    // The whole exfiltration path in one test: provider config is tenant-editable,
    // so an authRef that could name FIELD_KEY or ANTHROPIC_API_KEY would post our
    // own secrets to a URL the same tenant chose.
    await refused(JSON.stringify({ url: "https://api.falcon.example/quote", authRef: "FIELD_KEY" }), /authRef/i);
    await refused(
      JSON.stringify({ url: "https://api.falcon.example/quote", authRef: "ANTHROPIC_API_KEY" }),
      /authRef/i
    );
  });

  it("refuses when the named credential is not bound in this environment", async () => {
    await refused(
      JSON.stringify({ url: "https://api.falcon.example/quote", authRef: "CARRIER_CEDAR_API_KEY" }),
      /credential/i
    );
  });

  it("calls an endpoint that declares no credential at all — a public sandbox is legitimate", async () => {
    const spy = carrier(() => QUOTED);
    const out = await price(entry(JSON.stringify({ url: "https://sandbox.falcon.example/quote" })));
    expect(out.state).toBe("quoted");
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBeNull();
  });
});

describe("the deployed panel", () => {
  it("prices a table offering without the carrier ever being called", async () => {
    const spy = carrier(() => QUOTED);
    const out = await quoteOne(
      ctx,
      entry(null, {
        pricingMode: "table",
        ratingTableJson: JSON.stringify({ base: 60_000, minPremiumMinor: 95_000, taxPpm: 50_000 })
      }),
      { age: 34 },
      quoterFor(env)
    );
    expect(out.state).toBe("quoted");
    expect(out.premiumMinor).toBe(95_000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("reaching a carrier over a service binding", () => {
  // ADR-0072: the reference underwriter is a route on this same Worker, so it
  // is reached over a binding rather than by hostname (a Worker fetching its
  // own zone is Cloudflare error 1042). Every guard the url path carries has
  // to carry over, and a binding that is not there must never become a price.
  const BOUND = JSON.stringify({ url: "https://carrier.invalid/quote", binding: "CARRIER_SANDBOX" });

  /** A service binding: the same mock carrier, reached through `env` instead. */
  function bound(reply: () => unknown) {
    const service = vi.fn(async () => new Response(JSON.stringify(reply()), { status: 200 }));
    return { env: { CARRIER_SANDBOX: { fetch: service } } as unknown as Env, service };
  }

  it("posts through the binding and never touches the global fetch", async () => {
    const global = carrier(() => QUOTED);
    const { env: bindingEnv, service } = bound(() => QUOTED);
    const out = await quoteOne(ctx, entry(BOUND), { age: 34 }, quoterFor(bindingEnv));
    expect(out.state).toBe("quoted");
    expect(out.premiumMinor).toBe(214_500);
    expect(service).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  it("still guards the url it posts to, binding or no binding", async () => {
    const { env: bindingEnv } = bound(() => QUOTED);
    for (const url of ["http://carrier.invalid/quote", "https://127.0.0.1/quote", "https://carrier.internal/quote"]) {
      const out = await quoteOne(
        ctx,
        entry(JSON.stringify({ url, binding: "CARRIER_SANDBOX" })),
        { age: 34 },
        quoterFor(bindingEnv)
      );
      expect(out.state).toBe("error");
    }
  });

  it("errors rather than quoting when the named binding is not bound in this environment", async () => {
    const global = carrier(() => QUOTED);
    const out = await quoteOne(ctx, entry(BOUND), { age: 34 }, quoterFor({} as unknown as Env));
    expect(out.state).toBe("error");
    expect(out.declineReason).toMatch(/service binding/i);
    expect(out.premiumMinor).toBeUndefined();
    // The url must not be a second chance: a missing binding is a visible row,
    // never a silent fall back onto the open internet.
    expect(global).not.toHaveBeenCalled();
  });

  it("errors when the name is bound to something that is not a fetcher", async () => {
    const global = carrier(() => QUOTED);
    for (const value of ["https://carrier.invalid/quote", { fetch: "not a function" }, {}]) {
      const out = await quoteOne(
        ctx,
        entry(BOUND),
        { age: 34 },
        quoterFor({ CARRIER_SANDBOX: value } as unknown as Env)
      );
      expect(out.state).toBe("error");
      expect(out.declineReason).toMatch(/service binding/i);
    }
    expect(global).not.toHaveBeenCalled();
  });

  it("refuses a binding name outside the CARRIER_ namespace — provider rows are tenant CRUD", async () => {
    // BROWSER has a `fetch`, so without the namespace guard a tenant could
    // name it and aim a headless browser at a host of their choosing.
    const global = carrier(() => QUOTED);
    for (const name of ["BROWSER", "AI", "carrier_sandbox", ""]) {
      const out = await quoteOne(
        ctx,
        entry(JSON.stringify({ url: "https://carrier.invalid/quote", binding: name })),
        { age: 34 },
        quoterFor({ BROWSER: { fetch: vi.fn() }, AI: { fetch: vi.fn() } } as unknown as Env)
      );
      expect(out.state).toBe("error");
      expect(out.declineReason).toMatch(/binding must name a CARRIER_/i);
    }
    expect(global).not.toHaveBeenCalled();
  });

  it("applies every body guard to a binding's answer exactly as it does to the internet's", async () => {
    const { env: bindingEnv } = bound(() => ({ ...QUOTED, premiumMinor: 214_500.5 }));
    const out = await quoteOne(ctx, entry(BOUND), { age: 34 }, quoterFor(bindingEnv));
    expect(out.state).toBe("error");
    expect(out.premiumMinor).toBeUndefined();
  });
});

/* ---------------------------------------------------- portal automation (§2.1) */

// docs/modules/axis.md §2.1 names three quoting paths: an API, portal automation
// through headless Chrome, and structured email. Only the API existed. This is the
// second, and the tests are about what it *refuses*: a portal with no tenant map
// must never be guessed at, because a made-up selector yields a quote attributed
// to an underwriter who never gave one.

const PORTAL_ENDPOINT = JSON.stringify({
  url: "https://portal.falcon.example/motor/quote",
  authRef: "CARRIER_FALCON_API_KEY",
  adapter: "browser-portal",
  portal: {
    fill: { age: "#driver-age", sumInsuredMinor: "#sum-insured" },
    submit: "#get-quote",
    read: ["premiumMinor", "taxMinor", "feesMinor", "currency"],
    declineText: "not eligible"
  }
});

/** A browser service that answers whatever the test says, and records the ask. */
function browserService(reply: (req: { url: string; body: any }) => unknown) {
  const spy = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const out = reply({ url: String(input), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  });
  return spy;
}

function portalEnv(spy: ReturnType<typeof browserService>) {
  return { CARRIER_FALCON_API_KEY: "portal-user:portal-pass", BROWSER: { fetch: spy } } as unknown as Env;
}

const portalEntry = (endpoint: string = PORTAL_ENDPOINT) => entry(endpoint);

const portalQuote = (e: PanelEntry, envWithBrowser: Env, inputs: Record<string, unknown> = { age: 34, sumInsuredMinor: 28_000_000 }) =>
  quoteOne(ctx, e, inputs, quoterFor(envWithBrowser));

const PORTAL_QUOTED = { values: { premiumMinor: "214500", taxMinor: "10725", feesMinor: "2500", currency: "AED" } };

describe("the portal carrier quoter", () => {
  it("drives the tenant's own selectors and returns a row the caller cannot tell from an API quote", async () => {
    const spy = browserService(() => PORTAL_QUOTED);
    const row = await portalQuote(portalEntry(), portalEnv(spy));

    expect(row.state).toBe("quoted");
    expect(row.premiumMinor).toBe(214_500);
    expect(row.taxMinor).toBe(10_725);
    expect(row.feesMinor).toBe(2_500);
    expect(row.currency).toBe("AED");

    // It asked our own service, at the contract's path, with the tenant's map.
    const [calledUrl, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://browser-rendering/v1/portal-quote");
    const body = JSON.parse(String(init.body));
    expect(body.url).toBe("https://portal.falcon.example/motor/quote");
    expect(body.fill).toEqual([
      { selector: "#driver-age", value: "34" },
      { selector: "#sum-insured", value: "28000000" }
    ]);
    expect(body.submit).toBe("#get-quote");
    expect(body.read).toEqual(["premiumMinor", "taxMinor", "feesMinor", "currency"]);
    // The portal credential is the CARRIER_* secret, forwarded opaquely: a login
    // is not a bearer token and only the service knows how to present it.
    expect(body.credential).toBe("portal-user:portal-pass");
  });

  it("refuses to guess at a portal the tenant has not mapped", async () => {
    // The whole safety property: no map, no quote.
    const spy = browserService(() => PORTAL_QUOTED);
    const unmapped = JSON.stringify({
      url: "https://portal.falcon.example/motor/quote",
      adapter: "browser-portal"
    });
    const row = await portalQuote(portalEntry(unmapped), portalEnv(spy));
    expect(row.state).toBe("error");
    expect(row.declineReason).toContain("portal");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a map that names no inputs or no outputs", async () => {
    const spy = browserService(() => PORTAL_QUOTED);
    const noFill = JSON.stringify({ url: "https://p.example/q", adapter: "browser-portal", portal: { fill: {}, read: ["premiumMinor"] } });
    expect((await portalQuote(portalEntry(noFill), portalEnv(spy))).declineReason).toContain("input selectors");
    const noRead = JSON.stringify({ url: "https://p.example/q", adapter: "browser-portal", portal: { fill: { age: "#a" }, read: [] } });
    expect((await portalQuote(portalEntry(noRead), portalEnv(spy))).declineReason).toContain("output selectors");
    expect(spy).not.toHaveBeenCalled();
  });

  it("names the input the map expects and the risk does not carry, rather than filling it empty", async () => {
    const spy = browserService(() => PORTAL_QUOTED);
    const row = await portalQuote(portalEntry(), portalEnv(spy), { age: 34 });
    expect(row.state).toBe("error");
    expect(row.declineReason).toContain("sumInsuredMinor");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is an error, not a crash, when no browser is bound", async () => {
    const without = { CARRIER_FALCON_API_KEY: "x" } as unknown as Env;
    const row = await portalQuote(portalEntry(), without);
    expect(row.state).toBe("error");
    expect(row.declineReason).toContain("no browser service");
  });

  it("reads a decline and a broken page as different facts", async () => {
    const declining = browserService(() => ({ values: { decline: "not eligible" } }));
    const declined = await portalQuote(portalEntry(), portalEnv(declining));
    expect(declined.state).toBe("declined");
    expect(declined.declineReason).toContain("not eligible");

    const broken = browserService(() => ({ values: {} }));
    const unreadable = await portalQuote(portalEntry(), portalEnv(broken));
    expect(unreadable.state).toBe("error");
    expect(unreadable.declineReason).toContain("no usable premium");
  });

  it("lands every service failure on the visible error row, never on a number", async () => {
    const http = browserService(() => new Response("nope", { status: 502 }));
    expect((await portalQuote(portalEntry(), portalEnv(http))).declineReason).toContain("http 502");

    const notJson = browserService(() => new Response("<html>", { status: 200 }));
    expect((await portalQuote(portalEntry(), portalEnv(notJson))).declineReason).toContain("not json");

    const serviceSays = browserService(() => ({ error: "selector #get-quote matched nothing" }));
    expect((await portalQuote(portalEntry(), portalEnv(serviceSays))).declineReason).toContain("#get-quote matched nothing");

    // A premium a form could not have produced is a parsing bug, not a price.
    const fractional = browserService(() => ({ values: { premiumMinor: "214500.5" } }));
    expect((await portalQuote(portalEntry(), portalEnv(fractional))).declineReason).toContain("no usable premium");
  });

  it("refuses a portal quote in another currency rather than relabelling it", async () => {
    const other = browserService(() => ({ values: { premiumMinor: "1000", currency: "USD" } }));
    const row = await portalQuote(portalEntry(), portalEnv(other));
    expect(row.state).toBe("error");
    expect(row.declineReason).toContain("USD");
  });

  it("still refuses an unnamespaced credential and an internal host on this path", async () => {
    // The guards in `quoterFor` are wire-format independent, and these prove it.
    const spy = browserService(() => PORTAL_QUOTED);
    const badRef = JSON.stringify({ url: "https://p.example/q", authRef: "FIELD_KEY", adapter: "browser-portal", portal: { fill: { age: "#a" }, read: ["premiumMinor"] } });
    expect((await portalQuote(portalEntry(badRef), portalEnv(spy))).declineReason).toContain("CARRIER_");

    // https, so this reaches the internal-host guard rather than the earlier
    // "must use https" one — the metadata address is refused whichever it hits,
    // but the test should exercise the guard it names.
    const internal = JSON.stringify({ url: "https://169.254.169.254/q", adapter: "browser-portal", portal: { fill: { age: "#a" }, read: ["premiumMinor"] } });
    expect((await portalQuote(portalEntry(internal), portalEnv(spy))).declineReason).toContain("not reachable");
    expect(spy).not.toHaveBeenCalled();
  });
});
