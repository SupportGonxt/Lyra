import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// ADR-0118: `GET /v1/north/briefings/:id/grounding` is the read path for the
// provenance the narrator/audit stored. A briefing without an aiAuditId (or an
// audit row without grounding) answers `{grounding:null}` — never a guess.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let env: Env;
let db: Db;
let token: string;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  db = drizzle(client) as unknown as Db;
  const r = await seed(db as never, { mfaSecret: DEMO_TOTP_SECRET });
  tenantId = r.tenantId;

  env = { DB_CLIENT: db, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  const login = await call("POST", "/v1/auth/login", {
    email: "hala.zayed@gonxt.ae",
    password: PASSWORD,
    tenantSlug: "gonxt"
  });
  expect(login.status).toBe(200);
  token = login.body.token as string;
  const verified = await call(
    "POST",
    "/v1/auth/mfa/verify",
    { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
    { authorization: `Bearer ${token}` }
  );
  expect(verified.status).toBe(200);
}, 120_000);

describe("briefing grounding", () => {
  it("returns the stored provenance for a grounded briefing", async () => {
    const auditId = "aia_grounded_1";
    await db.insert(schema.aiAuditLog).values({
      id: auditId,
      tenantId,
      module: "north",
      purpose: "briefing.generate",
      model: "cortex0/lyra",
      provider: "aletheia",
      tier: "reasoning",
      inputHash: "h1",
      outputHash: "h2",
      tokensIn: 0,
      tokensOut: 0,
      costMicro: 0,
      latencyMs: 10,
      toolCallsJson: null,
      guardrailFlagsJson: null,
      groundingJson: JSON.stringify({
        epistemicCoverage: 1,
        state: "complete",
        facts: [{ factId: "F1", entity: "Acme", attribute: "revenue", source: "GL" }],
        contradictions: [],
        ood: false,
        samplingUsed: false
      }),
      actorRef: "user:u_1",
      subjectRef: null,
      outcome: "ok",
      ts: 1_700_000_000_000
    });
    await db.insert(schema.northBriefings).values({
      id: "brf_grounded_1",
      tenantId,
      date: "2026-01-07",
      audience: "exec",
      locale: "en",
      narrativeRef: "Grounded narrative.",
      highlightsJson: "[]",
      anomaliesJson: null,
      status: "review",
      generatedBy: "ai",
      aiAuditId: auditId,
      approvedBy: null,
      publishedAt: null,
      createdAt: 1_700_000_000_000
    });

    const res = await call<{ grounding: { state: string; epistemicCoverage: number; facts: { factId: string; source: string }[] } }>(
      "GET",
      "/v1/north/briefings/brf_grounded_1/grounding"
    );
    expect(res.status).toBe(200);
    expect(res.body.grounding.state).toBe("complete");
    expect(res.body.grounding.epistemicCoverage).toBe(1);
    expect(res.body.grounding.facts[0]!.source).toBe("GL");
  });

  it("answers null grounding for a briefing the narrator never grounded", async () => {
    await db.insert(schema.northBriefings).values({
      id: "brf_template_1",
      tenantId,
      date: "2026-01-08",
      audience: "exec",
      locale: "en",
      narrativeRef: "Template narrative.",
      highlightsJson: "[]",
      anomaliesJson: null,
      status: "draft",
      generatedBy: "template",
      aiAuditId: null,
      approvedBy: null,
      publishedAt: null,
      createdAt: 1_700_000_000_000
    });

    const res = await call<{ grounding: unknown }>("GET", "/v1/north/briefings/brf_template_1/grounding");
    expect(res.status).toBe(200);
    expect(res.body.grounding).toBeNull();
  });

  it("404s a briefing in another tenant", async () => {
    const res = await call("GET", "/v1/north/briefings/brf_missing/grounding");
    expect(res.status).toBe(404);
  });
});
