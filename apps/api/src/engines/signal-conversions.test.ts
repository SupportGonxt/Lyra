import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { sealFields, sha256Hex, type AdConversion, type AdPlatform, type ConversionKey, type Ctx } from "@lyra/core";
import { Hono } from "hono";
import { exportConversions, listConversionExports } from "./signal-conversions.js";
import { recordTouch } from "./signal-attribution.js";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// docs/17 SIG-032, ADR-0112. Value-based bidding: each bind SIGNAL attributed
// is reported back to the connected ad platforms with what it was worth, so
// their bidders optimise on value rather than lead count. It sends each bind
// once per account, only under the customer's consent, only the identifiers
// the platform matches on, and nothing at all until the tenant has said what a
// bind is worth.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-encryption-secret";
const NOW = Date.parse("2026-09-27T00:05:00Z");
const DAY_MS = 86_400_000;
let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function policyWith(signal: { enabled?: boolean; settings?: Record<string, unknown> }) {
  return PolicyJson.parse({ moduleConfig: { signal: { enabled: signal.enabled ?? true, settings: signal.settings ?? {} } } });
}

const PREMIUM_RATE = { conversionValue: { basis: "premium_rate", ratePpm: 100_000 } };

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: policyWith({ settings: PREMIUM_RATE }),
    entitlements: EntitlementsJson.parse({})
  };
});

async function connector(id: string, provider: string, opts: { status?: string; tenantId?: string } = {}) {
  const secretsJson = JSON.stringify(await sealFields(FIELD_KEY, { token: `tok-${id}` }, ["token"]));
  await ctx.db.insert(schema.orbitChannelConnectors).values({
    id,
    tenantId: opts.tenantId ?? "t_1",
    provider,
    transport: "ads",
    label: id,
    secretsJson,
    configJson: "{}",
    status: opts.status ?? "active",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function customer(id: string, purposes: Record<string, boolean> | null, extra: Partial<typeof schema.customers.$inferInsert> = {}) {
  await ctx.db.insert(schema.customers).values({
    id,
    tenantId: "t_1",
    nameJson: JSON.stringify({ en: "Rania Haddad" }),
    emailsJson: JSON.stringify(["Rania.Haddad@example.ae"]),
    phonesJson: JSON.stringify(["+971 50 123 4567"]),
    createdAt: NOW,
    updatedAt: NOW,
    ...extra
  });
  if (purposes) {
    await ctx.db.insert(schema.consents).values({
      id: `cns_${id}`,
      tenantId: "t_1",
      customerId: id,
      purposesJson: JSON.stringify(purposes),
      channelOptinsJson: "{}",
      source: "web",
      ts: NOW - 30 * DAY_MS
    });
  }
}

async function bind(opts: { customerId?: string; gclid?: string; fbclid?: string; valueMinor?: number; ageDays?: number; subjectRef?: string }) {
  return recordTouch(
    { ...ctx, now: NOW - (opts.ageDays ?? 1) * DAY_MS },
    {
      touchType: "bind",
      channel: "google_search",
      customerId: opts.customerId ?? null,
      gclid: opts.gclid ?? null,
      fbclid: opts.fbclid ?? null,
      valueMinor: opts.valueMinor ?? 100_000,
      currency: "AED",
      subjectRef: opts.subjectRef ?? null
    }
  );
}

/** In-memory platform that records every conversion it is handed. */
function fakePlatform(provider: string, keys: readonly ConversionKey[], maxAgeDays: number) {
  const platform: AdPlatform & { received: AdConversion[]; tokens: string[]; failIds: Set<string>; throws?: string } = {
    provider,
    defaultChannel: provider,
    conversionKeys: keys,
    conversionMaxAgeDays: maxAgeDays,
    received: [],
    tokens: [],
    failIds: new Set(),
    async pullSpend() {
      return [];
    },
    async adjustDailyBudget() {
      return { beforeMinor: 0, afterMinor: 0 };
    },
    async uploadConversions(conversions, secrets) {
      if (platform.throws) throw new Error(platform.throws);
      platform.tokens.push(String(secrets.token));
      platform.received.push(...conversions);
      return conversions.map((c) =>
        platform.failIds.has(c.conversionId) ? { conversionId: c.conversionId, status: "failed" as const, error: "refused" } : { conversionId: c.conversionId, status: "sent" as const }
      );
    }
  };
  return platform;
}

function platforms() {
  const google = fakePlatform("google-ads", ["gclid"], 90);
  const meta = fakePlatform("meta-ads", ["fbclid", "emailSha256", "phoneSha256"], 7);
  return { google, meta, all: { "google-ads": google, "meta-ads": meta } };
}

const exportsRows = () => ctx.db.select().from(schema.signalConversionExports);

describe("exportConversions — standing down", () => {
  it("sends nothing and records nothing until the tenant configures a value", async () => {
    ctx = { ...ctx, policy: policyWith({}) };
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true, dataSharing: true });
    await bind({ customerId: "cus_1", gclid: "G1" });
    const { google, all } = platforms();

    expect(await exportConversions(ctx, FIELD_KEY, all)).toEqual({ standDown: "no_value_rule", connectors: 0, sent: 0, skipped: 0, failed: 0, errors: [] });
    expect(google.received).toEqual([]);
    expect(await exportsRows()).toEqual([]);
  });

  it("stands down when SIGNAL is switched off", async () => {
    ctx = { ...ctx, policy: policyWith({ enabled: false, settings: PREMIUM_RATE }) };
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1" });
    const { google, all } = platforms();

    expect((await exportConversions(ctx, FIELD_KEY, all)).standDown).toBe("signal_off");
    expect(google.received).toEqual([]);
  });

  it("stands down with no ad connector, or only an inactive or another tenant's one", async () => {
    await connector("ccn_off", "google-ads", { status: "disabled" });
    await connector("ccn_other", "google-ads", { tenantId: "t_2" });
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1" });
    const { google, all } = platforms();

    expect(await exportConversions(ctx, FIELD_KEY, all)).toEqual({ connectors: 0, sent: 0, skipped: 0, failed: 0, errors: [] });
    expect(google.received).toEqual([]);
    expect(await exportsRows()).toEqual([]);
  });
});

describe("exportConversions", () => {
  it("sends each consented bind with its value and only the platform's own match keys", async () => {
    await connector("ccn_g", "google-ads");
    await connector("ccn_m", "meta-ads");
    await customer("cus_share", { marketing: true, dataSharing: true });
    await customer("cus_mkt", { marketing: true });
    const a = await bind({ customerId: "cus_share", gclid: "G1", fbclid: "F1", valueMinor: 250_000 });
    const b = await bind({ customerId: "cus_mkt", gclid: "G2" });
    await recordTouch(ctx, { touchType: "lead", channel: "google_search", customerId: "cus_share", gclid: "G_lead" });
    const { google, meta, all } = platforms();

    const out = await exportConversions(ctx, FIELD_KEY, all);

    expect(out).toMatchObject({ connectors: 2, sent: 3, errors: [] });
    const bindAt = NOW - DAY_MS;
    // Google matches on gclid alone, so that is all it receives — no hashed identifiers, ever.
    expect(google.received).toEqual(
      expect.arrayContaining([
        { conversionId: a, at: bindAt, valueMinor: 25_000, currency: "AED", gclid: "G1" },
        { conversionId: b, at: bindAt, valueMinor: 10_000, currency: "AED", gclid: "G2" }
      ])
    );
    expect(google.received).toHaveLength(2);
    // Meta gets the fbclid and, because this customer's consent covers data
    // sharing, hashed email and phone.
    expect(meta.received).toEqual([
      {
        conversionId: a,
        at: bindAt,
        valueMinor: 25_000,
        currency: "AED",
        fbclid: "F1",
        emailSha256: [await sha256Hex("rania.haddad@example.ae")],
        phoneSha256: [await sha256Hex("971501234567")]
      }
    ]);
    expect(google.tokens).toEqual(["tok-ccn_g"]);
  });

  it("never sends hashed identifiers without data-sharing consent, and skips a bind with nothing else to match on", async () => {
    await connector("ccn_m", "meta-ads");
    await customer("cus_mkt", { marketing: true, dataSharing: false });
    const t = await bind({ customerId: "cus_mkt" });
    const { meta, all } = platforms();

    expect(await exportConversions(ctx, FIELD_KEY, all)).toMatchObject({ sent: 0, skipped: 1 });
    expect(meta.received).toEqual([]);
    expect((await exportsRows()).map((r) => [r.touchId, r.connectorId, r.status, r.detail])).toEqual([[t, "ccn_m", "skipped", "no_match_key"]]);
  });

  it("skips a bind whose customer has not consented to marketing, or that names no customer at all", async () => {
    await connector("ccn_g", "google-ads");
    await customer("cus_none", null);
    await customer("cus_withdrawn", { marketing: false, dataSharing: true });
    await customer("cus_expired", null);
    await ctx.db.insert(schema.consents).values({
      id: "cns_exp",
      tenantId: "t_1",
      customerId: "cus_expired",
      purposesJson: JSON.stringify({ marketing: true }),
      channelOptinsJson: "{}",
      source: "web",
      ts: NOW - 60 * DAY_MS,
      expiry: NOW - DAY_MS
    });
    await bind({ customerId: "cus_none", gclid: "G1" });
    await bind({ customerId: "cus_withdrawn", gclid: "G2" });
    await bind({ customerId: "cus_expired", gclid: "G3" });
    await bind({ gclid: "G4" });
    const { google, all } = platforms();

    expect(await exportConversions(ctx, FIELD_KEY, all)).toMatchObject({ sent: 0, skipped: 4 });
    expect(google.received).toEqual([]);
    expect(new Set((await exportsRows()).map((r) => r.detail))).toEqual(new Set(["no_consent"]));
  });

  it("sends each bind once per account; a re-run sends nothing new", async () => {
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1" });
    const { google, all } = platforms();

    await exportConversions(ctx, FIELD_KEY, all);
    const second = await exportConversions(ctx, FIELD_KEY, all);

    expect(second).toMatchObject({ connectors: 1, sent: 0, skipped: 0, failed: 0 });
    expect(google.received).toHaveLength(1);
    const [row] = await exportsRows();
    expect(row).toMatchObject({ status: "sent", valueMinor: 10_000, currency: "AED", exportedAt: NOW, provider: "google-ads" });
  });

  it("offers a refused conversion again on the next run, and records when it finally went", async () => {
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true });
    const t = await bind({ customerId: "cus_1", gclid: "G1" });
    const { google, all } = platforms();
    google.failIds.add(t);

    expect(await exportConversions(ctx, FIELD_KEY, all)).toMatchObject({ failed: 1 });
    expect((await exportsRows())[0]).toMatchObject({ status: "failed", detail: "refused", exportedAt: null });

    google.failIds.clear();
    ctx = { ...ctx, now: NOW + 60_000 };
    expect(await exportConversions(ctx, FIELD_KEY, all)).toMatchObject({ sent: 1 });
    const rows = await exportsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", detail: null, exportedAt: NOW + 60_000 });
  });

  it("records an account that could not be reached, writes no rows for it, and carries on with the others", async () => {
    await connector("ccn_g", "google-ads");
    await connector("ccn_m", "meta-ads");
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1", fbclid: "F1" });
    const { google, meta, all } = platforms();
    google.throws = "google-ads 401: token expired";

    const out = await exportConversions(ctx, FIELD_KEY, all);

    expect(out.errors).toEqual([{ connectorId: "ccn_g", error: "google-ads 401: token expired" }]);
    expect(meta.received).toHaveLength(1);
    expect((await exportsRows()).map((r) => r.connectorId)).toEqual(["ccn_m"]);
    const audits = await ctx.db.select().from(schema.auditLog);
    expect(audits.map((a) => [a.action, a.subjectRef]).sort()).toEqual([
      ["signal.conversions.export_failed", "connector:ccn_g"],
      ["signal.conversions.exported", "connector:ccn_m"]
    ]);
  });

  it("offers a platform only the binds still inside its acceptance window", async () => {
    await connector("ccn_g", "google-ads");
    await connector("ccn_m", "meta-ads");
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1", fbclid: "F1", ageDays: 10 });
    await bind({ customerId: "cus_1", gclid: "G2", ageDays: 120 });
    const { google, meta, all } = platforms();

    await exportConversions(ctx, FIELD_KEY, all);

    expect(google.received.map((c) => c.gclid)).toEqual(["G1"]);
    expect(meta.received).toEqual([]);
  });

  it("values a bind at the commission booked on its policy under the commission basis", async () => {
    ctx = { ...ctx, policy: policyWith({ settings: { conversionValue: { basis: "commission" } } }) };
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true });
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: "t_1",
      customerId: "cus_1",
      providerId: "prv_1",
      policyNo: "P-1",
      startAt: NOW,
      endAt: NOW + 365 * DAY_MS,
      premiumMinor: 400_000,
      currency: "USD",
      commissionMinor: 36_000,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    });
    await bind({ customerId: "cus_1", gclid: "G1", subjectRef: "pol_1" });
    await bind({ customerId: "cus_1", gclid: "G2", subjectRef: "track:ev_1" });
    const { google, all } = platforms();

    expect(await exportConversions(ctx, FIELD_KEY, all)).toMatchObject({ sent: 1, skipped: 1 });
    expect(google.received.map((c) => [c.gclid, c.valueMinor, c.currency])).toEqual([["G1", 36_000, "USD"]]);
    expect((await exportsRows()).find((r) => r.status === "skipped")?.detail).toBe("no_value");
  });

  it("hands a platform nothing but the conversion shape — no customer attribute can reach a bidder (SIG-034)", async () => {
    await connector("ccn_g", "google-ads");
    await connector("ccn_m", "meta-ads");
    await customer("cus_1", { marketing: true, dataSharing: true }, {
      nationalIdHash: "nid",
      riskFlagsJson: JSON.stringify({ health: "diabetic" }),
      tagsJson: JSON.stringify(["religion:x", "nationality:y"]),
      country: "AE"
    });
    await bind({ customerId: "cus_1", gclid: "G1", fbclid: "F1" });
    const { google, meta, all } = platforms();

    await exportConversions(ctx, FIELD_KEY, all);

    const allowed = new Set(["conversionId", "at", "valueMinor", "currency", "gclid", "fbclid", "emailSha256", "phoneSha256"]);
    for (const c of [...google.received, ...meta.received]) expect(Object.keys(c).filter((k) => !allowed.has(k))).toEqual([]);
    const wire = JSON.stringify([google.received, meta.received]);
    for (const leaked of ["nid", "diabetic", "religion", "nationality", "Rania", "example.ae", "+971"]) expect(wire).not.toContain(leaked);
  });
});

describe("listConversionExports", () => {
  it("lists this tenant's export rows newest first, filtered by status", async () => {
    await connector("ccn_g", "google-ads");
    await customer("cus_1", { marketing: true });
    await bind({ customerId: "cus_1", gclid: "G1" });
    await bind({ customerId: "cus_1" });
    const { all } = platforms();
    await exportConversions(ctx, FIELD_KEY, all);

    expect((await listConversionExports(ctx, {})).map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect((await listConversionExports(ctx, { status: "skipped" })).map((r) => r.detail)).toEqual(["no_match_key"]);
    expect(await listConversionExports({ ...ctx, tenantId: "t_2" }, {})).toEqual([]);
  });
});

describe("POST /conversions/export, GET /conversions/exports", () => {
  const call = async (method: string, path: string, permissions: string[]) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    const res = await a.fetch(new Request(`http://api.test${path}`, { method }), { FIELD_KEY } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("runs the export on demand for someone who may write spend, and lists it for someone who may read attribution", async () => {
    expect((await call("POST", "/conversions/export", ["signal:attribution:read"])).status).toBe(403);
    expect(await call("POST", "/conversions/export", ["signal:spend:write"])).toEqual({
      status: 200,
      body: { connectors: 0, sent: 0, skipped: 0, failed: 0, errors: [] }
    });

    expect((await call("GET", "/conversions/exports", ["signal:spend:read"])).status).toBe(403);
    expect(await call("GET", "/conversions/exports", ["signal:attribution:read"])).toEqual({ status: 200, body: { data: [] } });
    expect((await call("GET", "/conversions/exports?status=bogus", ["signal:attribution:read"])).status).toBe(400);
  });
});
