// Walks every static route as a signed-in reader and greps the rendered `main`
// for text that is not prose. SWEEP_BASE picks the environment; default is
// production. Read-only by construction — it never submits a form.
//
// Anything with a :param is scripts/sweep-detail.mjs's job. The shared parts —
// sign-in, checks, per-route verdict — live in sweep-lib.mjs.
//
//   node scripts/sweep.mjs
//   SWEEP_BASE=https://staging.lyra.vantax.co.za node scripts/sweep.mjs
import { chromium } from "@playwright/test";
import { BASE, routePatterns, signIn, sweepRoute, report } from "./sweep-lib.mjs";

// SWEEP_ONLY=/a,/b re-sweeps just those routes — the loop while fixing them.
const ONLY = process.env.SWEEP_ONLY?.split(",");
const ROUTES = routePatterns({ param: false }).filter((r) => !ONLY || ONLY.includes(r));
if (!ONLY && !ROUTES.includes("/")) ROUTES.unshift("/");

console.log(`sweeping ${ROUTES.length} routes on ${BASE}\n`);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
// A fixed desktop viewport, so the layout findings (sweep-lib `layoutFindings`)
// measure the same screen every run; reduced motion skips the cold open.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await signIn(page);

const tally = { ok: 0, hit: 0, bad: 0, denied: 0 };
for (const path of ROUTES) tally[await sweepRoute(page, path)]++;

await browser.close();
process.exit(report("routes", ROUTES.length, tally) ? 1 : 0);
