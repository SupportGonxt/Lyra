import * as React from "react";
import { Button, Field, Input, Select } from "@lyra/ui";
import { FILTER_OPS, GRAINS, VALUELESS, dayOf, type DatasetInfo } from "../analytics-def";
import {
  COLUMNS,
  FILTER_ROWS,
  VIZ,
  WINDOWS,
  addTile,
  moveTile,
  rangeChoice,
  removeTile,
  reorderKey,
  resizeTile,
  spanClass,
  tileFromChoice,
  type Layout,
  type TileSpec,
  type Viz
} from "../dashboard-layout";

// docs/30 Analytics 5: the dashboard tile editor. Tiles live in React state and
// travel to the action as one hidden `tiles` field; the dashboard's filters are
// ordinary named inputs read by `filtersFromForm`. Every move is a pure
// function in dashboard-layout.ts, and reorder is a keyboard move as well as a
// button (WCAG 2.2 2.5.7 — nothing here is drag-only).
//
// `TileList` is stateless on purpose: the web suite has no DOM, so its tests
// walk the element tree and call the handlers a key press reaches.

type Label = (key: string, vars?: Record<string, string>) => string;

/** A saved report as the add form offers it. */
export interface ReportChoice {
  id: string;
  name: string;
  dataset: string | null;
}

export interface TileListProps {
  tiles: TileSpec[];
  /** The new list, and where the moved tile landed when it was a move. */
  onChange: (tiles: TileSpec[], moved?: number) => void;
  describe: (tile: TileSpec) => string;
  l: Label;
  idBase: string;
  announcement: string;
}

export function TileList({ tiles, onChange, describe, l, idBase, announcement }: TileListProps) {
  const hint = `${idBase}-reorder-hint`;
  const move = (from: number, to: number) => onChange(moveTile(tiles, from, to), to);
  return (
    <div className="flex flex-col gap-2">
      <p id={hint} className="font-ui text-12 text-subtle">
        {l("reorderHint")}
      </p>
      <ol className="flex flex-col gap-2" aria-label={l("tiles")}>
        {tiles.map((tile, i) => (
          <li
            key={tile.key}
            id={`${idBase}-tile-${i}`}
            tabIndex={0}
            aria-describedby={hint}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End"
            onKeyDown={(event) => {
              const to = reorderKey(event.key, event.altKey, i, tiles.length);
              if (to === null) return;
              event.preventDefault();
              move(i, to);
            }}
            className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface-1 p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="font-ui text-14 text-text">{tile.key}</span>
              <span className="font-ui text-12 text-subtle">{describe(tile)}</span>
            </div>
            <Field label={l("viz")} className="w-36">
              <Select
                value={tile.viz}
                onValueChange={(value) => onChange(tiles.map((t, j) => (j === i ? { ...t, viz: value as Viz } : t)))}
                options={VIZ.map((v) => ({ value: v, label: l(`viz.${v}`) }))}
              />
            </Field>
            <Field label={l("width")} className="w-36">
              <Select
                value={String(tile.span ?? 4)}
                onValueChange={(value) => onChange(resizeTile(tiles, i, Number(value)))}
                options={Array.from({ length: COLUMNS }, (_, n) => ({
                  value: String(n + 1),
                  label: l("widthOf", { n: String(n + 1), of: String(COLUMNS) })
                }))}
              />
            </Field>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                aria-label={l("moveUp", { title: tile.key })}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                <span aria-hidden="true">↑</span>
              </Button>
              <Button
                type="button"
                size="sm"
                aria-label={l("moveDown", { title: tile.key })}
                disabled={i === tiles.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <span aria-hidden="true">↓</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={l("removeTile", { title: tile.key })}
                onClick={() => onChange(removeTile(tiles, i))}
              >
                {l("remove")}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/** The tiles at their widths on the dashboard's own grid — what the screen will draw. */
export function GridPreview({ tiles, label }: { tiles: TileSpec[]; label: string }) {
  return (
    <div role="img" aria-label={label} className="grid gap-2 rounded-md border border-dashed border-border p-3 lg:grid-cols-12">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={`min-w-0 truncate rounded-sm border border-border bg-surface-2 px-2 py-3 font-ui text-12 text-muted ${spanClass(tile.span)}`}
        >
          {tile.key}
        </div>
      ))}
    </div>
  );
}

export interface DashboardEditorProps {
  initial: Layout;
  datasets: DatasetInfo[];
  reports: ReportChoice[];
  l: Label;
  datasetName: (key: string) => string;
}

/**
 * The whole editor: the tile list, a preview of the grid, the add form and the
 * dashboard's filters. Renders inside the route's <Form>; everything it posts
 * is a named field (`tiles`, `range`, `from`, `to`, `f<n>.*`).
 */
export function DashboardEditor({ initial, datasets, reports, l, datasetName }: DashboardEditorProps) {
  const idBase = React.useId();
  const [tiles, setTiles] = React.useState<TileSpec[]>(initial.tiles);
  const [announcement, setAnnouncement] = React.useState("");
  const [focusAt, setFocusAt] = React.useState<number | null>(null);

  // Focus follows a moved tile, so Alt+Arrow can be pressed again at once.
  React.useEffect(() => {
    if (focusAt === null) return;
    document.getElementById(`${idBase}-tile-${focusAt}`)?.focus();
    setFocusAt(null);
  }, [focusAt, idBase]);

  const findDataset = (key: string | null | undefined) => datasets.find((d) => d.key === key);
  const datasetOf = (tile: TileSpec) =>
    tile.definition?.dataset ?? reports.find((r) => r.id === tile.reportId)?.dataset ?? null;

  const describe = (tile: TileSpec) => {
    if (tile.reportId) {
      const report = reports.find((r) => r.id === tile.reportId);
      return l("fromReport", { name: report?.name ?? tile.reportId });
    }
    const def = tile.definition;
    if (!def) return "";
    const ds = findDataset(def.dataset);
    const measures = def.metrics.map((m) => ds?.metrics.find((x) => x.key === m)?.label ?? m).join(", ");
    return `${datasetName(def.dataset)} · ${measures}`;
  };

  const change = (next: TileSpec[], moved?: number) => {
    setTiles(next);
    if (moved !== undefined) {
      const tile = next[moved];
      if (tile) setAnnouncement(l("moved", { title: tile.key, position: String(moved + 1), count: String(next.length) }));
      setFocusAt(moved);
    }
  };

  // A dashboard filter can only name a dimension some tile's dataset has — the
  // API refuses any other, so the form never offers one.
  const filterable = new Map<string, string>();
  for (const tile of tiles) {
    for (const d of findDataset(datasetOf(tile))?.dimensions ?? []) filterable.set(d.key, d.label);
  }

  return (
    <div className="flex flex-col gap-6">
      <input type="hidden" name="tiles" value={JSON.stringify(tiles)} />

      <section aria-labelledby={`${idBase}-tiles`} className="flex flex-col gap-3">
        <h2 id={`${idBase}-tiles`} className="eyebrow">
          {l("tiles")}
        </h2>
        {tiles.length ? (
          <>
            <TileList tiles={tiles} onChange={change} describe={describe} l={l} idBase={idBase} announcement={announcement} />
            <GridPreview tiles={tiles} label={l("preview")} />
          </>
        ) : (
          <p className="font-ui text-13 text-muted">{l("noTiles")}</p>
        )}
      </section>

      <AddTile tiles={tiles} datasets={datasets} reports={reports} l={l} datasetName={datasetName} onAdd={(next) => change(next)} />

      <Filters initial={initial} filterable={filterable} l={l} />
    </div>
  );
}

function AddTile({
  tiles,
  datasets,
  reports,
  l,
  datasetName,
  onAdd
}: {
  tiles: TileSpec[];
  datasets: DatasetInfo[];
  reports: ReportChoice[];
  l: Label;
  datasetName: (key: string) => string;
  onAdd: (tiles: TileSpec[]) => void;
}) {
  const [source, setSource] = React.useState<"dataset" | "report">(datasets.length ? "dataset" : "report");
  const [dataset, setDataset] = React.useState(datasets[0]?.key ?? "");
  const [metric, setMetric] = React.useState("");
  const [dimension, setDimension] = React.useState("");
  const [grain, setGrain] = React.useState("none");
  const [reportId, setReportId] = React.useState(reports[0]?.id ?? "");
  const [title, setTitle] = React.useState("");
  const [viz, setViz] = React.useState<Viz>("number");
  const [error, setError] = React.useState("");
  const ds = datasets.find((d) => d.key === dataset);

  const add = () => {
    let tile: TileSpec | null = null;
    if (source === "report") {
      const report = reports.find((r) => r.id === reportId);
      if (report) tile = { key: title.trim() || report.name, viz, span: 4, reportId: report.id };
    } else {
      const definition = tileFromChoice({ dataset, metric, dimension, grain }, ds);
      const measure = ds?.metrics.find((m) => m.key === metric)?.label ?? metric;
      if (definition) tile = { key: title.trim() || measure, viz, span: 4, definition };
    }
    const next = tile ? addTile(tiles, tile) : null;
    if (!next) {
      setError(tile ? l("errFull") : l("errPick"));
      return;
    }
    setError("");
    setTitle("");
    onAdd(next);
  };

  const sources = [
    ...(datasets.length ? [{ value: "dataset", label: l("fromDataset") }] : []),
    ...(reports.length ? [{ value: "report", label: l("fromSaved") }] : [])
  ];
  if (!sources.length) return null;

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-4">
      <legend className="eyebrow px-1">{l("addTile")}</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={l("source")}>
          <Select value={source} onValueChange={(v) => setSource(v === "report" ? "report" : "dataset")} options={sources} />
        </Field>
        {source === "report" ? (
          <Field label={l("report")} className="lg:col-span-3">
            <Select value={reportId} onValueChange={setReportId} options={reports.map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
        ) : (
          <>
            <Field label={l("dataset")}>
              <Select
                value={dataset}
                onValueChange={(v) => {
                  setDataset(v);
                  setMetric("");
                  setDimension("");
                }}
                options={datasets.map((d) => ({ value: d.key, label: datasetName(d.key) }))}
              />
            </Field>
            <Field label={l("measure")}>
              <Select value={metric} onValueChange={setMetric} options={(ds?.metrics ?? []).map((m) => ({ value: m.key, label: m.label }))} />
            </Field>
            <Field label={l("splitBy")}>
              <Select
                value={dimension}
                onValueChange={setDimension}
                options={[{ value: "", label: l("noSplit") }, ...(ds?.dimensions ?? []).map((d) => ({ value: d.key, label: d.label }))]}
              />
            </Field>
            <Field label={l("grain")}>
              <Select value={grain} onValueChange={setGrain} options={GRAINS.map((g) => ({ value: g, label: l(`grain.${g}`) }))} />
            </Field>
          </>
        )}
        <Field label={l("tileTitle")} className="lg:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={64} />
        </Field>
        <Field label={l("viz")}>
          <Select value={viz} onValueChange={(v) => setViz(v as Viz)} options={VIZ.map((v) => ({ value: v, label: l(`viz.${v}`) }))} />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={add}>
          {l("addTile")}
        </Button>
      </div>
    </fieldset>
  );
}

function Filters({ initial, filterable, l }: { initial: Layout; filterable: Map<string, string>; l: Label }) {
  const stored = initial.filters;
  const [range, setRange] = React.useState(rangeChoice(stored));
  const windows: string[] = [...WINDOWS];
  if (stored?.lastDays !== undefined && !windows.includes(String(stored.lastDays))) windows.push(String(stored.lastDays));
  const rows = [...(stored?.where ?? [])].slice(0, FILTER_ROWS);
  while (rows.length < FILTER_ROWS) rows.push({ field: "", op: "eq" });
  const fields = [...filterable.entries()];

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-4">
      <legend className="eyebrow px-1">{l("filters")}</legend>
      <p className="font-ui text-12 text-subtle">{l("filtersHint")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={l("range")}>
          <Select
            name="range"
            value={range}
            onValueChange={setRange}
            options={[
              { value: "", label: l("range.none") },
              ...windows.map((days) => ({ value: days, label: l("range.last", { days }) })),
              { value: "fixed", label: l("range.fixed") }
            ]}
          />
        </Field>
        {range === "fixed" ? (
          <>
            <Field label={l("from")}>
              <Input type="date" name="from" defaultValue={dayOf(stored?.from)} />
            </Field>
            <Field label={l("to")}>
              <Input type="date" name="to" defaultValue={dayOf(stored?.to)} />
            </Field>
          </>
        ) : null}
      </div>
      {fields.length ? (
        <div className="flex flex-col gap-2">
          {rows.map((f, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-3">
              <Field label={l("filterField")} labelHidden={i > 0}>
                <Select
                  name={`f${i}.field`}
                  defaultValue={filterable.has(f.field) ? f.field : ""}
                  options={[{ value: "", label: l("anyField") }, ...fields.map(([key, label]) => ({ value: key, label }))]}
                />
              </Field>
              <Field label={l("filterOp")} labelHidden={i > 0}>
                <Select name={`f${i}.op`} defaultValue={f.op} options={FILTER_OPS.map((op) => ({ value: op, label: l(`op.${op}`) }))} />
              </Field>
              <Field label={l("filterValue")} labelHidden={i > 0}>
                <Input
                  name={`f${i}.value`}
                  defaultValue={f.value === undefined || VALUELESS.has(f.op) ? "" : Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}
                />
              </Field>
            </div>
          ))}
        </div>
      ) : (
        <p className="font-ui text-13 text-muted">{l("noFilterable")}</p>
      )}
    </fieldset>
  );
}
