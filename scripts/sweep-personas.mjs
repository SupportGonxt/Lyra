// sweep.mjs, once per demo seat instead of once as the administrator.
//
// Sighting 7: "a sweep's coverage is bounded by its persona's shells". That was
// written about which screens get *rendered* — tenant.admin resolves only to the
// `admin` shell, so every /orbit/* screen answered 403 and three `[object
// Object]` columns sat unseen. Signing in as the all-roles seat fixed that half.
//
// The other half is sighting 6, and no single-seat sweep can see it: /journey/*
// served HTTP 500 to every reader who was *not* a full administrator, because
// the loaders called `api()` bare and an ApiError is a crash to React Router.
// The widest persona is precisely the one reader that bug could not touch. So
// the question this script asks is not "does the screen render" but **"when
// this reader is refused, is it refused or does it crash"** — a 403 is a pass, a
// 500 is the defect.
//
// Per-seat the wall CHECK is off (a wall is the expected answer for a narrow
// role) and `ok` lines are suppressed: 18 seats x 77 routes is 1386 lines of
// nothing. What prints is FAIL, ERR and HIT.
//
//   node scripts/sweep-personas.mjs
//   SWEEP_BASE=http://127.0.0.1:5173 node scripts/sweep-personas.mjs
import { chromium } from "@playwright/test";
import { BASE, personas, routePatterns, signIn, signOut, sweepRoute, report } from "./sweep-lib.mjs";

const ROUTES = routePatterns({ param: false });
if (!ROUTES.includes("/")) ROUTES.unshift("/");

const browser = await chromium.launch();
const page = await browser.newPage();

const seats = await personas(page);
console.log(`${seats.length} demo seats x ${ROUTES.length} routes on ${BASE}\n`);

const totals = { ok: 0, hit: 0, bad: 0, denied: 0 };
for (const seat of seats) {
  await signOut(page).catch(() => {});
  await signIn(page, seat.email);
  const tally = { ok: 0, hit: 0, bad: 0, denied: 0 };
  for (const path of ROUTES) {
    tally[await sweepRoute(page, path, { walls: false, quiet: true })]++;
  }
  for (const k of Object.keys(tally)) totals[k] += tally[k];
  console.log(
    `  ${seat.email}: ${tally.ok} ok, ${tally.denied} refused, ${tally.hit} flagged, ${tally.bad} broken\n`
  );
}

await browser.close();
// A refusal is the right answer for a narrow seat, so `denied` is not counted
// against the run here — unlike sweep.mjs, where the persona is meant to reach
// everything and a refusal means the sweep proved nothing.
process.exit(report(`route loads across ${seats.length} seats`, totals.ok + totals.hit + totals.bad + totals.denied, { ...totals, denied: 0 }) ? 1 : 0);
