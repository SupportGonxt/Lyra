/* global document, window -- layoutFindings runs inside the page */
// Shared by sweep.mjs (static routes) and sweep-detail.mjs (routes behind an
// :id). The two differ only in how they find routes; sign-in, the not-prose
// checks and the per-route verdict are identical, and the last time they were
// separate scripts the detail one was lost and its 38 routes went unswept for
// weeks. One home means a check added for one sweep is live in both.
import { readdirSync, readFileSync } from "node:fs";

export const BASE = process.env.SWEEP_BASE ?? "https://lyra.vantax.co.za";

/**
 * Route patterns from the web manifest. `param` picks :id routes vs static.
 *
 * routes.ts is not the whole URL space. The last three entries in it are the
 * generic `:module`, `:module/:resource` and `:module/:resource/:id`, so every
 * *workspace landing page* — /analytics, /compliance, /admin, /ledger… — is a
 * real, nav-linked URL that no literal in routes.ts declares. Reading only the
 * literals, this sweep reported "77 routes, 0 unswept" while never once opening
 * the front door of 13 of the 13 workspaces: /analytics and /compliance have no
 * bespoke screen at all and were swept by nothing. WORKSPACE_PATHS (routing.ts)
 * is where the rail gets them, so it is where the sweep gets them too.
 *
 * **A route list derived from one of two sources of truth is a dead seam in the
 * tool that hunts for them.**
 */
export function routePatterns({ param }) {
  const src = readFileSync("apps/web/app/routes.ts", "utf8");
  const literals = [...src.matchAll(/route\("([^"]+)"/g)]
    .map((m) => m[1])
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
  // Same file-as-text idiom as I18N_KEYS below: routing.ts is TypeScript and
  // this is a plain .mjs script, so the list is read rather than imported.
  const declaration = readFileSync("apps/web/app/routing.ts", "utf8").match(
    /export const WORKSPACE_PATHS = \[([^\]]*)\]/s
  );
  // Loudly, not silently. A regex that stops matching would drop the workspace
  // landings back out of the sweep and report "0 not swept" over a smaller
  // list — which is the bug this whole function exists to have fixed.
  if (!param && !declaration) throw new Error("routing.ts no longer declares WORKSPACE_PATHS as a literal array");
  const workspaces = param ? [] : [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return [
    ...new Set(
      [...literals, ...workspaces]
        .filter((p) => p.includes(":") === param)
        .filter((p) => p !== "/login" && p !== "/logout")
    )
  ];
}

// An untranslated key is a key from the catalogue rendered as-is, so match the
// real key set rather than the shape of one. The old regex
// (/\b[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]+){2,}\b/) was wrong both ways: keys
// here are `area.thing`, two segments, so it could never match a real one, and
// it flagged every other dotted-lowercase token instead — "api.lyra.vantax.co.za"
// in a curl example, the seeded AXIS template key "group.medical.census" (whose
// display name lives in a sibling nameJson column and rendered correctly).
const I18N_KEYS = [
  ...new Set(
    [...readFileSync("apps/web/app/i18n/en.ts", "utf8").matchAll(/^\s*"([a-z][\w.]*\.[\w]+)":/gm)].map(
      (m) => m[1]
    )
  )
];
// Two ways a key reaches a screen, and neither check sees the other's case.
// A key in the catalogue printed verbatim is caught by membership. But the
// defect this check was written for — `admin.status.active` on /admin/staff/:id
// (fixed in f4dfaa4) — was a key in NO catalogue in either language, leaked by
// an unresolved lookup, so membership cannot see it. That one is caught by
// shape, narrowed to the namespaces the product actually owns: every first
// segment in the catalogue plus every module under app/modules. "admin" is
// there; "api" (api.lyra.vantax.co.za, in a curl example) and "group"
// (group.medical.census, a seeded AXIS template key whose display name lives in
// a sibling nameJson and rendered fine) are not, which is what made those three
// sweep hits false positives.
const NAMESPACES = [
  ...new Set([
    ...I18N_KEYS.map((k) => k.split(".")[0]),
    ...readdirSync("apps/web/app/modules")
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.startsWith("spec"))
      .map((f) => f.replace(/\.ts$/, ""))
  ])
].filter((n) => n !== "index");

const I18N_KEY_RE = new RegExp(
  `\\b(?:${I18N_KEYS.map((k) => k.replace(/\./g, "\\.")).join("|")}` +
    `|(?:${NAMESPACES.join("|")})(?:\\.[a-z][a-zA-Z0-9]*)+)\\b`
);

export const CHECKS = [
  [/\[object Object\]/, "[object Object]"],
  [/\bundefined\b/, "bare undefined"],
  [/\bNaN\b/, "NaN"],
  [I18N_KEY_RE, "untranslated i18n key"],
  [/[\w/-]+\/[\w-]+\.md\b/, "storage key"],
  [/\b\d{1,3},\d{3}-\d{2}-\d{2}\b/, "comma-grouped year"],
  // The sweep signs in holding all 24 roles, so a rendered permission wall is
  // always a lie about *this* reader — it is a 200 whose body says no, which
  // trips no other pattern and scored `ok`. That is how the settlement detail
  // screen hid: a 4xx on its /lines fetch was reported to the actor as a
  // missing grant. The prose is i18n/en.ts `error.forbidden`.
  [/Your roles do not include access/i, "permission wall shown to the all-roles persona"]
];

/**
 * Routes the permission-wall CHECK may not speak for, and why. The check's
 * premise is "this persona holds every role, so a wall is a lie about it" — and
 * the demo seat holds every **tenant** role (`TENANT_ROLE_KEYS`, seed.ts), not
 * every role there is. A workspace gated on a permission that only a goNXT
 * staff role carries is therefore walled *correctly* for every persona this
 * sweep can be, and the wall says nothing about whether the screen works.
 *
 * Keep this list to routes whose nav entry carries the same gate the screen
 * does — that pairing is what makes the wall by-design rather than a dead link.
 * Anything else belongs in the tally.
 */
const WALL_BY_DESIGN = {
  // ADR-0029. me.ts:451 gates the rail item on `admin:diagnostics:read`, and
  // rbac.ts grants that to platform.admin/support/engineer only, so the nav
  // never offers this to a tenant reader and the screen refusing it agrees.
  "/platform": "goNXT staff workspace — gated on admin:diagnostics:read, which no tenant role holds"
};

function inWallExceptions(path) {
  return Object.keys(WALL_BY_DESIGN).some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The persona is the sweep's coverage. sweep.mjs signed in as amina.saleh
 * (tenant.admin) for weeks, and tenant.admin resolves to the `admin` shell and
 * nothing else — a cross-module read deliberately does not imply a shell
 * (packages/core/src/lens.ts, ADR-0054 the one named exception). So every
 * /orbit/*, /axis/*, /signal/* shell screen answered 403 and was never
 * rendered, and three `[object Object]` columns on the ORBIT routing desk sat
 * there unseen while [object Object] was already a CHECKS pattern.
 *
 * The login page's demo picker carries one persona holding every role, which is
 * the only account that reaches every shell — the default here. Pass an `email`
 * (or set SWEEP_PERSONA) to sweep as one of the single-role seats instead;
 * `personas(page)` enumerates them, which is how a per-persona sweep covers the
 * shells the administrator's own roles happen not to open.
 *
 * The seat is chosen by the button's `value` — the persona's email, which
 * login.tsx puts on every one of them — and never by the label beside it. That
 * label reads "all 24 roles" only while the seed grants exactly 24: it is 25 on
 * a freshly seeded local DB, and matching `hasText: "all 24 roles"` made the
 * sweep hang on a 30s locator timeout that reads as a broken login page rather
 * than as a count that moved. **A selector keyed on a number the seed owns is a
 * dead seam in the tool that looks for them.**
 */
export async function signIn(page, email = process.env.SWEEP_PERSONA) {
  const seats = await personas(page);
  if (!seats.length) throw new Error(`${BASE}/login offers no demo personas — is this a demo deployment?`);
  // No email asked for: the widest seat, resolved from the rendered labels
  // rather than assumed. `auth.demo.allRoles` is the only label carrying a
  // count, so the one seat that has a number in it is the all-roles seat.
  const seat = email
    ? seats.find((s) => s.email === email)
    : seats.find((s) => /\d/.test(s.label)) ?? seats[0];
  if (!seat) throw new Error(`no demo persona for ${email} — have: ${seats.map((s) => s.email).join(", ")}`);
  // The picker is a <details> shut by default (login.tsx), so its buttons are in
  // the DOM but not clickable until it is opened. Clicking one signs in with no
  // password — a demo fixture, never a live credential.
  await page.locator("details").first().evaluate((d) => (d.open = true));
  await page.locator(`button[type=submit][name=email][value="${seat.email}"]`).first().click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 });
  console.log(`signed in as ${seat.email} (${seat.label})`);
  return seat;
}

/** Every demo seat the login page offers: `{ email, label }`, label being the
 *  role key or the all-roles count shown beside the name. */
export async function personas(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page
    .locator("details")
    .first()
    .evaluate((d) => (d.open = true))
    .catch(() => {});
  return page.locator("button[type=submit][name=email]").evaluateAll((bs) =>
    bs.map((b) => ({ email: b.getAttribute("value") ?? "", label: (b.textContent ?? "").trim() }))
  );
}

/**
 * Sign out, so the next persona starts from no session rather than inheriting
 * one. Dropping the cookie is the whole of it — the session lives in
 * `lyra_session` and the login page reads nothing else — and it is preferred
 * over posting to /logout because that route is action-only (HIDDEN_ROUTES) and
 * a sweep that never submits a form should not start here.
 */
export async function signOut(page) {
  await page.context().clearCookies();
}

/**
 * Render one route and classify it. Returns "ok" | "hit" | "bad" | "denied" so
 * a caller can tally; a denied route is counted as unswept and never as a pass,
 * because a route nothing rendered has been checked for nothing.
 */
/**
 * Layout, not text: what a reader sees in the first screen. Three findings,
 * each the shape a density audit (2026-09-23) found across most screens:
 *  - the same sentence printed twice (a headline restated as a card caption
 *    and again as the empty state's body);
 *  - the first piece of data (a row, a figure, a chart) starting in the lower
 *    half of the viewport, under forms, panels and prose;
 *  - a screen more than four viewports tall with no in-page navigation.
 * Measured on the rendered page, so it sees what the reader sees.
 */
export async function layoutFindings(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return [];
    const found = [];
    const seen = new Map();
    for (const el of main.querySelectorAll("h1, h2, h3, p, dd")) {
      const text = el.innerText?.trim().replace(/\s+/g, " ");
      // Prose only: a label or a name repeated once per card or row is data
      // doing its job, not a restated sentence.
      if (!text || text.split(" ").length < 6 || el.closest("[aria-hidden=true], table, li, article, [role=row], .eyebrow, [data-field-note]")) continue;
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
    const repeated = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
    if (repeated.length) found.push(`repeated sentence: ${JSON.stringify(repeated[0].slice(0, 60))}`);
    const top = main.getBoundingClientRect().top;
    const first = main.querySelector("tbody tr, dd, [data-stat], svg[role=img], ul:not(nav ul) > li, ol:not(nav ol) > li, article");
    const at = first ? first.getBoundingClientRect().top - top : null;
    if (at !== null && at > window.innerHeight / 2) found.push(`data starts ${Math.round(at)}px down`);
    const screens = main.scrollHeight / window.innerHeight;
    if (screens > 4 && !main.querySelector("nav, [role=tablist]")) {
      found.push(`${screens.toFixed(1)} screens tall with no in-page navigation`);
    }
    return found;
  });
}

export async function sweepRoute(page, path, { walls = true, quiet = false, layout = true } = {}) {
  // `walls` is the permission-wall CHECK, and it is only ever true of the seat
  // holding every tenant role. Sweeping as `axis.agent` and calling every wall
  // a defect would bury the thing a per-persona sweep is actually for — a
  // screen that 500s instead of refusing (sighting 6).
  const checks = CHECKS.filter(
    ([, label]) => !label.startsWith("permission wall") || (walls && !inWallExceptions(path))
  );
  let text = "";
  let status = "";
  try {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45_000 });
    status = res?.status() ?? "?";
    text = await page.locator("main").first().innerText({ timeout: 10_000 }).catch(() => "");
  } catch (err) {
    console.log(`ERR  ${path}  ${err.message.split("\n")[0]}`);
    return "bad";
  }
  if (status === 401 || status === 403) {
    console.log(`DENIED ${path}  [${status}]  not swept — persona cannot open it`);
    return "denied";
  }
  // A crash renders an error boundary whose prose trips none of the CHECKS, so
  // /north/explorer sat in this sweep's output logged `ok [500]` — the status
  // was printed all along and only the word beside it was wrong.
  if (typeof status === "number" && status >= 500) {
    console.log(`FAIL ${path}  [${status}]  server error`);
    return "bad";
  }
  const hits = checks
    .filter(([re]) => re.test(text))
    .map(([re, label]) => {
      const m = text.match(re);
      return `${label}: ${JSON.stringify(m[0].slice(0, 60))}`;
    });
  if (layout) hits.push(...(await layoutFindings(page).catch(() => [])));
  if (hits.length) {
    console.log(`HIT  ${path}  [${status}]  ${hits.join(" | ")}`);
    return "hit";
  }
  if (quiet) return "ok";
  console.log(`ok   ${path}  [${status}]  ${text.length}b`);
  return "ok";
}

export function report(kind, total, tally) {
  const bad = tally.bad + tally.hit;
  console.log(
    `\n${total} ${kind}, ${bad} flagged, ${tally.denied} not swept` +
      (tally.denied ? " — a denied route proves nothing about what it renders" : "")
  );
  return bad;
}
