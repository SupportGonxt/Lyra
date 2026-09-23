import { Hono } from "hono";
import { getTableColumns, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { badRequest, can, mask, scoped, type Ctx, type PiiKind, type PiiMap } from "@lyra/core";
import { REGISTRY, type Resource } from "../crud.js";
import type { App } from "../env.js";

// One batch resolver for "what is this ref called?". Rows carry refs
// (`customerId`, `assigneeRef`, `teamId`) and no display text, so every screen
// that listed them was rendering ULIDs at a human — worst on the ORBIT console,
// whose CUSTOMER and WITH columns were pure machine ids. Re-resolving per view
// would have been the same join written five times, once per consumer.
//
// Built off the same REGISTRY search.ts fans out over (CLAUDE.md rule 15): the
// prefix table, the read permission, the PII map and the row-visibility
// predicate all come from the resource's own declaration, so a table registered
// tomorrow resolves without touching this file. Gated per resource for the same
// reason search.ts is — an ungated name lookup is a read side channel onto data
// the caller cannot otherwise see.

export const nameRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/** A page shows 50-100 refs; 200 leaves headroom without becoming a scan. */
const MAX_REFS = 200;

/**
 * First of these the table actually has is its display column. Localised
 * (`*Json`) columns come first: where a table has both, the per-locale one is
 * the one a person should read.
 */
const DISPLAY_COLUMNS = [
  "nameJson",
  "titleJson",
  "labelJson",
  "name",
  "title",
  "label",
  "subject",
  // A case's `ref` IS its human-facing short reference (axis.ts), which is what
  // an operator says out loud — not a fallback for a missing name.
  "ref",
  "policyNo",
  "claimNo",
  "code",
  "email",
  "key",
  "slug",
  // Last resort, and only for the rows that carry nothing else: a legal hold is
  // a subject, a reason and an authority, so the sentence the compliance
  // officer wrote is the only part of it a person can read. Any table with a
  // name, title or ref never reaches this.
  "reason"
];

/**
 * Legacy id prefixes that point at a registered resource under another name.
 * Users were minted both as the registry's `us` and as a hand-written `usr`
 * (staff invites, SSO provisioning), so those rows resolved to nothing at all.
 * Minting is aligned on `us` now; this keeps the rows already on disk readable.
 *
 * The catalogue is the same story from the other side: the registry mints
 * `prv`/`prd`/`chn`/`off`, the rows in every tenant seeded before it carry
 * `pv`/`pr`/`ch`/`of`, and a SCOUT panel full of `pv_01KE…` or a settlement
 * queue full of `channel:ch_01KE…` resolves to nothing without this.
 */
const ALIASES: Record<string, string> = {
  usr: "us",
  pv: "prv",
  pr: "prd",
  ch: "chn",
  of: "off"
};

/**
 * The tenant's own staff directory. Naming the colleague who holds your
 * conversation is not an administrative act, but `core:users:read` is: no
 * tenant grants staff-admin rights to answer a chat, so the ORBIT console's
 * WITH column and its handover FROM/TO rendered `user:us_01KE…VNK5` at the
 * agent whose queue it is. These two resolve for any signed-in actor in the
 * tenant — display column only, tenant-scoped, PII-masked exactly as every
 * other read is, and never the list, record or write paths (ADR-0046).
 *
 * The catalogue joins them for the same reason: a carrier's name, a product's
 * name and a channel's name are the vocabulary of every SCOUT, AXIS, ORBIT and
 * ledger screen, and `core:providers:read` is an administrative grant no
 * analyst holds. The panel table listed six `pv_01KE…` ids under a column
 * headed "Carrier"; the settlement queue listed `channel:ch_01KE…` under
 * "Counterparty" (ADR-0048).
 *
 * These names are also the ones minimisation does not reach: a colleague is
 * not a data subject, and "Requested by Layla H•••••" on a decisions queue
 * masks the org chart from the org (ADR-0056). Only the display column, only
 * inside the tenant — a customer stays masked below.
 */
const DIRECTORY = new Set(["users", "teams", "providers", "products", "channels", "offerings"]);

/**
 * The PII kind guarding a display column. A `*Json` column declares itself per
 * locale (`nameJson.en`), so a lookup on the bare column name finds nothing and
 * handed every customer's real name to an actor holding no `core:pii:view` —
 * while the list beside it, which masks on the hydrated row, showed the mask.
 */
function piiKind(pii: PiiMap | undefined, column: string): PiiKind | undefined {
  if (!pii) return undefined;
  return pii[column] ?? Object.entries(pii).find(([path]) => path.startsWith(`${column}.`))?.[1];
}

interface Parsed {
  /** The ref exactly as asked, so the caller can look up the string it holds. */
  ref: string;
  id: string;
  prefix: string;
}

/** `cu_01H…` and `user:us_01H…` both reduce to an id and its prefix. */
export function parseRef(ref: string): Parsed | null {
  const colon = ref.indexOf(":");
  const id = colon > 0 ? ref.slice(colon + 1) : ref;
  const under = id.indexOf("_");
  if (under <= 0 || under === id.length - 1) return null;
  const prefix = id.slice(0, under);
  return { ref, id, prefix: ALIASES[prefix] ?? prefix };
}

/** A `*Json` column holds `{ en, ar }`; anything else is already a string. */
function displayText(value: unknown, locale: string): string | null {
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      return displayText(JSON.parse(value), locale);
    } catch {
      return value;
    }
  }
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const picked = record[locale] ?? record.en ?? Object.values(record)[0];
    return typeof picked === "string" ? picked.trim() || null : null;
  }
  return null;
}

/** The registered resource a ref points at, by its id prefix (aliases included). */
export function resourceOf(ref: string): { resource: Resource; id: string } | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  const resource = REGISTRY.find((one) => one.idPrefix === parsed.prefix);
  return resource ? { resource, id: parsed.id } : null;
}

nameRoutes.get("/", async (c) => {
  const ctx = ctxOf(c);
  const asked = [...new Set((c.req.query("refs") ?? "").split(",").map((one) => one.trim()).filter(Boolean))];
  if (!asked.length) throw badRequest("refs is required");
  if (asked.length > MAX_REFS) throw badRequest(`refs is capped at ${MAX_REFS}`);
  // Unresolved refs are absent rather than null: a view falls back to the short
  // ref it already holds, and never renders the word "null" at a person.
  return c.json({ names: await resolveNames(ctx, asked) });
});

/**
 * Ref → display name for every ref the caller may read; the rest are absent.
 * The route above is one caller; the notes backlinks, graph and vault export
 * (routes/notes.ts) are the others, so a name means the same thing in all four.
 */
export async function resolveNames(ctx: Ctx, asked: readonly string[]): Promise<Record<string, string>> {

  // Group by prefix so one resource costs one query however many refs point at
  // it, and drop anything unparseable here: a stale ref in a list must not fail
  // the batch that carries 49 good ones.
  const byPrefix = new Map<string, Parsed[]>();
  for (const ref of asked) {
    const parsed = parseRef(ref);
    if (!parsed) continue;
    const group = byPrefix.get(parsed.prefix);
    if (group) group.push(parsed);
    else byPrefix.set(parsed.prefix, [parsed]);
  }

  // Permission and column checks are synchronous and run before any query is
  // issued, so a resource the caller cannot read is never even asked about.
  const plans = [...byPrefix].flatMap(([prefix, group]) => {
    const resource = REGISTRY.find((one) => one.idPrefix === prefix);
    if (!resource) return [];
    if (
      !DIRECTORY.has(resource.path) &&
      !can(ctx.actor, resource.perms.read, { tenantId: ctx.tenantId, module: resource.module })
    )
      return [];
    const cols = getTableColumns(resource.table) as Record<string, SQLiteColumn>;
    const column = DISPLAY_COLUMNS.find((key) => cols[key]);
    if (!column || !cols.id) return [];
    return [{ resource, group, column, idCol: cols.id }];
  });

  const names: Record<string, string> = {};
  await Promise.all(
    plans.map(async ({ resource, group, column, idCol }) => {
      const ids = group.map((one) => one.id);
      const rows = (await ctx.db
        .select()
        .from(resource.table as never)
        .where(scoped(ctx, resource.table as never, inArray(idCol, ids)))
        .limit(ids.length)) as Record<string, unknown>[];

      const kind = DIRECTORY.has(resource.path) ? undefined : piiKind(resource.pii, column);
      const labels = new Map<string, string>();
      for (const row of rows) {
        // A row the actor may not see is a row whose name they may not read
        // either — same rule the record and list paths apply.
        if (resource.rowVisible && !(await resource.rowVisible(ctx, row))) continue;
        const text = displayText(row[column], ctx.locale);
        if (!text) continue;
        labels.set(String(row.id), kind ? mask(ctx.actor, { text }, { text: kind }, ctx.tenantId).text : text);
      }
      for (const one of group) {
        const label = labels.get(one.id);
        if (label) names[one.ref] = label;
      }
    })
  );

  return names;
}
