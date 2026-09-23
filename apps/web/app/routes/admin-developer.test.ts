import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { LABELS, SIGNING_HEADERS, action, devLede, keyTone, labelsIn, listOf, surfaceOf } from "./admin-developer";

// Rotating a webhook secret is a one-shot reveal: the plaintext exists only in
// the response of the POST, and the receiver stops verifying the old one
// immediately. These tests hold the two properties that make that safe — it asks
// before it rotates, and the secret comes back to the caller rather than being
// dropped by a redirect.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/admin/developer", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("labelsIn", () => {
  it("keeps ar on exactly the keys en has", () => {
    expect(Object.keys(LABELS.ar ?? {}).sort()).toEqual(Object.keys(LABELS.en ?? {}).sort());
  });

  it("translates every key rather than echoing english", () => {
    for (const [key, value] of Object.entries(LABELS.ar ?? {})) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toBe(LABELS.en?.[key]);
    }
  });

  it("falls back to the key rather than rendering nothing", () => {
    expect(labelsIn("de")("title")).toBe(LABELS.en?.title);
    expect(labelsIn("en")("nope")).toBe("nope");
  });

  it("interpolates the policy the approval notice quotes", () => {
    expect(labelsIn("en")("approvalBody", { policy: "webhook.rotate" })).toContain("webhook.rotate");
  });
});

describe("listOf", () => {
  it("takes the hydrated array, parses raw text, and survives malformed text", () => {
    expect(listOf(["a", "b"])).toEqual(["a", "b"]);
    expect(listOf('["a"]')).toEqual(["a"]);
    expect(listOf("nonsense")).toEqual([]);
    expect(listOf('{"a":1}')).toEqual([]);
  });
});

describe("surfaceOf", () => {
  it("counts paths and operations from the live document", () => {
    expect(
      surfaceOf({
        info: { version: "1.4.0" },
        paths: { "/v1/core/roles": { get: {}, post: {} }, "/v1/core/roles/{id}": { patch: {} } },
        tags: [{ name: "core" }, { name: "ledger" }, { id: "not a name" }]
      })
    ).toEqual({ version: "1.4.0", paths: 2, operations: 3, tags: ["core", "ledger"] });
  });

  it("reports an empty surface rather than throwing when the API answers with nothing useful", () => {
    expect(surfaceOf(null)).toEqual({ version: "", paths: 0, operations: 0, tags: [] });
    expect(surfaceOf({ paths: { "/x": null } })).toEqual({ version: "", paths: 1, operations: 0, tags: [] });
  });
});

describe("keyTone", () => {
  it("marks a live key differently from a test key, and a revoked key as spent", () => {
    expect(keyTone({ mode: "live", revokedAt: null })).toBe("warning");
    expect(keyTone({ mode: "test", revokedAt: null })).toBe("info");
    expect(keyTone({ mode: "live", revokedAt: 1 })).toBe("neutral");
  });
});

describe("devLede", () => {
  const l = labelsIn("en");

  it("names test mode when nothing live is calling in", () => {
    expect(devLede([{ mode: "test", revokedAt: null } as never], [], l)).toBe(LABELS.en?.introEmpty);
  });

  it("counts only live, unrevoked keys and active hooks", () => {
    const keys = [
      { mode: "live", revokedAt: null },
      { mode: "live", revokedAt: 1 },
      { mode: "test", revokedAt: null }
    ] as never[];
    const hooks = [{ status: "active" }, { status: "disabled" }] as never[];
    expect(devLede(keys, hooks, l)).toBe("1 live key and 1 active webhook are calling this API right now.");
  });
});

describe("signing contract", () => {
  it("names the four headers apps/api/src/dispatch.ts actually signs with", () => {
    expect([...SIGNING_HEADERS]).toEqual([
      "x-lyra-event",
      "x-lyra-event-id",
      "x-lyra-timestamp",
      "x-lyra-signature"
    ]);
  });
});

describe("rotate", () => {
  it("returns the new secret once, to the caller", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ id: "whk_1", url: "https://hooks.test/in", secret: "whsec_new" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "rotate", hookId: "whk_1", confirm: "on", idempotencyKey: "k1" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/core/webhooks/whk_1/rotate");
    expect(calls[0]?.method).toBe("POST");
    expect(result.rotated).toEqual({ id: "whk_1", url: "https://hooks.test/in", secret: "whsec_new" });
  });

  it("refuses without the confirmation, because the old secret dies on success", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "rotate", hookId: "whk_1" })));

    expect(result.error).toBe("confirmRequired");
    expect(calls).toHaveLength(0);
  });

  it("needs an endpoint", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "rotate", confirm: "on" })));

    expect(result.error).toBe("hookRequired");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a refusal as a Problem rather than throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403, code: "approval_required" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "rotate", hookId: "whk_1", confirm: "on" })));

    expect(result.problem?.status).toBe(403);
    expect(result.rotated).toBeNull();
  });
});

describe("test", () => {
  it("pings the endpoint and returns the delivery result", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ ok: true, status: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "test", hookId: "whk_1" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/core/webhooks/whk_1/test");
    expect(calls[0]?.method).toBe("POST");
    expect(result.tested).toEqual({ ok: true, status: 200 });
  });

  it("needs an endpoint", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "test" })));

    expect(result.error).toBe("hookRequired");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a refusal as a Problem rather than throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403 }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "test", hookId: "whk_1" })));

    expect(result.problem?.status).toBe(403);
    expect(result.tested).toBeNull();
  });
});

describe("unknown intent", () => {
  it("answers 400 without calling the API", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "rotate-everything" })));

    expect(result.problem?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
