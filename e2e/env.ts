import { resolve } from "node:path";
import { tmpdir } from "node:os";

// One fixed location, wiped and rebuilt every e2e run (playwright.config.ts).
// File-mode libsql, so the on-prem API process and the migrate/seed CLIs can
// all open the same database by path — no server to stand up first.
const ROOT = resolve(tmpdir(), "lyra-e2e");

export const DB_PATH = resolve(ROOT, "e2e.db");
export const FILES_DIR = resolve(ROOT, "files");
export const LIBSQL_URL = `file:${DB_PATH}`;

// 8787 collides with other local wrangler-dev projects on this machine — picked
// to avoid Playwright's reuseExistingServer silently attaching to a stray one.
export const API_PORT = 8797;
export const WEB_PORT = 5173;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

// Matches DEFAULT_PASSWORD in packages/core/src/seed.ts — the GONXT demo
// tenant, e2e's only fixture, never a live credential.
export const SEED_PASSWORD = "Gonxt-Demo-2026!";
export const TENANT_SLUG = "gonxt";

export const PERSONAS = {
  tenantAdmin: { email: "amina.saleh@gonxt.ae", name: "Amina Saleh" },
  axisAgent: { email: "layla.hassan@gonxt.ae", name: "Layla Hassan" },
  axisLead: { email: "omar.farouk@gonxt.ae", name: "Omar Farouk" },
  axisAdmin: { email: "suhail.hamdan@gonxt.ae", name: "Suhail Hamdan" },
  financeController: { email: "nadia.rahman@gonxt.ae", name: "Nadia Rahman" },
  financeController2: { email: "faisal.omar@gonxt.ae", name: "Faisal Omar" },
  northExec: { email: "hala.zayed@gonxt.ae", name: "Hala Zayed" },
  complianceOfficer: { email: "khalid.rashed@gonxt.ae", name: "Khalid Al Rashed" },
  signalLead: { email: "noor.jamal@gonxt.ae", name: "Noor Jamal" },
  scoutLead: { email: "tariq.mansour@gonxt.ae", name: "Tariq Mansour" },
  orbitAgent: { email: "sara.nasser@gonxt.ae", name: "Sara Al Nasser" },
  orbitRetention: { email: "yusuf.karim@gonxt.ae", name: "Yusuf Karim" }
} as const;
