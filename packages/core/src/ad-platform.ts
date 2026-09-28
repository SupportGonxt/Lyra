import { sha256Hex } from "./crypto.js";

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

/* ------------------------------------------------------ conversion upload */
// docs/17 SIG-032, ADR-0112. Value-based bidding: a bind reported back to the
// platform with what it was worth, so its bidder optimises on value rather
// than on lead count.

/** A minor amount in whole currency units — the double both platforms' value fields take. */
export function minorToUnits(minor: number, exponent: number): number {
  return Number((minor / 10 ** exponent).toFixed(exponent));
}

/**
 * How a bind is valued, from `moduleConfig.signal.settings.conversionValue`.
 * `none` — the default — means no conversion is exported at all: a value
 * nobody chose would teach the bidder a price nobody set.
 */
export type ConversionValueRule = { basis: "none" } | { basis: "commission" } | { basis: "premium_rate"; ratePpm: number };

export function conversionValueRule(settings: Record<string, unknown>): ConversionValueRule {
  const raw = settings.conversionValue;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { basis: "none" };
  const rule = raw as { basis?: unknown; ratePpm?: unknown };
  if (rule.basis === "commission") return { basis: "commission" };
  const ppm = rule.ratePpm;
  if (rule.basis === "premium_rate" && typeof ppm === "number" && Number.isInteger(ppm) && ppm > 0 && ppm <= 1_000_000) {
    return { basis: "premium_rate", ratePpm: ppm };
  }
  return { basis: "none" };
}

/** The bind's value in minor units under the rule; null when there is nothing positive to send. */
export function conversionValueMinor(
  rule: ConversionValueRule,
  bind: { premiumMinor: number | null; commissionMinor: number | null }
): number | null {
  let value: number | null = null;
  if (rule.basis === "commission") value = bind.commissionMinor;
  else if (rule.basis === "premium_rate" && bind.premiumMinor !== null) value = Math.round((bind.premiumMinor * rule.ratePpm) / 1_000_000);
  return value !== null && value > 0 ? value : null;
}

/**
 * One `@`, no whitespace, a non-empty local part, and a domain with a dot that
 * is neither its first nor last character. Checked by index, not a regex: the
 * address is customer-supplied and `[^\s@]+\.[^\s@]+` backtracks polynomially.
 */
function isEmail(value: string): boolean {
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@") || /\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** SHA-256 of the trimmed, lower-cased address (both platforms' normalisation); null for a non-address. */
export async function hashEmail(email: string): Promise<string | null> {
  const normal = email.trim().toLowerCase();
  return isEmail(normal) ? sha256Hex(normal) : null;
}

/** SHA-256 of the digits with country code and no `+`; null for anything else or fewer than 7 digits. */
export async function hashPhone(phone: string): Promise<string | null> {
  if (/[^\d\s()+.-]/.test(phone)) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? sha256Hex(digits) : null;
}

/** A gclid / fbclid as captured on /track: URL-safe characters only, bounded. */
export function clickId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,512}$/.test(value) ? value : null;
}
