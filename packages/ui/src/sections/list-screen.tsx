/**
 * Renders a `ListScreen` (`kind: "list"` in ./types.ts) — a filtered table
 * plus freeform notes. Reuses the existing `Table`/`Badge` primitives rather
 * than a bespoke grid: the design file's own row markup computes badge tone,
 * alignment and font per cell from each column's declared type at render
 * time, so this does the same from the literal `cols`/`rows` pairs instead
 * of inventing per-cell data the extraction never captured.
 */
import * as React from "react";
import { Badge } from "../primitives.js";
import { Table, type Column } from "../data.js";
import { toneFromWord } from "./shared.js";
import type { ListScreen } from "./types.js";

function renderCell(value: string, colType: string): React.ReactNode {
  if (colType === "badge") {
    return <Badge tone={toneFromWord(value)}>{value}</Badge>;
  }
  if (colType === "money" || colType === "num") {
    return <span className="font-mono text-13 tabular-nums">{value}</span>;
  }
  return <span className={colType === "wide" ? "text-13" : "truncate text-13"}>{value}</span>;
}

export function ListScreenView({ screen }: { screen: ListScreen }) {
  const columns: Array<Column<string[]>> = screen.cols.map(([label, colType], i) => ({
    key: `${i}-${label}`,
    header: label,
    numeric: colType === "money" || colType === "num",
    render: (row) => renderCell(row[i] ?? "", colType)
  }));

  return (
    <div className="flex flex-col gap-6">
      {screen.filters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {screen.filters.map(([name, value], i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-orbit border border-line2 bg-surface-2 px-3 py-1 text-12"
            >
              <span className="text-subtle">{name}</span>
              <span className="text-text">{value}</span>
            </span>
          ))}
          <span className="ms-auto font-mono text-12 text-subtle">{screen.rows.length}</span>
        </div>
      ) : null}
      <Table
        caption={screen.title}
        columns={columns}
        rows={screen.rows}
        rowKey={(row) => row[0] ?? row.join("|")}
      />
      {screen.notes.length > 0 ? (
        <div className="flex flex-wrap gap-6">
          {screen.notes.map(([hue, label, body], i) => (
            <div key={i} className="min-w-[19rem] flex-1 border-s-2 py-0.5 ps-3.5" style={{ borderColor: hue }}>
              <div className="mb-1 text-12 uppercase tracking-wide text-muted">{label}</div>
              <p className="text-13 leading-relaxed text-text">{body}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
