import type { schema } from "@lyra/db";
import type { CarrierService, Env } from "../env.js";
import type { ProviderQuoter, QuoteOutcome } from "./rating.js";

// The live-underwriter side of the rating seam (docs/16 "build to the seams",
// ADR-0070). `pricingMode: "api"` has always been in the engine; this is the
// first thing behind it that speaks to a real carrier.
//
// The rule that shapes every line below: a carrier that misbehaves produces a
// visible error row, never a number nobody underwrote. There is no defaulting,
// no rounding a bad field into a good one, and no partial quote.

type Offering = typeof schema.distOfferings.$inferSelect;

/** What the engine hands back for one offering, before it stamps ids and latency. */
type Outcome = Omit<QuoteOutcome, "offeringId" | "providerId" | "latencyMs">;

/**
 * `core_providers.quote_endpoint_json`. Tenant-editable, so every field is
 * treated as hostile: see `quoterFor` for the guards.
 */
interface QuoteEndpoint {
  /** Wire format. Defaults to the only one implemented. */
  adapter?: string;
  url?: string;
  /** The NAME of a wrangler secret, never a value. Must be `CARRIER_*`. */
  authRef?: string;
  /**
   * The NAME of a service binding to call instead of the public internet.
   * Same `CARRIER_*` namespace as `authRef`, for the same reason. `url` is
   * still required and still guarded: it is the address the carrier answers
   * on, and a binding that is named but missing is an error row rather than a
   * quiet fall back to the open internet.
   */
  binding?: string;
  /**
   * The portal-automation map (`adapter: "browser-portal"`): the tenant's own
   * selectors for its carrier portal. Required by that adapter and ignored by
   * the others — a portal is not a protocol, so it cannot be inferred.
   */
  portal?: PortalMap;
  /** Where the headless browser answers. Defaults to the platform's own binding. */
  portalService?: string;
}

/**
 * How to drive one carrier's portal. Supplied by the tenant because only the
 * tenant can see the markup, and a map we invented would produce a quote
 * attributed to an underwriter who never gave one.
 */
interface PortalMap {
  /** Input name (as the risk carries it) → the portal field's selector. */
  fill: Record<string, string>;
  /** Clicked after filling, when the portal does not submit on change. */
  submit?: string;
  /** Output keys to read back: `premiumMinor`, `taxMinor`, `feesMinor`, `currency`. */
  read: string[];
  /** Text whose presence means "not eligible" rather than "unreadable". */
  declineText?: string;
  /** How long to wait for the result after submitting. */
  settleMs?: number;
}

/** The one namespace on `env` a tenant-editable provider row may reach into. */
const CARRIER_NAMESPACE = /^CARRIER_[A-Z0-9_]+$/;

const WEEK = 7 * 86_400_000;
const YEAR = 365 * 86_400_000;

/** Free text from a carrier goes into a stored row, so bound it and flatten it. */
const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const parse = <T>(json: string | null): T | undefined => {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
};

/** Minor units are integers. A fractional or negative one is a carrier bug, not a price. */
const minor = (v: unknown): number | undefined =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined;

/**
 * Hosts a tenant must not be able to aim us at by editing a provider row:
 * loopback, link-local metadata, and split-horizon internal names.
 */
function internalHost(host: string): boolean {
  if (host.startsWith("[")) return true; // IPv6 literal — no legitimate carrier is one
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal, ditto
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  );
}

/** The headless-Chrome binding, typed to the one call this file makes. */
interface BrowserBinding {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/**
 * A carrier wire format. `http-json` is an API; `browser-portal` drives the
 * carrier's own web portal through headless Chrome, for the underwriters who
 * have no API and will not build one — docs/modules/axis.md §2.1 names exactly
 * these two plus a structured-email path.
 *
 * The map exists so that an endpoint naming a format nobody implements is a
 * visible error rather than a request sent in the wrong protocol and parsed as
 * if it had worked.
 */
type CarrierAdapter = (args: {
  url: string;
  /** How the request leaves: the global fetch, or a service binding's. */
  send: CarrierService["fetch"];
  token: string | undefined;
  offering: Offering;
  inputs: Record<string, unknown>;
  timeoutMs: number;
  now: number;
  /** The tenant's own endpoint config, for formats that need more than a URL. */
  cfg: QuoteEndpoint;
  /** Headless Chrome (docs/02 §9), for the portal-automation format. */
  browser: BrowserBinding | undefined;
}) => Promise<Outcome>;

const ADAPTERS: Record<string, CarrierAdapter> = { "http-json": httpJson, "browser-portal": browserPortal };

export function quoterFor(env: Env): ProviderQuoter {
  return async ({ offering, provider, inputs, timeoutMs, now }) => {
    const bad = (reason: string): Outcome => ({
      state: "error",
      taxMinor: 0,
      feesMinor: 0,
      currency: offering.currency,
      declineReason: reason
    });

    const cfg = parse<QuoteEndpoint>(provider?.quoteEndpointJson ?? null);
    if (!cfg?.url || typeof cfg.url !== "string") return bad("provider has no usable quote endpoint");

    const name = cfg.adapter ?? "http-json";
    const adapter = ADAPTERS[name];
    if (!adapter) return bad(`no quote adapter for ${clean(name)}`);

    let url: URL;
    try {
      url = new URL(cfg.url);
    } catch {
      return bad("provider quote endpoint is not a url");
    }
    if (url.protocol !== "https:") return bad("quote endpoint must use https");
    if (internalHost(url.hostname)) return bad("quote endpoint host is not reachable externally");

    // Provider rows are tenant CRUD. Without this the authRef could name
    // FIELD_KEY and post it to a host the same tenant chose (ADR-0070).
    let token: string | undefined;
    if (cfg.authRef !== undefined) {
      if (typeof cfg.authRef !== "string" || !/^CARRIER_[A-Z0-9_]+$/.test(cfg.authRef)) {
        return bad("quote endpoint authRef must name a CARRIER_* secret");
      }
      const secret = (env as unknown as Record<string, unknown>)[cfg.authRef];
      if (typeof secret !== "string" || !secret) return bad("carrier credential is not configured in this environment");
      token = secret;
    }

    // A service binding is how the platform reaches its own reference
    // underwriter (ADR-0072): a Worker that fetches its own zone by hostname
    // gets Cloudflare error 1042. The namespace guard is the authRef argument
    // unchanged — unbounded, a provider row could name any Fetcher on env.
    // ponytail: lazy `fetch` lookup rather than a captured reference, so a
    // stubbed global still applies.
    let send: CarrierService["fetch"] = (input, init) => fetch(input, init);
    if (cfg.binding !== undefined) {
      if (typeof cfg.binding !== "string" || !CARRIER_NAMESPACE.test(cfg.binding)) {
        return bad("quote endpoint binding must name a CARRIER_* service binding");
      }
      const bound = (env as unknown as Record<string, unknown>)[cfg.binding];
      // Absent, or present but not a Fetcher: an error row either way. Never a
      // silent fall back to the url over the open internet.
      if (typeof (bound as CarrierService | undefined)?.fetch !== "function") {
        return bad("carrier service binding is not configured in this environment");
      }
      const service = bound as CarrierService;
      send = (input, init) => service.fetch(input, init);
    }

    try {
      return await adapter({
        url: url.toString(),
        send,
        token,
        offering,
        inputs,
        timeoutMs,
        now,
        cfg,
        browser: (env as unknown as { BROWSER?: BrowserBinding }).BROWSER
      });
    } catch {
      // ponytail: the thrown text is deliberately dropped rather than logged —
      // fetch failures quote the request back at you, and the request carries a
      // bearer token. Reproduce with the carrier's own sandbox, not our logs.
      return bad("carrier request failed");
    }
  };
}

/** The default wire format: POST the risk as JSON, read a quote back as JSON. */
async function httpJson({
  url,
  send,
  token,
  offering,
  inputs,
  timeoutMs,
  now
}: Parameters<CarrierAdapter>[0]): Promise<Outcome> {
  const base = { taxMinor: 0, feesMinor: 0, currency: offering.currency };
  const bad = (reason: string): Outcome => ({ ...base, state: "error" as const, declineReason: reason });

  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ offeringCode: offering.code, currency: offering.currency, inputs }),
      signal
    });
  } catch (e) {
    if (signal.aborted) {
      return { ...base, state: "timeout", declineReason: `carrier timeout after ${timeoutMs}ms` };
    }
    throw e;
  }

  // A 4xx is our request being wrong and a 5xx is theirs being down. Both are
  // an error row: neither is an underwriting decision.
  if (!res.ok) return bad(`carrier returned http ${res.status}`);

  let body: Record<string, unknown> | undefined;
  try {
    body = object(await res.json());
  } catch {
    return bad("carrier returned a body that is not json");
  }
  if (!body) return bad("carrier returned a body that is not a quote");

  const reason = body.reason !== undefined ? clean(body.reason) : undefined;
  if (body.status === "declined") return { ...base, state: "declined", ...(reason ? { declineReason: reason } : {}) };
  if (body.status === "referred") return { ...base, state: "referred", ...(reason ? { declineReason: reason } : {}) };

  const premiumMinor = minor(body.premiumMinor);
  if (premiumMinor === undefined) return bad("carrier quote has no usable premium");

  // A price in the wrong currency cannot be compared against the panel and must
  // not be silently relabelled with the offering's own.
  if (body.currency !== undefined && body.currency !== offering.currency) {
    return bad(`carrier quoted in currency ${clean(body.currency)}, not ${offering.currency}`);
  }
  const taxMinor = minor(body.taxMinor ?? 0);
  const feesMinor = minor(body.feesMinor ?? 0);
  if (taxMinor === undefined || feesMinor === undefined) return bad("carrier quote has unusable tax or fees");

  // ponytail: `offering.minPremiumMinor` is deliberately NOT applied here. It is
  // a floor on OUR table, and raising a carrier's own binding number would
  // invent a price the underwriter never gave (ADR-0070).
  const until = body.validUntilMs;
  const validUntil =
    Number.isSafeInteger(until) && (until as number) > now && (until as number) < now + YEAR
      ? (until as number)
      : now + WEEK;

  const breakdown = Array.isArray(body.breakdown)
    ? body.breakdown.filter(
        (b): b is { label: string; amountMinor: number } =>
          !!object(b) &&
          typeof (b as { label?: unknown }).label === "string" &&
          Number.isSafeInteger((b as { amountMinor?: unknown }).amountMinor)
      )
    : [];

  const coverage = object(body.coverage) ?? parse<Record<string, unknown>>(offering.coverageJson);

  return {
    ...base,
    state: "quoted",
    premiumMinor,
    taxMinor,
    feesMinor,
    validUntil,
    ...(coverage ? { coverage } : {}),
    ...(breakdown.length ? { breakdown } : {})
  };
}

/**
 * The carrier's portal, driven by headless Chrome — docs/modules/axis.md §2.1's
 * second quoting path.
 *
 * This is the honest shape for an underwriter with no API: rather than inventing
 * a DOM, the **tenant** maps its own portal's fields to selectors in
 * `quoteEndpointJson.portal`, and this adapter hands that map to the browser
 * service. A portal with no map is a named error, never a guess — guessing at
 * somebody's markup would produce a quote attributed to an underwriter who never
 * gave one.
 *
 * The service contract (our own `render` service on-prem, Cloudflare Browser
 * Rendering in the cloud; docs/02 §9) is one POST:
 *
 *   POST /v1/portal-quote
 *   { "url", "fill": [{ "selector", "value" }], "submit", "read": ["premiumMinor", …],
 *     "declineText", "settleMs", "timeoutMs", "credential" }
 *   → { "values": { "<key>": "<text>" } } | { "error": "<why>" }
 *
 * The credential is the `CARRIER_*` secret's value, opened and forwarded by the
 * caller: a portal login is a username and password, not a bearer token, so it
 * is opaque here and the service decides how to present it.
 */
async function browserPortal({
  cfg,
  token,
  offering,
  inputs,
  timeoutMs,
  now,
  browser
}: Parameters<CarrierAdapter>[0]): Promise<Outcome> {
  const base = { taxMinor: 0, feesMinor: 0, currency: offering.currency };
  const bad = (reason: string): Outcome => ({ ...base, state: "error" as const, declineReason: reason });

  if (!browser) return bad("no browser service is bound in this environment");
  const portal = parse<PortalMap>(JSON.stringify(cfg.portal ?? null));
  if (!portal) return bad("portal quoting needs a `portal` map on the provider's quote endpoint");
  if (!portal.fill || !Object.keys(portal.fill).length) return bad("portal map names no input selectors");
  if (!portal.read || !portal.read.length) return bad("portal map names no output selectors");

  // Only selectors the tenant declared are filled, and only from the inputs the
  // risk actually carries — a map naming an input we do not have is a config
  // error the tenant has to see, not a silent empty field.
  const fill: { selector: string; value: string }[] = [];
  for (const [field, selector] of Object.entries(portal.fill)) {
    const value = inputs[field];
    if (value === undefined || value === null || value === "") {
      return bad(`portal map expects input \`${clean(field)}\`, which this risk does not carry`);
    }
    fill.push({ selector: clean(selector), value: clean(value) });
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await browser.fetch(`${(cfg.portalService ?? "https://browser-rendering").replace(/\/$/, "")}/v1/portal-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: cfg.url,
        fill,
        submit: portal.submit ? clean(portal.submit) : undefined,
        read: portal.read.map(clean),
        declineText: portal.declineText ? clean(portal.declineText) : undefined,
        settleMs: portal.settleMs ?? 2_000,
        timeoutMs,
        ...(token ? { credential: token } : {})
      }),
      signal
    });
  } catch (e) {
    if (signal.aborted) return { ...base, state: "timeout", declineReason: `portal timeout after ${timeoutMs}ms` };
    throw e;
  }
  if (!res.ok) return bad(`browser service returned http ${res.status}`);

  let body: Record<string, unknown> | undefined;
  try {
    body = object(await res.json());
  } catch {
    return bad("browser service returned a body that is not json");
  }
  if (!body) return bad("browser service returned a body that is not a result");
  if (typeof body.error === "string") return bad(`portal: ${clean(body.error)}`);

  const values = object(body.values);
  if (!values) return bad("browser service returned no field values");
  // A portal that says "not eligible" is a decline; one that returns nothing is
  // a page the service could not read, and those are different facts.
  if (portal.declineText && typeof values.decline === "string" && values.decline) {
    return { ...base, state: "declined", declineReason: clean(values.decline) };
  }

  // Read values arrive as text from a form; the same integer guards the API path
  // uses apply, because a fractional or negative premium is a parsing bug rather
  // than a price either way.
  const premiumMinor = minor(Number(values.premiumMinor));
  if (premiumMinor === undefined) return bad("portal quote has no usable premium");
  const taxMinor = minor(Number(values.taxMinor ?? 0));
  const feesMinor = minor(Number(values.feesMinor ?? 0));
  if (taxMinor === undefined || feesMinor === undefined) return bad("portal quote has unusable tax or fees");
  if (values.currency !== undefined && values.currency !== offering.currency) {
    return bad(`portal quoted in currency ${clean(values.currency)}, not ${offering.currency}`);
  }

  return {
    ...base,
    state: "quoted",
    premiumMinor,
    taxMinor,
    feesMinor,
    validUntil: now + WEEK,
    ...(object(parse<Record<string, unknown>>(offering.coverageJson)) ? { coverage: parse<Record<string, unknown>>(offering.coverageJson)! } : {})
  };
}
