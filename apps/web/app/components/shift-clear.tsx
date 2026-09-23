import type { ReactNode } from "react";

/**
 * The end of a shift, not an absence of records. `EmptyState` is the right
 * answer for "no rows match this filter"; it is the wrong answer for a queue
 * whose whole purpose is to be emptied — reaching zero there is the outcome the
 * day was working towards, and the screen should say so (Horizon comp, "Shift
 * clear").
 *
 * Purely presentational: every figure and every word is passed in, so the
 * caller stays the one place that decides what is true.
 */
export function ShiftClear({
  eyebrow,
  head,
  body,
  figures,
  after,
  children
}: {
  eyebrow: string;
  head: string;
  body: string;
  /** Left empty when the counts could not be read — the strip then does not render. */
  figures: { label: string; value: string }[];
  after: string;
  children?: ReactNode;
}) {
  return (
    <div className="animate-rise flex flex-col items-start gap-5 px-2 pb-11 pt-10">
      <p className="flex items-center gap-2">
        {/* Alive, not urgent: the one thing on a cleared screen still moving. */}
        <span aria-hidden="true" className="animate-pulse size-1.5 rounded-full bg-accent" />
        <span className="eyebrow text-muted">{eyebrow}</span>
      </p>

      <h2 className="max-w-[20ch] font-serif text-36 leading-[1.22] text-text">{head}</h2>
      <p className="max-w-[62ch] font-ui text-16 leading-[1.7] text-subtle">{body}</p>

      {figures.length > 0 ? (
        // gap-px over a background, so the hairlines between cells and the
        // border around them read as one rule.
        <dl className="flex w-full max-w-[62ch] flex-wrap gap-px border border-border bg-border">
          {figures.map((figure) => (
            <div key={figure.label} className="flex-1 basis-32 bg-surface-2 px-[17px] py-[15px]">
              <dt className="eyebrow text-muted">{figure.label}</dt>
              <dd className="mt-1.5 font-mono text-22 leading-none text-text">{figure.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="max-w-[62ch] font-ui text-13 leading-[1.65] text-muted">{after}</p>
      {children}
    </div>
  );
}
