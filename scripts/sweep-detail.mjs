// The sibling of sweep.mjs, for the 38 routes behind an :id. It cannot read
// those routes off the manifest the way sweep.mjs does — `/admin/staff/:id` is
// not a URL — so it harvests real ones: open a route, collect every `a[href]`
// on the page, keep the hrefs matching a :param pattern, and open those in turn
// until nothing new appears.
//
// This is how sighting 4 was found (`admin.status.active` rendered raw on
// /admin/staff/:id while the list beside it translated the same column).
// Harvesting beats a hard-coded id list for the same reason: the ids come from
// whatever the environment actually seeded.
//
// Two scope decisions worth keeping, both of which were once wrong and cost
// coverage. The harvest iterates rather than taking one hop, because a policy
// detail hangs off a policy record and a journey builder off a journey record —
// one hop reached 13 of 38 patterns, three reach 22. And it reads the whole
// page rather than `main`: the grep is scoped to `main` because that is where a
// screen's prose is, but a link is reachable wherever it is rendered, and the
// design catalogue lives in the shell's nav.
//
//   node scripts/sweep-detail.mjs
//   SWEEP_BASE=https://staging.lyra.vantax.co.za node scripts/sweep-detail.mjs
//   SWEEP_HOPS=4 node scripts/sweep-detail.mjs
import { chromium } from "@playwright/test";
import { BASE, routePatterns, signIn, sweepRoute, report } from "./sweep-lib.mjs";

const STATIC = routePatterns({ param: false });
const PARAM = routePatterns({ param: true });

// `/axis/policies/:id/detail` becomes /^\/axis\/policies\/[^/]+\/detail$/. A
// :param never spans a slash, so one segment each — which is also what keeps
// `/:module/:resource/:id` from swallowing every href on the site: it still has
// to match segment count exactly.
const MATCHERS = PARAM.map((p) => ({
  pattern: p,
  re: new RegExp(`^${p.split("/").map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`)
}));

const browser = await chromium.launch();
const page = await browser.newPage();
await signIn(page);

const found = new Map(); // url -> the pattern it matched, for coverage reporting

/**
 * Every in-app href on the page, filtered to the ones this sweep can render.
 *
 * The whole document, not `main`. Those are two different subjects and reading
 * one for the other cost real coverage: the grep is scoped to `main` because
 * that is where a screen's *prose* is, but a link is reachable wherever it is
 * rendered, and `/surface/:module/:screen` — a whole design catalogue — is built
 * into the shell's nav (components/shell.tsx:199), outside `main`, so it was
 * reported "unreached" on every run while sitting in the navigation of every
 * page the harvest opened.
 */
async function harvest(path) {
  const hrefs = await page
    .goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45_000 })
    .then(() => page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))
    .catch(() => []);
  const fresh = [];
  for (const href of hrefs) {
    if (!href?.startsWith("/")) continue; // external and #anchors are not ours
    const url = href.split(/[?#]/)[0];
    // An attachment route streams bytes with a Content-Disposition, so a
    // `page.goto` on it triggers a download rather than a render: there is no
    // `main` to grep, and the sweep reported the browser's own "Download is
    // starting" as a finding. Their failure mode belongs to proxyFile
    // (api.server.ts) and its unit tests, not to a screen sweep.
    if (/\/(?:file|download)$/.test(url)) continue;
    if (found.has(url)) continue;
    const m = MATCHERS.find(({ re }) => re.test(url));
    if (m) {
      found.set(url, m.pattern);
      fresh.push(url);
    }
  }
  return fresh;
}

// Two hops, not one. A single pass over the static routes reached 13 of 38
// param patterns and reported the other 25 "unreached", which reads as a wall
// of dead links and is mostly not: a policy detail hangs off a policy record,
// a journey builder off a journey record, a whitespace dossier off a radar dot
// — every one of them **one hop below a detail route the first pass had already
// found**. A harvest shallower than the app's own link depth cannot tell a
// screen with no opener from a screen whose opener it never opened, and that is
// the exact distinction this sweep exists to make (sighting 13). So each round
// harvests from what the last one discovered, until nothing new appears.
const MAX_HOPS = Number(process.env.SWEEP_HOPS ?? 3);
// One instance of a pattern links the same way as the next, so following the
// 600th commission entry discovers nothing the first did. Cap what each hop
// carries forward per pattern; without it hop 2's frontier is every row in the
// seed and the run never ends.
const HARVEST_PER_PATTERN = Number(process.env.SWEEP_HARVEST_PER_PATTERN ?? 2);
function throttle(urls) {
  const seen = new Map();
  return urls.filter((u) => {
    const p = found.get(u);
    const n = (seen.get(p) ?? 0) + 1;
    seen.set(p, n);
    return n <= HARVEST_PER_PATTERN;
  });
}

let frontier = STATIC;
for (let hop = 1; hop <= MAX_HOPS && frontier.length; hop++) {
  console.log(`\nhop ${hop}: harvesting hrefs from ${frontier.length} routes\n`);
  const next = [];
  let n = 0;
  for (const path of frontier) {
    // Harvest is the long phase — dozens of loads at `networkidle`. Without a
    // line per route a slow run and a hung one read identically, which cost an
    // hour once.
    process.stdout.write(`  ${++n}/${frontier.length} ${path}\n`);
    next.push(...(await harvest(path)));
  }
  frontier = throttle(next);
}

const covered = new Set(found.values());
const unreached = MATCHERS.filter(({ pattern }) => !covered.has(pattern)).map((m) => m.pattern);
console.log(`\n${found.size} detail URLs across ${covered.size}/${PARAM.length} param routes`);
// A pattern no link reaches is not swept, and silence would read as a pass.
// "Unreached" is not "unreachable", and the difference is worth stating because
// the list reads like an alarm: a screen opened by an *interaction* rather than
// by a rendered href is invisible to a harvest that never clicks —
// /scout/whitespace/:id is a Link that appears only once a radar dot is
// selected (scout-radar.tsx:317) — and so is one whose list is empty in this
// environment's seed. routing.reachable.test.ts is the guard that answers
// "does anything build this path"; this list answers the narrower "did a reader
// walking from the front door find one", and the two disagreeing is the signal
// worth chasing.
if (unreached.length) console.log(`unreached patterns: ${unreached.join(", ")}`);
console.log("");

// A pattern renders one template, so the tenth instance of it teaches nothing
// the first three did not — and the seed has 600+ commission entries, which is
// two hours of loads to re-render the same two screens. Sweep a few per pattern
// instead: enough that a row with an empty column or a null field still shows
// up, few enough that the whole sweep is minutes.
const PER_PATTERN = Number(process.env.SWEEP_PER_PATTERN ?? 3);
const perPattern = new Map();
const sample = [...found].filter(([, pattern]) => {
  const n = (perPattern.get(pattern) ?? 0) + 1;
  perPattern.set(pattern, n);
  return n <= PER_PATTERN;
});
console.log(`sweeping ${sample.length} of ${found.size} — up to ${PER_PATTERN} per pattern\n`);

const tally = { ok: 0, hit: 0, bad: 0, denied: 0 };
for (const [url] of sample) tally[await sweepRoute(page, url)]++;

await browser.close();
process.exit(report("detail URLs", sample.length, tally) ? 1 : 0);
