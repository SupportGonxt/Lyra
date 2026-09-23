import * as React from "react";
import { cn } from "../cn.js";
import { SectionShell } from "./shared.js";
import type { SparkItem, SparkSectionData, ScreenModule } from "./types.js";

/** Mirrors `Hero`'s scrubbable trend: pointer move and the arrow keys move a
 * reading cursor that surfaces one bar's literal value, without claiming the
 * "set a value" semantics of a real slider — inspect only, nothing to set. */
function ScrubTrack({ items, label }: { items: SparkItem[]; label: string }) {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const active = hoverIndex !== null ? items[hoverIndex] : null;

  const indexFromClientX = (clientX: number): number | null => {
    const el = trackRef.current;
    if (!el || items.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (items.length - 1));
  };

  return (
    <div
      ref={trackRef}
      tabIndex={0}
      role="group"
      aria-label={`${label} — hover or use the arrow keys to inspect a point`}
      className="relative flex h-24 items-end gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onMouseMove={(event) => setHoverIndex(indexFromClientX(event.clientX))}
      onMouseLeave={() => setHoverIndex(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setHoverIndex((i) => Math.max(0, (i ?? items.length - 1) - 1));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          setHoverIndex((i) => Math.min(items.length - 1, (i ?? 0) + 1));
        }
      }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={cn(
            "min-w-0.5 flex-1 rounded-t-sm transition-opacity duration-150 ease-out",
            hoverIndex !== null && hoverIndex !== i ? "opacity-40" : "opacity-100"
          )}
          style={{ height: item.h, background: item.hue }}
        />
      ))}
      {active ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line2 bg-surface-3 px-2 py-1 font-mono text-12 tabular-nums text-text shadow-elev"
          style={{ insetInlineStart: `${(hoverIndex! / Math.max(1, items.length - 1)) * 100}%` }}
        >
          {active.label}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {active ? `Point ${hoverIndex! + 1} of ${items.length}: ${active.label}` : ""}
      </span>
    </div>
  );
}

export function SparkSection({ section, mod }: { section: SparkSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod} flex={section.flex} min={section.min}>
      <div className="rounded-md bg-surface-2 p-4 shadow-elev">
        <ScrubTrack items={section.items} label={section.title || "Trend"} />
        {section.from || section.mid || section.to ? (
          <div className="mt-2.5 flex justify-between font-mono text-12 text-subtle">
            <span>{section.from}</span>
            <span>{section.mid}</span>
            <span>{section.to}</span>
          </div>
        ) : null}
      </div>
    </SectionShell>
  );
}
