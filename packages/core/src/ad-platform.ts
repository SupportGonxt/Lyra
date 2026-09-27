// docs/30 SIGNAL 5, ADR-0100. The arithmetic and config reading every
// `AdPlatform` adapter (seams.ts) shares. Platforms report money in their own
// units — Google Ads in micros, Meta in decimal strings — and a float slip
// here becomes a CAC the budget autopilot acts on, so conversion is exact.

/** Connector transport an ad-platform account is stored under. No ORBIT/SIGNAL sender selects it. */
export const AD_TRANSPORT = "ads";

/** Minor-unit digits of an ISO 4217 currency: AED 2, JPY 0, KWD 3. */
export function currencyExponent(currency: string): number {
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error(`not a currency code: ${currency}`);
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** "12.345" at exponent 2 -> 1235. Exact string arithmetic, half up on the first dropped digit. */
export function decimalToMinor(value: string, exponent: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a non-negative decimal amount: ${JSON.stringify(value)}`);
  const frac = m[2] ?? "";
  const kept = frac.slice(0, exponent).padEnd(exponent, "0");
  const roundUp = /[5-9]/.test(frac.charAt(exponent)) ? 1 : 0;
  return Number(m[1]! + kept) + roundUp;
}

function wholeMicros(micros: string | number): number {
  const n = typeof micros === "number" ? micros : /^\d+$/.test(micros) ? Number(micros) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error(`not a whole non-negative micros value: ${String(micros)}`);
  return n;
}

/** Google Ads' micros (1e-6 of a currency unit) down to minor units, half up. */
export function microsToMinor(micros: string | number, exponent: number): number {
  return Math.round(wholeMicros(micros) / 10 ** (6 - exponent));
}

export function minorToMicros(minor: number, exponent: number): number {
  return minor * 10 ** (6 - exponent);
}

/**
 * A budget move is sized against the autopilot's trailing window
 * (`amountMinor` is a share of that window's spend), so the daily budget moves
 * by the window amount spread over its days.
 */
export function dailyBudgetDelta(amountMinor: number, windowDays: number): number {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
  return Math.round(amountMinor / days);
}

/** A move that would leave a campaign with no daily budget is not a reallocation; refuse it. */
export function applyBudgetDelta(currentMinor: number, deltaMinor: number): number {
  const after = currentMinor + deltaMinor;
  if (after <= 0) throw new Error(`budget move would leave a daily budget of ${after}`);
  return after;
}

/** Connector config `campaigns`: platform campaign id -> LYRA campaign id. Anything else maps nothing. */
export function adCampaignMap(config: Record<string, unknown>): ReadonlyMap<string, string> {
  const raw = config.campaigns;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  return new Map(
    Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
  );
}

/** The one platform campaign behind a LYRA campaign; null for none or several (a budget is never split by guess). */
export function externalCampaignFor(map: ReadonlyMap<string, string>, campaignId: string): string | null {
  const hits = [...map].filter(([, id]) => id === campaignId);
  return hits.length === 1 ? hits[0]![0] : null;
}

export function adChannel(config: Record<string, unknown>, fallback: string): string {
  return typeof config.channel === "string" && config.channel !== "" ? config.channel : fallback;
}
