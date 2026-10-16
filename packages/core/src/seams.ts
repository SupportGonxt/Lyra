// docs/02 §11 extension seams + docs/16 future-horizon NOW obligations.
// ADR-0018. These are type-level seams: the NOW obligation for most
// horizons is that the shape is declared and provably referenced, not that
// H1-H12 be fully built out — LATER work builds against these types
// without a rebuild (docs/16 "Horizon governance").

import type { AgentAutonomy } from "@lyra/db";
import { hashObject } from "./crypto.js";
import type { Channel } from "./consent.js";

// docs/02 §11 names `Channel` as a seam; it already lives in consent.ts
// (`export type Channel = keyof ChannelOptinsJson`) — reused, not redefined.

/** H1 — machine-readable shape an agent principal binds against. Carried
 * inside `core_mandates.scopeJson` (already generic JSON built for this);
 * no dedicated table. `offerHash` is content-integrity via `hashObject`,
 * not asymmetric non-repudiation — real signing is LATER (ADR-0018). */
export interface AgentOffer {
  readonly itemRef: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly termsRef: string;
  readonly expiry: number;
}
export interface SignedAgentOffer extends AgentOffer {
  readonly offerHash: string;
}
export async function signOffer(offer: AgentOffer): Promise<SignedAgentOffer> {
  return { ...offer, offerHash: await hashObject(offer) };
}
export async function verifyOfferSignature(signed: SignedAgentOffer): Promise<boolean> {
  const { offerHash, ...offer } = signed;
  return (await hashObject(offer)) === offerHash;
}

/** H2 — `autonomyLevel` already lives on `ai_agents` (packages/db/schema/
 * ai.ts) and is enforced by approvals.ts (dual-control) and
 * signal-autopilot.ts (pre-action filter). This is the declared-envelope
 * type docs/16 asks for; `reversible` documents which levels need a
 * reversal path rather than the L1 cap already enforced elsewhere. The rungs
 * are the ones the column actually stores (`AGENT_AUTONOMY`) — the seam used
 * to name a fourth vocabulary of its own (`observe_only … act_autonomously`),
 * so an envelope could never be compared against a stored level (ADR-0049). */
export type AutonomyLevel = AgentAutonomy;
export interface AutonomyEnvelope {
  readonly level: AutonomyLevel;
  readonly maxActionsPerDay?: number;
  readonly spendCapMinor?: number;
  readonly reversible: boolean;
}

/** H3 — `modality` already lives on orbit messages. Real STT/TTS providers
 * implement this later without touching call sites (LATER, ADR-0018). */
export interface SpeechProvider {
  readonly name: string;
  transcribe(audio: Uint8Array, mimeType: string): Promise<{ text: string; confidence: number }>;
  synthesize(text: string, voice: string): Promise<Uint8Array>;
}

/** H4 — external data pull, mandatory consent-purpose binding. */
export interface DataInConnector {
  readonly providerRef: string;
  readonly consentPurpose: string;
  fetch(subjectRef: string): Promise<Record<string, unknown>>;
}

/**
 * SCOUT's Harvester seam (docs/modules/scout.md §2.1, §5 "connector framework").
 * Same shape as `DataInConnector` above and `ChannelAdapter` below: the module
 * declares what a source must answer, and an adapter implements it. Every
 * adapter that ships today is `external: false` — it reads rows LYRA already
 * holds, or takes a payload an integrator fed the feed API. The external
 * built-ins the spec names (search-trend connectors, review scraping, news/
 * regulatory RSS, competitor page monitors) are **not** integrated: each is a
 * third-party service and needs an ADR first (ADR-0078, docs/02 §9). They wire
 * in behind this interface without a rewrite — that is the whole point of the
 * seam.
 */
// `model` is Aletheia's own findings (ADR-0118): a value outside its learned
// benchmark is an observation about the market, not a news item, and filing it
// under `news` would make the Clusterer treat a modelled reading as a report
// somebody published.
export const SIGNAL_SOURCE_KINDS = ["search", "quotes", "abandonment", "reviews", "news", "regulatory", "model"] as const;
export type SignalSourceKind = (typeof SIGNAL_SOURCE_KINDS)[number];

export function isSignalSourceKind(s: string): s is SignalSourceKind {
  return (SIGNAL_SOURCE_KINDS as readonly string[]).includes(s);
}

/** One observation an adapter hands back. `sourceRef` is the dedupe key: the
 *  harvester writes a `scout_signals` row per (source, sourceRef) exactly once,
 *  which is what makes a re-run idempotent rather than a second copy. */
export interface HarvestedSignal {
  readonly source: SignalSourceKind;
  readonly sourceRef: string;
  readonly payload: Record<string, unknown>;
  readonly observedAt: number;
  /** Defaults to 1 when the adapter has no reason to weight one item higher. */
  readonly weight?: number;
}

export interface HarvestWindow {
  readonly since: number;
  readonly until: number;
}

export interface SignalSource {
  /** Stable id — also the i18n key suffix the source manager renders. */
  readonly id: string;
  readonly kind: SignalSourceKind;
  /** True only for an adapter that calls a service outside LYRA. None ship
   *  today; the flag exists so the admin screen can say which sources leave
   *  the building without reading each adapter. */
  readonly external: boolean;
  harvest(window: HarvestWindow): Promise<readonly HarvestedSignal[]>;
}

/** H5 — produces the `core_identity_verifications` row. No KYC touchpoint
 * consumes `evidenceLevel` yet — accepted gap, ADR-0018. */
export interface IdentityVerifier {
  readonly method: string;
  verify(subjectRef: string, evidence: unknown): Promise<{ evidenceLevel: string; providerRef?: string }>;
}

/** H6 — usage/sensor data feeding a product's `pricingInputsJson`. */
export interface TimeseriesIngest {
  readonly source: string;
  ingest(subjectRef: string, points: ReadonlyArray<{ at: number; value: number }>): Promise<void>;
}

/** H10 — first-party connectors are shipped as extensions of this shape;
 * no third-party developer harness yet (LATER, ADR-0018). */
export interface ExtensionManifest {
  readonly id: string;
  readonly kind: "connector" | "channel" | "engine";
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly tenantScopes: readonly string[];
}
export function validateExtensionManifest(m: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (!m.id) errors.push("id required");
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) errors.push("version must be semver");
  if (m.capabilities.length === 0) errors.push("capabilities must not be empty");
  return errors;
}

/**
 * ADR-0037 named this seam; ADR-0038 supersedes ADR-0037's original
 * interface shape with this one, after the design doc
 * (docs/specs/gap-orbit-design.md §1C) found the first shape had no room for
 * a handshake, media, or delivery receipts. `Channel` (consent.ts) is which
 * channel a tenant has opted into; `ChannelAdapter` is how a provider's wire
 * format is verified/parsed/sent — linked via `consentChannel`, not merged.
 */
export interface InboundMessage {
  readonly externalRef: string;
  readonly handle: string;
  readonly displayName?: string;
  readonly text: string;
  readonly modality: "text" | "voice" | "image" | "video" | "document";
  readonly media?: readonly {
    readonly providerId: string;
    readonly mime: string;
    readonly filename?: string;
    readonly bytes?: number;
  }[];
  readonly sentAt: number;
  readonly windowExpiresAt?: number;
}

export interface DeliveryReceipt {
  readonly externalRef: string;
  readonly status: "sent" | "delivered" | "read" | "failed";
  readonly at: number;
  readonly error?: string;
}

export type InboundEvent =
  | { readonly kind: "message"; readonly message: InboundMessage }
  | { readonly kind: "status"; readonly receipt: DeliveryReceipt }
  | { readonly kind: "ignored"; readonly why: string };

export interface VerifiedRequest {
  readonly rawBody: string;
  readonly headers: Headers;
  readonly query: URLSearchParams;
}

/** Raw, unsealed provider credentials for one connector (opened via `openFields` before use). */
export type ConnectorSecrets = Record<string, string>;

export interface OutboundMessage {
  readonly conversationId: string;
  readonly to: string;
  readonly text: string;
  readonly replyToExternalRef?: string;
}

export interface ChannelAdapter {
  readonly provider: string;
  readonly transport: "whatsapp" | "email" | "web" | "voice" | "agent";
  readonly consentChannel: Channel | null;
  challenge?(req: VerifiedRequest, secrets: ConnectorSecrets): string | null;
  verify(req: VerifiedRequest, secrets: ConnectorSecrets, now: number): Promise<void>;
  parse(req: VerifiedRequest): InboundEvent[];
  fetchMedia(
    providerId: string,
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<{ body: ArrayBuffer; mime: string; filename?: string }>;
  send(
    out: OutboundMessage,
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<{ externalRef: string }>;
}

/**
 * docs/30 SIGNAL 5, ADR-0100. An ad network is a channel (CLAUDE.md §13): the
 * tenant's account on Google Ads or Meta, held as a connector row sealed like
 * every other (`orbit_channel_connectors`, ADR-0093) under transport `ads`.
 * SIGNAL reads spend back through it and pushes an *approved* budget move out
 * through it — the adapter never decides whether a move may happen, only how
 * the provider's wire format says it.
 *
 * Amounts are minor units of `currency`. `externalCampaignId` is the
 * provider's own id; the connector config maps it to a LYRA campaign
 * (`adCampaignMap`, ad-platform.ts), so an adapter never sees LYRA ids.
 */
export interface AdSpendRow {
  readonly externalCampaignId: string;
  /** YYYY-MM-DD in the ad account's reporting timezone. */
  readonly day: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: number;
}

export interface AdSpendWindow {
  /** Inclusive YYYY-MM-DD. */
  readonly since: string;
  /** Inclusive YYYY-MM-DD. */
  readonly until: string;
}

/**
 * docs/17 SIG-032, ADR-0112. One bind reported back to the platform with its
 * value, so the platform's bidder optimises on value rather than lead count.
 * It carries nothing about the person beyond what the platform matches on:
 * a click id the platform itself issued, or SHA-256 identifiers the exporter
 * only fills in when the customer's consent covers data sharing. Which of those
 * a platform receives is decided by its own `conversionKeys`; nothing else is
 * ever put on this shape, so no protected attribute can reach a bidder (SIG-034).
 */
export type ConversionKey = "gclid" | "fbclid" | "emailSha256" | "phoneSha256";

export interface AdConversion {
  /** LYRA's id for the conversion (the bind touch): the platform's dedup key. */
  readonly conversionId: string;
  /** When the bind happened, epoch ms. */
  readonly at: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly gclid?: string;
  readonly fbclid?: string;
  readonly emailSha256?: readonly string[];
  readonly phoneSha256?: readonly string[];
}

export interface AdConversionResult {
  readonly conversionId: string;
  readonly status: "sent" | "failed";
  readonly error?: string;
}

/**
 * A compliance-cleared creative on its way to a platform (docs/modules/signal.md
 * §2.1 and §4.2 "one-click to channels"). The copy arrives already passed by the
 * pre-flight, so an adapter's job is transport, not judgement — it never decides
 * whether something may be published.
 */
export interface AdCreativePush {
  /** The LYRA creative id, which is the handle both sides can reconcile on. */
  readonly creativeId: string;
  /** "ad_copy" | "search_ad" | "social_ad" — the platform's own shape decides. */
  readonly kind: string;
  readonly locale: string;
  readonly headline: string;
  readonly body: string;
  readonly callToAction: string | null;
  readonly landingUrl: string;
  /** The platform campaign to hang it on, when the connector maps one. */
  readonly externalCampaignId: string | null;
  /** The creative's disclosure text, already appended — a regulated ad carries it. */
  readonly disclosure: string | null;
  /**
   * The other cleared variants of the same campaign and locale. A search ad is
   * *built* from a pool rather than from one line (Google wants three headlines
   * and two descriptions minimum), so a format that needs variants draws on
   * them; a format that does not, ignores this. Empty when the campaign has a
   * single approved variant — the adapter then refuses rather than inventing
   * copy to fill a quota.
   */
  readonly pool: { readonly headlines: readonly string[]; readonly descriptions: readonly string[] };
}

export interface AdCreativePushResult {
  readonly status: "published" | "failed";
  /** The platform's own id for what it created; absent on a failure. */
  readonly externalId?: string;
  readonly error?: string;
}

export interface AdPlatform {
  readonly provider: string;
  /** The identifiers this platform matches a conversion on; the exporter sends it no others. */
  readonly conversionKeys?: readonly ConversionKey[];
  /** The oldest conversion, in days, the platform still accepts. */
  readonly conversionMaxAgeDays?: number;
  /** Reports binds with their value. Optional: a platform without it simply receives none. */
  uploadConversions?(
    conversions: readonly AdConversion[],
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<readonly AdConversionResult[]>;
  /** The `signal_spend.channel` this provider's spend lands under unless the connector config names another. */
  readonly defaultChannel: string;
  pullSpend(window: AdSpendWindow, secrets: ConnectorSecrets, config: Record<string, unknown>): Promise<readonly AdSpendRow[]>;
  /** Moves one campaign's daily budget by `deltaMinor`; refuses a currency the account does not bill in. */
  adjustDailyBudget(
    externalCampaignId: string,
    deltaMinor: number,
    currency: string,
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<{ beforeMinor: number; afterMinor: number }>;
  /**
   * Creates the ad on the platform. Optional, on the same rule
   * `uploadConversions` follows: a platform that cannot take a creative simply
   * receives none, and the publisher records that as a per-platform outcome
   * rather than failing the whole push.
   */
  publishCreative?(
    creative: AdCreativePush,
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<AdCreativePushResult>;
}

/**
 * docs/25 §7 — the embedded PSP seam, the missing `pay` step of J-C1. A
 * consumer pays inside the flow instead of being sent away and told to wait:
 * the provider opens a hosted session the browser is redirected to, and calls
 * back with its own status webhook. Runtime-gated on the connector's secrets —
 * with none, the flow keeps the v1 behaviour (`engines/settlement.ts`: a
 * human-confirmed bank/PSP reference), so this seam only ever adds a rail.
 *
 * The card data never reaches LYRA: the payer types it on the provider's page
 * (docs/12 — never store a PAN), and only the provider's reference comes back.
 */
export interface PaymentSession {
  /** LYRA's id for this payment, echoed back by the provider's webhook. */
  readonly paymentRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** What is being paid for — a quote request id. */
  readonly subjectRef: string;
  readonly description?: string;
  /** Where the provider sends the browser on success/cancel. */
  readonly returnUrl: string;
  readonly cancelUrl?: string;
}

export interface PaymentSessionResult {
  /** The provider's own reference for the session. */
  readonly providerRef: string;
  /** The hosted page the payer is sent to. */
  readonly redirectUrl: string;
}

export interface PaymentWebhookEvent {
  readonly providerRef: string;
  readonly paymentRef: string;
  readonly status: "paid" | "failed" | "pending" | "refunded";
  readonly amountMinor: number;
  readonly currency: string;
  readonly at: number;
  readonly error?: string;
}

export interface PaymentProvider {
  readonly provider: string;
  /** Requirement for opening a session: which secrets the adapter needs. */
  readonly requiredSecrets?: readonly string[];
  /** Opens a hosted session and returns where to send the payer. */
  createSession(
    session: PaymentSession,
    secrets: ConnectorSecrets,
    config: Record<string, unknown>
  ): Promise<PaymentSessionResult>;
  /** Verifies a callback's authenticity; a bad signature throws. */
  verifyWebhook(req: VerifiedRequest, secrets: ConnectorSecrets): Promise<void>;
  /** Parses a verified callback into the status it carries. */
  parseWebhook(req: VerifiedRequest): PaymentWebhookEvent;
}

/* --------------------------------------------------------------------- tax */

/**
 * Tax for a market whose answer is not a row in a table (docs/29 G2, ADR-0121).
 *
 * US sales tax is a function of destination, the seller's own nexus footprint
 * and the product's taxability class; Brazil layers federal, state and municipal
 * taxes onto one invoice. Neither fits `ledger_tax_rules`, and neither should
 * distort it — that table is correct and cheap for the VAT/GST markets this
 * product ships for, and "a row per Illinois county" is not a rulepack.
 *
 * So a market outside that shape installs a provider and names it in tenant
 * policy (`policy.taxProvider`). The table-backed provider is always installed
 * and is what a tenant gets unless its policy says otherwise, which is what
 * keeps this seam load-bearing rather than a fifth declaration nothing calls.
 */
export interface TaxProviderQuery {
  readonly market: string;
  readonly code: string;
  /** Supply date — a restatement re-derives the rate that applied then. */
  readonly at: number;
}

export interface TaxProviderAnswer {
  readonly ratePpm: number;
  /** Which tax this is; the `TAX_KINDS` vocabulary in `./tax.js`. */
  readonly kind: string;
  readonly placeOfSupply: string | null;
  readonly reverseCharge: boolean;
  readonly exempt: boolean;
  /**
   * The rulepack row this came from, when it came from one. A computed answer —
   * a US destination rate — has none, and `null` is how it says so.
   */
  readonly ruleId: string | null;
}

export interface TaxProvider {
  /** The key tenant policy names. */
  readonly key: string;
  /** The treatment for this query, or null when this provider has no answer. */
  resolve(q: TaxProviderQuery): Promise<TaxProviderAnswer | null>;
}
