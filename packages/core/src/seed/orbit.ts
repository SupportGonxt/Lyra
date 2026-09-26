import { id, schema } from "@lyra/db";
import { splitCommission } from "../commission.js";
import { canonicalJson, sha256Hex } from "../crypto.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { dayName } from "./period.js";

/** The frequency cap every seeded journey carries (ORB-051), and the one the resync backfills. */
export const SEED_JOURNEY_COOLDOWN_DAYS = 30;

// ORBIT is the service side of the same story the core seed tells: Rania Haddad
// bought motor cover on Cedar's row through the web channel, and last year's
// policy is still inside the renewal window. Everything here is one of the two
// conversations that produces — the customer desk talking to Rania, and the
// partner desk talking to Alpha Brokers — so the demo can be walked end to end
// instead of read table by table.
//
// `orbit_renewals` is deliberately absent: the scheduled sweep raises those rows
// from the policy book (apps/api/src/engines/renewals.ts) and seeding them by
// hand would collide with its per-policy unique index.

export async function seedOrbit(ctx: SeedContext): Promise<void> {
  const { db, tenantId, now } = ctx;
  const sara = `user:${ctx.users["orbit.agent"]!}`; // Sara Al Nasser, customer desk
  const yusuf = `user:${ctx.users["orbit.retention"]!}`; // Yusuf Karim, retention desk
  const dana = `user:${ctx.users["orbit.partners"]!}`; // Dana Aziz, partner desk

  // The tenant runs one ORBIT agent (`renewal`, autonomy suggest), so every
  // AI turn on this side is attributed to it — including the one on C3 that
  // answered an accident report as if it were a renewal question, which is
  // exactly what the failing QA score is about.
  const AGENT = "agent:renewal";

  /* ---- the "why" behind the ✦ ------------------------------------------
   * The UI renders the ✦ marker from a message's ai_audit_id and links it to
   * the audit row, so a drafted turn with a dangling id is a marker that leads
   * nowhere. These four rows are the model calls those turns actually made. */
  const audit = {
    outreach: id("aia", now + 1),
    quoteExplain: id("aia", now + 2),
    closingDraft: id("aia", now + 3),
    misfire: id("aia", now + 4)
  };
  const renewalWindow = ctx.now + 4 * DAY; // the retention desk works the book on day 4
  // The two dates the retention thread talks about, read off the policies
  // themselves so the conversation and the record never disagree.
  const coverEnds = dayName(now + 20 * DAY);
  const boughtOn = dayName(ctx.issuedAt);

  const hash = async (value: unknown): Promise<string> => sha256Hex(canonicalJson(value));

  await db.insert(schema.aiAuditLog).values([
    {
      id: audit.outreach,
      tenantId,
      module: "orbit",
      purpose: "orbit.renewal.draft_outreach",
      model: "@cf/meta/llama-3.1-8b-instruct",
      provider: "workers-ai",
      tier: "fast",
      inputHash: await hash({ policyRef: "CDR-MOT-2501-664118", churnScore: 61 }),
      outputHash: await hash({ variant: "hold_price_7d" }),
      tokensIn: 812,
      tokensOut: 96,
      costMicro: 1_400,
      latencyMs: 640,
      actorRef: yusuf,
      subjectRef: ctx.renewalPolicyId,
      outcome: "ok",
      ts: renewalWindow + 5 * MINUTE
    },
    {
      id: audit.quoteExplain,
      tenantId,
      module: "dist",
      purpose: "dist.quote.explain",
      model: "claude-3-5-haiku",
      provider: "anthropic",
      tier: "fast",
      inputHash: await hash({ quoteRequestId: ctx.quoteRequestId, question: "why_cheaper" }),
      outputHash: await hash({ compared: ["cedarMotor", "falconMotor"] }),
      tokensIn: 1_240,
      tokensOut: 188,
      costMicro: 2_100,
      latencyMs: 910,
      actorRef: sara,
      subjectRef: ctx.quoteRequestId,
      outcome: "ok",
      ts: now + 13 * MINUTE
    },
    {
      id: audit.closingDraft,
      tenantId,
      module: "orbit",
      purpose: "orbit.renewal.draft_reply",
      model: "@cf/meta/llama-3.1-8b-instruct",
      provider: "workers-ai",
      tier: "fast",
      inputHash: await hash({ policyRef: "CDR-MOT-2501-664118", outcome: "replaced", nbo: "motor_to_home" }),
      outputHash: await hash({ variant: "close_plus_home_offer" }),
      tokensIn: 1_460,
      tokensOut: 214,
      costMicro: 2_600,
      latencyMs: 780,
      actorRef: yusuf,
      subjectRef: ctx.renewalPolicyId,
      outcome: "ok",
      ts: renewalWindow + 1 * HOUR + 57 * MINUTE
    },
    {
      id: audit.misfire,
      tenantId,
      module: "orbit",
      purpose: "orbit.conversation.reply",
      model: "@cf/meta/llama-3.1-8b-instruct",
      provider: "workers-ai",
      tier: "fast",
      inputHash: await hash({ lang: "ar", intent: "claim.first_notice" }),
      outputHash: await hash({ variant: "renewal_selfserve_ar" }),
      tokensIn: 640,
      tokensOut: 121,
      costMicro: 1_100,
      latencyMs: 520,
      actorRef: AGENT,
      subjectRef: null,
      // The guardrail did fire — it just did not stop the send, which is the
      // finding the QA rubric records and the coaching note asks to fix.
      guardrailFlagsJson: JSON.stringify({ flags: ["intent_mismatch"], blocked: false }),
      outcome: "ok",
      ts: now - 2 * DAY + 9 * HOUR + 1 * MINUTE
    }
  ]);

  /* ---- conversations ---------------------------------------------------- */
  const conv = {
    renewal: id("cnv", now + 10),
    compare: id("cnv", now + 11),
    accidentAr: id("cnv", now + 12),
    documents: id("cnv", now + 13),
    broker: id("cnv", now + 14),
    callback: id("cnv", now + 15),
    faqAr: id("cnv", now + 16),
    certificate: id("cnv", now + 17),
    awaitingRating: id("cnv", now + 18)
  };

  /* ---- the desk itself --------------------------------------------------
   * engines/orbit-routing.ts routes on these five tables; without them a real
   * tenant queues every conversation and assigns none. The orbit team ids are
   * the core team ids on purpose — orbit_conversations.team_id is written by
   * the seed from ctx.teams and by the router from orbit_teams, and one id
   * keeps both readings of that column true. */
  await db.insert(schema.orbitTeams).values([
    {
      id: ctx.teams.motor,
      tenantId,
      key: "motor",
      nameJson: JSON.stringify({ en: "Motor desk", ar: "مكتب المركبات" }),
      isDefault: true, // the catch-all rule below points here
      createdAt: now,
      updatedAt: now
    },
    {
      id: ctx.teams.retention,
      tenantId,
      key: "retention",
      nameJson: JSON.stringify({ en: "Retention", ar: "الاحتفاظ بالعملاء" }),
      createdAt: now,
      updatedAt: now
    }
  ]);

  await db.insert(schema.orbitTeamMembers).values([
    {
      // Sara answers the Arabic accident thread, so "ar" is a skill she is
      // actually picked on, not decoration.
      id: id("tmm", now + 1),
      tenantId,
      teamId: ctx.teams.motor,
      userId: ctx.users["orbit.agent"]!,
      skillsJson: JSON.stringify(["motor", "ar"]),
      maxConcurrent: 6,
      createdAt: now
    },
    {
      id: id("tmm", now + 2),
      tenantId,
      teamId: ctx.teams.retention,
      userId: ctx.users["orbit.retention"]!,
      skillsJson: JSON.stringify(["renewal", "motor"]),
      maxConcurrent: 4,
      createdAt: now
    },
    {
      id: id("tmm", now + 3),
      tenantId,
      teamId: ctx.teams.motor,
      userId: ctx.users["orbit.partners"]!,
      skillsJson: JSON.stringify(["partner"]),
      maxConcurrent: 3,
      createdAt: now
    }
  ]);

  await db.insert(schema.orbitAgentPresence).values([
    { id: id("ap", now + 1), tenantId, userId: ctx.users["orbit.agent"]!, status: "available", updatedAt: now },
    { id: id("ap", now + 2), tenantId, userId: ctx.users["orbit.retention"]!, status: "available", updatedAt: now },
    // Dana works the partner desk, not the customer queue.
    { id: id("ap", now + 3), tenantId, userId: ctx.users["orbit.partners"]!, status: "away", updatedAt: now }
  ]);

  await db.insert(schema.orbitSlaPolicies).values([
    { id: id("slp", now + 1), tenantId, key: "standard", frtMinutes: 15, resolutionMinutes: 480, createdAt: now, updatedAt: now },
    { id: id("slp", now + 2), tenantId, key: "urgent", frtMinutes: 5, resolutionMinutes: 120, createdAt: now, updatedAt: now }
  ]);

  await db.insert(schema.orbitRoutingRules).values([
    {
      id: id("rr", now + 1),
      tenantId,
      teamId: ctx.teams.retention,
      seq: 1,
      conditionsJson: JSON.stringify({ intent: "renewal.offer" }),
      createdAt: now,
      updatedAt: now
    },
    {
      // Last rule wins nothing on its own — it is the wildcard that stops a
      // conversation sitting unrouted because no condition matched it.
      id: id("rr", now + 2),
      tenantId,
      teamId: ctx.teams.motor,
      seq: 2,
      conditionsJson: JSON.stringify({}),
      createdAt: now,
      updatedAt: now
    }
  ]);

  await db.insert(schema.orbitConversations).values([
    {
      // The thread the demo opens: proactive renewal outreach that turns into a
      // save, and ends on an AI draft nobody has approved yet.
      id: conv.renewal,
      tenantId,
      customerId: ctx.customerId,
      channel: "whatsapp",
      externalRef: "wa:971501234567",
      state: "human",
      assigneeRef: yusuf,
      teamId: ctx.teams.retention,
      summary: "Renewal outreach on CDR-MOT-2501-664118 — already replaced by a web sale; NCD confirmed.",
      lang: "en",
      intent: "renewal.offer",
      sentiment: 42,
      firstResponseMs: 5 * MINUTE,
      // The last dispatched turn. The draft that follows it has not left the
      // building, so it does not move the queue clock.
      lastMessageAt: renewalWindow + 1 * HOUR + 55 * MINUTE,
      createdAt: renewalWindow,
      updatedAt: renewalWindow + 1 * HOUR + 57 * MINUTE
    },
    {
      // Pre-sale: the conversation that ran alongside the quote comparison the
      // core seed wrote, which is why it closes with a 5 and no follow-up.
      id: conv.compare,
      tenantId,
      customerId: ctx.customerId,
      channel: "web",
      externalRef: "web:sess-2601-0417",
      state: "closed",
      assigneeRef: sara,
      teamId: ctx.teams.motor,
      csat: 5,
      summary: "Asked why Cedar undercut Falcon on the same cover; answered from the panel and bound the same day.",
      lang: "en",
      intent: "quote.compare",
      sentiment: 64,
      firstResponseMs: 1 * MINUTE,
      lastMessageAt: now + 13 * MINUTE,
      closedAt: now + 3 * HOUR,
      createdAt: now + 12 * MINUTE,
      updatedAt: now + 3 * HOUR
    },
    {
      // The one that went wrong: an Arabic first-notice-of-loss from a number
      // that is not on file, answered by the bot with renewal self-service copy.
      // It carries the AI handover note and the below-the-bar QA score.
      id: conv.accidentAr,
      tenantId,
      customerId: null,
      channel: "whatsapp",
      externalRef: "wa:971559876543",
      state: "human",
      assigneeRef: sara,
      teamId: ctx.teams.motor,
      summary: "بلاغ حادث بالعربية أجاب عنه الروبوت بمحتوى تجديد؛ حُوِّل إلى الفريق البشري.",
      lang: "ar",
      intent: "claim.first_notice",
      sentiment: -58,
      firstResponseMs: 1 * MINUTE,
      lastMessageAt: now - 2 * DAY + 9 * HOUR + 1 * MINUTE,
      createdAt: now - 2 * DAY + 9 * HOUR,
      updatedAt: now - 2 * DAY + 11 * HOUR
    },
    {
      // Still with the bot, waiting on an upload — the same wait that halts the
      // claim_document_chase journey run below.
      id: conv.documents,
      tenantId,
      customerId: ctx.customerId,
      channel: "email",
      externalRef: "email:thread-9f21",
      state: "bot",
      teamId: ctx.teams.motor,
      summary: "Chasing the Emirates ID copy needed to complete the motor file. Two reminders sent, no upload.",
      lang: "en",
      intent: "policy.document",
      sentiment: 4,
      firstResponseMs: 22 * MINUTE,
      lastMessageAt: now + 6 * DAY,
      createdAt: now + 3 * DAY,
      updatedAt: now + 6 * DAY
    },
    {
      // The b2b side of the desk: Alpha Brokers chasing a bind that failed in
      // their portal, which is the refunded partner transaction further down.
      id: conv.broker,
      tenantId,
      customerId: null,
      channel: "agent",
      externalRef: "portal:alpha-brokers",
      state: "human",
      assigneeRef: dana,
      summary: "Alpha Brokers asking why a bind reversed after issue and when the clawback settles.",
      lang: "en",
      intent: "partner.settlement",
      sentiment: -18,
      firstResponseMs: 47 * MINUTE,
      lastMessageAt: now - 3 * DAY + 14 * HOUR,
      createdAt: now - 3 * DAY + 13 * HOUR,
      updatedAt: now - 3 * DAY + 14 * HOUR
    },
    {
      // Last year's callback, kept so the customer's history is not one policy
      // deep — a 3 on CSAT is why retention, not sales, owns her this year.
      id: conv.callback,
      tenantId,
      customerId: ctx.customerId,
      channel: "voice",
      externalRef: "cc:call-77120",
      state: "closed",
      assigneeRef: yusuf,
      teamId: ctx.teams.retention,
      csat: 3,
      summary: "مكالمة عن قسط العام الماضي؛ طلبت معاودة الاتصال وتمت التسوية بخصم عدم المطالبة.",
      lang: "ar",
      intent: "renewal.callback",
      sentiment: -12,
      firstResponseMs: 9 * MINUTE,
      lastMessageAt: now - 30 * DAY + 11 * HOUR,
      closedAt: now - 30 * DAY + 12 * HOUR,
      createdAt: now - 30 * DAY + 10 * HOUR,
      updatedAt: now - 30 * DAY + 12 * HOUR
    },
    {
      // Contained by the bot, no human touched it — the containment rate has to
      // have something in it or the QA board reads as if the bot never wins.
      id: conv.faqAr,
      tenantId,
      customerId: null,
      channel: "web",
      externalRef: "web:sess-2512-8830",
      state: "bot",
      summary: "سؤال عن تغطية المساعدة على الطريق خارج الإمارات — أجاب المساعد الآلي دون تحويل.",
      lang: "ar",
      intent: "coverage.question",
      sentiment: 18,
      firstResponseMs: 40_000,
      lastMessageAt: now - 9 * DAY + 16 * HOUR,
      createdAt: now - 9 * DAY + 16 * HOUR,
      updatedAt: now - 9 * DAY + 16 * HOUR
    },
    {
      id: conv.certificate,
      tenantId,
      customerId: ctx.customerId,
      channel: "whatsapp",
      externalRef: "wa:971501234567:cert",
      state: "closed",
      teamId: ctx.teams.motor,
      csat: 5,
      summary: "Asked for the insurance certificate for the new motor policy; bot issued the PDF and closed.",
      lang: "en",
      intent: "policy.certificate",
      sentiment: 55,
      firstResponseMs: 35_000,
      lastMessageAt: ctx.issuedAt + 5 * HOUR,
      closedAt: ctx.issuedAt + 5 * HOUR + 10 * MINUTE,
      createdAt: ctx.issuedAt + 5 * HOUR,
      updatedAt: ctx.issuedAt + 5 * HOUR + 10 * MINUTE
    },
    {
      // Closed this morning and not yet rated: the rating request went out with
      // the closure and the customer has not tapped it. Every other closed
      // thread here carries its `csat`, which left the CSAT collection half of
      // orbit.md §5 with nothing to collect — J-C2's hosted page
      // (/portal/:tenantSlug/feedback/:id) has no conversation to offer and the
      // demo cannot walk the journey. This row is that conversation.
      id: conv.awaitingRating,
      tenantId,
      customerId: ctx.customerId,
      channel: "whatsapp",
      externalRef: "wa:971501234567:driver",
      state: "closed",
      assigneeRef: sara,
      teamId: ctx.teams.motor,
      summary: "Asked to add her husband as a named driver; endorsement priced and confirmed, thread closed.",
      lang: "en",
      intent: "policy.endorsement",
      sentiment: 38,
      firstResponseMs: 3 * MINUTE,
      lastMessageAt: now - 3 * HOUR,
      closedAt: now - 2 * HOUR,
      createdAt: now - 3 * HOUR - 20 * MINUTE,
      updatedAt: now - 2 * HOUR
    }
  ]);

  /* ---- messages ---------------------------------------------------------
   * Messages are append-only, so what is written here is what the thread will
   * always say. Three conversations get turns: the renewal thread the demo
   * walks, the pre-sale exchange it references, and the misfire QA flagged.
   * The rest carry their summary — an operator's queue is mostly threads they
   * have not opened. */
  await db.insert(schema.orbitMessages).values([
    {
      id: id("msg", renewalWindow + 1),
      tenantId,
      conversationId: conv.renewal,
      role: "system",
      content: `Renewal sweep raised CDR-MOT-2501-664118. Cover ends ${coverEnds}; retention owns the outreach.`,
      ts: renewalWindow
    },
    {
      id: id("msg", renewalWindow + 2),
      tenantId,
      conversationId: conv.renewal,
      role: "agent_ai",
      content:
        `Hello Rania — your motor cover CDR-MOT-2501-664118 ends on ${coverEnds}. I can hold your current price for seven days, or bring you three fresh quotes from the panel. Which would you prefer?`,
      aiAuditId: audit.outreach,
      deliveryStatus: "read",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA01",
      ts: renewalWindow + 5 * MINUTE
    },
    {
      id: id("msg", renewalWindow + 3),
      tenantId,
      conversationId: conv.renewal,
      role: "customer",
      content: "I already bought a new policy through your website last week. Do I still need to renew this one?",
      deliveryStatus: "read",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA02",
      ts: renewalWindow + 41 * MINUTE
    },
    {
      id: id("msg", renewalWindow + 4),
      tenantId,
      conversationId: conv.renewal,
      role: "agent_human",
      content:
        `You don't — the cover you bought on ${boughtOn} (CDR-MOT-2601-778201) starts before the old one ends, so we'll let CDR-MOT-2501-664118 run to its expiry date and close it there. Nothing to pay.`,
      deliveryStatus: "delivered",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA03",
      ts: renewalWindow + 46 * MINUTE
    },
    {
      id: id("msg", renewalWindow + 5),
      tenantId,
      conversationId: conv.renewal,
      role: "customer",
      content: "Good. One thing — does the no-claims discount from the old policy carry over to the new one?",
      deliveryStatus: "read",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA04",
      ts: renewalWindow + 1 * HOUR + 12 * MINUTE
    },
    {
      id: id("msg", renewalWindow + 6),
      tenantId,
      conversationId: conv.renewal,
      role: "agent_human",
      content:
        "Yes. Cedar carried your claim-free years across when the new policy was issued — it is already priced into the AED 4,125 you paid. I've noted it on the file so nobody asks you again.",
      deliveryStatus: "delivered",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA05",
      ts: renewalWindow + 1 * HOUR + 20 * MINUTE
    },
    {
      id: id("msg", renewalWindow + 7),
      tenantId,
      conversationId: conv.renewal,
      role: "customer",
      content: "Perfect, thank you. Let the old one lapse.",
      deliveryStatus: "read",
      externalRef: "wamid.HBgMOTcxNTAxMjM0NTY3AA06",
      ts: renewalWindow + 1 * HOUR + 55 * MINUTE
    },
    {
      // The trailing draft: last turn, agent_ai, no delivery status and an audit
      // id nothing has dispatched — the shape the thread route reads as "waiting
      // for a human to approve". It also carries the motor→home next-best-offer
      // the dist seed scored at 72, so approving it is a real decision.
      id: id("msg", renewalWindow + 8),
      tenantId,
      conversationId: conv.renewal,
      role: "agent_ai",
      content:
        "Thank you, Rania — I've closed the renewal on CDR-MOT-2501-664118 as replaced rather than lost, so your claim-free record stays unbroken. While I have your file open: you have no home cover with us. Would you like a quote from the same panel? Two minutes, no obligation.",
      aiAuditId: audit.closingDraft,
      ts: renewalWindow + 1 * HOUR + 57 * MINUTE
    },
    {
      id: id("msg", now + 20),
      tenantId,
      conversationId: conv.compare,
      role: "customer",
      content: "Why is the Cedar quote cheaper than Falcon when the cover looks the same to me?",
      deliveryStatus: "read",
      externalRef: "web:sess-2601-0417:1",
      ts: now + 12 * MINUTE
    },
    {
      id: id("msg", now + 21),
      tenantId,
      conversationId: conv.compare,
      role: "agent_ai",
      content:
        "They aren't quite the same. Cedar is AED 4,125 with a AED 1,000 excess and agency repair for the first year. Falcon is AED 4,480 at the same excess but adds off-road recovery, which is why it ranks higher on cover even though it costs more. Nothing else on the panel undercuts Cedar at this level.",
      aiAuditId: audit.quoteExplain,
      deliveryStatus: "delivered",
      externalRef: "web:sess-2601-0417:2",
      ts: now + 13 * MINUTE
    },
    {
      id: id("msg", now + 22),
      tenantId,
      conversationId: conv.accidentAr,
      role: "customer",
      content: "سيارتي تعرضت لحادث على شارع الشيخ زايد هذا الصباح. ماذا أفعل؟ الوثيقة باسم زوجي.",
      deliveryStatus: "read",
      externalRef: "wamid.HBgMOTcxNTU5ODc2NTQzAA01",
      ts: now - 2 * DAY + 9 * HOUR
    },
    {
      id: id("msg", now + 23),
      tenantId,
      conversationId: conv.accidentAr,
      role: "agent_ai",
      content:
        "يسعدني مساعدتك. يمكنك تجديد وثيقتك أو الحصول على عرض سعر جديد عبر موقعنا في أي وقت، وسيتم إرسال الوثيقة إليك مباشرة.",
      aiAuditId: audit.misfire,
      deliveryStatus: "delivered",
      externalRef: "wamid.HBgMOTcxNTU5ODc2NTQzAA02",
      ts: now - 2 * DAY + 9 * HOUR + 1 * MINUTE
    }
  ]);

  /* ---- the run behind the draft ------------------------------------------
   * The approve-a-draft surface reads the run to show confidence and evidence.
   * It is left `awaiting_approval` because the `renewal` agent's autonomy is
   * suggest — the draft cannot send itself (CLAUDE.md rule 4). */
  await db.insert(schema.aiRuns).values({
    id: id("run", renewalWindow + 9),
    tenantId,
    agentKey: "renewal",
    module: "orbit",
    purpose: "orbit.renewal.draft_reply",
    subjectRef: conv.renewal,
    actorRef: yusuf,
    autonomyLevel: "suggest",
    trigger: "event",
    state: "awaiting_approval",
    inputHash: await hash({ conversationId: conv.renewal, policyRef: "CDR-MOT-2501-664118" }),
    outputRef: audit.closingDraft,
    confidence: 78,
    evidenceJson: JSON.stringify([
      { kind: "policy", ref: ctx.renewalPolicyId, label: `CDR-MOT-2501-664118 expires ${coverEnds}` },
      { kind: "policy", ref: ctx.policyId, label: "CDR-MOT-2601-778201 already in force" },
      { kind: "nbo", ref: ctx.customerId, label: "motor → home, score 72" }
    ]),
    tokensIn: 1_460,
    tokensOut: 214,
    costMicro: 2_600,
    latencyMs: 780,
    startedAt: renewalWindow + 1 * HOUR + 56 * MINUTE,
    endedAt: renewalWindow + 1 * HOUR + 57 * MINUTE
  });

  /* ---- handover notes ---------------------------------------------------- */
  await db.insert(schema.orbitHandoverNotes).values([
    {
      // Written by the agent when it finally recognised the intent it had
      // already answered wrongly — accepted, which is how Sara ended up owning it.
      id: id("hnd", now + 30),
      tenantId,
      conversationId: conv.accidentAr,
      fromRef: AGENT,
      toRef: sara,
      summary:
        "Collision reported in Arabic on Sheikh Zayed Road this morning. Number is not on file and the caller says the policy is in her husband's name. Needs FNOL, not renewal.",
      factsJson: JSON.stringify({
        lang: "ar",
        msisdn: "+971559876543",
        matchedCustomer: null,
        statedPolicyholder: "spouse",
        location: "Sheikh Zayed Road",
        injuries: "unstated"
      }),
      generatedBy: "ai",
      acceptedBy: sara,
      ts: now - 2 * DAY + 9 * HOUR + 26 * MINUTE
    },
    {
      // Human to human: sales hands the renewal thread to retention rather than
      // letting the sweep call a customer who has already re-bought.
      id: id("hnd", now + 31),
      tenantId,
      conversationId: conv.renewal,
      fromRef: sara,
      toRef: yusuf,
      summary:
        `Rania re-bought on the web on ${boughtOn}. Treat CDR-MOT-2501-664118 as replaced, confirm the NCD carried, don't re-quote.`,
      factsJson: JSON.stringify({
        newPolicy: "CDR-MOT-2601-778201",
        expiringPolicy: "CDR-MOT-2501-664118",
        ncdYears: 2
      }),
      generatedBy: "human",
      acceptedBy: yusuf,
      ts: renewalWindow + 44 * MINUTE
    },
    {
      // Unaccepted on purpose: the partner desk queue needs one note still
      // waiting, or "accepted by" reads as a column that is always filled.
      id: id("hnd", now + 32),
      tenantId,
      conversationId: conv.broker,
      fromRef: AGENT,
      toRef: dana,
      summary:
        "Alpha Brokers bind PTX reversed after issue. Clawback lands in the next monthly batch (10th, net 15). They want a date, not an explanation.",
      factsJson: JSON.stringify({ partner: "Alpha Brokers", kind: "refund", settlement: "monthly/10/net15" }),
      generatedBy: "ai",
      ts: now - 3 * DAY + 13 * HOUR + 40 * MINUTE
    },
    {
      id: id("hnd", now + 33),
      tenantId,
      conversationId: conv.documents,
      fromRef: AGENT,
      toRef: `team:${ctx.teams.motor}`,
      summary:
        "Two document reminders sent, no upload. The chase journey has halted; a human needs to call before the file ages out.",
      factsJson: JSON.stringify({ reminders: 2, awaiting: "emirates_id", journey: "claim_document_chase" }),
      generatedBy: "ai",
      ts: now + 6 * DAY + 30 * MINUTE
    },
    {
      id: id("hnd", now + 34),
      tenantId,
      conversationId: conv.callback,
      fromRef: yusuf,
      toRef: sara,
      summary:
        "Callback closed with an NCD adjustment. She was unhappy about last year's increase — flag her file before any price rise.",
      generatedBy: "human",
      acceptedBy: sara,
      ts: now - 30 * DAY + 12 * HOUR
    }
  ]);

  /* ---- QA scores ---------------------------------------------------------
   * The bar the conversation view draws is 70. Two rows sit under it, and the
   * one that matters is scored twice: the agent flagged itself, Sara disputed
   * the number, and a human lead re-scored — which is the whole dispute loop
   * visible on one conversation. */
  await db.insert(schema.orbitQaScores).values([
    {
      id: id("qas", now + 40),
      tenantId,
      conversationId: conv.accidentAr,
      rubricKey: "orbit.escalation",
      score: 52,
      breakdownJson: JSON.stringify({
        empathy: 40,
        accuracy: 55,
        escalation: 20,
        language: 90,
        coaching:
          "An accident report is never answered with self-service copy. Hand over on the first FNOL cue and stay in the customer's language."
      }),
      flagsJson: JSON.stringify(["missed_escalation", "intent_mismatch", "fnol_unrecognised"]),
      scoredBy: "agent:qa",
      disputedBy: sara,
      ts: now - 2 * DAY + 12 * HOUR
    },
    {
      // The re-score after the dispute. Still under the bar — disputing a score
      // is not a way to pass.
      id: id("qas", now + 41),
      tenantId,
      conversationId: conv.accidentAr,
      rubricKey: "orbit.escalation",
      score: 61,
      breakdownJson: JSON.stringify({
        empathy: 55,
        accuracy: 60,
        escalation: 35,
        language: 95,
        coaching: "Handover was correct once raised, but 26 minutes late. Credit for the Arabic, not for the delay."
      }),
      flagsJson: JSON.stringify(["missed_escalation"]),
      scoredBy: yusuf,
      ts: now - 2 * DAY + 15 * HOUR
    },
    {
      id: id("qas", now + 42),
      tenantId,
      conversationId: conv.renewal,
      rubricKey: "orbit.retention_call",
      score: 88,
      breakdownJson: JSON.stringify({
        discovery: 90,
        accuracy: 95,
        objection_handling: 80,
        coaching: "Saved the relationship without re-quoting. Could have asked for the home cover in the same breath."
      }),
      scoredBy: "agent:qa",
      ts: renewalWindow + 4 * HOUR
    },
    {
      id: id("qas", now + 43),
      tenantId,
      conversationId: conv.compare,
      rubricKey: "orbit.sales_conduct",
      score: 92,
      breakdownJson: JSON.stringify({
        disclosure: 95,
        comparison_fairness: 90,
        pressure: 100,
        coaching: "Named the trade-off instead of the cheapest price. Keep it."
      }),
      scoredBy: yusuf,
      ts: now + 4 * HOUR
    },
    {
      id: id("qas", now + 44),
      tenantId,
      conversationId: conv.faqAr,
      rubricKey: "orbit.bot_containment",
      score: 76,
      breakdownJson: JSON.stringify({
        resolution: 80,
        language: 85,
        handover_judgement: 65,
        coaching: "Answered correctly and contained. Should have offered a human once the question turned to exclusions."
      }),
      scoredBy: "agent:qa",
      ts: now - 9 * DAY + 18 * HOUR
    },
    {
      id: id("qas", now + 45),
      tenantId,
      conversationId: conv.broker,
      rubricKey: "orbit.partner_support",
      score: 66,
      breakdownJson: JSON.stringify({
        accuracy: 75,
        commitment: 45,
        tone: 80,
        coaching: "The broker asked when, and got how. Give a settlement date or say you will find one."
      }),
      flagsJson: JSON.stringify(["no_commitment_given"]),
      scoredBy: "agent:qa",
      ts: now - 3 * DAY + 17 * HOUR
    }
  ]);

  /* ---- journeys ----------------------------------------------------------
   * Graphs are deliberately small: enough nodes for the canvas to draw and for
   * a run to sit on one, not a real production flow. */
  // ORB-051: every journey carries a frequency cap — `triggerJourney` refuses a
  // graph without one, so a seeded journey missing it could never enrol anyone.
  const graph = (nodes: { key: string; type: string; [k: string]: unknown }[]): string =>
    JSON.stringify({
      cooldownDays: SEED_JOURNEY_COOLDOWN_DAYS,
      nodes,
      edges: nodes.slice(0, -1).map((n, i) => ({ from: n.key, to: nodes[i + 1]!.key }))
    });

  const jrn = {
    renewalV1: id("jrn", now + 50),
    renewalV2: id("jrn", now + 51),
    onboarding: id("jrn", now + 52),
    documents: id("jrn", now + 53),
    winback: id("jrn", now + 54),
    brokerActivation: id("jrn", now + 55)
  };

  await db.insert(schema.orbitJourneys).values([
    {
      // v1 is retired rather than deleted: a run still points at it, and the
      // audit trail of what a customer was actually walked through has to survive
      // the redesign.
      id: jrn.renewalV1,
      tenantId,
      key: "renewal_45d",
      version: 1,
      nameJson: JSON.stringify({ en: "Renewal — 45 days", ar: "التجديد — ٤٥ يومًا" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "orbit.renewal.due" },
        { key: "email_offer", type: "message", channel: "email" },
        { key: "wait_7d", type: "wait", days: 7 },
        { key: "call", type: "task", team: "retention" },
        { key: "end", type: "end" }
      ]),
      status: "retired",
      createdBy: ctx.users["orbit.retention"]!,
      createdAt: now - 300 * DAY
    },
    {
      id: jrn.renewalV2,
      tenantId,
      key: "renewal_45d",
      version: 2,
      nameJson: JSON.stringify({ en: "Renewal — 45 days", ar: "التجديد — ٤٥ يومًا" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "orbit.renewal.due" },
        { key: "score_churn", type: "agent", agent: "renewal" },
        { key: "draft_offer", type: "agent", agent: "renewal", approval: "orbit.outbound_send" },
        { key: "wait_5d", type: "wait", days: 5 },
        { key: "call", type: "task", team: "retention" },
        { key: "end", type: "end" }
      ]),
      status: "active",
      createdBy: ctx.users["orbit.retention"]!,
      createdAt: now - 40 * DAY
    },
    {
      id: jrn.onboarding,
      tenantId,
      key: "onboarding_new_policy",
      version: 1,
      nameJson: JSON.stringify({ en: "New policy welcome", ar: "الترحيب بالوثيقة الجديدة" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "axis.policy.issued" },
        { key: "send_documents", type: "message", channel: "email" },
        { key: "wait_2d", type: "wait", days: 2 },
        { key: "csat", type: "survey" },
        { key: "end", type: "end" }
      ]),
      status: "active",
      createdBy: ctx.users["orbit.agent"]!,
      createdAt: now - 120 * DAY
    },
    {
      // Paused while the reminder copy is rewritten — the halted run below is
      // stuck inside it, which is why nobody has restarted it.
      id: jrn.documents,
      tenantId,
      key: "document_chase",
      version: 1,
      nameJson: JSON.stringify({ en: "Missing document chase", ar: "متابعة المستندات الناقصة" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "orbit.conversation.document" },
        { key: "remind_1", type: "message", channel: "email" },
        { key: "wait_3d", type: "wait", days: 3 },
        { key: "remind_2", type: "message", channel: "whatsapp" },
        { key: "escalate", type: "task", team: "motor" },
        { key: "end", type: "end" }
      ]),
      status: "paused",
      createdBy: ctx.users["orbit.agent"]!,
      createdAt: now - 80 * DAY
    },
    {
      id: jrn.winback,
      tenantId,
      key: "winback_lapsed",
      version: 1,
      nameJson: JSON.stringify({ en: "Win back lapsed cover", ar: "استعادة التغطية المنتهية" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "orbit.renewal.lost" },
        { key: "wait_30d", type: "wait", days: 30 },
        { key: "offer", type: "agent", agent: "renewal", approval: "orbit.outbound_send" },
        { key: "end", type: "end" }
      ]),
      status: "draft",
      createdBy: ctx.users["orbit.retention"]!,
      createdAt: now - 6 * DAY
    },
    {
      id: jrn.brokerActivation,
      tenantId,
      key: "broker_activation",
      version: 1,
      nameJson: JSON.stringify({ en: "Partner activation", ar: "تفعيل الشريك" }),
      graphJson: graph([
        { key: "start", type: "trigger", on: "orbit.partner.stage_changed" },
        { key: "sandbox_keys", type: "task", team: "partners" },
        { key: "first_quote", type: "wait_for", event: "orbit.partner.quote" },
        { key: "go_live", type: "task", team: "partners" },
        { key: "end", type: "end" }
      ]),
      status: "active",
      createdBy: ctx.users["orbit.partners"]!,
      createdAt: now - 200 * DAY
    }
  ]);

  /* ---- journey runs ------------------------------------------------------
   * A run is unique per (journey, customer) and customer_id is required, so all
   * five belong to Rania — she is the only customer the core seed writes. */
  await db.insert(schema.orbitJourneyRuns).values([
    {
      id: id("jrr", now + 60),
      tenantId,
      journeyId: jrn.renewalV2,
      customerId: ctx.customerId,
      node: "wait_5d",
      state: "waiting",
      contextJson: JSON.stringify({
        policyRef: "CDR-MOT-2501-664118",
        churnScore: 61,
        conversationId: conv.renewal,
        draftAwaitingApproval: true
      }),
      nextAt: renewalWindow + 5 * DAY,
      createdAt: renewalWindow,
      updatedAt: renewalWindow + 1 * HOUR + 57 * MINUTE
    },
    {
      id: id("jrr", now + 61),
      tenantId,
      journeyId: jrn.onboarding,
      customerId: ctx.customerId,
      node: "end",
      state: "done",
      contextJson: JSON.stringify({ policyRef: "CDR-MOT-2601-778201", csat: 5 }),
      createdAt: ctx.issuedAt,
      updatedAt: ctx.issuedAt + 2 * DAY
    },
    {
      // The failed step: the second reminder could not be sent because the
      // WhatsApp template was rejected, so the run halted instead of skipping a
      // customer touch and pretending the chase continued.
      id: id("jrr", now + 62),
      tenantId,
      journeyId: jrn.documents,
      customerId: ctx.customerId,
      node: "remind_2",
      state: "halted",
      contextJson: JSON.stringify({
        awaiting: "emirates_id",
        conversationId: conv.documents,
        attempts: 2,
        error: { code: "channel.template_rejected", node: "remind_2", at: now + 6 * DAY },
        resumeRequires: "approved WhatsApp template or a manual call"
      }),
      createdAt: now + 3 * DAY,
      updatedAt: now + 6 * DAY
    },
    {
      id: id("jrr", now + 63),
      tenantId,
      journeyId: jrn.winback,
      customerId: ctx.customerId,
      node: "wait_30d",
      state: "running",
      contextJson: JSON.stringify({ enrolledFor: "home", reason: "no home cover on file" }),
      nextAt: now + 30 * DAY,
      createdAt: now,
      updatedAt: now
    },
    {
      // Left on the retired version: a completed run is history and does not get
      // migrated to v2.
      id: id("jrr", now + 64),
      tenantId,
      journeyId: jrn.renewalV1,
      customerId: ctx.customerId,
      node: "end",
      state: "done",
      contextJson: JSON.stringify({ policyRef: "CDR-MOT-2401-551903", outcome: "renewed" }),
      createdAt: now - 380 * DAY,
      updatedAt: now - 350 * DAY
    }
  ]);

  /* ---- partners ----------------------------------------------------------
   * Alpha Brokers is the same counterparty as the `alpha-brokers` distribution
   * channel — the partner row is the relationship, the channel row is how the
   * business it writes is priced, and the rates below repeat the channel's so
   * the partner statement and the commission engine agree.
   * `kind` has no broker slot yet (docs/16 reserved enum), so a motor broker
   * files under `auto` rather than inventing a value the API would reject. */
  const ptn = {
    alpha: id("ptn", now + 70),
    meridian: id("ptn", now + 71),
    telco: id("ptn", now + 72),
    superapp: id("ptn", now + 73),
    autoMall: id("ptn", now + 74)
  };

  await db.insert(schema.orbitPartners).values([
    {
      id: ptn.alpha,
      tenantId,
      name: "Alpha Brokers",
      kind: "auto",
      apiKeyRef: "alpha-brokers-live",
      revshareJson: JSON.stringify({
        channelId: ctx.channels.brokerAlpha,
        defaultSharePpm: 300_000,
        overrides: [
          { line: "motor", sharePpm: 350_000 },
          { offering: "cedar_motor_plus", sharePpm: 450_000 },
          { line: "health", sharePpm: 250_000, flatFeeMinor: 2_500 }
        ],
        settlement: { frequency: "monthly", dayOfMonth: 10, netDays: 15, minPayoutMinor: 50_000 }
      }),
      sandboxFlag: false,
      status: "active",
      contactJson: JSON.stringify({
        name: "Layla Mansour",
        email: "layla@alphabrokers.ae",
        phone: "+97142223300",
        ownerRef: dana
      }),
      createdAt: now - 400 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: ptn.meridian,
      tenantId,
      name: "Meridian Bank",
      kind: "bank",
      apiKeyRef: "meridian-embed-live",
      revshareJson: JSON.stringify({
        channelId: ctx.channels.bankEmbed,
        defaultSharePpm: 400_000,
        settlement: { frequency: "monthly", dayOfMonth: 10, netDays: 30, minPayoutMinor: 100_000 }
      }),
      sandboxFlag: false,
      status: "active",
      contactJson: JSON.stringify({ name: "Omar Fadel", email: "omar.fadel@meridian.ae", ownerRef: dana }),
      createdAt: now - 260 * DAY,
      updatedAt: now - 12 * DAY
    },
    {
      // Waiting on the `dist.partner_activate` approval — creating a partner
      // does not switch one on.
      id: ptn.telco,
      tenantId,
      name: "Etisalat Mobility",
      kind: "telco",
      revshareJson: JSON.stringify({ defaultSharePpm: 200_000 }),
      sandboxFlag: true,
      status: "pending",
      contactJson: JSON.stringify({ name: "Hessa Al Zaabi", email: "partners@etisalat-mobility.ae" }),
      createdAt: now - 21 * DAY,
      updatedAt: now - 21 * DAY
    },
    {
      id: ptn.superapp,
      tenantId,
      name: "Careem Everything",
      kind: "superapp",
      apiKeyRef: "careem-sandbox",
      revshareJson: JSON.stringify({ defaultSharePpm: 275_000 }),
      sandboxFlag: true,
      status: "active",
      contactJson: JSON.stringify({ name: "Zaid Rahmani", email: "insurance@careem.com", ownerRef: dana }),
      createdAt: now - 60 * DAY,
      updatedAt: now - 5 * DAY
    },
    {
      // Suspended, not deleted: their historic transactions still have to settle.
      id: ptn.autoMall,
      tenantId,
      name: "Gulf Auto Mall",
      kind: "auto",
      sandboxFlag: false,
      status: "suspended",
      contactJson: JSON.stringify({ name: "Faisal Nour", email: "faisal@gulfautomall.ae" }),
      createdAt: now - 500 * DAY,
      updatedAt: now - 45 * DAY
    }
  ]);

  /* ---- partner transactions ---------------------------------------------
   * Revshare is computed with the same splitCommission the settlement engine
   * uses, so the demo numbers survive being recalculated.
   * `txn_ref` stays null: it points at a ledger transaction, and no journal has
   * been posted for these — pointing at an id the ledger does not have would be
   * worse than an empty column. */
  const txnSpecs: {
    partnerId: string;
    kind: string;
    premiumMinor: number;
    basePpm: number;
    sharePpm: number;
    batch: string | null;
    at: number;
    payload: unknown;
  }[] = [
    {
      partnerId: ptn.alpha,
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: null,
      at: now - 26 * DAY + 10 * HOUR,
      payload: { line: "motor", vehicle: "Nissan Patrol 2022", quoted: 5_120_00 }
    },
    {
      partnerId: ptn.alpha,
      kind: "bind",
      premiumMinor: 486_000,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: "ALPHA-2512",
      at: now - 25 * DAY + 11 * HOUR,
      payload: { line: "motor", offering: "cedar_motor", policyRef: "CDR-MOT-2512-551140" }
    },
    {
      partnerId: ptn.alpha,
      kind: "bind",
      premiumMinor: 612_500,
      basePpm: 175_000,
      sharePpm: 450_000,
      batch: "ALPHA-2512",
      at: now - 22 * DAY + 9 * HOUR,
      payload: { line: "motor", offering: "cedar_motor_plus", policyRef: "CDR-MOP-2512-551208" }
    },
    {
      // The reversal Alpha is chasing on the partner conversation: the same
      // split run backwards, so the clawback matches what was paid out.
      partnerId: ptn.alpha,
      kind: "refund",
      premiumMinor: -612_500,
      basePpm: 175_000,
      sharePpm: 450_000,
      batch: null,
      at: now - 3 * DAY + 12 * HOUR,
      payload: { reversalOf: "CDR-MOP-2512-551208", reason: "vehicle_not_delivered" }
    },
    {
      partnerId: ptn.alpha,
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 350_000,
      batch: null,
      at: now - 1 * DAY + 15 * HOUR,
      payload: { line: "motor", vehicle: "Toyota Land Cruiser 2024", quoted: 6_480_00 }
    },
    {
      partnerId: ptn.meridian,
      kind: "bind",
      premiumMinor: 398_000,
      basePpm: 125_000,
      sharePpm: 400_000,
      batch: "MERIDIAN-2512",
      at: now - 20 * DAY + 8 * HOUR,
      payload: { line: "motor", origin: "car_loan_checkout", policyRef: "CDR-MOT-2512-548019" }
    },
    {
      partnerId: ptn.meridian,
      kind: "bind",
      premiumMinor: 745_000,
      basePpm: 125_000,
      sharePpm: 400_000,
      batch: null, // current period, not settled yet
      at: now + 1 * DAY + 10 * HOUR,
      payload: { line: "motor", origin: "car_loan_checkout", policyRef: "CDR-MOT-2601-779442" }
    },
    {
      // Sandbox traffic still writes a transaction; it just never settles.
      partnerId: ptn.superapp,
      kind: "quote",
      premiumMinor: 0,
      basePpm: 125_000,
      sharePpm: 275_000,
      batch: null,
      at: now - 5 * DAY + 19 * HOUR,
      payload: { line: "motor", sandbox: true, quoted: 3_990_00 }
    }
  ];

  const txnRows: (typeof schema.orbitPartnerTxns.$inferInsert)[] = [];
  for (const [i, spec] of txnSpecs.entries()) {
    const sign = spec.premiumMinor < 0 ? -1 : 1;
    const split = splitCommission({
      premiumMinor: Math.abs(spec.premiumMinor),
      baseCommissionPpm: spec.basePpm,
      channelSharePpm: spec.sharePpm
    });
    txnRows.push({
      id: id("ptx", now + 80 + i),
      tenantId,
      partnerId: spec.partnerId,
      kind: spec.kind,
      payloadHash: await hash(spec.payload),
      amountMinor: spec.premiumMinor,
      currency: "AED",
      revshareCalcMinor: sign * split.channelMinor,
      settlementBatch: spec.batch,
      ts: spec.at
    });
  }
  await db.insert(schema.orbitPartnerTxns).values(txnRows);
}
