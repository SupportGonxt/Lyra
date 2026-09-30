/**
 * The month the simulation drives. These are the illustrative Yalla Compare
 * figures from the activation plan (2,500 bound policies and AED 1m of paid
 * media a month) — NOT Yalla Compare's actuals, which we do not hold. Replace
 * with the 90-day actuals when they arrive; everything below scales from here.
 * SIM_SCALE multiplies every volume (0.1 for a smoke run, 4 to push past it).
 */
const SCALE = Number(process.env.SIM_SCALE ?? 1);
const per = (monthly: number) => Math.max(1, Math.round((monthly * SCALE) / 30));

export const BENCH = {
  days: Number(process.env.SIM_DAYS ?? 30),
  currency: "AED",
  /** Paid media, minor units per month, split across the four paid channels. */
  spendMinorPerMonth: 100_000_000 * SCALE,
  channels: ["google", "meta", "tiktok", "snapchat"] as const,
  perDay: {
    /** Anonymous impressions/clicks/visits on the storefront pixel. */
    touches: per(250_000),
    /** People who ask for a quote (leads) — 10% of them bind. */
    leads: per(25_000),
    binds: per(2_500),
    /** New customers imported by CSV (the CRM backfill a real tenant does). */
    customersImported: per(6_000),
    /** Web chat conversations opened by visitors. */
    chats: per(15_000),
    /** Partner (affinity/embedded) quote requests. */
    partnerQuotes: per(3_000),
    /** Staff screen reads per persona per day (lists, records, reports). */
    staffReads: 40
  }
} as const;
