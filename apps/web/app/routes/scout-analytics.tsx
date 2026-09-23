import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  GuardrailNotice,
  KPIWall,
  Select,
  Stat,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, names } from "../api.server";
import { cloudflare } from "../context";
import { who } from "../names";
import { Gate } from "./staff";
import { useScoutSessionData } from "./scout-shell";
import {
  PERM,
  adequacy,
  elasticities,
  emptyPage,
  explain,
  indexText,
  labelsIn,
  safe,
  weighted,
  type Elasticity,
  type Label,
  type Page,
  type PanelRow,
  type Problemish
} from "./scout.shared";

// What the bench says once every period is on the table: how the win rate moved
// when the price moved, and how much of our volume is actually priced to win.
//
// Elasticity here is observed, not modelled — the last two priced periods of one
// provider × line, nothing fitted across them — because a curve drawn through
// two points is a curve nobody should price against. Where the price did not
// move the ratio is withheld rather than divided by something near zero.
//
// The export card does not export the bench. Competitor prices are commercially
// sensitive and the report engine's dataset registry deliberately has no
// price-bench entry (apps/api/src/engines/report.ts), so the datasets on offer
// are the pipeline, the signal volume that fed it, clusters, experiments and
// data products, and the notice says why the bench is missing rather than
// leaving it look like an oversight.

/** apps/api/src/routes/analytics.ts ExportBody.format. */
const FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/** apps/api/src/engines/report.ts DATASETS — the SCOUT entries, and their
 *  registered metrics/dimensions. An unregistered name is a 400. Panel bench
 *  is deliberately absent from the registry (see report.ts's own comment) —
 *  a generic group-by has no k-anonymity floor, so it stays out of both the
 *  server registry and this mirror. */
const DATASETS = {
  whitespaces: { metrics: ["whitespaces", "demand", "avgCompetition"], dimensions: ["status"] },
  signals: { metrics: ["signals", "weight"], dimensions: ["source"] },
  clusters: { metrics: ["clusters", "avgMomentum", "size"], dimensions: ["theme"] },
  experiments: { metrics: ["experiments"], dimensions: ["state"] },
  dataProducts: { metrics: ["dataProducts", "avgFloor"], dimensions: ["status"] }
} as const;

type Dataset = keyof typeof DATASETS;

interface ExportRow {
  id: string;
  format: string;
  /** queued|rendering|ready|failed|expired — rendering happens inside the POST,
   *  so what comes back is already final. */
  state: string;
  rowCount: number | null;
  expiresAt: number | null;
  error: string | null;
}

const LIMIT = 200;

/** The one sentence analytics opens with — the adequacy share already on the
 *  KPI wall, no ✦ (arithmetic, not an agent's finding, CLAUDE.md §11). */
export function analyticsHeadline(periods: number, share: number | null, l: Label): string {
  if (periods === 0) return l("an.title");
  if (share !== null) return l("an.headlineAdequacy", { pct: String(Math.round(share)), periods: String(periods) });
  return l("an.headlineCount", { n: String(periods) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const bench = await safe(
    () => api<Page<PanelRow>>(`/v1/scout/panel-bench?sort=period&order=desc&limit=${LIMIT}`, { env, request }),
    emptyPage<PanelRow>()
  );

  const rows = bench.data;
  const moved = elasticities(rows);
  // The elasticity rows carry provider ids and nothing readable (ADR-0048).
  const resolved = await names(
    moved.map((row) => row.providerId),
    { env, request }
  );

  return {
    apiOrigin: env.API_ORIGIN,
    periods: new Set(rows.map((row) => row.period)).size,
    winRate: weighted(rows, (row) => row.winRate),
    ourIdx: weighted(rows, (row) => row.ourPriceIdx),
    marketIdx: weighted(rows, (row) => row.marketPriceIdx),
    adequacy: adequacy(rows),
    elasticities: moved,
    resolved
  };
}

export interface ActionResult {
  problem: Problemish | null;
  exported: ExportRow | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const dataset = String(form.get("dataset") ?? "");
  const format = String(form.get("format") ?? "");

  if (String(form.get("intent") ?? "") !== "export")
    return { problem: { title: "bad_intent", status: 400, code: "bad_intent" }, exported: null };
  // The bench arrives here as `panelBench` when somebody hand-builds the form;
  // it is refused at the screen rather than as a 400 from the registry.
  if (!Object.hasOwn(DATASETS, dataset))
    return { problem: { title: "dataset_required", status: 400, code: "dataset_required" }, exported: null };
  if (!FORMATS.some((allowed) => allowed === format))
    return { problem: { title: "format_required", status: 400, code: "format_required" }, exported: null };

  const registered = DATASETS[dataset as Dataset];
  // One clock reading for both ends of the window, as signal-analytics does.
  const now = Date.now();
  try {
    const exported = await api<ExportRow>("/v1/analytics/exports", {
      env,
      request,
      method: "POST",
      body: {
        format,
        definition: {
          dataset,
          metrics: [...registered.metrics],
          dimensions: [...registered.dimensions],
          grain: "month",
          // A year: the pipeline is measured in quarters, not days.
          from: now - 365 * 86_400_000,
          to: now
        },
        totals: true
      }
    });
    return { problem: null, exported };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, exported: null };
    throw error;
  }
}

export default function ScoutAnalytics() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useScoutSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const exported = result?.exported ?? null;
  const share = loaded.adequacy.priced > 0 ? (loaded.adequacy.atOrBelow / loaded.adequacy.priced) * 100 : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {analyticsHeadline(loaded.periods, share, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("an.lede")}</p>
        </div>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}

      <KPIWall>
        <Stat label={l("an.periods")} value={loaded.periods.toLocaleString(locale)} />
        <Stat
          label={l("an.winRate")}
          value={loaded.winRate === null ? l("none") : pct(locale, loaded.winRate)}
        />
        <Stat
          label={l("an.index")}
          value={indexText(loaded.ourIdx, locale) ?? l("none")}
          hint={indexText(loaded.marketIdx, locale) ?? undefined}
        />
        <Stat label={l("an.adequacy")} value={share === null ? l("none") : pct(locale, share)} />
        <Stat label={l("an.pricedVolume")} value={loaded.adequacy.priced.toLocaleString(locale)} />
      </KPIWall>

      <Card title={l("an.elasticity")} description={l("an.elasticityHint")}>
        {loaded.elasticities.length === 0 ? (
          <EmptyState title={l("an.empty")} body={l("an.empty.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("an.elasticity")}
            captionHidden
            rowKey={(row) => `${row.providerId}:${row.line}`}
            rows={loaded.elasticities}
            columns={elasticityColumns(l, locale, loaded.resolved)}
          />
        )}
      </Card>

      {may.has(PERM.exportCreate) ? (
        <Card title={l("an.export")} description={l("an.exportHint")}>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="export" />
            <Field label={l("an.dataset")} required>
              <Select
                name="dataset"
                defaultValue="whitespaces"
                options={(Object.keys(DATASETS) as Dataset[]).map((dataset) => ({
                  value: dataset,
                  label: l(`an.${dataset}`)
                }))}
              />
            </Field>
            <Field label={l("an.format")} required>
              <Select
                name="format"
                defaultValue="xlsx"
                options={FORMATS.map((format) => ({ value: format, label: l(format) }))}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("an.export")}
            </Button>
          </Form>

          {exported ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="font-ui text-13 text-text">
                {exported.state === "ready" ? l("an.exportReady") : l("an.exportQueued")}
              </span>
              <Badge tone={exported.state === "ready" ? "success" : "neutral"} size="sm" dot>
                {l(exported.format)}
              </Badge>
              {exported.error ? (
                <span role="alert" className="font-ui text-12 text-danger">
                  {exported.error}
                </span>
              ) : null}
              {exported.state === "ready" ? (
                <Button asChild variant="secondary" size="sm">
                  <a href={`${loaded.apiOrigin}/v1/analytics/exports/${exported.id}/download`} rel="noopener">
                    {l("an.download")}
                  </a>
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <GuardrailNotice
        tone="info"
        title={l("an.benchNotExportable")}
        reason={l("an.benchNotExportableWhy")}
      />

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/panel" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("an.openPanel")}
        </Link>
        <Link to="/scout/pricing" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("price.title")}
        </Link>
      </footer>
    </div>
  );
}

const pct = (locale: string, value: number): string =>
  `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;

/** A signed move, said as a number rather than a word: these two columns are
 *  read against each other, so the sign is the point. */
const signed = (locale: string, value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 1 })}`;

export function elasticityColumns(
  l: Label,
  locale: string,
  resolved: Record<string, string> = {}
): Array<Column<Elasticity>> {
  return [
    { key: "providerId", header: l("insurer"), render: (row) => who(row.providerId, resolved) },
    { key: "line", header: l("line"), render: (row) => row.line },
    {
      key: "window",
      header: l("an.window"),
      // Two periods joined by a separator rather than an arrow, which points the
      // wrong way once the page is in Arabic.
      render: (row) => `${row.fromPeriod} · ${row.toPeriod}`
    },
    {
      key: "move",
      header: l("an.move"),
      numeric: true,
      render: (row) => `${signed(locale, row.idxPct)}%`
    },
    {
      key: "winMove",
      header: l("an.winMove"),
      numeric: true,
      render: (row) => signed(locale, row.winDelta)
    },
    {
      key: "ratio",
      header: l("an.ratio"),
      numeric: true,
      render: (row) =>
        row.ratio === null ? (
          <span className="text-subtle">{l("an.held")}</span>
        ) : (
          row.ratio.toLocaleString(locale, { maximumFractionDigits: 2 })
        )
    }
  ];
}
