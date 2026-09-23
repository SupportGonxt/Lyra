import { describe, expect, it, vi } from "vitest";

// Static import, not `await import(...)` inside the test: the loader's module
// graph pulls in ScoutShell and the whole @lyra/ui tree, and importing it from
// a test body charges that one-off Vite transform (~200ms idle, >5s when the
// monorepo's suites run in parallel and every worker queues behind the same
// dev server) against the 5000ms testTimeout. At module scope it is collect
// time, which has no such budget. Same shape as orbit-shell/axis-shell.
vi.mock("../session.server", () => ({
  bootstrapSession: vi.fn()
}));

import { bootstrapSession } from "../session.server";
import { loader } from "./scout-shell";

function fakeContext(env: Record<string, unknown>) {
  return { get: () => ({ env }) } as never;
}

describe("scout-shell loader", () => {
  it("returns session when roles resolve to scout", async () => {
    vi.mocked(bootstrapSession).mockResolvedValue({
      availableShells: ["scout"],
      brand: { name: "Test" }
    } as never);
    const result = await loader({
      request: new Request("https://lyra.test/scout/radar"),
      context: fakeContext({})
    } as never);
    expect(result).toEqual({
      availableShells: ["scout"],
      brand: { name: "Test" }
    });
  });

  it("throws 403 not 401 when roles don't resolve to scout", async () => {
    vi.mocked(bootstrapSession).mockResolvedValue({
      availableShells: ["north"],
    aiPause: { all: false, modules: [] },
      brand: { name: "Test" }
    } as never);
    await expect(
      loader({
        request: new Request("https://lyra.test/scout/radar"),
        context: fakeContext({})
      } as never)
    ).rejects.toMatchObject({ init: { status: 403 } });
  });
});
