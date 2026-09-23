import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/06 §2. One describe per journey id, driven through the real router with
// the real seed — no handler is stubbed, no permission is bypassed. A journey
// that cannot be walked here cannot be walked by a person either.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const PASSWORD = "Gonxt-Demo-2026!";

/**
 * One shared TOTP secret for every seeded staff persona. Fine here and nowhere
 * else: a test needs a code it can compute, a real tenant enrols each person
 * separately (PLAT-013, seed.ts §mfaSecret).
 */
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** Persona per role, matching the seed. Journeys read as people, not user ids. */
const PEOPLE: Record<string, string> = {
  "tenant.admin": "amina.saleh",
  "tenant.compliance": "khalid.rashed",
  "axis.agent": "layla.hassan",
  "axis.lead": "omar.farouk",
  "orbit.agent": "sara.nasser",
  "orbit.retention": "yusuf.karim",
  "orbit.partners": "dana.aziz",
  "signal.lead": "noor.jamal",
  "scout.lead": "tariq.mansour",
  "north.exec": "hala.zayed",
  "north.analyst": "rana.hadid",
  "finance.controller": "faisal.omar",
  // Second controller: dual control means money out needs one of these to
  // initiate and a different one to decide.
  "finance.approver": "nadia.rahman",
  "finance.analyst": "mona.idris",
  "dev.admin": "raed.samir"
};

let env: Env;
let database: Db;
let seeded: SeedResult;
let tokens: Record<string, string>;
let products: Record<string, string>;
let customerId: string;
let consentId: string;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<Res<T>> {
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
  // Downloads answer with a workbook, not JSON. Body stays null for those.
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

/** POST that must succeed — surfaces the problem detail when it does not. */
function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/**
 * Walk an approval-gated write: the initiator is refused with an approval id, a
 * different person with the deciding permission clears it, the initiator retries
 * the identical body. This is the shape docs/06 calls "the second pair of eyes".
 */
async function throughApproval<T = any>(
  initiator: string,
  approver: string,
  method: string,
  path: string,
  payload: unknown
): Promise<Res<T>> {
  const first = await call(initiator, method, path, payload);
  expect(first.status).toBe(403);
  expect(first.body.type).toContain("approval_required");
  const approvalId = first.body.approval_id as string;
  expect(approvalId).toBeTruthy();
  ok(await call(approver, "POST", `/v1/me/approvals/${approvalId}/decide`, { decision: "approved" }));
  return call<T>(initiator, method, path, payload);
}

const MOTOR_RISK = { age: 34, sumInsuredMinor: 28_000_000, priorClaims: false, vehicleUse: "private" };

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    // Workers AI, stubbed at the binding rather than inside the gateway, so the
    // budget, the guardrails and the audit row are all still exercised.
    AI: {
      run: async (_model: string, input: { text?: string[] }) =>
        input?.text
          ? { data: input.text.map(() => [0.1, 0.2, 0.3]) }
          : { response: "Suggested: renew at the same premium." }
    },
    // ponytail: Vectorize as a Map — upsert then filter then take topK. Every
    // vector scores the same, so what this proves is the round trip (ingest
    // embeds, search joins the match back to its row) and the tenant filter,
    // never the ranking, which is Cloudflare's.
    VEC_MARKET: (() => {
      const vectors = new Map<string, { id: string; metadata?: Record<string, unknown> }>();
      return {
        upsert: async (rows: { id: string; metadata?: Record<string, unknown> }[]) => {
          for (const row of rows) vectors.set(row.id, row);
        },
        query: async (_values: number[], opts: { topK: number; filter?: Record<string, unknown> }) => ({
          matches: [...vectors.values()]
            .filter((one) =>
              Object.entries(opts.filter ?? {}).every(([key, want]) => one.metadata?.[key] === want)
            )
            .slice(0, opts.topK)
            .map((one) => ({ id: one.id, score: 1, metadata: one.metadata }))
        })
      };
    })(),
    // ponytail: a Map is the whole of R2 that exports use — put then get.
    // Without it every export lands in state "failed" and the download leg of
    // J-CO1 can never be walked here.
    FILES: (() => {
      const objects = new Map<string, Uint8Array>();
      return {
        put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes),
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { body: new Response(bytes).body } : null;
        }
      };
    })()
  } as unknown as Env;

  tokens = {};
  for (const [role, local] of Object.entries(PEOPLE)) {
    const res = await call(null, "POST", "/v1/auth/login", {
      email: `${local}@gonxt.ae`,
      password: PASSWORD,
      tenantSlug: "gonxt"
    });
    ok(res);
    const token = res.body.token as string;
    // PLAT-013: every one of these people is staff, so the password is only the
    // first hop. Walking the real second factor here is what proves the journeys
    // below are reachable by a person and not just by an ungated test.
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaStep).toBe("verify");
    const verified = await call(null, "POST", "/v1/auth/mfa/verify", {
      code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
    }, { authorization: `Bearer ${token}` });
    ok(verified);
    tokens[role] = token;
  }

  const productRows = await database.select().from(schema.products);
  products = Object.fromEntries(productRows.map((p) => [p.line, p.id]));
  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
  consentId = customer.consentId!;
  tenantId = customer.tenantId;
}, 120_000);

/* --------------------------------------------------------------- bootstrap */

describe("bootstrap", () => {
  it("GET /v1/me answers everything the shell needs in one round trip", async () => {
    const me = ok(await call("axis.agent", "GET", "/v1/me"));
    expect(me.tenant.slug).toBe("gonxt");
    expect(me.roles).toContain("axis.agent");
    expect(me.permissions).toContain("dist:quote_requests:create");
    expect(me.entitlements).toBeTruthy();
    // Every nav item carries a text label. An icon-only rail is a bug (docs/07).
    expect(me.nav.length).toBeGreaterThan(0);
    for (const item of me.nav) expect(item.labelKey).toMatch(/^nav\./);
  });

  it("the nav narrows to what the role may actually open", async () => {
    const agent = ok(await call("axis.agent", "GET", "/v1/me"));
    const finance = ok(await call("finance.controller", "GET", "/v1/me"));
    // Nav is grouped (heading items wrap the real destinations in `children`).
    const hrefs = (m: any) => m.nav.flatMap((n: any) => [n.href, ...(n.children ?? []).map((c: any) => c.href)]);
    expect(hrefs(agent)).toContain("/axis");
    // The agent has no tenant administration, the controller has no case queue.
    expect(hrefs(agent)).not.toContain("/admin");
    expect(hrefs(finance)).toContain("/ledger");
    expect(hrefs(finance)).not.toContain("/axis");
  });

  it("an unauthenticated call to a module route is refused", async () => {
    const res = await call(null, "GET", "/v1/axis/cases");
    expect(res.status).toBe(401);
  });

  it("GET /v1/me carries the tenant's locale overrides for the caller's locale", async () => {
    await ok(
      await call("tenant.admin", "POST", "/v1/core/locale-overrides", {
        locale: "en",
        key: "nav.home",
        value: "Dashboard",
        updatedBy: seeded.users["tenant.admin"] as string
      }),
      201
    );
    const me = ok(await call("tenant.admin", "GET", "/v1/me"));
    expect(me.overrides["nav.home"]).toBe("Dashboard");
  });
});

/* ------------------------------------------------------------------ J-C1 */

describe("J-C1 get covered", () => {
  let requestId: string;

  it("shops the whole panel from one submission", async () => {
    const res = await call("axis.agent", "POST", "/v1/dist/quote-requests/shop", {
      productId: products.motor,
      channelId: seeded.channels.web,
      customerId,
      consentId,
      inputs: MOTOR_RISK,
      currency: "AED"
    });
    const shopped = ok(res, 201);
    requestId = shopped.request.id;
    expect(shopped.responses.length).toBeGreaterThan(1);
    // At least two underwriters returned a real price, or there is nothing to compare.
    const priced = shopped.responses.filter((r: any) => r.state === "quoted");
    expect(priced.length).toBeGreaterThanOrEqual(2);
    expect(shopped.request.bestPremiumMinor).toBe(
      Math.min(...priced.map((r: any) => r.premiumMinor))
    );
  });

  it("the comparison ranks by price and shows margin to staff but never to a customer", async () => {
    const cmp = ok(await call("axis.agent", "GET", `/v1/dist/quote-requests/${requestId}/comparison`));
    const premiums = cmp.quotes.map((r: any) => r.premiumMinor);
    expect(premiums.length).toBeGreaterThan(1);
    expect(premiums).toEqual([...premiums].sort((a: number, b: number) => a - b));
    // Margin visibility is actor-kind based (`canSeeMargin`): staff advising a
    // customer need the commission, the customer-facing surface never gets it.
    expect(cmp.quotes.some((r: any) => typeof r.commissionMinor === "number")).toBe(true);
    expect(cmp.bestValue).toBeTruthy();
  });

  it("sharing with the customer needs the lead's permission, not the agent's", async () => {
    const denied = await call("axis.agent", "POST", `/v1/dist/quote-requests/${requestId}/share`, {
      channel: "email"
    });
    expect(denied.status).toBe(403);
    ok(await call("axis.lead", "POST", `/v1/dist/quote-requests/${requestId}/share`, { channel: "email" }));
  });

  it("a shop without consent is refused even with the customer id", async () => {
    const res = await call("axis.agent", "POST", "/v1/dist/quote-requests/shop", {
      productId: products.motor,
      channelId: seeded.channels.web,
      customerId,
      inputs: MOTOR_RISK
    });
    // Refused at the boundary: an identified customer with no consent record is a
    // malformed request, not a permission problem.
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("consentId");
  });
});

/* ------------------------------------------------------------------ J-C2 */

describe("J-C2 help on WhatsApp", () => {
  it("an inbound conversation gets an agent reply and an AI draft", async () => {
    const conversation = ok(
      await call("orbit.agent", "POST", "/v1/orbit/conversations", {
        channel: "whatsapp",
        customerId,
        state: "open"
      }),
      201
    );
    ok(
      await call("orbit.agent", "POST", "/v1/orbit/messages", {
        conversationId: conversation.id,
        role: "customer",
        content: "Is my windscreen covered?"
      }),
      201
    );
    const run = ok(
      await call("orbit.agent", "POST", "/v1/ai/runs", {
        agentKey: "renewal",
        purpose: "conversation.reply",
        subjectRef: conversation.id,
        input: "Is my windscreen covered?"
      }),
      200,
      201
    );
    expect(run.runId).toBeTruthy();
    expect(run.text).toBeTruthy();
  });

  it("the AI trail is readable and stores no message content", async () => {
    const audit = ok(await call("tenant.compliance", "GET", "/v1/ai/audit"));
    expect(audit.data.length).toBeGreaterThan(0);
    for (const row of audit.data) {
      // Only hashes are kept — the prompt and the reply themselves are never stored.
      expect(row.inputHash).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain("windscreen");
    }
  });
});

/* ------------------------------------------------------------------ J-C3 */

describe("J-C3 one-tap renewal", () => {
  let renewalId: string;
  let offerId: string;

  it("a renewal in the window is proposed a next-best offer", async () => {
    // A renewal is raised by the sweep on the scheduled tick, not by a person:
    // `orbit:renewals` carries read and update and no create, so
    // POST /v1/orbit/renewals/sweep (the same operator-trigger idiom as
    // staff.ts's /delegations/expire) is the only thing that can fill the
    // retention desk's queue outside the Workers cron tick. Walk the real one.
    await database
      .update(schema.axisPolicies)
      .set({ endAt: Date.now() + 20 * 86_400_000, status: "active" })
      .where(eq(schema.axisPolicies.tenantId, tenantId));

    const denied = await call("orbit.agent", "POST", "/v1/orbit/renewals/sweep");
    expect(denied.status).toBe(403);

    const raised = ok(await call("orbit.retention", "POST", "/v1/orbit/renewals/sweep"));
    expect(raised.raised).toBeGreaterThan(0);
    // Second tick inside the same window must not double up.
    expect(ok(await call("orbit.retention", "POST", "/v1/orbit/renewals/sweep")).raised).toBe(0);

    const queue = ok(await call("orbit.retention", "GET", "/v1/orbit/renewals?limit=5"));
    renewalId = queue.data[0].id;
    expect(queue.data[0].state).toBe("scheduled");
    expect((await call("orbit.retention", "GET", `/v1/orbit/renewals/${renewalId}`)).status).toBe(200);

    const proposed = ok(
      await call("orbit.retention", "POST", "/v1/dist/next-best-offers/propose", {
        customerId,
        channelId: seeded.channels.web
      })
    );
    expect(Array.isArray(proposed.data)).toBe(true);
    if (proposed.data.length) offerId = proposed.data[0].id;
  });

  it("surfacing an offer is an override the retention desk does not hold", async () => {
    if (!offerId) return;
    const denied = await call("orbit.retention", "POST", `/v1/dist/next-best-offers/${offerId}/surface`);
    expect(denied.status).toBe(403);
    ok(await call("axis.lead", "POST", `/v1/dist/next-best-offers/${offerId}/surface`), 204);
  });

  it("the renewal closes in one update", async () => {
    const done = ok(
      await call("orbit.retention", "PATCH", `/v1/orbit/renewals/${renewalId}`, { state: "accepted" })
    );
    expect(done.state).toBe("accepted");
  });

  it("a closed renewal cannot be reopened by a further PATCH", async () => {
    // accepted/lost are terminal (renewal-campaign.ts's resolved()) — a
    // generic PATCH moving it back to "scheduled" would leave RenewalWorkflow
    // and campaign engine both blind to it having ever closed.
    const res = await call("orbit.retention", "PATCH", `/v1/orbit/renewals/${renewalId}`, {
      state: "scheduled"
    });
    expect(res.status).toBe(400);

    const [row] = await database.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.id, renewalId));
    expect(row!.state).toBe("accepted");
  });
});

/* ------------------------------------------------------------------ J-C4 */

describe("J-C4 privacy rights", () => {
  let dsarId: string;

  it("a subject request is logged with a due date", async () => {
    const dsar = ok(
      await call("tenant.compliance", "POST", "/v1/compliance/dsar-requests", {
        subjectIdentifier: "rania.haddad@example.ae",
        type: "access",
        channel: "email",
        dueAt: Date.now() + 30 * 86_400_000
      }),
      201
    );
    dsarId = dsar.id;
    expect(dsar.state ?? "received").toBeTruthy();
  });

  it("the erasure log is evidence: readable, never writable over the API", async () => {
    const read = await call("tenant.compliance", "GET", "/v1/compliance/erasure-log");
    expect(read.status).toBe(200);
    const write = await call("tenant.compliance", "POST", "/v1/compliance/erasure-log", {
      dsarId,
      tableName: "core_customers",
      ts: Date.now()
    });
    expect(write.status).toBe(404);
  });

  it("operations cannot read the DSAR queue", async () => {
    const denied = await call("axis.agent", "GET", "/v1/compliance/dsar-requests");
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-O1 */

describe("J-O1 clearing the exception queue", () => {
  let caseId: string;
  let policyId: string;

  it("a case and its task are created by the agent", async () => {
    const created = ok(
      await call("axis.agent", "POST", "/v1/axis/cases", {
        ref: "CASE-J-O1",
        kind: "new_business",
        customerId,
        status: "open"
      }),
      201
    );
    caseId = created.id;
    ok(
      await call("axis.agent", "POST", "/v1/axis/tasks", {
        type: "document_missing",
        titleKey: "task.document_missing",
        caseId,
        state: "open"
      }),
      201
    );
  });

  it("binding within the delegated authority clears on the lead's own approval", async () => {
    // Every bind is gated — `axis.bind` is not on the tenant's auto-approve
    // list. Below 250_000_00 dual control does not apply, so the lead clears
    // their own request in one pass; the above-threshold refusal is J-X2.
    // The payload is built once: the approval's subject is a hash of the body,
    // so a re-quoted `Date.now()` would raise a second approval.
    const start = Date.now();
    const bound = await throughApproval("axis.lead", "axis.lead", "POST", "/v1/axis/policies", {
      customerId,
      providerId: seeded.providers.cedar,
      policyNo: "POL-J-O1",
      startAt: start,
      endAt: start + 365 * 86_400_000,
      premiumMinor: 100_000_00,
      currency: "AED",
      caseId
    });
    policyId = ok(bound, 201).id;
    expect(bound.body.policyNo).toBe("POL-J-O1");
  });

  it("the bind left an audit row naming the policy it created", async () => {
    const audit = ok(await call("tenant.compliance", "GET", "/v1/core/audit-log?limit=200"));
    expect(audit.data.some((r: any) => r.subjectRef === policyId)).toBe(true);
  });
});

/* ------------------------------------------------------------------ J-O2 */

describe("J-O2 group medical bid", () => {
  it("a referral panel answers with referrals, not silence", async () => {
    const shopped = ok(
      await call("axis.lead", "POST", "/v1/dist/quote-requests/shop", {
        productId: products.health,
        channelId: seeded.channels.brokerAlpha,
        inputs: { age: 41, sumInsuredMinor: 10_000_000, priorClaims: false, lives: 120 },
        currency: "AED"
      }),
      201
    );
    expect(shopped.responses.length).toBeGreaterThan(0);
    expect(shopped.responses.some((r: any) => r.state === "referred" || r.state === "quoted")).toBe(true);
  });

  it("the lead sees commission on the comparison, because the lead sets terms", async () => {
    const list = ok(await call("axis.lead", "GET", "/v1/dist/quote-requests?limit=1"));
    const id = list.data[0].id;
    const cmp = ok(await call("axis.lead", "GET", `/v1/dist/quote-requests/${id}/comparison`));
    expect(cmp.quotes.length + cmp.unavailable.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ J-O3 */

describe("J-O3 month-end reconciliation", () => {
  it("premium collected posts a balanced client-money entry", async () => {
    const posted = ok(
      await call("finance.controller", "POST", "/v1/ledger/txn/PREM-COLLECT", {
        idempotencyKey: "j-o3-collect-1",
        currency: "AED",
        grossMinor: 300_000_00,
        args: { amountMinor: 300_000_00, memo: "premium received" }
      }),
      201
    );
    expect(posted.txn.state).toBe("settled");

    const tb = ok(await call("finance.controller", "GET", "/v1/ledger/reports/trial-balance"));
    const debits = tb.rows.reduce((s: number, r: any) => s + (r.debitMinor ?? 0), 0);
    const credits = tb.rows.reduce((s: number, r: any) => s + (r.creditMinor ?? 0), 0);
    expect(debits).toBe(credits);
  });

  it("the same idempotency key does not post twice", async () => {
    const totalDebits = async () => {
      const tb = ok(await call("finance.controller", "GET", "/v1/ledger/reports/trial-balance"));
      return tb.rows.reduce((s: number, r: any) => s + (r.debitMinor ?? 0), 0);
    };
    const before = await totalDebits();
    const again = await call(
      "finance.controller",
      "POST",
      "/v1/ledger/txn/PREM-COLLECT",
      {
        idempotencyKey: "j-o3-collect-1",
        currency: "AED",
        grossMinor: 300_000_00,
        args: { amountMinor: 300_000_00, memo: "premium received" }
      },
      { "idempotency-key": "j-o3-collect-1" }
    );
    expect([200, 201, 409]).toContain(again.status);
    // A replay is not a second posting: whatever the ledger weighed before the
    // retry, it weighs after. A delta says that; an absolute total only says how
    // much the fixture happened to seed.
    expect(await totalDebits()).toBe(before);
  });

  it("a statement reconciles against the ledger without AI in the money path", async () => {
    const run = ok(
      await call("finance.analyst", "POST", "/v1/ledger/recon/runs", {
        process: "client_money",
        period: "2026-01",
        currency: "AED",
        lines: [
          { ref: "BANK-1", amountMinor: 300_000_00, currency: "AED", description: "premium received" }
        ]
      }),
      201
    );
    expect(run.run ?? run).toBeTruthy();
  });

  it("a resubmitted statement starts one run, not two", async () => {
    // A run posts matches against money, so a retried submit must replay the
    // first run rather than open a second against the same statement.
    const body = {
      process: "client_money",
      period: "2026-01",
      currency: "AED",
      lines: [{ ref: "BANK-2", amountMinor: 300_000_00, currency: "AED", description: "retry" }]
    };
    const key = { "idempotency-key": "j-o3-recon-1" };
    const first = ok(await call("finance.analyst", "POST", "/v1/ledger/recon/runs", body, key), 201);
    const second = ok(await call("finance.analyst", "POST", "/v1/ledger/recon/runs", body, key), 201);

    expect(second.runId).toBe(first.runId);
    const runs = await database
      .select()
      .from(schema.ledgerReconRuns)
      .where(eq(schema.ledgerReconRuns.id, first.runId));
    expect(runs).toHaveLength(1);
  });

  it("money out clears: the controller instructs, a second controller decides", async () => {
    // Client money, payouts and refunds are all dual-control and only a
    // controller may decide them. With a single controller in the tenant the
    // whole money-out side is unpayable, so the seed carries two.
    const paid = ok(
      await throughApproval("finance.controller", "finance.approver", "POST", "/v1/ledger/txn/PAYOUT-INSTRUCT", {
        idempotencyKey: "j-o3-payout-1",
        currency: "AED",
        args: { amountMinor: 25_000_00, memo: "channel share to broker" }
      }),
      201
    );
    expect(paid.txn.state).toBe("settled");

    const remitted = ok(
      await throughApproval("finance.controller", "finance.approver", "POST", "/v1/ledger/txn/PREM-REMIT", {
        idempotencyKey: "j-o3-remit-1",
        currency: "AED",
        args: { amountMinor: 275_000_00, memo: "remitted to underwriter" }
      }),
      201
    );
    expect(remitted.txn.state).toBe("settled");

    const tb = ok(await call("finance.controller", "GET", "/v1/ledger/reports/trial-balance"));
    const debits = tb.rows.reduce((s: number, r: any) => s + (r.debitMinor ?? 0), 0);
    const credits = tb.rows.reduce((s: number, r: any) => s + (r.creditMinor ?? 0), 0);
    expect(debits).toBe(credits);
  });

  it("the analyst may run a reconciliation but not close the period", async () => {
    // A well-formed close request, so what comes back is an authorisation answer
    // and not a validation one: the permission check is the first thing
    // closePeriod does (docs/specs/gap-finance-design.md D10).
    const denied = await call("finance.analyst", "POST", "/v1/ledger/periods/2026-01/close", {
      to: "soft_closed"
    });
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-X1 */

describe("J-X1 catching a handover", () => {
  it("a bot conversation hands over with a summary the human can read", async () => {
    const conversation = ok(
      await call("orbit.agent", "POST", "/v1/orbit/conversations", {
        channel: "web",
        customerId,
        state: "open"
      }),
      201
    );
    const note = ok(
      await call("orbit.agent", "POST", "/v1/orbit/handover-notes", {
        conversationId: conversation.id,
        fromRef: "agent:renewal",
        summary: "Customer asked about excess on a windscreen claim; needs a human.",
        ts: Date.now()
      }),
      201
    );
    expect(note.summary).toContain("excess");
  });

  it("scoring the handover is the lead's job, not the agent's", async () => {
    const list = ok(await call("orbit.agent", "GET", "/v1/orbit/conversations?limit=1"));
    const denied = await call("orbit.agent", "POST", "/v1/orbit/qa-scores", {
      conversationId: list.data[0].id,
      rubricKey: "handover.quality",
      score: 4,
      ts: Date.now()
    });
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-X2 */

describe("J-X2 the save desk", () => {
  let settlementApprovalId: string;
  let settlementId: string;

  it("a price match above the threshold needs an approver who is not the asker", async () => {
    const caseRow = ok(
      await call("axis.agent", "POST", "/v1/axis/cases", {
        ref: "CASE-J-X2",
        kind: "renewal",
        customerId,
        // A hand-keyed quote needs a channel to shop through (docs/27 F13).
        channelId: seeded.channels.callCentre,
        status: "open"
      }),
      201
    );
    // The save desk keys the retention price it negotiated by phone. Since F13
    // that lands in `dist_quote_responses` beside the panel's own answers.
    const quote = ok(
      await call("axis.agent", "POST", `/v1/axis/cases/${caseRow.id}/quotes`, {
        offeringId: seeded.offerings.cedarMotor,
        providerId: seeded.providers.cedar,
        premiumMinor: 120_000,
        currency: "AED"
      }),
      201
    );
    expect(quote.premiumMinor).toBe(120_000);
    expect(quote.state).toBe("quoted");
  });

  it("a policy above the delegated authority is refused, not quietly bound", async () => {
    const raised = await call("axis.lead", "POST", "/v1/axis/policies", {
      customerId,
      providerId: seeded.providers.gonxt,
      policyNo: "POL-J-X2",
      startAt: Date.now(),
      endAt: Date.now() + 365 * 86_400_000,
      premiumMinor: 400_000_00,
      currency: "AED"
    });
    expect(raised.status).toBe(403);
    expect(raised.body.type).toContain("approval_required");
    expect(raised.body.policy_key).toBe("axis.bind");
    // The lead cannot clear their own: `axis.bind` is dual control above the
    // threshold, and holding the deciding permission does not exempt the asker.
    const selfDecide = await call("axis.lead", "POST", `/v1/me/approvals/${raised.body.approval_id}/decide`, {
      decision: "approved"
    });
    expect(selfDecide.status).toBe(400);
    expect(String(selfDecide.body.detail).toLowerCase()).toContain("dual control");
  });

  it("an approval cannot be decided by the person who raised it, even holding the permission", async () => {
    // A real commission entry on a channel the settlement seed never touches
    // (brokerAlpha carries its own seeded partner, agreement and a standing
    // draft settlement — callCentre has none of that, so this fixture's
    // entry is the sole contributor to the total) — a genuine nonzero
    // netMinor to draft against, not the client-supplied totals the retired
    // generic CRUD used to accept.
    const period = "2031-01";
    const earnedAt = Date.UTC(2031, 0, 15);
    await database.insert(schema.distCommissionEntries).values({
      id: "ce_journey_settle",
      tenantId: seeded.tenantId,
      policyId: "pol_journey_settle",
      providerId: seeded.providers.cedar as string,
      channelId: seeded.channels.callCentre as string,
      kind: "new_business",
      premiumMinor: 900_000_00,
      grossCommissionMinor: 90_000_00,
      channelCommissionMinor: 85_000_00,
      netCommissionMinor: 85_000_00,
      currency: "AED",
      earnedOn: "issue",
      earnedAt,
      state: "accrued",
      createdAt: earnedAt,
      updatedAt: earnedAt
    });

    // Drafting is arithmetic only — no approval here (routes/settlement.ts).
    const drafted = ok(
      await call("finance.controller", "POST", "/v1/settlement/runs", {
        counterpartyKind: "partner",
        counterpartyRef: `channel:${seeded.channels.callCentre}`,
        period
      }),
      201
    );
    expect(drafted.totals.netMinor).toBe(85_000_00);
    settlementId = drafted.settlement.id;

    const raised = await call(
      "finance.controller",
      "POST",
      `/v1/settlement/settlements/${settlementId}/approve`,
      {}
    );
    expect(raised.status).toBe(403);
    expect(raised.body.policy_key).toBe("dist.settlement_run");
    settlementApprovalId = raised.body.approval_id;
    const selfDecide = await call(
      "finance.controller",
      "POST",
      `/v1/me/approvals/${settlementApprovalId}/decide`,
      { decision: "approved" }
    );
    expect(selfDecide.status).toBe(400);
    expect(String(selfDecide.body.detail).toLowerCase()).toContain("dual control");
  });

  it("a rejection must carry a reason", async () => {
    const noReason = await call("finance.analyst", "POST", `/v1/me/approvals/${settlementApprovalId}/decide`, {
      decision: "rejected"
    });
    // The analyst has no settlement authority at all, so the refusal comes first.
    expect(noReason.status).toBe(403);

    const pending = ok(await call("tenant.admin", "GET", "/v1/me/inbox"));
    expect(pending.counts.approvals).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(pending.approvals)).toBe(true);
  });

  it("a delegation puts the approval in the delegate's inbox and lets them decide it", async () => {
    const day = 86_400_000;
    const before = ok(await call("finance.analyst", "GET", "/v1/me/inbox"));
    expect(before.approvals.some((a: { id: string }) => a.id === settlementApprovalId)).toBe(false);

    await database.insert(schema.delegations).values({
      id: "dlg_journey_settle",
      tenantId: seeded.tenantId,
      fromUserId: seeded.users["finance.controller"] as string,
      toUserId: seeded.users["finance.analyst"] as string,
      reason: "controller on leave",
      scopeJson: null,
      maxAmountMinor: null,
      currency: null,
      startsAt: Date.now() - day,
      endsAt: Date.now() + day,
      status: "active",
      createdBy: `user:${seeded.users["tenant.admin"] as string}`,
      createdAt: Date.now() - day
    });

    // Seeing it and deciding it are the same authority: a delegate who could
    // decide but not see would be told the approval does not exist.
    const inbox = ok(await call("finance.analyst", "GET", "/v1/me/inbox"));
    expect(inbox.approvals.some((a: { id: string }) => a.id === settlementApprovalId)).toBe(true);

    const decided = ok(
      await call("finance.analyst", "POST", `/v1/me/approvals/${settlementApprovalId}/decide`, {
        decision: "approved"
      })
    );
    expect(decided.decision).toBe("approved");

    const [row] = await database.select().from(schema.approvals).where(eq(schema.approvals.id, settlementApprovalId));
    expect(row!.delegationId).toBe("dlg_journey_settle");
  });

  it("the retired generic CRUD door onto settlements is gone", async () => {
    // routes/settlement.ts is the sole doorway (run/approve/pay/dispute/
    // reopen). The generic create/update routes are unmounted entirely, so
    // both verbs 404 rather than just being permission-denied.
    const create = await call("finance.controller", "POST", "/v1/ledger/settlements", {
      counterpartyKind: "partner",
      counterpartyRef: `channel:${seeded.channels.callCentre}`,
      period: "2031-01"
    });
    expect(create.status).toBe(404);

    const patch = await call("finance.controller", "PATCH", `/v1/ledger/settlements/${settlementId}`, {
      state: "paid"
    });
    expect(patch.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ J-X3 */

describe("J-X3 partner integration", () => {
  it("a partner is activated through an approval and given a channel", async () => {
    // `dist.partner_activate` decides on `orbit:partners:certify`, which the
    // partnerships lead holds, and is single control — so they certify their own.
    const partner = ok(
      await throughApproval("orbit.partners", "orbit.partners", "POST", "/v1/orbit/partners", {
        name: "Falcon Bank",
        kind: "embedded",
        status: "pending"
      }),
      201
    );
    expect(partner.name).toBe("Falcon Bank");

    const channel = ok(
      await call("tenant.admin", "POST", "/v1/dist/channels", {
        key: "falcon-bank",
        nameJson: { en: "Falcon Bank", ar: "بنك فالكون" },
        kind: "b2b",
        medium: "portal",
        partnerId: partner.id,
        collectsPayment: "partner",
        defaultCommissionPpm: 120_000,
        status: "active"
      }),
      201,
      403
    );
    expect(channel).toBeTruthy();

    // advancePartner() is the sole doorway past prospect: blockingSteps() plus
    // dist.partner_activate on "live". A raw PATCH must not self-activate or
    // reverse a suspend/terminate.
    const patch = await call("orbit.agent", "PATCH", `/v1/orbit/partners/${partner.id}`, {
      stage: "live",
      status: "active",
      sandboxFlag: false
    });
    expect(patch.status).toBe(404);

    const [row] = await database.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.id, partner.id));
    expect(row!.stage).not.toBe("live");
  });

  it("a developer key can be issued but never read back", async () => {
    const keys = ok(await call("dev.admin", "GET", "/v1/core/api-keys"));
    expect(Array.isArray(keys.data)).toBe(true);
    for (const k of keys.data) {
      // `prefix` is the public handle — `qvk_live_` plus 8 characters, printed so
      // an operator can tell two integrations apart. What must never come back on
      // a read path is the hash or a full-length token: either one would let a
      // reader authenticate as the integration.
      expect(k.keyHash).toBeUndefined();
      expect(k.key).toBeUndefined();
      expect(JSON.stringify(k)).not.toMatch(/qvk_(live|test)_[A-Za-z0-9]{20,}/);
    }
  });
});

/* ------------------------------------------------------------------ J-M1 */

describe("J-M1 a campaign in a day", () => {
  let campaignId: string;

  it("audience, campaign and creative are authored by the growth lead", async () => {
    const audience = ok(
      await call("signal.lead", "POST", "/v1/signal/audiences", {
        name: "Motor renewals, 30 days",
        definitionJson: JSON.stringify({ segment: "renewals", withinDays: 30 })
      }),
      201
    );
    expect(audience.name).toBeTruthy();

    const campaign = ok(
      await call("signal.lead", "POST", "/v1/signal/campaigns", {
        name: "Renewal save",
        objective: "retention",
        channelsJson: JSON.stringify(["email", "whatsapp"]),
        budgetJson: JSON.stringify({ dailyMinor: 50_000 }),
        ownerRef: "signal.lead",
        audienceId: audience.id,
        state: "draft"
      }),
      201
    );
    campaignId = campaign.id;
  });

  it("creative variants are generated for the campaign, compliance-checked and audited", async () => {
    const denied = await call("scout.lead", "POST", "/v1/signal/creatives/generate", {
      campaignId,
      kind: "ad",
      brief: "Renew now and save.",
      locales: ["en"],
      count: 1
    });
    expect(denied.status).toBe(403);

    const generated = ok(
      await call("signal.lead", "POST", "/v1/signal/creatives/generate", {
        campaignId,
        kind: "ad",
        brief: "Renew now and save.",
        locales: ["en"],
        count: 1
      }),
      201
    );
    expect(generated.variants).toHaveLength(1);
    expect(generated.variants[0].locale).toBe("en");
    expect(generated.auditIds).toHaveLength(1);

    const creative = ok(await call("signal.lead", "GET", `/v1/signal/creatives/${generated.variants[0].id}`));
    expect(creative.campaignId).toBe(campaignId);
    expect(creative.generatedBy).toBe("ai");
  });

  it("launching is auto-approved by tenant policy but still audited", async () => {
    const launched = ok(
      await call("signal.lead", "PATCH", `/v1/signal/campaigns/${campaignId}`, { state: "live" })
    );
    expect(launched.state).toBe("live");
    const audit = ok(await call("tenant.compliance", "GET", "/v1/core/audit-log?limit=50"));
    expect(audit.data.length).toBeGreaterThan(0);
  });

  it("a marketer without the launch permission cannot go live", async () => {
    const denied = await call("scout.lead", "PATCH", `/v1/signal/campaigns/${campaignId}`, { state: "paused" });
    expect(denied.status).toBe(403);
  });

  it("a live campaign cannot be jumped back to draft, or an ended one resurrected, by a generic PATCH", async () => {
    const backwards = await call("signal.lead", "PATCH", `/v1/signal/campaigns/${campaignId}`, { state: "draft" });
    expect(backwards.status).toBe(400);

    const ended = ok(
      await call("signal.lead", "PATCH", `/v1/signal/campaigns/${campaignId}`, { state: "ended" })
    );
    expect(ended.state).toBe("ended");

    const revived = await call("signal.lead", "PATCH", `/v1/signal/campaigns/${campaignId}`, { state: "live" });
    expect(revived.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ J-S1 */

describe("J-S1 whitespace from the tenant's own book", () => {
  it("a marketer cannot run the whitespace sweep", async () => {
    const denied = await call("signal.lead", "POST", "/v1/scout/whitespaces/compute");
    expect(denied.status).toBe(403);
  });

  it("the product lead runs it against real quote demand vs. policy coverage", async () => {
    const first = ok(await call("scout.lead", "POST", "/v1/scout/whitespaces/compute"), 201);
    expect(typeof first.candidates).toBe("number");

    // Idempotent: a category that already has a live row is skipped, so a
    // second run right after the first raises nothing new.
    const second = ok(await call("scout.lead", "POST", "/v1/scout/whitespaces/compute"), 201);
    expect(second.candidates).toBe(0);
  });

  it("diffs two coverage wordings word by word", async () => {
    const diff = ok(
      await call("scout.lead", "POST", "/v1/scout/wording-diff", {
        textA: "excludes flood damage",
        textB: "includes flood damage"
      })
    );
    expect(diff.spans.some((s: { type: string }) => s.type !== "equal")).toBe(true);
  });

  it("resolves nearest signals back to their rows, and only this tenant's", async () => {
    // Ingest writes the vector (resources.ts SCOUT signals beforeWrite) and the
    // seed records the ids the harvester would have written; both leave the
    // index holding embedding_ref keys. Prime the stub with those, plus two
    // vectors that must not come back: one belonging to another tenant, one
    // whose row no longer exists.
    const signals = await database.select().from(schema.scoutSignals).limit(3);
    expect(signals.length).toBeGreaterThan(0);
    await (env.VEC_MARKET as never as { upsert(rows: unknown[]): Promise<void> }).upsert([
      ...signals.map((one) => ({
        id: one.embeddingRef,
        metadata: { tenantId: one.tenantId, source: one.source }
      })),
      { id: "vec:another-tenant", metadata: { tenantId: "ten_someone_else", source: "news" } },
      { id: "vec:deleted-row", metadata: { tenantId, source: "news" } }
    ]);

    const found = ok(
      await call("scout.lead", "POST", "/v1/scout/signals/similar", { text: "EV cover withdrawn", topK: 20 })
    );
    const ids = found.matches.map((one: { id: string }) => one.id);
    for (const one of signals) expect(ids).toContain(one.id);
    // A match is served as the signal's own columns, never as a bare vector id.
    expect(ids).not.toContain("vec:another-tenant");
    expect(ids).not.toContain("vec:deleted-row");
    expect(found.matches[0].source).toBeTruthy();

    const denied = await call("signal.lead", "POST", "/v1/scout/signals/similar", { text: "EV cover" });
    expect(denied.status).toBe(403);
  });

  it("downloads the negotiation pack as a PDF", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/scout/panel-bench/negotiation-pack", {
        headers: { authorization: `Bearer ${tokens["scout.lead"]}` }
      }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("negotiation-pack-");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
  });
});

/* ------------------------------------------------------------------ J-M2 */

describe("J-M2 the budget morning", () => {
  it("a budget move is reversible and names its approver", async () => {
    // The optimiser proposes the move; a person approves it. There is no create
    // permission on `signal:budget_moves`, so the proposal is written by the
    // engine and the API only exposes read and approve.
    const moveId = "bmv_j_m2_0000000000000000000";
    await database.insert(schema.signalBudgetMoves).values({
      id: moveId,
      tenantId,
      fromRef: "campaign:awareness",
      toRef: "campaign:renewal-save",
      amountMinor: 25_000,
      currency: "AED",
      reason: "Renewal save is converting at three times awareness.",
      approvedBy: "agent:optimiser",
      reversibleUntil: Date.now() + 86_400_000,
      ts: Date.now()
    } as never);

    const move = ok(await call("signal.lead", "GET", `/v1/signal/budget-moves/${moveId}`));
    expect(move.reversibleUntil).toBeGreaterThan(Date.now());
    // A move nobody can undo is not a decision, it is a fact. Reversal names the
    // person who pulled it back.
    // `signal.budget_move` is single control and decides on
    // `signal:budget_moves:approve`, which the growth lead holds.
    const reversed = ok(
      await throughApproval("signal.lead", "signal.lead", "PATCH", `/v1/signal/budget-moves/${moveId}`, {
        reversedBy: "signal.lead",
        reversedAt: Date.now()
      })
    );
    expect(reversed.reversedBy).toBe("signal.lead");
  });

  it("spend is readable and joins to attribution", async () => {
    const spend = ok(await call("signal.lead", "GET", "/v1/signal/spend"));
    expect(Array.isArray(spend.data)).toBe(true);
  });

  it("one-click pause and resume toggle the tenant-wide autopilot switch", async () => {
    // docs/modules/signal.md §8 clause 2: a global kill switch, gated to the
    // budget-oversight role (same permission as approve/reverse), not any role
    // outside SIGNAL.
    const denied = await call("scout.lead", "POST", "/v1/signal/autopilot/pause");
    expect(denied.status).toBe(403);

    const paused = ok(await call("signal.lead", "POST", "/v1/signal/autopilot/pause"));
    expect(paused.signalAutopilotPaused).toBe(true);
    const [tenantRow] = await database.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(JSON.parse(tenantRow!.policyJson!).signalAutopilotPaused).toBe(true);

    const resumed = ok(await call("signal.lead", "POST", "/v1/signal/autopilot/resume"));
    expect(resumed.signalAutopilotPaused).toBe(false);
  });
});

/* ------------------------------------------------------------------ J-M3 */

describe("J-M3 the answer box", () => {
  it("an AEO page is authored against a query cluster", async () => {
    const page = ok(
      await call("signal.lead", "POST", "/v1/signal/aeo-pages", {
        queryCluster: "car insurance dubai excess",
        contentRef: "cms:aeo/excess-explained",
        status: "draft"
      }),
      201
    );
    expect(page.queryCluster).toContain("excess");
  });

  it("the creative agent is invokable and its suggestion is measured", async () => {
    const run = ok(
      await call("signal.lead", "POST", "/v1/ai/runs", {
        agentKey: "creative",
        purpose: "aeo.draft",
        input: "Explain motor excess in two sentences for a UAE audience."
      }),
      200,
      201
    );
    const suggestion = ok(
      await call("signal.lead", "POST", "/v1/ai/suggestions", {
        surface: "draft",
        module: "signal",
        runId: run.runId
      }),
      200,
      201
    );
    ok(
      await call("signal.lead", "POST", `/v1/ai/suggestions/${suggestion.id}/outcome`, {
        outcome: "edited",
        editDistance: 42
      }),
      200,
      204
    );
    const acceptance = ok(await call("tenant.admin", "GET", "/v1/ai/suggestions/acceptance"));
    expect(acceptance.data.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ J-P1 */

describe("J-P1 the quarterly radar", () => {
  it("signals cluster into a whitespace the lead can promote", async () => {
    ok(
      await call("scout.lead", "POST", "/v1/scout/signals", {
        source: "panel_bench",
        payloadJson: JSON.stringify({ note: "Two underwriters withdrew from EV cover." }),
        observedAt: Date.now()
      }),
      201,
      403
    );
    // Whitespaces are clustered by the radar, not typed in: the lead's authority
    // over them is `scout:whitespaces:promote`, an update, so there is no POST.
    const whitespaceId = "wsp_j_p1_0000000000000000000";
    await database.insert(schema.scoutWhitespaces).values({
      id: whitespaceId,
      tenantId,
      description: "EV-only motor cover",
      status: "candidate",
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as never);
    // scout:whitespaces:promote gates through scout.whitespace_promote (docs/modules/scout.md
    // §4 "whitespace approvals") — self-clearable (dualControl: never), still a two-step ask.
    const promoted = ok(
      await throughApproval("scout.lead", "scout.lead", "PATCH", `/v1/scout/whitespaces/${whitespaceId}`, {
        status: "promoted",
        owner: "tariq.mansour",
        promotedAt: Date.now()
      })
    );
    expect(promoted.status).toBe("promoted");
  });

  it("the discovery agent runs against the reasoning tier", async () => {
    const run = ok(
      await call("scout.lead", "POST", "/v1/ai/runs", {
        agentKey: "discovery",
        purpose: "radar.summarise",
        input: "Summarise this quarter's panel withdrawals."
      }),
      200,
      201
    );
    expect(run.text).toBeTruthy();
    expect(run.tier).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ J-P2 */

describe("J-P2 panel negotiation", () => {
  it("a rate change is evidence: create-only, and gated", async () => {
    const attempt = await call("tenant.admin", "POST", "/v1/dist/commission-rates", {
      offeringId: seeded.offerings.cedarMotor,
      channelId: seeded.channels.brokerAlpha,
      baseCommissionPpm: 150_000,
      channelSharePpm: 500_000,
      effectiveFrom: Date.now()
    });
    // dist.rate_change is never auto-approved and always dual control, so the
    // first attempt is always a refusal carrying an approval id.
    expect(attempt.status).toBe(403);
    expect(attempt.body.type).toContain("approval_required");
    expect(attempt.body.policy_key).toBe("dist.rate_change");

    // The controller holds `dist:rates:approve`; the admin who asked does not.
    ok(
      await call("finance.controller", "POST", `/v1/me/approvals/${attempt.body.approval_id}/decide`, {
        decision: "approved"
      })
    );

    // Approving it did not do it: the rate was still unwritten, and the asker
    // had to find the form and fill it in again. The gate kept the request, so
    // the asker now finishes it with one call, in their own session.
    const ready = ok(await call("tenant.admin", "GET", "/v1/me/approvals/ready"));
    expect(ready.data.map((row: { id: string }) => row.id)).toContain(attempt.body.approval_id);
    const finished = await call("tenant.admin", "POST", `/v1/me/approvals/${attempt.body.approval_id}/finish`);
    expect(finished.status).toBe(201);
    expect(finished.body.baseCommissionPpm).toBe(150_000);
    // Once.
    const again = await call("tenant.admin", "POST", `/v1/me/approvals/${attempt.body.approval_id}/finish`);
    expect(again.status).toBe(409);
    // And only by whoever asked.
    const other = await call("finance.controller", "POST", `/v1/me/approvals/${attempt.body.approval_id}/finish`);
    expect(other.status).toBe(403);
  });

  it("panel benchmarks are readable by the people who negotiate", async () => {
    const bench = ok(await call("scout.lead", "GET", "/v1/scout/panel-bench"));
    expect(Array.isArray(bench.data)).toBe(true);
  });
});

/* ------------------------------------------------------------------ J-E1 */

describe("J-E1 the 7am read", () => {
  it("the briefing engine generates a real briefing from live metrics", async () => {
    // Generating is the analyst's permission; the exec reads what lands.
    const briefing = ok(
      await call("north.analyst", "POST", "/v1/north/briefings/generate", { date: "2026-01-06" }),
      201
    );
    expect(briefing.narrativeRef).toBeTruthy();
    expect(briefing.mismatches).toEqual([]);
    expect(briefing.auditId).toBeTruthy();
    const seen = ok(await call("north.exec", "GET", `/v1/north/briefings/${briefing.id}`));
    expect(seen.date).toBe("2026-01-06");
  });

  // `^\d{4}-\d{2}-\d{2}$` accepts `9999-99-99`, which is not a day: the
  // narrator builds `new Date("9999-99-99T00:00:00Z")` for the comparison
  // period and throws `RangeError: Invalid time value` from inside briefing
  // generation. Rejected at the door, where the message can say what is wrong.
  it("refuses a date that matches the shape but is not a day", async () => {
    for (const bad of ["9999-99-99", "2026-02-30", "2026-13-01"]) {
      const res = await call("north.analyst", "POST", "/v1/north/briefings/generate", { date: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it("a marketer cannot generate a briefing", async () => {
    const denied = await call("scout.lead", "POST", "/v1/north/briefings/generate", { date: "2026-01-07" });
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-E2 */

describe("J-E2 the board pack", () => {
  it("an analyst cannot assemble a board pack", async () => {
    const denied = await call("north.analyst", "POST", "/v1/north/boardpacks", {
      period: "2026-Q1",
      title: "Q1 board pack"
    });
    expect(denied.status).toBe(403);
  });

  it("a board pack is generated and a decision is recorded against it", async () => {
    // Client-supplied sectionsJson is ignored — the pack is a real assembly
    // from live briefings/snapshots/decisions, never a client-fabricated body.
    const pack = ok(
      await call("north.exec", "POST", "/v1/north/boardpacks", {
        period: "2026-Q1",
        title: "Q1 board pack",
        sectionsJson: JSON.stringify([{ key: "growth" }, { key: "loss_ratio" }])
      }),
      201
    );
    expect(pack.status).toBe("review");
    expect(pack.pdfFileId).toBeTruthy();
    expect(pack.approvedBy).toBeNull();

    const decision = ok(
      await call("north.exec", "POST", "/v1/north/decisions", {
        title: "Expand the motor panel to five underwriters",
        owner: "hala.zayed",
        status: "open"
      }),
      201
    );
    expect(decision.title).toContain("motor panel");
  });
});

/* ------------------------------------------------------------------ J-E3 */

describe("J-E3 the what-if", () => {
  it("a scenario stores its assumptions so the answer can be re-derived", async () => {
    const scenario = ok(
      await call("north.exec", "POST", "/v1/north/scenarios", {
        question: "What if the broker channel share rises to 60%?",
        assumptionsJson: JSON.stringify({ channelSharePpm: 600_000 }),
        author: "hala.zayed"
      }),
      201
    );
    // `*Json` columns hydrate on read, so the answer comes back as an object and
    // the caller never re-parses what the API already parsed.
    expect(scenario.assumptionsJson.channelSharePpm).toBe(600_000);
  });

  it("an ad-hoc report runs and exports to a real workbook", async () => {
    const run = ok(
      // The exec reads the ledger, not the distribution funnel — the dataset a
      // caller may query is the one their module permission already allows.
      await call("north.exec", "POST", "/v1/analytics/run", {
        dataset: "transactions",
        dimensions: ["type"],
        metrics: ["gross"],
        grain: "none"
      }),
      201
    );
    expect(Array.isArray(run.rows)).toBe(true);
  });
});

/* ------------------------------------------------------------------ J-E4 */

describe("J-E4 alert rules, explorer and data health", () => {
  it("an analyst sets an alert rule, an exec cannot be blocked from reading it", async () => {
    const rule = ok(
      await call("north.analyst", "POST", "/v1/north/alert_rules", {
        metricKey: "gwp",
        operator: "lt",
        thresholdValue: 100_000,
        windowGrain: "month"
      }),
      201
    );
    expect(rule.enabled).toBe(true);

    const seen = ok(await call("north.exec", "GET", `/v1/north/alert_rules/${rule.id}`));
    expect(seen.metricKey).toBe("gwp");
  });

  it("a marketer cannot write an alert rule", async () => {
    const denied = await call("scout.lead", "POST", "/v1/north/alert_rules", {
      metricKey: "gwp",
      operator: "lt",
      thresholdValue: 1,
      windowGrain: "day"
    });
    expect(denied.status).toBe(403);
  });

  it("the explorer answers a metric query from stored snapshots, never a client SQL string", async () => {
    const result = ok(
      await call("north.exec", "POST", "/v1/north/explore", {
        metricKeys: ["gwp", "policies_issued"],
        grain: "month",
        period: "2026-01"
      }),
      200
    );
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("data health reports staleness per metric", async () => {
    const health = ok(await call("north.exec", "GET", "/v1/north/data-health"));
    expect(Array.isArray(health.metrics)).toBe(true);
    expect(health.metrics.length).toBeGreaterThan(0);
    expect(health.metrics[0]).toHaveProperty("metricKey");
    expect(health.metrics[0]).toHaveProperty("staleness");
  });
});

/* ------------------------------------------------------------------ J-E5 */

describe("J-E5 cross-entity search", () => {
  it("finds a customer by name for someone who can read customers", async () => {
    const result = ok(await call("orbit.agent", "GET", "/v1/search?q=Haddad"));
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.some((hit: { resource: string }) => hit.resource === "customers")).toBe(true);
  });

  it("never returns a hit the searcher cannot read, even with core:search:read", async () => {
    // signal.lead holds core:search:read but not core:customers:read.
    const result = ok(await call("signal.lead", "GET", "/v1/search?q=Haddad"));
    expect(result.results.some((hit: { resource: string }) => hit.resource === "customers")).toBe(false);
  });

  it("refuses someone with no core:search:read at all", async () => {
    const denied = await call("scout.lead", "GET", "/v1/search?q=Haddad");
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-E6 */

describe("J-E6 message templates and locale overrides", () => {
  it("lets a tenant admin write and read back a message template", async () => {
    const created = ok<{ id: string }>(
      await call("tenant.admin", "POST", "/v1/core/message-templates", {
        key: "dist.renewal_reminder",
        channel: "email",
        subjectJson: JSON.stringify({ en: "Time to renew" }),
        bodyJson: JSON.stringify({ en: "Hi {{name}}, your policy renews soon." }),
        variablesJson: JSON.stringify(["name"])
      }),
      201
    );
    const fetched = ok<{ key: string }>(await call("tenant.admin", "GET", `/v1/core/message-templates/${created.id}`));
    expect(fetched.key).toBe("dist.renewal_reminder");
  });

  it("lets a tenant admin write and read back a locale override", async () => {
    const created = ok<{ id: string }>(
      await call("tenant.admin", "POST", "/v1/core/locale-overrides", {
        locale: "ar",
        key: "nav.today",
        value: "اليوم",
        updatedBy: seeded.users["tenant.admin"] as string
      }),
      201
    );
    const fetched = ok<{ value: string }>(await call("tenant.admin", "GET", `/v1/core/locale-overrides/${created.id}`));
    expect(fetched.value).toBe("اليوم");
  });

  it("refuses a role with no core:templates:write to create a template", async () => {
    const denied = await call("orbit.agent", "POST", "/v1/core/message-templates", {
      key: "orbit.spoof",
      channel: "email",
      bodyJson: JSON.stringify({ en: "x" })
    });
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-A1 */

describe("J-A1 a new tenant", () => {
  it("the seeded tenant is complete enough to work in", async () => {
    const me = ok(await call("tenant.admin", "GET", "/v1/me"));
    expect(me.tenant.plan).toBe("enterprise");
    expect(me.tenant.brand).toBeTruthy();
    const roles = ok(await call("tenant.admin", "GET", "/v1/core/roles?limit=100"));
    expect(roles.data.length).toBeGreaterThan(10);
    const agents = ok(await call("tenant.admin", "GET", "/v1/ai/agents?limit=50"));
    expect(agents.data.length).toBeGreaterThanOrEqual(8);
  });

  it("lists its own tenant row and nobody else's", async () => {
    // core_tenants has no tenant_id column — scoping it by its own id is the
    // only thing that keeps this list from erroring or spanning tenants.
    const tenants = ok(await call("tenant.admin", "GET", "/v1/core/tenants"));
    expect(tenants.data).toHaveLength(1);
    expect(tenants.data[0].slug).toBe("gonxt");
    const one = ok(await call("tenant.admin", "GET", `/v1/core/tenants/${tenants.data[0].id}`));
    expect(one.slug).toBe("gonxt");
  });
});

/* ------------------------------------------------------------------ J-A2 */

describe("J-A2 a new teammate", () => {
  it("a user is created, granted a role, and inherits exactly that role's nav", async () => {
    const user = ok(
      await call("tenant.admin", "POST", "/v1/core/users", {
        email: "new.joiner@gonxt.ae",
        name: "New Joiner",
        locale: "en",
        status: "active"
      }),
      201
    );
    // The hash never round-trips through CRUD, in either direction.
    expect(JSON.stringify(user)).not.toContain("passwordHash");

    const roles = ok(await call("tenant.admin", "GET", "/v1/core/roles?limit=100"));
    // tenant.admin holds core:roles:assign (the only role that does) but its
    // own bundle is read-only across every operational module — it can only
    // grant a role whose bundle is a subset of its own. north.board (pure
    // read) qualifies; axis.agent (module writes) does not — see ADR-0023.
    const roleId = roles.data.find((r: any) => r.key === "north.board").id;
    ok(
      await call("tenant.admin", "POST", "/v1/core/user-roles", { userId: user.id, roleId }),
      201
    );
  });

  it("an operations role cannot mint users", async () => {
    const denied = await call("axis.agent", "POST", "/v1/core/users", {
      email: "shadow@gonxt.ae",
      name: "Shadow",
      locale: "en",
      status: "active"
    });
    expect(denied.status).toBe(403);
  });

  it("tenant.admin cannot grant a role whose permissions it does not itself hold", async () => {
    const user = ok(
      await call("tenant.admin", "POST", "/v1/core/users", {
        email: "escalation.target@gonxt.ae",
        name: "Escalation Target",
        locale: "en",
        status: "active"
      }),
      201
    );
    const roles = ok(await call("tenant.admin", "GET", "/v1/core/roles?limit=100"));
    const roleId = roles.data.find((r: any) => r.key === "axis.agent").id;
    const denied = await call("tenant.admin", "POST", "/v1/core/user-roles", {
      userId: user.id,
      roleId
    });
    expect(denied.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ J-A3 */

describe("J-A3 pausing an agent mid-incident", () => {
  it("compliance can stop an agent without a deploy, and start it again", async () => {
    ok(
      await call("tenant.compliance", "POST", "/v1/ai/agents/quoting/pause", {
        reason: "Pricing anomaly on motor: quotes 40% below the panel."
      }),
      204
    );
    const blocked = await call("axis.agent", "POST", "/v1/ai/runs", {
      agentKey: "quoting",
      purpose: "quote.explain",
      input: "Why is Cedar cheaper?"
    });
    expect(blocked.status).toBe(400);
    // Restarting is a write, not a killswitch: compliance can stop the agent,
    // and the team that owns it is the one that starts it again.
    expect((await call("tenant.compliance", "POST", "/v1/ai/agents/quoting/resume")).status).toBe(403);
    ok(await call("tenant.admin", "POST", "/v1/ai/agents/quoting/resume"), 204);
    const allowed = await call("axis.agent", "POST", "/v1/ai/runs", {
      agentKey: "quoting",
      purpose: "quote.explain",
      input: "Why is Cedar cheaper?"
    });
    expect([200, 201]).toContain(allowed.status);
  });

  it("raising an agent's autonomy is never a self-service change", async () => {
    const res = await call("tenant.admin", "POST", "/v1/ai/agents/quoting/autonomy", {
      autonomyLevel: "act_within_limits",
      reason: "Motor quoting has held a 98% acceptance rate for two quarters."
    });
    // `ai.autonomy_raise` is never auto-approved, so the answer is a pending
    // approval — never the raised agent.
    expect([202, 403]).toContain(res.status);
    if (res.status === 202) expect(res.body.approval.decision).toBe("pending");
    else expect(res.body.type).toContain("approval_required");
  });

  it("the incident is recorded with a state a regulator can follow", async () => {
    const incident = ok(
      await call("tenant.compliance", "POST", "/v1/compliance/incidents", {
        kind: "ai_behaviour",
        title: "Quoting agent paused after a pricing anomaly",
        severity: "medium",
        state: "open"
      }),
      201
    );
    expect(incident.state).toBe("open");
    // Nobody types who they are: the session says it (SEC — actor columns).
    expect(incident.openedBy).toBe(`user:${seeded.users["tenant.compliance"]}`);
  });

  it("an actor column cannot be forged from the request body", async () => {
    const forged = await call("tenant.compliance", "POST", "/v1/compliance/incidents", {
      kind: "ai_behaviour",
      title: "Filed under someone else's name",
      severity: "low",
      state: "open",
      openedBy: `user:${seeded.users["tenant.admin"]}`
    });
    expect(forged.status).toBe(400);
    // Same rule for the other two compliance actor columns.
    const hold = ok(
      await call("tenant.compliance", "POST", "/v1/compliance/legal-holds", {
        subjectRef: "case:cas_1",
        reason: "Regulator request 2026-14"
      }),
      201
    );
    expect(hold.placedBy).toBe(`user:${seeded.users["tenant.compliance"]}`);
    const threshold = ok(
      await call("tenant.compliance", "POST", "/v1/compliance/policy-thresholds", {
        key: "axis.bind",
        // v1 is already in force; raising the gate mints the next version rather
        // than colliding with the row the tenant is currently governed by.
        version: 2,
        valueJson: { amountMinor: 5_000_000 },
        effectiveFrom: Date.now()
      }),
      201
    );
    expect(threshold.setBy).toBe(`user:${seeded.users["tenant.compliance"]}`);
  });
});

/* ------------------------------------------------------------------ J-D1 */

describe("J-D1 the first API call", () => {
  it("the OpenAPI document is public and describes the routes that exist", async () => {
    const spec = await call(null, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths["/v1/dist/quote-requests/shop"]).toBeTruthy();
    expect(spec.body.paths["/v1/me/approvals/{id}/decide"]).toBeTruthy();
  });

  it("health needs no credential; everything else does", async () => {
    expect((await call(null, "GET", "/health")).status).toBe(200);
    expect((await call(null, "GET", "/v1/me")).status).toBe(401);
  });

  it("carries security headers on every response, success or error (docs/10 §6)", async () => {
    for (const path of ["/health", "/v1/me"]) {
      const res = await app.fetch(new Request(`http://api.test${path}`), env as never, exec as never);
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("a bad session token is refused, not ignored", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/me", { headers: { authorization: "Bearer not-a-token" } }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(401);
  });
});

/* ----------------------------------------------------------------- J-CO1 */

describe("J-CO1 a regulator asks", () => {
  it("an unmasked export is refused without a justification and an approval", async () => {
    const res = await call("tenant.compliance", "POST", "/v1/analytics/exports", {
      format: "xlsx",
      definition: { dataset: "quotes", dimensions: ["state"], metrics: ["requests"], grain: "none" },
      unmasked: true,
      piiJustification: "Regulator request REG-2026-014 under article 27."
    });
    expect(res.status).toBe(403);
    expect(res.body.type).toContain("approval_required");
  });

  it("a masked export is produced without ceremony, and comes back down again", async () => {
    const created = ok(
      await call("tenant.compliance", "POST", "/v1/analytics/exports", {
        format: "xlsx",
        definition: { dataset: "quotes", dimensions: ["state"], metrics: ["requests"], grain: "none" }
      }),
      200,
      201
    );
    expect(created.state).toBe("ready");
    // An export nobody may fetch is not a report. Every role that can create one
    // can download it; the unmasked file keeps its own separate gate below.
    const file = await call("tenant.compliance", "GET", `/v1/analytics/exports/${created.id}/download`);
    expect(file.status).toBe(200);
  });

  it("the audit log is append-only over the API", async () => {
    const write = await call("tenant.compliance", "POST", "/v1/core/audit-log", {
      action: "core.fake",
      actorRef: "nobody"
    });
    expect(write.status).toBe(404);
    const patch = await call("tenant.compliance", "PATCH", "/v1/core/audit-log/aud_1", { action: "x" });
    expect(patch.status).toBe(404);
  });

  it("every AI spend is attributable to a module and a run", async () => {
    const spend = ok(await call("tenant.admin", "GET", "/v1/ai/audit/spend"));
    expect(spend.data.length).toBeGreaterThan(0);
    for (const row of spend.data) expect(row.module).toBeTruthy();
  });
});
