/**
 * The journey routes sit outside the module shells on purpose — the point of a
 * cross-module journey is that any signed-in reader can walk it — so the API is
 * the only thing that says no. All three loaders called `api()` bare, and an
 * ApiError React Router can only treat as a crash: production served HTTP 500
 * and "This did not load / The page could not be built" to north.exec on
 * /journey/axis and /journey/scout, and to tenant.compliance on all three.
 * `asRouteError` (api.server.ts) is the seam that turns a 403 into the
 * boundary's "not permitted"; these tests assert each loader routes through it.
 *
 * The subject list is **read out of routes.ts**, not typed here. It used to name
 * three loaders as literals, which covers the three screens that had the bug and
 * nothing else: /journey/signal was already registered beside them and absent
 * from the list, and a fifth journey route tomorrow would ship uncovered in
 * exactly the same silence. A guard that enumerates its own subjects by hand is
 * the same shape as the defect it guards — a contract with no reader — so the
 * route table is the single source, and adding a route adds a test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { api, fetchMe } = vi.hoisted(() => ({ api: vi.fn(), fetchMe: vi.fn() }));
// Only the callers are faked. asRouteError is the real one — a loader that
// forgets to call it must still fail this suite, so the seam itself is never
// mocked away.
vi.mock("../api.server", () => ({ api, fetchMe, asRouteError, ApiError }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { data } from "react-router";
import { ApiError } from "../api-error";

function asRouteError(error: unknown): never {
  if (error instanceof ApiError) throw data(error.requestId, { status: error.status });
  throw error;
}

/**
 * Every route that reaches a loader without a module shell in front of it: the
 * four `journey/*` screens plus the ORBIT journey builder, which is the same
 * cross-module walk keyed by an id. Matching on the path, not the filename, is
 * what keeps a renamed file in scope.
 */
const ROUTES = [
  ...readFileSync(join(import.meta.dirname, "..", "routes.ts"), "utf8").matchAll(
    /route\("((?:journey\/|orbit\/journeys\/)[^"]+)", "routes\/([^"]+)\.tsx"/g
  )
].map(([, path, file]) => ({ path: `/${path}`, file: file! }));

const SUBJECTS = await Promise.all(
  ROUTES.map(async (r) => ({
    ...r,
    // `.tsx` spelled in the static part: vite's dynamic-import-vars plugin
    // cannot build the glob without an extension and warns on every run.
    loader: ((await import(`./${r.file}.tsx`)) as { loader?: (a: never) => Promise<unknown> }).loader
  }))
);

const args = (path: string) =>
  ({
    request: new Request(`https://lyra.vantax.co.za${path}`),
    context: { get: () => ({ env: { API_ORIGIN: "https://api.example" } }) },
    params: { id: "jr_1" }
  }) as never;

/**
 * Arm both callers to reject, and clear the call log first — "this loader asked
 * the API for nothing" is read off that log below, so a count left over from the
 * previous subject answers for this one. mockReset, not a beforeEach: a function
 * returned from a vitest beforeEach is that hook's *teardown* and gets invoked,
 * so `beforeEach(() => api.mockClear())` calls the mock and fails the test with
 * the mock's own rejection.
 *
 * mockImplementation, not mockRejectedValue: the latter builds the rejected
 * promise at setup time, before any handler attaches, and vitest fails the test
 * on the unhandled rejection instead of running it.
 */
function arm(error: unknown) {
  const reject = () => Promise.reject(error);
  api.mockReset().mockImplementation(reject);
  fetchMe.mockReset().mockImplementation(reject);
}

const refuse = () =>
  arm(new ApiError({ title: "Forbidden", status: 403, instance: "/x" }, "req_1"));

it("found the journey routes", () => {
  // routes.ts moving or the regex rotting would otherwise empty this suite and
  // report green, which is the failure mode a source-reading guard has.
  expect(SUBJECTS.length).toBeGreaterThanOrEqual(5);
  expect(SUBJECTS.every((s) => s.loader)).toBe(true);
});

// No beforeEach reset: every test sets its own mockImplementation, and a
// `beforeEach(() => api.mockClear())` — an arrow returning the mock — makes
// vitest treat the returned function as the hook's teardown and call it, which
// invokes the mock and surfaces its rejection as the test's failure.
describe.each(SUBJECTS)("$file loader", ({ loader, path }) => {
  it("rethrows a 403 as a route error, not a crash", async () => {
    refuse();
    const thrown = await loader!(args(path)).then(
      () => null,
      (e: unknown) => e
    );

    // A loader that asks the API for nothing — /journey/signal reads only its
    // query string — has nothing to route through the seam and passes by having
    // no call to get wrong. Asserting on it would demand a call it should not
    // make, so the pass is recorded against what it did: it resolved, and it
    // resolved without touching the API.
    if (!api.mock.calls.length && !fetchMe.mock.calls.length) {
      expect(thrown).toBeNull();
      return;
    }

    // A bare ApiError here is the bug: the boundary reads it as a 500. What
    // asRouteError throws is react-router's `data()` — the status the boundary
    // reads travels in `init`, and the request id support needs is the payload.
    expect(thrown).not.toBeInstanceOf(ApiError);
    const routeError = thrown as { type: string; data: unknown; init: { status: number } };
    expect(routeError.type).toBe("DataWithResponseInit");
    expect(routeError.init.status).toBe(403);
    expect(routeError.data).toBe("req_1");
  });

  it("leaves a real fault alone", async () => {
    const boom = new TypeError("fetch failed");
    arm(boom);
    const thrown = await loader!(args(path)).then(
      () => null,
      (e: unknown) => e
    );
    if (!api.mock.calls.length && !fetchMe.mock.calls.length) {
      expect(thrown).toBeNull();
      return;
    }
    expect(thrown).toBe(boom);
  });
});
