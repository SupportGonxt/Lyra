import { and, desc, eq, gte, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  audit,
  conversionValueMinor,
  conversionValueRule,
  currentConsent,
  hashEmail,
  hashPhone,
  moduleSettings,
  type AdConversion,
  type AdConversionResult,
  type ConversionKey,
  type ConversionValueRule,
  type Ctx
} from "@lyra/core";
import { AD_PLATFORMS, adAccounts, secretsOf, type AdAccount, type AdPlatforms } from "./signal-ad-platforms.js";

// docs/17 SIG-032, ADR-0112. Value-based bidding signals: every bind SIGNAL
// attributed is reported back to the tenant's connected ad accounts with what
// it was worth, so Google's and Meta's bidders optimise on value instead of on
// lead count. It rides the `AdPlatform` seam (core/seams.ts) and the `ads`
// connector rows ADR-0100 made; an account whose adapter has no
// `uploadConversions` simply receives nothing.
//
// What may leave, and when:
//  - nothing at all until the tenant has said what a bind is worth
//    (`moduleConfig.signal.settings.conversionValue`), and nothing while SIGNAL
//    is switched off;
//  - a bind only when its customer's current consent grants `marketing` — a
//    bind that names no customer has no consent to read and is skipped;
//  - only the identifiers that platform matches on (`conversionKeys`): a click
//    id the platform itself issued, and SHA-256 email/phone only when that
//    consent also grants `dataSharing`. No other customer field is ever read
//    into a conversion, so no protected attribute can reach a bidder (SIG-034).
//
// Each (bind, account) is recorded in `signal_conversion_exports`: `sent` and
// `skipped` are final, `failed` is offered again next run. The platform
// deduplicates too (Google by orderId, Meta by event_id), both keyed on the
// touch id, so a run that dies between upload and record cannot double-count.

const DAY_MS = 86_400_000;
/** For an adapter that does not say how old a conversion it accepts. */
const DEFAULT_MAX_AGE_DAYS = 7;
const BATCH = 500;
const ALL_KEYS: readonly ConversionKey[] = ["gclid", "fbclid", "emailSha256", "phoneSha256"];

export type ExportStatus = "sent" | "skipped" | "failed";
export type SkipReason = "no_consent" | "no_value" | "no_match_key";

export interface ConversionExportResult {
  /** Why nothing was looked at: no value configured, or SIGNAL switched off. */
  standDown?: "no_value_rule" | "signal_off";
  connectors: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: { connectorId: string; error: string }[];
}

type TouchRow = typeof schema.signalAttributionEvents.$inferSelect;

/** What a bind is, independent of which account it goes to. */
type Fact = { skip: "no_consent" | "no_value" } | { skip?: undefined; conversion: AdConversion; valueMinor: number; currency: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function strings(json: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function hashed(values: string[], hash: (v: string) => Promise<string | null>): Promise<string[]> {
  const out = (await Promise.all(values.map(hash))).filter((h): h is string => h !== null);
  return [...new Set(out)];
}

async function factOf(ctx: Ctx, rule: ConversionValueRule, touch: TouchRow): Promise<Fact> {
  if (!touch.customerId) return { skip: "no_consent" };
  const consent = await currentConsent(ctx, touch.customerId);
  if (consent?.purposes.marketing !== true) return { skip: "no_consent" };

  let commissionMinor: number | null = null;
  let currency = touch.currency;
  if (rule.basis === "commission" && touch.subjectRef) {
    const [policy] = await ctx.db
      .select({ commissionMinor: schema.axisPolicies.commissionMinor, currency: schema.axisPolicies.currency })
      .from(schema.axisPolicies)
      .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.id, touch.subjectRef)))
      .limit(1);
    commissionMinor = policy?.commissionMinor ?? null;
    currency = policy?.currency ?? null;
  }
  const valueMinor = conversionValueMinor(rule, { premiumMinor: touch.valueMinor, commissionMinor });
  if (valueMinor === null || !currency) return { skip: "no_value" };

  let emailSha256: string[] = [];
  let phoneSha256: string[] = [];
  if (consent.purposes.dataSharing === true) {
    const [customer] = await ctx.db
      .select({ emailsJson: schema.customers.emailsJson, phonesJson: schema.customers.phonesJson })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, touch.customerId)))
      .limit(1);
    emailSha256 = await hashed(strings(customer?.emailsJson ?? null), hashEmail);
    phoneSha256 = await hashed(strings(customer?.phonesJson ?? null), hashPhone);
  }
  return {
    valueMinor,
    currency,
    conversion: {
      conversionId: touch.id,
      at: touch.ts,
      valueMinor,
      currency,
      ...(touch.gclid ? { gclid: touch.gclid } : {}),
      ...(touch.fbclid ? { fbclid: touch.fbclid } : {}),
      ...(emailSha256.length ? { emailSha256 } : {}),
      ...(phoneSha256.length ? { phoneSha256 } : {})
    }
  };
}

/** The conversion cut down to the keys this platform matches on; null when none is left. */
function forPlatform(conversion: AdConversion, keys: readonly ConversionKey[]): AdConversion | null {
  const kept = Object.fromEntries(
    Object.entries(conversion).filter(([k]) => !(ALL_KEYS as readonly string[]).includes(k) || keys.includes(k as ConversionKey))
  );
  return keys.some((k) => kept[k] !== undefined) ? (kept as unknown as AdConversion) : null;
}

const maxAgeDays = (account: AdAccount) => account.platform.conversionMaxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

interface Outcome {
  touchId: string;
  status: ExportStatus;
  detail: string | null;
  valueMinor: number | null;
  currency: string | null;
}

async function record(ctx: Ctx, account: AdAccount, o: Outcome): Promise<void> {
  const t = schema.signalConversionExports;
  const exportedAt = o.status === "sent" ? ctx.now : null;
  await ctx.db
    .insert(t)
    .values({
      id: newId("cvx", ctx.now),
      tenantId: ctx.tenantId,
      touchId: o.touchId,
      connectorId: account.row.id,
      provider: account.row.provider,
      status: o.status,
      detail: o.detail,
      valueMinor: o.valueMinor,
      currency: o.currency,
      attemptedAt: ctx.now,
      exportedAt
    })
    .onConflictDoUpdate({
      target: [t.tenantId, t.touchId, t.connectorId],
      set: { status: o.status, detail: o.detail, valueMinor: o.valueMinor, currency: o.currency, attemptedAt: ctx.now, exportedAt, attempts: sql`${t.attempts} + 1` }
    });
}

/**
 * The nightly run, and `POST /v1/signal/conversions/export` on demand. Stands
 * down — no read of a touch, no call, no row — until a value is configured,
 * while SIGNAL is off, and for a tenant with no ads connector that takes
 * conversions.
 */
export async function exportConversions(
  ctx: Ctx,
  fieldKey: string | undefined,
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<ConversionExportResult> {
  const nothing = (): ConversionExportResult => ({ connectors: 0, sent: 0, skipped: 0, failed: 0, errors: [] });
  const signal = moduleSettings(ctx.policy, "signal");
  if (!signal.enabled) return { standDown: "signal_off", ...nothing() };
  const rule = conversionValueRule(signal.settings);
  if (rule.basis === "none") return { standDown: "no_value_rule", ...nothing() };
  const accounts = (await adAccounts(ctx, platforms)).filter((a) => typeof a.platform.uploadConversions === "function");
  const out = { ...nothing(), connectors: accounts.length };
  if (!accounts.length) return out;

  // An export row is always written after its bind happened, so the same
  // lower bound selects both without a bound parameter per touch id.
  const since = ctx.now - Math.max(...accounts.map(maxAgeDays)) * DAY_MS;
  const ev = schema.signalAttributionEvents;
  const binds = await ctx.db
    .select()
    .from(ev)
    .where(and(eq(ev.tenantId, ctx.tenantId), eq(ev.touchType, "bind"), gte(ev.ts, since)))
    .orderBy(ev.ts);
  if (!binds.length) return out;
  const cx = schema.signalConversionExports;
  const settled = new Set(
    (
      await ctx.db
        .select({ touchId: cx.touchId, connectorId: cx.connectorId, status: cx.status })
        .from(cx)
        .where(and(eq(cx.tenantId, ctx.tenantId), gte(cx.attemptedAt, since)))
    )
      .filter((r) => r.status !== "failed")
      .map((r) => `${r.touchId}\u0000${r.connectorId}`)
  );

  const facts = new Map<string, Fact>();
  const factFor = async (touch: TouchRow) => {
    let fact = facts.get(touch.id);
    if (!fact) facts.set(touch.id, (fact = await factOf(ctx, rule, touch)));
    return fact;
  };

  for (const account of accounts) {
    const from = ctx.now - maxAgeDays(account) * DAY_MS;
    const outcomes: Outcome[] = [];
    const upload: { conversion: AdConversion; valueMinor: number; currency: string }[] = [];
    for (const touch of binds) {
      if (touch.ts < from || settled.has(`${touch.id}\u0000${account.row.id}`)) continue;
      const fact = await factFor(touch);
      if (fact.skip) {
        outcomes.push({ touchId: touch.id, status: "skipped", detail: fact.skip, valueMinor: null, currency: null });
        continue;
      }
      const conversion = forPlatform(fact.conversion, account.platform.conversionKeys ?? []);
      if (!conversion) outcomes.push({ touchId: touch.id, status: "skipped", detail: "no_match_key", valueMinor: fact.valueMinor, currency: fact.currency });
      else upload.push({ conversion, valueMinor: fact.valueMinor, currency: fact.currency });
    }

    const subjectRef = `connector:${account.row.id}`;
    try {
      if (upload.length) {
        const secrets = await secretsOf(fieldKey, account.row);
        for (let i = 0; i < upload.length; i += BATCH) {
          const batch = upload.slice(i, i + BATCH);
          const results = await account.platform.uploadConversions!(
            batch.map((u) => u.conversion),
            secrets,
            account.config
          );
          const byId = new Map<string, AdConversionResult>(results.map((r) => [r.conversionId, r]));
          for (const u of batch) {
            const r = byId.get(u.conversion.conversionId);
            const sent = r?.status === "sent";
            outcomes.push({
              touchId: u.conversion.conversionId,
              status: sent ? "sent" : "failed",
              detail: sent ? null : (r?.error ?? "no answer from the platform"),
              valueMinor: u.valueMinor,
              currency: u.currency
            });
          }
        }
      }
    } catch (err) {
      // An account that cannot be reached writes no rows: every bind is still
      // unsettled for it, and the next run offers them again.
      out.errors.push({ connectorId: account.row.id, error: message(err) });
      await audit(ctx, { action: "signal.conversions.export_failed", subjectRef, after: { error: message(err) } });
      continue;
    }

    const counts = { sent: 0, skipped: 0, failed: 0 };
    for (const o of outcomes) {
      await record(ctx, account, o);
      counts[o.status]++;
    }
    out.sent += counts.sent;
    out.skipped += counts.skipped;
    out.failed += counts.failed;
    if (outcomes.length) await audit(ctx, { action: "signal.conversions.exported", subjectRef, after: { ...counts, basis: rule.basis } });
  }
  return out;
}

export async function listConversionExports(ctx: Ctx, opts: { status?: ExportStatus | undefined; limit?: number | undefined }) {
  const cx = schema.signalConversionExports;
  return ctx.db
    .select()
    .from(cx)
    .where(and(eq(cx.tenantId, ctx.tenantId), opts.status ? eq(cx.status, opts.status) : undefined))
    .orderBy(desc(cx.attemptedAt), desc(cx.id))
    .limit(opts.limit ?? 100);
}
