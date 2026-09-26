import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  assertChannel,
  audit,
  checkOutreachDraft,
  emit,
  gate,
  inQuietHours,
  AppError,
  type Ctx
} from "@lyra/core";
import { promptNouns, type Gateway, type PromptNouns } from "@lyra/model-gateway";
import { recordTouch } from "./signal-attribution.js";
import { markProspectsContacted } from "./signal-prospects.js";
import { recordResponse } from "./signal-responses.js";

// The send half of the publish loop (docs/27: "Content generation without the
// publish loop it advertises"). SIGNAL could draft compliant ar/en creative but
// nothing ever delivered it to a person — and `signal_attribution_events` had
// no `lead` writer either, so the funnel's middle was a dead seam and the bind
// loop-back (`onBindIssued`) had nothing to credit. This engine is both:
//
//   draft → consent gate → approval gate → send → lead touch → (AXIS bind)
//         → autopilot CAC window sees the channel → budget moves.
//
// Channels are the three that carry acquisition in the Gulf: email, WhatsApp
// and SMS (docs/modules/signal.md §2.1 lists WhatsApp templates as first-class;
// Snapchat/TikTok reach is paid-media, already covered by campaign channels).
// Every hop is inspectable: the drafted text carries ✦ provenance via its
// ai_audit_id, the consent check is `assertChannel(marketing)` at runtime, the
// send itself is consequential (CLAUDE.md §4) and gates on
// `signal.outreach_send`, and the lead touch is what lets NORTH and the
// cockpit say "SIGNAL bought this customer" with a row to point at.

export const OUTREACH_CHANNEL = ["email", "whatsapp", "sms"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNEL)[number];

/** Per-recipient weekly cap — mirrors the seed guardrail's frequencyCapPerWeek
 *  default so an engine default and a tenant guardrail agree out of the box. */
const FREQUENCY_CAP_PER_WEEK = 2;

const WEEK_MS = 7 * 86_400_000;

/** A live acquisition campaign eligible for outreach. */
export interface OutreachCampaign {
  id: string;
  name: string;
  audienceId: string | null;
}

/** One recipient the sweep will draft for. */
interface Recipient {
  customerId: string;
  /** First channel opt-in that also has marketing purpose — checked again at
   *  send time; this only picks who to consider. */
  channel: OutreachChannel;
  address: string | null;
}

/**
 * Live acquisition campaigns for a tenant. `objective: "acq"` only — renewal
 * and cross-sell outreach belongs to ORBIT's journeys, which already own their
 * consent and cadence; two engines sending to one inbox is how frequency caps
 * get broken by arithmetic neither side sees.
 */
export async function acquisitionCampaigns(ctx: Ctx): Promise<OutreachCampaign[]> {
  return ctx.db
    .select({ id: schema.signalCampaigns.id, name: schema.signalCampaigns.name, audienceId: schema.signalCampaigns.audienceId })
    .from(schema.signalCampaigns)
    .where(
      and(
        eq(schema.signalCampaigns.tenantId, ctx.tenantId),
        eq(schema.signalCampaigns.objective, "acq"),
        eq(schema.signalCampaigns.state, "live"),
        isNull(schema.signalCampaigns.deletedAt)
      )
    );
}

/**
 * Audience members with a contactable channel. Consent-aware by construction:
 * the audience rule resolves members, then each member's latest consent row
 * must carry marketing purpose AND the channel opt-in the message would use.
 * A member with no qualifying channel is skipped, not errored — suppression is
 * the normal case, not an exception.
 */
export async function recipientsFor(ctx: Ctx, campaign: OutreachCampaign): Promise<Recipient[]> {
  if (!campaign.audienceId) return [];
  const members = await audienceMemberIds(ctx, campaign.audienceId);
  if (!members.length) return [];

  // Every member's latest consent, in chunks: D1 binds at most 100 parameters
  // per statement, and the max(ts) subquery picks each customer's newest row.
  const consents: (typeof schema.consents.$inferSelect)[] = [];
  for (let i = 0; i < members.length; i += CHUNK) {
    consents.push(
      ...(await ctx.db
        .select()
        .from(schema.consents)
        .where(
          and(
            eq(schema.consents.tenantId, ctx.tenantId),
            inArray(schema.consents.customerId, members.slice(i, i + CHUNK)),
            sql`${schema.consents.ts} = (select max(c2.ts) from ${schema.consents} c2 where c2.customer_id = ${schema.consents.customerId} and c2.tenant_id = ${schema.consents.tenantId})`
          )
        ))
    );
  }
  const consentByCustomer = new Map(consents.map((c) => [c.customerId, c]));

  const out: Recipient[] = [];
  for (const customerId of members) {
    const consent = consentByCustomer.get(customerId);
    if (!consent) continue;
    let purposes: { marketing?: boolean } = {};
    let channels: Record<string, boolean> = {};
    try {
      purposes = JSON.parse(consent.purposesJson) as { marketing?: boolean };
      channels = JSON.parse(consent.channelOptinsJson) as Record<string, boolean>;
    } catch {
      continue;
    }
    if (purposes.marketing !== true) continue;
    // Preference order: WhatsApp dominates response rates in the Gulf, then
    // SMS, then email. The first opted-in channel wins; the runtime gate
    // re-checks before anything is sent.
    const channel = (["whatsapp", "sms", "email"] as const).find((c) => channels[c] === true);
    if (!channel) continue;
    out.push({ customerId, channel, address: null });
  }
  return out;
}

const CHUNK = 90;
const PAGE = 500;

type Leaf = { field: string; op: string; value: unknown };

/** Reasons outreach may act on. Churn risk is a renewal, and renewals are ORBIT's journeys. */
const OUTREACH_REASONS = ["quote_expired", "no_policy"];

/**
 * Why the resolver cannot run this rule, or null when it can. An unrunnable
 * rule used to resolve to nobody at send time, silently; now it is refused
 * when a person writes it (ADR-0091).
 */
export function audienceRuleProblem(def: unknown): string | null {
  const leaves = collectLeaves(def);
  if (!leaves.length) return "no rule: add a tag or a prospect reason";
  for (const l of leaves) {
    if (l.field === "tagsJson" && l.op === "contains" && typeof l.value === "string") continue;
    if (l.field === "prospect.score" && l.op === "gte" && typeof l.value === "number") continue;
    if (l.field === "prospect.reason" && l.op === "eq") {
      if (l.value === "churn_risk") return "churn risk is reached by ORBIT's renewal journeys, not by acquisition outreach";
      if (OUTREACH_REASONS.includes(l.value as string)) continue;
    }
    // Suppression's own rule: it excludes, it is never sent to.
    if (l.field === "consent.marketing" && l.op === "eq" && l.value === false) continue;
    return `cannot resolve ${l.field} ${l.op}`;
  }
  if (leaves.some((l) => l.field === "prospect.score") && !leaves.some((l) => l.field === "prospect.reason")) {
    return "a prospect score needs a prospect reason";
  }
  return null;
}

/** Resolve an audience definition's member ids: tag leaves over customers,
 *  prospect leaves over SIGNAL's own prospects, intersected under `all` and
 *  joined under `any`. Anything else resolves to nobody — fail closed. */
async function audienceMemberIds(ctx: Ctx, audienceId: string): Promise<string[]> {
  const [audience] = await ctx.db
    .select()
    .from(schema.signalAudiences)
    .where(and(eq(schema.signalAudiences.tenantId, ctx.tenantId), eq(schema.signalAudiences.id, audienceId)))
    .limit(1);
  if (!audience) return [];
  let def: unknown;
  try {
    def = JSON.parse(audience.definitionJson);
  } catch {
    return [];
  }
  if (audienceRuleProblem(def) !== null) return [];
  const leaves = collectLeaves(def);
  const any = Array.isArray((def as { any?: unknown }).any);

  const sets: Set<string>[] = [];
  for (const tag of leaves.filter((l) => l.field === "tagsJson")) {
    sets.push(
      await paged((offset) =>
        ctx.db
          .select({ id: schema.customers.id })
          .from(schema.customers)
          .where(and(eq(schema.customers.tenantId, ctx.tenantId), isNull(schema.customers.deletedAt), sql`${schema.customers.tagsJson} like ${`%${tag.value}%`}`))
          .orderBy(schema.customers.id)
          .limit(PAGE)
          .offset(offset)
      )
    );
  }
  const reason = leaves.find((l) => l.field === "prospect.reason");
  if (reason) {
    const floor = leaves.find((l) => l.field === "prospect.score")?.value as number | undefined;
    sets.push(
      await paged((offset) =>
        ctx.db
          .select({ id: schema.signalProspects.customerId })
          .from(schema.signalProspects)
          .where(
            and(
              eq(schema.signalProspects.tenantId, ctx.tenantId),
              eq(schema.signalProspects.reason, reason.value as string),
              inArray(schema.signalProspects.state, ["open", "contacted"]),
              floor === undefined ? undefined : gte(schema.signalProspects.score, floor)
            )
          )
          .orderBy(schema.signalProspects.customerId)
          .limit(PAGE)
          .offset(offset)
      )
    );
  }
  if (!sets.length) return [];
  const [first, ...rest] = sets;
  const out = any
    ? new Set(sets.flatMap((x) => [...x]))
    : new Set([...first!].filter((id) => rest.every((x) => x.has(id))));
  return [...out];
}

async function paged(page: (offset: number) => Promise<{ id: string }[]>): Promise<Set<string>> {
  const out = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const rows = await page(offset);
    for (const r of rows) out.add(r.id);
    if (rows.length < PAGE) return out;
  }
}

function collectLeaves(node: unknown): Leaf[] {
  if (!node || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  if (typeof o.field === "string" && typeof o.op === "string") {
    return [{ field: o.field, op: o.op, value: o.value }];
  }
  const inner = Array.isArray(o.all) ? o.all : Array.isArray(o.any) ? o.any : [];
  return inner.flatMap(collectLeaves);
}

/**
 * Frequency cap: how many outreach sends this customer has already received
 * across ALL campaigns in the trailing week. Cross-campaign by design — a cap
 * counted per campaign is not a cap, it is multiplication.
 */
export async function recentSendCount(ctx: Ctx, customerId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.signalOutreach)
    .where(
      and(
        eq(schema.signalOutreach.tenantId, ctx.tenantId),
        eq(schema.signalOutreach.customerId, customerId),
        gte(schema.signalOutreach.ts, ctx.now - WEEK_MS)
      )
    );
  return row?.n ?? 0;
}

/**
 * Quiet hours moved to packages/core (`quiet-hours.ts`) when ORBIT's journey
 * engine needed the same floor: two modules reaching the same window makes it
 * a core concern, and importing it from here would be exactly the cross-module
 * import CLAUDE.md rule 6 forbids. Re-exported so this module's callers and
 * its own tests keep one name for it.
 */
export { inQuietHours } from "@lyra/core";

export interface DraftedOutreach {
  customerId: string;
  channel: OutreachChannel;
  text: string;
  locale: "en" | "ar";
  complianceStatus: "passed" | "flagged";
  aiAuditId: string | null;
}

/**
 * Draft one message per recipient from the campaign's winning creative, in the
 * recipient's own language, through the gateway (CLAUDE.md rule 3). The model
 * personalises the campaign's approved copy; it never invents a price, a
 * discount or a coverage promise — the reply is groundedness-checked against
 * the evidence lines and compliance-checked like any other creative, and a
 * flagged or ungrounded draft is dropped rather than queued.
 */
export async function draftOutreach(
  ctx: Ctx,
  gateway: Gateway,
  campaign: OutreachCampaign,
  recipient: Recipient,
  creativeText: string,
  nouns: PromptNouns
): Promise<DraftedOutreach | null> {
  const [customer] = await ctx.db
    .select({ nameJson: schema.customers.nameJson, locale: schema.customers.locale })
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, recipient.customerId)))
    .limit(1);
  const locale: "en" | "ar" = customer?.locale === "ar" || ctx.locale === "ar" ? "ar" : "en";
  const name = firstName(customer?.nameJson);

  const why = await prospectReason(ctx, recipient.customerId, nouns);
  const evidenceLines = [
    `Campaign: ${campaign.name}`,
    `Approved copy to personalise: ${creativeText}`,
    `Recipient first name: ${name ?? "unknown"}`,
    ...(why ? [`Why this person: ${why}`] : []),
    `Channel: ${recipient.channel}`,
    `Language: ${locale === "ar" ? "Arabic" : "English"}`
  ];

  try {
    const res = await gateway.complete(ctx, {
      module: "signal",
      purpose: "outreach.draft",
      tier: "fast",
      subjectRef: `signal_campaign:${campaign.id}`,
      locale,
      messages: [
        {
          role: "system",
          content:
            `You write one short ${recipient.channel} acquisition message for a ${nouns.domain} brand, in ${locale === "ar" ? "Arabic" : "English"}, addressed to ${name ?? "the recipient"} by first name. ` +
            "Personalise the approved copy below — do not invent prices, discounts, deadlines or coverage promises. " +
            "If a reason is given for writing to this person, acknowledge it plainly and state no fact beyond it. " +
            "No superlatives against the market, no guarantees of acceptance. Under 90 words. Reply with the message text only."
        },
        { role: "user", content: evidenceLines.join("\n") }
      ]
    });

    const text = res.text.trim();
    if (!text) return null;
    // Two gates before anything is queueable: groundedness (no number the
    // evidence lacked) and the same compliance classifier every creative
    // passes. Either failing drops the draft — a bad message is not a smaller
    // message.
    const gateResult = checkOutreachDraft(text, evidenceLines);
    if (!gateResult.ok) {
      return {
        customerId: recipient.customerId,
        channel: recipient.channel,
        text,
        locale,
        complianceStatus: "flagged",
        aiAuditId: res.auditId
      };
    }
    return {
      customerId: recipient.customerId,
      channel: recipient.channel,
      text,
      locale,
      complianceStatus: "passed",
      aiAuditId: res.auditId
    };
  } catch {
    return null;
  }
}

/**
 * The one fact about this person the model may use (ADR-0091): the newest
 * reason SIGNAL holds for them, in words, with its date. Nothing else from the
 * prospect row — and nobody else's — reaches the prompt.
 */
async function prospectReason(ctx: Ctx, customerId: string, nouns: PromptNouns): Promise<string | null> {
  const [p] = await ctx.db
    .select({ reason: schema.signalProspects.reason, evidenceJson: schema.signalProspects.evidenceJson })
    .from(schema.signalProspects)
    .where(
      and(
        eq(schema.signalProspects.tenantId, ctx.tenantId),
        eq(schema.signalProspects.customerId, customerId),
        inArray(schema.signalProspects.reason, OUTREACH_REASONS),
        inArray(schema.signalProspects.state, ["open", "contacted"])
      )
    )
    .orderBy(desc(schema.signalProspects.score))
    .limit(1);
  if (!p) return null;
  if (p.reason === "no_policy") return `they are known to us but hold no ${nouns.contract} yet`;
  const at = (JSON.parse(p.evidenceJson) as { expiredAt?: number }).expiredAt;
  return `their quote expired${typeof at === "number" ? ` on ${new Date(at).toISOString().slice(0, 10)}` : ""} without being taken up`;
}

function firstName(nameJson: string | undefined | null): string | null {
  if (!nameJson) return null;
  try {
    const parsed = JSON.parse(nameJson) as unknown;
    const full =
      typeof parsed === "string"
        ? parsed
        : parsed && typeof parsed === "object"
          ? ((parsed as Record<string, unknown>).full ?? (parsed as Record<string, unknown>).en)
          : null;
    return typeof full === "string" && full.trim() ? full.trim().split(/\s+/)[0]! : null;
  } catch {
    return null;
  }
}

export interface SendOutcome {
  sent: number;
  pendingApproval: number;
  skippedQuietHours: number;
  skippedCap: number;
  droppedFlagged: number;
}

/**
 * The sweep: draft, gate, send, attribute. Runs from the nightly tick after
 * `runBudgetAutopilot` (same scheduler slot) and from POST /v1/signal/outreach/run.
 *
 * Quiet hours skip silently-by-design: the message stays for the next awake
 * tick rather than sending at 23:00 Riyadh. The approval gate follows the
 * budget-move idiom exactly — `gate()` returning means auto-approved or
 * already-approved; `approval_required` parks the send as pending for the
 * approvals queue.
 */
export async function runAcquisitionSweep(
  ctx: Ctx,
  gateway: Gateway,
  opts: {
    deliver?: (channel: OutreachChannel, to: string, text: string) => Promise<Delivered | string | null>;
    limit?: number;
  } = {}
): Promise<SendOutcome> {
  const outcome: SendOutcome = { sent: 0, pendingApproval: 0, skippedQuietHours: 0, skippedCap: 0, droppedFlagged: 0 };
  if (inQuietHours(ctx.now, ctx.policy.timezone)) return outcome;

  const campaigns = await acquisitionCampaigns(ctx);
  const nouns = promptNouns(ctx.policy.domainPack);
  const limit = opts.limit ?? 50;

  for (const campaign of campaigns) {
    const recipients = await recipientsFor(ctx, campaign);
    // Winning creative: the campaign's newest passed creative in either
    // locale — the same row the studio would show as review-ready.
    const [creative] = await ctx.db
      .select({ contentRef: schema.signalCreatives.contentRef, locale: schema.signalCreatives.locale })
      .from(schema.signalCreatives)
      .where(
        and(
          eq(schema.signalCreatives.tenantId, ctx.tenantId),
          eq(schema.signalCreatives.campaignId, campaign.id),
          eq(schema.signalCreatives.complianceStatus, "passed")
        )
      )
      .orderBy(desc(schema.signalCreatives.createdAt))
      .limit(1);
    if (!creative) continue;

    for (const recipient of recipients) {
      if (outcome.sent + outcome.pendingApproval >= limit) return outcome;

      if ((await recentSendCount(ctx, recipient.customerId)) >= FREQUENCY_CAP_PER_WEEK) {
        outcome.skippedCap++;
        continue;
      }

      const drafted = await draftOutreach(ctx, gateway, campaign, recipient, creative.contentRef, nouns);
      if (!drafted) continue;
      if (drafted.complianceStatus === "flagged") {
        outcome.droppedFlagged++;
        continue;
      }

      const outreachId = newId("otr", ctx.now);
      let approvedBy = "auto";
      try {
        const approval = await gate(ctx, {
          policyKey: "signal.outreach_send",
          subjectRef: `signal-outreach:${outreachId}`,
          context: {
            campaignId: campaign.id,
            channel: drafted.channel,
            customerId: recipient.customerId,
            locale: drafted.locale
          }
        });
        approvedBy = approval?.decidedBy ?? "auto";
      } catch (err) {
        if (err instanceof AppError && err.code === "approval_required") {
          approvedBy = "pending";
        } else {
          throw err;
        }
      }

      // Deliver only what was actually authorised. Write-after-send, same as
      // orbit-channel-outbound: a failed delivery must not leave a row
      // claiming "sent".
      let externalRef: string | null = null;
      let conversationId: string | null = null;
      if (approvedBy !== "pending") {
        const out = opts.deliver
          ? await opts.deliver(drafted.channel, recipient.customerId, drafted.text)
          : await deliverInline(ctx, drafted.channel, recipient.customerId, drafted.text);
        ({ externalRef, conversationId } = typeof out === "string" ? { externalRef: out, conversationId: null } : (out ?? { externalRef: null, conversationId: null }));
      }

      await ctx.db.insert(schema.signalOutreach).values({
        id: outreachId,
        tenantId: ctx.tenantId,
        campaignId: campaign.id,
        customerId: recipient.customerId,
        channel: drafted.channel,
        locale: drafted.locale,
        text: drafted.text,
        state: approvedBy === "pending" ? "pending_approval" : externalRef ? "sent" : "failed",
        approvedBy,
        externalRef,
        conversationId,
        aiAuditId: drafted.aiAuditId,
        ts: ctx.now
      });

      if (approvedBy === "pending") {
        outcome.pendingApproval++;
        continue;
      }
      if (!externalRef) continue;

      // THE LOOP: the send becomes a lead touch carrying campaign + channel,
      // which is exactly the row onBindIssued credits a bind to and the row
      // the autopilot's CAC window and the cockpit funnel read. Without this
      // insert, nothing downstream can ever say SIGNAL acquired anyone.
      await recordTouch(ctx, {
        touchType: "lead",
        channel: drafted.channel,
        campaignId: campaign.id,
        customerId: recipient.customerId
      });
      // ADR-0091: the send is the denominator every scale's rates divide by.
      const [sentRow] = await ctx.db.select().from(schema.signalOutreach).where(eq(schema.signalOutreach.id, outreachId));
      await recordResponse(ctx, sentRow!, "lead");
      await markProspectsContacted(ctx, recipient.customerId);
      outcome.sent++;
    }
  }
  return outcome;
}

/**
 * Inline delivery. Email/WhatsApp provider connectors are credential-gated
 * (same posture as signal-creative's publish half), so the default delivery
 * writes the message into ORBIT's outbound path when a connector exists for
 * the tenant and returns null otherwise — the sweep still records the attempt
 * honestly as `failed` rather than pretending. A tenant that wires a real
 * provider passes `deliver` and the loop closes end-to-end.
 */
export interface Delivered {
  externalRef: string | null;
  /** The ORBIT conversation it went into — how a reply finds this send. */
  conversationId: string | null;
}

async function deliverInline(ctx: Ctx, channel: OutreachChannel, customerId: string, text: string): Promise<Delivered | null> {
  // Runtime consent check — the pick-time read is advisory, this is the gate.
  await assertChannel(ctx, customerId, channel, { marketing: true });
  const [connector] = await ctx.db
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, ctx.tenantId),
        eq(schema.orbitChannelConnectors.transport, channel),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    )
    .limit(1);
  if (!connector) return null;
  // Real provider hand-off rides the existing adapter seam via dispatch —
  // imported lazily to keep this module's import graph free of ORBIT internals.
  const identity = await ctx.db
    .select()
    .from(schema.orbitChannelIdentities)
    .where(and(eq(schema.orbitChannelIdentities.tenantId, ctx.tenantId), eq(schema.orbitChannelIdentities.customerId, customerId)))
    .orderBy(desc(schema.orbitChannelIdentities.createdAt))
    .limit(1);
  if (!identity[0]) return null;
  const { dispatchOutbound } = await import("./orbit-channel-outbound.js");
  const [conversation] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(
      and(
        eq(schema.orbitConversations.tenantId, ctx.tenantId),
        eq(schema.orbitConversations.connectorId, connector.id),
        eq(schema.orbitConversations.externalRef, identity[0].handle)
      )
    )
    .orderBy(desc(schema.orbitConversations.updatedAt))
    .limit(1);
  if (!conversation) return null;
  const sent = await dispatchOutbound(ctx, (ctx as Ctx & { env?: unknown }).env as never, conversation, connector, text);
  return { externalRef: sent.externalRef, conversationId: conversation.id };
}

/**
 * The loop-back proof. Called from dispatch when a bind lands: if the bind's
 * credited lead touch came from an outreach send, stamp the outreach row
 * `converted`, emit `signal.acquisition.closed`, and audit it. This is the
 * row the cockpit's loop panel reads to say "this customer came from this
 * message" — attribution you can click, not a dashboard's word for it.
 */
export async function onLeadConverted(ctx: Ctx, customerId: string, policyId: string): Promise<boolean> {
  const [lead] = await ctx.db
    .select()
    .from(schema.signalAttributionEvents)
    .where(
      and(
        eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
        eq(schema.signalAttributionEvents.customerId, customerId),
        eq(schema.signalAttributionEvents.touchType, "lead")
      )
    )
    .orderBy(desc(schema.signalAttributionEvents.ts))
    .limit(1);
  if (!lead?.campaignId) return false;

  const [outreach] = await ctx.db
    .select()
    .from(schema.signalOutreach)
    .where(
      and(
        eq(schema.signalOutreach.tenantId, ctx.tenantId),
        eq(schema.signalOutreach.campaignId, lead.campaignId),
        eq(schema.signalOutreach.customerId, customerId),
        eq(schema.signalOutreach.state, "sent")
      )
    )
    .orderBy(desc(schema.signalOutreach.ts))
    .limit(1);
  if (!outreach) return false;

  await ctx.db
    .update(schema.signalOutreach)
    .set({ state: "converted", convertedRef: policyId, updatedAt: ctx.now })
    .where(eq(schema.signalOutreach.id, outreach.id));
  await recordResponse(ctx, outreach, "bind", policyId);

  await emit(ctx, {
    module: "signal",
    type: "signal.acquisition.closed",
    subject: outreach.id,
    data: { campaignId: outreach.campaignId, customerId, policyId, channel: outreach.channel }
  });
  await audit(ctx, {
    action: "signal.acquisition.closed",
    subjectRef: `signal-outreach:${outreach.id}`,
    after: { campaignId: outreach.campaignId, customerId, policyId, channel: outreach.channel }
  });
  return true;
}

/** Loop summary for the cockpit: per campaign, sends → leads → binds, and the
 *  conversions (closed loops) with their refs. */
export async function loopSummary(ctx: Ctx, since: number): Promise<
  Array<{ campaignId: string; sends: number; leads: number; binds: number; converted: number }>
> {
  const campaigns = await acquisitionCampaigns(ctx);
  const out: Array<{ campaignId: string; sends: number; leads: number; binds: number; converted: number }> = [];
  for (const campaign of campaigns) {
    const [[sends], [leads], [binds], [converted]] = await Promise.all([
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.signalOutreach)
        .where(and(eq(schema.signalOutreach.tenantId, ctx.tenantId), eq(schema.signalOutreach.campaignId, campaign.id), gte(schema.signalOutreach.ts, since))),
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.signalAttributionEvents)
        .where(and(eq(schema.signalAttributionEvents.tenantId, ctx.tenantId), eq(schema.signalAttributionEvents.campaignId, campaign.id), eq(schema.signalAttributionEvents.touchType, "lead"), gte(schema.signalAttributionEvents.ts, since))),
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.signalAttributionEvents)
        .where(and(eq(schema.signalAttributionEvents.tenantId, ctx.tenantId), eq(schema.signalAttributionEvents.campaignId, campaign.id), eq(schema.signalAttributionEvents.touchType, "bind"), gte(schema.signalAttributionEvents.ts, since))),
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.signalOutreach)
        .where(and(eq(schema.signalOutreach.tenantId, ctx.tenantId), eq(schema.signalOutreach.campaignId, campaign.id), eq(schema.signalOutreach.state, "converted")))
    ]);
    out.push({
      campaignId: campaign.id,
      sends: sends?.n ?? 0,
      leads: leads?.n ?? 0,
      binds: binds?.n ?? 0,
      converted: converted?.n ?? 0
    });
  }
  return out;
}
