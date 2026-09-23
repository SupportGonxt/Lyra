import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, DateTime, EmptyState, Field, GuardrailNotice, Input, Panel, Table, Textarea, type Column } from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { jsonOf } from "../json.js";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import { emptyPage, explain, labelsIn, refuse, safe, type Page, type Problemish } from "./scout.shared";

// SCOUT dev (docs/modules/scout.md §4 screen 7): the integrator's bench for the
// two SCOUT surfaces that are not CRUD — the market index and the wording
// differ. Both consoles call the real endpoints, so what an integrator sees
// here is what their key will get.
//
// There is no ingest console. Writing a signal needs `scout:signals:ingest`,
// which only an API key minted for the harvester carries, and a screen that
// posts one from the browser would teach an integrator the wrong shape. The
// contract is shown as curl instead.

/* --------------------------------------------------------------- constants */

const KEYS_PERM = "core:api_keys:read";

/** The endpoint's own bound (apps/api/src/routes/scout.ts SimilarBody). */
const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 10;
const MAX_TEXT = 4_000;

/* ------------------------------------------------------------------ shapes */

export interface Match {
  id: string;
  source: string;
  observedAt: number;
  score: number;
}

/** Mirrors packages/core/src/wording-diff.ts DiffSpan — the web app cannot
 *  import @lyra/core (same reason approvals.tsx restates the approval states). */
export interface Span {
  type: "equal" | "insert" | "delete";
  text: string;
}

/** `scout_signals` as generic CRUD returns it — see `r("signals", …)` in
 *  apps/api/src/resources.ts. */
interface SignalRow {
  id: string;
  source: string;
  /** Already parsed on the wire — see `jsonOf`. */
  payloadJson: unknown;
  observedAt: number;
}

/* ----------------------------------------------------------------- helpers */

/** The typed top-K, or null when it is not a whole number the endpoint takes. */
export function topKOf(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 1 && value <= MAX_TOP_K ? value : null;
}

/** How much of the wording actually moved, for a one-line read of the diff. */
export function wordCounts(spans: readonly Span[]): { added: number; removed: number; kept: number } {
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  return {
    added: spans.filter((one) => one.type === "insert").reduce((sum, one) => sum + words(one.text), 0),
    removed: spans.filter((one) => one.type === "delete").reduce((sum, one) => sum + words(one.text), 0),
    kept: spans.filter((one) => one.type === "equal").reduce((sum, one) => sum + words(one.text), 0)
  };
}

/** The console's own request, written out so an integrator can paste it. */
export function curlFor(origin: string, path: string, body: unknown): string {
  return [
    `curl -X POST ${origin}${path} \\`,
    `  -H "authorization: Bearer $LYRA_API_KEY" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '${JSON.stringify(body)}'`
  ].join("\n");
}

/** A seeded signal's own text, so the playground starts on something real. */
export function sampleText(rows: readonly SignalRow[]): string {
  const payload = rows[0]?.payloadJson;
  if (payload === undefined || payload === null || payload === "") return "";
  const parsed = jsonOf(payload);
  const text = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).text : null;
  if (typeof text === "string") return text;
  // No `text` key: the envelope itself, so the playground still opens on
  // something the tenant actually ingested.
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const recent = await safe(
    () =>
      api<Page<SignalRow>>("/v1/scout/signals?sort=observedAt&order=desc&limit=1", { env, request }),
    emptyPage<SignalRow>()
  );
  return { origin: env.API_ORIGIN, sample: sampleText(recent.data) };
}

/* ------------------------------------------------------------------ action */

export interface DevResult {
  problem: Problemish | null;
  done: "similar" | "diff" | null;
  matches?: Match[];
  spans?: Span[];
  topK?: number;
  text?: string;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<DevResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "diff") {
    const textA = String(form.get("textA") ?? "").trim();
    const textB = String(form.get("textB") ?? "").trim();
    if (textA === "" || textB === "") return refuse("both_texts");
    try {
      const result = await api<{ spans: Span[] }>("/v1/scout/wording-diff", {
        env,
        request,
        method: "POST",
        body: { textA, textB }
      });
      return { problem: null, done: "diff", spans: result.spans };
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }
  }

  if (intent !== "similar") return refuse("bad_intent");

  const text = String(form.get("text") ?? "").trim();
  if (text === "") return refuse("text_required");
  if (text.length > MAX_TEXT) return refuse("text_too_long");
  const topK = topKOf(String(form.get("topK") ?? ""));
  if (topK === null) return refuse("bad_topk");

  try {
    const result = await api<{ matches: Match[] }>("/v1/scout/signals/similar", {
      env,
      request,
      method: "POST",
      body: { text, topK }
    });
    return { problem: null, done: "similar", matches: result.matches, topK, text };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

/* -------------------------------------------------------------- the screen */

const TONE: Record<Span["type"], string> = {
  equal: "text-muted",
  insert: "bg-success/15 text-success",
  delete: "bg-danger/15 text-danger line-through"
};

export default function ScoutDev() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";

  const columns: Column<Match>[] = [
    {
      key: "id",
      header: l("dev.col.signal"),
      render: (row) => <span className="font-mono text-12">{row.id}</span>
    },
    { key: "source", header: l("dev.col.source"), render: (row) => l(`adm.source.${row.source}`) },
    {
      key: "observedAt",
      header: l("dev.col.observed"),
      render: (row) => <DateTime value={row.observedAt} locale={locale} />
    },
    {
      key: "score",
      header: l("dev.col.score"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{row.score.toFixed(3)}</span>
    }
  ];

  const counts = result?.spans ? wordCounts(result.spans) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{l("dev.title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("dev.lede")}</p>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`dev.ran.${result.done}`)}
        </p>
      ) : null}

      <Panel module="scout" eyebrow={l("dev.similar")} lede={l("dev.similarWhy")}>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="similar" />
          <Field label={l("dev.text")} hint={l("dev.textHint", { max: String(MAX_TEXT) })}>
            <Textarea
              name="text"
              rows={3}
              maxLength={MAX_TEXT}
              defaultValue={result?.text ?? loaded.sample}
              aria-label={l("dev.text")}
            />
          </Field>
          <Field label={l("dev.topK")} hint={l("dev.topKHint", { max: String(MAX_TOP_K) })}>
            <Input
              name="topK"
              inputMode="numeric"
              defaultValue={String(result?.topK ?? DEFAULT_TOP_K)}
              aria-label={l("dev.topK")}
            />
          </Field>
          <div>
            <Button type="submit" disabled={busy}>
              {l("dev.run")}
            </Button>
          </div>
        </Form>

        {result?.matches ? (
          <div className="mt-5 flex flex-col gap-3">
            <Table
              columns={columns}
              rows={result.matches}
              rowKey={(row) => row.id}
              caption={l("dev.matchesCaption")}
              empty={<EmptyState title={l("dev.noMatches")} body={l("dev.noMatchesWhy")} />}
            />
            <details>
              <summary className="cursor-pointer font-ui text-13 text-accent">{l("dev.raw")}</summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
                {JSON.stringify({ matches: result.matches }, null, 2)}
              </pre>
            </details>
          </div>
        ) : null}
      </Panel>

      <Panel module="scout" eyebrow={l("dev.diff")} lede={l("dev.diffWhy")}>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="diff" />
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label={l("dev.textA")}>
              <Textarea name="textA" rows={5} aria-label={l("dev.textA")} />
            </Field>
            <Field label={l("dev.textB")}>
              <Textarea name="textB" rows={5} aria-label={l("dev.textB")} />
            </Field>
          </div>
          <div>
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("dev.diffRun")}
            </Button>
          </div>
        </Form>

        {result?.spans && counts ? (
          <div className="mt-5 flex flex-col gap-3">
            <p className="font-ui text-13 text-muted">
              {l("dev.diffCounts", {
                added: String(counts.added),
                removed: String(counts.removed),
                kept: String(counts.kept)
              })}
            </p>
            <p className="max-w-prose font-ui text-13 leading-relaxed text-text">
              {result.spans.map((span, at) => (
                <span key={`${span.type}-${at}`} className={`${TONE[span.type]} rounded-sm px-0.5`}>
                  {span.text}{" "}
                </span>
              ))}
            </p>
          </div>
        ) : null}
      </Panel>

      <Panel module="scout" eyebrow={l("dev.curl")} lede={l("dev.curlWhy")}>
        <div className="flex flex-col gap-3">
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
            {curlFor(loaded.origin, "/v1/scout/signals/similar", {
              text: loaded.sample || "EV cover withdrawn",
              topK: DEFAULT_TOP_K
            })}
          </pre>
          <p className="max-w-prose font-ui text-13 text-muted">{l("dev.ingestWhy")}</p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
            {curlFor(loaded.origin, "/v1/scout/signals", {
              source: "news",
              sourceRef: "https://example.com/article",
              payloadJson: JSON.stringify({ text: "Carrier withdraws EV cover in the Emirates" }),
              observedAt: 1_770_000_000_000
            })}
          </pre>
          {may.has(KEYS_PERM) ? (
            <Link to="/admin/developer" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
              {l("dev.keys")}
            </Link>
          ) : null}
        </div>
      </Panel>

      <GuardrailNotice tone="info" title={l("dev.noEvents")} reason={l("dev.noEventsWhy")} />

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/radar" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("dev.openRadar")}
        </Link>
        <Link to="/scout/panel" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("dev.openPanel")}
        </Link>
      </footer>
    </div>
  );
}
