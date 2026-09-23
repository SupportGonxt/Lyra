/**
 * Horizon grammar — the editorial layer of Constellation (ADR-0031, docs/07 §2).
 *
 * These are not new components so much as the seven marks the Horizon design
 * repeats on every surface, extracted so a screen composes them instead of
 * re-deriving the same inline styles:
 *
 *   the eyebrow      a small tracked-out label that says what a block is
 *   the lede         one serif sentence that says what it means
 *   the figure       every number in mono, tabular, with its unit set quietly
 *   the hue bar      2px of module colour, the only place a module signs itself
 *   the hairline     a rule instead of a shadow
 *   the answer       ✦, who it was answered for, and how long it took
 *   the provenance   the "why" behind an AI artifact, inspectable in place
 *
 * Logical properties only, same as the rest of the package (`src/ui.test.ts`
 * enforces it).
 */
import * as React from "react";
import { AGENT_MARK } from "./ai.js";
import { cn } from "./cn.js";
import type { LyraModule } from "./nav.js";

/* -------------------------------------------------------------------------- */
/* Hue                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The CSS variable a module signs itself with. Returns the neutral accent for
 * surfaces that belong to no module (home, settings, the ledger shell).
 */
export function hueVar(module?: LyraModule | null): string {
  return module ? `var(--module-${module})` : "var(--accent)";
}

export interface HueBarProps extends React.ComponentPropsWithRef<"div"> {
  module?: LyraModule | null;
  /** Horizontal by default; `vertical` for the strip beside a list row. */
  orientation?: "horizontal" | "vertical";
}

/**
 * Two pixels of module colour. Decorative — the module is always also named in
 * text nearby, so this carries no information a screen reader needs.
 */
export function HueBar({
  module,
  orientation = "horizontal",
  className,
  style,
  ...props
}: HueBarProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(orientation === "horizontal" ? "h-0.5 w-full" : "w-0.5 self-stretch", className)}
      style={{ background: hueVar(module), ...style }}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Eyebrow, lede, hairline                                                     */
/* -------------------------------------------------------------------------- */

export interface EyebrowProps extends React.ComponentPropsWithRef<"p"> {
  /** Renders the module dot before the label. */
  module?: LyraModule | null;
}

/** The block's name, set small and tracked out. Never a sentence. */
export function Eyebrow({ module, className, children, ...props }: EyebrowProps) {
  return (
    <p
      className={cn(
        "eyebrow flex items-center gap-2",
        className
      )}
      {...props}
    >
      {module ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-orbit"
          style={{ background: hueVar(module) }}
        />
      ) : null}
      {children}
    </p>
  );
}

/**
 * One serif sentence. Horizon's rule: the eyebrow says what a block is, the
 * lede says what it means, and nothing else on the surface is set in serif.
 */
export function Lede({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  return (
    <p
      className={cn("font-serif text-22 leading-[1.25] text-text text-start", className)}
      {...props}
    />
  );
}

/** A rule where a lesser design would put a shadow. */
export function Hairline({ className, ...props }: React.ComponentPropsWithRef<"hr">) {
  return <hr className={cn("border-0 border-t border-border", className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Figure                                                                      */
/* -------------------------------------------------------------------------- */

export type FigureTone = "neutral" | "ok" | "bad";
export type FigureSize = "sm" | "md" | "lg";

const figureSizes: Record<FigureSize, string> = {
  sm: "text-16",
  md: "text-22",
  lg: "text-36"
};

const deltaTones: Record<FigureTone, string> = {
  neutral: "text-subtle",
  ok: "text-ok-tx2",
  bad: "text-danger"
};

export interface FigureProps extends Omit<React.ComponentPropsWithRef<"p">, "children"> {
  value: React.ReactNode;
  /** Currency symbol, %, "days" — set quiet so the number carries the weight. */
  unit?: React.ReactNode;
  delta?: React.ReactNode;
  /** Whether the delta is good news. Falling cost is `ok`; rising cost is `bad`. */
  tone?: FigureTone;
  size?: FigureSize;
}

/**
 * Every number in Horizon is mono and tabular, so a column of them aligns
 * without a table and a changing value does not shift its neighbours.
 */
/**
 * Replays a one-shot animation whenever the rendered value changes.
 *
 * docs/15 §3: "deltas pulse once, never loop". A CSS animation only fires on
 * mount, and React keeps this node across a re-render, so the animation has to
 * be removed and re-added to play again — hence the two-pass ref dance rather
 * than a class toggle, which the browser would coalesce into no change at all.
 *
 * ponytail: no count-up interpolation. Every figure on screen comes from a
 * route loader, so values arrive in one step, not as a stream — there is
 * nothing to count through. Add the interpolation when a live socket exists.
 */
function useTickOnChange(value: React.ReactNode) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const previous = React.useRef(value);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || Object.is(previous.current, value)) return;
    previous.current = value;
    node.classList.remove("motion-safe:animate-tick");
    // Reading layout between the two writes is what makes the browser treat
    // this as a restart instead of collapsing it to a no-op.
    void node.offsetWidth;
    node.classList.add("motion-safe:animate-tick");
  }, [value]);
  return ref;
}

export function Figure({
  value,
  unit,
  delta,
  tone = "neutral",
  size = "md",
  className,
  ...props
}: FigureProps) {
  const ref = useTickOnChange(value);
  return (
    <p className={cn("flex items-baseline gap-1.5 text-start", className)} {...props}>
      <span
        ref={ref}
        className={cn("font-mono font-medium tabular-nums text-text", figureSizes[size])}
      >
        {value}
      </span>
      {unit ? <span className="font-ui text-13 text-subtle">{unit}</span> : null}
      {delta ? (
        <span className={cn("font-mono text-12 tabular-nums", deltaTones[tone])}>{delta}</span>
      ) : null}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export interface AutoGridProps extends React.ComponentPropsWithRef<"div"> {
  /** Minimum column width before the grid drops a column. */
  min?: string;
}

/**
 * The only grid Horizon uses: columns that fit, then wrap. No breakpoint
 * ladder, so a screen behaves the same inside a rail as it does full-bleed.
 */
export function AutoGrid({ min = "17rem", className, style, ...props }: AutoGridProps) {
  return (
    <div
      className={cn("grid gap-3", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}, 100%), 1fr))`, ...style }}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

export interface PanelProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  eyebrow?: React.ReactNode;
  lede?: React.ReactNode;
  /** Draws the module's 2px signature across the top edge. */
  module?: LyraModule | null;
  actions?: React.ReactNode;
  /** Drop the body padding for a panel whose child is a full-bleed table. */
  padded?: boolean;
}

/**
 * The Horizon block: hairline, optional hue signature, eyebrow, lede, content.
 * `Card` remains for the surfaces that want a titled container with elevation;
 * `Panel` is what a Horizon screen reaches for.
 */
export function Panel({
  eyebrow,
  lede,
  module,
  actions,
  padded = true,
  className,
  children,
  ...props
}: PanelProps) {
  const heading = eyebrow || lede || actions;
  return (
    <section
      className={cn("overflow-hidden rounded-md border border-border bg-surface-1 text-start", className)}
      {...props}
    >
      {heading ? (
        <header
          className={cn(
            "flex items-start justify-between gap-4 px-4 pt-4",
            padded ? "" : "pb-4",
            children && padded ? "pb-3" : ""
          )}
        >
          <div className="min-w-0 space-y-2">
            {/* The module signs a panel with the eyebrow's dot, not a second
                hue bar: the shell already draws the one bar a page carries,
                and three stacked bars read as rules, not as a signature. */}
            {eyebrow ? <Eyebrow {...(module ? { module } : {})}>{eyebrow}</Eyebrow> : null}
            {lede ? <Lede>{lede}</Lede> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children ? <div className={padded ? "px-4 pb-4" : ""}>{children}</div> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Answer                                                                      */
/* -------------------------------------------------------------------------- */

export interface AnswerBannerProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  /** "Answered for Hala Zayed · NORTH scenario engine" — caller supplies the copy. */
  attribution: React.ReactNode;
  /** Rendered mono. Horizon shows how long the answer took, always. */
  latency?: React.ReactNode;
  headline: React.ReactNode;
  body?: React.ReactNode;
  /** Follow-on actions as chips. Each should be a Button or Link. */
  actions?: React.ReactNode;
  module?: LyraModule | null;
}

/**
 * Horizon's structural idea: the home screen answers rather than displays. The
 * banner carries the ✦ mark and its attribution because every AI artifact has
 * to say who produced it and be inspectable (CLAUDE.md §11, docs/15 §4).
 */
export function AnswerBanner({
  attribution,
  latency,
  headline,
  body,
  actions,
  module,
  className,
  ...props
}: AnswerBannerProps) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-md border border-accent-line bg-accent-soft/40 text-start",
        className
      )}
      {...props}
    >
      {module ? <HueBar module={module} /> : null}
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow flex items-center gap-2">
            <span aria-hidden="true" className="text-accent">
              {AGENT_MARK}
            </span>
            {attribution}
          </p>
          {latency ? (
            <span className="font-mono text-12 tabular-nums text-subtle">{latency}</span>
          ) : null}
        </div>
        <Lede className="text-28">{headline}</Lede>
        {body ? (
          <p className="max-w-[84ch] font-ui text-14 leading-relaxed text-muted">{body}</p>
        ) : null}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

export interface ProvenanceRow {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Set for values that are counts, money, ratios or IDs. */
  mono?: boolean;
}

export interface ProvenanceProps extends React.ComponentPropsWithRef<"dl"> {
  rows: ProvenanceRow[];
}

/**
 * The "why" behind an answer, as a definition list so it reads correctly to a
 * screen reader and can sit inline rather than behind a modal.
 */
export function Provenance({ rows, className, ...props }: ProvenanceProps) {
  return (
    <dl className={cn("divide-y divide-border text-start", className)} {...props}>
      {rows.map((row, index) => (
        <div key={index} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="font-ui text-13 text-subtle">{row.label}</dt>
          <dd
            className={cn(
              "text-end font-ui text-13 text-text",
              row.mono ? "font-mono tabular-nums" : ""
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
