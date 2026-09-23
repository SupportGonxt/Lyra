import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Guards on /v1/ai that the journey suite does not reach: who may write the
// suggestion telemetry, and which handler owns `GET /v1/ai/runs/:id`.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

// tenant.admin holds `ai:*:read`; axis.agent holds no `ai:` permission beyond
// the suggestion telemetry it is shown. The suggestion negative case is
// dev.admin, not a module operator: every persona that is shown an ambient
// suggestion now carries `ai:suggestions:read` so it can record the outcome
// (rbac.ts ROLES), and a developer-console seat sees no suggestion surface.
const PEOPLE: Record<string, string> = {
  "tenant.admin": "amina.saleh",
  "axis.agent": "layla.hassan",
  "dev.admin": "raed.samir"
};

let env: Env;
let database: Db;
let tokens: Record<string, string>;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
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
  database = drizzle(client) as unknown as Db;
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    // The streaming route needs a provider to reach. A binding that answers
    // with the plain object rather than a ReadableStream is also the case
    // workers-ai.stream degrades through — a model that ignores `stream: true`
    // is served as a stream of one rather than as an error.
    AI: { run: async () => ({ response: "Cedar is cheaper because of the excess." }) }
  } as unknown as Env;

  tokens = {};
  for (const [role, local] of Object.entries(PEOPLE)) {
    const login = await call(null, "POST", "/v1/auth/login", {
      email: `${local}@gonxt.ae`,
      password: PASSWORD,
      tenantSlug: "gonxt"
    });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const verified = await call(
      null,
      "POST",
      "/v1/auth/mfa/verify",
      { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
      { authorization: `Bearer ${token}` }
    );
    expect(verified.status).toBe(200);
    tokens[role] = token;
  }

  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  tenantId = customer.tenantId;
}, 120_000);

/* -------------------------------------------------------------- suggestions */

describe("ai suggestion telemetry is gated", () => {
  const shown = { surface: "chip" as const, module: "axis" };

  it("refuses an actor without ai:suggestions:read", async () => {
    const created = await call("dev.admin", "POST", "/v1/ai/suggestions", shown);
    expect(created.status).toBe(403);

    // The outcome leg is gated on the same permission, not just on ownership —
    // otherwise the acceptance rate stays writable by anyone with a session.
    const outcome = await call("dev.admin", "POST", "/v1/ai/suggestions/sug_nope/outcome", {
      outcome: "accepted"
    });
    expect(outcome.status).toBe(403);
  });

  it("lets an actor with ai:suggestions:read record and resolve one", async () => {
    const created = await call("tenant.admin", "POST", "/v1/ai/suggestions", shown);
    expect(created.status).toBe(201);
    expect(created.body.tenantId).toBe(tenantId);
    expect(created.body.outcome).toBe("shown");

    const outcome = await call(
      "tenant.admin",
      "POST",
      `/v1/ai/suggestions/${created.body.id}/outcome`,
      { outcome: "accepted" }
    );
    expect(outcome.status).toBe(204);

    const row = await call("tenant.admin", "GET", `/v1/ai/suggestions/${created.body.id}`);
    expect(row.body.outcome).toBe("accepted");
  });
});

/* ---------------------------------------------------------------- streaming */

// docs/27 F35. The guardrail arithmetic is the gateway's (evals/streaming);
// what only this level can hold is that the route really answers SSE, really
// records the run, and really refuses before streaming when it should.
describe("POST /v1/ai/runs/stream", () => {
  async function sse(who: string, payload: unknown): Promise<{ status: number; body: string }> {
    const res = await app.fetch(
      new Request("http://api.test/v1/ai/runs/stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` },
        body: JSON.stringify(payload)
      }),
      env as never,
      exec as never
    );
    return { status: res.status, body: await res.text() };
  }

  it("answers an event stream and closes with a done event carrying the run id", async () => {
    const res = await sse("axis.agent", {
      agentKey: "quoting",
      purpose: "quote.explain",
      input: "draft a short note about renewals"
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("event: done");
    const done = JSON.parse(res.body.split("event: done\ndata: ")[1]!.split("\n")[0]!);
    expect(done.runId).toMatch(/^air_/);
    expect(done.auditId).toMatch(/^aia_/);

    const rows = await database.select().from(schema.aiRuns);
    const row = rows.find((r) => r.id === done.runId);
    expect(row!.state).toBe("succeeded");
    // A streamed run is audited like any other (CLAUDE.md §3).
    expect(row!.outputRef).toBe(done.auditId);
  });

  // Same door, same lock: `purpose` is a safety input wherever it arrives.
  it("refuses an unregistered purpose before opening a stream", async () => {
    const res = await sse("axis.agent", {
      agentKey: "quoting",
      purpose: "not.a.purpose",
      input: "hello"
    });
    expect(res.status).toBe(400);
  });

  it("refuses an actor without the agent module's ai:invoke", async () => {
    const res = await sse("dev.admin", { agentKey: "quoting", purpose: "quote.explain", input: "hello" });
    expect(res.status).toBe(403);
  });
});

/* --------------------------------------------------------------- run views */

describe("GET /v1/ai/runs/:id reaches the CRUD record handler", () => {
  const runId = "air_shadow_test";

  beforeAll(async () => {
    await database.insert(schema.aiRuns).values({
      id: runId,
      tenantId,
      agentKey: "creative",
      module: "signal",
      purpose: "aeo.draft",
      actorRef: "user:seed",
      autonomyLevel: "suggest",
      trigger: "user",
      state: "succeeded",
      inputHash: "",
      startedAt: Date.now()
    });
  });

  it("answers with a flat row, not the enriched wrapper", async () => {
    const res = await call("tenant.admin", "GET", `/v1/ai/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.run).toBeUndefined();
    expect(res.body.id).toBe(runId);
    expect(res.body.agentKey).toBe("creative");
    expect(res.body.state).toBe("succeeded");
  });

  it("serves the enriched view from /detail", async () => {
    const res = await call("tenant.admin", "GET", `/v1/ai/runs/${runId}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.toolCalls).toEqual([]);
    expect(res.body.audit).toBeNull();
  });

  it("still gates the enriched view on ai:runs:read", async () => {
    const res = await call("axis.agent", "GET", `/v1/ai/runs/${runId}/detail`);
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------- query params */

describe("numeric query params survive garbage input", () => {
  // `Number("abc")` is NaN; fed to `.limit()` or a `gte()` bind it turns a
  // read endpoint into a 500. Garbage falls back to the default instead.
  it("GET /v1/ai/audit with a garbage limit and since answers 200", async () => {
    const res = await call("tenant.admin", "GET", "/v1/ai/audit?limit=abc&since=abc");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /v1/ai/audit/spend with garbage days answers 200", async () => {
    const res = await call("tenant.admin", "GET", "/v1/ai/audit/spend?days=abc");
    expect(res.status).toBe(200);
  });

  it("GET /v1/ai/suggestions/acceptance with garbage days answers 200", async () => {
    const res = await call("tenant.admin", "GET", "/v1/ai/suggestions/acceptance?days=abc");
    expect(res.status).toBe(200);
  });
});

/* ------------------------------------------------------------ kill switches */

// docs/12 §4: "Kill switches: per-agent, per-module, per-tenant, global — all
// one click, all logged". Per-agent is covered by J-A3 in journeys.test.ts;
// these are the three wider tiers and the read that shows them.

describe("tenant and module kill switches", () => {
  async function state(who = "tenant.admin") {
    return (await call(who, "GET", "/v1/ai/kill-switches")).body;
  }

  it("starts with every tier clear", async () => {
    expect(await state()).toMatchObject({ global: false, tenant: false, modules: [] });
  });

  it("pauses one module without touching the rest", async () => {
    const paused = await call("tenant.admin", "POST", "/v1/ai/pause", {
      module: "scout",
      reason: "Scout is citing a retired price list."
    });
    expect(paused.status).toBe(204);
    expect(await state()).toMatchObject({ tenant: false, modules: ["scout"] });

    const audits = await database.select().from(schema.auditLog);
    expect(audits.some((a) => a.action === "ai.module.paused" && a.subjectRef === "scout")).toBe(true);

    expect((await call("tenant.admin", "POST", "/v1/ai/resume", { module: "scout" })).status).toBe(204);
    expect(await state()).toMatchObject({ modules: [] });
  });

  it("pauses the whole tenant, and stops a model call with 503", async () => {
    expect(
      (await call("tenant.admin", "POST", "/v1/ai/pause", { reason: "Vendor incident, stop everything." }))
        .status
    ).toBe(204);
    expect(await state()).toMatchObject({ tenant: true });

    const run = await call("axis.agent", "POST", "/v1/ai/runs", {
      agentKey: "quoting",
      purpose: "quote.explain",
      input: "Why is Cedar cheaper?"
    });
    expect(run.status).toBe(503);

    expect((await call("tenant.admin", "POST", "/v1/ai/resume", {})).status).toBe(204);
    expect(await state()).toMatchObject({ tenant: false });
  });

  it("refuses a pause from an actor without ai:killswitch:use", async () => {
    const res = await call("axis.agent", "POST", "/v1/ai/pause", { reason: "not mine to throw" });
    expect(res.status).toBe(403);
  });

  it("needs a reason, so the audit row says why", async () => {
    expect((await call("tenant.admin", "POST", "/v1/ai/pause", {})).status).toBe(400);
  });
});

/* ----------------------------------------------- autonomy has one door only */

// Raising an agent's autonomy is dual control, never auto-approvable
// (`ai.autonomy_raise`, POST /v1/ai/agents/:key/autonomy). The generic agents
// CRUD was a second door with no gate: a PATCH of `autonomyLevel`, or a create
// that starts above the floor, widened what an agent may do without asking.
describe("the agents CRUD cannot move autonomy", () => {
  it("refuses a PATCH that changes autonomyLevel", async () => {
    const [agent] = await database.select().from(schema.aiAgents).where(eq(schema.aiAgents.tenantId, tenantId)).limit(1);
    const res = await call("tenant.admin", "PATCH", `/v1/ai/agents/${agent!.id}`, { autonomyLevel: "autonomous" });
    expect(res.status).toBe(400);
    const [after] = await database.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent!.id));
    expect(after!.autonomyLevel).toBe(agent!.autonomyLevel);
  });

  it("still lets the CRUD change other fields and restate the same level", async () => {
    const [agent] = await database.select().from(schema.aiAgents).where(eq(schema.aiAgents.tenantId, tenantId)).limit(1);
    const res = await call("tenant.admin", "PATCH", `/v1/ai/agents/${agent!.id}`, {
      tier: "standard",
      autonomyLevel: agent!.autonomyLevel
    });
    expect(res.status).toBe(200);
  });

  it("lets the CRUD lower autonomy — narrowing needs no second seat", async () => {
    const [agent] = await database.select().from(schema.aiAgents).where(eq(schema.aiAgents.tenantId, tenantId)).limit(1);
    const res = await call("tenant.admin", "PATCH", `/v1/ai/agents/${agent!.id}`, { autonomyLevel: "suggest" });
    expect(res.status).toBe(200);
    const [after] = await database.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent!.id));
    expect(after!.autonomyLevel).toBe("suggest");
  });

  it("refuses a create above the default rung, and allows one at it", async () => {
    const body = (key: string, autonomyLevel: string) => ({
      key,
      module: "signal",
      nameJson: { en: "Probe", ar: "مسبار" },
      autonomyLevel
    });
    const high = await call("tenant.admin", "POST", "/v1/ai/agents", body("autonomy-bypass-probe", "autonomous"));
    expect(high.status).toBe(400);
    const ok = await call("tenant.admin", "POST", "/v1/ai/agents", body("autonomy-floor-probe", "act_with_approval"));
    expect(ok.status).toBe(201);
  });
});
