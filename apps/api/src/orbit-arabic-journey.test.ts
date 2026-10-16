import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema, type Db } from "@lyra/db";
import { permissionsForRole, seed, totpAt, TOTP_STEP_SEC, type Ctx, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import { gatewayFor } from "./mw.js";
import { sweepQaScores } from "./engines/orbit-qa.js";
import type { Env } from "./env.js";

// docs/modules/orbit.md §8, criterion 1: **"WhatsApp inbound in Arabic: quote →
// bind end-to-end with one human approval, transcript fully logged and
// QA-scored."**
//
// Every component existed and no test walked them as one path — `J-C2 help on
// WhatsApp` is English and stops at a draft. Four obstacles stood in the way, and
// each is answered below rather than worked around:
//
//   1. `sweepQaScores` runs from the scheduler alone (`index.ts:335`), so this
//      file holds a `Ctx` and a gateway and calls the engine. That is why it is
//      its own file: `journeys.test.ts` drives `app.fetch` and never holds one.
//   2. `parseCxDimensions` needs a JSON object carrying **every** rubric
//      dimension, so the stub reply is shaped for the judge and stays prose for
//      every other reader.
//   3. `POST /v1/orbit/messages` requires `orbit:conversations:reply`, held by
//      `orbit.agent` — `sara.nasser` — not by an AXIS seat.
//   4. The journey is shop → **select** → bind. `bind` refuses an unselected
//      quote (`routes/axis.ts:931`) and refuses one that carries no commission
//      (`:785`), so the chosen response must have commission **greater than
//      zero** — `!== null` is not enough, because zero is a commission of
//      nothing, and picking one is how this test first earned a 400 where it
//      expected the approval gate.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

/** Arabic, because the criterion is about the Arabic path and not a translated one. */
const ASK = "هل يغطي تأميني الزجاج الأمامي؟";
const ANSWER = "نعم، الزجاج الأمامي مشمول بتأمينك الشامل. يمكنك المطالبة عبر التطبيق.";

/**
 * Every rubric dimension, 1–5 — and **nothing else**.
 *
 * `parseCxDimensions` parses the *whole* reply (`parseJsonObject` →
 * `JSON.parse(stripFence(reply))`, `packages/model-gateway/src/parse.ts:35`), so a
 * trailing sentence makes it throw and the run is discarded. A stub that reads
 * like a model's answer, with a friendly note after the JSON, is scored as
 * nothing at all — which is how this file first produced a transcript and no
 * score.
 */
const JUDGE_REPLY = '{"accuracy":4,"clarity":4,"tone":5,"actionability":4,"why":"grounded in the transcript above"}';

let database: Db;
let env: Env;
let seeded: SeedResult;
let tokens: Record<string, string>;
let customerId: string;
let consentId: string;
let productId: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  extra: Record<string, string> = {}
): Promise<Res<T>> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : null) as T };
}

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * The ONE human approval: refused first, decided, then the same call succeeds.
 *
 * The decider is a parameter because the **deciding seat** has to hold the
 * permission the approval is for — `axis.bind`'s approval asks for
 * `axis:policies:create`, so an orbit agent gets a 403 on the decision itself.
 * `axis.bind` is single control, so the AXIS lead may decide their own, which is
 * how `journeys.test.ts` walks J-O1 too.
 */
async function throughApproval<T = any>(who: string, approver: string, method: string, path: string, payload: unknown): Promise<T> {
  const first = await call(who, method, path, payload);
  expect(first.status, JSON.stringify(first.body)).toBe(403);
  expect(String(first.body.type)).toContain("approval_required");
  const approvalId = first.body.approval_id as string;
  expect(approvalId).toBeTruthy();
  ok(await call(approver, "POST", `/v1/me/approvals/${approvalId}/decide`, { decision: "approved" }));
  return ok<T>(await call(who, method, path, payload), 200, 201);
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(stmt);
  }
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    // Stubbed at the binding, so the guardrails, the AI audit row and the QA
    // score are all still exercised rather than faked.
    AI: {
      run: async (_model: string, input: { text?: string[] }) =>
        input?.text ? { data: input.text.map(() => [0.1, 0.2, 0.3]) } : { response: JUDGE_REPLY }
    }
  } as unknown as Env;

  tokens = {};
  for (const [who, local] of [["agent", "sara.nasser"], ["lead", "omar.farouk"]] as const) {
    const login = ok(await call(null, "POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" }));
    const token = login.token as string;
    const verified = await app.fetch(
      new Request("http://api.test/v1/auth/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) })
      }),
      env as never,
      exec as never
    );
    expect(verified.status).toBe(200);
    tokens[who] = token;
  }

  const [customer] = await database.select().from(schema.customers).limit(1);
  customerId = customer!.id;
  consentId = customer!.consentId!;
  const [product] = await database.select().from(schema.products).where(eq(schema.products.line, "motor"));
  productId = product!.id;
}, 120_000);

/**
 * The `Ctx` the QA engine needs.
 *
 * A default policy and entitlements, not the tenant's: `sweepQaScores` reads the
 * `qa` agent row and the transcripts from the database and consults no tenant
 * config, and passing the seeded strings to these schemas is how this file first
 * earned a raw `ZodError` ("expected object, received string") instead of a
 * result — they take an object, not the JSON text the column holds.
 */
function ctxFor(): Ctx {
  return {
    db: database as never,
    tenantId: seeded.tenantId,
    actor: { kind: "system", id: "scheduler", tenantId: seeded.tenantId, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_qa",
    now: Date.now(),
    locale: "ar",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  } as unknown as Ctx;
}

describe("ORBIT §8 criterion 1 — the Arabic WhatsApp path", () => {
  it("quotes, binds through one approval and logs the transcript, in Arabic", async () => {
    // 1. Inbound on WhatsApp, in Arabic.
    const conversation = ok(
      await call("agent", "POST", "/v1/orbit/conversations", { channel: "whatsapp", customerId, state: "open", lang: "ar" }),
      201
    );
    ok(await call("agent", "POST", "/v1/orbit/messages", { conversationId: conversation.id, role: "customer", content: ASK }), 201);
    // `agent_human`, because that is the role `loadTranscripts` reads as "the
    // reply" (`engines/orbit-qa.ts:162` — `agent_human` or `agent_ai`). A message
    // posted as `"agent"` is stored and shown but is **invisible to the judge**,
    // which is why this journey first produced a transcript and no score: the
    // sweep skips a conversation whose transcript carries no reply, by design.
    ok(await call("agent", "POST", "/v1/orbit/messages", { conversationId: conversation.id, role: "agent_human", content: ANSWER }), 201);

    // 2. Quote → select → bind, through exactly one approval.
    const shopped = ok(
      await call("lead", "POST", "/v1/dist/quote-requests/shop", {
        productId,
        channelId: seeded.channels.web,
        customerId,
        consentId,
        inputs: { age: 34, sumInsuredMinor: 28_000_000, priorClaims: false, vehicleUse: "private" },
        currency: "AED"
      }),
      201
    );
    const quoted = (shopped.responses as { id: string; state: string; commissionMinor: number | null }[]).filter(
      (r) => r.state === "quoted" && r.commissionMinor !== null && r.commissionMinor > 0
    );
    expect(quoted.length).toBeGreaterThanOrEqual(1);
    const chosen = quoted[0]!;

    ok(
      await call("lead", "POST", `/v1/dist/quote-requests/${shopped.request.id}/select`, { responseId: chosen.id }, {
        "idempotency-key": `journey-select-${chosen.id}`
      }),
      200,
      201
    );

    const startAt = Date.now();
    const bound = await throughApproval("lead", "lead", "POST", `/v1/axis/quote-responses/${chosen.id}/bind`, {
      policyNo: `POL-JOURNEY-${startAt}`,
      startAt,
      endAt: startAt + 365 * 86_400_000
    });
    // Read the policy rather than the response body: the bind's reply shape is
    // its own, and the facts that matter are the row's — it exists, it is bound,
    // and it carries the commission it was quoted (which is what `bindPolicy`
    // refuses to proceed without).
    expect(bound).toBeTruthy();
    const [policy] = await database
      .select()
      .from(schema.axisPolicies)
      .where(and(eq(schema.axisPolicies.tenantId, seeded.tenantId), eq(schema.axisPolicies.policyNo, `POL-JOURNEY-${startAt}`)));
    expect(policy).toBeTruthy();
    expect(policy!.status).toBe("bound");
    expect(policy!.commissionMinor).toBeGreaterThan(0);

    // 3. The transcript is complete, in order, in Arabic.
    const messages = await database
      .select()
      .from(schema.orbitMessages)
      .where(and(eq(schema.orbitMessages.tenantId, seeded.tenantId), eq(schema.orbitMessages.conversationId, conversation.id)));
    expect(messages.map((m) => m.role)).toEqual(["customer", "agent_human"]);
    expect(messages[0]!.content).toBe(ASK);
    expect(messages[1]!.content).toBe(ANSWER);
    // 4. Closed, because the judge scores a story that has ended — its own words:
    //    "scoring mid-flight would judge a story that has not ended." Closed at the
    //    row because the PATCH requires `orbit:conversations:assign`, which no
    //    seeded seat holds (see the header).
    await database
      .update(schema.orbitConversations)
      .set({ state: "closed" })
      .where(and(eq(schema.orbitConversations.tenantId, seeded.tenantId), eq(schema.orbitConversations.id, conversation.id)));

    // 5. QA-scored — the criterion's last two words.
    const scored = await sweepQaScores(ctxFor(), gatewayFor(env));
    expect(scored, "the sweep scored the closed conversation").toBeGreaterThanOrEqual(1);
    const [score] = await database
      .select()
      .from(schema.orbitQaScores)
      .where(and(eq(schema.orbitQaScores.tenantId, seeded.tenantId), eq(schema.orbitQaScores.conversationId, conversation.id)));
    expect(score).toBeTruthy();
    expect(score!.rubricKey).toBe("cx_judge");
    expect(score!.score).toBeGreaterThanOrEqual(80); // 4/5 on the rubric, stored 0–100
  });
});
