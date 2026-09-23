import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Column } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  asJson,
  devHeadline,
  explain,
  labelsIn,
  mintKey,
  safe,
  type Label,
  type Page,
  type Problemish
} from "./signal.shared";
import type { HookRow, TestPing } from "./admin-developer";

// docs/modules/signal.md §4 screen 7: the integrator's bench. Everything here
// is the real endpoint — the read console runs the same REST list your code
// will, the webhook tester delivers to the real URL, and the sandbox tick is
// the demo spend route the API already exposes outside production.
//
// The spec asks for a pixel/tag debugger and a catalogue feed endpoint. Neither
// exists: `attribution-events` is registered read-only and immutable
// (apps/api/src/resources.ts), so there is no ingest route a tag could post to,
// and `aeo-pages` has no unauthenticated serving route. The screen says so
// rather than shipping a console for a thing that is not there.

/* --------------------------------------------------------------- contract */

const KEYS_READ = "core:api_keys:read";
const MAX_ROWS = 100;

/** The SIGNAL REST lists, with the permission each one's read is gated on. */
export const RESOURCES: ReadonlyArray<{ path: string; permission: string }> = [
  { path: "audiences", permission: PERM.audiencesRead },
  { path: "campaigns", permission: PERM.campaignsRead },
  { path: "creatives", permission: PERM.creativesRead },
  { path: "signal-experiments", permission: PERM.experimentsRead },
  { path: "budget-moves", permission: PERM.movesRead },
  { path: "aeo-pages", permission: PERM.aeoRead },
  { path: "attribution-events", permission: PERM.attributionRead },
  { path: "spend", permission: PERM.spendRead }
];

/**
 * The `lyra-events` topics SIGNAL owns. `emitted` is the honest half: only the
 * autopilot publishes today (apps/api/src/engines/signal-autopilot.ts and
 * apps/api/src/routes/signal.ts). The rest are named by docs/modules/signal.md
 * §6 and nothing raises them yet, so an endpoint subscribed to one waits
 * forever — better said here than discovered in production.
 */
export const TOPICS: ReadonlyArray<{ name: string; emitted: boolean }> = [
  { name: "signal.budget.moved", emitted: true },
  { name: "signal.autopilot.paused", emitted: true },
  { name: "signal.autopilot.resumed", emitted: true },
  { name: "signal.campaign.launched", emitted: false },
  { name: "signal.experiment.concluded", emitted: false },
  { name: "signal.creative.flagged", emitted: false }
];

/* ---------------------------------------------------------------- reading */

/** The events an endpoint subscribes to, however the column came back. */
export function eventsOf(hook: HookRow): string[] {
  const list = asJson<unknown>(hook.eventTypesJson, []);
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Whether an endpoint is one this screen is about. */
export function subscribesToSignal(hook: HookRow): boolean {
  return eventsOf(hook).some((type) => type.startsWith("signal."));
}

/** The console's own request, written out so an integrator can paste it. */
export function curlFor(origin: string, resource: string, limit: number): string {
  return [
    `curl "${origin}/v1/signal/${resource}?limit=${limit}" \\`,
    `  -H "authorization: Bearer $LYRA_API_KEY"`
  ].join("\n");
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const readable = RESOURCES.filter((resource) => held.has(resource.permission)).map((resource) => resource.path);
  const hooks = held.has("core:webhooks:read")
    ? await safe(() => api<Page<HookRow>>("/v1/core/webhooks?limit=100", { env, request }), { data: [] })
    : { data: [] as HookRow[] };

  return {
    readable,
    hooks: hooks.data.filter(subscribesToSignal),
    mayKeys: held.has(KEYS_READ),
    // The sandbox route is demoOnly(): 404 in production (apps/api/src/auth.ts).
    maySandbox: env.ENVIRONMENT !== "production" && held.has(PERM.autopilotRun),
    origin: env.API_ORIGIN,
    key: mintKey("signal-dev")
  };
}

/* ------------------------------------------------------------------ action */

export interface ActionResult {
  problem: Problemish | null;
  done: string | null;
  resource?: string;
  rows?: unknown[];
  ping?: TestPing;
  inserted?: number;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const refuse = (code: string): ActionResult => ({ problem: { title: code, status: 400, code }, done: null });
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const key = text("key") || mintKey("signal-dev");
  const intent = text("intent");

  if (intent === "read") {
    const resource = text("resource");
    if (!RESOURCES.some((one) => one.path === resource)) return refuse("resource_required");
    const limit = Number(text("limit"));
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_ROWS) return refuse("limit_required");

    try {
      const page = await api<Page<unknown>>(`/v1/signal/${resource}?limit=${Math.round(limit)}`, { env, request });
      return { problem: null, done: "read", resource, rows: page.data };
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }
  }

  if (intent === "ping") {
    const hookId = text("hookId");
    if (!hookId) return refuse("hook_required");
    try {
      const ping = await api<TestPing>(`/v1/core/webhooks/${encodeURIComponent(hookId)}/test`, {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": key }
      });
      return { problem: null, done: "ping", ping };
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }
  }

  if (intent !== "tick") return refuse("bad_intent");

  try {
    const ticked = await api<{ inserted: number }>("/v1/signal/demo/spend-tick", {
      env,
      request,
      method: "POST",
      headers: { "idempotency-key": key }
    });
    return { problem: null, done: "tick", inserted: ticked.inserted };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

/* -------------------------------------------------------------- the screen */

export default function SignalDev() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  const first = loaded.readable[0] ?? "";

  const hookColumns: Array<Column<HookRow>> = [
    {
      key: "url",
      header: l("dev.hookUrl"),
      render: (row) => <span className="font-mono text-12 break-all">{row.url}</span>
    },
    {
      key: "events",
      header: l("dev.hookEvents"),
      render: (row) => (
        <span className="flex flex-wrap gap-1">
          {eventsOf(row).map((type) => (
            <Badge key={type} tone="neutral" size="sm">
              <span className="font-mono">{type}</span>
            </Badge>
          ))}
        </span>
      )
    },
    { key: "status", header: l("dev.hookStatus"), render: (row) => row.status },
    {
      key: "test",
      header: l("dev.hookTest"),
      render: (row) => (
        <Form method="post">
          <input type="hidden" name="intent" value="ping" />
          <input type="hidden" name="key" value={loaded.key} />
          <input type="hidden" name="hookId" value={row.id} />
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
            {l("dev.hookTest")}
          </Button>
        </Form>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="eyebrow">{l("dev.kicker")}</span>
        <h1 className="page-title">
          {devHeadline(l, { readable: loaded.readable.length, hooks: loaded.hooks.length })}
        </h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("dev.lede")}</p>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`dev.saved.${result.done}`)}
        </p>
      ) : null}

      {loaded.readable.length === 0 ? (
        <Card title={l("dev.readTitle")} description={l("dev.readLede")}>
          <p className="font-ui text-13 text-muted">{l("dev.denied")}</p>
        </Card>
      ) : (
        <>
          <Card title={l("dev.readTitle")} description={l("dev.readLede")}>
            <div className="flex flex-col gap-4">
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="read" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={l("dev.resource")}>
                    <Select
                      name="resource"
                      defaultValue={result?.resource ?? first}
                      aria-label={l("dev.resource")}
                      options={loaded.readable.map((path) => ({ value: path, label: l(`dev.res.${path}`) }))}
                    />
                  </Field>
                  <Field label={l("dev.limit")} hint={l("dev.limitHint")}>
                    <Input
                      name="limit"
                      type="number"
                      min={1}
                      max={MAX_ROWS}
                      defaultValue="10"
                      aria-label={l("dev.limit")}
                    />
                  </Field>
                </div>
                <div>
                  <Button type="submit" disabled={busy}>
                    {l("dev.read")}
                  </Button>
                </div>
              </Form>

              {result?.rows ? (
                result.rows.length === 0 ? (
                  <EmptyState title={l("dev.readEmpty")} body={l("dev.readEmpty.body")} />
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="font-ui text-13 text-subtle">
                      {l("dev.rows")}: <span className="font-mono text-text">{result.rows.length}</span>
                    </p>
                    <details>
                      <summary className="cursor-pointer font-ui text-13 text-accent">{l("dev.raw")}</summary>
                      <pre className="mt-2 max-h-[28rem] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
                        {JSON.stringify({ data: result.rows }, null, 2)}
                      </pre>
                    </details>
                  </div>
                )
              ) : null}
            </div>
          </Card>

          <Card title={l("dev.curlTitle")} description={l("dev.curlLede")}>
            <div className="flex flex-col gap-3">
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
                {curlFor(loaded.origin, result?.resource ?? first, 10)}
              </pre>
              {loaded.mayKeys ? (
                <Link to="/admin/developer" className="font-ui text-13 text-accent underline underline-offset-2">
                  {l("dev.keysOpen")}
                </Link>
              ) : null}
            </div>
          </Card>

          <Card title={l("dev.pixelTitle")} description={l("dev.pixelLede")} />
          <Card title={l("dev.feedTitle")} description={l("dev.feedLede")} />
        </>
      )}

      <Card title={l("dev.hooksTitle")} description={l("dev.hooksLede")}>
        <div className="flex flex-col gap-3">
          <Table
            caption={l("dev.hookCaption")}
            columns={hookColumns}
            rows={loaded.hooks}
            rowKey={(row) => row.id}
            empty={<EmptyState title={l("dev.hooksEmpty")} body={l("dev.hooksEmpty.body")} />}
          />
          {result?.ping ? <Ping ping={result.ping} l={l} /> : null}
        </div>
      </Card>

      <Card title={l("dev.topicsTitle")} description={l("dev.topicsLede")}>
        <ul className="flex flex-col gap-2">
          {TOPICS.map((topic) => (
            <li key={topic.name} className="flex flex-wrap items-center gap-2 font-ui text-13">
              <span className="font-mono text-12 text-text">{topic.name}</span>
              <Badge tone={topic.emitted ? "success" : "neutral"} size="sm" dot>
                {l(topic.emitted ? "dev.topicLive" : "dev.topicPlanned")}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      {loaded.maySandbox ? (
        <Card title={l("dev.sandboxTitle")} description={l("dev.sandboxLede")}>
          <div className="flex flex-col gap-3">
            <Form method="post">
              <input type="hidden" name="intent" value="tick" />
              <input type="hidden" name="key" value={loaded.key} />
              <Button type="submit" variant="secondary" disabled={busy}>
                {l("dev.sandboxRun")}
              </Button>
            </Form>
            {result?.inserted === undefined ? null : (
              <p className="font-ui text-13 text-subtle">
                {l("dev.sandboxDone", { inserted: String(result.inserted) })}
              </p>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Ping({ ping, l }: { ping: TestPing; l: Label }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={ping.ok ? "success" : "danger"} size="sm" dot>
        {ping.ok ? l("dev.pingOk", { status: String(ping.status ?? 200) }) : l("dev.pingFailed")}
      </Badge>
      {ping.error ? (
        <p role="alert" className="font-ui text-12 text-danger">
          {ping.error}
        </p>
      ) : null}
    </div>
  );
}
