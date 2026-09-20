import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { loader } from "./ledger-account";

// docs/27 "thin screens": this screen could show a statement and export
// nothing. What is pinned here is the address the download goes to — the same
// account, window and currency the loader read the statement with, normalised
// the way the API takes them (instants, not date strings), because a file that
// answers a different question from the screen above it is worse than no file.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetchByUrl(replies: Array<[string, Response]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    const match = replies.find(([part]) => url.includes(part));
    return Promise.resolve(match ? match[1].clone() : json({}));
  });
  return calls;
}

const me = (permissions: string[]) =>
  json({ actor: {}, permissions, roles: [], nav: [], policy: { currency: "AED" } });

const STATEMENT = { accountCode: "1000", openingMinor: 0, closingMinor: 500, lines: [] };

function loaderArgs(search = ""): LoaderFunctionArgs {
  return {
    request: new Request(`https://web.test/ledger/statement${search}`),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as LoaderFunctionArgs;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loader", () => {
  it("refuses without the journal permission", async () => {
    const calls = stubFetchByUrl([["/v1/me", me(["ledger:recon:read"])]]);
    expect(await loader(loaderArgs("?account=1000"))).toMatchObject({ denied: true });
    expect(calls.some((url) => url.includes("/statement"))).toBe(false);
  });

  it("names no export address until an account is picked", async () => {
    stubFetchByUrl([["/v1/me", me(["ledger:journals:read"])]]);
    expect(await loader(loaderArgs())).toMatchObject({ exportUrl: "", statement: null });
  });

  it("carries the account, window and currency onto the export address", async () => {
    stubFetchByUrl([
      ["/v1/me", me(["ledger:journals:read"])],
      ["/statement", json(STATEMENT)],
      ["/balance", json({ accountCode: "1000", currency: "AED", debitMinor: 500, creditMinor: 0, balanceMinor: 500 })]
    ]);

    const loaded = await loader(loaderArgs("?account=1000&currency=AED&from=2026-06-01&to=2026-06-30"));
    const url = (loaded as { exportUrl: string }).exportUrl;

    expect(url.startsWith("https://api.test/v1/ledger/reports/account-statement/export?")).toBe(true);
    expect(url).toContain("code=1000");
    expect(url).toContain("currency=AED");
    // Instants, not date strings — and `to` is the end of that day, so a line
    // posted during the last day is in the file as well as on the screen.
    expect(url).toContain(`from=${Date.parse("2026-06-01T00:00:00.000Z")}`);
    expect(url).toContain(`to=${Date.parse("2026-06-30T23:59:59.999Z")}`);
    expect(url.endsWith("&")).toBe(true);
  });
});
