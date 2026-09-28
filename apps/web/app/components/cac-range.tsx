import { Money } from "@lyra/ui";
import type { CacRange } from "@lyra/core/attribution-range";

// docs/17 SIG-057, ADR-0109: cost per acquisition as a range with its method
// disclosed. The type is the API's own (GET /v1/signal/attribution/range
// returns `acquisitionCostRange` from apps/api/src/engines/signal-attribution.ts,
// whose `range` is packages/core's `CacRange`), imported rather than mirrored.
// This is statistics, not AI — no ✦ marker, and the "why" is the method.

type Label = (key: string, vars?: Record<string, string>) => string;

/** "AED low – high (point)". The point never appears without its bounds. */
export function CacRangeValue({
  range,
  currency,
  locale,
  l
}: {
  range: CacRange | null;
  currency: string;
  locale: string;
  l: Label;
}) {
  if (!range) return <>{l("none")}</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      <Money amountMinor={range.low} currency={currency} locale={locale} />
      <span aria-hidden="true">–</span>
      <span className="sr-only">{l("attribution.to")}</span>
      {range.high === null ? (
        <span>{l("attribution.unbounded")}</span>
      ) : (
        <Money amountMinor={range.high} currency={currency} locale={locale} />
      )}
      <span className="font-ui text-13 font-normal text-muted">
        (<Money amountMinor={range.point} currency={currency} locale={locale} />)
      </span>
    </span>
  );
}

/** The method, one native disclosure: keyboard-reachable with no script. */
export function CacMethod({ range, l }: { range: CacRange | null; l: Label }) {
  if (!range) return null;
  return (
    <details className="font-ui text-12 text-subtle">
      <summary className="cursor-pointer underline-offset-2 hover:underline">{l("attribution.method")}</summary>
      <p className="mt-1 max-w-prose">{l(range.methodKey, { pct: String(Math.round(range.confidence * 100)) })}</p>
    </details>
  );
}
