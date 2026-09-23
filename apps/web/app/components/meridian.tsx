import * as React from "react";
import { DateTime } from "@lyra/ui";
import {
  DAY_MS,
  dayEvents,
  dayFraction,
  meridianState,
  scrubFraction,
  type Inbox,
  type MeridianState
} from "./shift";
import type { Translate } from "../i18n";

/**
 * The day strip that opens the Horizon shell: one line for today, ticked by the
 * hour, with a dot where each thing landed and a playhead you can drag. Left of
 * now is replay — the shift as it stood at that hour — and right of it is the
 * rest of the day, which nothing has landed in yet. The strip only ever states
 * what it can know: dragging moves which moment the shift rail answers for
 * (`onScrub`), it does not fabricate figures for a time that has not happened.
 *
 * Everything positioned from local time renders only after mount. A Worker
 * formats in UTC (packages/ui text.tsx UiTimeZoneProvider, which serves "UTC"
 * on the server pass and the browser's first pass before swapping to the
 * reader's zone), so a dot placed from local hours during SSR is a hydration
 * mismatch — which React 19 answers by throwing the whole route to the error
 * boundary.
 */
export function Meridian({
  t,
  inbox,
  accent,
  initialAsOf = null,
  onScrub
}: {
  t: Translate;
  inbox: Inbox | null;
  accent: string;
  /** Seeds the scrubber's cursor in replay mode (?asOf=<epoch-ms> in the
   *  caller's URL). Absent/null means live — the pre-existing default. */
  initialAsOf?: number | null;
  /** The moment the playhead is on, or null while it is following now. */
  onScrub?: (at: number | null) => void;
}) {
  const [now, setNow] = React.useState<number | null>(null);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    setNow(Date.now());
    // A playhead that only moves on navigation is a stopped clock. One tick a
    // minute is as fine as the strip can show — 42px carries no more.
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Seeds the replay cursor from the deep link once, post-mount, in the
  // reader's real local timezone — same reasoning as `now` above. Runs only
  // on mount so a later drag (or `release`) is never clobbered by this.
  React.useEffect(() => {
    if (initialAsOf !== null) setCursor(dayFraction(initialAsOf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const events = now === null ? [] : dayEvents(inbox, now);
  const played = now === null ? 0 : dayFraction(now);
  const at = cursor ?? played;
  const state: MeridianState = meridianState(at, played);

  /** Midnight today, so a fraction of the strip is a moment on the clock. */
  const midnight = now === null ? 0 : new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const atMs = midnight + at * DAY_MS;

  const move = React.useCallback(
    (fraction: number) => {
      setCursor(fraction);
      onScrub?.(midnight + fraction * DAY_MS);
    },
    [midnight, onScrub]
  );

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    move(scrubFraction(event.clientX, rect, document.documentElement.dir === "rtl"));
  };

  /** Back to now — and back to the live shift, not a frozen copy of it. */
  const release = () => {
    setCursor(null);
    onScrub?.(null);
  };

  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rtl = document.documentElement.dir === "rtl";
    const step = event.shiftKey ? 1 / 24 : 1 / 96; // an hour, or a quarter of one
    const back = event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    if (back || forward) {
      event.preventDefault();
      move(Math.max(0, Math.min(1, at + (forward ? step : -step))));
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(1);
    } else if (event.key === "Escape" && cursor !== null) {
      event.preventDefault();
      release();
    }
  };

  return (
    <section
      aria-label={t("meridian.title")}
      className="hidden h-[var(--chrome-meridian)] shrink-0 border-b border-border bg-surface-1 px-[var(--gutter)] pt-2 md:block"
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <span className="text-12 uppercase tracking-[0.16em] text-subtle">{t("meridian.title")}</span>
          <span className="font-mono text-12 text-text">
            {now === null ? null : <DateTime value={atMs} precision="time" />}
          </span>
          <span
            className="text-12"
            style={{ color: state === "live" ? accent : state === "projection" ? "var(--module-north)" : undefined }}
          >
            {now === null ? null : t(`meridian.${state}`)}
          </span>
          {cursor === null ? null : (
            <button
              type="button"
              onClick={release}
              className="rounded-md px-1 text-12 text-muted underline underline-offset-2 transition-colors duration-150 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t("meridian.now")}
            </button>
          )}
        </div>
        <span className="text-12 text-subtle">
          {now === null ? null : cursor === null ? t("meridian.hint") : t("meridian.landed", { count: String(events.filter((e) => dayFraction(e.at) <= at).length) })}
        </span>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t("meridian.scrub")}
        aria-valuemin={0}
        aria-valuemax={1440}
        aria-valuenow={Math.round(at * 1440)}
        aria-valuetext={clockOf(at)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          scrub(event);
        }}
        onPointerMove={(event) => {
          if (dragging) scrub(event);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={key}
        // touch-none so a drag on a touchscreen scrubs the day instead of
        // scrolling the page out from under the finger.
        className="relative h-[42px] cursor-ew-resize touch-none rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <div className="absolute inset-x-0 top-[21px] h-px bg-border-strongest" />
        {/* The sweep is the only motion here, and it carries nothing: the
            reduced-motion reset in tokens.css stops it without loss. */}
        <div
          className="pointer-events-none absolute start-0 top-5 h-[3px] w-[14%] opacity-50"
          style={{
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
            animation: "lyra-scan 9s linear infinite"
          }}
          aria-hidden="true"
        />
        {/* What has not happened yet, hatched rather than blank so the strip
            reads as a day and not as a half-loaded one. Hatched from now, not
            from the playhead: dragging changes what you are reading, not what
            the day has done. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 top-2 border-s border-dashed border-border-strong"
          style={{
            insetInlineStart: `${played * 100}%`,
            insetInlineEnd: 0,
            background:
              "repeating-linear-gradient(135deg, var(--surface-3) 0px, var(--surface-3) 3px, transparent 3px, transparent 7px)"
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-[15px] flex h-[13px] items-stretch justify-between"
        >
          {HOURS.map((hour) => (
            <div key={hour} className="w-px bg-border-strong" style={{ height: hour % 6 === 0 ? "13px" : hour % 2 === 0 ? "7px" : "4px" }} />
          ))}
        </div>

        <ul className="contents">
          {events.map((event) => (
            <li
              key={event.id}
              className="pointer-events-none absolute top-0 -translate-x-1/2 transition-opacity duration-150 rtl:translate-x-1/2"
              style={{
                insetInlineStart: `${dayFraction(event.at) * 100}%`,
                // Replay dims what had not landed yet at the moment being read.
                opacity: dayFraction(event.at) > at ? 0.25 : 1
              }}
            >
              <div className="mx-auto size-[5px] rounded-full" style={{ background: hueFor(event.module, accent) }} />
              <div className="mx-auto h-[17px] w-px bg-border-strong" />
              <div className="mt-0.5 whitespace-nowrap font-mono text-12 text-subtle">
                {event.labelled ? <DateTime value={event.at} precision="time" /> : null}
              </div>
            </li>
          ))}
        </ul>

        {now === null || cursor === null ? null : (
          // Where now is, once the playhead has left it — otherwise a dragged
          // strip loses the one mark the rest of the screen is relative to.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-border-strongest opacity-60"
            style={{ insetInlineStart: `${played * 100}%` }}
          />
        )}

        {now === null ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px"
            style={{ insetInlineStart: `${at * 100}%`, background: accent }}
          >
            <div
              className="absolute -top-0.5 size-[7px] rounded-full"
              style={{ insetInlineStart: "-3px", background: accent }}
            />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Midnight to midnight. Three tick weights, as horizon-1-shell.md §5.6 draws the
 * rail: full height every sixth hour so the eye finds 06:00, medium on the other
 * even hours, a hairline between. The comp's tick count is not portable — 29
 * ticks cannot land on 24 hourly intervals — and the hour is load-bearing here
 * (shift+arrow steps 1/24), so the weights come across and the count does not.
 */
const HOURS = Array.from({ length: 25 }, (_, i) => i);

/** The playhead's moment for a screen reader, in the plain 24-hour clock. */
function clockOf(fraction: number): string {
  const minutes = Math.round(fraction * 1440);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const MODULE_HUE: Record<string, string> = {
  axis: "var(--module-axis)",
  orbit: "var(--module-orbit)",
  signal: "var(--module-signal)",
  scout: "var(--module-scout)",
  north: "var(--module-north)"
};

/** A dot the module owns takes the module's hue; anything else takes the tenant's. */
function hueFor(module: string, accent: string): string {
  return MODULE_HUE[module] ?? accent;
}
