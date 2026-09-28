import { and, eq, isNull } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  conflict,
  emit,
  expandLookalike,
  kAnonymityFloor,
  notFound,
  LOOKALIKE_MAX_SIZE,
  type ConsentPurpose,
  type Ctx,
  type LookalikeExclusions,
  type LookalikePerson,
  type LookalikeRefusal
} from "@lyra/core";
import { currentPurposes, suppressedCustomerIds } from "./signal-consent.js";
import { audienceMemberIds } from "./signal-outreach.js";

// docs/17 §SIG-028 — lookalike expansion with consent basis preserved. ADR-0113.
//
// The engine is the half the pure scorer (packages/core/src/lookalike.ts)
// cannot see: which customers exist, what each has currently consented to, who
// is suppressed, and who the seed audience resolves to. It reads the book once,
// hands the scorer people as tags plus consent, and writes what came back as a
// new audience whose `consentPurposes` is the strictest basis its members
// share. Nothing is sent: an audience is a definition, and every campaign that
// uses one still goes through consent at send time and its own approval.

/** The leaf a lookalike's rule is made of. The resolver reads the member table for it. */
export const LOOKALIKE_LEAF = { field: "lookalike.member", op: "eq", value: true } as const;

/** Members per insert: seven columns, under D1's 100 bound parameters. */
const INSERT_CHUNK = 12;

export interface ExpandedAudience {
  /** The same id twice: `id` is what a generic record action follows. */
  id: string;
  audienceId: string;
  size: number;
  basis: ConsentPurpose[];
  excluded: LookalikeExclusions;
}

export async function expandAudience(
  ctx: Ctx,
  seedAudienceId: string,
  opts: { size: number; name?: string }
): Promise<ExpandedAudience> {
  if (!Number.isInteger(opts.size) || opts.size < 1 || opts.size > LOOKALIKE_MAX_SIZE) {
    throw badRequest(`size must be a whole number from 1 to ${LOOKALIKE_MAX_SIZE}`, { size: "out of range" });
  }
  const [seedAudience] = await ctx.db
    .select()
    .from(schema.signalAudiences)
    .where(and(eq(schema.signalAudiences.tenantId, ctx.tenantId), eq(schema.signalAudiences.id, seedAudienceId)))
    .limit(1);
  if (!seedAudience) throw notFound("audience");

  const seedIds = new Set(await audienceMemberIds(ctx, seedAudienceId));
  const customers = await ctx.db
    .select({ id: schema.customers.id, tagsJson: schema.customers.tagsJson })
    .from(schema.customers)
    // Soft-deleted customers are erased people: neither seed nor candidate.
    .where(and(eq(schema.customers.tenantId, ctx.tenantId), isNull(schema.customers.deletedAt)));
  const purposes = await currentPurposes(ctx);
  const suppressed = await suppressedCustomerIds(ctx);

  const people: LookalikePerson[] = customers.map((c) => ({
    id: c.id,
    tags: tagsOf(c.tagsJson),
    purposes: purposes.get(c.id) ?? null,
    suppressed: suppressed.has(c.id)
  }));
  const floor = kAnonymityFloor(ctx.policy, "signal");
  const result = expandLookalike({
    seed: people.filter((p) => seedIds.has(p.id)),
    candidates: people,
    size: opts.size,
    pack: ctx.policy.domainPack,
    floor
  });
  if (!result.ok) throw conflict(refusal(result.reason, floor));

  const audienceId = newId("aud", ctx.now);
  const basis = [...result.basis];
  await ctx.db.insert(schema.signalAudiences).values({
    id: audienceId,
    tenantId: ctx.tenantId,
    name: opts.name?.trim() || `${seedAudience.name} (lookalike)`,
    definitionJson: JSON.stringify({
      all: [LOOKALIKE_LEAF],
      // The why of the whole audience, beside the rule the resolver runs: who
      // it was grown from, on which axes and cells, and everyone it left out
      // and for what reason.
      lookalike: {
        seedAudienceId,
        seedName: seedAudience.name,
        seedSize: result.profile.size,
        requested: opts.size,
        floor,
        axes: result.profile.axes,
        cells: result.profile.cells,
        excluded: result.excluded,
        method: "axis-overlap"
      }
    }),
    sizeCached: result.members.length,
    refreshPolicy: "manual",
    lastRefreshedAt: ctx.now,
    consentPurposes: basis.join(","),
    createdBy: actorRef(ctx),
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  for (let i = 0; i < result.members.length; i += INSERT_CHUNK) {
    await ctx.db.insert(schema.signalAudienceMembers).values(
      result.members.slice(i, i + INSERT_CHUNK).map((m) => ({
        id: newId("aum", ctx.now),
        tenantId: ctx.tenantId,
        audienceId,
        customerId: m.id,
        score: m.score,
        matchedJson: JSON.stringify(m.matched),
        createdAt: ctx.now
      }))
    );
  }

  await audit(ctx, {
    action: "signal.audience.expanded",
    subjectRef: `signal_audience:${audienceId}`,
    after: { seedAudienceId, requested: opts.size, size: result.members.length, basis, axes: result.profile.axes, excluded: result.excluded }
  });
  await emit(ctx, {
    module: "signal",
    type: "signal.audience.expanded",
    subject: audienceId,
    data: { seedAudienceId, size: result.members.length, basis }
  });

  return { id: audienceId, audienceId, size: result.members.length, basis, excluded: result.excluded };
}

function refusal(reason: LookalikeRefusal, floor: number): string {
  switch (reason) {
    case "seed_below_floor":
      return `the seed has fewer than ${floor} members who consented to marketing and profiling`;
    case "no_profile":
      return `no targetable attribute is shared by at least ${floor} seed members`;
    case "no_match":
      return "no consented, unsuppressed customer resembles the seed";
    case "bad_size":
      return `size must be a whole number from 1 to ${LOOKALIKE_MAX_SIZE}`;
  }
}

/**
 * Why a write to the audiences resource may not stand, or null. A lookalike is
 * made by expansion and nothing else: its rule names a member table only
 * expansion fills, and its consent basis is derived from those members, so
 * neither may be typed in. Editing the rule of an existing lookalike is an
 * ordinary rule edit: the member leaf still resolves through the basis check.
 */
export function lookalikeWriteProblem(
  values: Record<string, unknown>,
  existing: { definitionJson?: unknown; consentPurposes?: unknown } | null | undefined
): { field: "definitionJson" | "consentPurposes"; problem: string } | null {
  const wasLookalike = existing != null && isLookalike(existing.definitionJson);
  if ("definitionJson" in values && isLookalike(values.definitionJson) && !wasLookalike) {
    return { field: "definitionJson", problem: "a lookalike is made by expanding a seed audience, not written as a rule" };
  }
  if (wasLookalike && "consentPurposes" in values && values.consentPurposes !== existing.consentPurposes) {
    return { field: "consentPurposes", problem: "a lookalike's consent basis is derived from its members and cannot be edited" };
  }
  return null;
}

function isLookalike(def: unknown): boolean {
  let d = def;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return false;
    }
  }
  return JSON.stringify(d ?? null).includes(`"${LOOKALIKE_LEAF.field}"`);
}

function tagsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
