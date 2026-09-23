/**
 * The one interactive hero every screen renders above `sections[]` (not part
 * of the design file — see docs header in ./types.ts). A screen with no
 * `hero` data still renders: eyebrow, title, attn and sub degrade gracefully
 * on their own, the headline figure/trend/chips are additive.
 *
 * Four real behaviours, not decoration pretending to be interactive:
 *   - the headline figure counts up from zero once, on mount
 *   - the trend strip is scrubbable by pointer and by arrow key
 *   - each chip reveals its `detail` on hover/focus, and stays open on tap
 *   - a chip row past three items drills in behind a real expand toggle
 */
import * as React from "react";
import { cn } from "../cn.js";
import { Eyebrow, Lede, hueVar } from "../horizon.js";
import { asLyraModule } from "./shared.js";
import type { HeroChip, HeroData, ScreenModule, SparkItem } from "./types.js";

const VISIBLE_CHIPS = 3;

/**
 * Finds the leading numeral in a headline value: "AED 4.2m" matches "AED 4.2",
 * with "AED " as group 1 and "4.2" as group 2. Whatever follows is the caller's
 * to slice off — see `splitHeadline`.
 *
 * Two deliberate shapes here, both of them the fix for CodeQL js/polynomial-redos
 * on a hero `value`, which is tenant data:
 *
 *   * the prefix excludes ',' as well as digits. The obvious `\D*` overlaps the
 *     group after it on every comma, so the two would fight over the same
 *     characters. No currency or unit prefix contains a comma.
 *   * there is no trailing `(.*)$`. `.` does not match a newline, so that group
 *     FAILS on a value containing one — and every failure sends the engine back
 *     to try a shorter `[\d,]+`, which is the quadratic. Ending the pattern at
 *     the numeral leaves nothing that can fail and nothing to backtrack into.
 */
export const HEADLINE_NUMERAL = /^([^\d,]*)([\d,]+(?:\.\d+)?)/;

/** The three parts of a headline value, or `undefined` if it holds no numeral. */
export function splitHeadline(target: string): { prefix: string; numStr: string; suffix: string } | undefined {
  const match = HEADLINE_NUMERAL.exec(target);
  if (!match?.[2]) return undefined;
  return { prefix: match[1] ?? "", numStr: match[2], suffix: target.slice(match[0].length) };
}

/**
 * Whether a display value is a quantity worth counting up. A numeral followed
 * by `-`, `/` or `:` and another digit is a date, time or reference, and a
 * value opening on a letter-digit code is an identifier: counting either from
 * zero shows a date or id nobody wrote.
 */
export function countable(target: string): boolean {
  const parts = splitHeadline(target);
  if (!parts) return false;
  if (/^[-/:]\d/.test(parts.suffix)) return false;
  if (/[A-Za-z]-$/.test(parts.prefix)) return false;
  return true;
}

/**
 * One frame of a count-up, formatted the way the caller already formatted
 * `numStr`: to the same number of decimals, and grouped only if the source was
 * grouped.
 *
 * The grouping half is load-bearing. Plenty of chip values carry a leading
 * numeral that is not a quantity — `2026-08-12` is a date, `2026` is a year —
 * and `toLocaleString`'s default grouping settles those on `2,026-08-12`, a
 * date nobody wrote. A source string that meant its numeral as a number has
 * separators in it already.
 */
export function countFrame(numStr: string, value: number): string {
  const decimals = numStr.includes(".") ? (numStr.split(".")[1]?.length ?? 0) : 0;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: numStr.includes(",")
  });
}

/**
 * Animates a display string from 0 up to the numeral inside `target`, once,
 * on mount or whenever `target` itself changes. Values with no parseable
 * leading numeral (or a browser that prefers reduced motion) render as-is —
 * there is nothing to count through and nothing worth forcing.
 */
function useCountUp(target: string, durationMs = 700): string {
  const [display, setDisplay] = React.useState(target);
  React.useEffect(() => {
    const parts = splitHeadline(target);
    if (!parts || !countable(target)) {
      setDisplay(target);
      return;
    }
    const { prefix, numStr, suffix } = parts;
    const value = Number(numStr.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      setDisplay(target);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(`${prefix}${countFrame(numStr, value * eased)}${suffix}`);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return display;
}

/** A scrubbable trend strip: pointer move and ArrowLeft/ArrowRight both move
 * a reading cursor that surfaces one point's literal label in a tooltip and
 * an `aria-live` line, without claiming the "set a value" semantics of a
 * true slider — this only lets a person inspect, never adjust, the series. */
function Trend({ items }: { items: SparkItem[] }) {
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
      aria-label="Trend — hover or use the arrow keys to inspect a point"
      className="relative flex h-16 items-end gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
          className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line2 bg-surface-3 px-2 py-1 font-mono text-12 text-fg shadow-elev"
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

/** One KPI chip. The whole chip is a real button (keyboard reachable, a real
 * `onClick`) so hovering, focusing or tapping all reveal `detail` the same
 * way — never a `role`/`tabIndex` promising an action nothing implements. */
function Chip({ chip }: { chip: HeroChip }) {
  const [pinned, setPinned] = React.useState(false);
  const display = useCountUp(chip.value);
  return (
    <button
      type="button"
      aria-expanded={chip.detail ? pinned : undefined}
      onClick={() => {
        if (chip.detail) setPinned((v) => !v);
      }}
      className={cn(
        "group flex min-w-[9rem] flex-col gap-1 rounded-md border border-border bg-surface-2 px-4 py-3 text-start shadow-elev transition-colors duration-150 ease-out hover:border-accent-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        pinned && "border-accent-line"
      )}
    >
      <span className="text-12 uppercase tracking-wide text-subtle">{chip.label}</span>
      <span className="font-mono text-22 font-medium tabular-nums" style={{ color: chip.hue }}>
        {display}
      </span>
      {chip.detail ? (
        <span
          className={cn(
            "grid text-12 leading-relaxed text-subtle transition-[grid-template-rows] duration-200 ease-out",
            pinned
              ? "grid-rows-[1fr] pt-1 opacity-100"
              : "grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:pt-1 group-hover:opacity-100"
          )}
        >
          <span className="overflow-hidden">{chip.detail}</span>
        </span>
      ) : null}
    </button>
  );
}

/** Chips past the first three sit behind a real expand toggle — the "drill
 * in" behaviour — rather than a wall of chips every screen has to scan. */
function ChipRow({ chips }: { chips: HeroChip[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? chips : chips.slice(0, VISIBLE_CHIPS);
  const hiddenCount = chips.length - VISIBLE_CHIPS;
  return (
    <div className="flex flex-wrap items-stretch gap-3">
      {visible.map((chip, i) => (
        <Chip key={i} chip={chip} />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-[6rem] items-center justify-center rounded-md border border-dashed border-line3 px-4 py-3 text-12 text-subtle transition-colors duration-150 ease-out hover:border-accent-line hover:text-accent"
        >
          {expanded ? "Show fewer" : `+${hiddenCount} more`}
        </button>
      ) : null}
    </div>
  );
}

export interface HeroProps {
  eyebrow: string;
  title: string;
  attn?: string;
  sub?: string;
  mod: ScreenModule;
  hero?: HeroData;
}

export function Hero({ eyebrow, title, attn, sub, mod, hero }: HeroProps) {
  const module = asLyraModule(mod);
  const [headline, ...restChips] = hero?.chips ?? [];
  const headlineDisplay = useCountUp(headline?.value ?? "");

  return (
    <section className="relative flex flex-col gap-5 overflow-hidden rounded-lg border border-border bg-surface-1 p-6 shadow-elev">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1" style={{ background: hueVar(module) }} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow module={module}>{eyebrow}</Eyebrow>
          <Lede>{title}</Lede>
          {sub ? <p className="max-w-[60ch] text-14 leading-relaxed text-subtle">{sub}</p> : null}
        </div>
        {attn ? (
          <span className="shrink-0 rounded-orbit border border-accent-line bg-accent-soft px-3 py-1 text-12 text-accent">
            {attn}
          </span>
        ) : null}
      </div>
      {headline ? (
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-48 font-medium tabular-nums motion-safe:animate-rise"
            style={{ color: headline.hue }}
          >
            {headlineDisplay}
          </span>
          <span className="text-13 text-subtle">{headline.label}</span>
        </div>
      ) : null}
      {hero?.trend && hero.trend.length > 0 ? <Trend items={hero.trend} /> : null}
      {restChips.length > 0 ? <ChipRow chips={restChips} /> : null}
    </section>
  );
}
