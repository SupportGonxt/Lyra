import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  DateTime,
  DonutChart,
  EmptyState,
  LineChart,
  ProgressBar,
  Stat,
  Table,
  formatMoney,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { humanise } from "../modules/spec";
import { Cell } from "../components/fields";
import { cloudflare } from "../context";
import { asJson } from "../json.js";
import { translator } from "../i18n";
import type { Row } from "../modules/spec";
import { useShellData } from "./workspace";
import { labelsFrom, type Label } from "./detail-kit";

// One dashboard, painted from a single call. GET /dashboards/:id/data runs every
// tile server-side and returns a table per tile — so this screen is layout and
// nothing else: it never runs a report, never merges definitions, and never
// decides what a tile is allowed to see.
//
// A tile that failed comes back as `{ key, error }` instead of a table, which is
// how one denied dataset shows as one dead tile rather than a blank page.
//
// ponytail: no charting library, by decision (ADR-0053). A line tile is
// @lyra/ui's LineChart — SVG with a scale beside it — a donut is its ring and
// legend, a bar stays one labelled meter per row because a horizontal bar reads
// its own name in a narrow tile where a vertical one cannot, and everything else
// is the table the report engine already returns.

const PERM = { read: "analytics:dashboards:read" } as const;

/** How many bars one tile draws before it stops being a picture. */
const MAX_BARS = 8;

/** Tailwind needs the class to exist in the source, so the spans are written out. */
const SPAN: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
  9: "lg:col-span-9",
  10: "lg:col-span-10",
  11: "lg:col-span-11",
  12: "lg:col-span-12"
};

/** DashboardBody.layout.tiles, apps/api/src/routes/analytics.ts. */
interface TileSpec {
  key: string;
  viz: "number" | "line" | "bar" | "table" | "donut" | "list";
  span?: number;
}

/** ReportTable, packages/ledger/src/reports.ts — what a tile actually returns. */
interface TileTable {
  title: string;
  columns: { key: string; label: string; kind: "text" | "money" | "date" | "number" }[];
  rows: Row[];
  currency?: string;
  generatedAt: number;
}

export interface TileResult {
  key: string;
  table?: TileTable;
  totals?: Record<string, number>;
  /** Set instead of `table` when that one tile failed. */
  error?: string;
}

interface DashboardData {
  id: string;
  key: string;
  layout: { tiles: TileSpec[] };
  tiles: TileResult[];
  generatedAt: number;
}

/** The list row, which is where the name and the role filter live. */
interface DashboardRow {
  id: string;
  key: string;
  nameJson: string | Record<string, string>;
  module: string;
}

/** This screen's own vocabulary. */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    dashboard: "Dashboard",
    denied: "You do not have permission to open dashboards.",
    missing: "This dashboard is not available to you.",
    unavailable: "This dashboard could not be built.",
    noTiles: "This dashboard has no tiles yet.",
    tileFailed: "This tile could not be built.",
    noRows: "No figures in this window.",
    generated: "Generated",
    total: "Total",
    "health.allOk": "All {count} tiles built.",
    "health.someFailed": "{failed} of {total} tiles could not be built."
  },
  ar: {
    dashboard: "لوحة معلومات",
    denied: "ليس لديك إذن لفتح لوحات المعلومات.",
    missing: "هذه اللوحة غير متاحة لك.",
    unavailable: "تعذّر إنشاء هذه اللوحة.",
    noTiles: "لا تحتوي هذه اللوحة على أي بطاقات بعد.",
    tileFailed: "تعذّر إنشاء هذه البطاقة.",
    noRows: "لا توجد أرقام في هذه الفترة.",
    generated: "تم الإنشاء",
    total: "الإجمالي",
    "health.allOk": "تم إنشاء كل البطاقات ({count}).",
    "health.someFailed": "تعذّر إنشاء {failed} من أصل {total} بطاقة."
  }
};

/** How many of a dashboard's tiles came back as figures versus a dead tile
 *  (`{ error }` with no table, checked above in `TileResult`). Pure so the
 *  hero line is a one-line test, not a scan of the tile grid. */
export function tileHealth(tiles: TileResult[]): { ok: number; failed: number; total: number } {
  const failed = tiles.filter((tile) => tile.error || !tile.table).length;
  return { ok: tiles.length - failed, failed, total: tiles.length };
}

/** The shared resolver (docs/ui.md §7 P3-14), with one last resort of its own:
 *  a tile type nobody labelled reads as words, not as `claims_by_state`. */
export function labelsIn(locale: string): Label {
  const shared = labelsFrom(LABELS)(locale);
  return (key, vars) => {
    const said = shared(key, vars);
    return said === key ? humanise(key) : said;
  };
}

/** `nameJson` arrives parsed from generic CRUD and as text from the module router. */
function nameIn(value: unknown, locale: string, fallback: string): string {
  const bag = asJson<Record<string, string>>(value, {});
  return bag[locale] ?? bag.en ?? fallback;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const dashboardId = params.id ?? "";

  const me = await fetchMe(env, request);
  if (!me.permissions.includes(PERM.read)) {
    return { name: null, data: null, error: null, requestId: null, denied: true };
  }

  // GET /dashboards/:id/data checks the permission and the tenant, but not the
  // dashboard's own `rolesJson` or its personal scope — the list does. So the
  // list is the gate: a dashboard that is not in it is not this actor's to open.
  const listed = await api<{ data: DashboardRow[] }>("/v1/analytics/dashboards", { env, request });
  const row = listed.data.find((entry) => entry.id === dashboardId);
  if (!row) return { name: null, data: null, error: null, requestId: null, denied: false };

  try {
    const data = await api<DashboardData>(`/v1/analytics/dashboards/${dashboardId}/data`, {
      env,
      request
    });
    return { name: nameIn(row.nameJson, me.locale, row.key), data, error: null, requestId: null, denied: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        name: nameIn(row.nameJson, me.locale, row.key),
        data: null,
        error: error.problem.detail ?? error.problem.title,
        // The id support looks the failure up by. Flattening the problem to a
        // string here is what loses it, which is why it rides alongside
        // (docs/15 checklist item 10, same narrowing point as module.tsx).
        requestId: error.problem.requestId ?? null,
        denied: false
      };
    }
    throw error;
  }
}

export default function AnalyticsDashboard() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);

  if (loaded.denied) return <EmptyState title={l("denied")} body={t("error.forbidden")} />;
  if (!loaded.name) return <EmptyState title={l("missing")} body={t("error.notFound")} />;

  const data = loaded.data;
  const specs = data?.layout.tiles ?? [];
  const health = data ? tileHealth(data.tiles) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{loaded.name}</h1>
          {health ? (
            <p className="font-ui text-13 text-muted">
              {health.failed > 0
                ? l("health.someFailed", { failed: String(health.failed), total: String(health.total) })
                : l("health.allOk", { count: String(health.total) })}
            </p>
          ) : null}
          {data ? (
            <p className="font-ui text-12 text-subtle">
              {l("generated")}{" "}
              <DateTime value={data.generatedAt} locale={locale} precision="minute" />
            </p>
          ) : null}
        </div>
      </header>

      {!data ? (
        <EmptyState
          title={l("unavailable")}
          body={
            loaded.requestId
              ? `${loaded.error ?? t("error.generic")} ${t("error.requestId", { id: loaded.requestId })}`
              : (loaded.error ?? t("error.generic"))
          }
        />
      ) : specs.length === 0 ? (
        <EmptyState title={l("noTiles")} body={t("common.empty.body")} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          {specs.map((spec) => {
            const result = data.tiles.find((tile) => tile.key === spec.key);
            const span = SPAN[Math.min(12, Math.max(1, spec.span ?? 4))] ?? SPAN[4];
            return (
              <section
                key={spec.key}
                aria-label={l(spec.key)}
                className={`flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 ${span}`}
              >
                <h2 className="eyebrow">{l(spec.key)}</h2>
                <Tile spec={spec} result={result} locale={locale} l={l} t={t} />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One tile: whatever the engine returned, drawn the way the layout asked for. */
function Tile({
  spec,
  result,
  locale,
  l,
  t
}: {
  spec: TileSpec;
  result: TileResult | undefined;
  locale: string;
  l: (key: string) => string;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  // A dead tile says so where it sits. The reason is the API's own text — data,
  // not copy, and better in front of the actor than in a log they cannot read.
  if (!result || result.error || !result.table) {
    return (
      <p role="note" className="font-ui text-13 text-muted">
        {l("tileFailed")} {result?.error ?? ""}
      </p>
    );
  }

  const table = result.table;
  const currency = table.currency ?? "";
  const rows: Row[] = table.rows.map((row, index) => ({
    ...row,
    __currency: currency,
    __key: String(index)
  }));
  const figures = table.columns.filter(
    (column) => column.kind === "money" || column.kind === "number"
  );
  const first = figures[0];
  const dimension = table.columns.find((column) => column.kind === "text" || column.kind === "date");

  if (!rows.length && spec.viz !== "number") {
    return <p className="font-ui text-13 text-subtle">{l("noRows")}</p>;
  }

  // A single figure: the totals the engine already computed, not a number this
  // screen sums for itself.
  if (spec.viz === "number") {
    const totals = result.totals ?? {};
    const shown = figures.filter((column) => column.key in totals);
    if (!shown.length) return <p className="font-ui text-13 text-subtle">{l("noRows")}</p>;
    const totalsRow: Row = { ...totals, __currency: currency };
    return (
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        {shown.map((column) => (
          <Stat
            key={column.key}
            label={column.label}
            value={
              <Cell
                column={{ name: column.key, type: column.kind, currencyFrom: "__currency" }}
                row={totalsRow}
                locale={locale}
                label={l}
              />
            }
          />
        ))}
      </div>
    );
  }

  if (spec.viz === "line" && first) {
    const values = rows.map((row) => Number(row[first.key] ?? 0)).filter(Number.isFinite);
    const last = rows[rows.length - 1];
    const axis = (value: number) =>
      first.kind === "money" && currency
        ? formatMoney(value, currency, locale)
        : new Intl.NumberFormat(locale).format(value);
    return values.length ? (
      <div className="flex flex-col gap-2">
        <LineChart
          values={values}
          label={`${table.title} — ${first.label}`}
          xLabels={dimension ? rows.map((row) => String(row[dimension.key] ?? "")) : undefined}
          format={axis}
        />
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-ui text-12 text-subtle">{first.label}</span>
          {last ? (
            <span className="font-ui text-13 tabular-nums text-text">
              <Cell
                column={{ name: first.key, type: first.kind, currencyFrom: "__currency" }}
                row={last}
                locale={locale}
                label={l}
              />
            </span>
          ) : null}
        </div>
      </div>
    ) : (
      <p className="font-ui text-13 text-subtle">{l("noRows")}</p>
    );
  }

  // A donut is share of the whole, so it is drawn as the whole: the ring says
  // how much of it each slice holds, which is the one thing a row of meters
  // against the largest row cannot say.
  if (spec.viz === "donut" && first && dimension) {
    const slices = rows.slice(0, MAX_BARS).map((row) => ({
      name: String(row[dimension.key] ?? ""),
      value: Math.max(0, Number(row[first.key] ?? 0)),
      display: (
        <Cell
          column={{ name: first.key, type: first.kind, currencyFrom: "__currency" }}
          row={row}
          locale={locale}
          label={l}
        />
      )
    }));
    return slices.some((slice) => slice.value > 0) ? (
      <DonutChart slices={slices} label={`${table.title} — ${first.label}`} />
    ) : (
      <p className="font-ui text-13 text-subtle">{l("noRows")}</p>
    );
  }

  // A bar is this row against the largest one: one labelled meter per row, so
  // the name sits beside its own figure however narrow the tile gets.
  if (spec.viz === "bar" && first && dimension) {
    const values = rows.slice(0, MAX_BARS).map((row) => ({
      row,
      name: String(row[dimension.key] ?? ""),
      value: Number(row[first.key] ?? 0)
    }));
    const basis = Math.max(...values.map((entry) => Math.abs(entry.value)));
    return (
      <ul className="flex flex-col gap-3">
        {values.map((entry) => (
          <li key={String(entry.row.__key)} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-ui text-13 text-text">{entry.name}</span>
              <span className="font-ui text-13 tabular-nums text-text">
                <Cell
                  column={{ name: first.key, type: first.kind, currencyFrom: "__currency" }}
                  row={entry.row}
                  locale={locale}
                  label={l}
                />
              </span>
            </div>
            <ProgressBar
              value={basis > 0 ? (Math.abs(entry.value) / basis) * 100 : 0}
              label={`${entry.name} — ${first.label}`}
            />
          </li>
        ))}
      </ul>
    );
  }

  // table, list, and any viz whose figures this tile does not have: the rows.
  const columns: Array<Column<Row>> = table.columns.map((column) => ({
    key: column.key,
    header: column.label,
    numeric: column.kind === "money" || column.kind === "number",
    render: (row: Row) => (
      <Cell
        column={{ name: column.key, type: column.kind, currencyFrom: "__currency" }}
        row={row}
        locale={locale}
        label={l}
      />
    )
  }));

  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.__key)}
      caption={table.title}
      density="compact"
      empty={<EmptyState title={t("common.empty.title")} body={l("noRows")} />}
      footer={
        <div className="pt-3">
          <span className="font-ui text-12 tabular-nums text-subtle">
            {t("common.rows", { count: String(rows.length) })}
          </span>
        </div>
      }
    />
  );
}
