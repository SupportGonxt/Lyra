import { AppError } from "@lyra/core";
import type { Env } from "../env.js";

// The screening seam (CLAUDE.md §15) and what plugs into it. The route owns the
// hash, the row, the block and the audit; a provider only answers the question.

export type ScreeningKind = "sanctions" | "pep" | "adverse_media" | "fraud";

/** What the provider is asked. Hashed as-is, so normalisation lives upstream. */
export interface ScreeningQuery {
  kind: ScreeningKind;
  /** Lower-cased, single-spaced. Two spellings of one search must hash alike. */
  name: string;
  identifiers: Record<string, string>;
}

export interface ScreeningHit {
  listRef: string;
  matchedName: string;
  matchPct: number;
  note: string;
  /** True on a hit the built-in stub made up; false on one a real list returned. */
  stub: boolean;
}

export interface ScreeningOutcome {
  result: "clear" | "hit" | "inconclusive";
  hits: ScreeningHit[];
}

/**
 * The seam a bought watchlist plugs into (CLAUDE.md §15). One method, because a
 * screening is one question — the endpoint owns the hash, the row, the block and
 * the audit, so a provider cannot get any of those wrong.
 */
export interface ScreeningProvider {
  /** Written to `compliance_screenings.provider`; it is the evidence of what ran. */
  readonly name: string;
  screen(query: ScreeningQuery): Promise<ScreeningOutcome>;
}

/** Names that make the stub answer something other than "clear". Exported so a
 *  test can walk the hit path without pretending a real list exists. */
export const STUB_SCREENING_TOKENS = [
  ["lyra-test-hit", "hit"],
  ["lyra-test-inconclusive", "inconclusive"]
] as const;

/**
 * Consults nothing. It matches two deliberately fake tokens and returns "clear"
 * for every real name — which is not a screening result and is labelled as such
 * on every hit and on the screen. It answers wherever no list is configured,
 * and for the kinds no configured list covers (ADR-0095).
 */
export const stubScreening: ScreeningProvider = {
  name: "stub",
  async screen(query) {
    const match = STUB_SCREENING_TOKENS.find(([token]) => query.name.includes(token));
    if (!match) return { result: "clear", hits: [] };
    return {
      result: match[1],
      hits: [
        {
          listRef: `stub:${match[0]}`,
          matchedName: query.name,
          matchPct: 100,
          note: "Produced locally by the built-in stub. No watchlist was consulted.",
          stub: true
        }
      ]
    };
  }
};

/* ------------------------------------------------------ OpenSanctions */

/** Which OpenSanctions collection answers which kind; the rest it does not cover. */
const COLLECTION: Partial<Record<ScreeningKind, string>> = { sanctions: "sanctions", pep: "peps" };
/** Query identifiers the match API reads as FollowTheMoney properties. */
const PROPERTIES = ["birthDate", "nationality", "country", "idNumber", "passportNumber", "registrationNumber"] as const;
/** At or above this the list's own call is "maybe": a person must look. */
const CLOSE = 0.7;

interface MatchResult {
  id: string;
  caption: string;
  score: number;
  match: boolean;
  datasets?: string[];
}

/**
 * ADR-0095: the OpenSanctions match API — hosted, or a self-hosted `yente` on
 * the on-prem stack (ADR-0010). A call that fails is an error, never "clear":
 * an unanswered screening must not read as a passed one.
 */
export function openSanctions(opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch }): ScreeningProvider {
  const base = (opts.baseUrl ?? "https://api.opensanctions.org").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  return {
    name: "opensanctions",
    async screen(query) {
      const collection = COLLECTION[query.kind] ?? "default";
      const properties: Record<string, string[]> = { name: [query.name] };
      for (const key of PROPERTIES) if (query.identifiers[key]) properties[key] = [query.identifiers[key]!];
      const res = await doFetch(`${base}/match/${collection}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `ApiKey ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          queries: { q: { schema: query.identifiers.entityType === "company" ? "Company" : "Person", properties } }
        })
      });
      if (!res.ok) throw new AppError(502, "screening_unavailable", "Screening provider unavailable", `opensanctions answered ${res.status}`);
      const body = (await res.json()) as { responses?: { q?: { results?: MatchResult[] } } };
      const found = (body.responses?.q?.results ?? []).filter((r) => r.match || r.score >= CLOSE);
      return {
        result: found.some((r) => r.match) ? "hit" : found.length ? "inconclusive" : "clear",
        hits: found.map((r) => ({
          listRef: `opensanctions:${r.id}`,
          matchedName: r.caption,
          matchPct: Math.round(r.score * 100),
          note: (r.datasets ?? []).join(", "),
          stub: false
        }))
      };
    }
  };
}

/** The list for the kinds it covers once configured; the labelled stub otherwise. */
export function screeningFor(env: Pick<Env, "OPENSANCTIONS_API_KEY" | "OPENSANCTIONS_URL">, kind: ScreeningKind): ScreeningProvider {
  if (!COLLECTION[kind] || !(env.OPENSANCTIONS_API_KEY || env.OPENSANCTIONS_URL)) return stubScreening;
  return openSanctions({
    ...(env.OPENSANCTIONS_API_KEY ? { apiKey: env.OPENSANCTIONS_API_KEY } : {}),
    ...(env.OPENSANCTIONS_URL ? { baseUrl: env.OPENSANCTIONS_URL } : {})
  });
}
