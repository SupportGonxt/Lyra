import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { makeLibsqlDb } from "@lyra/db/libsql";
import type { Db } from "@lyra/db";
import worker, { app } from "./index.js";
import type { Env } from "./env.js";

// docs/11 §3. The on-prem twin: RUNTIME=node, libsql instead of D1, and local
// stand-ins for the two bindings that actually get called. Nothing below
// apps/api/src/env.ts knows which home it is in — this file is the whole
// difference. MODE=app serves HTTP; MODE=jobs runs the same `scheduled`
// handler the cron trigger runs in the cloud (ops/docker-compose.yml).
//
// No AI adapter: on-prem points OPENAI_COMPAT_URL at the internal llm service
// and packages/model-gateway routes to its `openai-compat` provider already
// (docs/11 §2). No queue adapter: nothing in apps/api binds one.

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

/* -------------------------------------------------------------------- KV */

/**
 * The login throttle is the only KV caller (auth.ts) and it uses exactly
 * `get` and `put` with an `expirationTtl`.
 *
 * ponytail: in-process Map, so the window is per container. Redis is already
 * in the compose stack — move this there the day `app` runs more than one
 * replica, or the throttle counts to 8 per replica instead of per estate.
 */
function kv() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      const ttl = opts?.expirationTtl ?? 86_400;
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    }
  };
}

/* ----------------------------------------------------------------- FILES */

/**
 * R2 stand-in over the local filesystem. Analytics exports call `put` then
 * `get` and read `.body`; that is the entire surface used.
 *
 * ponytail: reads whole objects into memory. Board packs and XLSX exports are
 * megabytes — stream with `Readable.toWeb(createReadStream(p))` if a tenant
 * ever exports something that does not fit.
 */
function files(root: string) {
  const path = (key: string): string => {
    // Keys are server-built (`exports/<tenant>/<id>.<fmt>`), but this is a
    // filesystem write: a key that escapes the root must not be honoured.
    const p = resolve(root, key);
    if (p !== root && !p.startsWith(root + "/")) throw new Error(`invalid object key: ${key}`);
    return p;
  };
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key: string): Promise<{ body: ReadableStream | null } | null> {
      try {
        return { body: new Response(await readFile(path(key))).body };
      } catch {
        return null;
      }
    }
  };
}

/* ------------------------------------------------------------------- env */

/** `DB` stays unbound: auth.ts prefers `DB_CLIENT` and never reaches D1 here. */
export function makeEnv(): Env {
  const env = {
    DB_CLIENT: makeLibsqlDb(need("LIBSQL_URL"), process.env.LIBSQL_AUTH_TOKEN || undefined) as unknown as Db,
    KV: kv(),
    // The virtual clock's offset (clock.ts): without it the sim cannot run on-prem.
    CONFIG: kv(),
    FILES: files(resolve(process.env.FILES_DIR ?? "/var/lib/lyra/files")),
    ENVIRONMENT: process.env.ENVIRONMENT ?? "onprem",
    ...(process.env.APP_ORIGIN ? { APP_ORIGIN: process.env.APP_ORIGIN } : {}),
    ...(process.env.SESSION_COOKIE ? { SESSION_COOKIE: process.env.SESSION_COOKIE } : {}),
    // A wrangler secret on Workers, a container env var here (docs/25 §FIELD_KEY).
    // Without it field encryption and the portal-link HMAC (routes/portal.ts)
    // both fail closed, so the on-prem process has to be able to carry it too.
    ...(process.env.FIELD_KEY ? { FIELD_KEY: process.env.FIELD_KEY } : {}),
    ...(process.env.OPENAI_COMPAT_URL ? { OPENAI_COMPAT_URL: process.env.OPENAI_COMPAT_URL } : {}),
    ...(process.env.OPENAI_COMPAT_API_KEY ? { OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.AI_GATEWAY_URL ? { AI_GATEWAY_URL: process.env.AI_GATEWAY_URL } : {})
  } as unknown as Env;
  // The reference underwriter (ADR-0072) is a self service binding on Workers.
  // Here the same Worker is this process, so the binding is a real Request
  // through the same app — the quote adapter cannot tell the difference, and
  // without it every e2e run and every on-prem box renders the live-API
  // offering as an error row instead of a price.
  env.CARRIER_SANDBOX = {
    fetch: async (input, init) => app.fetch(new Request(input, init), env, exec as never)
  };
  return env;
}

/* --------------------------------------------------------------- runtime */

const exec = { waitUntil() {}, passThroughOnException() {} };

/** The cloud cron trigger, as a timer. Same handler, same idempotency. */
export async function tick(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  try {
    await worker.scheduled(null, env, { waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending);
  } catch (err) {
    // A failed tick is latency, not data loss (index.ts: both jobs are
    // idempotent). Crashing the container would turn it into an outage.
    console.error("scheduled tick failed:", err instanceof Error ? err.stack : err);
  }
}

async function main(): Promise<void> {
  const env = makeEnv();
  if ((process.env.MODE ?? "app") === "jobs") {
    const every = Number(process.env.CRON_INTERVAL_MS ?? 300_000);
    setInterval(() => void tick(env), every);
    void tick(env);
    console.log(`lyra worker: scheduled every ${every}ms`);
    return;
  }
  const port = Number(process.env.PORT ?? 8787);
  await mkdir(resolve(process.env.FILES_DIR ?? "/var/lib/lyra/files"), { recursive: true });
  serve({ fetch: (req: Request) => app.fetch(req, env, exec as never), port });
  console.log(`lyra api: http://0.0.0.0:${port}`);
}

// Only when run as the entrypoint — importing this module (the adapter tests)
// must not open a socket or start a timer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A container that cannot reach its database must die loudly and let the
  // restart policy retry, not serve 500s from a half-built env.
  main().catch((err: unknown) => {
    console.error("lyra: failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { kv, files };
