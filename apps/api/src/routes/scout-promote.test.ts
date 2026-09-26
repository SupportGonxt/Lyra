import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { decide, notFound, permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { onError } from "../mw.js";
import { scoutRoutes } from "./scout.js";
import type { App } from "../env.js";

// The server half of "commentary on a whitespace, converted into a campaign":
//
//   GET  /whitespaces/commentary            scout:whitespaces:read
//   GET  /whitespaces/:id/commentary        scout:whitespaces:read
//   POST /whitespaces/:id/promote-to-signal scout:whitespaces:promote
//
// Same libSQL harness as engines/scout-whitespace.test.ts, driven through the
// real router so the permission gate, the approval gate, the idempotency slot
// and the ⊘ transaction's audit + event are all the ones production runs.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;
let tenantId: string;

const NOW = Date.UTC(2026, 0, 6, 8, 0, 0);

/** 20 refs — DEFAULT_K_FLOOR exactly, the thinnest publishable cell. */
const REFS = JSON.stringify(Array.from({ length: 20 }, (_, i) => `qs_${i}`));

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "scout-promote-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "user",
      id: "u_1",
      tenantId,
      grants: [{ roleKey: "scout.lead", permissions: permissionsForRole("scout.lead") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    // What seed() provisions: every module. Promotion lands in SIGNAL.
    entitlements: EntitlementsJson.parse({ modules: ["axis", "orbit", "signal", "scout", "north"] })
  };

  await ctx.db.insert(schema.scoutWhitespaces).values([
    {
      id: "wsp_marine",
      tenantId,
      description: "Marine demand is moving against a book that carries almost none of it.",
      category: "marine",
      clusterId: null,
      evidenceRefsJson: REFS,
      demandEstimate: 78,
      competitionScore: 40,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      // Below the k-anonymity floor: three quotes, so nothing about the cell
      // may leave — not the sentence, not the counts, and it may not be briefed.
      id: "wsp_thin",
      tenantId,
      description: "Cyber demand is moving against a book that carries none of it.",
      category: "cyber",
      clusterId: null,
      evidenceRefsJson: JSON.stringify(["qs_a", "qs_b", "qs_c"]),
      demandEstimate: 91,
      competitionScore: null,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      // Half a model reaches this one: the en call lands, the ar call dies.
      id: "wsp_partial",
      tenantId,
      description: "Aviation demand with nothing on the book, briefed while the model dies mid-way.",
      category: "aviation",
      clusterId: null,
      evidenceRefsJson: REFS,
      demandEstimate: 61,
      competitionScore: 25,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      // No model at all reaches this one: the promotion still has to commit.
      id: "wsp_nomodel",
      tenantId,
      description: "Marine demand with nothing on the book, briefed with no model available.",
      category: "marine",
      clusterId: null,
      evidenceRefsJson: REFS,
      demandEstimate: 55,
      competitionScore: 20,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      // The deterministic fallback sentence: carries no ✦, by construction.
      id: "wsp_fallback",
      tenantId,
      description: "travel: demand momentum 60 vs. 0 policies on the book",
      category: "travel",
      clusterId: null,
      evidenceRefsJson: REFS,
      demandEstimate: 60,
      competitionScore: 10,
      status: "candidate",
      owner: null,
      promotedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    }
  ] as never);
}, 120_000);

/** A brief that states no number the evidence did not give it — anything else is
 *  rejected by parseWhitespaceBrief and the fallback is used instead. */
const BRIEF_REPLY = JSON.stringify({
  name: "Marine cover launch",
  objective: "acq",
  proposition: "Marine risk we already see quoted, and do not yet cover.",
  brief: "Introduce the marine category. Speak to the demand we measured against the thin book behind it."
});

const variantLines = (n: number, label: string): string =>
  Array.from({ length: n }, (_, i) => `${label} variant ${i + 1}: talk to us about marine.`).join("\n");

/** A plan whose prose states no figure at all — same groundedness gate as the
 *  brief, and the point here is call *order*, not the parser (campaign-plan's
 *  own tests cover that). */
const PLAN_REPLY = JSON.stringify({
  notes:
    "Marine demand is moving against a book that carries almost none of it. The pool is thin, so " +
    "the three options below trade reach against precision.",
  options: [
    {
      name: "Direct to the quoting few",
      angle: "Speak only to the customers already asking for marine cover.",
      offer: "A marine quote in under a minute.",
      channels: ["email", "meta"],
      probability: 62,
      why: ["The demand is measured and the book behind it is thin."],
      risk: "A pool this narrow burns out fast."
    },
    {
      name: "Intent capture",
      angle: "Buy the searches people already make.",
      offer: "A quote for anyone already looking for marine cover.",
      channels: ["google_search"],
      probability: 48,
      why: ["The demand exists before the campaign does."],
      risk: null
    },
    {
      name: "Broad build",
      angle: "Introduce marine to the rest of the book.",
      offer: "An introduction for customers who hold none.",
      channels: ["display", "youtube"],
      probability: 27,
      why: ["Nobody on this book carries the cover yet."],
      risk: null
    }
  ]
});

function gatewayWith(replies: string[]): { stub: ReturnType<typeof makeStub>; gw: Gateway } {
  const stub = makeStub({ replies });
  return { stub, gw: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } }) };
}

/** Brief, plan, then three drafts per locale — the six DRAFT_VARIANTS the engine
 *  asks for. The stub is scripted by call order, so the plan sits where the
 *  engine makes it: after the brief it argues from, before the copy it briefs. */
const promoteReplies = (): string[] => [BRIEF_REPLY, PLAN_REPLY, variantLines(3, "en"), variantLines(3, "ar")];

function app(over: Partial<Ctx> = {}, gw: Gateway = gatewayWith(promoteReplies()).gw): Hono<App> {
  const a = new Hono<App>();
  a.onError(onError);
  a.notFound((c) => onError(notFound(c.req.path), c));
  a.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, ...over });
    c.set("gateway", gw);
    await next();
  });
  a.route("/", scoutRoutes);
  return a;
}

const send = async (a: Hono<App>, method: string, path: string, headers: Record<string, string> = {}, payload: unknown = {}) => {
  const res = await a.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(method === "POST" ? { body: JSON.stringify(payload) } : {})
    }),
    // No Vectorize binding: a harvest stores the row unembedded, as deployed.
    {}
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> };
};

/** Same tenant, narrower grants — `can` refuses any actor from another tenant
 *  outright, so the permission itself is what these tests vary. */
const actorWith = (id: string, permissions: Ctx["actor"]["grants"][number]["permissions"]): Ctx["actor"] => ({
  kind: "user",
  id,
  tenantId,
  grants: [{ roleKey: "test", permissions }]
});

const reader = (): Ctx["actor"] => actorWith("u_reader", ["scout:whitespaces:read", "scout:signals:read"]);
const outsider = (): Ctx["actor"] => actorWith("u_outsider", ["scout:data_products:read"]);

/** Campaigns this promotion made — the seed ships its own, so a bare count lies. */
const promoted = async (name: string) =>
  ctx.db
    .select({ id: schema.signalCampaigns.id })
    .from(schema.signalCampaigns)
    .where(and(eq(schema.signalCampaigns.tenantId, tenantId), eq(schema.signalCampaigns.name, name)));

const draftsFor = async (whitespaceId: string) =>
  ctx.db
    .select({ id: schema.signalCreatives.id })
    .from(schema.signalCreatives)
    .where(and(eq(schema.signalCreatives.tenantId, tenantId), eq(schema.signalCreatives.variantGroup, whitespaceId)));

describe("GET /whitespaces/commentary", () => {
  it("refuses an actor without scout:whitespaces:read", async () => {
    const res = await send(app({ actor: outsider() }), "GET", "/whitespaces/commentary");
    expect(res.status).toBe(403);
  });

  it("prefetches every live candidate's sentence and evidence in one read", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/commentary");
    expect(res.status).toBe(200);

    const rows = res.body.data as unknown as {
      whitespaceId: string;
      commentary: string | null;
      why: string[];
      suppressed: boolean;
      evidence: { signalCount: number; momentum: number } | null;
    }[];
    const byId = new Map(rows.map((row) => [row.whitespaceId, row]));
    // The seed ships its own candidates; these three are the ones under test.
    expect([...byId.keys()]).toEqual(expect.arrayContaining(["wsp_fallback", "wsp_marine", "wsp_thin"]));

    const marine = byId.get("wsp_marine")!;
    expect(marine.commentary).toContain("Marine demand is moving");
    expect(marine.suppressed).toBe(false);
    expect(marine.evidence!.signalCount).toBe(20);
    expect(marine.evidence!.momentum).toBe(78);
    // The inspectable "why" is the evidence, not the prose (docs/15 §4).
    expect(marine.why).toContain("Category: marine");
    expect(marine.why).toContain("Demand momentum score (0-100): 78");
  });

  it("leaks nothing about a candidate below the k-anonymity floor", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/commentary");
    const thin = (res.body.data as unknown as { whitespaceId: string }[]).find(
      (row) => row.whitespaceId === "wsp_thin"
    ) as unknown as {
      commentary: null;
      evidence: null;
      why: string[];
      ai: null;
      suppressed: boolean;
    };
    expect(thin.suppressed).toBe(true);
    expect(thin.commentary).toBeNull();
    expect(thin.evidence).toBeNull();
    expect(thin.why).toEqual([]);
    expect(thin.ai).toBeNull();
    // Belt and braces: neither the sentence nor the cell's momentum appears anywhere.
    expect(JSON.stringify(res.body)).not.toContain("Cyber demand");
    expect(JSON.stringify(thin)).not.toContain("91");
  });

  it("clamps a silly limit instead of trusting it", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/commentary?limit=99999");
    expect(res.status).toBe(200);
    const res2 = await send(app({ actor: reader() }), "GET", "/whitespaces/commentary?limit=0");
    expect((res2.body.data as unknown as unknown[]).length).toBe(1);
  });

  it("marks a deterministic sentence as not-AI: no ✦ for prose no model wrote", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/commentary");
    const fallback = (res.body.data as unknown as { whitespaceId: string; ai: unknown }[]).find(
      (row) => row.whitespaceId === "wsp_fallback"
    )!;
    expect(fallback.ai).toBeNull();
  });
});

describe("GET /whitespaces/:id/commentary", () => {
  it("reads one row", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/wsp_marine/commentary");
    expect(res.status).toBe(200);
    expect(res.body.whitespaceId).toBe("wsp_marine");
  });

  it("404s an id this tenant does not have", async () => {
    const res = await send(app({ actor: reader() }), "GET", "/whitespaces/wsp_nope/commentary");
    expect(res.status).toBe(404);
  });
});

describe("POST /whitespaces/:id/promote-to-signal", () => {
  it("refuses a reader who lacks scout:whitespaces:promote", async () => {
    const res = await send(app({ actor: reader() }), "POST", "/whitespaces/wsp_marine/promote-to-signal");
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("approval_required");
  });

  // @accept:SA: the handover drafts a campaign, its ads and its audience in
  // SIGNAL. A tenant without SIGNAL is told so, before any approval is asked
  // for and before anything is written that it could never open.
  it("refuses the handover when SIGNAL is not on, naming why, and writes nothing", async () => {
    const res = await send(app({ entitlements: EntitlementsJson.parse({ modules: ["scout"] }) }), "POST", "/whitespaces/wsp_marine/promote-to-signal", {
      "idempotency-key": "promote-marine-solo"
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("signal");
    expect(await promoted("Marine cover launch")).toHaveLength(0);
  });

  it("asks for the existing scout.whitespace_promote approval and drafts nothing yet", async () => {
    const res = await send(app(), "POST", "/whitespaces/wsp_marine/promote-to-signal", {
      "idempotency-key": "promote-marine-1"
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("scout.whitespace_promote");

    const [row] = await ctx.db
      .select()
      .from(schema.scoutWhitespaces)
      .where(eq(schema.scoutWhitespaces.id, "wsp_marine"));
    expect(row!.status).toBe("candidate");
    expect(await promoted("Marine cover launch")).toHaveLength(0);
    expect(await draftsFor("wsp_marine")).toHaveLength(0);
  });

  it("refuses a candidate whose evidence is below the k-anonymity floor, before asking anyone to approve it", async () => {
    const res = await send(app(), "POST", "/whitespaces/wsp_thin/promote-to-signal");
    expect(res.status).toBe(409);
    const approvals = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, "whitespaces:wsp_thin")));
    expect(approvals).toHaveLength(0);
  });

  it("promotes once approved: a draft campaign, six drafts, an audit row, an ai_audit_log row and one bus event", async () => {
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, "whitespaces:wsp_marine")));
    await decide(ctx, pending!.id, "approved");

    const { stub, gw } = gatewayWith(promoteReplies());
    const res = await send(app({}, gw), "POST", "/whitespaces/wsp_marine/promote-to-signal", {
      "idempotency-key": "promote-marine-1"
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("committed");
    expect(res.body.briefSource).toBe("ai");
    expect(res.body.drafts).toBe(6);

    // The brief went through the gateway with SCOUT's own purpose (CLAUDE.md rule 3).
    expect(stub.calls[0]!.module).toBe("scout");
    expect(stub.calls[0]!.purpose).toBe("whitespace.brief");
    expect(stub.calls[0]!.tier).toBe("reasoning");
    const briefAudit = await ctx.db
      .select()
      .from(schema.aiAuditLog)
      .where(and(eq(schema.aiAuditLog.tenantId, tenantId), eq(schema.aiAuditLog.purpose, "whitespace.brief")));
    expect(briefAudit).toHaveLength(1);
    expect(res.body.briefAuditId).toBe(briefAudit[0]!.id);

    // The plan is its own gateway call, with its own purpose and its own audit row.
    expect(stub.calls[1]!.module).toBe("signal");
    expect(stub.calls[1]!.purpose).toBe("campaign.plan");
    expect(res.body.planSource).toBe("ai");
    expect(res.body.plan).toMatchObject({ recommended: "Direct to the quoting few", confidence: 100 });
    expect((res.body.plan as unknown as { options: unknown[] }).options).toHaveLength(3);

    // And it reached the copy: the creative prompt carries the recommended
    // option's angle and offer, which is the entire reason for planning first.
    const copyPrompt = stub.calls[2]!.messages.map((m) => m.content).join("\n");
    expect(copyPrompt).toContain("Campaign approach: Direct to the quoting few");
    expect(copyPrompt).toContain("Speak only to the customers already asking for marine cover.");
    expect(copyPrompt).toContain("A marine quote in under a minute.");

    const campaignId = res.body.campaignId as unknown as string;
    const [campaign] = await ctx.db
      .select()
      .from(schema.signalCampaigns)
      .where(eq(schema.signalCampaigns.id, campaignId));
    expect(campaign!.state).toBe("draft");
    expect(campaign!.name).toBe("Marine cover launch");
    expect(campaign!.objective).toBe("acq");
    // Nothing was funded and nothing was sent.
    expect(campaign!.channelsJson).toBe("[]");
    expect(JSON.parse(campaign!.planJson!)).toMatchObject({ recommended: "Direct to the quoting few" });
    expect(JSON.parse(campaign!.budgetJson!)).toMatchObject({ dailyMinor: 0, totalMinor: 0 });

    // Provenance back to the whitespace, since signal_campaigns has no column for it.
    const creatives = await ctx.db
      .select()
      .from(schema.signalCreatives)
      .where(eq(schema.signalCreatives.campaignId, campaignId));
    expect(creatives).toHaveLength(6);
    expect(new Set(creatives.map((c) => c.variantGroup))).toEqual(new Set(["wsp_marine"]));

    const [row] = await ctx.db
      .select()
      .from(schema.scoutWhitespaces)
      .where(eq(schema.scoutWhitespaces.id, "wsp_marine"));
    expect(row!.status).toBe("validated");
    expect(row!.promotedAt).toBe(NOW);

    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.action, "scout.whitespace.promoted")));
    expect(audits).toHaveLength(1);

    // docs/04 §7: SIGNAL learns of this on the bus, not through an import.
    const events = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, tenantId), eq(schema.eventOutbox.type, "scout.whitespace.promoted")));
    expect(events).toHaveLength(1);
    const envelope = JSON.parse(events[0]!.envelopeJson) as { subject: string; data: Record<string, unknown> };
    expect(envelope.subject).toBe("wsp_marine");
    expect(envelope.data).toMatchObject({ campaignId, category: "marine", objective: "acq", signalCount: 20 });
  });

  it("replays the same idempotency key without creating a second campaign", async () => {
    const before = await ctx.db.select().from(schema.signalCampaigns);
    const { stub, gw } = gatewayWith(promoteReplies());
    const res = await send(app({}, gw), "POST", "/whitespaces/wsp_marine/promote-to-signal", {
      "idempotency-key": "promote-marine-1"
    });

    expect(res.status).toBe(201);
    expect(await ctx.db.select().from(schema.signalCampaigns)).toHaveLength(before.length);
    // The replay is served from the stored response: no second model call at all.
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a second promotion under a fresh key — validated has no self-hop", async () => {
    const res = await send(app(), "POST", "/whitespaces/wsp_marine/promote-to-signal", {
      "idempotency-key": "promote-marine-2"
    });
    expect(res.status).toBe(409);
    expect(await promoted("Marine cover launch")).toHaveLength(1);
    expect(await draftsFor("wsp_marine")).toHaveLength(6);
  });

  it("falls back to the deterministic brief when the model is unusable, and still promotes", async () => {
    const first = await send(app(), "POST", "/whitespaces/wsp_fallback/promote-to-signal");
    expect(first.body.code).toBe("approval_required");
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, "whitespaces:wsp_fallback")));
    await decide(ctx, pending!.id, "approved");

    // An invented rand figure: grounded-only is the gate, so this is refused and
    // the deterministic brief is used rather than persisting the invention.
    const { gw } = gatewayWith([
      JSON.stringify({
        name: "Travel",
        objective: "acq",
        proposition: "R4.2m of travel premium is going elsewhere.",
        brief: "Say we are cheapest on travel."
      }),
      PLAN_REPLY,
      variantLines(3, "en"),
      variantLines(3, "ar")
    ]);
    const res = await send(app({}, gw), "POST", "/whitespaces/wsp_fallback/promote-to-signal");
    expect(res.status).toBe(201);
    expect(res.body.briefSource).toBe("fallback");
    expect(res.body.brief).toMatchObject({ confidence: 0, objective: "acq" });
    expect(JSON.stringify(res.body.brief)).not.toContain("4.2m");
  });

  it("counts the drafts that survived when the generator dies between locales", async () => {
    // The generator has no transaction and cannot have one: the en rows are
    // committed before the ar call is made. Swallowing that failure into "zero
    // drafts" would put a number in the audit row and in the tray that
    // signal_creatives disagrees with — three drafts sitting in the table while
    // the handover says nothing was written. Report what is actually there.
    const ok = makeStub({ replies: [BRIEF_REPLY, PLAN_REPLY, variantLines(3, "en")] });
    let n = 0;
    const flaky = {
      ...ok,
      async complete(...args: Parameters<typeof ok.complete>) {
        // 0 = the brief, 1 = the plan, 2 = en creatives, 3 = ar creatives.
        if (n++ >= 3) throw new Error("workers-ai: 503");
        return ok.complete(...args);
      }
    };
    const gw = new Gateway({ env: {}, providers: { "workers-ai": flaky, anthropic: flaky, "openai-compat": flaky } });

    const first = await send(app({}, gw), "POST", "/whitespaces/wsp_partial/promote-to-signal");
    expect(first.body.code).toBe("approval_required");
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, "whitespaces:wsp_partial")));
    await decide(ctx, pending!.id, "approved");

    const res = await send(app({}, gw), "POST", "/whitespaces/wsp_partial/promote-to-signal");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "committed", drafts: 3 });
    expect(res.body.creatives).toHaveLength(3);

    // The response and the table agree; the audit row hashes that same after-state.
    const rows = await ctx.db
      .select({ id: schema.signalCreatives.id, locale: schema.signalCreatives.locale })
      .from(schema.signalCreatives)
      .where(
        and(eq(schema.signalCreatives.tenantId, tenantId), eq(schema.signalCreatives.variantGroup, "wsp_partial"))
      );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.locale === "en")).toBe(true);
    const entries = await ctx.db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.tenantId, tenantId),
          eq(schema.auditLog.action, "scout.whitespace.promoted"),
          eq(schema.auditLog.subjectRef, "wsp_partial")
        )
      );
    expect(entries).toHaveLength(1);
  });

  it("promotes with no drafts when the creative generator has no usable model", async () => {
    // docs/15 §4 — AI drafts, it does not gate. `draftBrief` has always fallen
    // back; the creative call did not, so anywhere without a model binding (e2e,
    // a provider outage) the whole promotion 500'd and the SCOUT -> SIGNAL
    // handover was unreachable. The campaign, the hop and the event do not
    // depend on a model; only the draft count does.
    const dead = new Gateway({
      env: {},
      providers: (() => {
        const stub = makeStub({ fail: new Error("workers-ai: AI binding missing") });
        return { "workers-ai": stub, anthropic: stub, "openai-compat": stub };
      })()
    });

    const first = await send(app({}, dead), "POST", "/whitespaces/wsp_nomodel/promote-to-signal");
    expect(first.body.code).toBe("approval_required");
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, "whitespaces:wsp_nomodel")));
    await decide(ctx, pending!.id, "approved");

    const res = await send(app({}, dead), "POST", "/whitespaces/wsp_nomodel/promote-to-signal");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "committed", drafts: 0, briefSource: "fallback" });
    expect(res.body.creatives).toEqual([]);
    expect(await draftsFor("wsp_nomodel")).toHaveLength(0);

    // The parts that never needed a model still happened.
    expect(await promoted((res.body.brief as unknown as { name: string }).name)).toHaveLength(1);
    const [row] = await ctx.db
      .select({ status: schema.scoutWhitespaces.status })
      .from(schema.scoutWhitespaces)
      .where(and(eq(schema.scoutWhitespaces.tenantId, tenantId), eq(schema.scoutWhitespaces.id, "wsp_nomodel")));
    expect(row!.status).toBe("validated");
    // The subject lives inside the envelope — event_outbox has no column for it.
    const events = await ctx.db
      .select({ envelopeJson: schema.eventOutbox.envelopeJson })
      .from(schema.eventOutbox)
      .where(
        and(eq(schema.eventOutbox.tenantId, tenantId), eq(schema.eventOutbox.type, "scout.whitespace.promoted"))
      );
    expect(events.filter((e) => (JSON.parse(e.envelopeJson) as { subject?: string }).subject === "wsp_nomodel")).toHaveLength(1);
  });
});

describe("POST /signals/import", () => {
  const admin = () => ({ kind: "user" as const, id: "u_2", tenantId, grants: [{ roleKey: "scout.admin", permissions: permissionsForRole("scout.admin") }] });

  // @accept:SA: a SCOUT-only tenant brings its own signals by file, stored the
  // way a fed item is, and told which lines it refused.
  it("stores each good line once and names the ones it refused", async () => {
    const day = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
    const csv = `source,sourceRef,observedAt,line\nsearch,imp-1,${day},motor\ngossip,imp-2,${day},motor\n`;
    const solo = { actor: admin(), entitlements: EntitlementsJson.parse({ modules: ["scout"] }) };
    const first = await send(app(solo), "POST", "/signals/import", {}, { csv });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ingested: 1 });
    expect((first.body.errors as unknown as { line: number }[]).map((e) => e.line)).toEqual([3]);
    const again = await send(app(solo), "POST", "/signals/import", {}, { csv });
    expect(again.body).toMatchObject({ ingested: 0, duplicates: 1 });
  });

  it("refuses a reader without scout:signals:ingest", async () => {
    expect((await send(app(), "POST", "/signals/import", {}, { csv: "source\n" })).status).toBe(403);
  });
});
