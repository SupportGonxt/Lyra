/* global document, location, URL -- the probes run inside the page */
// Can each role do its job, and does the product tell it the truth?
//
// The route sweeps answer "does every screen render for every seat". This asks
// the adoption question instead: signed in as each demo seat, starting from
// where Lyra lands that seat, can it *find* its jobs (docs/06 journeys) in a
// click or two, does the screen open, does it show that seat real data near
// the top, and does it offer a next action. Read-only, like every sweep.
//
//   SWEEP_BASE=http://127.0.0.1:5173 CHROMIUM=/opt/pw-browsers/chromium node scripts/role-adoption.mjs
//
// Prints one `SEAT {json}` line per persona and `JOB {json}` per job; the
// report reads those. SWEEP_PERSONA narrows to one seat.
import { chromium } from "@playwright/test";
import { BASE, signIn, signOut } from "./sweep-lib.mjs";

/** [journey, job, path] per seat, from docs/06 §2 and each module's shell. */
const JOBS = {
  "demo@gonxt.ae": [
    ["J-E1", "Read the morning brief", "/north/brief"],
    ["CMD", "Run the business from the command center", "/center"],
    ["APPR", "Decide what is waiting on me", "/approvals"]
  ],
  "amina.saleh@gonxt.ae": [
    ["J-A2", "Invite a teammate and give them a role", "/admin/staff"],
    ["J-A3", "Pause AI agents in an incident", "/admin/ai/console"],
    ["SET", "Set brand and tenant policy", "/settings"],
    ["APPR", "Decide what is waiting on me", "/approvals"]
  ],
  "layla.hassan@gonxt.ae": [
    ["J-O1", "Clear the exceptions queue", "/axis/exceptions"],
    ["CLM", "Work the claims desk", "/axis/claims/desk"],
    ["FNOL", "Register a claim", "/axis/claims/new"],
    ["CASE", "Work my cases", "/axis/cases"]
  ],
  "omar.farouk@gonxt.ae": [
    ["J-O1", "See what failed automation today", "/axis/exceptions"],
    ["BIND", "Compare quotes and bind", "/distribution/quote-requests"],
    ["J-O3", "Reconcile the month's bordereaux", "/axis/bordereaux"],
    ["APPR", "Decide what is waiting on me", "/approvals"],
    ["INS", "See how operations performed", "/axis/analytics"]
  ],
  "raed.samir@gonxt.ae": [
    ["J-D1", "Get a test key and make a first call", "/admin/developer"],
    ["KEYS", "Manage API keys", "/admin/api-keys"],
    ["HOOK", "Check webhook deliveries", "/admin/webhook-deliveries"]
  ],
  "mona.idris@gonxt.ae": [
    ["MAP", "See where the money sits", "/ledger/money-map"],
    ["STMT", "Read a channel's commission statement", "/distribution/commission-entries/statement"],
    ["PNL", "Read the month's P&L", "/ledger/reports/pnl"]
  ],
  "faisal.omar@gonxt.ae": [
    ["J-O3", "Close the month", "/ledger/period-close"],
    ["STL", "Run and approve settlements", "/ledger/settlement"],
    ["JRN", "Post a manual journal", "/ledger/journal"],
    ["APPR", "Decide what is waiting on me", "/approvals"],
    ["PNL", "Read the month's P&L", "/ledger/reports/pnl"]
  ],
  "nadia.rahman@gonxt.ae": [
    ["APPR", "Countersign approvals", "/approvals"],
    ["J-O3", "Close the month", "/ledger/period-close"],
    ["REC", "Reconcile the bank", "/ledger/recon"]
  ],
  "rana.hadid@gonxt.ae": [
    ["EXP", "Explore any metric", "/north/explorer"],
    ["ANOM", "Investigate anomalies", "/north/anomalies"],
    ["JH", "Check journey health", "/north/journeys"],
    ["BLD", "Build a report", "/analytics/builder"]
  ],
  "hala.zayed@gonxt.ae": [
    ["J-E1", "Read the morning brief", "/north/brief"],
    ["J-E2", "Prepare the board pack", "/north/board"],
    ["J-E3", "Ask a what-if", "/north/whatif"],
    ["DEC", "Track decisions", "/north/decisions"]
  ],
  "hind.saqr@gonxt.ae": [
    ["CHN", "Connect a channel", "/orbit/channel-connectors"],
    ["RTE", "Set routing rules", "/orbit/routing-rules"],
    ["QA", "Review service quality", "/orbit/quality"],
    ["SUP", "Supervise live queues", "/orbit/supervisor"]
  ],
  "sara.nasser@gonxt.ae": [
    ["J-X1", "Catch a handover and resolve it", "/orbit/console"],
    ["CNV", "Work my conversations", "/orbit/conversations"],
    ["KB", "Find an answer in the knowledge base", "/orbit/kb-articles"]
  ],
  "dana.aziz@gonxt.ae": [
    ["PRT", "Manage partners", "/orbit/partners"],
    ["PIPE", "Work the partner pipeline", "/orbit/pipeline"],
    ["CHN", "See channel performance", "/distribution/channels"]
  ],
  "yusuf.karim@gonxt.ae": [
    ["J-X2", "Work the save desk", "/orbit/save"],
    ["REN", "Work renewals", "/axis/renewals"],
    ["NBO", "Propose a next-best offer", "/distribution/next-best-offers/suggest"]
  ],
  "yasmin.faris@gonxt.ae": [["DP", "Read the data products we bought", "/scout/data-products"]],
  "tariq.mansour@gonxt.ae": [
    ["J-P1", "Review the whitespace radar", "/scout/radar"],
    ["J-P2", "Prepare a panel negotiation", "/scout/panel"],
    ["EXPT", "Run a product experiment", "/scout/experiments"]
  ],
  "noor.jamal@gonxt.ae": [
    ["J-M1", "See CAC by channel", "/signal/cockpit"],
    ["J-M2", "Approve this morning's budget moves", "/signal/budget"],
    ["STU", "Make campaign variants", "/signal/studio"],
    ["J-M3", "Own the answer box", "/signal/answer-engines"]
  ],
  "khalid.rashed@gonxt.ae": [
    ["J-CO1", "Answer a regulator request", "/admin/audit-log"],
    ["SCR", "Clear screening hits", "/compliance/screenings"],
    ["DSAR", "Handle a privacy request", "/compliance/dsar-requests"]
  ]
};

const ONLY = process.env.SWEEP_PERSONA?.split(",");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/** Same-origin paths a reader can click from the current page, query stripped. */
const linksHere = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("a[href]")]
      .map((a) => new URL(a.getAttribute("href"), location.href))
      .filter((u) => u.origin === location.origin && !u.pathname.startsWith("/logout"))
      .map((u) => u.pathname.replace(/\/$/, "") || "/")
  );

/** What a reader sees on the screen in front of them. */
const measure = () =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const top = main.getBoundingClientRect().top;
    const first = main.querySelector("tbody tr, dd, [data-stat], svg[role=img], ul:not(nav ul) > li, ol:not(nav ol) > li, article");
    const rows = main.querySelectorAll("tbody tr").length;
    const stats = main.querySelectorAll("[data-stat], dd").length;
    const empties = [...main.querySelectorAll(".border-dashed")].filter((e) => e.querySelector("h3")).length;
    const actions = [...main.querySelectorAll("button:not([disabled]), a[href]")].filter((e) => !e.closest("nav, header [aria-label=breadcrumb]")).length;
    const text = main.innerText ?? "";
    return {
      title: (main.querySelector("h1")?.innerText ?? document.title).trim().slice(0, 80),
      firstDataPx: first ? Math.round(first.getBoundingClientRect().top - top) : null,
      rows,
      stats,
      empties,
      actions,
      ai: (text.match(/✦/g) ?? []).length,
      words: text.split(/\s+/).filter(Boolean).length
    };
  });

for (const [email, jobs] of Object.entries(JOBS)) {
  if (ONLY && !ONLY.includes(email)) continue;
  await signOut(page).catch(() => {});
  await signIn(page, email);
  // Sign-in lands through a redirect; measure the home it settles on, not the
  // login page still on screen when waitForURL first resolves.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45_000 });
  if (new URL(page.url()).pathname.endsWith("/login")) throw new Error(`${email}: still on the login page after sign-in`);
  const landing = new URL(page.url()).pathname;
  const home = await measure();

  // Two clicks of reach: every link on the landing page, then every link one hop on.
  const depth = new Map([[landing, 0]]);
  const first = [...new Set(await linksHere())];
  for (const p of first) if (!depth.has(p)) depth.set(p, 1);
  for (const p of first.slice(0, 45)) {
    if (/\/(export|audit-export)$|\/file$|\/download$/.test(p)) continue;
    const res = await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    if (!res || res.status() >= 400) continue;
    for (const q of await linksHere()) if (!depth.has(q)) depth.set(q, 2);
  }

  for (const [journey, job, path] of jobs) {
    const t0 = Date.now();
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => null);
    const status = res?.status() ?? 0;
    const m = status && status < 400 ? await measure() : null;
    const clicks = depth.get(path) ?? null;
    const opened = status > 0 && status < 400;
    const hasData = !!m && (m.rows > 0 || m.stats > 0) && m.empties === 0;
    const aboveFold = !!m && m.firstDataPx !== null && m.firstDataPx <= 450;
    const actionable = !!m && m.actions > 0;
    const score = [clicks !== null && clicks <= 2, opened, hasData, aboveFold, actionable].filter(Boolean).length;
    console.log(`JOB ${JSON.stringify({ email, journey, job, path, status, clicks, ms: Date.now() - t0, opened, hasData, aboveFold, actionable, score, ...m })}`);
  }
  console.log(`SEAT ${JSON.stringify({ email, landing, reach: depth.size, home })}`);
}
await browser.close();
