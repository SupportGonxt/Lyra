import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { action } from "./module";

// A webhook signing secret exists in exactly one response: the 201 that mints
// it. Every read strips it (apps/api/src/resources.ts `secretColumns`), so if
// the create flow discards the body the tenant can never sign a delivery again.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCreate(body: unknown) {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    )
  );
}

 
function args(module: string, resource: string): any {
  return {
    request: new Request(`https://web.test/${module}/${resource}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "create", url: "https://hook.test", eventTypesJson: "[]" })
    }),
    params: { module, resource },
    context: { get: () => ({ env, ctx: {} }) }
  };
}

describe("a secret the API returns once is shown once", () => {
  it("carries the minted webhook secret back to the render", async () => {
    stubCreate({ id: "whk_01", url: "https://hook.test", secret: "whsec_ABC123" });
    const result = await action(args("admin", "webhooks"));

    expect(result).toMatchObject({ problem: null, revealed: "whsec_ABC123" });
  });

  it("reveals nothing on a resource that mints nothing", async () => {
    stubCreate({ id: "idp_01", name: "Acme SSO", secret: "should never be read" });
    const result = await action(args("admin", "identity-providers"));

    // No `revealOnCreate` on the spec: a stray field in a response is not a
    // reason to print it on screen.
    expect(result).toMatchObject({ problem: null, revealed: null });
  });
});

// A create that succeeded said nothing: the panel stayed open with the values
// still typed, and a second press made a duplicate row.
describe("a create says what it made", () => {
  it("hands back the new record's id so the screen can confirm and link it", async () => {
    stubCreate({ id: "whk_01", url: "https://hook.test", secret: "whsec_ABC123" });
    const result = await action(args("admin", "webhooks"));
    expect(result).toMatchObject({ created: "whk_01" });
  });
});
