/**
 * Data display — Table, Pagination (keyset), EmptyState, Stat, Sparkline,
 * Timeline, AuditTrail. docs/07 §2 and docs/22 §1.
 */
import * as React from "react";
import { cn, focusRing } from "./cn.js";
import { Badge, Button, type BadgeTone } from "./primitives.js";
import { DateTime } from "./format.js";
import { useUiText } from "./text.js";

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<T> {
  key: string;
  header: string;
  /** Renders the cell. Keep money in <Money> and dates in <DateTime>. */
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Numeric columns align to the inline-end edge and use tabular figures. */
  numeric?: boolean;
  width?: string;
  /** Column heading shown to assistive tech when `header` is a glyph. */
  headerLabel?: string;
}

export interface TableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Required: tables carry a caption for screen readers (WCAG 2.2 AA). */
  caption: string;
  captionHidden?: boolean;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  density?: "comfortable" | "compact";
  stickyHeader?: boolean;
  /** Row treatment — docs/22 §1: posted lines look sealed, drafts look editable. */
  rowState?: (row: T) => "sealed" | "draft" | undefined;
  onRowActivate?: (row: T) => void;
  empty?: React.ReactNode;
  /** Keyset pager / bulk bar slot, rendered under the table. */
  footer?: React.ReactNode;
  className?: string;
}

function nextDirection(current: SortState | undefined, key: string): SortDirection {
  return current?.key === key && current.direction === "asc" ? "desc" : "asc";
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  captionHidden = true,
  sort,
  onSortChange,
  density = "comfortable",
  stickyHeader = true,
  rowState,
  onRowActivate,
  empty,
  footer,
  className
}: TableProps<T>) {
  const t = useUiText();
  const cellPad = density === "compact" ? "px-2.5 py-1.5" : "px-3 py-2.5";

  return (
    <div className={cn("flex flex-col", className)}>
      {/* A scroller a mouse can reach and a keyboard cannot is a wall (WCAG 2.2
          AA, axe scrollable-region-focusable). The caption already names the
          table, so it names the region too. */}
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className={cn("overflow-auto rounded-md border border-border", focusRing)}
      >
        <table className="w-full border-collapse font-ui text-13">
          <caption
            className={cn(
              "text-start font-ui text-12 text-subtle",
              captionHidden ? "sr-only" : "p-3"
            )}
          >
            {caption}
          </caption>
          <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
            <tr>
              {columns.map((col) => {
                const active = sort?.key === col.key;
                const ariaSort = active
                  ? sort.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : col.sortable
                    ? "none"
                    : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    {...(ariaSort ? { "aria-sort": ariaSort } : {})}
                    style={col.width ? { inlineSize: col.width } : undefined}
                    className={cn(
                      // A header is a label, not prose: it names the column on one
                      // line or the column is too narrow. Uppercase at 0.14em
                      // tracking is wide enough that "SLA due" broke across two
                      // rows and shoved the header band taller than the data.
                      // The wrapper scrolls (line 87), so a long header widens
                      // the table rather than folding.
                      "whitespace-nowrap border-b border-border bg-surface-1 font-medium uppercase tracking-[0.14em] text-12 text-subtle",
                      cellPad,
                      col.numeric ? "text-end" : "text-start"
                    )}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange({ key: col.key, direction: nextDirection(sort, col.key) })}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm uppercase hover:text-text",
                          active && "text-accent",
                          focusRing
                        )}
                      >
                        <span>{col.headerLabel ?? col.header}</span>
                        <span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
                      </button>
                    ) : (
                      (col.headerLabel ?? col.header)
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = rowState?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  {...(onRowActivate
                    ? {
                        // No role="button": that would replace the row/cell
                        // semantics a screen reader navigates a table with. The
                        // row stays a row, and stays operable by Enter.
                        tabIndex: 0,
                        onClick: () => onRowActivate(row),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowActivate(row);
                          }
                        }
                      }
                    : {})}
                  className={cn(
                    "border-b border-border/60",
                    // Sealed rows never gain hover elevation (docs/22 §1).
                    state === "sealed"
                      ? "bg-surface-1 border-s-[3px] border-s-success"
                      : state === "draft"
                        ? "bg-surface-2 border-s-[3px] border-s-dashed border-s-subtle"
                        : onRowActivate
                          ? "hover:bg-surface-2"
                          : undefined,
                    onRowActivate && focusRing
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        cellPad,
                        "align-top text-muted",
                        // Horizon sets every number in mono so a column aligns
                        // and a changing value never shifts its neighbours.
                        col.numeric ? "text-end font-mono tabular-nums text-text" : "text-start"
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center">
                  {empty ?? <span className="font-ui text-13 text-subtle">{t("empty")}</span>}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination — keyset, not offset                                             */
/* -------------------------------------------------------------------------- */

export interface PaginationProps {
  /** Keyset cursors: presence, not page numbers, drives the controls. */
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  /** e.g. "51–100" — keyset paging has no total, so never render "of N". */
  rangeLabel?: string;
  pageSize?: number;
  pageSizes?: number[];
  onPageSizeChange?: (size: number) => void;
  label?: string;
  /** Row-count select label. A prop wins; otherwise the kit catalogue answers. */
  rowsLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  className?: string;
}

export function Pagination({
  hasPrevious = false,
  hasNext = false,
  onPrevious,
  onNext,
  rangeLabel,
  pageSize,
  pageSizes = [25, 50, 100],
  onPageSizeChange,
  label,
  rowsLabel,
  previousLabel,
  nextLabel,
  className
}: PaginationProps) {
  const t = useUiText();
  const rows = rowsLabel ?? t("rows");
  const back = previousLabel ?? t("previous");
  const forward = nextLabel ?? t("next");
  return (
    <nav
      aria-label={label ?? t("pagination")}
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <div className="flex items-center gap-3">
        {rangeLabel ? (
          <span className="font-ui text-12 tabular-nums text-subtle" aria-live="polite">
            {rangeLabel}
          </span>
        ) : null}
        {onPageSizeChange && pageSize !== undefined ? (
          <label className="flex items-center gap-2 font-ui text-12 text-subtle">
            <span>{rows}</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.currentTarget.value))}
              className={cn(
                "h-8 rounded-md border border-border bg-surface-1 px-2 text-12 text-text",
                focusRing
              )}
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!hasPrevious}
          {...(onPrevious ? { onClick: onPrevious } : {})}
          aria-label={back}
        >
          <span aria-hidden="true">‹</span>
          <span>{back}</span>
        </Button>
        <Button
          size="sm"
          disabled={!hasNext}
          {...(onNext ? { onClick: onNext } : {})}
          aria-label={forward}
        >
          <span>{forward}</span>
          <span aria-hidden="true">›</span>
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* EmptyState                                                                  */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  title: string;
  /** Empty states teach: say what it means, then offer one action (docs/07 §5). */
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Thin-line constellation — the house illustration idiom (docs/01 §5). */
function ConstellationArt() {
  return (
    <svg viewBox="0 0 120 80" className="h-16 w-auto" role="presentation" aria-hidden="true">
      <g fill="none" stroke="var(--text-subtle)" strokeWidth="1.2" opacity="0.7">
        <path d="M42 44 L72 36 L83 68 L53 76 Z" />
        <path d="M25 24 L42 44" />
      </g>
      <g fill="var(--text-muted)">
        <circle cx="42" cy="44" r="2.4" />
        <circle cx="72" cy="36" r="2" />
        <circle cx="83" cy="68" r="2" />
        <circle cx="53" cy="76" r="2" />
      </g>
      <circle cx="25" cy="24" r="5" fill="var(--accent)" />
    </svg>
  );
}

export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-10 text-center",
        className
      )}
    >
      <ConstellationArt />
      <h3 className="font-serif text-18 leading-[1.3] text-text">{title}</h3>
      {body ? <p className="max-w-prose font-ui text-13 text-subtle">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat / Sparkline / KPIWall                                                  */
/* -------------------------------------------------------------------------- */

export interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Signed delta, e.g. +4.2. ion for positive, flare for negative (docs/01 §3). */
  delta?: number;
  deltaSuffix?: string;
  /** For metrics where down is good (cost, latency). */
  invertDelta?: boolean;
  hint?: React.ReactNode;
  /** Applies the "twinkle" treatment to live-updating numbers (docs/01 §5). */
  live?: boolean;
  className?: string;
}

export function Stat({
  label,
  value,
  delta,
  deltaSuffix = "",
  invertDelta = false,
  hint,
  live = false,
  className
}: StatProps) {
  const good = delta === undefined ? undefined : invertDelta ? delta < 0 : delta > 0;
  const tone: BadgeTone = good === undefined ? "neutral" : good ? "success" : "danger";
  return (
    // min-w-0: a grid item defaults to min-width:auto, so a figure wider than
    // its track ran into the next stat ("AED 244,900.001") instead of wrapping.
    <div className={cn("flex min-w-0 flex-col gap-1 text-start", className)}>
      <span className="font-ui text-12 font-medium uppercase tracking-[0.14em] text-subtle">{label}</span>
      {/* Mono, like every other number in Horizon: a KPI wall of these lines
          up on the decimal without anyone laying out a grid for it. */}
      <span
        className={cn(
          "font-mono text-28 font-medium tabular-nums text-text",
          live && "motion-safe:animate-twinkle"
        )}
      >
        {value}
      </span>
      {delta !== undefined ? (
        <Badge tone={tone} size="sm">
          {/* A signed figure has no strong direction, so in RTL the sign
              drifted to the far side ("143%-"). Isolate it as LTR. */}
          <span dir="ltr">
            {delta > 0 ? "+" : ""}
            {delta}
            {deltaSuffix}
          </span>
        </Badge>
      ) : null}
      {hint ? <span className="font-ui text-12 text-subtle">{hint}</span> : null}
    </div>
  );
}

export interface SparklineProps {
  values: number[];
  /** Required: the chart is an image and needs a text alternative. */
  label: string;
  tone?: "accent" | "success" | "danger" | "info";
  className?: string;
}

/** ponytail: a polyline is a sparkline. No chart library for 40 numbers. */
export function Sparkline({ values, label, tone = "accent", className }: SparklineProps) {
  const w = 100;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const stroke = {
    accent: "var(--accent)",
    success: "var(--success)",
    danger: "var(--danger)",
    info: "var(--info)"
  }[tone];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn("h-7 w-full", className)}
    >
      {/* docs/15 §3: "charts draw in 400ms once per mount, never on data
          refresh". A CSS animation runs when the element mounts; React reuses
          this same <polyline> when `values` changes, so a refresh updates the
          points without replaying the draw — the rule falls out of the DOM
          rather than needing a guard. The draw is a clip reveal, not a dash:
          a dash on a non-scaling stroke is measured in screen pixels and cut
          the line into segments. */}
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className="motion-safe:animate-chart-draw"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* LineChart / DonutChart                                                      */
/* -------------------------------------------------------------------------- */

// ponytail: still no charting library (ADR-0053). A sparkline answers "which
// way is it going" in a table row; a dashboard tile is asked "how much, when,
// and against what", which needs a scale a reader can name. That is two shapes
// and a legend, drawn in the SVG this file already draws — not a dependency, a
// bundle, and a second theming system. Anything past this (zoom, brushing,
// stacked series, axes on both sides) is where a library earns its place.

export interface LineChartProps {
  /** Y in row order — the series as the report engine returned it. */
  values: number[];
  /** Required: the plot is an image and needs a text alternative. */
  label: string;
  /** One per value; only the first and last are drawn, the rest position them. */
  xLabels?: string[] | undefined;
  /** How a y-axis figure reads — money, percent, plain. Defaults to the locale's number. */
  format?: (value: number) => string;
  tone?: "accent" | "success" | "danger" | "info";
  className?: string;
}

/**
 * A time series with a scale on it: two gridlines the reader can name (the low
 * and the high), the first and last x label, and the line between them. The
 * axis words are HTML beside the plot rather than `<text>` inside it, so a
 * stretched viewBox never stretches the type.
 */
export function LineChart({
  values,
  label,
  xLabels,
  format = (value) => String(value),
  tone = "accent",
  className
}: LineChartProps) {
  const finite = values.filter(Number.isFinite);
  const w = 100;
  const h = 40;
  const min = Math.min(...finite, 0);
  const max = Math.max(...finite, 0);
  const span = max - min || 1;
  const points = finite
    .map((value, index) => {
      const x = finite.length === 1 ? w / 2 : (index / (finite.length - 1)) * w;
      const y = h - ((value - min) / span) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const stroke = TONE_STROKE[tone];
  const first = xLabels?.[0];
  const last = xLabels?.[xLabels.length - 1];

  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-stretch gap-2">
        {/* The scale, in the mono every other figure uses. High at the top,
            low at the bottom — the same order the plot draws them. */}
        <div
          aria-hidden="true"
          className="flex shrink-0 flex-col justify-between py-0.5 font-mono text-12 tabular-nums text-subtle"
        >
          <span>{format(max)}</span>
          <span>{format(min)}</span>
        </div>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          className="h-32 w-full min-w-0"
        >
          {[0, h / 2, h].map((y) => (
            <line
              key={y}
              x1={0}
              x2={w}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Same draw-once rule as the sparkline: the animation runs on mount,
              and a data refresh moves the points without replaying it. */}
          <polyline
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="motion-safe:animate-chart-draw"
          />
        </svg>
      </div>
      {first || last ? (
        <figcaption
          aria-hidden="true"
          className="flex justify-between gap-3 font-ui text-12 text-subtle"
        >
          <span className="truncate">{first}</span>
          {last && last !== first ? <span className="truncate">{last}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

export interface DonutSlice {
  name: string;
  value: number;
  /** What the figure reads as beside the name — already formatted. */
  display?: React.ReactNode;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  /** Required: the ring is an image and needs a text alternative. */
  label: string;
  className?: string;
}

/**
 * Share of a whole, as a ring with a named legend. A bar chart cannot say
 * "share": it says "against the biggest one", which is a different question and
 * the reason a donut tile used to read wrong.
 */
export function DonutChart({ slices, label, className }: DonutChartProps) {
  const shown = slices.filter((slice) => slice.value > 0);
  const total = shown.reduce((sum, slice) => sum + slice.value, 0);
  // The ring is one circle per slice, each dashed to its own share and rotated
  // past the ones before it — no arc paths, no trigonometry.
  const r = 15.9155; // circumference 100, so a dash length IS a percentage
  let offset = 0;
  const arcs = shown.map((slice, index) => {
    const pct = total > 0 ? (slice.value / total) * 100 : 0;
    const arc = { slice, pct, offset, colour: SLICE_COLOURS[index % SLICE_COLOURS.length]! };
    offset += pct;
    return arc;
  });

  return (
    <figure className={cn("flex flex-wrap items-center gap-4", className)}>
      <svg viewBox="0 0 42 42" role="img" aria-label={label} className="h-28 w-28 shrink-0 -rotate-90">
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
        {arcs.map((arc) => (
          <circle
            key={arc.slice.name}
            cx="21"
            cy="21"
            r={r}
            fill="none"
            stroke={arc.colour}
            strokeWidth="4"
            strokeDasharray={`${arc.pct.toFixed(2)} ${(100 - arc.pct).toFixed(2)}`}
            strokeDashoffset={(-arc.offset).toFixed(2)}
          />
        ))}
      </svg>
      <figcaption className="flex min-w-0 flex-1 flex-col gap-1.5">
        {arcs.map((arc) => (
          <span key={arc.slice.name} className="flex min-w-0 items-baseline gap-2">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: arc.colour }}
            />
            <span className="min-w-0 flex-1 truncate font-ui text-13 text-text">{arc.slice.name}</span>
            <span className="font-mono text-12 tabular-nums text-subtle">
              {arc.slice.display ?? arc.slice.value}
            </span>
            <span className="w-10 shrink-0 text-end font-mono text-12 tabular-nums text-subtle">
              {arc.pct.toFixed(0)}%
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

const TONE_STROKE = {
  accent: "var(--accent)",
  success: "var(--success)",
  danger: "var(--danger)",
  info: "var(--info)"
} as const;

/** Categorical, not semantic: a slice is not good or bad, it is one of several. */
const SLICE_COLOURS = [
  "var(--accent)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--danger)",
  "var(--text-subtle)"
];

export function KPIWall({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn("grid gap-4", className)}
      // auto-fill, not auto-fit: a home with two stats and no economics panel
      // stretched them to half a screen each, which reads as an empty band
      // rather than two numbers. Empty tracks keep the stats at their own
      // width; a full wall still fills the row. 10rem keeps a phone two-up.
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(10rem, 100%), 1fr))" }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Timeline / AuditTrail                                                       */
/* -------------------------------------------------------------------------- */

export interface TimelineEvent {
  id: string;
  title: string;
  at: Date | string | number;
  /** Who did it — a person, or an agent with its autonomy level. */
  actor?: string;
  detail?: React.ReactNode;
  tone?: BadgeTone;
  /** State-machine steps waiting on a third party are named, never spinners. */
  pending?: boolean;
}

export interface TimelineProps {
  events: TimelineEvent[];
  label: string;
  locale?: string;
  timeZone?: string;
  className?: string;
}

export function Timeline({ events, label, locale, timeZone, className }: TimelineProps) {
  const t = useUiText();
  return (
    <ol aria-label={label} className={cn("flex flex-col border-s border-border ps-5", className)}>
      {events.map((e) => (
        <li key={e.id} className="relative pb-5 last:pb-0">
          <span
            aria-hidden="true"
            className={cn("absolute top-1.5 size-2 rounded-orbit", e.pending ? "bg-warning" : "bg-accent")}
            style={{ insetInlineStart: "-26px" }}
          />
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-ui text-14 text-text">{e.title}</span>
            {e.tone ? (
              <Badge tone={e.tone} size="sm">
                {t(e.pending ? "waiting" : "done")}
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 font-ui text-12 text-subtle">
            <DateTime value={e.at} precision="minute" {...(locale ? { locale } : {})} {...(timeZone ? { timeZone } : {})} />
            {e.actor ? <span> · {e.actor}</span> : null}
          </div>
          {e.detail ? <div className="mt-1 font-ui text-13 text-muted">{e.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  at: Date | string | number;
  target?: string;
  /** Immutable audit rows are read-only by construction: no controls exist. */
  detail?: React.ReactNode;
}

export function AuditTrail({
  entries,
  label,
  locale,
  timeZone,
  className
}: {
  entries: AuditEntry[];
  label?: string;
  /** Overrides the provider's locale; the stamps follow it. */
  locale?: string;
  timeZone?: string;
  className?: string;
}) {
  const t = useUiText();
  return (
    <Table<AuditEntry>
      {...(className ? { className } : {})}
      caption={label ?? t("auditTrail")}
      rows={entries}
      rowKey={(e) => e.id}
      density="compact"
      rowState={() => "sealed"}
      columns={[
        {
          key: "at",
          header: t("when"),
          render: (e) => (
            <DateTime
              value={e.at}
              precision="second"
              {...(locale ? { locale } : {})}
              {...(timeZone ? { timeZone } : {})}
            />
          )
        },
        { key: "actor", header: t("actor"), render: (e) => e.actor },
        {
          key: "action",
          header: t("action"),
          render: (e) => <span className="font-mono text-12">{e.action}</span>
        },
        { key: "target", header: t("target"), render: (e) => e.target ?? "—" },
        { key: "detail", header: t("detail"), render: (e) => e.detail ?? null }
      ]}
    />
  );
}
