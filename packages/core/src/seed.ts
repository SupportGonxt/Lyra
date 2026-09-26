import { and, eq, isNull } from "drizzle-orm";
import {
  BrandJson,
  CHART_OF_ACCOUNTS,
  EntitlementsJson,
  PolicyJson,
  TAX_RULEPACK,
  TakafulJson,
  id,
  schema,
  toJson
} from "@lyra/db";
import { ROLES, TENANT_ROLE_KEYS, isInternalRole, requiresMfa } from "./rbac.js";
import { hashPassword } from "./password.js";
import { PROSPECT_CHURN_FLOOR } from "./prospects.js";
import { splitCommission } from "./commission.js";
import type { CoreDb } from "./context.js";
import { seedAdmin } from "./seed/admin.js";
import { seedAnalytics } from "./seed/analytics.js";
import { seedAxis } from "./seed/axis.js";
import { seedCompliance } from "./seed/compliance.js";
import { seedLedger } from "./seed/ledger.js";
import { seedOnboarding } from "./seed/onboarding.js";
import { dayKey, dayStart, monthKey, monthName, monthStart, quarterKey } from "./seed/period.js";
import { SEED_JOURNEY_COOLDOWN_DAYS, seedOrbit } from "./seed/orbit.js";
import { seedPlatform } from "./seed/platform.js";
import { seedScout } from "./seed/scout.js";
import { seedSettlement } from "./seed/settlement.js";
import { seedSignal } from "./seed/signal.js";
import { seedStaff } from "./seed/staff.js";
import type { SeedContext } from "./seed/context.js";

// GONXT is the reference tenant: an aggregator that distributes other
// underwriters' products, underwrites some of its own, and sells through a b2c
// site and b2b partners. The seed is the demo, the e2e fixture and the
// provisioning template — one dataset, so a bug shows up in all three.

const T0 = Date.UTC(2026, 0, 6, 8, 0, 0); // deterministic ids: same seed, same ULIDs prefix time
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Overridable so a real deployment never ships a known password. */
const DEFAULT_PASSWORD = "Gonxt-Demo-2026!";

export interface SeedOptions {
  now?: number;
  password?: string;
  /** Set to "production" from the caller's real env — refuses the built-in demo password. */
  environment?: string;
  /**
   * Enrol every staff persona on this shared TOTP secret. Only a test or a demo
   * wants this — it is one secret for many people, which is the opposite of what
   * a second factor is for. Leave it unset for a real tenant and PLAT-013 walks
   * each person through enrolment on their first sign-in.
   */
  mfaSecret?: string;
}

export interface SeedResult {
  tenantId: string;
  users: Record<string, string>;
  channels: Record<string, string>;
  providers: Record<string, string>;
  offerings: Record<string, string>;
}

const ROLE_NAMES: Record<string, string> = {
  "tenant.admin": "Tenant administrator",
  "tenant.compliance": "Compliance officer",
  "axis.agent": "Operations agent",
  "axis.lead": "Operations lead",
  "axis.admin": "Operations administrator",
  "orbit.agent": "Customer agent",
  "orbit.lead": "Customer lead",
  "orbit.retention": "Retention specialist",
  "orbit.partners": "Partner manager",
  "orbit.admin": "Customer administrator",
  "signal.marketer": "Marketer",
  "signal.lead": "Growth lead",
  "signal.admin": "Growth administrator",
  "scout.pm": "Product manager",
  "scout.lead": "Product lead",
  "scout.admin": "Product administrator",
  "north.exec": "Executive",
  "north.analyst": "Analyst",
  "north.board": "Board member",
  "north.admin": "Intelligence administrator",
  "finance.analyst": "Finance analyst",
  "finance.controller": "Financial controller",
  "dev.developer": "Developer",
  "dev.admin": "Developer administrator",
  customer: "Customer",
  "partner.developer": "Partner developer",
  "partner.manager": "Partner manager",
  "provider.viewer": "Provider viewer"
};

/** email local part -> role key. One login per persona in the journey tests. */
const PEOPLE: ReadonlyArray<{ local: string; name: string; role: string; locale?: string }> = [
  { local: "amina.saleh", name: "Amina Saleh", role: "tenant.admin" },
  { local: "khalid.rashed", name: "Khalid Al Rashed", role: "tenant.compliance", locale: "ar" },
  { local: "layla.hassan", name: "Layla Hassan", role: "axis.agent" },
  { local: "omar.farouk", name: "Omar Farouk", role: "axis.lead" },
  { local: "sara.nasser", name: "Sara Al Nasser", role: "orbit.agent" },
  { local: "yusuf.karim", name: "Yusuf Karim", role: "orbit.retention" },
  { local: "dana.aziz", name: "Dana Aziz", role: "orbit.partners" },
  { local: "hind.saqr", name: "Hind Saqr", role: "orbit.admin" },
  { local: "noor.jamal", name: "Noor Jamal", role: "signal.lead" },
  { local: "tariq.mansour", name: "Tariq Mansour", role: "scout.lead" },
  { local: "hala.zayed", name: "Hala Zayed", role: "north.exec" },
  { local: "rana.hadid", name: "Rana Hadid", role: "north.analyst" },
  { local: "faisal.omar", name: "Faisal Omar", role: "finance.controller" },
  // Money out is dual-control and only a controller may decide it, so one
  // controller means no payout, refund or client-money transfer can ever clear.
  { local: "nadia.rahman", name: "Nadia Rahman", role: "finance.controller" },
  { local: "mona.idris", name: "Mona Idris", role: "finance.analyst" },
  { local: "raed.samir", name: "Raed Samir", role: "dev.admin" },
  // ROLE-028 (ADR-0025): a real provider-side login, scoped after seeding to
  // Falcon Insurance's own core_users.providerId below — parity with every
  // other role having a persona for journey/e2e coverage.
  { local: "yasmin.faris", name: "Yasmin Faris", role: "provider.viewer" }
];

/**
 * The one login a demo is given: every internal role at once, so a single
 * account can walk the whole platform without signing out between screens.
 * The named personas above still exist — they are what the journey tests use,
 * and they are what proves a role sees only its own share. This account proves
 * the opposite, and is deliberately the only one like it.
 *
 * External roles (customer, partner.*, provider.*) are left off: they are not
 * more permission, they are a different shell (the portal), and granting them
 * to a staff login would make the account's own module scope ambiguous.
 */
const DEMO_ADMIN = { local: "demo", name: "Demo Administrator" };

export async function seed(db: CoreDb, opts: SeedOptions = {}): Promise<SeedResult> {
  if (opts.environment === "production" && !opts.password) {
    throw new Error("refusing to seed production with the built-in demo password — pass an explicit password");
  }
  const now = opts.now ?? T0;
  const existing = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, "gonxt"))
    .limit(1);
  if (existing[0]) throw new Error("gonxt tenant already seeded — drop the database first");

  const tenantId = id("tn", now);

  await db.insert(schema.tenants).values({
    id: tenantId,
    slug: "gonxt",
    name: "GONXT",
    plan: "enterprise",
    region: "auto",
    status: "active",
    brandJson: JSON.stringify(
      BrandJson.parse({
        name: "GONXT",
        shortName: "GONXT",
        domain: "gonxt.ae",
        // No `palette` and no `font`: the demo tenant is the product showing
        // itself, so it inherits Horizon's own accent and typefaces rather than
        // painting over them. The five-property override contract (tokens.css
        // §TENANT OVERRIDE CONTRACT) is exercised by settings-brand.test.ts and
        // by the tenants that set it — a demo that overrides is a demo of
        // somebody else's brand. Horizon's accent is two values, not one (olive
        // on the daylight page, lime on the night one); a tenant override is a
        // single value across both themes and so cannot express it.
        email: { from: "hello@gonxt.ae", replyTo: "support@gonxt.ae" },
        legal: { company: "GONXT Insurance Services LLC", privacyUrl: "https://gonxt.ae/privacy" }
      })
    ),
    policyJson: JSON.stringify(
      PolicyJson.parse({
        locales: ["en", "ar"],
        defaultLocale: "en",
        currency: "AED",
        // Where this tenant's business day is. Every timestamp on screen and
        // every scheduled report's cron are reckoned here rather than in
        // whatever zone the reader's laptop happens to sit in.
        timezone: "Asia/Dubai",
        // A UAE book prices in AED off a UAE panel; it does not segment on the
        // SAARF/BRC LSM scale, which does not exist outside southern Africa.
        // See packages/core/src/targeting.ts and ADR-0071.
        domainPack: "insurance-gulf",
        autonomyDefault: "act_with_approval",
        autoApprove: ["signal.campaign_launch"]
      })
    ),
    entitlementsJson: JSON.stringify(
      EntitlementsJson.parse({
        edition: "suite",
        modules: ["axis", "orbit", "signal", "scout", "north"],
        seats: 250,
        features: { comparativeQuotes: true, aggregator: true, onPrem: false }
      })
    ),
    createdAt: now,
    updatedAt: now
  });

  /* -------------------------------------------------------------- roles */
  const roleIds: Record<string, string> = {};
  let n = 0;
  for (const key of TENANT_ROLE_KEYS) {
    const rid = id("rl", now + n++);
    roleIds[key] = rid;
    await db.insert(schema.roles).values({
      id: rid,
      tenantId,
      key,
      name: ROLE_NAMES[key] ?? key,
      permissionsJson: JSON.stringify(ROLES[key] ?? []),
      system: true,
      createdAt: now
    });
  }

  /* -------------------------------------------------------------- teams */
  const teams = {
    motor: id("tm", now),
    health: id("tm", now + 1),
    retention: id("tm", now + 2)
  };
  await db.insert(schema.teams).values([
    { id: teams.motor, tenantId, name: "Motor desk", moduleScope: "axis", createdAt: now },
    { id: teams.health, tenantId, name: "Health desk", moduleScope: "axis", createdAt: now },
    { id: teams.retention, tenantId, name: "Retention", moduleScope: "orbit", createdAt: now }
  ]);

  /* -------------------------------------------------------------- users */
  const passwordHash = await hashPassword(opts.password ?? DEFAULT_PASSWORD);
  const users: Record<string, string> = {};
  let u = 0;
  for (const person of PEOPLE) {
    const uid = id("us", now + u++);
    // ponytail: first person wins a shared role. Two personas hold
    // finance.controller and the seven readers below all want a *specific*
    // user, so last-write-wins would silently hand them the other one the day
    // someone reorders PEOPLE. Keyed lookups stay for the roles held once;
    // give a second holder its own key if a reader ever needs it.
    users[person.role] ??= uid;
    await db.insert(schema.users).values({
      id: uid,
      tenantId,
      email: `${person.local}@gonxt.ae`,
      name: person.name,
      locale: person.locale ?? "en",
      status: "active",
      authProvider: "password",
      passwordHash,
      // PLAT-013 covers staff only, so an external persona stays on a password
      // even when the demo secret is supplied.
      mfaEnrolled: Boolean(opts.mfaSecret) && requiresMfa([person.role]),
      mfaSecret: opts.mfaSecret && requiresMfa([person.role]) ? opts.mfaSecret : null,
      createdAt: now,
      updatedAt: now
    });
    await db.insert(schema.userRoles).values({
      id: id("ur", now + u),
      tenantId,
      userId: uid,
      roleId: roleIds[person.role]!,
      // ponytail: team-scoped grants gate the WHOLE grant (rbac.ts scopeAllows),
      // and axis.agent's bundle spans resources with no team column (documents,
      // quotes, tasks) that could never supply a satisfying subject.teamId. Scoping
      // this fixture role would just lock the demo agent out of everything, not
      // exercise ABAC. Team-scoping needs its own role split when it's built for real.
      scopeJson: null,
      createdAt: now
    });
  }

  await ensureDemoAdmin(db, tenantId, {
    now: now + u,
    passwordHash,
    ...(opts.mfaSecret !== undefined ? { mfaSecret: opts.mfaSecret } : {})
  });

  /* --------------------------------------------------- ledger accounts */
  let a = 0;
  for (const acc of CHART_OF_ACCOUNTS) {
    await db.insert(schema.ledgerAccounts).values({
      id: id("acc", now + a++),
      tenantId,
      code: acc.code,
      nameJson: JSON.stringify({ en: acc.en, ar: acc.ar }),
      type: acc.type,
      normalSide: acc.normalSide,
      clientMoney: acc.clientMoney ?? false,
      suspense: acc.suspense ?? false,
      cashFlow: acc.cashFlow ?? null,
      currency: "AED",
      status: "active",
      createdAt: now
    });
  }

  /* --------------------------------------------- tax rulepack (F17) */
  // docs/19 §5.3. Without these rows every commission accrual is refused, so
  // the rulepack is provisioned beside the chart of accounts rather than left
  // to a settings screen nobody would find before the first bind.
  await syncTaxRules(db, tenantId, { now });

  /* ------------------------------------------------------------ panel */
  const providers = {
    gonxt: id("pv", now),
    falcon: id("pv", now + 1),
    cedar: id("pv", now + 2),
    oryx: id("pv", now + 3),
    gulfHealth: id("pv", now + 4),
    meridian: id("pv", now + 5),
    zenith: id("pv", now + 6)
  };
  await db.insert(schema.providers).values([
    {
      id: providers.gonxt,
      tenantId,
      name: "GONXT Underwriting",
      kind: "insurer",
      isInternal: true,
      linesJson: JSON.stringify(["motor", "travel"]),
      integrationJson: JSON.stringify({ mode: "internal" }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.falcon,
      tenantId,
      name: "Falcon Insurance",
      kind: "insurer",
      linesJson: JSON.stringify(["motor", "home"]),
      integrationJson: JSON.stringify({ mode: "api" }),
      quoteEndpointJson: JSON.stringify({ url: "https://api.falcon.example/quote", authRef: "CARRIER_FALCON_API_KEY" }),
      settlementTermsJson: JSON.stringify({ frequency: "monthly", netDays: 30 }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.cedar,
      tenantId,
      name: "Cedar General Insurance",
      kind: "insurer",
      linesJson: JSON.stringify(["motor", "home", "travel"]),
      integrationJson: JSON.stringify({ mode: "api" }),
      quoteEndpointJson: JSON.stringify({ url: "https://api.cedar.example/rate", authRef: "CARRIER_CEDAR_API_KEY" }),
      settlementTermsJson: JSON.stringify({ frequency: "monthly", netDays: 45 }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.oryx,
      tenantId,
      name: "Oryx Takaful",
      kind: "insurer",
      linesJson: JSON.stringify(["motor", "life"]),
      integrationJson: JSON.stringify({ mode: "portal" }),
      settlementTermsJson: JSON.stringify({ frequency: "monthly", netDays: 60 }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.gulfHealth,
      tenantId,
      name: "Gulf Health Assurance",
      kind: "insurer",
      linesJson: JSON.stringify(["health"]),
      integrationJson: JSON.stringify({ mode: "email" }),
      settlementTermsJson: JSON.stringify({ frequency: "monthly", netDays: 30 }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.meridian,
      tenantId,
      name: "Meridian Bank",
      kind: "financier",
      linesJson: JSON.stringify(["loan"]),
      integrationJson: JSON.stringify({ mode: "api" }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: providers.zenith,
      tenantId,
      name: "Zenith Direct",
      kind: "insurer",
      linesJson: JSON.stringify(["motor"]),
      integrationJson: JSON.stringify({ mode: "api" }),
      // The first-party reference underwriter (ADR-0072), reached over the
      // CARRIER_SANDBOX service binding rather than a fake external host — the
      // only offering below with `pricingMode: "api"` that resolves to a real
      // HTTP hop instead of a table lookup.
      quoteEndpointJson: JSON.stringify({ url: "https://api.lyra.vantax.co.za/carrier-sandbox/quote", binding: "CARRIER_SANDBOX" }),
      settlementTermsJson: JSON.stringify({ frequency: "monthly", netDays: 30 }),
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    }
  ]);

  // ROLE-028: Falcon subscribes to the two published data products seeded
  // below (see scout.ts subscribersJson), so this persona's scoped view is
  // exercised rather than trivially empty.
  await db
    .update(schema.users)
    .set({ providerId: providers.falcon })
    .where(eq(schema.users.id, users["provider.viewer"]!));

  /* --------------------------------------------------------- products */
  const products = {
    motor: id("pr", now),
    health: id("pr", now + 1),
    travel: id("pr", now + 2),
    home: id("pr", now + 3),
    life: id("pr", now + 4)
  };
  await db.insert(schema.products).values([
    {
      id: products.motor,
      tenantId,
      line: "motor",
      nameJson: JSON.stringify({ en: "Motor comprehensive", ar: "تأمين شامل للمركبات" }),
      status: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: products.health,
      tenantId,
      line: "health",
      nameJson: JSON.stringify({ en: "Health – individual", ar: "تأمين صحي – فردي" }),
      status: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: products.travel,
      tenantId,
      line: "travel",
      nameJson: JSON.stringify({ en: "Travel", ar: "تأمين السفر" }),
      status: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: products.home,
      tenantId,
      line: "home",
      nameJson: JSON.stringify({ en: "Home contents", ar: "تأمين محتويات المنزل" }),
      status: "active",
      createdAt: now,
      updatedAt: now
    },
    {
      id: products.life,
      tenantId,
      line: "life",
      nameJson: JSON.stringify({ en: "Term life", ar: "تأمين على الحياة" }),
      structure: "takaful",
      // docs/16 H8 / docs/27 F45. The column carried `structure: "takaful"` and
      // nothing else, so the one takaful product in the demo could not be sold
      // as takaful by its own rules: no wakala fee, no surplus rule, no board
      // ruling, and `SURPLUS-DIST`'s precondition refuses all three absences.
      // Wakala — a fee, and the participants keep the whole surplus — because
      // that is the common Gulf retail structure and the conservative default.
      takafulJson: toJson(TakafulJson, {
        model: "wakala",
        wakalaFeeBps: 2_000,
        participantShareBps: 10_000,
        fundRef: "fund:gonxt-family-takaful",
        shariah: {
          state: "certified",
          boardRef: "board:gonxt-shariah-supervisory",
          fatwaRef: "FTW-2026-014",
          certifiedAt: now - 30 * DAY,
          // Rulings are reviewed; a demo whose certificate never expires cannot
          // show the screen that says one has.
          expiresAt: now + 335 * DAY
        }
      }),
      status: "active",
      createdAt: now,
      updatedAt: now
    }
  ]);

  /* -------------------------------------------------------- offerings */
  const offerings = {
    gonxtMotor: id("of", now),
    falconMotor: id("of", now + 1),
    cedarMotor: id("of", now + 2),
    oryxMotor: id("of", now + 3),
    cedarMotorPlus: id("of", now + 4),
    gulfHealth: id("of", now + 5),
    gonxtTravel: id("of", now + 6),
    cedarHome: id("of", now + 7),
    oryxLife: id("of", now + 8),
    zenithMotor: id("of", now + 9)
  };
  const offering = (
    key: keyof typeof offerings,
    providerId: string,
    productId: string,
    code: string,
    en: string,
    ar: string,
    baseCommissionPpm: number,
    // `pricingMode` is required, not defaulted. `api` now dials a live carrier
    // (ADR-0070) including from the public portal, so a forgotten mode must be a
    // typecheck failure here rather than an outbound request at runtime.
    extra: Partial<typeof schema.distOfferings.$inferInsert> &
      Required<Pick<typeof schema.distOfferings.$inferInsert, "pricingMode">>
  ): typeof schema.distOfferings.$inferInsert => ({
    id: offerings[key],
    tenantId,
    productId,
    providerId,
    code,
    nameJson: JSON.stringify({ en, ar }),
    currency: "AED",
    baseCommissionPpm,
    effectiveFrom: now,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...extra
  });

  // Rate tables, not live underwriter APIs. A seeded panel has to price for
  // real — the comparison is the product — and there is no third-party endpoint
  // to call from a demo, an e2e run or an on-prem box. `pricingMode: "api"` is
  // exercised by the adapter tests instead, where a stub quoter stands in.
  const motorTable = (base: number, ratePpm: number, minPremiumMinor: number): string =>
    JSON.stringify({
      base,
      bands: [
        { field: "age", min: 18, max: 24, factorPpm: 1_450_000 },
        { field: "age", min: 25, max: 39, factorPpm: 1_050_000 },
        { field: "age", min: 40, max: 120, factorPpm: 900_000 }
      ],
      rates: [{ field: "sumInsuredMinor", ratePpm }],
      loadings: [{ field: "priorClaims", whenTrue: 30_000 }],
      minPremiumMinor,
      taxPpm: 50_000 // 5% VAT
    });

  await db.insert(schema.distOfferings).values([
    // Our own paper: no external commission, the whole margin is underwriting result.
    offering(
      "gonxtMotor",
      providers.gonxt,
      products.motor,
      "GNX-MOT-STD",
      "GONXT Motor Standard",
      "جي أو إن إكس تي – تأمين مركبات قياسي",
      0,
      {
        pricingMode: "table",
        ratingTableJson: motorTable(60_000, 7_800, 95_000),
        coverageJson: JSON.stringify({ excessMinor: 100_000, agencyRepair: false, roadside: true }),
        crossSellTagsJson: JSON.stringify(["motor_owner"])
      }
    ),
    offering("falconMotor", providers.falcon, products.motor, "FAL-MOT-COMP", "Falcon Motor Comprehensive", "فالكون – شامل للمركبات", 150_000, {
      pricingMode: "table",
      ratingTableJson: motorTable(80_000, 9_100, 120_000),
      eligibilityJson: JSON.stringify({ minAge: 21, markets: ["AE"], requires: { vehicleUse: "private" } }),
      coverageJson: JSON.stringify({ excessMinor: 50_000, agencyRepair: true, roadside: true }),
      crossSellTagsJson: JSON.stringify(["motor_owner"])
    }),
    offering("cedarMotor", providers.cedar, products.motor, "CDR-MOT-ESS", "Cedar Motor Essential", "سيدار – أساسي للمركبات", 125_000, {
      pricingMode: "table",
      ratingTableJson: motorTable(52_000, 7_200, 85_000),
      coverageJson: JSON.stringify({ excessMinor: 150_000, agencyRepair: false, roadside: false })
    }),
    offering("cedarMotorPlus", providers.cedar, products.motor, "CDR-MOT-PLUS", "Cedar Motor Plus", "سيدار – بلس للمركبات", 175_000, {
      pricingMode: "table",
      ratingTableJson: motorTable(96_000, 10_400, 150_000),
      // Priced for higher-value vehicles: a small risk is declined, and the
      // comparison shows why rather than quietly returning a shorter panel.
      eligibilityJson: JSON.stringify({ minSumInsuredMinor: 5_000_000 }),
      coverageJson: JSON.stringify({ excessMinor: 0, agencyRepair: true, roadside: true }),
      upsellOfOfferingId: offerings.cedarMotor
    }),
    offering("oryxMotor", providers.oryx, products.motor, "ORX-MOT-TKF", "Oryx Motor Takaful", "أوريكس – تكافل المركبات", 140_000, {
      pricingMode: "manual",
      slaSeconds: 120
    }),
    offering("gulfHealth", providers.gulfHealth, products.health, "GHA-IND-SILVER", "Gulf Health Individual Silver", "الخليج الصحي – فضي فردي", 100_000, {
      pricingMode: "referral",
      slaSeconds: 300,
      crossSellTagsJson: JSON.stringify(["family", "new_parent"])
    }),
    offering("gonxtTravel", providers.gonxt, products.travel, "GNX-TRV-ANN", "GONXT Travel Annual", "جي أو إن إكس تي – سفر سنوي", 0, {
      pricingMode: "table",
      ratingTableJson: JSON.stringify({
        base: 18_000,
        bands: [
          { field: "tripDays", min: 1, max: 14, factorPpm: 1_000_000 },
          { field: "tripDays", min: 15, max: 60, factorPpm: 1_600_000 },
          { field: "tripDays", min: 61, max: 365, factorPpm: 2_400_000 }
        ],
        loadings: [{ field: "winterSports", whenTrue: 12_000 }],
        minPremiumMinor: 15_000,
        taxPpm: 50_000
      }),
      crossSellTagsJson: JSON.stringify(["traveller", "motor_owner"])
    }),
    offering("cedarHome", providers.cedar, products.home, "CDR-HOM-CONT", "Cedar Home Contents", "سيدار – محتويات المنزل", 200_000, {
      pricingMode: "table",
      ratingTableJson: JSON.stringify({
        base: 24_000,
        rates: [{ field: "sumInsuredMinor", ratePpm: 3_400 }],
        loadings: [{ field: "priorClaims", whenTrue: 20_000 }],
        minPremiumMinor: 40_000,
        taxPpm: 50_000
      }),
      crossSellTagsJson: JSON.stringify(["homeowner", "motor_owner"])
    }),
    offering("oryxLife", providers.oryx, products.life, "ORX-LIF-TERM", "Oryx Term Takaful", "أوريكس – تكافل الحياة", 300_000, {
      pricingMode: "manual",
      crossSellTagsJson: JSON.stringify(["new_parent"])
    }),
    offering("zenithMotor", providers.zenith, products.motor, "ZEN-MOT-LIVE", "Zenith Motor Live", "زينيث – حي للمركبات", 110_000, {
      pricingMode: "api",
      coverageJson: JSON.stringify({ excessMinor: 100_000, agencyRepair: false, roadside: false }),
      crossSellTagsJson: JSON.stringify(["motor_owner"])
    })
  ]);

  /* --------------------------------------------------------- channels */
  const channels = {
    web: id("ch", now),
    app: id("ch", now + 1),
    callCentre: id("ch", now + 2),
    brokerAlpha: id("ch", now + 3),
    bankEmbed: id("ch", now + 4)
  };
  await db.insert(schema.distChannels).values([
    {
      id: channels.web,
      tenantId,
      key: "gonxt-web",
      kind: "b2c",
      nameJson: JSON.stringify({ en: "gonxt.ae", ar: "gonxt.ae" }),
      medium: "web",
      collectsPayment: "us",
      currency: "AED",
      createdAt: now,
      updatedAt: now
    },
    {
      id: channels.app,
      tenantId,
      key: "gonxt-app",
      kind: "b2c",
      nameJson: JSON.stringify({ en: "GONXT app", ar: "تطبيق GONXT" }),
      medium: "app",
      collectsPayment: "us",
      currency: "AED",
      createdAt: now,
      updatedAt: now
    },
    {
      id: channels.callCentre,
      tenantId,
      key: "gonxt-call",
      kind: "b2c",
      nameJson: JSON.stringify({ en: "Call centre", ar: "مركز الاتصال" }),
      medium: "call_centre",
      collectsPayment: "us",
      currency: "AED",
      createdAt: now,
      updatedAt: now
    },
    {
      id: channels.brokerAlpha,
      tenantId,
      key: "alpha-brokers",
      kind: "b2b",
      nameJson: JSON.stringify({ en: "Alpha Brokers", ar: "ألفا للوساطة" }),
      medium: "portal",
      collectsPayment: "us",
      defaultCommissionPpm: 300_000,
      settlementTermsJson: JSON.stringify({ frequency: "monthly", dayOfMonth: 10, netDays: 15, minPayoutMinor: 50_000 }),
      currency: "AED",
      createdAt: now,
      updatedAt: now
    },
    {
      id: channels.bankEmbed,
      tenantId,
      key: "meridian-embed",
      kind: "b2b",
      nameJson: JSON.stringify({ en: "Meridian Bank embed", ar: "تضمين بنك ميريديان" }),
      medium: "embed",
      collectsPayment: "partner",
      defaultCommissionPpm: 400_000,
      settlementTermsJson: JSON.stringify({ frequency: "monthly", dayOfMonth: 5, netDays: 30 }),
      currency: "AED",
      createdAt: now,
      updatedAt: now
    }
  ]);

  /* -------------------------------------------------- commission rates */
  await db.insert(schema.distCommissionRates).values([
    {
      id: id("cr", now),
      tenantId,
      channelId: channels.brokerAlpha,
      productId: products.motor,
      channelSharePpm: 350_000,
      earnedOn: "collection",
      clawbackDays: 30,
      effectiveFrom: now,
      createdBy: `user:${users["tenant.admin"]}`,
      createdAt: now
    },
    {
      id: id("cr", now + 1),
      tenantId,
      channelId: channels.brokerAlpha,
      offeringId: offerings.cedarMotorPlus,
      channelSharePpm: 450_000,
      earnedOn: "collection",
      clawbackDays: 30,
      effectiveFrom: now,
      createdBy: `user:${users["tenant.admin"]}`,
      createdAt: now
    },
    {
      id: id("cr", now + 2),
      tenantId,
      channelId: channels.brokerAlpha,
      productId: products.health,
      channelSharePpm: 250_000,
      flatFeeMinor: 2_500,
      earnedOn: "collection",
      effectiveFrom: now,
      createdBy: `user:${users["tenant.admin"]}`,
      createdAt: now
    },
    {
      id: id("cr", now + 3),
      tenantId,
      channelId: channels.bankEmbed,
      line: "motor",
      channelSharePpm: 400_000,
      earnedOn: "issue",
      clawbackDays: 45,
      effectiveFrom: now,
      createdBy: `user:${users["tenant.admin"]}`,
      createdAt: now
    }
  ]);

  /* ----------------------------------------------- a live comparative shop */
  const customerId = id("cu", now);
  const consentId = id("cn", now);
  await db.insert(schema.customers).values({
    id: customerId,
    tenantId,
    type: "person",
    nameJson: JSON.stringify({ en: "Rania Haddad", ar: "رانيا حداد" }),
    emailsJson: JSON.stringify(["rania.haddad@example.ae"]),
    phonesJson: JSON.stringify(["+971501234567"]),
    kycStatus: "verified",
    consentId,
    locale: "en",
    // Targeting attributes under the `axis:value` grammar packages/core/src/targeting.ts
    // parses, on the axes the Gulf pack declares. Her quote request below says
    // 34 and Dubai; a AED 280k Land Cruiser puts her in the top fifth.
    tagsJson: JSON.stringify([
      "region:dubai",
      "ageband:25-34",
      "incomequintile:5",
      "language:en",
      "lifestage:family"
    ]),
    createdAt: now,
    updatedAt: now
  });
  await db.insert(schema.consents).values({
    id: consentId,
    tenantId,
    customerId,
    // dataSharing is what licenses the fan-out to the panel.
    purposesJson: JSON.stringify({ marketing: true, profiling: true, dataSharing: true, crossBorder: false }),
    channelOptinsJson: JSON.stringify({ email: true, sms: false, whatsapp: true, voice: false, push: true }),
    source: "web",
    ts: now,
    version: 1
  });

  const requestId = id("qr", now);
  await db.insert(schema.distQuoteRequests).values({
    id: requestId,
    tenantId,
    customerId,
    channelId: channels.web,
    productId: products.motor,
    inputsJson: JSON.stringify({
      vehicle: { make: "Toyota", model: "Land Cruiser", year: 2023, valueMinor: 28_000_000 },
      driver: { age: 34, licenceYears: 9, claimsLast3y: 0 },
      emirate: "Dubai"
    }),
    consentId,
    fanoutCount: 4,
    respondedCount: 4,
    bestOfferingId: offerings.cedarMotor,
    bestPremiumMinor: 412_500,
    currency: "AED",
    sharedWithCustomerAt: now + 40_000,
    state: "complete",
    expiresAt: now + 14 * DAY,
    createdAt: now,
    updatedAt: now + 40_000
  });

  interface FanoutRow {
    key: keyof typeof offerings;
    providerId: string;
    premiumMinor: number;
    basePpm: number;
    rank: number;
    valueScore: number;
    rationaleKey: string;
  }
  const responses: readonly FanoutRow[] = [
    { key: "cedarMotor", providerId: providers.cedar, premiumMinor: 412_500, basePpm: 125_000, rank: 1, valueScore: 78, rationaleKey: "rationale.cheapest" },
    { key: "falconMotor", providerId: providers.falcon, premiumMinor: 448_000, basePpm: 150_000, rank: 2, valueScore: 86, rationaleKey: "rationale.best_value" },
    { key: "cedarMotorPlus", providerId: providers.cedar, premiumMinor: 521_000, basePpm: 175_000, rank: 3, valueScore: 91, rationaleKey: "rationale.widest_cover" },
    { key: "gonxtMotor", providerId: providers.gonxt, premiumMinor: 465_000, basePpm: 0, rank: 4, valueScore: 74, rationaleKey: "rationale.own_paper" }
  ];
  const responseIds: Partial<Record<keyof typeof offerings, string>> = {};
  let r = 0;
  for (const row of responses) {
    // b2c web channel: no channel share, so gross === net before tax.
    const split = splitCommission({ premiumMinor: row.premiumMinor, baseCommissionPpm: row.basePpm });
    const responseId = id("qs", now + r);
    responseIds[row.key] = responseId;
    await db.insert(schema.distQuoteResponses).values({
      id: responseId,
      tenantId,
      requestId,
      offeringId: offerings[row.key],
      providerId: row.providerId,
      state: "quoted",
      premiumMinor: row.premiumMinor,
      taxMinor: Math.round(row.premiumMinor * 0.05),
      currency: "AED",
      commissionPpm: row.basePpm,
      commissionMinor: split.grossMinor,
      channelCommissionMinor: 0,
      coverageJson: JSON.stringify({ excessMinor: 100_000, agencyRepair: row.rank <= 2, roadside: true }),
      priceRank: row.rank,
      valueScore: row.valueScore,
      rationaleKey: row.rationaleKey,
      latencyMs: 900 + r * 350,
      validUntil: now + 14 * DAY,
      createdAt: now + 1_000 * (r + 1),
      updatedAt: now + 1_000 * (r + 1)
    });
    r++;
  }

  /* ------------------------------------ the sale: case -> quote -> policy -> money */
  const won = responses[0]!; // the customer took the cheapest
  const caseId = id("cs", now);
  const issuedAt = now + 2 * DAY;
  await db.insert(schema.axisCases).values({
    id: caseId,
    tenantId,
    ref: "GNX-2601-0001",
    kind: "bind",
    customerId,
    productLine: "motor",
    channelId: channels.web,
    quoteRequestId: requestId,
    status: "issued",
    ownerRef: `user:${users["axis.agent"]}`,
    teamId: teams.motor,
    source: "web",
    valueMinor: won.premiumMinor,
    currency: "AED",
    closedAt: issuedAt,
    createdAt: now,
    updatedAt: issuedAt
  });
  // docs/27 F13: the winning quote is the `dist_quote_responses` row the panel
  // already wrote. There is no second `axis_quotes` row saying the same thing —
  // the sale points at the answer the provider actually gave.
  await db
    .update(schema.distQuoteResponses)
    .set({ selectedAt: issuedAt, updatedAt: issuedAt })
    .where(eq(schema.distQuoteResponses.id, responseIds[won.key]!));

  const sale = splitCommission({ premiumMinor: won.premiumMinor, baseCommissionPpm: won.basePpm });
  const policyId = id("pol", issuedAt);
  const versionId = id("pver", issuedAt);
  await db.insert(schema.axisPolicies).values({
    id: policyId,
    tenantId,
    caseId,
    customerId,
    providerId: won.providerId,
    productId: products.motor,
    offeringId: offerings[won.key],
    channelId: channels.web,
    policyNo: "CDR-MOT-2601-778201",
    startAt: issuedAt,
    endAt: issuedAt + 365 * DAY,
    premiumMinor: won.premiumMinor,
    currency: "AED",
    commissionMinor: sale.grossMinor,
    status: "active",
    currentVersionId: versionId,
    versionSeq: 1,
    createdAt: issuedAt,
    updatedAt: issuedAt
  });
  // Version 1 of the schedule, as a real bind writes it (routes/axis.ts
  // `bindPolicy`). Without it the demo policy has no history for the versions
  // tab, and F13's join — sale back to quote — has nothing to hang on.
  await db.insert(schema.axisPolicyVersions).values({
    id: versionId,
    tenantId,
    policyId,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: issuedAt,
    effectiveTo: issuedAt + 365 * DAY,
    premiumMinor: won.premiumMinor,
    taxMinor: 0,
    feesMinor: 0,
    commissionMinor: sale.grossMinor,
    currency: "AED",
    premiumDeltaMinor: 0,
    termsJson: JSON.stringify({ excessMinor: 100_000, agencyRepair: true, roadside: true }),
    quoteResponseId: responseIds[won.key]!,
    state: "effective",
    issuedBy: `user:${users["axis.agent"]}`,
    issuedAt,
    createdAt: issuedAt,
    updatedAt: issuedAt
  });
  // Last year's cover for the same customer, ending inside the renewal window.
  // The sweep on the scheduled tick raises it, so the retention desk opens on a
  // real queue instead of an empty one (docs/05 J-C3).
  const renewalPolicyId = id("pol", issuedAt + 1);
  await db.insert(schema.axisPolicies).values({
    id: renewalPolicyId,
    tenantId,
    customerId,
    providerId: won.providerId,
    productId: products.motor,
    offeringId: offerings[won.key],
    channelId: channels.web,
    policyNo: "CDR-MOT-2501-664118",
    startAt: now - 345 * DAY,
    endAt: now + 20 * DAY,
    premiumMinor: won.premiumMinor,
    currency: "AED",
    commissionMinor: sale.grossMinor,
    status: "active",
    createdAt: now - 345 * DAY,
    updatedAt: now - 345 * DAY
  });
  await db.insert(schema.distCommissionEntries).values({
    id: id("ce", issuedAt),
    tenantId,
    policyId,
    offeringId: offerings[won.key],
    providerId: won.providerId,
    channelId: channels.web,
    kind: "new_business",
    premiumMinor: won.premiumMinor,
    grossCommissionMinor: sale.grossMinor,
    channelCommissionMinor: sale.channelMinor,
    netCommissionMinor: sale.netMinor,
    taxMinor: sale.taxMinor,
    currency: "AED",
    earnedOn: "issue",
    earnedAt: issuedAt,
    state: "accrued",
    createdAt: issuedAt,
    updatedAt: issuedAt
  });

  // The AI's next best offer on this journey: a motor buyer with a villa address.
  await db.insert(schema.distNextBestOffers).values({
    id: id("nb", now),
    tenantId,
    customerId,
    kind: "cross_sell",
    offeringId: offerings.cedarHome,
    anchorRef: `quote_request:${requestId}`,
    channelId: channels.web,
    score: 72,
    expectedValueMinor: 96_000,
    currency: "AED",
    reasonKey: "nbo.reason.motor_to_home",
    reasonJson: JSON.stringify({ signals: ["villa_address", "high_vehicle_value", "no_home_policy"] }),
    state: "proposed",
    expiresAt: now + 30 * DAY,
    createdAt: now,
    updatedAt: now
  });

  /* --------------------------------------------------------------- ai */
  // One agent per module, each pointing at a versioned prompt row. Without
  // these `POST /v1/ai/runs` 404s on every key, so the demo tenant would ship
  // with no AI at all — and an inline prompt in code cannot be diffed against
  // the version that produced a bad answer (docs/15).
  const agents: { key: string; module: string; tier: string; autonomy: string; en: string; ar: string; desc: string; tools: string[]; prompt: string }[] = [
    {
      key: "quoting",
      module: "dist",
      tier: "standard",
      autonomy: "suggest",
      en: "Quote adviser",
      ar: "مستشار التسعير",
      desc: "Explains a comparison panel in plain language and flags the cross-sell worth raising.",
      tools: ["dist.quote_requests.read", "dist.offerings.read", "dist.next_best_offers.propose"],
      prompt:
        "You compare insurance offerings for a customer of an aggregator. You are given the ranked panel " +
        "as JSON: premium, cover differences, excess, and any declined or referred rows. Explain in at most " +
        "five sentences why the best-value row won, what the cheapest row gives up, and why any row was " +
        "declined. Name a cross-sell only when a signal in the input supports it. Never invent a price, a " +
        "cover term or a provider that is not in the input. Answer in the customer's locale."
    },
    {
      key: "copilot",
      module: "axis",
      tier: "standard",
      autonomy: "act_with_approval",
      en: "Case copilot",
      ar: "مساعد الملفات",
      desc: "Summarises a case, drafts the next action, and prepares the quote comparison for the agent.",
      tools: ["axis.cases.read", "axis.quotes.compare", "core.customers.read", "axis.tasks.write"],
      prompt:
        "You assist a licensed insurance agent working a case. Summarise the case state, then propose the " +
        "single next action with the reason. Draft customer-facing text only as a draft for the agent to " +
        "send — never claim it has been sent. You may not give regulated advice, quote a price that is not " +
        "in the input, or promise cover. If a required document is missing, say which one."
    },
    {
      key: "renewal",
      module: "orbit",
      tier: "fast",
      autonomy: "suggest",
      en: "Renewal agent",
      ar: "وكيل التجديد",
      desc: "Ranks the renewal book by churn risk and drafts the retention offer.",
      tools: ["orbit.renewals.read", "orbit.conversations.reply", "dist.next_best_offers.propose"],
      prompt:
        "You triage a renewal book. For each policy in the input, give a churn risk of low, medium or high " +
        "with the one signal that drove it, and a retention action. Use only the premium history, claims " +
        "and contact history given. Do not offer a discount that is not in the allowed list."
    },
    {
      // docs/27 F7. The agent behind the pending drafts in the ORBIT inbox —
      // apps/api/src/engines/orbit-draft.ts resolves this key on every tick and
      // skips the sweep entirely when it is missing or paused, which is how an
      // operator turns drafting off without a deploy.
      key: "service",
      module: "orbit",
      tier: "fast",
      autonomy: "suggest",
      en: "Service agent",
      ar: "وكيل الخدمة",
      desc: "Drafts the next reply to a waiting customer for a human to approve before it is sent.",
      tools: ["fetch_policy"],
      prompt:
        "You draft the next reply to an insurance customer who is waiting on us. Answer only from the " +
        "context lines given: the customer's policies, claims and the conversation so far. Never state a " +
        "premium, excess, date or reference that is not in the context — say you will confirm it instead. " +
        "Never say a message has been sent, a payment taken or a change made: a human approves your draft " +
        "before the customer sees it. No regulated advice, no promise of cover, no discount. Two to four " +
        "sentences, in the customer's language, no greeting boilerplate beyond one line."
    },
    {
      key: "creative",
      module: "signal",
      tier: "standard",
      autonomy: "suggest",
      en: "Creative studio",
      ar: "استوديو المحتوى",
      desc: "Drafts campaign copy and variants for human approval before anything is published.",
      tools: ["signal.campaigns.read", "signal.creatives.write"],
      prompt:
        "You draft marketing copy for a regulated insurance distributor. Every draft is a proposal for a " +
        "human to approve; nothing you write is published directly. Do not state a price, a guarantee, a " +
        "regulatory status or a comparison claim unless it is in the input. No urgency pressure, no " +
        "invented testimonials, no likeness of a real person."
    },
    {
      key: "discovery",
      module: "scout",
      tier: "reasoning",
      autonomy: "suggest",
      en: "Market scout",
      ar: "كشّاف السوق",
      desc: "Reads market signals and proposes experiments in underserved segments.",
      tools: ["scout.signals.read", "scout.whitespaces.read", "scout.experiments.create"],
      prompt:
        "You look for gaps in an insurance distributor's product coverage. From the segment and signal " +
        "data given, propose at most three testable experiments, each with a hypothesis, the metric that " +
        "would settle it, and the smallest version worth running. Say when the data is too thin to support " +
        "a proposal rather than proposing anyway."
    },
    {
      key: "briefing",
      module: "north",
      tier: "reasoning",
      autonomy: "suggest",
      en: "Executive briefing",
      ar: "الإحاطة التنفيذية",
      desc: "Turns the metric set into a short briefing with the anomalies called out first.",
      tools: ["north.metrics.read", "north.anomalies.read", "analytics.reports.run"],
      prompt:
        "You write an executive briefing from the metrics given. Lead with what changed and by how much, " +
        "then what is likely driving it, then the decision it calls for. Every number must come from the " +
        "input. Where a movement has no explanation in the data, say so instead of guessing."
    },
    {
      key: "recon",
      module: "ledger",
      tier: "fast",
      autonomy: "suggest",
      en: "Reconciliation agent",
      ar: "وكيل التسوية",
      desc: "Matches statement lines to ledger entries and explains what is left unmatched.",
      tools: ["ledger.recon.run", "ledger.journals.read", "ledger.settlements.read"],
      prompt:
        "You reconcile a provider or bank statement against ledger entries. Propose matches with the " +
        "amount, date and reference that justify each one. Never propose a match on amount alone when the " +
        "reference disagrees. List the unmatched lines with the reason they could not be matched. You " +
        "propose only — no posting is made by you."
    },
    {
      key: "qa",
      module: "core",
      tier: "standard",
      autonomy: "suggest",
      en: "Quality reviewer",
      ar: "مراجع الجودة",
      desc: "Reviews AI output and agent conversations against the guardrails before they reach a customer.",
      tools: ["ai.runs.read", "core.audit.read"],
      prompt:
        "You review a draft that is about to reach a customer. Check it against these rules: no regulated " +
        "advice, no price or cover term absent from the source data, no regulatory or comparison claim " +
        "without a source, no personal data beyond what the recipient may see. Return pass or fail with " +
        "the specific offending sentence."
    }
  ];

  const promptRows: (typeof schema.aiPrompts.$inferInsert)[] = [];
  const agentRows: (typeof schema.aiAgents.$inferInsert)[] = [];
  let a2 = 0;
  for (const agent of agents) {
    const promptKey = `prompt.${agent.key}.system`;
    promptRows.push({
      id: id("pmt", now + a2),
      tenantId,
      key: promptKey,
      version: 1,
      locale: "en",
      body: agent.prompt,
      status: "active",
      createdBy: users["dev.admin"]!,
      createdAt: now
    });
    agentRows.push({
      id: id("agt", now + a2),
      tenantId,
      key: agent.key,
      module: agent.module,
      nameJson: JSON.stringify({ en: agent.en, ar: agent.ar }),
      descriptionJson: JSON.stringify({ en: agent.desc }),
      autonomyLevel: agent.autonomy,
      tier: agent.tier,
      toolsJson: JSON.stringify(agent.tools),
      // Budget and PII rules are enforced in the gateway; this is what the
      // console shows an operator and what an eval asserts against.
      guardrailsJson: JSON.stringify({
        maxTokens: 2_000,
        piiRedaction: true,
        requiresConsent: agent.module === "dist" || agent.module === "orbit",
        humanApproval: agent.autonomy === "act_with_approval"
      }),
      promptRef: promptKey,
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    a2++;
  }
  // Arabic is a first-class locale, not a translation layer: the resolver picks
  // the prompt for the actor's locale, so at least one has to exist to prove it.
  promptRows.push({
    id: id("pmt", now + a2),
    tenantId,
    key: "prompt.quoting.system",
    version: 1,
    locale: "ar",
    body:
      "أنت تقارن عروض التأمين لعميل لدى وسيط مقارنة. تحصل على لوحة المقارنة المرتبة بصيغة JSON: القسط، " +
      "فروق التغطية، التحمّل، وأي عرض مرفوض أو محال. اشرح في خمس جمل كحد أقصى سبب فوز العرض الأفضل قيمة، " +
      "وما الذي يتنازل عنه العرض الأرخص، وسبب رفض أي عرض. لا تذكر منتجاً إضافياً إلا إذا دعمته بيانات " +
      "المدخلات. لا تخترع سعراً أو شرط تغطية أو مزوّداً غير وارد في المدخلات.",
    status: "active",
    createdBy: users["dev.admin"]!,
    createdAt: now
  });

  await db.insert(schema.aiPrompts).values(promptRows);
  await db.insert(schema.aiAgents).values(agentRows);

  /* ------------------------------------------------------------------ north */
  // NORTH is a rollup, never a hot-table read (docs/modules/north.md §2.1), so
  // these rows describe the *same* book the panel above describes — five lines
  // from five underwriters, three b2c channels and two b2b channels — one
  // closed accounting period behind the live sale seeded above. Money is minor
  // units (fils); every percent and ratio is basis points, and the scale is
  // carried in `targetJson` because the registry has no scale column.
  //
  // Periods are derived from `now` (seed/period.ts), not written down: a demo
  // provisioned in August must not narrate January, and a rolling window on a
  // screen is empty if the data behind it is a year old.
  const BPS = "bps";

  const METRICS: ReadonlyArray<{
    key: string;
    en: string;
    ar: string;
    def: string;
    unit: "count" | "money" | "percent" | "ratio" | "duration_ms";
    grain: "day" | "week" | "month";
    direction: "up" | "down";
    owner: string;
    sensitivity?: "public" | "internal" | "restricted";
    target: Record<string, unknown>;
  }> = [
    {
      key: "gwp",
      en: "Gross written premium",
      ar: "إجمالي الأقساط المكتتبة",
      def: "v_exec_daily.premium_minor",
      unit: "money",
      grain: "month",
      direction: "up",
      owner: "faisal.omar",
      target: { value: 230_000_000, scale: "minor", currency: "AED" }
    },
    {
      key: "net_commission",
      en: "Net commission retained",
      ar: "صافي العمولة المحتفظ بها",
      def: "dist_commission_entries.net_commission_minor",
      unit: "money",
      grain: "month",
      direction: "up",
      owner: "faisal.omar",
      target: { value: 21_000_000, scale: "minor", currency: "AED" }
    },
    {
      key: "active_policies",
      en: "Policies in force",
      ar: "الوثائق السارية",
      def: "axis_policies WHERE status = 'active'",
      unit: "count",
      grain: "month",
      direction: "up",
      owner: "omar.farouk",
      target: { value: 4_800, scale: "count" }
    },
    {
      key: "renewal_retention",
      en: "Renewal retention rate",
      ar: "معدل الاحتفاظ عند التجديد",
      def: "v_renewal_book: accepted / (accepted + lost)",
      unit: "percent",
      grain: "month",
      direction: "up",
      owner: "yusuf.karim",
      target: { value: 8_500, scale: BPS }
    },
    {
      key: "cac_per_policy",
      en: "Acquisition cost per policy",
      ar: "تكلفة اكتساب الوثيقة",
      def: "v_cac_ltv.spend_minor / v_cac_ltv.binds",
      unit: "money",
      grain: "month",
      direction: "down",
      owner: "noor.jamal",
      target: { value: 19_000, scale: "minor", currency: "AED" }
    },
    {
      key: "broker_channel_share",
      en: "Share of premium through b2b channels",
      ar: "حصة الأقساط عبر قنوات الأعمال",
      def: "axis_policies JOIN dist_channels ON kind = 'b2b'",
      unit: "percent",
      grain: "month",
      direction: "up",
      owner: "dana.aziz",
      target: { value: 4_000, scale: BPS }
    },
    {
      key: "loss_ratio",
      en: "Loss ratio — own paper",
      ar: "نسبة الخسارة — الاكتتاب الذاتي",
      def: "axis_claims / axis_policies WHERE provider is internal",
      unit: "ratio",
      grain: "month",
      direction: "down",
      owner: "faisal.omar",
      // Only GONXT's own underwriting result, so it is not a number the panel
      // partners or the b2b channels get to see.
      sensitivity: "restricted",
      target: { value: 6_000, scale: BPS }
    },
    {
      key: "ai_cost_per_case",
      en: "AI cost per case",
      ar: "تكلفة الذكاء الاصطناعي لكل ملف",
      def: "v_exec_daily.ai_cost_micro / v_exec_daily.cases_created",
      unit: "money",
      grain: "month",
      direction: "down",
      owner: "raed.samir",
      target: { value: 100, scale: "minor", currency: "AED" }
    },
    {
      key: "policies_issued",
      en: "Policies issued",
      ar: "الوثائق المُصدرة",
      def: "v_exec_daily.policies_issued",
      unit: "count",
      grain: "day",
      direction: "up",
      owner: "omar.farouk",
      target: { value: 55, scale: "count" }
    },
    {
      key: "quote_to_bind_rate",
      en: "Quote to bind rate",
      ar: "معدل التحويل من عرض إلى وثيقة",
      def: "axis_policies / dist_quote_requests WHERE state = 'complete'",
      unit: "percent",
      grain: "day",
      direction: "up",
      owner: "layla.hassan",
      target: { value: 2_400, scale: BPS }
    },
    {
      key: "panel_response_rate",
      en: "Panel response rate",
      ar: "معدل استجابة لوحة المزوّدين",
      def: "dist_quote_requests.responded_count / dist_quote_requests.fanout_count",
      unit: "percent",
      grain: "day",
      direction: "up",
      owner: "dana.aziz",
      target: { value: 9_700, scale: BPS }
    },
    {
      key: "quote_latency_p95",
      en: "Quote latency p95",
      ar: "زمن استجابة التسعير — المئين ٩٥",
      def: "dist_quote_responses.latency_ms, p95",
      unit: "duration_ms",
      grain: "day",
      direction: "down",
      owner: "raed.samir",
      sensitivity: "public",
      target: { value: 2_500, scale: "ms" }
    },
    // AXIS task 15 (docs/specs/gap-axis-design.md §F); see ADR-0024/ADR-0034.
    {
      key: "gross_written_premium",
      en: "Gross written premium",
      ar: "إجمالي الأقساط المكتتبة",
      def: "SUM(axis_policy_versions.premium_minor + tax_minor + fees_minor) WHERE effective_from in period AND state != 'voided'",
      unit: "money",
      grain: "day",
      direction: "up",
      owner: "faisal.omar",
      target: { value: 7_500_000, scale: "minor", currency: "AED" }
    },
    {
      key: "net_written_premium",
      en: "Net written premium",
      ar: "صافي الأقساط المكتتبة",
      def: "SUM(axis_policy_versions.premium_minor) WHERE effective_from in period AND state != 'voided'",
      unit: "money",
      grain: "day",
      direction: "up",
      owner: "faisal.omar",
      target: { value: 6_800_000, scale: "minor", currency: "AED" }
    },
    {
      key: "expense_ratio",
      en: "Expense ratio",
      ar: "نسبة المصروفات",
      def: "SUM(ledger_journal_lines WHERE account_code LIKE '5%') / earned_premium",
      unit: "ratio",
      grain: "month",
      direction: "down",
      owner: "faisal.omar",
      sensitivity: "restricted",
      target: { value: 1_500, scale: BPS }
    },
    {
      key: "combined_ratio",
      en: "Combined ratio",
      ar: "النسبة المجمعة",
      def: "loss_ratio + expense_ratio",
      unit: "ratio",
      grain: "month",
      direction: "down",
      owner: "faisal.omar",
      sensitivity: "restricted",
      target: { value: 9_500, scale: BPS }
    },
    {
      key: "quote_hit_rate",
      en: "Quote hit rate",
      ar: "معدل تحويل العروض",
      def: "COUNT(ledger_txns type='BIND' created) / COUNT(dist_quote_requests created)",
      unit: "percent",
      grain: "day",
      direction: "up",
      owner: "layla.hassan",
      target: { value: 2_400, scale: BPS }
    },
    {
      key: "avg_handling_time_claims",
      en: "Avg handling time — claims",
      ar: "متوسط زمن معالجة المطالبات",
      def: "MEDIAN(axis_claims.closed_at - reported_at) WHERE closed_at in period",
      unit: "duration_ms",
      grain: "day",
      direction: "down",
      owner: "yusuf.karim",
      target: { value: 5 * DAY, scale: "ms" }
    },
    {
      key: "avg_handling_time_cases",
      en: "Avg handling time — cases",
      ar: "متوسط زمن معالجة الملفات",
      def: "MEDIAN(axis_cases.closed_at - created_at) WHERE closed_at in period",
      unit: "duration_ms",
      grain: "day",
      direction: "down",
      owner: "raed.samir",
      target: { value: 2 * DAY, scale: "ms" }
    },
    {
      key: "reserve_adequacy",
      en: "Reserve adequacy",
      ar: "كفاية المخصصات",
      def: "SUM(reserve at report+30d) / SUM(final paid) over axis_claims closed in period",
      unit: "ratio",
      grain: "month",
      direction: "up",
      owner: "yusuf.karim",
      sensitivity: "restricted",
      target: { value: 10_000, scale: BPS }
    },
    {
      key: "sla_breach_rate",
      en: "SLA breach rate",
      ar: "معدل خرق اتفاقية مستوى الخدمة",
      def: "COUNT(axis_cases + axis_claims closed past sla_due_at) / COUNT(closed)",
      unit: "percent",
      grain: "day",
      direction: "down",
      owner: "raed.samir",
      target: { value: 500, scale: BPS }
    },
    {
      key: "open_claim_count",
      en: "Open claim count",
      ar: "عدد المطالبات المفتوحة",
      def: "COUNT(axis_claims WHERE closed_at IS NULL AND status NOT IN ('withdrawn', 'rejected'))",
      unit: "count",
      grain: "month",
      direction: "down",
      owner: "yusuf.karim",
      target: { value: 120, scale: "count" }
    },
    {
      key: "whitespace_promotion_rate",
      en: "Whitespace promotion rate",
      ar: "معدل ترقية الفجوات السوقية",
      def: "COUNT(scout_whitespaces WHERE promoted_at IS NOT NULL) / COUNT(scout_whitespaces) over the month raised",
      unit: "percent",
      grain: "month",
      direction: "up",
      owner: "layla.hassan",
      target: { value: 3_000, scale: BPS }
    },
    {
      key: "campaign_return_on_spend",
      en: "Campaign return on spend",
      ar: "عائد الإنفاق على الحملات",
      def: "SUM(signal_attribution_events.value_minor WHERE touch_type='bind') / SUM(signal_spend.amount_minor)",
      unit: "ratio",
      grain: "month",
      direction: "up",
      owner: "layla.hassan",
      target: { value: 30_000, scale: BPS }
    },
    {
      key: "outstanding_reserve",
      en: "Outstanding reserve",
      ar: "المخصصات المستحقة",
      def: "SUM(axis_claims.reserve_minor)",
      unit: "money",
      grain: "month",
      direction: "down",
      owner: "yusuf.karim",
      sensitivity: "restricted",
      target: { value: 12_000_000, scale: "minor", currency: "AED" }
    },
    // The unit economics a buyer doing diligence asks for: what a lead costs,
    // what an acquisition costs, and what each contract and each customer pays
    // back against it. Noor Jamal owns the cost side (she already owns
    // cac_per_policy) and the LTV proxy that is read against it; Faisal Omar
    // owns the commission the finance book actually recognises.
    {
      key: "cost_per_lead",
      en: "Cost per lead",
      ar: "تكلفة العميل المحتمل",
      def: "SUM(signal_spend.amount_minor) / COUNT(signal_attribution_events WHERE touch_type='lead')",
      unit: "money",
      grain: "month",
      direction: "down",
      owner: "noor.jamal",
      target: { value: 3_500, scale: "minor", currency: "AED" }
    },
    {
      key: "cost_per_acquisition",
      en: "Cost per acquisition",
      ar: "تكلفة الاكتساب",
      def: "SUM(signal_spend.amount_minor) / COUNT(signal_attribution_events WHERE touch_type='bind')",
      unit: "money",
      grain: "month",
      direction: "down",
      owner: "noor.jamal",
      target: { value: 25_000, scale: "minor", currency: "AED" }
    },
    {
      key: "commission_per_policy",
      en: "Commission per policy",
      ar: "العمولة لكل وثيقة",
      def: "SUM(dist_commission_entries.net_commission_minor WHERE earned_at in period) / COUNT(axis_policies bound in period)",
      unit: "money",
      grain: "month",
      direction: "up",
      owner: "faisal.omar",
      target: { value: 48_000, scale: "minor", currency: "AED" }
    },
    {
      key: "revenue_per_customer",
      en: "Revenue per customer",
      ar: "الإيراد لكل عميل",
      def: "SUM(dist_commission_entries.net_commission_minor WHERE earned_at in period) / COUNT(DISTINCT axis_policies.customer_id bound in period)",
      unit: "money",
      grain: "month",
      direction: "up",
      owner: "noor.jamal",
      target: { value: 58_000, scale: "minor", currency: "AED" }
    }
  ];

  let m = 0;
  await db.insert(schema.northMetrics).values(
    METRICS.map((metric) => ({
      id: id("mtr", now + m++),
      tenantId,
      key: metric.key,
      nameJson: JSON.stringify({ en: metric.en, ar: metric.ar }),
      definitionSqlRef: metric.def,
      unit: metric.unit,
      currency: metric.unit === "money" ? "AED" : null,
      grain: metric.grain,
      owner: metric.owner,
      targetJson: JSON.stringify(metric.target),
      sensitivity: metric.sensitivity ?? "internal",
      direction: metric.direction,
      createdAt: now,
      updatedAt: now
    }))
  );

  /* --------------------------------------------------------- snapshots */
  // The nightly rollup runs at 02:00Z: a daily period is written the morning
  // after it closes, a monthly period on the 1st, and the open month is
  // rewritten every night. Both are expressed as an offset from `now`.
  // The three closed months plus the open one, and the five closed days.
  const MONTHS = [monthKey(now, -3), monthKey(now, -2), monthKey(now, -1), monthKey(now)];
  const DAYS = [5, 4, 3, 2, 1].map((back) => dayKey(now, -back));
  /** A closed month lands on the 1st of the next; the open one is this morning's rerun. */
  const monthRollupAt = (i: number): number =>
    (i === MONTHS.length - 1 ? dayStart(now) : monthStart(now, i - 2)) + 2 * HOUR;

  const MONTHLY: Record<string, readonly [number, number, number, number]> = {
    gwp: [186_400_000, 201_750_000, 238_900_000, 74_300_000],
    net_commission: [17_708_000, 19_166_000, 22_695_000, 7_058_000],
    active_policies: [4_182, 4_361, 4_608, 4_690],
    renewal_retention: [7_920, 8_050, 8_310, 8_180],
    cac_per_policy: [21_400, 20_150, 18_900, 24_600],
    broker_channel_share: [3_120, 3_380, 3_611, 3_740],
    loss_ratio: [6_140, 5_980, 6_420, 6_050],
    ai_cost_per_case: [118, 104, 96, 91],
    // The demand loop the board reads across: what SCOUT raised and the desk
    // acted on, and what SIGNAL's spend brought back against it.
    whitespace_promotion_rate: [2_000, 2_500, 3_300, 2_800],
    campaign_return_on_spend: [24_000, 27_500, 31_200, 29_000],
    // Acquisition unit economics, in minor units. The cost side falls through
    // the quarter as the autopilot moves budget off social and onto search,
    // then turns up in the open month — the same shape cac_per_policy has,
    // because it is the same spend seen a different way. An acquisition costs
    // more than a blended policy does (18_900 last month) because only the
    // contracts SIGNAL is credited with divide it. Revenue per customer stays
    // above cost per acquisition all quarter: the business is not buying
    // customers at a loss, and it is above commission per policy because some
    // customers hold more than one contract.
    cost_per_lead: [3_950, 3_720, 3_480, 4_210],
    cost_per_acquisition: [28_600, 26_400, 24_100, 29_800],
    commission_per_policy: [44_200, 45_900, 47_600, 46_100],
    revenue_per_customer: [51_300, 53_700, 56_400, 54_200]
  };
  const DAILY: Record<string, readonly [number, number, number, number, number]> = {
    policies_issued: [41, 38, 52, 61, 57],
    quote_to_bind_rate: [2_310, 2_280, 2_405, 2_360, 1_890],
    panel_response_rate: [9_650, 9_720, 9_580, 9_240, 8_810],
    quote_latency_p95: [2_150, 2_080, 2_310, 3_040, 3_620]
  };

  // Readable and unique per dimension set, which is all the unique index needs.
  // ponytail: a digest buys nothing at this cardinality — swap it for one when
  // a dimension value can contain "=" or "&".
  const dimsHash = (dims: Record<string, string>): string =>
    Object.entries(dims)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

  // The last closed month by channel and by underwriter — both sum to that
  // month's total, so drilling into the metric never disagrees with the headline.
  const LAST_MONTH_SPLITS: ReadonlyArray<{ dims: Record<string, string>; value: number }> = [
    { dims: { channel: "gonxt-web" }, value: 96_420_000 },
    { dims: { channel: "gonxt-app" }, value: 41_880_000 },
    { dims: { channel: "gonxt-call" }, value: 14_320_000 },
    { dims: { channel: "alpha-brokers" }, value: 62_190_000 },
    { dims: { channel: "meridian-embed" }, value: 24_090_000 },
    { dims: { provider: "Cedar General Insurance" }, value: 84_500_000 },
    { dims: { provider: "Falcon Insurance" }, value: 61_300_000 },
    { dims: { provider: "Oryx Takaful" }, value: 33_700_000 },
    { dims: { provider: "Gulf Health Assurance" }, value: 28_900_000 },
    { dims: { provider: "GONXT Underwriting" }, value: 30_500_000 }
  ];

  const snapshotRows: (typeof schema.northSnapshots.$inferInsert)[] = [];
  let s = 0;
  const snapshot = (
    metricKey: string,
    grain: "day" | "month",
    period: string,
    value: number,
    ts: number,
    dims?: Record<string, string>
  ): void => {
    snapshotRows.push({
      id: id("snp", now + s++),
      tenantId,
      metricKey,
      grain,
      period,
      dimsJson: dims ? JSON.stringify(dims) : null,
      dimsHash: dims ? dimsHash(dims) : "",
      value,
      ts
    });
  };

  for (const [key, series] of Object.entries(MONTHLY)) {
    MONTHS.forEach((period, i) => {
      snapshot(key, "month", period!, series[i]!, monthRollupAt(i));
    });
  }
  for (const [key, series] of Object.entries(DAILY)) {
    DAYS.forEach((period, i) => {
      snapshot(key, "day", period!, series[i]!, dayStart(now, i - 4) + 2 * HOUR);
    });
  }
  for (const split of LAST_MONTH_SPLITS) {
    snapshot("gwp", "month", MONTHS[2]!, split.value, monthRollupAt(2), split.dims);
  }
  await db.insert(schema.northSnapshots).values(snapshotRows);

  /* --------------------------------------------------------- briefings */
  // Ids are declared up front because an anomaly points at the decision it
  // opened and that decision points back at the briefing that raised it.
  const briefingIds = {
    jan05En: id("brf", now),
    jan05Ar: id("brf", now + 1),
    jan04En: id("brf", now + 2),
    jan02Board: id("brf", now + 3),
    dec31Investor: id("brf", now + 4)
  };
  const anomalyIds = {
    bindRate: id("ano", now),
    panelResponse: id("ano", now + 1),
    cac: id("ano", now + 2),
    december: id("ano", now + 3),
    latency: id("ano", now + 4)
  };
  const boardpackIds = { q4: id("bpk", now), q1: id("bpk", now + 1) };
  const decisionIds = {
    panel: id("dec", now),
    brokerShare: id("dec", now + 1),
    oryxPricing: id("dec", now + 2),
    campaign: id("dec", now + 3),
    ownPaper: id("dec", now + 4),
    callCentre: id("dec", now + 5)
  };

  // Every label a briefing reads is relative to the seed clock — the demo is
  // provisioned whenever it is provisioned, and must narrate that month rather
  // than the one this file was written in.
  const lastMonth = monthKey(now, -1);
  const lastMonthName = monthName(now, -1);
  const priorMonthName = monthName(now, -2);
  const lastMonthAr = monthName(now, -1, "ar-AE");
  const priorMonthAr = monthName(now, -2, "ar-AE");
  const thisQuarter = quarterKey(now).slice(5);
  const lastQuarter = quarterKey(now, -1).slice(5);

  await db.insert(schema.northBriefings).values([
    {
      id: briefingIds.jan05En,
      tenantId,
      // Today/exec/en is deliberately left free: J-E1 generates that briefing at
      // runtime and the unique index would reject a second one.
      date: dayKey(now, -1),
      audience: "exec",
      locale: "en",
      narrativeRef: `${lastMonthName} closed at AED 2,389,000 of gross written premium, the best month \
of the year and 18.4% above ${priorMonthName}. Motor on the web and app channels drove \
almost all of the increase; nothing in the mix suggests a one-off.

Broker share reached 36.1% of premium. Alpha Brokers and the Meridian embed \
together wrote just over a third of the book, which is the highest \
concentration we have carried and worth watching rather than celebrating.

Against that, yesterday's quote-to-bind rate was 18.9% — well below the \
five-day average of 23.4%. Two anomalies are open on it and neither has an \
owner yet.`,
      highlightsJson: JSON.stringify([
        {
          metricKey: "gwp",
          period: lastMonth,
          value: 238_900_000,
          deltaBps: 1_841,
          note: `${lastMonthName} closed above every prior month, led by motor on the web and app channels.`
        },
        {
          metricKey: "broker_channel_share",
          period: lastMonth,
          value: 3_611,
          deltaBps: 683,
          note: "Alpha Brokers and the Meridian embed together wrote just over a third of premium."
        },
        {
          metricKey: "quote_to_bind_rate",
          period: dayKey(now, -1),
          value: 1_890,
          deltaBps: -1_923,
          note: "Yesterday's conversion fell well below the five-day average; see the open anomaly."
        }
      ]),
      anomaliesJson: JSON.stringify([anomalyIds.bindRate, anomalyIds.panelResponse]),
      status: "published",
      generatedBy: "ai",
      approvedBy: "hala.zayed",
      publishedAt: now - DAY - 5 * HOUR,
      createdAt: now - DAY - 6 * HOUR
    },
    {
      id: briefingIds.jan05Ar,
      tenantId,
      date: dayKey(now, -1),
      audience: "exec",
      locale: "ar",
      narrativeRef: `أغلق ${lastMonthAr} عند 2,389,000 درهم من إجمالي الأقساط المكتتبة، وهو أفضل شهر في \
السنة وبزيادة 18.4% عن ${priorMonthAr}. جاء معظم النمو من تأمين المركبات عبر الموقع \
والتطبيق.

تحسّن الاحتفاظ عند التجديد إلى 83.1% للشهر الثالث على التوالي، ويعود ذلك في \
الأساس إلى التواصل المبكر قبل موعد التجديد.

يبقى انخفاض معدل التحويل من عرض السعر إلى الإصدار أمس هو البند الوحيد الذي \
يحتاج إلى قرار اليوم.`,
      highlightsJson: JSON.stringify([
        {
          metricKey: "gwp",
          period: lastMonth,
          value: 238_900_000,
          deltaBps: 1_841,
          note: `أغلق ${lastMonthAr} أعلى من كل الأشهر السابقة، بقيادة تأمين المركبات عبر الموقع والتطبيق.`
        },
        {
          metricKey: "renewal_retention",
          period: lastMonth,
          value: 8_310,
          deltaBps: 323,
          note: "تحسّن الاحتفاظ عند التجديد للشهر الثالث على التوالي."
        }
      ]),
      anomaliesJson: JSON.stringify([anomalyIds.bindRate]),
      status: "published",
      generatedBy: "ai",
      approvedBy: "khalid.rashed",
      publishedAt: now - DAY - 5 * HOUR,
      createdAt: now - DAY - 6 * HOUR
    },
    {
      id: briefingIds.jan04En,
      tenantId,
      date: dayKey(now, -2),
      audience: "exec",
      locale: "en",
      narrativeRef: `Sixty-one policies issued yesterday, the strongest issuing day of the new \
year and 17.3% above the same day last week. Most of it is motor renewals \
coming back rather than new business.

Quote latency at the 95th percentile drifted to 3.04 seconds, above the \
2.3-second target. The manual-priced Oryx leg is the slowest part of the \
panel and is the whole of the gap.`,
      highlightsJson: JSON.stringify([
        {
          metricKey: "policies_issued",
          period: dayKey(now, -2),
          value: 61,
          deltaBps: 1_731,
          note: "Best issuing day of the new year so far, mostly motor renewals coming back."
        },
        {
          metricKey: "quote_latency_p95",
          period: dayKey(now, -2),
          value: 3_040,
          deltaBps: 3_160,
          note: "Panel latency drifted above target; the manual-priced Oryx row is the slowest leg."
        }
      ]),
      anomaliesJson: JSON.stringify([anomalyIds.latency]),
      status: "published",
      generatedBy: "ai",
      approvedBy: "hala.zayed",
      publishedAt: now - 2 * DAY - 5 * HOUR,
      createdAt: now - 2 * DAY - 6 * HOUR
    },
    {
      id: briefingIds.jan02Board,
      tenantId,
      date: dayKey(now, -4),
      audience: "board",
      locale: "en",
      narrativeRef: `${lastQuarter} finished ahead of plan on premium and slightly behind on acquisition \
cost. ${lastMonthName} alone wrote AED 2,389,000, up 18.4% on the prior month.

The book grew in every month of the quarter and ended at 4,608 active \
policies, up 5.7%.

The one item for the board is the own-paper loss ratio, which widened to \
64.2% in ${lastMonthName}. It is one month, not a trend, but it is the number that \
would change the ${thisQuarter} plan if it holds. This draft is in review and has not \
been circulated.`,
      highlightsJson: JSON.stringify([
        {
          metricKey: "gwp",
          period: lastMonth,
          value: 238_900_000,
          deltaBps: 1_841,
          note: `${lastQuarter} finished ahead of plan on premium and slightly behind on acquisition cost.`
        },
        {
          metricKey: "active_policies",
          period: lastMonth,
          value: 4_608,
          deltaBps: 566,
          note: "The book grew every month of the quarter."
        },
        {
          metricKey: "loss_ratio",
          period: lastMonth,
          value: 6_420,
          deltaBps: 736,
          note: `Own-paper loss ratio widened in ${lastMonthName} and is worth a closer look in ${thisQuarter}.`
        }
      ]),
      anomaliesJson: JSON.stringify([anomalyIds.december]),
      status: "review",
      generatedBy: "ai",
      approvedBy: null,
      publishedAt: null,
      createdAt: now - 4 * DAY - 6 * HOUR
    },
    {
      id: briefingIds.dec31Investor,
      tenantId,
      date: dayKey(now, -6),
      audience: "investor",
      locale: "en",
      narrativeRef: `Retained commission for ${lastMonthName} was AED 226,950, tracking premium at 18.4% \
growth. The shift toward b2b volume did not dilute the margin, which is the \
question this mix shift was always going to raise.

Acquisition cost per policy improved for the third consecutive month to \
AED 189. The improvement is organic — paid spend was flat over the quarter.

This is a draft and the ${lastMonthName} figures are unaudited.`,
      highlightsJson: JSON.stringify([
        {
          metricKey: "net_commission",
          period: lastMonth,
          value: 22_695_000,
          deltaBps: 1_842,
          note: "Retained commission tracked premium; the b2b mix shift did not dilute the margin."
        },
        {
          metricKey: "cac_per_policy",
          period: lastMonth,
          value: 18_900,
          deltaBps: -620,
          note: "Acquisition cost per policy improved for the third month."
        }
      ]),
      anomaliesJson: null,
      status: "draft",
      generatedBy: "ai",
      approvedBy: null,
      publishedAt: null,
      createdAt: now - 6 * DAY - 6 * HOUR
    }
  ]);

  /* --------------------------------------------------------- anomalies */
  // `magnitude` is signed basis points against the expected value, so every
  // row here is round((actual - expected) / expected * 10_000).
  await db.insert(schema.northAnomalies).values([
    {
      id: anomalyIds.bindRate,
      tenantId,
      metricKey: "quote_to_bind_rate",
      window: dayKey(now, -1),
      magnitude: -1_923,
      expected: 2_340,
      actual: 1_890,
      driverAnalysisJson: JSON.stringify({
        method: "period_over_period",
        baseline: "trailing_4_day",
        drivers: [
          { dimension: "channel", key: "alpha-brokers", contributionBps: -1_180 },
          { dimension: "channel", key: "gonxt-web", contributionBps: -520 },
          { dimension: "line", key: "motor", contributionBps: -1_640 }
        ]
      }),
      state: "explained",
      linkedActionRef: null,
      explainedBy: "rana.hadid",
      detectedAt: now - 6 * HOUR
    },
    {
      id: anomalyIds.panelResponse,
      tenantId,
      metricKey: "panel_response_rate",
      window: `${dayKey(now, -5)}..${dayKey(now, -1)}`,
      magnitude: -861,
      expected: 9_640,
      actual: 8_810,
      driverAnalysisJson: JSON.stringify({
        method: "trend",
        baseline: "trailing_30_day",
        drivers: [
          { dimension: "provider", key: "Oryx Takaful", contributionBps: -790 },
          { dimension: "provider", key: "Gulf Health Assurance", contributionBps: -71 }
        ],
        note: "Both are off-API rows: Oryx prices manually and Gulf Health quotes by email."
      }),
      state: "action_created",
      linkedActionRef: `north_decision:${decisionIds.oryxPricing}`,
      explainedBy: "rana.hadid",
      detectedAt: now - 6 * HOUR
    },
    {
      id: anomalyIds.cac,
      tenantId,
      metricKey: "cac_per_policy",
      window: monthKey(now),
      magnitude: 2_813,
      expected: 19_200,
      actual: 24_600,
      driverAnalysisJson: JSON.stringify({
        method: "period_over_period",
        baseline: lastMonth,
        drivers: [
          { dimension: "channel", key: "gonxt-web", contributionBps: 1_940 },
          { dimension: "channel", key: "gonxt-app", contributionBps: 873 }
        ]
      }),
      state: "new",
      linkedActionRef: null,
      explainedBy: null,
      detectedAt: now - 6 * HOUR
    },
    {
      id: anomalyIds.december,
      tenantId,
      metricKey: "gwp",
      window: lastMonth,
      magnitude: 1_269,
      expected: 212_000_000,
      actual: 238_900_000,
      driverAnalysisJson: JSON.stringify({
        method: "seasonal",
        baseline: "trailing_12_month_seasonal",
        drivers: [{ dimension: "line", key: "motor", contributionBps: 1_104 }],
        note: `${lastMonthName} renewals land in the same week every year.`
      }),
      state: "dismissed",
      linkedActionRef: null,
      explainedBy: "rana.hadid",
      detectedAt: now - 5 * DAY - 6 * HOUR
    },
    {
      id: anomalyIds.latency,
      tenantId,
      metricKey: "quote_latency_p95",
      window: dayKey(now, -2),
      magnitude: 6_606,
      expected: 2_180,
      actual: 3_620,
      driverAnalysisJson: JSON.stringify({
        method: "period_over_period",
        baseline: "trailing_7_day",
        drivers: [{ dimension: "provider", key: "Oryx Takaful", contributionBps: 5_980 }]
      }),
      state: "new",
      linkedActionRef: null,
      explainedBy: null,
      detectedAt: now - DAY - 6 * HOUR
    }
  ]);

  /* --------------------------------------------------------- scenarios */
  // Assumptions are the input the answer can be re-derived from (J-E3); the
  // result is the model's, so it stays a stored object rather than prose.
  // `modelRunRef` is null because this seed writes no ai_audit_log rows —
  // a dangling run id would be worse than an empty column.
  await db.insert(schema.northScenarios).values([
    {
      id: id("scn", now),
      tenantId,
      question: "What if Alpha Brokers' motor share moves from 35% to 45%?",
      assumptionsJson: JSON.stringify({
        channelKey: "alpha-brokers",
        line: "motor",
        channelSharePpm: 450_000,
        currentChannelSharePpm: 350_000,
        volumeUpliftBps: 1_200,
        horizonMonths: 6,
        currency: "AED"
      }),
      modelRunRef: null,
      resultJson: JSON.stringify({
        gwpDeltaMinor: 18_600_000,
        netCommissionDeltaMinor: -1_284_000,
        policiesDelta: 214,
        brokerChannelShareBps: 4_180,
        breakEvenMonths: 4,
        sensitivity: "A volume uplift under 700bps leaves retained commission below today."
      }),
      author: "hala.zayed",
      sharedWithJson: JSON.stringify(["faisal.omar", "dana.aziz"]),
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: id("scn", now + 1),
      tenantId,
      question: "What if we add a fifth motor underwriter to the panel?",
      assumptionsJson: JSON.stringify({
        line: "motor",
        currentPanelSize: 4,
        panelSize: 5,
        assumedBaseCommissionPpm: 160_000,
        assumedWinRateBps: 1_400,
        quoteLatencyBudgetMs: 2_500,
        horizonMonths: 12
      }),
      modelRunRef: null,
      resultJson: JSON.stringify({
        gwpDeltaMinor: 26_400_000,
        netCommissionDeltaMinor: 2_910_000,
        quoteToBindRateDeltaBps: 180,
        quoteLatencyP95DeltaMs: 340,
        note: "Upside holds only while the new row answers over the API; a manual row spends the whole latency budget."
      }),
      author: "rana.hadid",
      sharedWithJson: JSON.stringify(["hala.zayed", "omar.farouk"]),
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY
    },
    {
      id: id("scn", now + 2),
      tenantId,
      question: "What if Oryx motor moves from manual pricing to a rate table?",
      assumptionsJson: JSON.stringify({
        offeringCode: "ORX-MOT-TKF",
        fromPricingMode: "manual",
        toPricingMode: "table",
        currentSlaSeconds: 120,
        targetSlaSeconds: 5,
        horizonMonths: 3
      }),
      modelRunRef: null,
      resultJson: JSON.stringify({
        panelResponseRateDeltaBps: 620,
        quoteLatencyP95DeltaMs: -980,
        quoteToBindRateDeltaBps: 140,
        gwpDeltaMinor: 7_200_000,
        note: `Recovers most of the response-rate drift seen across the first week of ${monthName(now)}.`
      }),
      author: "rana.hadid",
      sharedWithJson: JSON.stringify(["dana.aziz"]),
      createdAt: now - DAY,
      updatedAt: now - DAY
    }
  ]);

  /* -------------------------------------------------------- board packs */
  // No pdfFileId: nothing has rendered a PDF into R2 in a fresh install, and a
  // file id pointing at a missing object would fail on the first download.
  await db.insert(schema.northBoardpacks).values([
    {
      id: boardpackIds.q4,
      tenantId,
      period: quarterKey(now, -1),
      title: `${quarterKey(now, -1).slice(5)} ${quarterKey(now, -1).slice(0, 4)} board pack`,
      sectionsJson: JSON.stringify([
        { key: "growth", metricKeys: ["gwp", "policies_issued", "active_policies"] },
        { key: "distribution_mix", metricKeys: ["broker_channel_share"] },
        { key: "retention", metricKeys: ["renewal_retention"] },
        { key: "acquisition_cost", metricKeys: ["cac_per_policy", "net_commission"] },
        { key: "own_paper", metricKeys: ["loss_ratio"] },
        { key: "decisions", decisionRefs: [decisionIds.campaign, decisionIds.ownPaper] }
      ]),
      pdfFileId: null,
      xlsxFileId: null,
      distributionLogJson: JSON.stringify([
        { to: "board@gonxt.ae", medium: "email", ts: now - 4 * DAY },
        { to: "hala.zayed@gonxt.ae", medium: "email", ts: now - 4 * DAY }
      ]),
      status: "distributed",
      approvedBy: "hala.zayed",
      createdAt: now - 6 * DAY,
      updatedAt: now - 4 * DAY
    },
    {
      id: boardpackIds.q1,
      tenantId,
      period: quarterKey(now),
      title: `${thisQuarter} ${quarterKey(now).slice(0, 4)} board pack`,
      sectionsJson: JSON.stringify([
        { key: "growth", metricKeys: ["gwp", "policies_issued", "active_policies"] },
        { key: "panel_health", metricKeys: ["panel_response_rate", "quote_latency_p95"] },
        { key: "conversion", metricKeys: ["quote_to_bind_rate"] },
        { key: "decisions", decisionRefs: [decisionIds.panel, decisionIds.brokerShare] }
      ]),
      pdfFileId: null,
      xlsxFileId: null,
      distributionLogJson: null,
      status: "draft",
      approvedBy: null,
      createdAt: now - DAY,
      updatedAt: now - DAY
    }
  ]);

  /* ---------------------------------------------------------- decisions */
  await db.insert(schema.northDecisions).values([
    {
      id: decisionIds.panel,
      tenantId,
      title: "Add a fifth motor underwriter to the panel",
      contextRef: `north_briefing:${briefingIds.jan02Board}`,
      optionsJson: JSON.stringify([
        { key: "invite_two", label: "Invite two underwriters to quote in Q1", costMinor: 0 },
        { key: "invite_one", label: "Invite one underwriter and review in Q2", costMinor: 0 },
        { key: "hold", label: "Hold the panel at four and revisit after Q1" }
      ]),
      chosen: "invite_two",
      owner: "hala.zayed",
      reviewAt: now + 60 * DAY,
      outcomeReviewJson: null,
      status: "open",
      createdAt: now - 4 * DAY,
      updatedAt: now - 4 * DAY
    },
    {
      id: decisionIds.brokerShare,
      tenantId,
      title: "Raise the Alpha Brokers motor share to 40% for Q1",
      contextRef: `north_briefing:${briefingIds.jan05En}`,
      optionsJson: JSON.stringify([
        { key: "raise_40", label: "Raise the motor share to 40% for Q1 only" },
        { key: "raise_45", label: "Raise the motor share to 45% with a volume floor" },
        { key: "hold_35", label: "Hold at 35% and revisit at renewal" }
      ]),
      chosen: "raise_40",
      owner: "dana.aziz",
      reviewAt: now + 90 * DAY,
      outcomeReviewJson: null,
      status: "open",
      createdAt: now - DAY,
      updatedAt: now - DAY
    },
    {
      id: decisionIds.oryxPricing,
      tenantId,
      title: "Move Oryx motor quotes off manual pricing",
      contextRef: `north_anomaly:${anomalyIds.panelResponse}`,
      optionsJson: JSON.stringify([
        { key: "rate_table", label: "Agree a rate table with Oryx and price in-platform" },
        { key: "tighten_sla", label: "Keep manual pricing and tighten the SLA to 30 seconds" },
        { key: "drop_row", label: "Drop the row from the default panel" }
      ]),
      chosen: "rate_table",
      owner: "omar.farouk",
      reviewAt: now + 30 * DAY,
      outcomeReviewJson: null,
      status: "open",
      createdAt: now - 6 * HOUR,
      updatedAt: now - 6 * HOUR
    },
    {
      id: decisionIds.campaign,
      tenantId,
      title: `Pause the ${lastMonthName} brand campaign and move the budget to search`,
      contextRef: `north_briefing:${briefingIds.dec31Investor}`,
      optionsJson: JSON.stringify([
        { key: "move_to_search", label: "Move the remaining budget to search" },
        { key: "keep", label: "Keep the campaign running to the end of the quarter" }
      ]),
      chosen: "move_to_search",
      owner: "noor.jamal",
      reviewAt: now - 5 * DAY,
      outcomeReviewJson: JSON.stringify({
        reviewedAt: now - 5 * DAY,
        reviewedBy: "hala.zayed",
        metricKey: "cac_per_policy",
        before: 21_400,
        after: 18_900,
        verdict: "worked",
        note: "Acquisition cost per policy fell over the two months after the switch."
      }),
      status: "reviewed",
      createdAt: now - 40 * DAY,
      updatedAt: now - 5 * DAY
    },
    {
      id: decisionIds.ownPaper,
      tenantId,
      title: "Keep GONXT motor on own paper for the 25–39 age band",
      contextRef: `north_boardpack:${boardpackIds.q4}`,
      optionsJson: JSON.stringify([
        { key: "keep", label: "Keep writing the band on own paper" },
        { key: "cede", label: "Cede the band to the panel and keep only travel" }
      ]),
      chosen: "keep",
      owner: "faisal.omar",
      reviewAt: now - 2 * DAY,
      outcomeReviewJson: JSON.stringify({
        reviewedAt: now - 2 * DAY,
        reviewedBy: "faisal.omar",
        metricKey: "loss_ratio",
        before: 5_980,
        after: 6_420,
        verdict: "mixed",
        note: `The band stayed profitable but the ${lastMonthName} loss ratio is worth watching in ${thisQuarter}.`
      }),
      status: "reviewed",
      createdAt: now - 30 * DAY,
      updatedAt: now - 2 * DAY
    },
    {
      id: decisionIds.callCentre,
      tenantId,
      title: "Withdraw Cedar Motor Essential from the call centre",
      contextRef: `north_briefing:${briefingIds.jan04En}`,
      optionsJson: JSON.stringify([
        { key: "withdraw", label: "Withdraw the row from the call centre panel" },
        { key: "keep", label: "Keep the row and script the excess difference" }
      ]),
      chosen: "keep",
      owner: "omar.farouk",
      reviewAt: now + 14 * DAY,
      outcomeReviewJson: JSON.stringify({
        reversedAt: now - 3 * DAY,
        reversedBy: "hala.zayed",
        note: "Withdrawing it removed the cheapest row from the call-centre comparison, so the original decision was undone and the excess is explained in the script instead."
      }),
      status: "reversed",
      createdAt: now - 20 * DAY,
      updatedAt: now - 3 * DAY
    }
  ]);

  /* ------------------------------------------------------ the other workspaces */
  // One file per module rather than one more screenful here: the modules do not
  // share rows, only the context below, and a seeder that owns its own file can
  // be read next to the module it fills.
  const ctx: SeedContext = {
    db,
    now,
    tenantId,
    users,
    teams,
    providers,
    products,
    offerings,
    channels,
    customerId,
    consentId,
    quoteRequestId: requestId,
    caseId,
    policyId,
    renewalPolicyId,
    issuedAt
  };
  await seedAdmin(ctx);
  await seedAxis(ctx);
  await seedLedger(ctx);
  await seedOrbit(ctx);
  // Onboarding reads partners by name, so it follows orbit. Settlement reads
  // the periods ledger writes, the channels the core story writes and the
  // agreement onboarding signs, so it follows both.
  await seedOnboarding(ctx);
  await seedSettlement(ctx);
  await seedStaff(ctx);
  await seedSignal(ctx);
  await seedScout(ctx);
  await seedCompliance(ctx);
  await seedAnalytics(ctx);
  // Last, because the audit trail is a record of what the seeders above did:
  // it can only be written once those rows exist.
  await seedPlatform(ctx);

  return { tenantId, users, channels, providers, offerings };
}

/** Referenced by the provisioning path when a new tenant is created from the template. */
export const SEED_TENANT_SLUG = "gonxt";

/**
 * `core_roles.permissions_json` is a one-time snapshot of ROLES[key] written
 * at seed time (see the role-provisioning loop above); it never resyncs, so a
 * permission added to an existing role in rbac.ts after a tenant was seeded
 * never reaches that tenant. This overwrites every `system` role's stored
 * bundle with the current compiled one for one tenant — a manual, explicit
 * maintenance action (not run automatically), since a stored bundle can also
 * be a deliberate narrowing (approvals.ts's grantsFor trusts it either way)
 * that this must not silently undo.
 */
/**
 * The chart of accounts is provisioned once, at seed time, so a code added to
 * CHART_OF_ACCOUNTS afterwards never reaches a tenant that already exists —
 * which is how the 3xxx equity accounts (docs/27 F3) would have left every
 * deployed tenant unable to run a year-end close. This inserts whatever is
 * missing and touches nothing else: an account a tenant added itself stays,
 * and an existing row keeps whatever name or status it was given, since a
 * renamed account is a tenant's decision, not drift to correct.
 *
 * Returns the codes it added, so a repeat run answers with an empty list.
 */
export async function syncChartOfAccounts(db: CoreDb, tenantId: string): Promise<string[]> {
  const existing = new Set(
    (
      await db
        .select({ code: schema.ledgerAccounts.code })
        .from(schema.ledgerAccounts)
        .where(eq(schema.ledgerAccounts.tenantId, tenantId))
    ).map((row) => row.code)
  );
  const now = Date.now();
  const added: string[] = [];
  for (const acc of CHART_OF_ACCOUNTS) {
    if (existing.has(acc.code)) {
      // ADR-0090: the IAS 7 class reaches a tenant seeded before it existed.
      // Only where unset — a class the tenant chose is theirs.
      if (acc.cashFlow) {
        await db
          .update(schema.ledgerAccounts)
          .set({ cashFlow: acc.cashFlow })
          .where(
            and(
              eq(schema.ledgerAccounts.tenantId, tenantId),
              eq(schema.ledgerAccounts.code, acc.code),
              isNull(schema.ledgerAccounts.cashFlow)
            )
          );
      }
      continue;
    }
    await db.insert(schema.ledgerAccounts).values({
      id: id("acc", now + added.length),
      tenantId,
      code: acc.code,
      nameJson: JSON.stringify({ en: acc.en, ar: acc.ar }),
      type: acc.type,
      normalSide: acc.normalSide,
      clientMoney: acc.clientMoney ?? false,
      suspense: acc.suspense ?? false,
      cashFlow: acc.cashFlow ?? null,
      currency: "AED",
      status: "active",
      createdAt: now
    });
    added.push(acc.code);
  }
  return added;
}

/**
 * docs/27 F17. The market tax rulepack has exactly the staleness sighting 9
 * describes: `TAX_RULEPACK` is a compiled table read at provisioning time, so a
 * market or code added to it afterwards never reaches a tenant that already
 * exists — and since `taxTreatment` now *refuses* a supply it has no rule for,
 * that staleness is a 400 on every bind rather than a quietly wrong figure.
 *
 * Idempotent by (market, code): an existing row is left entirely alone, because
 * a tenant that has restated a rate has restated it deliberately. Returns the
 * `market/code` pairs it added, so a repeat run answers with an empty list.
 */
export async function syncTaxRules(
  db: CoreDb,
  tenantId: string,
  opts: { now?: number } = {}
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const existing = new Set(
    (
      await db
        .select({ market: schema.ledgerTaxRules.market, code: schema.ledgerTaxRules.code })
        .from(schema.ledgerTaxRules)
        .where(eq(schema.ledgerTaxRules.tenantId, tenantId))
    ).map((r) => `${r.market}/${r.code}`)
  );
  const added: string[] = [];
  for (const rule of TAX_RULEPACK) {
    const key = `${rule.market}/${rule.code}`;
    if (existing.has(key)) continue;
    await db.insert(schema.ledgerTaxRules).values({
      id: id("tax", now + added.length),
      tenantId,
      market: rule.market,
      code: rule.code,
      ratePpm: rule.ratePpm,
      placeOfSupply: rule.placeOfSupply ?? null,
      reverseCharge: rule.reverseCharge ?? false,
      exempt: rule.exempt ?? false,
      // Open-ended from the epoch: a tenant migrating history must be able to
      // re-derive the rate that applied to a back-dated sale, and a rulepack
      // that started today would refuse every one of them.
      effectiveFrom: 0,
      effectiveTo: null
    });
    added.push(key);
  }
  return added;
}

/**
 * Add the personas a tenant is missing from `PEOPLE`, with their role grant.
 *
 * `seed()` refuses a second call once "gonxt" exists, and nothing else writes
 * staff, so `PEOPLE` reaches a deployed tenant exactly once: every persona
 * added to that list since is a login that exists in this file and nowhere in
 * production. On the demo tenant that is `hind.saqr` (orbit.admin, dec6b07) and
 * `yasmin.faris` (provider.viewer, ee2e5e9) — both absent from the live
 * `/v1/auth/demo/personas`, which enumerates users and so cannot show a row
 * that was never written. Same staleness the three reconcilers beside this one
 * already answer for roles, accounts and the demo admin.
 *
 * Idempotent by email: an existing address is left entirely alone (password,
 * name, roles), so this can only ever add. Returns the addresses it created.
 */
export async function ensureSeedPeople(
  db: CoreDb,
  tenantId: string,
  opts: { now?: number; passwordHash?: string; mfaSecret?: string } = {}
): Promise<{ created: string[] }> {
  const now = opts.now ?? Date.now();
  const existing = new Set(
    (
      await db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.tenantId, tenantId))
    ).map((r) => r.email)
  );
  const roleIds = new Map(
    (
      await db
        .select({ id: schema.roles.id, key: schema.roles.key })
        .from(schema.roles)
        .where(eq(schema.roles.tenantId, tenantId))
    ).map((r) => [r.key, r.id])
  );

  const created: string[] = [];
  let n = 0;
  for (const person of PEOPLE) {
    const email = `${person.local}@gonxt.ae`;
    // A role this tenant does not carry cannot be granted, and a user with no
    // grant is a login that can reach nothing — skip rather than half-create.
    const roleId = roleIds.get(person.role);
    if (existing.has(email) || !roleId) continue;

    const uid = id("us", now + n++);
    await db.insert(schema.users).values({
      id: uid,
      tenantId,
      email,
      name: person.name,
      locale: person.locale ?? "en",
      status: "active",
      authProvider: "password",
      passwordHash: opts.passwordHash ?? (await hashPassword(DEFAULT_PASSWORD)),
      mfaEnrolled: Boolean(opts.mfaSecret) && requiresMfa([person.role]),
      mfaSecret: opts.mfaSecret && requiresMfa([person.role]) ? opts.mfaSecret : null,
      createdAt: now,
      updatedAt: now
    });
    await db.insert(schema.userRoles).values({
      id: id("ur", now + n++),
      tenantId,
      userId: uid,
      roleId,
      scopeJson: null,
      createdAt: now
    });

    // ROLE-028 (ADR-0025): provider.viewer is scoped to one provider's own
    // rows, and an unscoped one is a WIDER grant than intended, not a narrower
    // one — so this persona is only created if the provider it belongs to is
    // there to scope it to. seed.ts does this by id at seed time; here the
    // name is the only handle left.
    if (person.role === "provider.viewer") {
      const [falcon] = await db
        .select({ id: schema.providers.id })
        .from(schema.providers)
        .where(and(eq(schema.providers.tenantId, tenantId), eq(schema.providers.name, "Falcon Insurance")))
        .limit(1);
      if (!falcon) {
        await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, uid));
        await db.delete(schema.users).where(eq(schema.users.id, uid));
        continue;
      }
      await db.update(schema.users).set({ providerId: falcon.id }).where(eq(schema.users.id, uid));
    }
    created.push(email);
  }
  return { created };
}

/**
 * Event names the seed once shipped that no code emits, and the event each
 * fact is actually announced as (docs/27, 2026-09-23). A journey triggering on
 * the left-hand name could never enrol anybody; a webhook subscribed to it
 * could never receive anything. apps/api event-seams.test.ts holds the seed to
 * emitted names from here on; this map is what brings a tenant seeded earlier.
 */
export const SEED_EVENT_RENAMES: Readonly<Record<string, string>> = {
  // Nothing ever emitted these: the renewal sweep now announces the catalogue's
  // `orbit.renewal.due` (docs/04 §7), and a bind is AXIS's `axis.policy.issued`.
  "orbit.renewal.raised": "orbit.renewal.due",
  "dist.policy.issued": "axis.policy.issued",
  "dist.quote.bound": "axis.policy.issued",
  // Shopping fans out and collects the panel's quotes in one request (dist.ts
  // /quote-requests/shop), so "quotes are ready" is exactly that event.
  "dist.quote.ready": "dist.quote_request.fanned_out",
  // A settlement's accrual posts (RSHARE-ACCR) when it is approved.
  "ledger.settlement.posted": "ledger.settlement.approved",
  // The document chase begins when ORBIT asks the customer for a document.
  "orbit.document.missing": "orbit.conversation.document",
  // A partner moving up the onboarding ladder (onboarding.ts advancePartner).
  "dist.partner.approved": "orbit.partner.stage_changed",
  // Was only ever an audit action; orbit-partner-quotes.ts now emits this.
  "orbit.partner.quote": "orbit.partner.quoted"
};

/** The journey keys the seed writes (seed/orbit.ts). Only these are ours to repair. */
const SEED_JOURNEY_KEYS = new Set([
  "renewal_45d",
  "onboarding_new_policy",
  "document_chase",
  "winback_lapsed",
  "broker_activation"
]);

/** Seeded journeys that follow a partner rather than a customer. */
const SEED_PARTNER_JOURNEYS = new Set(["broker_activation"]);

/**
 * Give a tenant's seeded journeys what they were seeded without (docs/30 ORBIT
 * gap 1): the frequency cap `triggerJourney` requires (ORB-051), and — for the
 * partner journey — `subject: "partner"`, without which it waits for a
 * customer that partner events never name. Only seeded keys, only what is
 * missing: an authored journey is its author's. Idempotent. Returns the ids it
 * changed.
 */
export async function syncSeedJourneyGraphs(db: CoreDb, tenantId: string): Promise<string[]> {
  const changed: string[] = [];
  for (const j of await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId))) {
    if (!SEED_JOURNEY_KEYS.has(j.key)) continue;
    let graph: { cooldownDays?: unknown; subject?: unknown };
    try {
      graph = JSON.parse(j.graphJson) as typeof graph;
    } catch {
      continue; // not ours to repair
    }
    const capped = typeof graph.cooldownDays === "number" && graph.cooldownDays > 0;
    const subjectRight = !SEED_PARTNER_JOURNEYS.has(j.key) || graph.subject === "partner";
    if (capped && subjectRight) continue;
    const next = {
      ...graph,
      ...(capped ? {} : { cooldownDays: SEED_JOURNEY_COOLDOWN_DAYS }),
      ...(subjectRight ? {} : { subject: "partner" })
    };
    await db
      .update(schema.orbitJourneys)
      .set({ graphJson: JSON.stringify(next) })
      .where(and(eq(schema.orbitJourneys.tenantId, tenantId), eq(schema.orbitJourneys.id, j.id)));
    changed.push(j.id);
  }
  return changed;
}

/**
 * ADR-0091. SIGNAL learns of prospects by event from the day it listens; the
 * book before that day never announced itself. This reads it once — customers
 * holding no contract, comparisons that lapsed, renewals at churn risk — into
 * `signal_prospects`, the same rows the events write. Existing rows are left
 * as they are (their state is SIGNAL's). Idempotent. Returns rows created.
 */
export async function backfillProspects(db: CoreDb, tenantId: string, now: number): Promise<number> {
  const rows: { customerId: string; reason: string; score: number; evidenceJson: string; sourceRef: string | null }[] = [];
  const holders = new Set(
    (await db.select({ c: schema.axisPolicies.customerId }).from(schema.axisPolicies).where(eq(schema.axisPolicies.tenantId, tenantId))).map((r) => r.c)
  );
  for (const c of await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, tenantId), isNull(schema.customers.deletedAt)))) {
    if (!holders.has(c.id)) rows.push({ customerId: c.id, reason: "no_policy", score: 30, evidenceJson: "{}", sourceRef: null });
  }
  for (const q of await db
    .select()
    .from(schema.distQuoteRequests)
    .where(and(eq(schema.distQuoteRequests.tenantId, tenantId), eq(schema.distQuoteRequests.state, "expired")))) {
    if (!q.customerId) continue;
    rows.push({
      customerId: q.customerId,
      reason: "quote_expired",
      score: 70,
      evidenceJson: JSON.stringify({ productId: q.productId, expiredAt: q.expiresAt ?? q.updatedAt }),
      sourceRef: q.id
    });
  }
  const [tenant] = await db.select({ policyJson: schema.tenants.policyJson }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const floor = PolicyJson.parse(tenant?.policyJson ? JSON.parse(tenant.policyJson) : {}).signalChurnProspectFloor ?? PROSPECT_CHURN_FLOOR;
  for (const r of await db.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.tenantId, tenantId))) {
    if (r.churnScore === null || r.churnScore < floor || r.state === "accepted" || r.state === "lost") continue;
    rows.push({ customerId: r.customerId, reason: "churn_risk", score: r.churnScore, evidenceJson: JSON.stringify({ expiryAt: r.expiryAt }), sourceRef: r.policyRef });
  }
  let created = 0;
  for (const r of rows) {
    const done = await db
      .insert(schema.signalProspects)
      .values({ id: id("psp", now), tenantId, ...r, state: "open", createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.signalProspects.id });
    created += done.length;
  }
  return created;
}

/**
 * Rewrite the seeded dead event names a tenant still holds — journey trigger
 * nodes and webhook subscriptions — to the names the code emits. Only names in
 * SEED_EVENT_RENAMES move; anything a tenant authored is left alone. Idempotent:
 * a second run finds nothing to rewrite. Returns the ids it changed.
 */
export async function syncSeedEventNames(
  db: CoreDb,
  tenantId: string
): Promise<{ journeys: string[]; webhooks: string[] }> {
  const rename = (name: string): string => SEED_EVENT_RENAMES[name] ?? name;
  const journeys: string[] = [];
  for (const j of await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId))) {
    let graph: { nodes?: { type?: string; on?: unknown; event?: unknown }[] };
    try {
      graph = JSON.parse(j.graphJson) as typeof graph;
    } catch {
      continue; // not ours to repair
    }
    let changed = false;
    for (const node of graph.nodes ?? []) {
      if (node.type === "trigger" && typeof node.on === "string" && rename(node.on) !== node.on) {
        node.on = rename(node.on);
        changed = true;
      }
      // A wait_for names an event the same way a trigger does.
      if (node.type === "wait_for" && typeof node.event === "string" && rename(node.event) !== node.event) {
        node.event = rename(node.event);
        changed = true;
      }
    }
    if (!changed) continue;
    await db
      .update(schema.orbitJourneys)
      .set({ graphJson: JSON.stringify(graph) })
      .where(and(eq(schema.orbitJourneys.tenantId, tenantId), eq(schema.orbitJourneys.id, j.id)));
    journeys.push(j.id);
  }

  const webhooks: string[] = [];
  for (const h of await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId))) {
    let types: unknown;
    try {
      types = JSON.parse(h.eventTypesJson);
    } catch {
      continue;
    }
    if (!Array.isArray(types) || !types.some((t) => typeof t === "string" && rename(t) !== t)) continue;
    // Two dead names can map to one live one (the bank hook held both quote
    // names' bind half): keep the first, drop the duplicate.
    const next = [...new Set(types.map((t) => (typeof t === "string" ? rename(t) : t)))];
    await db
      .update(schema.webhooks)
      .set({ eventTypesJson: JSON.stringify(next) })
      .where(and(eq(schema.webhooks.tenantId, tenantId), eq(schema.webhooks.id, h.id)));
    webhooks.push(h.id);
  }
  return { journeys, webhooks };
}

/**
 * Provision (or top up) the all-access demo login. Idempotent, and safe on a
 * tenant that was seeded before this account existed: it creates the user only
 * if the address is free, then adds whichever internal roles the account is
 * still missing. It never removes a role and never rewrites the password of an
 * account that is already there.
 *
 * Returns the role keys it granted, so a repeat run answers with an empty list.
 */
export async function ensureDemoAdmin(
  db: CoreDb,
  tenantId: string,
  opts: { now?: number; passwordHash?: string; mfaSecret?: string } = {}
): Promise<{ userId: string; created: boolean; granted: string[] }> {
  const now = opts.now ?? Date.now();
  const email = `${DEMO_ADMIN.local}@gonxt.ae`;
  const [found] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, email)))
    .limit(1);

  let userId = found?.id;
  if (!userId) {
    userId = id("us", now);
    await db.insert(schema.users).values({
      id: userId,
      tenantId,
      email,
      name: DEMO_ADMIN.name,
      locale: "en",
      status: "active",
      authProvider: "password",
      passwordHash: opts.passwordHash ?? (await hashPassword(DEFAULT_PASSWORD)),
      mfaEnrolled: Boolean(opts.mfaSecret),
      mfaSecret: opts.mfaSecret ?? null,
      createdAt: now,
      updatedAt: now
    });
  }

  const roles = await db
    .select({ id: schema.roles.id, key: schema.roles.key })
    .from(schema.roles)
    .where(eq(schema.roles.tenantId, tenantId));
  const held = new Set(
    (
      await db
        .select({ roleId: schema.userRoles.roleId })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, userId))
    ).map((r) => r.roleId)
  );

  const wanted = new Set(TENANT_ROLE_KEYS.filter(isInternalRole));
  const granted: string[] = [];
  for (const role of roles) {
    if (!wanted.has(role.key) || held.has(role.id)) continue;
    await db.insert(schema.userRoles).values({
      id: id("ur", now + granted.length + 1),
      tenantId,
      userId,
      roleId: role.id,
      scopeJson: null,
      createdAt: now
    });
    granted.push(role.key);
  }
  return { userId, created: !found, granted };
}

export async function resyncSystemRolePermissions(db: CoreDb, tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.roles.id, key: schema.roles.key })
    .from(schema.roles)
    .where(and(eq(schema.roles.tenantId, tenantId), eq(schema.roles.system, true)));
  const updated: string[] = [];
  for (const row of rows) {
    await db
      .update(schema.roles)
      .set({ permissionsJson: JSON.stringify(ROLES[row.key] ?? []) })
      .where(eq(schema.roles.id, row.id));
    updated.push(row.key);
  }
  return updated;
}
