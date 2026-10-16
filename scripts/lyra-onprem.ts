import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Secrets ops/init must not leave as the .env.example placeholder — generated
// fresh per install (rule 10: secrets via Docker env, never committed/shared).
const GENERATE = new Set(["AUTH_SECRET", "MINIO_ROOT_PASSWORD", "RENDER_TOKEN"]);

export interface InitResult {
  path: string;
  created: boolean;
  generated: string[];
  licenceConfigured: boolean;
}

export function onpremInit(opts: { root?: string } = {}): InitResult {
  const root = opts.root ?? resolve(import.meta.dirname, "..");
  const outPath = resolve(root, "ops/.env");
  const examplePath = resolve(root, ".env.example");

  if (existsSync(outPath)) {
    return { path: outPath, created: false, generated: [], licenceConfigured: false };
  }

  const template = readFileSync(examplePath, "utf8");
  const generated: string[] = [];
  let licenceConfigured = false;

  const written = template.replace(/^([A-Z0-9_]+)=(.*)$/gm, (line, key: string, value: string) => {
    if (GENERATE.has(key)) {
      generated.push(key);
      return `${key}=${randomBytes(24).toString("base64url")}`;
    }
    if (key === "LYRA_LICENCE" && value.trim() !== "") licenceConfigured = true;
    return line;
  });

  mkdirSync(resolve(root, "ops"), { recursive: true });
  // **Two template values address the developer's host, and inside a container they
  // address the container itself.**
  //
  // `ops/docker-compose.yml` gives every service address a default
  // (`${LIBSQL_URL:-http://libsql:8080}`, `${OPENAI_COMPAT_URL:-http://llm:11434/v1}`), and
  // the intent is clearly that an operator may override them. But `.env.example` — a
  // **host-dev** template — already sets both to host-local values, and composes's `:-`
  // default only applies when the variable is unset **or empty**. A non-empty
  // `file:./.data/lyra.db` therefore wins over `http://libsql:8080`, and the default
  // never fires.
  //
  // Found by running the stack, 2026-10-16. `migrate` died with
  // `ConnectionFailed("Unable to open connection to local database ./.data/lyra.db")`
  // — drizzle opening a file that does not exist in that container, because the
  // template told it to.
  //
  // The other four service addresses in the template are already correct
  // (`REDIS_URL=redis://redis:6379`, `QDRANT_URL`, `EMBEDDINGS_URL`, `RENDER_URL` all
  // name services), which is what makes these two look deliberate rather than wrong.
  //
  // `APP_ORIGIN` is left alone: it is genuinely deployment-specific, and the operator
  // sets it to the public origin.
  const CONTAINER_ADDRESSES: Record<string, string> = {
    LIBSQL_URL: "http://libsql:8080",
    OPENAI_COMPAT_URL: "http://llm:11434/v1"
  };
  const fixed = written.replace(/^([A-Z0-9_]+)=.*$/gm, (line, key: string) =>
    key in CONTAINER_ADDRESSES ? `${key}=${CONTAINER_ADDRESSES[key]}` : line
  );

  writeFileSync(outPath, fixed);
  return { path: outPath, created: true, generated, licenceConfigured };
}

// ---------------------------------------------------------------------------
// migrate / seed — thin wrappers around the same commands e2e/global-setup.ts
// already uses. Don't reimplement drizzle-kit or seed(); just point them at
// the on-prem LIBSQL_URL. exec is injectable so tests never spawn pnpm.
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void;

function defaultExec(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): void {
  execFileSync(cmd, args, { ...opts, stdio: "inherit" });
}

interface RunOpts {
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  root?: string;
}

// LIBSQL_URL is drizzle's name for the connection; seed-cli.ts reads
// DATABASE_URL/DATABASE_AUTH_TOKEN instead (same value, different name) —
// bridge both, exactly as e2e/global-setup.ts does.
//
// The default must be an absolute path: `pnpm --filter @lyra/db migrate`
// runs with packages/db as its cwd, so a relative `file:./.data/lyra.db`
// resolves under packages/db, not repo root. Real on-prem deployments point
// LIBSQL_URL at the libsql-server container over http:// and never hit this;
// it only matters for local file-mode testing, which is exactly where it's
// easy to get burned.
function dbEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const libsqlUrl = env.LIBSQL_URL ?? `file:${resolve(root, ".data/lyra.db")}`;
  return {
    ...env,
    LIBSQL_URL: libsqlUrl,
    DATABASE_URL: libsqlUrl,
    DATABASE_AUTH_TOKEN: env.LIBSQL_AUTH_TOKEN ?? env.DATABASE_AUTH_TOKEN
  };
}

export function onpremMigrate(opts: RunOpts = {}): void {
  const exec = opts.exec ?? defaultExec;
  const root = opts.root ?? resolve(import.meta.dirname, "..");
  exec("pnpm", ["--filter", "@lyra/db", "migrate"], { cwd: root, env: dbEnv(opts.env ?? process.env, root) });
}

export function onpremSeed(opts: RunOpts & { password?: string } = {}): void {
  const exec = opts.exec ?? defaultExec;
  const root = opts.root ?? resolve(import.meta.dirname, "..");
  const env = dbEnv(opts.env ?? process.env, root);
  if (opts.password) env.SEED_PASSWORD = opts.password;
  exec("pnpm", ["--filter", "@lyra/core", "seed"], { cwd: root, env });
}

// ---------------------------------------------------------------------------
// smoke — reachability + one live round trip.
//
// ponytail: this deliberately re-implements the OpenAI-compat wire shape
// instead of importing packages/model-gateway/src/providers/openai-compat.ts.
// That file is intentionally NOT exported from the package (gateway.ts: "the
// only way to reach a model" — budget/scrub/guardrails/audit wrap every real
// call, CLAUDE.md rule 3). Reaching around that for an ops probe would be the
// exact seam-bypass the guardrails warn against, so this speaks the same
// protocol rather than importing the private module. Upgrade path if this
// ever needs to exercise the real adapter: route it through Gateway.complete()
// with a Ctx built from the seeded on-prem tenant.
export interface TierProbe {
  service: "llm" | "llm-vllm" | "embed";
  url: string;
  reachable: boolean;
  models?: string[];
  detail?: string;
}

export interface RoundTripResult {
  ok: boolean;
  model?: string;
  text?: string;
  error?: string;
}

export interface SmokeReport {
  tiers: TierProbe[];
  roundTrip: RoundTripResult | null;
}

const TIMEOUT_MS = 3000;

async function probeChatTier(
  fetchImpl: typeof fetch,
  service: "llm" | "llm-vllm",
  url: string
): Promise<TierProbe> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { service, url, reachable: false, detail: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { id: string }[] };
    return { service, url, reachable: true, models: (json.data ?? []).map((m) => m.id) };
  } catch (err) {
    return { service, url, reachable: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function probeEmbedTier(fetchImpl: typeof fetch, url: string): Promise<TierProbe> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { service: "embed", url, reachable: false, detail: `HTTP ${res.status}` };
    return { service: "embed", url, reachable: true };
  } catch (err) {
    return { service: "embed", url, reachable: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function chatRoundTrip(fetchImpl: typeof fetch, url: string, model: string): Promise<RoundTripResult> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with the single word: Ok" }]
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (!res.ok) return { ok: false, model, error: json.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, model, text: json.choices?.[0]?.message?.content ?? "" };
  } catch (err) {
    return { ok: false, model, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function onpremSmoke(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<SmokeReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;

  const [llm, vllm, embed] = await Promise.all([
    probeChatTier(fetchImpl, "llm", env.OPENAI_COMPAT_URL ?? "http://localhost:11434/v1"),
    probeChatTier(fetchImpl, "llm-vllm", env.VLLM_COMPAT_URL ?? "http://localhost:8000/v1"),
    probeEmbedTier(fetchImpl, env.EMBEDDINGS_URL ?? "http://localhost:8080")
  ]);

  const chatTier = [llm, vllm].find((t) => t.reachable && t.models?.length);
  // ponytail: naive pick when LYRA_SMOKE_MODEL isn't set — prefer an
  // "instruct" chat model, then anything that isn't an Ollama "cloud"
  // passthrough tag (smoke proves the on-prem estate answers, not a remote
  // provider behind it), then just the first entry. A vision/embedding-only
  // model can still slip through and fail the round trip on a given host.
  const model =
    chatTier &&
    (env.LYRA_SMOKE_MODEL ??
      chatTier.models!.find((m) => m.includes("instruct")) ??
      chatTier.models!.find((m) => !m.endsWith(":cloud")) ??
      chatTier.models![0]);
  const roundTrip = chatTier && model ? await chatRoundTrip(fetchImpl, chatTier.url, model) : null;

  return { tiers: [llm, vllm, embed], roundTrip };
}
