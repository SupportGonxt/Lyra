import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, Card, DateTime, EmptyState, Field, GuardrailNotice, Ref, Select } from "@lyra/ui";
import { ApiError, api, names } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  K_FLOOR,
  PERM,
  emptyPage,
  explain,
  labelsIn,
  mintKey,
  refuse,
  safe,
  type Label,
  type Page,
  type Problemish
} from "./scout.shared";
import { jsonOf } from "../json.js";

// Selling insight back to the panel (docs/modules/scout.md §4 screen 5). Four
// things have to be on one screen or the product is indefensible: what the cut
// is, who receives it, the floor below which its cells are suppressed, and
// whether the last build actually ran.
//
// Nothing here is recomputed. The cut, its refresh cadence and its last run are
// the definition blob the builder wrote; the subscribers are the subscribers
// column, suspensions included; the floor is `aggregation_min` on the row. The
// delivery log is the platform's own export table filtered to this product —
// SCOUT does not keep a second one — so a product with no file cut yet reads as
// exactly that rather than as a delivery that happened.
//
// The one judgement the screen makes is arithmetic: a floor under the module's
// k-anonymity floor cannot be published from here, because publishing is what
// exposes the thin cells.

const LIMIT = 100;
const DELIVERIES = 20;

/** `analytics_exports.subject_ref` for a cut of this product. */
export const subjectRefOf = (id: string): string => `scout_data_product:${id}`;

export interface DataProductRow {
  id: string;
  name: string;
  /** Already parsed on the wire — see `jsonOf`. */
  definitionJson: unknown;
  consentBasis: string;
  aggregationMin: number;
  /** Already parsed on the wire — see `jsonOf`. */
  subscribersJson: unknown;
  delivery: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExportRow {
  id: string;
  format: string;
  state: string;
  rowCount: number | null;
  piiMasked: boolean;
  requestedBy: string;
  createdAt: number;
  error: string | null;
}

export interface Definition {
  source: string | null;
  dimensions: string[];
  measures: string[];
  window: string | null;
  cadence: string | null;
  lastRunAt: number | null;
  /** fresh|stale|never_run|halted, as the builder wrote it. */
  refreshState: string | null;
  failure: string | null;
  note: string | null;
}

export interface Subscriber {
  providerId: string;
  since: number | null;
  suspendedAt: number | null;
}

const bag = (raw: unknown): Record<string, unknown> => {
  const parsed = jsonOf(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
};

const text = (from: Record<string, unknown>, key: string): string | null =>
  typeof from[key] === "string" ? (from[key] as string) : null;

const list = (from: Record<string, unknown>, key: string): string[] =>
  Array.isArray(from[key]) ? (from[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

export function definitionOf(row: DataProductRow): Definition {
  const body = bag(row.definitionJson);
  const refresh = body.refresh && typeof body.refresh === "object" ? (body.refresh as Record<string, unknown>) : {};
  return {
    source: text(body, "source"),
    dimensions: list(body, "dimensions"),
    measures: list(body, "measures"),
    window: text(body, "window"),
    cadence: text(refresh, "cadence"),
    lastRunAt: typeof refresh.lastRunAt === "number" ? refresh.lastRunAt : null,
    refreshState: text(refresh, "state"),
    failure: text(refresh, "failure"),
    note: text(body, "note") ?? text(body, "suppression")
  };
}

export function subscribersOf(row: DataProductRow): Subscriber[] {
  const parsed = jsonOf(row.subscribersJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.providerId !== "string") return [];
    return [
      {
        providerId: item.providerId,
        since: typeof item.since === "number" ? item.since : null,
        suspendedAt: typeof item.suspendedAt === "number" ? item.suspendedAt : null
      }
    ];
  });
}

export const activeSubscribers = (row: DataProductRow): Subscriber[] =>
  subscribersOf(row).filter((one) => one.suspendedAt === null);

/**
 * What the monitor has against a product, worst first. `belowFloor` is
 * arithmetic against the module's k-anonymity floor; `singleCounterparty` is a
 * cut keyed on the counterparty itself, where every cell names one provider
 * however high the floor is (the seeded latency benchmark is exactly this, and
 * it is why that product is suspended).
 */
export function warningsFor(row: DataProductRow, floor: number = K_FLOOR): string[] {
  const out: string[] = [];
  if (row.aggregationMin < floor) out.push("belowFloor");
  if (definitionOf(row).dimensions.includes("providerId")) out.push("singleCounterparty");
  const refresh = definitionOf(row).refreshState;
  if (row.status === "published" && (refresh === "stale" || refresh === "halted")) out.push("staleFeed");
  return out;
}

/** The state a publisher may move a product to from where it stands. */
export function nextProductStates(from: string): string[] {
  switch (from) {
    case "draft":
      return ["published"];
    case "published":
      return ["suspended"];
    case "suspended":
      return ["published", "draft"];
    default:
      return [];
  }
}

/** The one sentence the catalogue opens with — publish and warning counts
 *  already on every row, no ✦ (arithmetic, not an agent's finding, CLAUDE.md
 *  §11). */
export function dtpHeadline(rows: DataProductRow[], l: Label, floor: number = K_FLOOR): string {
  if (rows.length === 0) return l("dtp.title");
  const published = rows.filter((row) => row.status === "published").length;
  const flagged = rows.filter((row) => warningsFor(row, floor).length > 0).length;
  if (flagged > 0) return l("dtp.headlineFlagged", { n: String(flagged), total: String(rows.length) });
  return l("dtp.headlinePublished", { n: String(published), total: String(rows.length) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const chosen = new URL(request.url).searchParams.get("product") ?? "";

  const page = await safe(
    () =>
      api<Page<DataProductRow>>(`/v1/scout/data-products?sort=updatedAt&order=desc&limit=${LIMIT}`, { env, request }),
    emptyPage<DataProductRow>()
  );
  const rows = page.data;
  const product = rows.find((row) => row.id === chosen) ?? rows[0] ?? null;

  // docs/27 P2 K_FLOOR follow-up: the resolved tenant value, not the compiled
  // default — falls back to it on a permission or network failure, same as
  // every other best-effort read on this loader.
  const kFloor = await safe(
    () => api<{ kFloor: number }>("/v1/scout/config", { env, request }).then((r) => r.kFloor),
    K_FLOOR
  );

  const [named, deliveries] = await Promise.all([
    names(
      rows.flatMap((row) => subscribersOf(row).map((one) => one.providerId)),
      { env, request }
    ),
    product === null
      ? Promise.resolve(emptyPage<ExportRow>())
      : safe(
          () =>
            api<Page<ExportRow>>(
              `/v1/analytics/exports?subjectRef=${encodeURIComponent(subjectRefOf(product.id))}&sort=createdAt&order=desc&limit=${DELIVERIES}`,
              { env, request }
            ),
          // A withheld export read costs the delivery log, not the catalogue.
          emptyPage<ExportRow>()
        )
  ]);

  return {
    rows,
    productId: product?.id ?? null,
    named,
    deliveries: deliveries.data,
    moves: product === null ? [] : nextProductStates(product.status),
    key: mintKey("scout-dtp"),
    kFloor
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: { status: string } | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const key = String(form.get("key") ?? "") || mintKey("scout-dtp");

  if (String(form.get("intent") ?? "") !== "move") return refuse("bad_intent");

  const id = String(form.get("productId") ?? "");
  if (id === "") return refuse("product_required");

  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  if (!nextProductStates(from).includes(to)) return refuse("transition_required");

  // The floor is the whole guarantee. Publishing a cut floored under the
  // module's k-anonymity floor is the one move this screen refuses outright —
  // lower the cells or raise the floor, but not from a publish button. The
  // authoritative check is resources.ts's beforeWrite on this resource (any
  // caller, any tenant floor); this is a same-request pre-check against the
  // resolved value, for the polished bilingual message instead of a bare
  // ApiError round trip.
  const floor = Number(form.get("floor") ?? "0");
  if (to === "published" && Number.isFinite(floor)) {
    const kFloor = await safe(
      () => api<{ kFloor: number }>("/v1/scout/config", { env, request }).then((r) => r.kFloor),
      K_FLOOR
    );
    if (floor < kFloor) return refuse("floor_too_low");
  }

  try {
    await api<DataProductRow>(`/v1/scout/data-products/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      body: { status: to },
      headers: { "idempotency-key": key }
    });
    return { problem: null, done: { status: to } };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function ScoutDataProducts() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const [params, setParams] = useSearchParams();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";

  const product = loaded.rows.find((row) => row.id === loaded.productId) ?? null;

  if (loaded.rows.length === 0 || product === null) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-serif text-22 leading-[1.2] text-text">{dtpHeadline(loaded.rows, l, loaded.kFloor)}</h1>
            <p className="font-ui text-13 text-muted">{l("dtp.lede")}</p>
          </div>
        </header>
        <EmptyState title={l("dtp.empty")} body={l("dtp.empty.body")} />
      </div>
    );
  }

  const published = loaded.rows.filter((row) => row.status === "published");
  const flagged = loaded.rows.filter((row) => warningsFor(row, loaded.kFloor).length > 0);
  const definition = definitionOf(product);
  const subscribers = subscribersOf(product);
  const warnings = warningsFor(product, loaded.kFloor);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-22 leading-[1.2] text-text">{l("dtp.title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("dtp.lede")}</p>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}

      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("dtp.moved", { status: l(`dtp.status.${result.done.status}`) })}
        </p>
      ) : null}

      <Card title={l("dtp.monitor")} description={l("dtp.monitorHint")}>
        <dl className="mt-3 grid gap-4 sm:grid-cols-4">
          <Metric label={l("dtp.published")} value={String(published.length)} />
          <Metric label={l("dtp.floor")} value={String(loaded.kFloor)} />
          <Metric label={l("dtp.subscribing")} value={String(new Set(published.flatMap((row) => activeSubscribers(row).map((one) => one.providerId))).size)} />
          <Metric label={l("dtp.flagged")} value={String(flagged.length)} />
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title={l("dtp.catalogue")} description={l("dtp.catalogueHint")}>
          <ul className="mt-3 flex flex-col gap-2">
            {loaded.rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("product", row.id);
                    setParams(next, { preventScrollReset: true });
                  }}
                  aria-current={row.id === product.id ? "true" : undefined}
                  className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-start ${
                    row.id === product.id ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2"
                  }`}
                >
                  <span className="font-ui text-13 text-text">{row.name}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={toneFor(row.status)} size="sm">
                      {l(`dtp.status.${row.status}`)}
                    </Badge>
                    <span className="font-ui text-12 text-subtle">{l(`dtp.delivery.${row.delivery}`)}</span>
                    <span className="font-ui text-12 text-subtle">
                      {l("dtp.k", { floor: String(row.aggregationMin) })}
                    </span>
                    {warningsFor(row, loaded.kFloor).length > 0 ? (
                      <Badge tone="warning" size="sm">
                        {l(`dtp.warn.${warningsFor(row, loaded.kFloor)[0]}`)}
                      </Badge>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-6">
          <Card title={product.name} description={l("dtp.cutHint")}>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={toneFor(product.status)}>{l(`dtp.status.${product.status}`)}</Badge>
              <span className="font-ui text-12 text-subtle">{l(`dtp.delivery.${product.delivery}`)}</span>
              <Ref value={product.id} />
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <Line label={l("dtp.source")} value={definition.source ?? l("none")} />
              <Line label={l("dtp.window")} value={definition.window ?? l("none")} />
              <Line
                label={l("dtp.dimensions")}
                value={definition.dimensions.length === 0 ? l("none") : definition.dimensions.join(" · ")}
              />
              <Line
                label={l("dtp.measures")}
                value={definition.measures.length === 0 ? l("none") : definition.measures.join(" · ")}
              />
              <Line label={l("dtp.consent")} value={product.consentBasis} />
              <Line label={l("dtp.k", { floor: String(product.aggregationMin) })} value={l("dtp.kHint")} />
            </dl>
            {definition.note === null ? null : (
              <p className="mt-3 max-w-prose font-ui text-12 text-subtle">{definition.note}</p>
            )}
            <p className="mt-3 font-ui text-12 text-subtle">
              {definition.cadence === null ? l("dtp.noCadence") : l("dtp.cadence", { cadence: definition.cadence })}{" "}
              {definition.refreshState === null ? null : l(`dtp.refresh.${definition.refreshState}`)}{" "}
              {definition.lastRunAt === null ? null : <DateTime value={definition.lastRunAt} locale={locale} />}
            </p>
            {definition.failure === null ? null : (
              <GuardrailNotice tone="warning" title={l("dtp.buildFailed")} reason={definition.failure} />
            )}
            {warnings.map((warning) => (
              <GuardrailNotice
                key={warning}
                tone="warning"
                title={l(`dtp.warn.${warning}`)}
                reason={l(`dtp.warnWhy.${warning}`, { floor: String(loaded.kFloor) })}
              />
            ))}
          </Card>

          <Card title={l("dtp.subscribers")} description={l("dtp.subscribersHint")}>
            {subscribers.length === 0 ? (
              <EmptyState title={l("dtp.noSubscribers")} body={l("dtp.noSubscribers.body")} />
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {subscribers.map((one) => (
                  <li key={one.providerId} className="flex flex-col gap-1 border-b border-line pb-3 last:border-0">
                    <span className="font-ui text-13 text-text">{loaded.named[one.providerId] ?? one.providerId}</span>
                    <span className="flex flex-wrap items-center gap-2 font-ui text-12 text-subtle">
                      {one.since === null ? l("none") : <DateTime value={one.since} locale={locale} />}
                      {one.suspendedAt === null ? (
                        <Badge tone="success" size="sm">
                          {l("dtp.active")}
                        </Badge>
                      ) : (
                        <Badge tone="warning" size="sm">
                          {l("dtp.suspendedOn")}
                        </Badge>
                      )}
                      {one.suspendedAt === null ? null : <DateTime value={one.suspendedAt} locale={locale} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={l("dtp.deliveries")} description={l("dtp.deliveriesHint")}>
            {loaded.deliveries.length === 0 ? (
              <EmptyState title={l("dtp.noDeliveries")} body={l("dtp.noDeliveries.body")} />
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {loaded.deliveries.map((row) => (
                  <li key={row.id} className="flex flex-col gap-1 border-b border-line pb-3 last:border-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={row.state === "failed" ? "danger" : "neutral"} size="sm">
                        {row.state}
                      </Badge>
                      <span className="font-ui text-13 text-text">{row.format.toUpperCase()}</span>
                      <span className="font-ui text-12 text-subtle">
                        {row.rowCount === null ? l("none") : row.rowCount.toLocaleString(locale)}
                      </span>
                      <DateTime value={row.createdAt} locale={locale} />
                    </span>
                    {row.error === null ? null : <span className="font-ui text-12 text-danger">{row.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {may.has(PERM.dataProductsPublish) ? (
        <Card title={l("dtp.move")} description={l("dtp.moveHint")}>
          {loaded.moves.length === 0 ? (
            <EmptyState title={l("dtp.noMoves")} body={l("dtp.noMoves.body")} />
          ) : (
            <Form method="post" className="mt-2 flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="move" />
              <input type="hidden" name="key" value={loaded.key} />
              <input type="hidden" name="productId" value={product.id} />
              <input type="hidden" name="from" value={product.status} />
              <input type="hidden" name="floor" value={String(product.aggregationMin)} />
              <Field label={l("dtp.target")} id="to">
                <Select
                  name="to"
                  defaultValue={loaded.moves[0] ?? ""}
                  options={loaded.moves.map((state) => ({ value: state, label: l(`dtp.status.${state}`) }))}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {l("dtp.move")}
              </Button>
            </Form>
          )}
        </Card>
      ) : (
        <GuardrailNotice tone="info" title={l("dtp.move")} reason={l("dtp.moveDenied")} />
      )}

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/radar" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("dtp.openRadar")}
        </Link>
      </footer>
    </div>
  );
}

const toneFor = (status: string): "success" | "warning" | "neutral" =>
  status === "published" ? "success" : status === "suspended" ? "warning" : "neutral";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-12 text-subtle">{label}</dt>
      <dd className="font-serif text-22 text-text">{value}</dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-12 text-subtle">{label}</dt>
      <dd className="font-ui text-13 text-text">{value}</dd>
    </div>
  );
}

export type { Label };
