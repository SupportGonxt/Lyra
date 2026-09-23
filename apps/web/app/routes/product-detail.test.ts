import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { LABELS, PERM, action, channelKeysOf, labelsIn, productLede, shariahStep } from "./product-detail";
import type { OfferingRow } from "./product-detail";

// Read-only screen: no action to exercise. What can break is the labelling and
// the derivation of "which channels distribute this", which has no join table —
// it is the union of each version's channel allow-list, and a null list means
// every channel, which the screen must not render as "none".

function offering(channelKeysJson: OfferingRow["channelKeysJson"]): OfferingRow {
  return { id: "off_1", code: "C", nameJson: null, channelKeysJson } as OfferingRow;
}

describe("labelsIn", () => {
  it("answers every key in both languages, and never with the key itself", () => {
    for (const key of Object.keys(LABELS.en!)) {
      expect(LABELS.ar![key], key).toBeTruthy();
      for (const locale of ["en", "ar"]) expect(labelsIn(locale)(key), `${locale}:${key}`).not.toBe(key);
    }
    expect(Object.keys(LABELS.ar!).sort()).toEqual(Object.keys(LABELS.en!).sort());
  });

  it("keeps the Arabic distinct from the English", () => {
    for (const [key, value] of Object.entries(LABELS.en!)) expect(LABELS.ar![key], key).not.toBe(value);
  });

  it("takes the pack's word for cover before its own", () => {
    expect(labelsIn("en", "retail-ecom")("coverageJson")).toBe("Entitlements");
  });
});

describe("productLede", () => {
  it("states the line, status and version count from the loaded record", () => {
    expect(productLede({ line: "motor", status: "active" }, 3, labelsIn("en"))).toBe("Motor · Active · 3 versions");
  });
});

describe("PERM", () => {
  it("scopes each panel to its own permission so one refusal hides one panel", () => {
    const values = Object.values(PERM);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => /^[a-z_]+:[a-z_]+:[a-z_]+$/.test(value))).toBe(true);
  });
});

describe("channelKeysOf", () => {
  it("unions the allow-lists across versions, without duplicates", () => {
    expect(channelKeysOf([offering(["web", "broker"]), offering(["broker", "app"])])).toEqual([
      "web",
      "broker",
      "app"
    ]);
  });

  it("reports no keys when a version is open to every channel", () => {
    expect(channelKeysOf([offering(null)])).toEqual([]);
  });

  it("ignores a malformed allow-list instead of throwing", () => {
    expect(channelKeysOf([offering("web" as unknown as string[]), offering([1 as unknown as string, "web"])])).toEqual([
      "web"
    ]);
  });

  it("has nothing to say about no versions", () => {
    expect(channelKeysOf([])).toEqual([]);
  });
});

// The Shariah lane (docs/16 H8): the API had submit and certify, and this screen
// showed the ruling with no way to ask for one or record one.
describe("shariahStep", () => {
  it("offers submission until the board has the terms, then the ruling", () => {
    expect(shariahStep(undefined)).toBe("submit");
    expect(shariahStep("draft")).toBe("submit");
    expect(shariahStep("withdrawn")).toBe("submit");
    expect(shariahStep("submitted")).toBe("certify");
    expect(shariahStep("certified")).toBe("resubmit");
  });
});

describe("action", () => {
  const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function run(form: FormData, reply: Response) {
    const calls: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: typeof init.body === "string" ? init.body : null });
      return Promise.resolve(reply.clone());
    });
    const args = {
      request: new Request("https://web.test/admin/products/prd_1/detail", { method: "POST", body: form }),
      context: { get: () => ({ env, ctx: null }) },
      params: { id: "prd_1" }
    } as unknown as ActionFunctionArgs;
    return { calls, result: action(args) };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the product to the board", async () => {
    const form = new FormData();
    form.set("intent", "shariah-submit");
    const { calls, result } = run(form, json({ productId: "prd_1", shariah: { state: "submitted" } }));
    expect(await result).toEqual({ done: "shariah-submit", queued: false, problem: null });
    expect(calls[0]?.url).toBe("https://api.test/v1/compliance/shariah/submit");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ productId: "prd_1" });
  });

  it("records a ruling with its references and expiry", async () => {
    const form = new FormData();
    form.set("intent", "shariah-certify");
    form.set("boardRef", "SSB-2026-04");
    form.set("fatwaRef", "F-118");
    form.set("expiresAt", "2027-06-30");
    const { calls, result } = run(form, json({ productId: "prd_1" }));
    await result;
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      productId: "prd_1",
      boardRef: "SSB-2026-04",
      fatwaRef: "F-118",
      expiresAt: Date.UTC(2027, 5, 30)
    });
  });

  // Certification is dual control and never auto-approved: the first answer is
  // always "a second person must approve", and that is a result, not a failure.
  it("reads the approval gate as queued, not as an error", async () => {
    const form = new FormData();
    form.set("intent", "shariah-certify");
    form.set("boardRef", "SSB");
    form.set("fatwaRef", "F");
    const { result } = run(
      form,
      json({ type: "about:blank", title: "Approval required", status: 403, code: "approval_required", policy_key: "compliance.shariah_certify" }, 403)
    );
    expect(await result).toMatchObject({ done: "shariah-certify", queued: true, problem: null });
  });
});
