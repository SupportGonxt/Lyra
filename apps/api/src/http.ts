import type { Context } from "hono";
import { z } from "zod";
import { AppError, badRequest, toProblem, type Problem } from "@lyra/core";
import type { App } from "./env.js";

// docs/04 §1. Everything an endpoint needs that is not business logic: shapes,
// problem+json rendering, cursor pagination and the list-query parser. Kept in
// one file so the routers stay readable as routers.

export const PROBLEM_MIME = "application/problem+json";

export function problem(c: Context<App>, err: unknown): Response {
  const p: Problem = toProblem(err, c.req.path);
  const status = (p.status || 500) as 400;
  return c.json(p, status, { "content-type": PROBLEM_MIME });
}

/** Parse a body against a schema, or throw a 400 carrying field-level errors. */
export async function body<T extends z.ZodTypeAny>(c: Context<App>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("request body is not valid JSON");
  }
  return parse(schema, raw);
}

export function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const out = schema.safeParse(raw);
  if (out.success) return out.data;
  const errors: Record<string, string> = {};
  for (const issue of out.error.issues) errors[issue.path.join(".") || "_"] = issue.message;
  throw badRequest("validation failed", errors);
}

/**
 * An instant a `Date` can actually hold (ECMA-262: ±8.64e15 ms from the epoch).
 * `z.number().int()` alone is a *safe*-integer check, so it lets through the band
 * (8.64e15, 9.007e15] — and every renderer downstream (`new Date(ms).toISOString()`,
 * the fraud prompt, the claim UI) throws on those. It threw inside a blanket
 * `catch`, so a claimant filing with a big number silently turned their own fraud
 * scoring off. Rejected at the trust boundary; `promptInstant` is the second layer.
 *
 * Lives here rather than beside one endpoint because every write surface needs
 * the same bound: the AXIS FNOL bodies, and the generated CRUD shape (crud.ts).
 *
 * A query parameter touches no schema at all, so no census of the zod shapes
 * can see one. An earlier version of this paragraph called that a hypothetical
 * "fourth way in"; it was already live. `?asOf=` on the finance reports reached
 * a SQL bind param, `Math.floor((asOf - postedAt) / DAY)` and `generatedAt` in
 * a rendered document header at once. Three shapes carry the bound, and an
 * instant-valued query parameter takes whichever matches its endpoint's
 * contract on garbage — nothing else:
 *
 * - `instantParam`, read straight off the request, 400s on garbage;
 * - `InstantMsParam`, the same in a query *schema*, where the value arrives as
 *   a string and has to be coerced first;
 * - `intParam(raw, def, { max: MAX_INSTANT_MS })`, where the endpoint's tested
 *   contract is that garbage falls back to the default rather than failing.
 *
 * Three rounds running, this paragraph claimed a coverage it did not have and
 * the next wave believed it. Keep it a list of what exists, not a slogan.
 */
export const MAX_INSTANT_MS = 8.64e15;
export const InstantMs = z.number().int().min(-MAX_INSTANT_MS).max(MAX_INSTANT_MS);

/** `InstantMs` for a query schema, where every value starts life as a string. */
export const InstantMsParam = z.coerce.number().pipe(InstantMs);

/**
 * A query parameter that names an instant. `Number("abc")` is NaN, and `??`
 * does not catch NaN, so garbage reached SQL and date arithmetic alike and
 * surfaced as a 500 where 400 is the answer. Missing or empty stays
 * `undefined`, so the endpoint's own default still applies.
 */
export function instantParam(raw: string | undefined): number | undefined {
  return raw ? parse(InstantMs, Number(raw)) : undefined;
}

/**
 * A calendar day, and a real one: `^\d{4}-\d{2}-\d{2}$` alone accepts
 * `9999-99-99` and `2026-02-30`, which the readers downstream turn into
 * `new Date("9999-99-99T00:00:00Z")` — `Invalid Date`, then `RangeError` from
 * the middle of whatever was being generated. The round trip is the check:
 * `Date` normalises Feb 30 to Mar 2, so a string that does not come back
 * unchanged was never a day.
 */
export const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    // `Date.parse` first: `toISOString()` on an unparseable string throws, and
    // a validator that throws is the defect it is here to prevent.
    const ms = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
  }, "is not a real calendar day");

/**
 * The same check a month at a time: `2026-99` rolls over into a wrong window.
 * Turn one into bounds with `monthRangeMs`, never with `Date.UTC` — see there.
 */
export const IsoMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "must be YYYY-MM")
  .refine((s) => Number(s.slice(5)) >= 1 && Number(s.slice(5)) <= 12, "is not a real calendar month");

/**
 * Half-open UTC bounds of an `IsoMonth`. Financial periods do not move with a
 * timezone, and they do not move with a century either: `Date.UTC(y, m - 1, 1)`
 * maps years 0-99 onto 1900-1999, so `"0050-06"` silently summed June *1950*
 * under a 0050 label. `Date.parse` on the ISO string has no such mapping. Two
 * engines had hand-rolled the `Date.UTC` version independently, which is why
 * this lives here rather than beside either.
 */
export function monthRangeMs(period: string): { start: number; end: number } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const iso = (year: number, month: number) =>
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01T00:00:00Z`;
  return {
    start: Date.parse(iso(y, m)),
    end: Date.parse(m === 12 ? iso(y + 1, 1) : iso(y, m + 1))
  };
}

/**
 * Whether a field name means "epoch milliseconds", by convention — the schema
 * has no marker for it, so the name is all there is to go on.
 *
 * ponytail: name rules plus a short list of whole keys, derived by censusing
 * every integer/real column in packages/db/src/schema — 625 numeric columns, of
 * which the rules match 366 and every match is an instant (no false positives).
 *
 * `expiry`, `freshness` and `reversibleUntil` are whole keys rather than suffix
 * matches. `freshness` and `reversibleUntil` are unique in the schema;
 * `expiry` is four columns — `grep -rn '^\s*expiry:' packages/db/src/schema`
 * gives core/consents, core/mandates, core/identityVerifications and
 * core/memories — and all four are instants, so naming it mis-bounds nothing.
 * They earned their place by sitting on registered *writable* resources whose
 * values render as dates: core/consents, core/mandates, core/memories
 * (`expiry`); signal/aeo-pages (`freshness`, `rw("signal:aeo")`, so create +
 * update + remove); signal/budget-moves (`reversibleUntil`,
 * `update: "signal:budget_moves:approve"`). The fourth `expiry`,
 * core/identity-verifications, is `ro` — bounded anyway, and it stays bounded
 * if that ever goes writable.
 *
 * No line numbers here on purpose: two fix waves in a row wrote them and both
 * went stale inside the same wave. Grep the resource names against
 * resources.ts.
 *
 * Ceiling: five instant columns are still named outside these rules and are NOT
 * recognised — `axis.telemetryPoints.at`, `axis.quotes.validUntil`,
 * `dist.quoteResponses.validUntil`, `scout.clusters.firstSeen`,
 * `scout.clusters.lastSeen`. Checked one by one against resources.ts rather
 * than asserted: `axis.telemetryPoints` and `dist.quoteResponses` are not
 * registered at all, and `axis.quotes` and `scout.clusters` are both `ro`, so
 * none of the five has a generic-CRUD write surface today. The two that take
 * caller input at all (`at`, `validUntil`) are bounded by hand at their own
 * endpoints (routes/axis.ts). Register any of those tables writable, or upgrade
 * either `ro`, and this paragraph is the checklist — a previous version of it
 * named the wrong line and claimed the wrong tables, and two live holes hid
 * behind that. Verify against resources.ts, do not trust this list.
 *
 * Why `at` is not in the rules, censused rather than assumed:
 * `axis.telemetryPoints.at` is the only `at:` column in the whole schema, so
 * adding it would bound exactly one unregistered table and nothing else. An
 * earlier note blamed a false positive on the orbit tools; that was wrong —
 * the three registered tools (`fetch_policy`, `start_quote`,
 * `create_endorsement_request`) return no row carrying `at`. The exclusion is
 * harmless, not principled: add `at` when that table gets a write surface.
 *
 * Upgrade path is a marker on the column itself, which Drizzle has no room for
 * — so a declared set on Resource, a parallel list this exists to avoid
 * maintaining.
 */
export const isInstantKey = (key: string): boolean =>
  key.endsWith("At") ||
  key.startsWith("effective") ||
  key === "ts" ||
  key === "expiry" ||
  key === "freshness" ||
  key === "reversibleUntil";

/* ------------------------------------------------------------- pagination */

export const MAX_PAGE = 200;

export interface Page<T> {
  data: T[];
  /** Opaque; pass back as `?cursor=`. Absent when the last page has been read. */
  cursor?: string;
  /** Only present when the caller asked for it — counting is not free at scale. */
  total?: number;
}

/**
 * Keyset cursor over `(sortValue, id)`. Offset pagination degrades on deep
 * pages, and a tenant's case list is exactly the thing an operator scrolls to
 * the bottom of.
 */
export function encodeCursor(sortValue: string | number | null, id: string): string {
  return btoa(JSON.stringify([sortValue, id])).replace(/=+$/, "");
}

export function decodeCursor(raw: string): { value: string | number | null; id: string } {
  try {
    const [value, id] = JSON.parse(atob(raw)) as [string | number | null, string];
    if (typeof id !== "string") throw new Error("bad cursor");
    return { value, id };
  } catch {
    throw badRequest("cursor is not valid");
  }
}

/* ------------------------------------------------------------ list params */

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
  cursor: z.string().optional(),
  q: z.string().max(200).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  /** Include soft-deleted rows. Requires the resource's delete permission. */
  deleted: z.coerce.boolean().default(false),
  count: z.coerce.boolean().default(false),
  /** Epoch-ms window on the sort column. */
  from: InstantMsParam.optional(),
  to: InstantMsParam.optional()
});
export type ListQuery = z.infer<typeof ListQuery>;

/** Everything not a reserved key is treated as an exact-match column filter. */
const RESERVED = new Set(Object.keys(ListQuery.shape));

export function listParams(c: Context<App>): { list: ListQuery; filters: Record<string, string> } {
  const raw = c.req.query();
  const list = parse(ListQuery, raw);
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k) && v !== "") filters[k] = v;
  return { list, filters };
}

/**
 * A single query param as a clamped integer. `Number("abc")` is NaN, and NaN
 * poisons every comparison and date arithmetic downstream — garbage input
 * falls back to the default instead.
 */
export function intParam(
  raw: string | undefined,
  def: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}
): number {
  if (!raw) return def;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/* ------------------------------------------------------------------ misc */

export function requireHeader(c: Context<App>, name: string): string {
  const v = c.req.header(name);
  if (!v) throw badRequest(`${name} header is required`);
  return v;
}

/** 201 with a Location header — the shape every create endpoint returns. */
export function created<T extends { id: string }>(c: Context<App>, row: T): Response {
  return c.json(row, 201, { location: `${c.req.path}/${row.id}` });
}

export { AppError };

/** A CSV upload: a multipart "file" field, or JSON `{ csv }` — what every import route accepts. */
export async function csvBody(c: Context): Promise<string> {
  if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) throw badRequest('attach the CSV as a "file" field');
    return file.text();
  }
  const input = (await c.req.json()) as { csv?: unknown };
  if (typeof input.csv !== "string" || !input.csv) throw badRequest("body must carry a csv string");
  return input.csv;
}
