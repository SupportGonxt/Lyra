import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { changeSetHashOf } from "./axis-endorse.js";
import { onQuoteRequested } from "./axis-orbit-intake.js";
import { executeOrbitToolCalls, ORBIT_TOOL_DEFS, orbitToolsFor, runOrbitTool, TOOL_PERMISSION } from "./orbit-tools.js";

// docs/15. ORBIT's agent acts through these handlers, not raw SQL in the AI
// route — so the registry is tested on its own, no HTTP, no model gateway.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function actor(): Actor {
  return {
    kind: "agent",
    id: "quoting",
    tenantId: "t_1",
    grants: [{ roleKey: "axis.agent", permissions: permissionsForRole("axis.agent") }]
  };
}

function actorWithRole(roleKey: string): Actor {
  return { kind: "agent", id: "quoting", tenantId: "t_1", grants: [{ roleKey, permissions: permissionsForRole(roleKey) }] };
}

async function makeCtx(now = 1_770_000_000_000): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

// A policy on risk is a head row plus its effective version (design §C.2) —
// endorsement reads the version, not the head, so seeding only the head would
// make every endorsement test fail on "no effective version" instead of on the
// thing it is testing.
async function seedPolicy(id: string, tenantId = ctx.tenantId) {
  await ctx.db.insert(schema.axisPolicies).values({
    id,
    tenantId,
    customerId: "cus_1",
    providerId: "prv_1",
    policyNo: `POL-${id}`,
    startAt: ctx.now,
    endAt: ctx.now + 365 * 86_400_000,
    premiumMinor: 500_00,
    grossMinor: 500_00,
    currency: "AED",
    status: "bound",
    currentVersionId: `pver_${id}`,
    versionSeq: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  await ctx.db.insert(schema.axisPolicyVersions).values({
    id: `pver_${id}`,
    tenantId,
    policyId: id,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: ctx.now,
    effectiveTo: ctx.now + 365 * 86_400_000,
    premiumMinor: 500_00,
    currency: "AED",
    termsJson: "{}",
    state: "effective",
    issuedBy: "user:seed",
    issuedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

/** The endorsement handler runs with the desk's grants (design §A.3). */
function endorser(): Ctx {
  return { ...ctx, actor: actorWithRole("axis.lead") };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

describe("fetch_policy", () => {
  it("returns a policy by id, scoped to the tenant", async () => {
    await seedPolicy("pol_1");
    const result = (await runOrbitTool(ctx, "fetch_policy", { policyId: "pol_1" })) as { id: string };
    expect(result.id).toBe("pol_1");
  });

  it("returns a policy by policy number", async () => {
    await seedPolicy("pol_2");
    const result = (await runOrbitTool(ctx, "fetch_policy", { policyNo: "POL-pol_2" })) as { id: string };
    expect(result.id).toBe("pol_2");
  });

  it("never returns another tenant's policy", async () => {
    await seedPolicy("pol_3", "t_other");
    await expect(runOrbitTool(ctx, "fetch_policy", { policyId: "pol_3" })).rejects.toMatchObject({
      status: 404
    });
  });

  it("rejects a call with neither id nor number", async () => {
    await expect(runOrbitTool(ctx, "fetch_policy", {})).rejects.toMatchObject({ status: 400 });
  });
});

describe("start_quote", () => {
  // CLAUDE.md rule 6, docs/30 ORBIT 5: ORBIT asks, AXIS opens the case. The
  // tool writes no AXIS table; the case exists once AXIS hears the request.
  it("asks AXIS for an intake case by event and writes no AXIS row itself", async () => {
    const result = (await runOrbitTool(ctx, "start_quote", {
      customerId: "cus_1",
      productLine: "motor"
    })) as { caseId: string; status: string };
    expect(result.status).toBe("requested");
    expect(await ctx.db.select().from(schema.axisCases).where(eq(schema.axisCases.id, result.caseId))).toEqual([]);

    const [event] = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "orbit.quote.requested"));
    const envelope = JSON.parse(event!.envelopeJson);
    await onQuoteRequested(ctx, envelope);
    const [row] = await ctx.db
      .select()
      .from(schema.axisCases)
      .where(and(eq(schema.axisCases.tenantId, ctx.tenantId), eq(schema.axisCases.id, result.caseId)));
    expect(row).toMatchObject({ kind: "quote", status: "intake", source: "agent", customerId: "cus_1", productLine: "motor" });
  });

  it("is not consequential — no approval required", () => {
    const def = ORBIT_TOOL_DEFS.find((t) => t.name === "start_quote")!;
    expect(def.consequential).toBe(false);
  });
});

// orbit:ai:invoke authorizes *running the agent*, not the specific action a
// tool performs — so each handler must hold its own permission check, same
// as the human-facing CRUD route for the same table. Without it, any actor
// holding orbit:ai:invoke could reach axis_cases/axis_policies through chat
// while deliberately lacking the axis:* grant the UI requires.
describe("tool execution enforces its own RBAC, not just the agent-invoke gate", () => {
  it("fetch_policy rejects an actor without axis:policies:read", async () => {
    await seedPolicy("pol_4");
    const noAxis = { ...ctx, actor: actorWithRole("customer") };
    await expect(runOrbitTool(noAxis, "fetch_policy", { policyId: "pol_4" })).rejects.toMatchObject({
      name: "ForbiddenError"
    });
  });

  it("start_quote rejects an actor without axis:cases:create", async () => {
    // orbit.retention holds axis:policies:read/axis:quotes:create but not
    // axis:cases:create — start_quote must not treat those as equivalent.
    const retention = { ...ctx, actor: actorWithRole("orbit.retention") };
    await expect(runOrbitTool(retention, "start_quote", { customerId: "cus_1" })).rejects.toMatchObject({
      name: "ForbiddenError"
    });
  });

  it("create_endorsement_request rejects an actor without axis:policies:endorse, before any approval gate", async () => {
    await seedPolicy("pol_5");
    const retention = { ...ctx, actor: actorWithRole("orbit.retention") };
    await expect(
      runOrbitTool(retention, "create_endorsement_request", { policyId: "pol_5", changes: { term: 12 } })
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("create_endorsement_request", () => {
  it("is flagged consequential", () => {
    const def = ORBIT_TOOL_DEFS.find((t) => t.name === "create_endorsement_request")!;
    expect(def.consequential).toBe(true);
  });

  it("blocks on approval_required and writes no version until one exists", async () => {
    await seedPolicy("pol_4");
    await expect(
      runOrbitTool(endorser(), "create_endorsement_request", {
        policyId: "pol_4",
        changes: { sumInsuredMinor: 1_200_00 },
        premiumMinor: 1_200_00
      })
    ).rejects.toMatchObject({ status: 403, code: "approval_required" });

    // The contract is untouched: still one version, still the issued price.
    const versions = await ctx.db
      .select()
      .from(schema.axisPolicyVersions)
      .where(and(eq(schema.axisPolicyVersions.tenantId, ctx.tenantId), eq(schema.axisPolicyVersions.policyId, "pol_4")));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.state).toBe("effective");

    // The pending approval is real, not swallowed.
    const approvals = await ctx.db.select().from(schema.approvals);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.policyKey).toBe("axis.endorse");
  });

  it("proceeds once the matching approval is already granted", async () => {
    await seedPolicy("pol_5");
    const changes = { sumInsuredMinor: 1_200_00 };
    const subjectRef = `axis_endorse:pol_5:pver_pol_5:${await changeSetHashOf({ changes, reason: null })}`;
    await ctx.db.insert(schema.approvals).values({
      id: "apr_1",
      tenantId: ctx.tenantId,
      subjectRef,
      policyKey: "axis.endorse",
      module: "axis",
      requestedBy: "agent:quoting",
      requestedAt: ctx.now - 1000,
      decidedBy: "user:amina",
      decision: "approved",
      reason: "within threshold",
      // An approval covers at most what it was granted for — the delta here is
      // 700_00, so the record has to say so or the gate asks again.
      contextJson: JSON.stringify({ amountMinor: 700_00 }),
      decidedAt: ctx.now - 500,
      delegationId: null
    });

    const result = (await runOrbitTool(endorser(), "create_endorsement_request", {
      policyId: "pol_5",
      changes,
      premiumMinor: 1_200_00
    })) as { policy: { currentVersionId: string | null }; version: { id: string; versionSeq: number; premiumMinor: number } };
    expect(result.version.versionSeq).toBe(2);
    expect(result.version.premiumMinor).toBe(1_200_00);
    expect(result.policy.currentVersionId).toBe(result.version.id);
  });

  it("rejects a missing policy before touching approvals", async () => {
    await expect(
      runOrbitTool(endorser(), "create_endorsement_request", { policyId: "nope", changes: { a: 1 } })
    ).rejects.toMatchObject({ status: 404 });
    const approvals = await ctx.db.select().from(schema.approvals);
    expect(approvals).toHaveLength(0);
  });
});

describe("executeOrbitToolCalls", () => {
  it("records one ai_tool_calls row per call and returns tool-result messages", async () => {
    await seedPolicy("pol_6");
    await ctx.db.insert(schema.aiRuns).values({
      id: "air_1",
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });

    const messages = await executeOrbitToolCalls(
      endorser(),
      "air_1",
      [
        { id: "call_1", name: "fetch_policy", args: { policyId: "pol_6" } },
        {
          id: "call_2",
          name: "create_endorsement_request",
          args: { policyId: "pol_6", changes: { a: 1 }, premiumMinor: 1_200_00 }
        }
      ],
      new Set(ORBIT_TOOL_DEFS.map((d) => d.name))
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("tool");
    expect(messages[0]!.toolCallId).toBe("call_1");
    expect(JSON.parse(messages[0]!.content).id).toBe("pol_6");

    const gated = JSON.parse(messages[1]!.content);
    expect(gated.error).toBe("approval_required");
    expect(gated.approvalId).toBeTruthy();

    const rows = await ctx.db
      .select()
      .from(schema.aiToolCalls)
      .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, "air_1")))
      .orderBy(schema.aiToolCalls.seq);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.consequential).toBe(false);
    expect(rows[1]!.outcome).toBe("awaiting_approval");
    expect(rows[1]!.consequential).toBe(true);
    expect(rows[1]!.approvalId).toBeTruthy();
  });

  it("turns an unknown tool into an error row, not a thrown exception", async () => {
    await ctx.db.insert(schema.aiRuns).values({
      id: "air_2",
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });
    const messages = await executeOrbitToolCalls(
      ctx,
      "air_2",
      [{ id: "call_9", name: "delete_everything", args: {} }],
      new Set(ORBIT_TOOL_DEFS.map((d) => d.name))
    );
    expect(JSON.parse(messages[0]!.content).error).toBeTruthy();
    const rows = await ctx.db
      .select()
      .from(schema.aiToolCalls)
      .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, "air_2")));
    expect(rows[0]!.outcome).toBe("error");
  });

  it("never executes a tool outside the agent's allowlist, even if HANDLERS has it", async () => {
    await seedPolicy("pol_7");
    await ctx.db.insert(schema.aiRuns).values({
      id: "air_3",
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });

    const messages = await executeOrbitToolCalls(
      ctx,
      "air_3",
      [{ id: "call_10", name: "fetch_policy", args: { policyId: "pol_7" } }],
      new Set(["start_quote"])
    );

    expect(JSON.parse(messages[0]!.content).error).toBeTruthy();
    const rows = await ctx.db
      .select()
      .from(schema.aiToolCalls)
      .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, "air_3")));
    expect(rows[0]!.outcome).toBe("error");
  });

  // docs/27 F33. `seq` used to restart at 0 on every call, and the executor was
  // only ever called once per run, so nothing noticed. A real loop calls it once
  // per round, and a sequence that restarts is not a sequence.
  it("continues the run's tool sequence across rounds instead of restarting it", async () => {
    await seedPolicy("pol_8");
    await ctx.db.insert(schema.aiRuns).values({
      id: "air_4",
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });
    const allow = new Set(["fetch_policy"]);
    const call = { id: "call_a", name: "fetch_policy", args: { policyId: "pol_8" } };
    await executeOrbitToolCalls(ctx, "air_4", [call], allow, 0);
    await executeOrbitToolCalls(ctx, "air_4", [{ ...call, id: "call_b" }], allow, 1);

    const rows = await ctx.db
      .select()
      .from(schema.aiToolCalls)
      .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, "air_4")));
    expect(rows.map((r) => r.seq).sort()).toEqual([0, 1]);
  });
});

// docs/27 F38. `consequential: true` was written to `ai_tool_calls` and read by
// nothing: the rule held only because the one such tool happens to gate inside
// its handler. These hold the branch that makes it structural.
describe("consequential tools are gated by the executor, not by the handler's goodwill", () => {
  async function seedRun(id: string): Promise<void> {
    await ctx.db.insert(schema.aiRuns).values({
      id,
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });
  }

  it("refuses a consequential tool with no registered approval policy, before the handler runs", async () => {
    await seedRun("air_g1");
    // The registry entry is the declaration; POLICY_FOR_TOOL is the gate behind
    // it. Simulating the next consequential tool someone adds without one.
    const def = ORBIT_TOOL_DEFS.find((d) => d.name === "start_quote")!;
    const wasConsequential = def.consequential;
    def.consequential = true;
    try {
      const messages = await executeOrbitToolCalls(
        ctx,
        "air_g1",
        [{ id: "call_x", name: "start_quote", args: { customerId: "cus_1" } }],
        new Set(["start_quote"])
      );
      expect(JSON.parse(messages[0]!.content).error).toContain("no registered approval policy");
      // The handler never ran, so no case exists.
      const cases = await ctx.db.select().from(schema.axisCases);
      expect(cases).toHaveLength(0);
    } finally {
      def.consequential = wasConsequential;
    }
  });

  it("leaves a registered consequential tool on its own gate", async () => {
    await seedRun("air_g2");
    await seedPolicy("pol_9");
    const messages = await executeOrbitToolCalls(
      endorser(),
      "air_g2",
      [
        {
          id: "call_y",
          name: "create_endorsement_request",
          args: { policyId: "pol_9", changes: { sumInsuredMinor: 1_200_00 }, premiumMinor: 1_200_00 }
        }
      ],
      new Set(["create_endorsement_request"])
    );
    // approval_required from endorsePolicy, not the executor's refusal.
    expect(JSON.parse(messages[0]!.content).error).toBe("approval_required");
    const rows = await ctx.db
      .select()
      .from(schema.aiToolCalls)
      .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, "air_g2")));
    expect(rows[0]!.outcome).toBe("awaiting_approval");
    expect(rows[0]!.consequential).toBe(true);
  });
});

describe("tool results as prompt text", () => {
  // 1781571600000 = 2026-06-16T01:00:00.000Z, and it passes Luhn — so as a bare
  // 13-digit run it is a card number to the scrubber, which is what a raw
  // `JSON.stringify(policyRow)` handed the model: `"endAt":[[CARD_1]]`. The
  // agent then answers "I can't see when this policy expires" about a policy it
  // just successfully read.
  const LUHN_MS = 1_781_571_600_000;

  it("renders instants in a tool result so the scrubber has no digit run to eat", async () => {
    ctx = await makeCtx(LUHN_MS);
    await seedPolicy("pol_8");
    await ctx.db.insert(schema.aiRuns).values({
      id: "air_4",
      tenantId: ctx.tenantId,
      agentKey: "quoting",
      module: "orbit",
      purpose: "orbit.copilot",
      actorRef: "agent:quoting",
      autonomyLevel: "act_with_approval",
      trigger: "user",
      state: "running",
      inputHash: "",
      startedAt: ctx.now
    });

    const toolMessages = await executeOrbitToolCalls(
      ctx,
      "air_4",
      [{ id: "call_11", name: "fetch_policy", args: { policyId: "pol_8" } }],
      new Set(["fetch_policy"])
    );

    const stub = makeStub({ replies: ["ok"] });
    const gateway = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
    await gateway.complete(ctx, {
      module: "orbit",
      purpose: "orbit.copilot",
      tier: "fast",
      messages: [{ role: "user", content: "when does pol_8 expire?" }, { role: "assistant", content: "" }, ...toolMessages]
    });

    // stub.calls records what the provider was handed — after the gateway scrubbed it.
    const sent = stub.calls[0]!.messages.find((m) => m.role === "tool")!.content;
    expect(sent, "an epoch instant reached the scrubber and was redacted as a card number").not.toContain("[[CARD_");
    expect(sent).toContain("2026-06-16T01:00:00.000Z");
  });
});

describe("orbitToolsFor", () => {
  // An unconfigured column is not consent: a null allowlist used to hand the
  // model `create_endorsement_request`. Absent config = read-only subset.
  it("withholds consequential tools when the agent carries no allowlist", () => {
    const defs = orbitToolsFor({ toolsJson: null });
    expect(defs).toHaveLength(ORBIT_TOOL_DEFS.filter((t) => !t.consequential).length);
    expect(defs.some((t) => t.name === "create_endorsement_request")).toBe(false);
  });

  it("still grants a consequential tool when it is explicitly listed", () => {
    expect(orbitToolsFor({ toolsJson: JSON.stringify(["create_endorsement_request"]) }).map((t) => t.name)).toEqual([
      "create_endorsement_request"
    ]);
  });

  // @accept:SA — an ORBIT-only tenant's grants carry no axis:* permission
  // (entitledGrants), so a policy tool offered to its agent could only fail.
  it("offers only the tools the acting person could run — none of AXIS's without AXIS", () => {
    const orbitOnly = { kind: "user" as const, id: "u_1", tenantId: "t_1", grants: [{ roleKey: "orbit.agent", permissions: ["orbit:*:*"] as never }] };
    const names = orbitToolsFor({ toolsJson: JSON.stringify(ORBIT_TOOL_DEFS.map((t) => t.name)) }, orbitOnly).map((t) => t.name);
    expect(names).not.toContain("fetch_policy");
    expect(names).not.toContain("start_quote");
    expect(names).not.toContain("create_endorsement_request");
    expect(names).toContain("human_handover");
  });

  it("names a permission for every tool, so none is offered unchecked", () => {
    expect(ORBIT_TOOL_DEFS.filter((t) => !TOOL_PERMISSION[t.name]).map((t) => t.name)).toEqual([]);
  });

  it("filters to the agent's allowlist", () => {
    const defs = orbitToolsFor({ toolsJson: JSON.stringify(["fetch_policy"]) });
    expect(defs.map((d) => d.name)).toEqual(["fetch_policy"]);
  });
});
