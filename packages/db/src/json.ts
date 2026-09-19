import { z } from "zod";

// Zod shapes for TEXT-as-JSON columns (docs/03). Every JSON column in the schema
// has a shape here; readers parse, writers stringify. Nothing hand-rolls JSON.

/* ------------------------------------------------------------------ brand */

export const BrandJson = z.object({
  name: z.string(),
  shortName: z.string().optional(),
  logo: z.object({ light: z.string(), dark: z.string(), mark: z.string() }).partial().default({}),
  // accentContrast is text/icons placed ON --accent. It completes the five-property
  // tenant override contract in packages/ui/src/tokens.css; without it here, zod
  // stripped the field on write and the settings screen's AA check guarded a value
  // that never survived the round trip.
  palette: z
    .object({ accent: z.string(), accentHover: z.string(), accentContrast: z.string() })
    .partial()
    .default({}),
  font: z.enum(["space-grotesk", "inter", "ibm-plex-sans-arabic"]).optional(),
  domain: z.string().optional(),
  email: z.object({ from: z.string(), replyTo: z.string() }).partial().default({}),
  legal: z.object({ company: z.string(), footer: z.string(), privacyUrl: z.string() }).partial().default({})
});
export type BrandJson = z.infer<typeof BrandJson>;

/* ----------------------------------------------------------------- policy */

/**
 * How much a *campaign* may do on its own (`signal_campaigns.autonomy_level`,
 * and the tenant default a transaction is stamped with). SIGNAL's autopilot
 * gates on the top two rungs and the budget screen labels all five, so this
 * ladder stays as it is. Agents use a different one — see AGENT_AUTONOMY.
 */
export const AutonomyLevel = z.enum(["suggest", "draft", "act_with_approval", "act", "act_and_report"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/**
 * How much an *agent* may do on its own (`ai_agents.autonomy_level`), lowest
 * rung first. The API that changes it and the console that shows it have
 * always used these four, but nothing declared them where the writers could
 * see: the seed wrote `suggest_only` on nine of ten agents, a spelling on no
 * ladder anywhere, so the console rendered the raw key `suggest_only` where a
 * label belongs and its autonomy picker opened with nothing selected
 * (docs/ui.md P2 defect 9, docs/ui/admin.md §14 defect 2; ADR-0049).
 *
 * Order is rank: the console compares indices to tell a raise from a lowering,
 * so a new rung goes in at its true height or the raise confirmation is wrong.
 */
export const AGENT_AUTONOMY = ["suggest", "act_with_approval", "act_within_limits", "autonomous"] as const;

export const AgentAutonomy = z.enum(AGENT_AUTONOMY);
export type AgentAutonomy = z.infer<typeof AgentAutonomy>;

export const PolicyJson = z.object({
  autoApprove: z.array(z.string()).default([]),
  aiBudgetDailyTokens: z.number().int().nonnegative().default(2_000_000),
  aiBudgetDailyCostMicro: z.number().int().nonnegative().default(50_000_000),
  locales: z.array(z.string()).default(["en", "ar"]),
  defaultLocale: z.string().default("en"),
  dataResidency: z.enum(["cloud", "in-region", "on-prem"]).default("cloud"),
  autonomyDefault: AutonomyLevel.default("act_with_approval"),
  retention: z
    .object({
      messagesMonths: z.number().int().positive().default(24),
      filesYears: z.number().int().positive().default(7),
      aiAuditYears: z.number().int().positive().default(7)
    })
    .default({ messagesMonths: 24, filesYears: 7, aiAuditYears: 7 }),
  domainPack: z.string().default("insurance-retail"),
  // ADR-0073: the command center's autonomy envelope — how much the central
  // loop may do without asking. Absent means draft_only (reads yes, writes
  // no); consequential actions propose under every level, here or anywhere.
  commandCenter: z
    .object({
      autonomy: z.enum(["draft_only", "assist", "act_with_approval"]).default("draft_only")
    })
    .default({ autonomy: "draft_only" }),
  // Gulf tenants reckon dates in Hijri, or cite both on anything contractual.
  // A rendering preference, not a second stored value: timestamps stay epoch.
  calendarPreference: z.enum(["gregorian", "islamic-umalqura", "dual"]).default("gregorian"),
  // The zone this tenant's business day runs in — what a cutoff, a due date and
  // a scheduled report all mean by "today". Absent on purpose rather than
  // defaulted: a screen with no configured zone renders in the reader's own,
  // which is what every screen did before this field existed, and a *wrong*
  // default would silently move every timestamp in the product. Unvalidated
  // here because this schema also parses stored rows — a bad value must not
  // throw a read (see apps/web/app/calendar.ts timezoneFrom, which degrades,
  // and the settings panel, which refuses one on the way in).
  timezone: z.string().optional(),
  currency: z.string().length(3).default("AED"),
  // docs/modules/signal.md §8: "one-click global pause" for budget autopilot —
  // a tenant-wide kill switch, distinct from a single campaign's own
  // state=paused (packages/db/schema/signal.ts).
  signalAutopilotPaused: z.boolean().default(false),
  // docs/12 §4 kill switches. Per-agent is the agent row's status; these two
  // are the tenant-wide and per-module tiers, read straight off the Ctx so the
  // check in front of every model call costs no query.
  aiPaused: z.boolean().default(false),
  aiPausedModules: z.array(z.string()).default([]),
  // docs/27 F8. Tier -> model-gateway catalogue key. Values are validated by
  // the gateway's own CATALOGUE (an unknown key is ignored, not obeyed), which
  // is why this stays a loose record: @lyra/db must not depend on the gateway.
  modelOverrides: z.record(z.string(), z.string()).default({}),
  // Per-module configuration. Each module gets its own autonomy override,
  // model tier, and enabled flag — so a tenant can run SIGNAL standalone with
  // aggressive autonomy while keeping AXIS conservative, without touching the
  // global defaults. Absent keys fall through to the tenant-wide defaults
  // (autonomyDefault, modelOverrides, entitlements.modules).
  moduleConfig: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        autonomy: AutonomyLevel.optional(),
        modelTier: z.string().optional(),
        // Free-form per-module settings (e.g. signal: { dailyBudgetCapMinor })
        settings: z.record(z.string(), z.unknown()).default({})
      })
    )
    .default({})
});
export type PolicyJson = z.infer<typeof PolicyJson>;

/* ----------------------------------------------------- editions (docs/21) */

export const EDITIONS = [
  "core",
  "bots",
  "ops",
  "social",
  "radar",
  "insights",
  "suite"
] as const;
export const Edition = z.enum(EDITIONS);
export type Edition = z.infer<typeof Edition>;

export const EntitlementsJson = z.object({
  edition: Edition.default("core"),
  modules: z.array(z.enum(["axis", "orbit", "signal", "scout", "north"])).default([]),
  features: z.record(z.string(), z.boolean()).default({}),
  seats: z.number().int().positive().default(5),
  limits: z
    .object({
      casesPerMonth: z.number().int().nonnegative().optional(),
      conversationsPerMonth: z.number().int().nonnegative().optional(),
      aiTokensPerDay: z.number().int().nonnegative().optional()
    })
    .default({})
});
export type EntitlementsJson = z.infer<typeof EntitlementsJson>;

/* ------------------------------------------------------------ names & PII */

export const NameJson = z.object({ en: z.string(), ar: z.string().optional() });
export type NameJson = z.infer<typeof NameJson>;

export const PurposesJson = z.object({
  marketing: z.boolean().default(false),
  profiling: z.boolean().default(false),
  dataSharing: z.boolean().default(false),
  crossBorder: z.boolean().default(false)
});
export type PurposesJson = z.infer<typeof PurposesJson>;

export const ChannelOptinsJson = z.object({
  email: z.boolean().default(false),
  sms: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
  voice: z.boolean().default(false),
  push: z.boolean().default(false)
});
export type ChannelOptinsJson = z.infer<typeof ChannelOptinsJson>;

/* --------------------------------------------------------------- rbac/abac */

export const ScopeJson = z.object({
  teamIds: z.array(z.string()).optional(),
  modules: z.array(z.string()).optional(),
  productLines: z.array(z.string()).optional(),
  providerIds: z.array(z.string()).optional()
});
export type ScopeJson = z.infer<typeof ScopeJson>;

/* ------------------------------------------------------------ money/ledger */

/** Money is always integer minor units + ISO-4217 currency (docs/04 §1). */
export const Money = z.object({
  amountMinor: z.number().int(),
  currency: z.string().length(3)
});
export type Money = z.infer<typeof Money>;

export const ApprovalJson = z.object({
  policyKey: z.string(),
  requestedBy: z.string(),
  decidedBy: z.string().optional(),
  decision: z.enum(["pending", "approved", "rejected"]),
  reason: z.string().optional(),
  ts: z.number().int()
});
export type ApprovalJson = z.infer<typeof ApprovalJson>;

export const GuardrailsJson = z.object({
  maxAmountMinor: z.number().int().nonnegative().optional(),
  requiresApproval: z.boolean().default(true),
  autoApproveKey: z.string().optional(),
  clientMoney: z.boolean().default(false)
});
export type GuardrailsJson = z.infer<typeof GuardrailsJson>;

/* ---------------------------------------------------------- payment plans */

/**
 * `axis_policies.payment_plan_json` — the instalment schedule the lapse sweep
 * reads to decide whether cover ends unpaid (apps/api/src/engines/axis-lifecycle.ts).
 *
 * Every field defaults, because the sweep must be able to read a partial plan:
 * a plan it cannot parse turns lapse-on-missed off silently, which is fail-open
 * on a money path. That is also why `dueAt` carries no `InstantMs`-style bound
 * here — bounding it made one unrenderable instalment fail the whole plan. The
 * bound belongs on the write door, and now lives there: `PaymentPlanWrite`
 * below, which apps/api/src/resources.ts validates against. Read lenient, write
 * strict — the same shape could not be both.
 */
/**
 * `core_products.takaful_json` — docs/16 H8's "wakala fee, surplus rule, fund
 * ref", plus the standing Shariah ruling on the product (docs/27 F45).
 *
 * The column held free-form JSON and the horizon seam test wrote
 * `{model, surplusSharePct}` into it, so nothing could act on it: a surplus
 * distribution has to know whose money it is splitting and by how much, and a
 * percentage in prose is not a rule an engine can post from. Giving it a shape
 * is what lets `SURPLUS-DIST` stop being a declared type with a borrowed
 * recipe.
 *
 * Basis points, not a percentage, for the reason the rest of the ledger uses
 * them: `surplusSharePct: 10` cannot express 12.5% and a takaful contract
 * routinely does.
 *
 * `shariah` is the review lane docs/16 H8 asks for, held here rather than in
 * its own table because it is one standing ruling per product with one open
 * question at a time — the same reason `complianceStatus` sits on a creative.
 * `approvalId` points at the `core_approvals` row that carries the two
 * signatures, so the certification inherits dual control rather than
 * re-implementing it.
 */
export const TakafulJson = z.object({
  /** wakala: fee-based, operator takes no surplus. mudaraba: operator shares it. */
  model: z.enum(["wakala", "mudaraba", "hybrid"]).default("wakala"),
  /** The operator's management fee, deducted from contributions. */
  wakalaFeeBps: z.number().int().min(0).max(10_000).default(0),
  /**
   * The participants' share of a declared surplus; the operator takes the
   * remainder. Defaults to all of it, which is the wakala answer and the safe
   * one — an unconfigured product distributes nothing to the operator rather
   * than silently taking a share nobody agreed to.
   */
  participantShareBps: z.number().int().min(0).max(10_000).default(10_000),
  /** The risk fund this product's contributions pool into. */
  fundRef: z.string().optional(),
  shariah: z
    .object({
      state: z.enum(["draft", "submitted", "certified", "withdrawn"]).default("draft"),
      /** The approval row holding the board's decision (dual control). */
      approvalId: z.string().optional(),
      /** The board itself, and the ruling it issued. */
      boardRef: z.string().optional(),
      fatwaRef: z.string().optional(),
      certifiedAt: z.number().int().optional(),
      /** Rulings are reviewed periodically; past this the product is uncertified. */
      expiresAt: z.number().int().optional()
    })
    .default({ state: "draft" })
})
  // `.prefault({})`, not `.default({})`, and the difference is the whole
  // behaviour: zod 4 hands a `default` back unparsed, so `.default({})` makes
  // a null column parse to a literal `{}` with no `shariah` on it and the
  // first reader dereferences undefined. `prefault` feeds the value through
  // the schema, so the field defaults actually apply.
  //
  // It matters because `structure = "takaful"` with `takaful_json` still null
  // is the state every existing row is in, and the defaults are the safe
  // reading of it — `state: "draft"`, so an unrecorded ruling is an absent
  // ruling and never a permitted one.
  .prefault({});
export type TakafulJson = z.infer<typeof TakafulJson>;

/**
 * Whether a product may be sold, and a surplus distributed, as takaful right
 * now. One function because three readers ask it — the precondition on
 * `SURPLUS-DIST`, the certification endpoint, and the product screen — and
 * "certified" alone is the wrong answer: a ruling with an expiry that has
 * passed is not a current ruling, and a screen that says otherwise is the
 * defect this exists to prevent.
 */
export function shariahCertified(takaful: TakafulJson, now: number): boolean {
  if (takaful.shariah.state !== "certified") return false;
  return takaful.shariah.expiresAt === undefined || takaful.shariah.expiresAt > now;
}

export const PaymentPlanJson = z.object({
  graceDays: z.number().int().nonnegative().default(0),
  lapseOnMissed: z.boolean().default(false),
  instalments: z
    .array(z.object({ seq: z.number().int(), dueAt: z.number().int(), state: z.string() }))
    .default([])
});
export type PaymentPlanJson = z.infer<typeof PaymentPlanJson>;

/**
 * The same plan arriving from a caller. Everything the read shape forgives is
 * refused here, because at the write door refusing is free:
 *
 * - `dueAt` bounded to what a `Date` can hold. Unbounded, the promise in the
 *   comment above was empty: the write door parsed with the *read* shape, so
 *   `{"dueAt": 9e15}` stored fine and every renderer of it threw afterwards.
 * - `.strict()`, outer and per instalment. With every field defaulted,
 *   `{"foo":"bar"}` parsed clean and stored as `lapseOnMissed: false` — a
 *   "validated" plan that quietly switched the lapse sweep off. A typo in
 *   `lapseOnMissed` did the same thing.
 * - `lapseOnMissed` and a non-empty `instalments` required: a schedule with no
 *   instalments, or one that will not say what a missed one means, is not a plan.
 *
 * ponytail: strict means a richer plan (per-instalment `grossMinor`, a
 * `frequency`) is refused until its keys are added here. Plans seeded outside
 * the API still carry such keys and still lapse, because the read shape above
 * stays lenient — that asymmetry is the point, not an oversight.
 */
export const PaymentPlanWrite = z
  .object({
    graceDays: z.number().int().nonnegative().default(0),
    lapseOnMissed: z.boolean(),
    instalments: z
      .array(
        z
          .object({
            seq: z.number().int(),
            dueAt: z.number().int().min(-8.64e15).max(8.64e15),
            // The vocabulary axis-lifecycle.ts's lapse sweep branches on, taken
            // from the sweep rather than from the seed data: it treats anything
            // that is not exactly "paid" or "waived" as unpaid, so `"Paid"` on
            // a settled instalment lapses cover on a customer who paid. Casing
            // follows the sweep. Widen this enum and the sweep in one commit.
            state: z.enum(["due", "paid", "waived"])
          })
          .strict()
      )
      .min(1)
  })
  .strict();

/* ------------------------------------------------------------------- lens */

export const LensJson = z.object({
  workspace: z.string(),
  pinned: z.array(z.string()).default([]),
  hidden: z.array(z.string()).default([]),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  savedViews: z
    .array(z.object({ id: z.string(), name: z.string(), route: z.string(), query: z.string() }))
    .default([]),
  /** docs/15 §5 learned adaptation: view/filter key -> interaction count, capped
   *  (see MAX_LENS_WEIGHT in packages/core/src/lens.ts) so this stays a small blob. */
  weights: z.record(z.string(), z.number().int().nonnegative()).default({})
});
export type LensJson = z.infer<typeof LensJson>;

/* ------------------------------------------------------------ helper pair */

/** Parse a TEXT-as-JSON column with its shape; returns the schema default on null. */
export function parseJson<T extends z.ZodTypeAny>(shape: T, raw: string | null | undefined): z.infer<T> {
  if (raw == null || raw === "") return shape.parse(undefined);
  return shape.parse(JSON.parse(raw));
}

/** Validate then stringify for writing. Never write unvalidated JSON. */
export function toJson<T extends z.ZodTypeAny>(shape: T, value: z.input<T>): string {
  return JSON.stringify(shape.parse(value));
}
