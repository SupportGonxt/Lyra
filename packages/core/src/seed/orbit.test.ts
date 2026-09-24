import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, asc } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import { seedOrbit } from "./orbit.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import type { CoreDb } from "../context.js";
import { splitCommission } from "../commission.js";
import { canonicalJson, sha256Hex } from "../crypto.js";

// One level deeper than seed.test.ts (src/seed/ vs src/), hence the extra "..".
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

const NOW = 1_774_000_000_000;
const RENEWAL_WINDOW = NOW + 4 * DAY;
const ISSUED_AT = NOW + 2 * DAY;
const TENANT_ID = "t_orbit";

const USER_IDS = { agent: "usr_sara", retention: "usr_yusuf", partners: "usr_dana" };
const SARA = `user:${USER_IDS.agent}`;
const YUSUF = `user:${USER_IDS.retention}`;
const DANA = `user:${USER_IDS.partners}`;
const AGENT = "agent:renewal";

const TEAMS = { motor: "team_motor", health: "team_health", retention: "team_retention" };
const CHANNELS = {
  web: "ch_web",
  app: "ch_app",
  callCentre: "ch_call",
  brokerAlpha: "ch_alpha",
  bankEmbed: "ch_bank"
};
const CUSTOMER_ID = "cus_rania";
const QUOTE_REQUEST_ID = "qrq_1";
const POLICY_ID = "pol_new";
const RENEWAL_POLICY_ID = "pol_renewal";

let client: Client;
let db: CoreDb;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  const ctx: SeedContext = {
    db,
    now: NOW,
    tenantId: TENANT_ID,
    users: { "orbit.agent": USER_IDS.agent, "orbit.retention": USER_IDS.retention, "orbit.partners": USER_IDS.partners },
    teams: TEAMS,
    providers: { gonxt: "p1", falcon: "p2", cedar: "p3", oryx: "p4", gulfHealth: "p5", meridian: "p6" },
    products: { motor: "pr1", health: "pr2", travel: "pr3", home: "pr4", life: "pr5" },
    offerings: {
      gonxtMotor: "of1",
      falconMotor: "of2",
      cedarMotor: "of3",
      oryxMotor: "of4",
      cedarMotorPlus: "of5",
      gulfHealth: "of6",
      gonxtTravel: "of7",
      cedarHome: "of8",
      oryxLife: "of9"
    },
    channels: CHANNELS,
    customerId: CUSTOMER_ID,
    consentId: "con_1",
    quoteRequestId: QUOTE_REQUEST_ID,
    caseId: "case_1",
    policyId: POLICY_ID,
    renewalPolicyId: RENEWAL_POLICY_ID,
    issuedAt: ISSUED_AT
  };

  await seedOrbit(ctx);
});

describe("seedOrbit — ai_audit_log", () => {
  async function byPurpose(purpose: string) {
    const rows = await db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.purpose, purpose));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("writes the renewal outreach turn attributed to retention, on the orbit module", async () => {
    const row = await byPurpose("orbit.renewal.draft_outreach");
    expect(row.tenantId).toBe(TENANT_ID);
    expect(row.module).toBe("orbit");
    expect(row.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(row.provider).toBe("workers-ai");
    expect(row.tier).toBe("fast");
    expect(row.tokensIn).toBe(812);
    expect(row.tokensOut).toBe(96);
    expect(row.costMicro).toBe(1_400);
    expect(row.latencyMs).toBe(640);
    expect(row.actorRef).toBe(YUSUF);
    expect(row.subjectRef).toBe(RENEWAL_POLICY_ID);
    expect(row.outcome).toBe("ok");
    expect(row.ts).toBe(RENEWAL_WINDOW + 5 * MINUTE);
    expect(row.inputHash).toBe(await hash({ policyRef: "CDR-MOT-2501-664118", churnScore: 61 }));
    expect(row.outputHash).toBe(await hash({ variant: "hold_price_7d" }));
    expect(row.guardrailFlagsJson).toBeNull();
  });

  it("writes the quote-explain turn on the dist module, attributed to sales", async () => {
    const row = await byPurpose("dist.quote.explain");
    expect(row.module).toBe("dist");
    expect(row.model).toBe("claude-3-5-haiku");
    expect(row.provider).toBe("anthropic");
    expect(row.tokensIn).toBe(1_240);
    expect(row.tokensOut).toBe(188);
    expect(row.costMicro).toBe(2_100);
    expect(row.latencyMs).toBe(910);
    expect(row.actorRef).toBe(SARA);
    expect(row.subjectRef).toBe(QUOTE_REQUEST_ID);
    expect(row.ts).toBe(NOW + 13 * MINUTE);
    expect(row.inputHash).toBe(await hash({ quoteRequestId: QUOTE_REQUEST_ID, question: "why_cheaper" }));
    expect(row.outputHash).toBe(await hash({ compared: ["cedarMotor", "falconMotor"] }));
  });

  it("writes the closing draft, still attributed to retention", async () => {
    const row = await byPurpose("orbit.renewal.draft_reply");
    expect(row.module).toBe("orbit");
    expect(row.actorRef).toBe(YUSUF);
    expect(row.subjectRef).toBe(RENEWAL_POLICY_ID);
    expect(row.tokensIn).toBe(1_460);
    expect(row.tokensOut).toBe(214);
    expect(row.costMicro).toBe(2_600);
    expect(row.latencyMs).toBe(780);
    expect(row.ts).toBe(RENEWAL_WINDOW + 1 * HOUR + 57 * MINUTE);
    expect(row.inputHash).toBe(
      await hash({ policyRef: "CDR-MOT-2501-664118", outcome: "replaced", nbo: "motor_to_home" })
    );
    expect(row.outputHash).toBe(await hash({ variant: "close_plus_home_offer" }));
  });

  it("writes the misfire with no subjectRef, attributed to the agent itself, guardrail flagged but not blocked", async () => {
    const row = await byPurpose("orbit.conversation.reply");
    expect(row.actorRef).toBe(AGENT);
    expect(row.subjectRef).toBeNull();
    expect(row.tokensIn).toBe(640);
    expect(row.tokensOut).toBe(121);
    expect(row.costMicro).toBe(1_100);
    expect(row.latencyMs).toBe(520);
    expect(row.ts).toBe(NOW - 2 * DAY + 9 * HOUR + 1 * MINUTE);
    expect(row.inputHash).toBe(await hash({ lang: "ar", intent: "claim.first_notice" }));
    expect(row.outputHash).toBe(await hash({ variant: "renewal_selfserve_ar" }));
    expect(row.guardrailFlagsJson).toBe(JSON.stringify({ flags: ["intent_mismatch"], blocked: false }));
  });

  it("writes exactly four rows total", async () => {
    expect(await db.select().from(schema.aiAuditLog)).toHaveLength(4);
  });
});

describe("seedOrbit — orbit_conversations", () => {
  async function byExternalRef(externalRef: string) {
    const rows = await db
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.externalRef, externalRef));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("writes exactly nine conversations", async () => {
    expect(await db.select().from(schema.orbitConversations)).toHaveLength(9);
  });

  it("renewal thread: human state, assigned to retention, no csat, no closedAt", async () => {
    const row = await byExternalRef("wa:971501234567");
    expect(row.customerId).toBe(CUSTOMER_ID);
    expect(row.channel).toBe("whatsapp");
    expect(row.state).toBe("human");
    expect(row.assigneeRef).toBe(YUSUF);
    expect(row.teamId).toBe(TEAMS.retention);
    expect(row.csat).toBeNull();
    expect(row.lang).toBe("en");
    expect(row.intent).toBe("renewal.offer");
    expect(row.sentiment).toBe(42);
    expect(row.firstResponseMs).toBe(5 * MINUTE);
    expect(row.lastMessageAt).toBe(RENEWAL_WINDOW + 1 * HOUR + 55 * MINUTE);
    expect(row.closedAt).toBeNull();
    expect(row.createdAt).toBe(RENEWAL_WINDOW);
    expect(row.updatedAt).toBe(RENEWAL_WINDOW + 1 * HOUR + 57 * MINUTE);
  });

  it("compare thread: closed with csat 5, assigned to sales", async () => {
    const row = await byExternalRef("web:sess-2601-0417");
    expect(row.state).toBe("closed");
    expect(row.assigneeRef).toBe(SARA);
    expect(row.teamId).toBe(TEAMS.motor);
    expect(row.csat).toBe(5);
    expect(row.intent).toBe("quote.compare");
    expect(row.sentiment).toBe(64);
    expect(row.closedAt).toBe(NOW + 3 * HOUR);
  });

  it("accidentAr thread: no matched customer, negative sentiment, Arabic", async () => {
    const row = await byExternalRef("wa:971559876543");
    expect(row.customerId).toBeNull();
    expect(row.lang).toBe("ar");
    expect(row.intent).toBe("claim.first_notice");
    expect(row.sentiment).toBe(-58);
    expect(row.state).toBe("human");
    expect(row.assigneeRef).toBe(SARA);
    expect(row.csat).toBeNull();
    expect(row.createdAt).toBe(NOW - 2 * DAY + 9 * HOUR);
  });

  it("documents thread: still with the bot, no assignee", async () => {
    const row = await byExternalRef("email:thread-9f21");
    expect(row.state).toBe("bot");
    expect(row.assigneeRef).toBeNull();
    expect(row.intent).toBe("policy.document");
    expect(row.lastMessageAt).toBe(NOW + 6 * DAY);
    expect(row.createdAt).toBe(NOW + 3 * DAY);
  });

  it("broker thread: b2b, no team, negative sentiment", async () => {
    const row = await byExternalRef("portal:alpha-brokers");
    expect(row.customerId).toBeNull();
    expect(row.channel).toBe("agent");
    expect(row.assigneeRef).toBe(DANA);
    expect(row.teamId).toBeNull();
    expect(row.intent).toBe("partner.settlement");
    expect(row.sentiment).toBe(-18);
  });

  it("callback thread: closed, csat 3, Arabic, retention-owned", async () => {
    const row = await byExternalRef("cc:call-77120");
    expect(row.channel).toBe("voice");
    expect(row.state).toBe("closed");
    expect(row.assigneeRef).toBe(YUSUF);
    expect(row.teamId).toBe(TEAMS.retention);
    expect(row.csat).toBe(3);
    expect(row.lang).toBe("ar");
    expect(row.sentiment).toBe(-12);
    expect(row.closedAt).toBe(NOW - 30 * DAY + 12 * HOUR);
  });

  it("faqAr thread: contained by the bot, no assignee, no csat, no closedAt", async () => {
    const row = await byExternalRef("web:sess-2512-8830");
    expect(row.customerId).toBeNull();
    expect(row.state).toBe("bot");
    expect(row.assigneeRef).toBeNull();
    expect(row.teamId).toBeNull();
    expect(row.csat).toBeNull();
    expect(row.closedAt).toBeNull();
    expect(row.sentiment).toBe(18);
    expect(row.firstResponseMs).toBe(40_000);
  });

  it("certificate thread: closed, csat 5, timed off ctx.issuedAt", async () => {
    const row = await byExternalRef("wa:971501234567:cert");
    expect(row.state).toBe("closed");
    expect(row.csat).toBe(5);
    expect(row.teamId).toBe(TEAMS.motor);
    expect(row.assigneeRef).toBeNull();
    expect(row.lastMessageAt).toBe(ISSUED_AT + 5 * HOUR);
    expect(row.closedAt).toBe(ISSUED_AT + 5 * HOUR + 10 * MINUTE);
    expect(row.createdAt).toBe(ISSUED_AT + 5 * HOUR);
    expect(row.firstResponseMs).toBe(35_000);
  });

  // The one closed thread the seed leaves unrated, so the CSAT half of
  // orbit.md §5 has something to collect and J-C2's hosted feedback page has a
  // conversation to offer. Its `csat` staying null is the point of the row.
  it("awaiting-rating thread: closed this morning with no csat", async () => {
    const row = await byExternalRef("wa:971501234567:driver");
    expect(row.state).toBe("closed");
    expect(row.csat).toBeNull();
    expect(row.customerId).toBe(CUSTOMER_ID);
    expect(row.assigneeRef).toBe(SARA);
    expect(row.teamId).toBe(TEAMS.motor);
    expect(row.lastMessageAt).toBe(NOW - 3 * HOUR);
    expect(row.closedAt).toBe(NOW - 2 * HOUR);
    expect(row.createdAt).toBe(NOW - 3 * HOUR - 20 * MINUTE);
    expect(row.firstResponseMs).toBe(3 * MINUTE);
  });
});

describe("seedOrbit — orbit_messages", () => {
  async function conversationId(externalRef: string): Promise<string> {
    const rows = await db
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.externalRef, externalRef));
    return rows[0]!.id;
  }

  it("writes exactly twelve messages", async () => {
    expect(await db.select().from(schema.orbitMessages)).toHaveLength(12);
  });

  it("renewal thread: eight messages in order, system opens and agent_ai draft closes unattached", async () => {
    const cid = await conversationId("wa:971501234567");
    const rows = await db
      .select()
      .from(schema.orbitMessages)
      .where(eq(schema.orbitMessages.conversationId, cid))
      .orderBy(asc(schema.orbitMessages.ts));
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.role)).toEqual([
      "system",
      "agent_ai",
      "customer",
      "agent_human",
      "customer",
      "agent_human",
      "customer",
      "agent_ai"
    ]);
    // Opening system message: no aiAuditId, no deliveryStatus, no externalRef.
    expect(rows[0]!.content).toBe(
      "Renewal sweep raised CDR-MOT-2501-664118. Cover ends 9 April; retention owns the outreach."
    );
    expect(rows[0]!.aiAuditId).toBeNull();
    expect(rows[0]!.deliveryStatus).toBeNull();
    expect(rows[0]!.ts).toBe(RENEWAL_WINDOW);

    // First AI outreach turn: linked to the outreach audit row, delivery read.
    const outreachAudit = (
      await db
        .select()
        .from(schema.aiAuditLog)
        .where(eq(schema.aiAuditLog.purpose, "orbit.renewal.draft_outreach"))
    )[0]!;
    expect(rows[1]!.aiAuditId).toBe(outreachAudit.id);
    expect(rows[1]!.deliveryStatus).toBe("read");
    expect(rows[1]!.externalRef).toBe("wamid.HBgMOTcxNTAxMjM0NTY3AA01");
    expect(rows[1]!.ts).toBe(RENEWAL_WINDOW + 5 * MINUTE);

    // Trailing draft: agent_ai, linked to the closing draft audit row, and — the
    // one message in this thread with neither deliveryStatus nor externalRef,
    // because nothing has dispatched it yet.
    const closingAudit = (
      await db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.purpose, "orbit.renewal.draft_reply"))
    )[0]!;
    const last = rows[7]!;
    expect(last.role).toBe("agent_ai");
    expect(last.aiAuditId).toBe(closingAudit.id);
    expect(last.deliveryStatus).toBeNull();
    expect(last.externalRef).toBeNull();
    expect(last.ts).toBe(RENEWAL_WINDOW + 1 * HOUR + 57 * MINUTE);
    expect(last.content).toContain("closed the renewal on CDR-MOT-2501-664118 as replaced");
  });

  it("compare thread: two messages, the second linked to the quote-explain audit row", async () => {
    const cid = await conversationId("web:sess-2601-0417");
    const rows = await db
      .select()
      .from(schema.orbitMessages)
      .where(eq(schema.orbitMessages.conversationId, cid))
      .orderBy(asc(schema.orbitMessages.ts));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.role).toBe("customer");
    expect(rows[0]!.ts).toBe(NOW + 12 * MINUTE);
    expect(rows[1]!.role).toBe("agent_ai");
    expect(rows[1]!.deliveryStatus).toBe("delivered");
    const quoteExplainAudit = (
      await db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.purpose, "dist.quote.explain"))
    )[0]!;
    expect(rows[1]!.aiAuditId).toBe(quoteExplainAudit.id);
  });

  it("accidentAr thread: the misfired agent_ai reply carries the misfire audit id", async () => {
    const cid = await conversationId("wa:971559876543");
    const rows = await db
      .select()
      .from(schema.orbitMessages)
      .where(eq(schema.orbitMessages.conversationId, cid))
      .orderBy(asc(schema.orbitMessages.ts));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.role).toBe("customer");
    const misfireAudit = (
      await db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.purpose, "orbit.conversation.reply"))
    )[0]!;
    expect(rows[1]!.aiAuditId).toBe(misfireAudit.id);
    expect(rows[1]!.deliveryStatus).toBe("delivered");
    expect(rows[1]!.ts).toBe(NOW - 2 * DAY + 9 * HOUR + 1 * MINUTE);
  });

  it("scopes the external-ref uniqueness per tenant, and every message row's externalRef is unique or null", async () => {
    const rows = await db.select().from(schema.orbitMessages);
    const refs = rows.map((r) => r.externalRef).filter((r): r is string => r !== null);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("seedOrbit — ai_runs", () => {
  it("writes one run awaiting approval, evidencing both policies and the nbo", async () => {
    const rows = await db.select().from(schema.aiRuns);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agentKey).toBe("renewal");
    expect(row.module).toBe("orbit");
    expect(row.purpose).toBe("orbit.renewal.draft_reply");
    expect(row.actorRef).toBe(YUSUF);
    expect(row.autonomyLevel).toBe("suggest");
    expect(row.trigger).toBe("event");
    expect(row.state).toBe("awaiting_approval");
    expect(row.confidence).toBe(78);
    expect(row.tokensIn).toBe(1_460);
    expect(row.tokensOut).toBe(214);
    expect(row.costMicro).toBe(2_600);
    expect(row.latencyMs).toBe(780);
    expect(row.startedAt).toBe(RENEWAL_WINDOW + 1 * HOUR + 56 * MINUTE);
    expect(row.endedAt).toBe(RENEWAL_WINDOW + 1 * HOUR + 57 * MINUTE);

    const closingAudit = (
      await db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.purpose, "orbit.renewal.draft_reply"))
    )[0]!;
    expect(row.outputRef).toBe(closingAudit.id);

    const renewalConv = (
      await db
        .select()
        .from(schema.orbitConversations)
        .where(eq(schema.orbitConversations.externalRef, "wa:971501234567"))
    )[0]!;
    expect(row.subjectRef).toBe(renewalConv.id);
    expect(row.inputHash).toBe(
      await hash({ conversationId: renewalConv.id, policyRef: "CDR-MOT-2501-664118" })
    );

    expect(JSON.parse(row.evidenceJson!)).toEqual([
      { kind: "policy", ref: RENEWAL_POLICY_ID, label: "CDR-MOT-2501-664118 expires 9 April" },
      { kind: "policy", ref: POLICY_ID, label: "CDR-MOT-2601-778201 already in force" },
      { kind: "nbo", ref: CUSTOMER_ID, label: "motor → home, score 72" }
    ]);
  });
});

describe("seedOrbit — orbit_handover_notes", () => {
  async function forConversation(externalRef: string) {
    const cid = (
      await db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.externalRef, externalRef))
    )[0]!.id;
    const rows = await db.select().from(schema.orbitHandoverNotes).where(eq(schema.orbitHandoverNotes.conversationId, cid));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("writes exactly five handover notes", async () => {
    expect(await db.select().from(schema.orbitHandoverNotes)).toHaveLength(5);
  });

  it("accidentAr: ai-generated, accepted by Sara", async () => {
    const row = await forConversation("wa:971559876543");
    expect(row.fromRef).toBe(AGENT);
    expect(row.toRef).toBe(SARA);
    expect(row.generatedBy).toBe("ai");
    expect(row.acceptedBy).toBe(SARA);
    expect(JSON.parse(row.factsJson!)).toEqual({
      lang: "ar",
      msisdn: "+971559876543",
      matchedCustomer: null,
      statedPolicyholder: "spouse",
      location: "Sheikh Zayed Road",
      injuries: "unstated"
    });
  });

  it("renewal: human-generated, sales to retention, accepted", async () => {
    const row = await forConversation("wa:971501234567");
    expect(row.fromRef).toBe(SARA);
    expect(row.toRef).toBe(YUSUF);
    expect(row.generatedBy).toBe("human");
    expect(row.acceptedBy).toBe(YUSUF);
    expect(JSON.parse(row.factsJson!)).toEqual({
      newPolicy: "CDR-MOT-2601-778201",
      expiringPolicy: "CDR-MOT-2501-664118",
      ncdYears: 2
    });
  });

  it("broker: ai-generated, deliberately unaccepted", async () => {
    const row = await forConversation("portal:alpha-brokers");
    expect(row.fromRef).toBe(AGENT);
    expect(row.toRef).toBe(DANA);
    expect(row.generatedBy).toBe("ai");
    expect(row.acceptedBy).toBeNull();
  });

  it("documents: addressed to the motor team ref, not a person", async () => {
    const row = await forConversation("email:thread-9f21");
    expect(row.toRef).toBe(`team:${TEAMS.motor}`);
    expect(row.generatedBy).toBe("ai");
    expect(row.acceptedBy).toBeNull();
  });

  it("callback: human-generated, retention to sales, accepted", async () => {
    const row = await forConversation("cc:call-77120");
    expect(row.fromRef).toBe(YUSUF);
    expect(row.toRef).toBe(SARA);
    expect(row.generatedBy).toBe("human");
    expect(row.acceptedBy).toBe(SARA);
    expect(row.factsJson).toBeNull();
  });
});

describe("seedOrbit — orbit_qa_scores", () => {
  it("writes exactly six qa scores", async () => {
    expect(await db.select().from(schema.orbitQaScores)).toHaveLength(6);
  });

  it("accidentAr is scored twice: an initial score under the bar disputed by Sara, then a re-score by Yusuf", async () => {
    const cid = (
      await db
        .select()
        .from(schema.orbitConversations)
        .where(eq(schema.orbitConversations.externalRef, "wa:971559876543"))
    )[0]!.id;
    const rows = await db
      .select()
      .from(schema.orbitQaScores)
      .where(eq(schema.orbitQaScores.conversationId, cid))
      .orderBy(asc(schema.orbitQaScores.ts));
    expect(rows).toHaveLength(2);

    expect(rows[0]!.score).toBe(52);
    expect(rows[0]!.scoredBy).toBe("agent:qa");
    expect(rows[0]!.disputedBy).toBe(SARA);
    expect(JSON.parse(rows[0]!.flagsJson!)).toEqual(["missed_escalation", "intent_mismatch", "fnol_unrecognised"]);

    expect(rows[1]!.score).toBe(61);
    expect(rows[1]!.scoredBy).toBe(YUSUF);
    expect(rows[1]!.disputedBy).toBeNull();
    expect(JSON.parse(rows[1]!.flagsJson!)).toEqual(["missed_escalation"]);

    // Both under the 70 bar the conversation view draws.
    expect(rows[0]!.score).toBeLessThan(70);
    expect(rows[1]!.score).toBeLessThan(70);
  });

  it("renewal, compare and faqAr score above the bar with no flags", async () => {
    for (const [externalRef, expectedScore, rubricKey] of [
      ["wa:971501234567", 88, "orbit.retention_call"],
      ["web:sess-2601-0417", 92, "orbit.sales_conduct"],
      ["web:sess-2512-8830", 76, "orbit.bot_containment"]
    ] as const) {
      const cid = (
        await db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.externalRef, externalRef))
      )[0]!.id;
      const rows = await db.select().from(schema.orbitQaScores).where(eq(schema.orbitQaScores.conversationId, cid));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.score).toBe(expectedScore);
      expect(rows[0]!.rubricKey).toBe(rubricKey);
      expect(rows[0]!.score).toBeGreaterThanOrEqual(70);
      expect(rows[0]!.flagsJson).toBeNull();
    }
  });

  it("broker scores 66, under the bar, flagged for no commitment given", async () => {
    const cid = (
      await db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.externalRef, "portal:alpha-brokers"))
    )[0]!.id;
    const rows = await db.select().from(schema.orbitQaScores).where(eq(schema.orbitQaScores.conversationId, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(66);
    expect(rows[0]!.score).toBeLessThan(70);
    expect(JSON.parse(rows[0]!.flagsJson!)).toEqual(["no_commitment_given"]);
    expect(rows[0]!.scoredBy).toBe("agent:qa");
  });
});

describe("seedOrbit — graph() helper via orbit_journeys", () => {
  function expectedEdges(nodes: { key: string }[]): { from: string; to: string }[] {
    return nodes.slice(0, -1).map((n, i) => ({ from: n.key, to: nodes[i + 1]!.key }));
  }

  it("writes exactly six journeys", async () => {
    expect(await db.select().from(schema.orbitJourneys)).toHaveLength(6);
  });

  it("renewal_45d v1 is retired, created by the raw retention user id (not user:-prefixed)", async () => {
    const rows = await db
      .select()
      .from(schema.orbitJourneys)
      .where(eq(schema.orbitJourneys.key, "renewal_45d"));
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => r.version === 1)!;
    const v2 = rows.find((r) => r.version === 2)!;

    expect(v1.status).toBe("retired");
    expect(v1.createdBy).toBe(USER_IDS.retention); // not "user:usr_yusuf"
    expect(v1.createdAt).toBe(NOW - 300 * DAY);
    const nodes1 = [
      { key: "start", type: "trigger", on: "orbit.renewal.due" },
      { key: "email_offer", type: "message", channel: "email" },
      { key: "wait_7d", type: "wait", days: 7 },
      { key: "call", type: "task", team: "retention" },
      { key: "end", type: "end" }
    ];
    const parsed1 = JSON.parse(v1.graphJson);
    expect(parsed1.nodes).toEqual(nodes1);
    expect(parsed1.edges).toEqual(expectedEdges(nodes1));
    expect(parsed1.edges).toHaveLength(4);

    expect(v2.status).toBe("active");
    expect(v2.createdBy).toBe(USER_IDS.retention);
    expect(v2.createdAt).toBe(NOW - 40 * DAY);
    const nodes2 = [
      { key: "start", type: "trigger", on: "orbit.renewal.due" },
      { key: "score_churn", type: "agent", agent: "renewal" },
      { key: "draft_offer", type: "agent", agent: "renewal", approval: "orbit.outbound_send" },
      { key: "wait_5d", type: "wait", days: 5 },
      { key: "call", type: "task", team: "retention" },
      { key: "end", type: "end" }
    ];
    const parsed2 = JSON.parse(v2.graphJson);
    expect(parsed2.nodes).toEqual(nodes2);
    expect(parsed2.edges).toEqual(expectedEdges(nodes2));
    expect(parsed2.edges).toHaveLength(5);
  });

  it("onboarding_new_policy: active, created by the agent-desk user, 4 edges over 5 nodes", async () => {
    const row = (
      await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.key, "onboarding_new_policy"))
    )[0]!;
    expect(row.version).toBe(1);
    expect(row.status).toBe("active");
    expect(row.createdBy).toBe(USER_IDS.agent);
    expect(row.createdAt).toBe(NOW - 120 * DAY);
    const nodes = [
      { key: "start", type: "trigger", on: "axis.policy.issued" },
      { key: "send_documents", type: "message", channel: "email" },
      { key: "wait_2d", type: "wait", days: 2 },
      { key: "csat", type: "survey" },
      { key: "end", type: "end" }
    ];
    const parsed = JSON.parse(row.graphJson);
    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual(expectedEdges(nodes));
  });

  it("document_chase: paused, 6 nodes / 5 edges", async () => {
    const row = (
      await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.key, "document_chase"))
    )[0]!;
    expect(row.status).toBe("paused");
    expect(row.createdBy).toBe(USER_IDS.agent);
    const nodes = [
      { key: "start", type: "trigger", on: "orbit.conversation.document" },
      { key: "remind_1", type: "message", channel: "email" },
      { key: "wait_3d", type: "wait", days: 3 },
      { key: "remind_2", type: "message", channel: "whatsapp" },
      { key: "escalate", type: "task", team: "motor" },
      { key: "end", type: "end" }
    ];
    const parsed = JSON.parse(row.graphJson);
    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual(expectedEdges(nodes));
    expect(parsed.edges).toHaveLength(5);
  });

  it("winback_lapsed: draft status, 4 nodes / 3 edges", async () => {
    const row = (
      await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.key, "winback_lapsed"))
    )[0]!;
    expect(row.status).toBe("draft");
    expect(row.createdBy).toBe(USER_IDS.retention);
    const nodes = [
      { key: "start", type: "trigger", on: "orbit.renewal.lost" },
      { key: "wait_30d", type: "wait", days: 30 },
      { key: "offer", type: "agent", agent: "renewal", approval: "orbit.outbound_send" },
      { key: "end", type: "end" }
    ];
    const parsed = JSON.parse(row.graphJson);
    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual(expectedEdges(nodes));
    expect(parsed.edges).toHaveLength(3);
  });

  it("broker_activation: active, created by the partner-desk user, 5 nodes / 4 edges", async () => {
    const row = (
      await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.key, "broker_activation"))
    )[0]!;
    expect(row.status).toBe("active");
    expect(row.createdBy).toBe(USER_IDS.partners);
    const nodes = [
      { key: "start", type: "trigger", on: "orbit.partner.stage_changed" },
      { key: "sandbox_keys", type: "task", team: "partners" },
      { key: "first_quote", type: "wait_for", event: "orbit.partner.quote" },
      { key: "go_live", type: "task", team: "partners" },
      { key: "end", type: "end" }
    ];
    const parsed = JSON.parse(row.graphJson);
    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual(expectedEdges(nodes));
    expect(parsed.edges).toHaveLength(4);
  });
});

describe("seedOrbit — orbit_journey_runs", () => {
  async function forJourneyKey(key: string, version: number) {
    const journey = (
      await db
        .select()
        .from(schema.orbitJourneys)
        .where(eq(schema.orbitJourneys.key, key))
    ).find((r) => r.version === version)!;
    const rows = await db.select().from(schema.orbitJourneyRuns).where(eq(schema.orbitJourneyRuns.journeyId, journey.id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("writes exactly five journey runs, all for the one seeded customer", async () => {
    const rows = await db.select().from(schema.orbitJourneyRuns);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.customerId).toBe(CUSTOMER_ID);
  });

  it("renewal v2 run: waiting on wait_5d, nextAt 5 days into the renewal window", async () => {
    const row = await forJourneyKey("renewal_45d", 2);
    expect(row.node).toBe("wait_5d");
    expect(row.state).toBe("waiting");
    expect(row.nextAt).toBe(RENEWAL_WINDOW + 5 * DAY);
    expect(row.createdAt).toBe(RENEWAL_WINDOW);
    expect(row.updatedAt).toBe(RENEWAL_WINDOW + 1 * HOUR + 57 * MINUTE);
    expect(JSON.parse(row.contextJson!)).toEqual({
      policyRef: "CDR-MOT-2501-664118",
      churnScore: 61,
      conversationId: (
        await db
          .select()
          .from(schema.orbitConversations)
          .where(eq(schema.orbitConversations.externalRef, "wa:971501234567"))
      )[0]!.id,
      draftAwaitingApproval: true
    });
  });

  it("onboarding run: done, no nextAt", async () => {
    const row = await forJourneyKey("onboarding_new_policy", 1);
    expect(row.node).toBe("end");
    expect(row.state).toBe("done");
    expect(row.nextAt).toBeNull();
    expect(row.createdAt).toBe(ISSUED_AT);
    expect(row.updatedAt).toBe(ISSUED_AT + 2 * DAY);
    expect(JSON.parse(row.contextJson!)).toEqual({ policyRef: "CDR-MOT-2601-778201", csat: 5 });
  });

  it("documents run: halted with a nested error object, no nextAt", async () => {
    const row = await forJourneyKey("document_chase", 1);
    expect(row.node).toBe("remind_2");
    expect(row.state).toBe("halted");
    expect(row.nextAt).toBeNull();
    const ctxJson = JSON.parse(row.contextJson!);
    expect(ctxJson.attempts).toBe(2);
    expect(ctxJson.error).toEqual({ code: "channel.template_rejected", node: "remind_2", at: NOW + 6 * DAY });
    expect(ctxJson.resumeRequires).toBe("approved WhatsApp template or a manual call");
  });

  it("winback run: running, nextAt 30 days out", async () => {
    const row = await forJourneyKey("winback_lapsed", 1);
    expect(row.node).toBe("wait_30d");
    expect(row.state).toBe("running");
    expect(row.nextAt).toBe(NOW + 30 * DAY);
    expect(row.createdAt).toBe(NOW);
    expect(JSON.parse(row.contextJson!)).toEqual({ enrolledFor: "home", reason: "no home cover on file" });
  });

  it("renewal v1 run: done, stays on the retired version rather than migrating to v2", async () => {
    const row = await forJourneyKey("renewal_45d", 1);
    expect(row.node).toBe("end");
    expect(row.state).toBe("done");
    expect(row.createdAt).toBe(NOW - 380 * DAY);
    expect(row.updatedAt).toBe(NOW - 350 * DAY);
    expect(JSON.parse(row.contextJson!)).toEqual({ policyRef: "CDR-MOT-2401-551903", outcome: "renewed" });
  });
});

describe("seedOrbit — orbit_partners", () => {
  async function byName(name: string) {
    const rows = await db.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.name, name));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("writes exactly five partners", async () => {
    expect(await db.select().from(schema.orbitPartners)).toHaveLength(5);
  });

  it("Alpha Brokers: live, auto, revshare overrides and settlement terms", async () => {
    const row = await byName("Alpha Brokers");
    expect(row.kind).toBe("auto");
    expect(row.apiKeyRef).toBe("alpha-brokers-live");
    expect(row.sandboxFlag).toBe(false);
    expect(row.status).toBe("active");
    expect(row.createdAt).toBe(NOW - 400 * DAY);
    expect(row.updatedAt).toBe(NOW - 3 * DAY);
    const revshare = JSON.parse(row.revshareJson!);
    expect(revshare.channelId).toBe(CHANNELS.brokerAlpha);
    expect(revshare.defaultSharePpm).toBe(300_000);
    expect(revshare.overrides).toEqual([
      { line: "motor", sharePpm: 350_000 },
      { offering: "cedar_motor_plus", sharePpm: 450_000 },
      { line: "health", sharePpm: 250_000, flatFeeMinor: 2_500 }
    ]);
    expect(revshare.settlement).toEqual({ frequency: "monthly", dayOfMonth: 10, netDays: 15, minPayoutMinor: 50_000 });
    expect(JSON.parse(row.contactJson!)).toEqual({
      name: "Layla Mansour",
      email: "layla@alphabrokers.ae",
      phone: "+97142223300",
      ownerRef: DANA
    });
  });

  it("Meridian Bank: bank kind, no override array, net-30 settlement", async () => {
    const row = await byName("Meridian Bank");
    expect(row.kind).toBe("bank");
    expect(row.apiKeyRef).toBe("meridian-embed-live");
    expect(row.sandboxFlag).toBe(false);
    expect(row.status).toBe("active");
    const revshare = JSON.parse(row.revshareJson!);
    expect(revshare.channelId).toBe(CHANNELS.bankEmbed);
    expect(revshare.defaultSharePpm).toBe(400_000);
    expect(revshare.overrides).toBeUndefined();
    expect(revshare.settlement).toEqual({ frequency: "monthly", dayOfMonth: 10, netDays: 30, minPayoutMinor: 100_000 });
  });

  it("Etisalat Mobility: telco, pending, no apiKeyRef", async () => {
    const row = await byName("Etisalat Mobility");
    expect(row.kind).toBe("telco");
    expect(row.apiKeyRef).toBeNull();
    expect(row.status).toBe("pending");
    expect(row.sandboxFlag).toBe(true);
    expect(JSON.parse(row.revshareJson!)).toEqual({ defaultSharePpm: 200_000 });
  });

  it("Careem Everything: superapp, sandbox true, active", async () => {
    const row = await byName("Careem Everything");
    expect(row.kind).toBe("superapp");
    expect(row.apiKeyRef).toBe("careem-sandbox");
    expect(row.sandboxFlag).toBe(true);
    expect(row.status).toBe("active");
    expect(JSON.parse(row.revshareJson!)).toEqual({ defaultSharePpm: 275_000 });
  });

  it("Gulf Auto Mall: auto, suspended, no apiKeyRef, no revshareJson", async () => {
    const row = await byName("Gulf Auto Mall");
    expect(row.kind).toBe("auto");
    expect(row.apiKeyRef).toBeNull();
    expect(row.revshareJson).toBeNull();
    expect(row.status).toBe("suspended");
    expect(row.sandboxFlag).toBe(false);
    expect(row.createdAt).toBe(NOW - 500 * DAY);
    expect(row.updatedAt).toBe(NOW - 45 * DAY);
  });
});

describe("seedOrbit — orbit_partner_txns", () => {
  interface ExpectedTxn {
    partnerName: string;
    kind: string;
    premiumMinor: number;
    basePpm: number;
    sharePpm: number;
    batch: string | null;
    at: number;
    payload: unknown;
  }

  // Same literal specs as the source, hand-sorted ascending by `at` — the order
  // a ts-ordered query returns them in.
  const expectedByTs: ExpectedTxn[] = [
    {
      partnerName: "Alpha Brokers",
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: null,
      at: NOW - 26 * DAY + 10 * HOUR,
      payload: { line: "motor", vehicle: "Nissan Patrol 2022", quoted: 512_000 }
    },
    {
      partnerName: "Alpha Brokers",
      kind: "bind",
      premiumMinor: 486_000,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: "ALPHA-2512",
      at: NOW - 25 * DAY + 11 * HOUR,
      payload: { line: "motor", offering: "cedar_motor", policyRef: "CDR-MOT-2512-551140" }
    },
    {
      partnerName: "Alpha Brokers",
      kind: "bind",
      premiumMinor: 612_500,
      basePpm: 175_000,
      sharePpm: 450_000,
      batch: "ALPHA-2512",
      at: NOW - 22 * DAY + 9 * HOUR,
      payload: { line: "motor", offering: "cedar_motor_plus", policyRef: "CDR-MOP-2512-551208" }
    },
    {
      partnerName: "Meridian Bank",
      kind: "bind",
      premiumMinor: 398_000,
      basePpm: 125_000,
      sharePpm: 400_000,
      batch: "MERIDIAN-2512",
      at: NOW - 20 * DAY + 8 * HOUR,
      payload: { line: "motor", origin: "car_loan_checkout", policyRef: "CDR-MOT-2512-548019" }
    },
    {
      partnerName: "Careem Everything",
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 275_000,
      batch: null,
      at: NOW - 5 * DAY + 19 * HOUR,
      payload: { line: "motor", sandbox: true, quoted: 399_000 }
    },
    {
      partnerName: "Alpha Brokers",
      kind: "refund",
      premiumMinor: -612_500,
      basePpm: 175_000,
      sharePpm: 450_000,
      batch: null,
      at: NOW - 3 * DAY + 12 * HOUR,
      payload: { reversalOf: "CDR-MOP-2512-551208", reason: "vehicle_not_delivered" }
    },
    {
      partnerName: "Alpha Brokers",
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: null,
      at: NOW - 1 * DAY + 15 * HOUR,
      payload: { line: "motor", vehicle: "Toyota Land Cruiser 2024", quoted: 648_000 }
    },
    {
      partnerName: "Meridian Bank",
      kind: "bind",
      premiumMinor: 745_000,
      basePpm: 125_000,
      sharePpm: 400_000,
      batch: null,
      at: NOW + 1 * DAY + 10 * HOUR,
      payload: { line: "motor", origin: "car_loan_checkout", policyRef: "CDR-MOT-2601-779442" }
    }
  ];

  it("writes exactly eight partner transactions", async () => {
    expect(await db.select().from(schema.orbitPartnerTxns)).toHaveLength(8);
  });

  it("every ts is distinct and ascending-sorts to the fixture's own chronology", async () => {
    const rows = await db.select().from(schema.orbitPartnerTxns).orderBy(asc(schema.orbitPartnerTxns.ts));
    expect(rows.map((r) => r.ts)).toEqual(expectedByTs.map((e) => e.at));
  });

  it("pins amountMinor, currency, revshareCalcMinor and payloadHash exactly, field by field, including the refund's negative sign", async () => {
    const rows = await db.select().from(schema.orbitPartnerTxns).orderBy(asc(schema.orbitPartnerTxns.ts));
    expect(rows).toHaveLength(expectedByTs.length);

    for (let i = 0; i < expectedByTs.length; i++) {
      const expected = expectedByTs[i]!;
      const row = rows[i]!;
      const partner = (
        await db.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.name, expected.partnerName))
      )[0]!;

      expect(row.partnerId).toBe(partner.id);
      expect(row.kind).toBe(expected.kind);
      expect(row.currency).toBe("AED");
      expect(row.settlementBatch).toBe(expected.batch);
      expect(row.ts).toBe(expected.at);

      // amountMinor is the raw signed premium, unmodified — including 0 and the
      // refund's negative value.
      expect(row.amountMinor).toBe(expected.premiumMinor);

      expect(row.payloadHash).toBe(await hash(expected.payload));

      // The production sign ternary, recomputed independently here (not copied
      // from orbit.ts): sign is -1 only when premiumMinor is strictly negative.
      const sign = expected.premiumMinor < 0 ? -1 : 1;
      const split = splitCommission({
        premiumMinor: Math.abs(expected.premiumMinor),
        baseCommissionPpm: expected.basePpm,
        channelSharePpm: expected.sharePpm
      });
      expect(row.revshareCalcMinor).toBe(sign * split.channelMinor);
    }
  });

  it("the refund row carries a negative revshareCalcMinor, mirroring its negative amountMinor", async () => {
    const rows = await db.select().from(schema.orbitPartnerTxns).where(eq(schema.orbitPartnerTxns.kind, "refund"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.amountMinor).toBeLessThan(0);
    expect(row.revshareCalcMinor).toBeLessThan(0);
    expect(row.amountMinor).toBe(-612_500);
    // Same split as the bind it reverses (same premium magnitude/ppm), just resigned.
    const split = splitCommission({ premiumMinor: 612_500, baseCommissionPpm: 175_000, channelSharePpm: 450_000 });
    expect(row.revshareCalcMinor).toBe(-split.channelMinor);
  });

  it("zero-premium quote rows settle to zero revshare regardless of sign", async () => {
    const rows = await db.select().from(schema.orbitPartnerTxns).where(eq(schema.orbitPartnerTxns.kind, "quote"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.amountMinor).toBe(0);
      expect(row.revshareCalcMinor).toBe(0);
    }
  });
});

// The routing engine (apps/api/src/engines/orbit-routing.ts) reads five tables
// that nothing used to write, so a freshly seeded tenant queued every
// conversation and routed none of them. These rows are that desk's roster.
describe("seedOrbit — routing tables", () => {
  it("gives the tenant one default team, reusing the core team ids the conversations already carry", async () => {
    const rows = await db.select().from(schema.orbitTeams).orderBy(asc(schema.orbitTeams.key));
    expect(rows.map((r) => r.key)).toEqual(["motor", "retention"]);
    expect(rows.map((r) => r.id)).toEqual([TEAMS.motor, TEAMS.retention]);
    expect(rows.filter((r) => r.isDefault).map((r) => r.key)).toEqual(["motor"]);
    for (const row of rows) {
      expect(row.tenantId).toBe(TENANT_ID);
      expect(row.status).toBe("active");
      expect(JSON.parse(row.nameJson)).toHaveProperty("en");
      expect(JSON.parse(row.nameJson)).toHaveProperty("ar");
    }
  });

  it("puts the three seeded agents on a team with skills the rules can require", async () => {
    const rows = await db.select().from(schema.orbitTeamMembers).orderBy(asc(schema.orbitTeamMembers.userId));
    expect(rows.map((r) => r.userId).sort()).toEqual([USER_IDS.agent, USER_IDS.partners, USER_IDS.retention].sort());

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(USER_IDS.agent)!.teamId).toBe(TEAMS.motor);
    expect(byUser.get(USER_IDS.retention)!.teamId).toBe(TEAMS.retention);
    // Sara takes the Arabic accident thread, so the skill she is picked on is real.
    expect(JSON.parse(byUser.get(USER_IDS.agent)!.skillsJson)).toContain("ar");
    for (const row of rows) expect(row.maxConcurrent).toBeGreaterThan(0);
  });

  it("marks the two agents holding open conversations available", async () => {
    const rows = await db.select().from(schema.orbitAgentPresence).orderBy(asc(schema.orbitAgentPresence.userId));
    const byUser = new Map(rows.map((r) => [r.userId, r.status]));
    expect(byUser.get(USER_IDS.agent)).toBe("available");
    expect(byUser.get(USER_IDS.retention)).toBe("available");
    // Dana's thread is with the partner desk, not the queue — she is off it.
    expect(byUser.get(USER_IDS.partners)).toBe("away");
    for (const row of rows) expect(row.updatedAt).toBeGreaterThan(0);
  });

  it("writes an SLA policy the conversations name", async () => {
    const rows = await db.select().from(schema.orbitSlaPolicies);
    expect(rows.map((r) => r.key)).toContain("standard");
    for (const row of rows) {
      expect(row.frtMinutes).toBeGreaterThan(0);
      expect(row.resolutionMinutes).toBeGreaterThan(row.frtMinutes);
    }
  });

  it("ends the rule list with a wildcard so nothing falls through unrouted", async () => {
    const rows = await db.select().from(schema.orbitRoutingRules).orderBy(asc(schema.orbitRoutingRules.seq));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.enabled)).toBe(true);
    // Every rule points at a team that exists.
    const teams = new Set((await db.select().from(schema.orbitTeams)).map((t) => t.id));
    for (const row of rows) expect(teams.has(row.teamId)).toBe(true);
    // The renewal desk is picked by intent before the catch-all.
    expect(JSON.parse(rows[0]!.conditionsJson)).toEqual({ intent: "renewal.offer" });
    expect(rows[0]!.teamId).toBe(TEAMS.retention);
    expect(JSON.parse(rows.at(-1)!.conditionsJson)).toEqual({});
  });
});
