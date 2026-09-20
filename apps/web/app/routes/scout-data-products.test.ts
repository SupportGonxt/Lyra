import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  action,
  activeSubscribers,
  definitionOf,
  dtpHeadline,
  nextProductStates,
  subjectRefOf,
  subscribersOf,
  warningsFor,
  type DataProductRow
} from "./scout-data-products";
import { labelsIn } from "./scout.shared";

const l = labelsIn("en");

// A data product is a promise about what its cells cannot reveal. What is worth
// asserting is that the promise is arithmetic — a floor under the module's
// k-anonymity floor never reaches the publish call — and that the screen reads
// the builder's definition rather than inventing one when the blob is missing.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...replies: Response[]) {
  const calls: Array<{ url: string; method: string; key: string | null; body: Record<string, unknown> }> = [];
  let at = 0;
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      key: headers.get("idempotency-key"),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    });
    const reply = replies[Math.min(at, replies.length - 1)] ?? new Response(null, { status: 204 });
    at += 1;
    return Promise.resolve(reply.clone());
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/scout/data-products", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};

const product = (over: Partial<DataProductRow> = {}): DataProductRow => ({
  id: "dtp_1",
  name: "Motor demand curve by emirate and age band",
  definitionJson: {
    source: "dist_quote_requests",
    dimensions: ["emirate", "ageBand"],
    measures: ["requests", "medianPremium"],
    window: "rolling 90 days",
    refresh: { cadence: "weekly", lastRunAt: 1_770_000_000_000, state: "fresh" }
  },
  consentBasis: "consent:dataSharing",
  aggregationMin: 20,
  subscribersJson: [
    { providerId: "prv_falcon", since: 1_760_000_000_000 },
    { providerId: "prv_cedar", since: 1_762_000_000_000 }
  ],
  delivery: "api",
  status: "published",
  createdAt: 1_750_000_000_000,
  updatedAt: 1_770_000_000_000,
  ...over
});

/* ------------------------------------------------------------- definition */

describe("the cut", () => {
  it("reads the builder's definition without recomputing any of it", () => {
    const cut = definitionOf(product());
    expect(cut.source).toBe("dist_quote_requests");
    expect(cut.dimensions).toEqual(["emirate", "ageBand"]);
    expect(cut.measures).toEqual(["requests", "medianPremium"]);
    expect(cut.window).toBe("rolling 90 days");
    expect(cut.cadence).toBe("weekly");
    expect(cut.refreshState).toBe("fresh");
    expect(cut.lastRunAt).toBe(1_770_000_000_000);
    expect(cut.failure).toBeNull();
  });

  it("carries the failure the builder recorded rather than calling the feed fresh", () => {
    const cut = definitionOf(
      product({
        definitionJson: {
          source: "dist_quote_requests",
          refresh: { cadence: "weekly", state: "stale", failure: "the travel connector run has errored" }
        }
      })
    );
    expect(cut.refreshState).toBe("stale");
    expect(cut.failure).toBe("the travel connector run has errored");
  });

  it("reads an absent, malformed or list-shaped definition as an empty cut, never as a default one", () => {
    for (const blob of [null, "not json", "[1,2]", "{}"]) {
      const cut = definitionOf(product({ definitionJson: blob }));
      expect(cut.source).toBeNull();
      expect(cut.dimensions).toEqual([]);
      expect(cut.cadence).toBeNull();
      expect(cut.lastRunAt).toBeNull();
    }
  });

  it("drops definition fields that are not the type they claim to be", () => {
    const cut = definitionOf(
      product({ definitionJson: { source: 7, dimensions: ["emirate", 3, null], window: {} } })
    );
    expect(cut.source).toBeNull();
    expect(cut.dimensions).toEqual(["emirate"]);
    expect(cut.window).toBeNull();
  });
});

/* ------------------------------------------------------------ subscribers */

describe("subscribers", () => {
  it("keeps a suspended subscriber on the list but out of the active count", () => {
    const row = product({
      subscribersJson: [
        { providerId: "prv_falcon", since: 1_760_000_000_000, suspendedAt: 1_768_000_000_000 },
        { providerId: "prv_cedar", since: 1_762_000_000_000 }
      ]
    });
    expect(subscribersOf(row).map((one) => one.providerId)).toEqual(["prv_falcon", "prv_cedar"]);
    expect(activeSubscribers(row).map((one) => one.providerId)).toEqual(["prv_cedar"]);
  });

  it("reads a malformed, absent or bag-shaped subscriber list as nobody", () => {
    for (const blob of [null, "not json", '{"providerId":"prv_falcon"}']) {
      expect(subscribersOf(product({ subscribersJson: blob }))).toEqual([]);
    }
  });

  it("skips entries with no provider and tolerates a missing since", () => {
    const rows = subscribersOf(
      product({ subscribersJson: [{ since: 1 }, null, "prv_falcon", { providerId: "prv_cedar" }] })
    );
    expect(rows).toEqual([{ providerId: "prv_cedar", since: null, suspendedAt: null }]);
  });
});

/* --------------------------------------------------------------- monitor */

describe("k-anonymity monitor", () => {
  it("passes a cut floored at the module floor with no provider dimension", () => {
    expect(warningsFor(product())).toEqual([]);
  });

  it("flags a floor under the module floor", () => {
    expect(warningsFor(product({ aggregationMin: 5 }))).toContain("belowFloor");
  });

  it("checks against a passed-in floor, not just the compiled default", () => {
    // 20 clears the compiled default with room to spare, but not a tenant
    // that raised its own floor to 25.
    expect(warningsFor(product({ aggregationMin: 20 }), 25)).toContain("belowFloor");
    expect(warningsFor(product({ aggregationMin: 20 }), 15)).not.toContain("belowFloor");
  });

  it("flags a cut keyed on the counterparty however high the floor is", () => {
    // Every cell of a providerId-keyed cut names one carrier; the floor cannot
    // fix that, which is why the seeded latency benchmark ships suspended.
    const row = product({
      aggregationMin: 200,
      definitionJson: { source: "scout_panel_bench", dimensions: ["providerId", "line"] }
    });
    expect(warningsFor(row)).toEqual(["singleCounterparty"]);
  });

  it("flags a published product whose feed has stopped building, but not a draft one", () => {
    const stale = { refresh: { cadence: "weekly", state: "stale" } };
    expect(warningsFor(product({ definitionJson: stale }))).toContain("staleFeed");
    expect(warningsFor(product({ definitionJson: stale, status: "draft" }))).not.toContain("staleFeed");
  });
});

/* ----------------------------------------------------------- transitions */

describe("status machine", () => {
  it("publishes a draft, suspends a published product, and reopens a suspended one", () => {
    expect(nextProductStates("draft")).toEqual(["published"]);
    expect(nextProductStates("published")).toEqual(["suspended"]);
    expect(nextProductStates("suspended")).toEqual(["published", "draft"]);
  });

  it("offers nothing from a status it does not know", () => {
    expect(nextProductStates("retired")).toEqual([]);
    expect(nextProductStates("")).toEqual([]);
  });
});

/* -------------------------------------------------------------- delivery */

describe("delivery log", () => {
  it("keys exports by the product row, matching the platform's subject reference shape", () => {
    expect(subjectRefOf("dtp_1")).toBe("scout_data_product:dtp_1");
  });
});

/* ---------------------------------------------------------------- action */

describe("changing status", () => {
  it("refuses a move the product cannot make, before any call", async () => {
    const calls = stubFetch();
    const result = await action(args(form({ intent: "move", productId: "dtp_1", from: "draft", to: "suspended" })));
    expect(result.problem?.code).toBe("transition_required");
    expect(calls).toHaveLength(0);
  });

  it("refuses without a product, and refuses any other intent", async () => {
    const calls = stubFetch();
    expect((await action(args(form({ intent: "move", from: "draft", to: "published" })))).problem?.code).toBe(
      "product_required"
    );
    expect((await action(args(form({ intent: "delete" })))).problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });

  it("refuses to publish a cut floored below the module floor", async () => {
    const calls = stubFetch(json({ kFloor: 20 }));
    const result = await action(
      args(form({ intent: "move", productId: "dtp_1", from: "draft", to: "published", floor: "5" }))
    );
    expect(result.problem?.code).toBe("floor_too_low");
    // One call to resolve the tenant's floor, none to actually PATCH — the
    // pre-check refuses before the write is attempted.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/v1/scout/config");
  });

  it("reads the tenant's own resolved floor, not the compiled default", async () => {
    // aggregationMin 25 clears the compiled default (20) but not a tenant that
    // raised its own floor to 30 — the pre-check has to ask, not assume.
    const calls = stubFetch(json({ kFloor: 30 }));
    const result = await action(
      args(form({ intent: "move", productId: "dtp_1", from: "draft", to: "published", floor: "25" }))
    );
    expect(result.problem?.code).toBe("floor_too_low");
    expect(calls[0]?.url).toBe("https://api.test/v1/scout/config");
  });

  it("still allows suspending a product whose floor is too low", async () => {
    // The floor gate is about exposure. Withdrawing a thin cut is the fix, not
    // another thing to block.
    const calls = stubFetch(json({ id: "dtp_1", status: "suspended" }));
    const result = await action(
      args(form({ intent: "move", productId: "dtp_1", from: "published", to: "suspended", floor: "5" }))
    );
    expect(result.problem).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("patches the row with the new status and nothing else", async () => {
    const calls = stubFetch(json({ kFloor: 20 }), json({ id: "dtp_1", status: "published" }));
    const result = await action(
      args(form({ intent: "move", productId: "dtp_1", from: "draft", to: "published", floor: "20", key: "idem_1" }))
    );
    expect(calls[0]?.url).toBe("https://api.test/v1/scout/config");
    expect(calls[1]?.url).toBe("https://api.test/v1/scout/data-products/dtp_1");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.key).toBe("idem_1");
    expect(calls[1]?.body).toEqual({ status: "published" });
    expect(result.done).toEqual({ status: "published" });
  });

  it("reads the approval gate as a queued change, not a failure", async () => {
    stubFetch(
      json(
        {
          title: "Approval required",
          status: 403,
          code: "approval_required",
          policy_key: "scout.data_product_publish"
        },
        403
      )
    );
    const result = await action(
      args(form({ intent: "move", productId: "dtp_1", from: "draft", to: "published", floor: "20" }))
    );
    expect(result.problem?.code).toBe("approval_required");
    expect(result.problem?.policy_key).toBe("scout.data_product_publish");
    expect(result.done).toBeNull();
  });
});

/* --------------------------------------------------------------- headline */

describe("dtpHeadline", () => {
  it("leads with the flagged count when any product is flagged", () => {
    const flagged = product({ aggregationMin: 1, status: "draft" });
    expect(warningsFor(flagged)).toContain("belowFloor");
    const rows = [flagged, product()];
    expect(dtpHeadline(rows, l)).toBe(l("dtp.headlineFlagged", { n: "1", total: "2" }));
  });

  it("falls back to the published count with nothing flagged", () => {
    const rows = [product({ status: "published" }), product({ status: "draft" })];
    expect(dtpHeadline(rows, l)).toBe(l("dtp.headlinePublished", { n: "1", total: "2" }));
  });

  it("falls back to the title with no products at all", () => {
    expect(dtpHeadline([], l)).toBe(l("dtp.title"));
  });
});
