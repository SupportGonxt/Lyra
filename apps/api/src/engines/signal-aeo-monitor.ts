import { and, desc, eq, gte } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, openFields, type Ctx } from "@lyra/core";

// docs/modules/signal.md §2.4: "AEO monitor samples major AI assistants weekly
// ... logs citation share into `signal_aeo_pages`". The spec asked for it and no
// sampler existed — `citedByJson` had exactly one writer in the whole
// repository, the demo seed, so the module's own headline KPI read 0% on every
// tenant that was not the demo. This is the sampler, and the table it writes is
// `signal_aeo_citations`: one row per query per assistant per run, because a
// single mutable column cannot produce the eight-week trend J-M3 measures.
//
// Runtime-gated on a connector, like every other integration here: no active
// `aeo` connector, no sampling, no rows, no error. Credentials live in the
// connector's sealed secrets, never in the environment or the code.

/** Connector transport the AEO monitor's assistant is stored under. */
export const AEO_TRANSPORT = "aeo";

/** The one provider shape this ships. Any OpenAI-compatible endpoint speaks it. */
export const OPENAI_COMPATIBLE = "openai-compatible";

/** Queries sampled per run, so a tenant with a thousand clusters costs a bounded
 *  number of calls rather than a thousand. Newest clusters first. */
export const AEO_SAMPLE_MAX = 25;

export interface AeoAssistant {
  /** The connector's row id, kept so two assistants' numbers never merge. */
  connectorId: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** The domains that count as *us*: `nxt.ae` matches `www.nxt.ae`. */
  domains: string[];
}

export interface AssistantAnswer {
  /** The answer as given. Stored trimmed — evidence, not a corpus. */
  text: string;
  /** The URLs the answer leaned on, in the order they appeared. */
  citations: string[];
}

/** Injectable so the engine is tested against a scripted assistant, not a network. */
export type AskAssistant = (assistant: AeoAssistant, query: string, locale: string) => Promise<AssistantAnswer>;

/* ------------------------------------------------------------------ asking */

/**
 * One question to an OpenAI-compatible chat endpoint.
 *
 * The prompt asks for the query *and* for the sources, because an assistant
 * that answers without naming them cannot be scored: "cited" would have to mean
 * "we guessed from the prose", and a KPI built on a guess is worse than absent.
 */
export const AEO_PROMPT = (query: string, locale: string) =>
  `Answer this the way you would answer a person searching in ${locale}: ${query}\n\n` +
  `Then, on a final line beginning "SOURCES:", list the exact URLs you relied on, one per line.`;

export const askOpenAiCompatible: AskAssistant = async (assistant, query, locale) => {
  const res = await fetch(`${assistant.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${assistant.apiKey}` },
    body: JSON.stringify({
      model: assistant.model,
      temperature: 0,
      messages: [{ role: "user", content: AEO_PROMPT(query, locale) }]
    })
  });
  if (!res.ok) throw new Error(`assistant ${assistant.label} answered ${res.status}`);
  const body = (await res.json()) as { choices?: ReadonlyArray<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? "";
  return { text, citations: urlsIn(text) };
};

/** Every absolute URL in an answer, de-duplicated and in order. */
export function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, "")))];
}

/** The registrable-ish domain of a URL: host, lower-cased, `www.` dropped. */
export function domainOf(url: string): string | null {
  try {
    const host = new URL(url).host.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host || null;
  } catch {
    return null;
  }
}

/**
 * Whether any cited domain is one of ours. Suffix-matched on a dot boundary, so
 * `nxt.ae` matches `www.nxt.ae` and `quotes.nxt.ae` but **not** `notnxt.ae` —
 * an attacker's lookalike domain is not a citation.
 */
export function citedBy(citations: readonly string[], domains: readonly string[]): boolean {
  const hosts = citations.map(domainOf).filter((h): h is string => h !== null);
  return hosts.some((host) => domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

/** The domains an answer cited, for naming who took the box. */
export function citedDomains(citations: readonly string[]): string[] {
  return [...new Set(citations.map(domainOf).filter((h): h is string => h !== null))];
}

/** The field-key opener the scheduler passes in, in one place. */
export const openerFor = (fieldKey: string | undefined) => async (sealed: string): Promise<Record<string, string>> => {
  if (!fieldKey) throw new Error("FIELD_KEY is not configured");
  return openFields(fieldKey, JSON.parse(sealed) as Record<string, string>);
};

/* --------------------------------------------------------------- connectors */

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The tenant's assistants whose connector is configured well enough to ask. */
export async function aeoAssistants(ctx: Ctx, open: (sealed: string) => Promise<Record<string, string>>): Promise<AeoAssistant[]> {
  const rows = await ctx.db
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, ctx.tenantId),
        eq(schema.orbitChannelConnectors.transport, AEO_TRANSPORT),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    );
  const out: AeoAssistant[] = [];
  for (const row of rows) {
    const config = parseConfig(row.configJson);
    const baseUrl = config.baseUrl;
    const model = config.model;
    const domains = config.domains;
    if (typeof baseUrl !== "string" || !/^https:\/\//.test(baseUrl)) continue;
    if (typeof model !== "string" || !model) continue;
    if (!Array.isArray(domains) || domains.length === 0) continue;
    const secrets = await open(row.secretsJson);
    if (!secrets.apiKey) continue;
    out.push({
      connectorId: row.id,
      label: row.label || row.provider,
      baseUrl,
      model,
      apiKey: secrets.apiKey,
      domains: domains.filter((d): d is string => typeof d === "string" && d.length > 0)
    });
  }
  return out;
}

/* ------------------------------------------------------------------- sample */

export interface AeoRunSummary {
  assistants: number;
  queries: number;
  sampled: number;
  cited: number;
  errors: string[];
}

/**
 * Samples the tenant's assistants for the queries its published AEO pages
 * target, and records what came back.
 *
 * One assistant failing does not lose the other's observations: each connector
 * is its own attempt, and the failure is audited rather than thrown, the same
 * shape the ad-spend pull uses for a platform that is down.
 */
export async function sampleAeoCitations(
  ctx: Ctx,
  open: (sealed: string) => Promise<Record<string, string>>,
  ask: AskAssistant = askOpenAiCompatible
): Promise<AeoRunSummary> {
  const summary: AeoRunSummary = { assistants: 0, queries: 0, sampled: 0, cited: 0, errors: [] };
  const assistants = await aeoAssistants(ctx, open);
  if (!assistants.length) return summary;
  summary.assistants = assistants.length;

  const pages = await ctx.db
    .select()
    .from(schema.signalAeoPages)
    .where(and(eq(schema.signalAeoPages.tenantId, ctx.tenantId), eq(schema.signalAeoPages.status, "published")))
    // Deterministic, because the sample is capped: an unstable order would ask
    // a *different* 25 questions each week and the trend would compare two
    // different populations. Stalest first (the pages most at risk of losing a
    // box), then by id so the set is reproducible run to run.
    .orderBy(desc(schema.signalAeoPages.freshness), desc(schema.signalAeoPages.id))
    .limit(AEO_SAMPLE_MAX);
  summary.queries = pages.length;
  if (!pages.length) return summary;

  for (const assistant of assistants) {
    for (const page of pages) {
      const query = page.queryCluster;
      try {
        const answer = await ask(assistant, query, page.locale);
        const cited = citedBy(answer.citations, assistant.domains);
        await ctx.db.insert(schema.signalAeoCitations).values({
          id: newId("aec", ctx.now),
          tenantId: ctx.tenantId,
          pageId: page.id,
          query,
          locale: page.locale,
          assistant: assistant.label,
          cited,
          citedDomainsJson: JSON.stringify(citedDomains(answer.citations)),
          excerpt: answer.text.slice(0, 500),
          sampledAt: ctx.now
        });
        summary.sampled += 1;
        if (cited) summary.cited += 1;
        await audit(ctx, {
          action: "signal.aeo.sampled",
          subjectRef: page.id,
          after: { query, assistant: assistant.label, cited, citations: answer.citations.length }
        });
        if (cited) {
          await audit(ctx, { action: "signal.aeo.cited", subjectRef: page.id, after: { query, assistant: assistant.label } });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        summary.errors.push(`${assistant.label}: ${reason}`);
        // The action name carries the outcome; AuditEntry has no field for it.
        await audit(ctx, { action: "signal.aeo.sample_failed", subjectRef: page.id, after: { query, reason } });
      }
    }
  }
  return summary;
}

/* ---------------------------------------------------------------- read back */

export interface AeoWeek {
  /** ISO week start, YYYY-MM-DD (a Monday). */
  week: string;
  sampled: number;
  cited: number;
  /** Cited ÷ sampled, 0..1. Null when nothing was sampled that week: an
   *  unsampled week is not a week of zero citations. */
  share: number | null;
}

/** The Monday of the ISO week an instant falls in, as YYYY-MM-DD. */
export function weekStart(at: number): string {
  const d = new Date(at);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * Citation share per week, oldest first — the eight-week trend J-M3 measures.
 *
 * A week with no sample reports `share: null` rather than 0, because "nobody
 * asked" and "we were not cited" are different facts and a chart that merges
 * them invents a collapse.
 */
export async function aeoWeeks(ctx: Ctx, weeks = 8): Promise<AeoWeek[]> {
  const since = ctx.now - weeks * 7 * 86_400_000;
  const rows = await ctx.db
    .select({ cited: schema.signalAeoCitations.cited, sampledAt: schema.signalAeoCitations.sampledAt })
    .from(schema.signalAeoCitations)
    .where(and(eq(schema.signalAeoCitations.tenantId, ctx.tenantId), gte(schema.signalAeoCitations.sampledAt, since)));

  const buckets = new Map<string, { sampled: number; cited: number }>();
  for (let i = weeks - 1; i >= 0; i -= 1) buckets.set(weekStart(ctx.now - i * 7 * 86_400_000), { sampled: 0, cited: 0 });
  for (const row of rows) {
    const key = weekStart(row.sampledAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.sampled += 1;
    if (row.cited) bucket.cited += 1;
  }
  return [...buckets.entries()].map(([week, b]) => ({
    week,
    sampled: b.sampled,
    cited: b.cited,
    share: b.sampled > 0 ? b.cited / b.sampled : null
  }));
}

/** The latest observation per query, for "who is citing whom" on the board. */
export async function latestCitations(ctx: Ctx, limit = 50) {
  return ctx.db
    .select()
    .from(schema.signalAeoCitations)
    .where(eq(schema.signalAeoCitations.tenantId, ctx.tenantId))
    .orderBy(desc(schema.signalAeoCitations.sampledAt))
    .limit(limit);
}
