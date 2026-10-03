import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { labelsIn, loader, nextRenewalCustomer, offerSummary } from "./dist-offers";

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a first customer to score", () => {
  // Role adoption: the retention seat opened this screen to a blank customer
  // field. The customer whose renewal comes up soonest is the one a
  // retention desk would score first, so the empty screen starts there.
  const rows = [
    { customerId: null, expiryAt: 1 },
    { customerId: "cu_late", expiryAt: 30 },
    { customerId: "cu_soon", expiryAt: 10 }
  ];

  it("picks the soonest renewal that names a customer", () => {
    expect(nextRenewalCustomer(rows)).toBe("cu_soon");
    expect(nextRenewalCustomer([{ customerId: null, expiryAt: 1 }])).toBeNull();
  });

  function route(renewals: Response) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: URL | string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v1/me")) {
        return Promise.resolve(new Response(JSON.stringify({ actor: {}, permissions: ["dist:offers:read"] })));
      }
      if (url.includes("/v1/orbit/renewals")) return Promise.resolve(renewals.clone());
      if (url.includes("/v1/names")) return Promise.resolve(new Response(JSON.stringify({ names: { cu_soon: "Mariam" } })));
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    });
    return calls;
  }
  const args = (url = "https://web.test/distribution/next-best-offers/suggest") =>
    ({ request: new Request(url), context: { get: () => ({ env, ctx: null }) }, params: {} }) as unknown as LoaderFunctionArgs;

  it("offers the soonest renewal's customer when none is named", async () => {
    const calls = route(new Response(JSON.stringify({ data: rows })));
    const loaded = await loader(args());
    expect(loaded.start).toEqual({ customerId: "cu_soon", name: "Mariam" });
    expect(calls.some((url) => url.includes("/v1/orbit/renewals") && url.includes("state=scheduled%2Coffered"))).toBe(true);
  });

  it("offers nothing when the renewals are not this seat's to read", async () => {
    route(new Response(JSON.stringify({ title: "forbidden", status: 403 }), { status: 403 }));
    expect((await loader(args())).start).toBeNull();
  });

  it("asks nothing extra once a customer is named", async () => {
    const calls = route(new Response(JSON.stringify({ data: rows })));
    const loaded = await loader(args("https://web.test/distribution/next-best-offers/suggest?customerId=cu_x"));
    expect(loaded.start).toBeNull();
    expect(calls.some((url) => url.includes("/v1/orbit/renewals"))).toBe(false);
  });

  it("words the start in both languages", () => {
    for (const locale of ["en", "ar"]) expect(labelsIn(locale)("startFrom")).not.toBe("startFrom");
  });
});

describe("offerSummary", () => {
  it("counts every offer as surfaceable when permitted and still proposed", () => {
    const offers = [{ state: "proposed" }, { state: "proposed" }];
    expect(offerSummary(offers, true)).toEqual({ total: 2, surfaceable: 2 });
  });

  it("excludes offers already surfaced or declined", () => {
    const offers = [{ state: "proposed" }, { state: "surfaced" }, { state: "declined" }];
    expect(offerSummary(offers, true)).toEqual({ total: 3, surfaceable: 1 });
  });

  it("is zero-surfaceable without the surface permission, regardless of state", () => {
    const offers = [{ state: "proposed" }];
    expect(offerSummary(offers, false)).toEqual({ total: 1, surfaceable: 0 });
  });

  it("is zero-zero on an empty list", () => {
    expect(offerSummary([], true)).toEqual({ total: 0, surfaceable: 0 });
  });
});

describe("labelsIn", () => {
  it("lets the tenant's pack rename the offer kind", () => {
    // `optionLabel(l, "kind", "renewal")` reads "kind.renewal", which the pack
    // owns; without the pack the card called a reorder a renewal.
    expect(labelsIn("en", "retail-ecom")("kind.renewal")).toBe("Reorder");
    expect(labelsIn("ar", "retail-ecom")("kind.renewal")).toBe("إعادة طلب");
  });

  it("keeps the insurance wording when no pack renames it", () => {
    expect(labelsIn("en")("kind.renewal")).toBe("Renewal");
  });
});
