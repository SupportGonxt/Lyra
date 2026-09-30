/**
 * A compressed month of a Yalla Compare-shaped tenant, driven through the real
 * API as every seeded persona, to validate RBAC, CRUD and the business flows at
 * volume and to try to break them. Local only: a fresh libSQL database under
 * SIM_DIR, the real app served over HTTP on SIM_PORT (so the web UI and the
 * sweeps can point at it), and the scheduled tick run in-process against the
 * virtual clock (clock.ts) so nightly jobs fire once per simulated day.
 *
 *   SIM_SCALE=0.1 SIM_DAYS=3 pnpm --filter @lyra/api exec tsx sim/month.ts
 *
 * Never point this at a deployed environment: it writes, fuzzes and deletes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { BENCH } from "./bench.js";
import { allFindings, call, find, latencyTable, pool, totalCalls, type Client } from "./lib.js";
import { flows, funnel } from "./flows.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const DIR = resolve(process.env.SIM_DIR ?? join(ROOT, ".sim"));
const PORT = Number(process.env.SIM_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 86_400_000;

function boot(): void {
  if (process.env.SIM_KEEP_DB !== "1") rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "files"), { recursive: true });
  process.env.LIBSQL_URL = `file:${join(DIR, "sim.db")}`;
  process.env.DATABASE_URL = process.env.LIBSQL_URL;
  process.env.FILES_DIR = join(DIR, "files");
  process.env.ENVIRONMENT = "local";
  process.env.FIELD_KEY ??= "sim-field-key";
  process.env.APP_ORIGIN ??= "http://127.0.0.1:5173";
  process.env.SESSION_COOKIE ??= "lyra_session";
  if (process.env.SIM_KEEP_DB !== "1") {
    const env = { ...process.env };
    execFileSync("pnpm", ["--filter", "@lyra/db", "migrate"], { cwd: ROOT, env, stdio: "ignore" });
    execFileSync("pnpm", ["--filter", "@lyra/core", "seed"], { cwd: ROOT, env, stdio: "ignore" });
  }
}

boot();
// Imported after boot: node.ts reads LIBSQL_URL when the env is built.
const { makeEnv, tick } = await import("../src/node.js");
const worker = (await import("../src/index.js")).default;
const env = makeEnv();
const exec = { waitUntil() {}, passThroughOnException() {} };
const server = serve({ fetch: (req: Request) => worker.fetch(req, env, exec as never), port: PORT });

const anon: Client = { base: BASE, persona: "anonymous" };

/* ------------------------------------------------------------ personas */

export interface Seat extends Client {
  email: string;
  roleKey: string;
  permissions: Set<string>;
}

/** Sessions live on the virtual clock, so every clock move can expire them. */
async function relogin(people: Seat[]): Promise<void> {
  for (const seat of people) {
    const login = await call(anon, "POST", "/v1/auth/demo/login", { email: seat.email });
    if (login.status === 200) seat.token = login.json.token;
  }
}

async function seats(): Promise<Seat[]> {
  const list = await call(anon, "GET", "/v1/auth/demo/personas");
  const out: Seat[] = [];
  for (const p of list.json.data as { email: string; roleKey: string }[]) {
    const login = await call(anon, "POST", "/v1/auth/demo/login", { email: p.email });
    if (login.status !== 200) {
      find({ severity: "high", kind: "login", route: "POST /v1/auth/demo/login", persona: p.email, status: login.status, detail: login.text.slice(0, 200) });
      continue;
    }
    const seat: Seat = { base: BASE, persona: p.email, email: p.email, roleKey: p.roleKey, token: login.json.token, permissions: new Set() };
    const me = await call(seat, "GET", "/v1/me");
    seat.permissions = new Set(me.json?.permissions ?? []);
    out.push(seat);
  }
  return out;
}

/* --------------------------------------------------------------- clock */

let simNowMs = Date.now();
/** Move the virtual clock to an absolute instant (forward only). */
async function clockTo(target: number): Promise<void> {
  const delta = target - simNowMs;
  if (delta <= 0) return;
  const res = await call(anon, "POST", "/v1/auth/demo/clock", { advanceMs: Math.round(delta) });
  if (res.status !== 200) throw new Error(`clock refused: ${res.status} ${res.text}`);
  simNowMs = res.json.simNow;
}
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY) * DAY;

/* ------------------------------------------------ RBAC / CRUD matrix */

interface Op {
  method: string;
  path: string;
  permission: string | null;
}

async function operations(): Promise<Op[]> {
  const spec = (await call(anon, "GET", "/openapi.json")).json;
  const ops: Op[] = [];
  for (const [path, byMethod] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
    // Pre-session, public, provider-signed and SCIM-token surfaces have their
    // own credentials; the matrix is about sessions and roles.
    if (/^\/v1\/(auth|portal|channels|scim|realtime)\b|^\/carrier-sandbox|^\/health|^\/openapi/.test(path)) continue;
    for (const [method, op] of Object.entries(byMethod)) {
      if (!op.security) continue;
      ops.push({ method: method.toUpperCase(), path, permission: op.security[0]?.session?.[0] ?? null });
    }
  }
  return ops;
}

/**
 * Every persona against every operation. An id in the path is a record that
 * does not exist, so nothing is destroyed: a reader without the permission
 * must be refused (403) before anything else, a reader with it must be
 * answered without a crash. The permission list is the API's own (/v1/me), so
 * the oracle is the declared contract, not this file's opinion of it.
 */
async function rbacMatrix(people: Seat[]): Promise<void> {
  const ops = await operations();
  let checked = 0;
  for (const seat of people) {
    await pool(ops, 8, async (op) => {
      const path = op.path.replace(/\{[^}]+\}/g, "zz_sim_missing");
      const body = op.method === "GET" || op.method === "DELETE" ? undefined : {};
      const res = await call(seat, op.method, path, body);
      checked++;
      const held = op.permission === null || seat.permissions.has(op.permission);
      const route = `${op.method} ${op.path}`;
      if (res.status === 401) {
        find({ severity: "high", kind: "session-lost", route, persona: seat.email, status: 401, detail: "a freshly signed-in session was refused" });
        return;
      }
      if (!held && res.status !== 403 && res.status < 500) {
        find({
          severity: res.status < 300 ? "critical" : "medium",
          kind: res.status < 300 ? "rbac-bypass" : "rbac-order",
          route,
          persona: seat.email,
          status: res.status,
          detail: `lacks ${op.permission} but got ${res.status}${res.status < 300 ? "" : " (not 403: a check runs after lookup/validation)"}`
        });
      }
      // An approval gate is the permission working, not a refusal of it.
      if (held && res.status === 403 && !/approval_required/.test(res.text)) {
        find({ severity: "medium", kind: "rbac-denied", route, persona: seat.email, status: 403, detail: `holds ${op.permission ?? "(session only)"} yet refused: ${res.text.slice(0, 160)}` });
      }
    });
  }
  console.log(`rbac matrix: ${checked} checks across ${people.length} personas and ${ops.length} operations`);
}

/* ------------------------------------------------------------- fuzzing */

const HOSTILE: Record<string, unknown> = {
  "1MB string": { name: "x".repeat(1_000_000) },
  // Sent as raw text: JSON.stringify of it would overflow this process first.
  "deep nesting": "[".repeat(5000) + "]".repeat(5000),
  "wrong types": { name: 12, amountMinor: "a lot", currency: ["AED"], id: null },
  "injection": { name: "'; DROP TABLE core_customers; --", q: "%' OR 1=1 --", email: "a@b.c<script>alert(1)</script>" },
  "unicode": { name: "‮أحمد\u0000￿😀", notes: "\uD800" },
  "regex bomb": { email: "a@" + ".".repeat(60_000) + "@", phone: "+".repeat(60_000), q: "a".repeat(60_000) + "!" },
  "negative money": { amountMinor: -1e18, premiumMinor: Number.MAX_SAFE_INTEGER + 2 },
  "not json": "{not: json"
};

async function fuzz(admin: Seat): Promise<void> {
  const ops = (await operations()).filter((o) => o.method === "POST" || o.method === "PATCH");
  const lists = (await operations()).filter((o) => o.method === "GET" && !o.path.includes("{"));
  await pool(ops, 6, async (op) => {
    const path = op.path.replace(/\{[^}]+\}/g, "zz_sim_missing");
    for (const [label, body] of Object.entries(HOSTILE)) {
      const res = await call(admin, op.method, path, body);
      if (res.ms > 2_000) {
        find({ severity: "high", kind: "fuzz-slow", route: `${op.method} ${op.path}`, status: res.status, detail: `${label}: ${Math.round(res.ms)}ms` });
      }
      if (res.status >= 500) {
        find({ severity: "high", kind: "fuzz-crash", route: `${op.method} ${op.path}`, status: res.status, detail: `${label}: ${res.text.slice(0, 160)}` });
      }
    }
  });
  // Query-string abuse on every list: page bounds, sort injection, huge search.
  await pool(lists, 6, async (op) => {
    for (const qs of ["limit=100000", "limit=-5", "limit=abc", "sort=;drop", "sort=-nonexistent", `q=${"%25".repeat(3000)}`, "cursor=not-a-cursor"]) {
      const res = await call(admin, "GET", `${op.path}?${qs}`);
      if (res.status >= 500) find({ severity: "high", kind: "query-crash", route: `GET ${op.path}`, status: res.status, detail: `${qs}: ${res.text.slice(0, 160)}` });
    }
  });
}

/* ------------------------------------------------------------ the month */

const people = await seats();
console.log(`personas: ${people.length} signed in`);
const admin = people.find((p) => p.permissions.size === Math.max(...people.map((x) => x.permissions.size)))!;

simNowMs = (await call(anon, "POST", "/v1/auth/demo/clock", { advanceMs: 0 })).json.simNow;
const run = flows({ base: BASE, anon, people, admin, bench: BENCH });
await run.setup();

for (let day = 1; day <= BENCH.days; day++) {
  const dayStart = startOfUtcDay(simNowMs) + DAY;
  // Nightly window: the spend pull, autopilot, snapshotter and the other
  // first-tick-of-the-day jobs gate on 00:00-00:15 UTC (index.ts scheduled).
  await clockTo(dayStart + 5 * 60_000);
  const t0 = performance.now();
  await tick(env);
  const tickMs = performance.now() - t0;
  if (tickMs > 60_000) find({ severity: "medium", kind: "slow-tick", route: "scheduled", detail: `day ${day}: ${Math.round(tickMs)}ms` });
  // Backup window, then the business day.
  await clockTo(dayStart + 2 * 3_600_000 + 5 * 60_000);
  await tick(env);
  await clockTo(dayStart + 9 * 3_600_000);
  await relogin(people);
  await run.day(day);
  console.log(`day ${day}: tick ${Math.round(tickMs)}ms, ${totalCalls()} calls so far, ${allFindings().length} findings`);
}

await run.close();
await relogin(people);
console.log("rbac matrix…");
await rbacMatrix(people);
console.log("fuzzing…");
await fuzz(admin);
await run.invariants();

const report = { calls: totalCalls(), funnel: Object.fromEntries([...funnel.entries()].sort()), findings: allFindings(), latency: latencyTable().slice(0, 40) };
console.log(`REPORT ${JSON.stringify(report)}`);
console.log(`done: ${report.calls} calls, ${report.findings.length} findings (grep '^REPORT ' for the full report)`);
if (process.env.SIM_SERVE !== "1") {
  server.close();
  process.exit(0);
}
console.log(`API left running on ${BASE} for the UI sweep (SIM_SERVE=1)`);
