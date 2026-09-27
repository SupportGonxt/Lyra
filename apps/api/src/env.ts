import { internal } from "@lyra/core";
import type { Db } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import type { Envelope } from "@lyra/core";
import type { AgentRoom } from "./engines/agent-room.js";
import type { RateCounter } from "./engines/rate-counter.js";
import type { UserChannel } from "./engines/user-channel.js";
import type { RenewalWorkflowParams } from "./engines/renewal-campaign.js";

/** A carrier reachable over a service binding, typed to the one call we make. */
export interface CarrierService {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** A Vectorize index binding, typed to just the calls this codebase makes. */
export interface VectorizeIndex {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  query(
    vector: number[],
    opts: { topK: number; filter?: Record<string, unknown>; returnMetadata?: boolean }
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
}

/**
 * Worker bindings. The on-prem twin supplies the same names from Docker env and
 * a libsql client instead of D1 — nothing below this file knows which home it is
 * running in (docs/02 §4).
 */
export interface Env {
  DB: D1Database;
  /**
   * A ready-made client, used instead of `DB` when there is no D1 to bind: the
   * on-prem adapter puts a libsql client here, and the journey tests put an
   * in-memory one, so both drive the real handlers rather than a copy of them.
   */
  DB_CLIENT?: Db;
  /** Workers AI. Default provider for every tier until a tenant overrides it. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** ponytail: CACHE only, today — short-TTL SSO nonces + ephemeral state. CONFIG
   * exists per docs/10 §2 for tenant-config caching once a reader needs it. */
  CONFIG?: KVNamespace;
  CACHE?: KVNamespace;
  /** @deprecated kept as an alias of CACHE during the docs/10 §2 KV split; remove once no caller references it. */
  KV?: KVNamespace;
  FILES?: R2Bucket;
  EXPORTS?: R2Bucket;
  LOGS?: R2Bucket;
  /** docs/16 H3 / docs/02 §4: one AgentRoom Durable Object per conversation. */
  AGENT_ROOM: DurableObjectNamespace<AgentRoom>;
  /** docs/10 §2: per-key fixed-window counter, replaces the racy KV read-modify-write. */
  RATE?: DurableObjectNamespace<RateCounter>;
  /** docs/04 §5 / docs/10 §2: per-user notification channel (WebSocket + SSE). */
  REALTIME?: DurableObjectNamespace<UserChannel>;
  /** docs/10 §2: producer side of the `lyra-events` topic — the outbox drain publishes here. */
  EVENTS?: Queue<Envelope>;
  /** docs/10 §2: durable day-0/7/21/30 renewal campaign, one instance per raised orbit_renewals row. */
  WF?: Workflow<RenewalWorkflowParams>;
  /** docs/21 knowledge base chunks (AXIS document extraction). */
  VEC_KB?: VectorizeIndex;
  /** SCOUT whitespace/competitive bench embeddings. */
  VEC_MARKET?: VectorizeIndex;
  /** ORBIT conversation memory embeddings. */
  VEC_CONVO?: VectorizeIndex;
  /** Request + AI-usage metrics (docs/10 §2). */
  TELEMETRY?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
  /** Headless Chrome, used for Arabic-shaped PDF rendering (docs/07 pdf.ts fallback). */
  BROWSER?: { fetch(req: Request): Promise<Response> };
  ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  AI_GATEWAY_URL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_COMPAT_URL?: string;
  OPENAI_COMPAT_API_KEY?: string;
  SESSION_COOKIE?: string;
  /**
   * Cookie `Domain` for the session, when web and api sit on sibling hosts —
   * the shared parent of both (`lyra.vantax.co.za`), never one of them. Unset
   * means host-only, which is what local dev wants. See `sessionCookie` in
   * auth.ts for why this is configured rather than derived from APP_ORIGIN.
   */
  SESSION_COOKIE_DOMAIN?: string;
  /**
   * docs/12 §1 field-level encryption key (ADR-0032). A wrangler secret, never
   * a `vars` entry: the day it lands in wrangler.jsonc it is in git.
   */
  FIELD_KEY?: string;
  /** ADR-0095: the OpenSanctions match API key (a wrangler secret). With neither
   *  this nor OPENSANCTIONS_URL set, screening runs the labelled stub. */
  OPENSANCTIONS_API_KEY?: string;
  /** ADR-0095: a self-hosted yente (on-prem); defaults to the hosted API. */
  OPENSANCTIONS_URL?: string;
  /**
   * docs/10 §6 Turnstile secret (`infra/cloudflare/turnstile.tf`). A wrangler
   * secret. Its absence is meaningful: no secret, no challenge — see
   * `turnstile.ts`.
   */
  TURNSTILE_SECRET?: string;
  /**
   * Live underwriter credentials — one wrangler secret per carrier, named by
   * that provider's `quoteEndpointJson.authRef` (ADR-0070). The `CARRIER_`
   * prefix is load-bearing and enforced in `engines/dist-quoter.ts`: provider
   * rows are tenant-editable, so an unnamespaced ref would let a tenant name
   * FIELD_KEY and have us post it to a host of their choosing.
   */
  [carrierName: `CARRIER_${string}`]: string | CarrierService | undefined;
  /**
   * The first-party reference underwriter (ADR-0072) — a self service binding
   * back into this same Worker, because a Worker that fetches its own zone by
   * hostname gets Cloudflare error 1042. It sits in the `CARRIER_` namespace so
   * the same guard that bounds `authRef` bounds the binding a provider row may
   * name.
   */
  CARRIER_SANDBOX?: CarrierService;
}

/**
 * The field-encryption secret, or a failed request. Fails the write rather than
 * quietly storing an Emirates ID in the clear — a deployment without the secret
 * is a misconfiguration, not a degraded mode (docs/12 §1, ADR-0032).
 */
export function fieldKey(env: Pick<Env, "FIELD_KEY">): string {
  if (!env.FIELD_KEY) throw internal("FIELD_KEY is not configured");
  return env.FIELD_KEY;
}

/** Per-request state carried on the Hono context. */
export interface Vars {
  ctx: Ctx;
  gateway: Gateway;
  requestId: string;
  startedAt: number;
}

export type App = { Bindings: Env; Variables: Vars };
