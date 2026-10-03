import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
  canClawBack,
  filtersFrom,
  totalsRow,
  action as accrue,
  loader as statementLoader,
  type CommissionEntry
} from "./commission-statement";
import { blockedReason, reversalPreview } from "./commission-clawback";
import { canSurface, evidenceOf, loader as offersLoader, type Offer } from "./dist-offers";

// The three commission and offer screens. Everything below is either a money
// rule (minor units stay integers, a total means nothing across currencies) or
// a gate (a control the actor cannot use is absent, and a refusal is a notice
// rather than a crash).

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

const entry: CommissionEntry = {
  id: "com_01",
  policyId: "pol_01",
  offeringId: "off_01",
  providerId: "prv_01",
  channelId: "chn_01",
  kind: "new_business",
  premiumMinor: 120_000,
  grossCommissionMinor: 15_000,
  channelCommissionMinor: 6_000,
  netCommissionMinor: 8_500,
  taxMinor: 500,
  currency: "ZAR",
  earnedOn: "issue",
  earnedAt: 1_700_000_000,
  state: "accrued",
  reversalOf: null,
  providerSettlementId: null,
  channelSettlementId: null,
  txnId: null,
  createdAt: 1_700_000_000
};

const offer: Offer = {
  id: "nb_01",
  customerId: "cus_01",
  kind: "cross_sell",
  offeringId: "off_02",
  anchorRef: "pol_01",
  channelId: null,
  score: 72,
  expectedValueMinor: 45_000,
  currency: "ZAR",
  reasonKey: "nbo.reason.has_vehicle",
  reasonJson: { signal: "vehicle" },
  runId: "run_01",
  model: "sonnet",
  state: "proposed",
  suppressReason: null,
  surfacedAt: null,
  decidedAt: null,
  expiresAt: null,
  createdAt: 1_700_000_000
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers each call by the first URL fragment that matches; records the lot. */
function stubApi(replies: Array<[string, Response]>) {
  const calls: Array<{ url: string; method: string; body: string | null; headers: Headers }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      headers: new Headers(init.headers)
    });
    const hit = replies.find(([fragment]) => url.includes(fragment));
    if (!hit) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(hit[1].clone());
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function me(...permissions: string[]): Response {
  return json({ id: "usr_01", permissions, roles: [], tenantId: "t1" });
}

/** Loader args with just the pieces these loaders read. */
 
function args(url: string, init?: RequestInit): any {
  return {
    request: new Request(url, init),
    params: {},
    context: { get: () => ({ env, ctx: {} }) }
  };
}

/* ------------------------------------------------------------------- money */

describe("money on the statement", () => {
  it("hands one currency's totals to the renderer as minor units with that currency", () => {
    const row = totalsRow({
      currency: "ZAR",
      count: 2,
      premiumMinor: 120_000,
      receivableMinor: 15_000,
      payableMinor: 6_000,
      netMinor: 8_500,
      taxMinor: 500
    });

    // Untouched integers: any division belongs to <Money>, which knows how many
    // minor units the currency has.
    expect(row.netMinor).toBe(8_500);
    expect(row.premiumMinor).toBe(120_000);
    // The currency travels with the figures rather than being read off the first
    // row, so a statement spanning currencies cannot mislabel a total.
    expect(row.__currency).toBe("ZAR");
  });

  it("negates every amount on a reversal and nothing else", () => {
    expect(reversalPreview(entry)).toEqual({
      premiumMinor: -120_000,
      grossCommissionMinor: -15_000,
      channelCommissionMinor: -6_000,
      netCommissionMinor: -8_500,
      taxMinor: -500
    });
  });
});

/* --------------------------------------------------------------- filtering */

describe("statement filters", () => {
  it("keeps only the filters the statement handler applies", () => {
    const url = new URL("https://web.test/s?providerId=prv_01&state=accrued&from=1&kind=renewal");
    // `from` and `kind` are ignored server-side; offering them would be a lie.
    expect(filtersFrom(url)).toEqual({ providerId: "prv_01", state: "accrued" });
  });

  it("treats blank input as no filter", () => {
    expect(filtersFrom(new URL("https://web.test/s?providerId=%20&channelId="))).toEqual({});
  });
});

/* ------------------------------------------------------------------- gates */

describe("who may reverse an entry", () => {
  it("withholds the control from an actor without the adjustment permission", () => {
    expect(canClawBack(entry, false)).toBe(false);
    expect(blockedReason(entry, false)).toBe("blockedPermission");
  });

  it("refuses a reversal of a reversal, as the API does", () => {
    expect(canClawBack({ ...entry, reversalOf: "com_00" }, true)).toBe(false);
    expect(blockedReason({ ...entry, reversalOf: "com_00" }, true)).toBe("blockedReversal");
  });

  it("refuses a second reversal of the same accrual, which the API does not", () => {
    expect(canClawBack({ ...entry, state: "clawed_back" }, true)).toBe(false);
    expect(blockedReason({ ...entry, state: "clawed_back" }, true)).toBe("blockedClawedBack");
  });

  it("offers it on a standing entry to an actor who holds the permission", () => {
    expect(canClawBack(entry, true)).toBe(true);
    expect(blockedReason(entry, true)).toBeNull();
  });
});

describe("who may surface an offer", () => {
  it("withholds the control without dist:offers:override", () => {
    expect(canSurface(offer, false)).toBe(false);
  });

  it("withholds it once the offer has been decided, because the API no-ops", () => {
    expect(canSurface({ ...offer, state: "surfaced" }, true)).toBe(false);
    expect(canSurface({ ...offer, state: "dismissed" }, true)).toBe(false);
  });

  it("offers it on a proposed offer", () => {
    expect(canSurface(offer, true)).toBe(true);
  });
});

/* ------------------------------------------------------ loaders and denial */

describe("the statement loader", () => {
  it("never calls the statement without the read permission, and says so", async () => {
    const calls = stubApi([["/v1/me", me("dist:offers:read")]]);
    const loaded = await statementLoader(args("https://web.test/distribution/commission-entries/statement"));

    expect(loaded.statement).toBeNull();
    expect(loaded.may.read).toBe(false);
    expect(calls.map((call) => call.url)).toEqual(["https://api.test/v1/me"]);
  });

  it("hides the accrue panel from an actor who may read but not adjust", async () => {
    stubApi([
      ["/v1/me", me("dist:commissions:read")],
      ["/statement", json({ totals: [], count: 0, limit: 50, entries: [] })]
    ]);
    const loaded = await statementLoader(args("https://web.test/distribution/commission-entries/statement"));

    expect(loaded.may.adjust).toBe(false);
  });

  it("turns a refusal from the API into a denial, not an exception", async () => {
    stubApi([
      ["/v1/me", me("dist:commissions:read")],
      ["/statement", json({ title: "forbidden", status: 403 }, 403)]
    ]);
    const loaded = await statementLoader(args("https://web.test/distribution/commission-entries/statement"));

    expect(loaded.may.read).toBe(false);
    expect(loaded.statement).toBeNull();
  });

  it("passes only the honoured filters to the API", async () => {
    const calls = stubApi([
      ["/v1/me", me("dist:commissions:read")],
      ["/statement", json({ totals: [], count: 0, limit: 50, entries: [] })]
    ]);
    await statementLoader(
      args("https://web.test/distribution/commission-entries/statement?state=paid&kind=renewal")
    );

    // The two picker lists are fetched alongside; the statement call is the
    // one that must carry the filters, and only the honoured ones.
    expect(calls.map((call) => call.url)).toContain(
      "https://api.test/v1/dist/commission-entries/statement?state=paid"
    );
  });
});

describe("accruing", () => {
  it("carries an idempotency key so a double submit accrues once", async () => {
    const calls = stubApi([["/accrue", json(entry, 201)]]);
    const form = new FormData();
    form.set("intent", "accrue");
    form.set("idempotencyKey", "key_01");
    form.set("policyId", "pol_01");
    form.set("kind", "renewal");
    form.set("taxMinor", "500");

    const result = await accrue(args("https://web.test/", { method: "POST", body: form }));

    expect(calls[0]?.headers.get("idempotency-key")).toBe("key_01");
    // Only the fields the API declares travel, and a money field travels as the
    // integer minor unit it is, never a formatted string.
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      policyId: "pol_01",
      kind: "renewal",
      taxMinor: 500
    });
    expect(result).toEqual({ problem: null, accrued: entry });
  });

  it("surfaces a conflict beside the form instead of throwing", async () => {
    stubApi([["/accrue", json({ title: "conflict", status: 409 }, 409)]]);
    const form = new FormData();
    form.set("intent", "accrue");
    form.set("policyId", "pol_01");

    const result = await accrue(args("https://web.test/", { method: "POST", body: form }));

    expect(result).toMatchObject({ accrued: null, problem: { status: 409 } });
  });
});

describe("the offers loader", () => {
  it("asks for no offers until a customer is named", async () => {
    // It does read the open renewals, to suggest who to start with
    // (dist-offers.test.ts); never the offers, which need a customer.
    const calls = stubApi([["/v1/me", me("dist:offers:read")]]);
    const loaded = await offersLoader(
      args("https://web.test/distribution/next-best-offers/suggest")
    );

    expect(loaded.offers).toBeNull();
    expect(calls.filter((call) => call.url.includes("next-best-offers"))).toEqual([]);
  });

  it("separates reading offers from proposing and surfacing them", async () => {
    stubApi([
      ["/v1/me", me("dist:offers:read")],
      ["next-best-offers?", json({ data: [offer] })]
    ]);
    const loaded = await offersLoader(
      args("https://web.test/distribution/next-best-offers/suggest?customerId=cus_01")
    );

    expect(loaded.may.propose).toBe(true);
    // The propose permission does not carry the surface one: the consequential
    // half is a separate grant.
    expect(loaded.may.surface).toBe(false);
    expect(loaded.offers).toHaveLength(1);
  });

  it("shows an empty list rather than a denial when the model proposed nothing", async () => {
    stubApi([
      ["/v1/me", me("dist:offers:read")],
      ["next-best-offers?", json({ data: [] })]
    ]);
    const loaded = await offersLoader(
      args("https://web.test/distribution/next-best-offers/suggest?customerId=cus_01")
    );

    expect(loaded.may.read).toBe(true);
    expect(loaded.offers).toEqual([]);
  });
});

describe("offer evidence", () => {
  it("survives model output that is not the object it promised", () => {
    expect(evidenceOf(null)).toEqual({});
    expect(evidenceOf("not json")).toEqual({});
    expect(evidenceOf("[1,2]")).toEqual({});
    expect(evidenceOf('{"signal":"vehicle"}')).toEqual({ signal: "vehicle" });
  });
});
