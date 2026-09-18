import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIDDEN_ROUTES } from "./routing";

// The inverse of modules/spec.routes.test.ts. That one breaks on a link with no
// screen; this one breaks on a screen with no link.
//
// `HIDDEN_ROUTES` is a map of route to *why it never appears in the nav*, and
// most entries answer with a reachability claim — "opened from that partner,
// channel or staff record". Nothing verified those claims, so
// `/onboarding/:kind/:ref` sat fully implemented and unreachable: a real screen,
// a documented opener, and no path builder anywhere in the app. That is the
// dead-seam shape from the other direction, and the tell was a comment in
// portal.$tenantSlug.partners.tsx describing the screen staff supposedly reach.
//
// Only parameterised routes are checked. A static href is greppable as a
// literal and `spec.routes.test.ts` already covers the module specs; a route
// with a `:param` can only be reached by code that *builds* the path, which is
// the thing that goes missing.

const APP = import.meta.dirname;

/**
 * Claims an opener inside the app — as opposed to a marketing link, a token'd
 * email or a storefront footer, none of which this repo builds.
 *
 * The active voice belongs here too, and leaving it out cost most of this
 * guard's reach. HIDDEN_ROUTES writes a detail route's claim as "**opens** one
 * policy with its history from the policies list", not "opened from", and the
 * first version of this pattern matched only the passive: 16 of the 28 in-app
 * claims — every `:id/detail`, `/admin/customers/:id/360`, the journey builder,
 * the clawback, both analytics screens — fell out of the filter and the suite
 * reported green over 12. A guard that selects its subjects by matching prose
 * has to be held to the prose that is actually written, or it quietly grades
 * itself on the half it happens to parse.
 */
const IN_APP = /opened from|linked from|reached from|opens \w+|opens from/;
const EXTERNAL = /no session and no shell|marketing link|storefront footer|one-time token/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(e.name) || e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx")) return [];
    // routing.ts is the claim itself; routes.ts only declares the screens.
    if (path === join(APP, "routing.ts") || path === join(APP, "routes.ts")) return [];
    return [readFileSync(path, "utf8")];
  });
}

const CORPUS = sources(APP);

/**
 * Does anything build this path? A builder writes the literal segments before
 * the first `:param` and then interpolates — `/onboarding/${kind}/${ref}`,
 * `"/onboarding/" + kind`, or a spec `recordLink` href whose `{id}` record.tsx
 * substitutes. Matching on that prefix is what separates a real builder from a
 * bare mention in prose.
 */
function built(pattern: string): boolean {
  const prefix = pattern.split("/:")[0]!;
  // Literal prefix, then any further literal segments, then the interpolation:
  // `${…}` for a template, `{id}` for a spec recordLink href.
  // `["'\`]` anchors the start of the string literal, which is what keeps
  // `/v1/onboarding/partners/${ref}` — an API call, not a screen — from
  // answering for `/onboarding/:kind/:ref`.
  const builder = new RegExp(`["'\`]${prefix}(?:/[\\w.-]+)*/(?:\\$\\{|\\{)`);
  return CORPUS.some((src) => builder.test(src));
}

describe("every parameterised hidden route has something that builds its path", () => {
  const claims = Object.entries(HIDDEN_ROUTES).filter(
    ([path, why]) => path.includes("/:") && IN_APP.test(why) && !EXTERNAL.test(why)
  );

  // A generic pattern (`/:module/:resource`) has no literal prefix to key off —
  // record.tsx builds those, and spec.routes.test.ts already holds them.
  const checkable = claims.filter(([path]) => !path.startsWith("/:"));

  /**
   * Every parameterised hidden route must land in exactly one of three buckets,
   * and the leftover bucket must be empty.
   *
   * `expect(checkable.length).toBeGreaterThan(5)` used to stand here, and a
   * floor is not a contract: the filter above was matching 12 of the 28 in-app
   * claims and this assertion was happy, because 12 is more than 5. A route
   * whose claim the filter fails to recognise is not skipped loudly — it is
   * skipped silently, which is the same failure mode as the unreachable screen
   * the suite exists to catch. So account for all of them instead.
   */
  it("classifies every parameterised hidden route", () => {
    const all = Object.keys(HIDDEN_ROUTES).filter((p) => p.includes("/:"));
    const external = all.filter((p) => EXTERNAL.test(HIDDEN_ROUTES[p]!));
    // record.tsx builds these from a spec, and spec.routes.test.ts holds them.
    const generic = all.filter((p) => p.startsWith("/:"));
    const unclassified = all.filter(
      (p) =>
        !external.includes(p) && !generic.includes(p) && !checkable.some(([path]) => path === p)
    );
    expect(
      unclassified,
      "these claim no opener this guard recognises — reword the claim, or teach IN_APP the words it uses"
    ).toEqual([]);
    expect(checkable.length + external.length + generic.length).toBe(all.length);
  });

  for (const [path, why] of checkable) {
    it(`${path} is opened from somewhere`, () => {
      expect(built(path), `routing.ts says "${why}" — but nothing builds ${path}`).toBe(true);
    });
  }
});

/**
 * The same question for the routes with no `:param`. The header above says a
 * static href "is greppable as a literal and spec.routes.test.ts already covers
 * the module specs" — but that suite covers the *workspace specs*, and more than
 * half of these are not in one: /approvals, /design, /center, /search/results,
 * and all four `/journey/*` screens, whose claims describe a chain
 * ("reached via JourneyContinue from /journey/axis") that nothing held anyone
 * to. Greppable and not grepped is the same state as unchecked, and it is the
 * state /onboarding/:kind/:ref was in when it was found unreachable.
 *
 * The check is the literal, because that is all a static path needs: an href,
 * a redirect or a `to=` somewhere that is not routing.ts itself.
 */
describe("every static hidden route claiming an opener has a link to it", () => {
  /** `reached via JourneyContinue from …` — the journey chain's own wording. */
  const STATIC_IN_APP = new RegExp(`${IN_APP.source}|reached via`);
  /** A route with deliberately no UI and so deliberately no link. */
  const NO_UI = /no UI of its own|action only, no UI|pre-session/;

  const all = Object.entries(HIDDEN_ROUTES).filter(([p]) => !p.includes("/:"));
  const claims = all.filter(
    ([, why]) => STATIC_IN_APP.test(why) && !EXTERNAL.test(why) && !NO_UI.test(why)
  );

  it("classifies every static hidden route", () => {
    const unclassified = all
      .filter(([p, why]) => !NO_UI.test(why) && !EXTERNAL.test(why) && !claims.some(([q]) => q === p))
      .map(([p]) => p);
    expect(
      unclassified,
      "these claim no opener this guard recognises — reword the claim, or teach the pattern its words"
    ).toEqual([]);
  });

  for (const [path, why] of claims) {
    it(`${path} is linked from somewhere`, () => {
      // The path as a whole string literal: `to="/design"`, `href='/approvals'`,
      // `redirect(\`/center\`)`. Trailing `?` and `#` count — a link that carries
      // query context is still the link.
      const literal = new RegExp(`["'\`]${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#"'\`])`);
      expect(
        CORPUS.some((src) => literal.test(src)),
        `routing.ts says "${why}" — but no source links ${path}`
      ).toBe(true);
    });
  }
});
