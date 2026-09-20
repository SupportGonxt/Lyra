import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.server", () => ({
  api: vi.fn(),
  directory: vi.fn(async () => []),
  fetchMe: vi.fn(async () => ({ actor: { id: "us_1" } })),
  ApiError: class extends Error {}
}));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { action } from "./conversation";

// docs/27 F32: the macro endpoint has a human caller, and this is the contract
// between them — a key, never wording. An agent who could edit a canned reply
// on its way out would make the macro library a suggestion rather than a
// standard, so the post body is asserted, not just the call.

function fakeContext() {
  return { get: () => ({ env: {} }) } as never;
}

function post(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://app.test/orbit/conversations/cnv_1", { method: "POST", body: form });
}

describe("conversation action — macro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the macro key to the conversation's macro endpoint and nothing else", async () => {
    vi.mocked(api).mockResolvedValueOnce({});
    const result = await action({
      request: post({ intent: "macro", macroKey: "renewal_link", nonce: "n1" }),
      params: { id: "cnv_1" },
      context: fakeContext()
    } as never);

    expect(api).toHaveBeenCalledTimes(1);
    const [path, opts] = vi.mocked(api).mock.calls[0]!;
    expect(path).toBe("/v1/orbit/conversations/cnv_1/macro");
    expect((opts as { method: string }).method).toBe("POST");
    expect((opts as { body: unknown }).body).toEqual({ macroKey: "renewal_link" });
    // A send that runs twice is a customer reading the same thing twice.
    expect((opts as { headers: Record<string, string> }).headers["idempotency-key"]).toBe("n1");
    expect(result).toMatchObject({ done: "done.macro" });
  });

  it("does nothing at all when no macro was chosen", async () => {
    const result = await action({
      request: post({ intent: "macro" }),
      params: { id: "cnv_1" },
      context: fakeContext()
    } as never);
    expect(api).not.toHaveBeenCalled();
    expect(result).toMatchObject({ done: null });
  });
});
