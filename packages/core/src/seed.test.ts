import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHART_OF_ACCOUNTS, schema } from "@lyra/db";
import { ensureDemoAdmin, ensureSeedPeople, seed, SEED_TENANT_SLUG, syncChartOfAccounts, syncSeedEventNames, syncSeedJourneyGraphs } from "./seed.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { TENANT_ROLE_KEYS, isInternalRole, permissionsForRole } from "./rbac.js";
import type { CoreDb } from "./context.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let db: CoreDb;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;
});

describe("password", () => {
  it("round-trips and rejects a wrong password", async () => {
    const stored = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(await verifyPassword("correct-horse-batterz", stored)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
    expect(needsRehash("pbkdf2$1000$aa$bb")).toBe(true);
  });

  it("refuses a short password", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/12 characters/);
  });
});

describe("seed", () => {
  it("refuses to seed a production environment with the built-in demo password", async () => {
    await expect(seed(db, { environment: "production" })).rejects.toThrow(/production/);
    const tenants = await db.select().from(schema.tenants);
    expect(tenants).toHaveLength(0);
  });

  it("provisions GONXT once, with logins, panel and a reconcilable sale", async () => {
    const r = await seed(db, { password: "gonxt-test-password" });
    expect(r.tenantId).toMatch(/^tn_/);

    // Roles carry the real permission catalogue, not an empty list.
    const admin = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.key, "tenant.admin"));
    expect(JSON.parse(admin[0]!.permissionsJson)).toEqual(permissionsForRole("tenant.admin"));

    const user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "amina.saleh@gonxt.ae"));
    expect(await verifyPassword("gonxt-test-password", user[0]!.passwordHash)).toBe(true);

    // Our own paper sits on the panel alongside the external underwriters.
    const providers = await db.select().from(schema.providers);
    expect(providers.filter((p) => p.isInternal)).toHaveLength(1);
    expect(providers.length).toBeGreaterThan(4);

    // The fan-out shared four comparable quotes and one was bound.
    const responses = await db.select().from(schema.distQuoteResponses);
    expect(responses).toHaveLength(4);

    const [entry] = await db.select().from(schema.distCommissionEntries);
    const [policy] = await db.select().from(schema.axisPolicies);
    expect(entry!.policyId).toBe(policy!.id);
    expect(entry!.grossCommissionMinor).toBe(policy!.commissionMinor);
    expect(entry!.channelCommissionMinor + entry!.taxMinor + entry!.netCommissionMinor).toBe(
      entry!.grossCommissionMinor
    );

    await expect(seed(db)).rejects.toThrow(/already seeded/);
  });

  it("gives NORTH a coherent set to read: every reference resolves", async () => {
    await seed(db, { password: "gonxt-test-password" });

    const metricKeys = new Set(
      (await db.select().from(schema.northMetrics)).map((r) => r.key)
    );
    expect(metricKeys.size).toBeGreaterThanOrEqual(10);

    // Snapshots and anomalies are the metric layer measured — neither may name
    // a metric the registry does not define.
    const snaps = await db.select().from(schema.northSnapshots);
    expect(snaps.length).toBeGreaterThanOrEqual(20);
    for (const s of snaps) expect(metricKeys.has(s.metricKey)).toBe(true);
    const anomalies = await db.select().from(schema.northAnomalies);
    for (const a of anomalies) expect(metricKeys.has(a.metricKey)).toBe(true);

    // A drill-down that disagrees with the headline is the bug this catches.
    const decemberGwp = snaps.filter((s) => s.metricKey === "gwp" && s.period === "2025-12");
    const total = decemberGwp.find((s) => s.dimsHash === "")!.value;
    for (const dim of ["channel", "provider"]) {
      const split = decemberGwp.filter((s) => s.dimsHash.startsWith(`${dim}=`));
      expect(split.length).toBeGreaterThan(1);
      expect(split.reduce((sum, s) => sum + s.value, 0)).toBe(total);
    }

    // Decisions cite the briefing, anomaly or pack that raised them.
    const ids = new Set([
      ...(await db.select().from(schema.northBriefings)).map((r) => `north_briefing:${r.id}`),
      ...anomalies.map((r) => `north_anomaly:${r.id}`),
      ...(await db.select().from(schema.northBoardpacks)).map((r) => `north_boardpack:${r.id}`)
    ]);
    const decisions = await db.select().from(schema.northDecisions);
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    for (const d of decisions) expect(ids.has(d.contextRef!)).toBe(true);

    // ...and an anomaly that opened one points back at a decision that exists.
    const decisionIds = new Set(decisions.map((d) => `north_decision:${d.id}`));
    for (const a of anomalies.filter((x) => x.linkedActionRef)) {
      expect(decisionIds.has(a.linkedActionRef!)).toBe(true);
    }
  });

  it("exposes the constant that guards re-seeding as the gonxt slug", () => {
    expect(SEED_TENANT_SLUG).toBe("gonxt");
  });

  it("names the gonxt tenant with the slug every provisioning path checks", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const [tenant] = await db.select().from(schema.tenants);
    expect(tenant!.slug).toBe(SEED_TENANT_SLUG);
    expect(tenant!.name).toBe("GONXT");
  });

  it("logs in each named persona with their exact name and role", async () => {
    await seed(db, { password: "gonxt-test-password" });

    const roleKeyFor = async (email: string): Promise<{ name: string; role: string }> => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      const [ur] = await db
        .select({ key: schema.roles.key })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(eq(schema.userRoles.userId, user!.id));
      return { name: user!.name, role: ur!.key };
    };

    expect(await roleKeyFor("rana.hadid@gonxt.ae")).toEqual({ name: "Rana Hadid", role: "north.analyst" });
    expect(await roleKeyFor("faisal.omar@gonxt.ae")).toEqual({ name: "Faisal Omar", role: "finance.controller" });
    expect(await roleKeyFor("nadia.rahman@gonxt.ae")).toEqual({ name: "Nadia Rahman", role: "finance.controller" });
    expect(await roleKeyFor("mona.idris@gonxt.ae")).toEqual({ name: "Mona Idris", role: "finance.analyst" });
    expect(await roleKeyFor("raed.samir@gonxt.ae")).toEqual({ name: "Raed Samir", role: "dev.admin" });
  });

  it("gives the demo login every internal role and no portal role", async () => {
    await seed(db, { password: "gonxt-test-password" });

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, "demo@gonxt.ae"));
    const held = await db
      .select({ key: schema.roles.key })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, user!.id));
    const keys = held.map((r) => r.key).sort();

    expect(user!.name).toBe("Demo Administrator");
    expect(keys).toEqual(TENANT_ROLE_KEYS.filter(isInternalRole).slice().sort());
    expect(keys.some((k) => !isInternalRole(k))).toBe(false);
  });

  it("tops up a tenant seeded before the demo login existed, and adds nothing twice", async () => {
    const { tenantId } = await seed(db, { password: "gonxt-test-password" });

    // The state an already-deployed tenant is in: the account and its grants
    // gone, as if it had been provisioned before either existed.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, "demo@gonxt.ae"));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));

    const first = await ensureDemoAdmin(db, tenantId);
    expect(first.created).toBe(true);
    expect(first.granted.slice().sort()).toEqual(TENANT_ROLE_KEYS.filter(isInternalRole).slice().sort());

    const second = await ensureDemoAdmin(db, tenantId);
    expect(second).toMatchObject({ created: false, userId: first.userId, granted: [] });
  });

  /**
   * The live symptom this was written for: `hind.saqr` and `yasmin.faris` were
   * added to PEOPLE after the demo tenant was provisioned, `seed()` refuses a
   * second call, and so neither appears in production's /demo/personas.
   */
  it("adds a persona the tenant was seeded before, and adds nothing twice", async () => {
    const { tenantId } = await seed(db, { password: "gonxt-test-password" });

    // The state a tenant seeded before dec6b07 is in.
    const [hind] = await db.select().from(schema.users).where(eq(schema.users.email, "hind.saqr@gonxt.ae"));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, hind!.id));
    await db.delete(schema.users).where(eq(schema.users.id, hind!.id));

    const first = await ensureSeedPeople(db, tenantId);
    expect(first.created).toEqual(["hind.saqr@gonxt.ae"]);

    const [again] = await db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.email, "hind.saqr@gonxt.ae"));
    expect(again!.name).toBe("Hind Saqr");
    const [role] = await db
      .select({ key: schema.roles.key })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, again!.id));
    expect(role!.key).toBe("orbit.admin");

    // A second run touches nothing — every address is already taken.
    expect((await ensureSeedPeople(db, tenantId)).created).toEqual([]);
  });

  /**
   * Sighting 9's shape again: seeded journeys and webhooks named events the
   * code never emits (`dist.policy.issued`, `dist.quote.bound`, …). Fixing the
   * seed reaches a fresh tenant; a tenant provisioned before it keeps the dead
   * names forever unless the resync seam rewrites them.
   */
  it("rewrites the seeded dead event names a deployed tenant still holds, and only those", async () => {
    const { tenantId } = await seed(db, { password: "gonxt-test-password" });
    // The state a tenant seeded before the rename is in.
    const journeys = await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId));
    const welcome = journeys.find((j) => j.key === "onboarding_new_policy")!;
    await db
      .update(schema.orbitJourneys)
      .set({ graphJson: welcome.graphJson.replace('"axis.policy.issued"', '"dist.policy.issued"') })
      .where(eq(schema.orbitJourneys.id, welcome.id));
    const hooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    const ops = hooks.find((h) => h.url.includes("ops.gonxt.ae"))!;
    await db
      .update(schema.webhooks)
      .set({ eventTypesJson: JSON.stringify(["ledger.settlement.posted", "ledger.recon.completed", "tenant.own.event"]) })
      .where(eq(schema.webhooks.id, ops.id));

    const first = await syncSeedEventNames(db, tenantId);
    expect(first).toEqual({ journeys: [welcome.id], webhooks: [ops.id] });

    const [after] = await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.id, welcome.id));
    expect(after!.graphJson).toContain('"on":"axis.policy.issued"');
    expect(after!.graphJson).not.toContain("dist.policy.issued");
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, ops.id));
    // A name the tenant authored is theirs: only the seeded dead names move.
    expect(JSON.parse(hook!.eventTypesJson)).toEqual(["ledger.settlement.approved", "ledger.recon.completed", "tenant.own.event"]);

    expect(await syncSeedEventNames(db, tenantId)).toEqual({ journeys: [], webhooks: [] });
  });

  /**
   * docs/30 ORBIT gap 1. The seeded journeys carried no `cooldownDays`, and
   * `triggerJourney` refuses a graph without one (ORB-051: the frequency cap is
   * an unremovable floor) — so no seeded journey could ever enrol anybody, and
   * every event matching a seeded trigger failed its consumer. The seed is
   * fixed; this is how a tenant seeded before the fix gets the cap.
   */
  it("gives a deployed tenant's seeded journeys the cooldown they lacked, and leaves an authored journey alone", async () => {
    const { tenantId } = await seed(db, { password: "gonxt-test-password" });
    const journeys = await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId));
    for (const j of journeys) {
      const graph = JSON.parse(j.graphJson) as Record<string, unknown>;
      expect(graph.cooldownDays, j.key).toBeGreaterThan(0);
      delete graph.cooldownDays;
      delete graph.subject;
      // The name it was seeded with before orbit-partner-quotes.ts emitted anything.
      graph.nodes = (graph.nodes as { type: string; event?: string }[]).map((n) =>
        n.type === "wait_for" ? { ...n, event: "orbit.partner.quote" } : n
      );
      await db.update(schema.orbitJourneys).set({ graphJson: JSON.stringify(graph) }).where(eq(schema.orbitJourneys.id, j.id));
    }
    await db.insert(schema.orbitJourneys).values({
      id: "jrn_own",
      tenantId,
      key: "tenant_own",
      version: 1,
      nameJson: JSON.stringify({ en: "Own" }),
      graphJson: JSON.stringify({ nodes: [], edges: [] }),
      status: "draft",
      createdBy: "user:x",
      createdAt: 1
    });

    const fixed = await syncSeedJourneyGraphs(db, tenantId);
    expect([...fixed].sort()).toEqual(journeys.map((j) => j.id).sort());
    for (const j of await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId))) {
      const graph = JSON.parse(j.graphJson) as { cooldownDays?: number; subject?: string };
      // An authored journey's cap is its author's to set.
      if (j.id === "jrn_own") expect(graph.cooldownDays).toBeUndefined();
      else expect(graph.cooldownDays, j.key).toBe(30);
      expect(graph.subject, j.key).toBe(j.key === "broker_activation" ? "partner" : undefined);
    }
    expect(await syncSeedJourneyGraphs(db, tenantId)).toEqual([]);

    const renamed = await syncSeedEventNames(db, tenantId);
    const broker = journeys.find((j) => j.key === "broker_activation")!;
    expect(renamed.journeys).toContain(broker.id);
    const [after] = await db.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.id, broker.id));
    expect(after!.graphJson).toContain('"event":"orbit.partner.quoted"');
  });

  /**
   * An unscoped provider.viewer is a WIDER grant than the seeded one (ROLE-028,
   * ADR-0025), so a backfill that cannot find the provider must not create the
   * persona at all rather than create it seeing every provider's rows.
   */
  it("scopes a backfilled provider viewer, or declines to create it", async () => {
    const { tenantId } = await seed(db, { password: "gonxt-test-password" });
    const [yasmin] = await db.select().from(schema.users).where(eq(schema.users.email, "yasmin.faris@gonxt.ae"));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, yasmin!.id));
    await db.delete(schema.users).where(eq(schema.users.id, yasmin!.id));

    const { created } = await ensureSeedPeople(db, tenantId);
    expect(created).toContain("yasmin.faris@gonxt.ae");
    const [back] = await db
      .select({ providerId: schema.users.providerId })
      .from(schema.users)
      .where(eq(schema.users.email, "yasmin.faris@gonxt.ae"));
    const [falcon] = await db
      .select({ id: schema.providers.id })
      .from(schema.providers)
      .where(eq(schema.providers.name, "Falcon Insurance"));
    expect(back!.providerId).toBe(falcon!.id);

    // Same persona missing, no Falcon to scope it to: nothing is written.
    const [again] = await db.select().from(schema.users).where(eq(schema.users.email, "yasmin.faris@gonxt.ae"));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, again!.id));
    await db.delete(schema.users).where(eq(schema.users.id, again!.id));
    await db.update(schema.providers).set({ name: "Falcon Renamed" }).where(eq(schema.providers.id, falcon!.id));

    expect((await ensureSeedPeople(db, tenantId)).created).toEqual([]);
    const rows = await db.select().from(schema.users).where(eq(schema.users.email, "yasmin.faris@gonxt.ae"));
    expect(rows).toEqual([]);
  });

  it("opens the three desks scoped to their owning module", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const teams = await db.select().from(schema.teams);
    const byName = Object.fromEntries(teams.map((t) => [t.name, t]));

    expect(teams).toHaveLength(3);
    expect(byName["Motor desk"]).toMatchObject({ moduleScope: "axis" });
    expect(byName["Health desk"]).toMatchObject({ moduleScope: "axis" });
    expect(byName["Retention"]).toMatchObject({ moduleScope: "orbit" });
  });

  it("wires every chart-of-accounts entry into a ledger account with matching fields", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const accounts = await db.select().from(schema.ledgerAccounts);
    expect(accounts).toHaveLength(CHART_OF_ACCOUNTS.length);

    const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
    for (const acc of CHART_OF_ACCOUNTS) {
      expect(byCode[acc.code]).toMatchObject({
        nameJson: JSON.stringify({ en: acc.en, ar: acc.ar }),
        type: acc.type,
        normalSide: acc.normalSide,
        clientMoney: acc.clientMoney ?? false,
        suspense: acc.suspense ?? false,
        currency: "AED",
        status: "active"
      });
    }

    // Spot-check the client-money account explicitly: this is the flag the
    // ledger relies on to segregate client funds, so its wiring must be exact.
    expect(byCode["1010"]).toMatchObject({ clientMoney: true });
    expect(byCode["1000"]).toMatchObject({ clientMoney: false });

    // ADR-0083: PSP Clearing is the one seeded suspense-flagged account, read
    // by periods.ts's no_suspense_balance close check.
    expect(byCode["1300"]).toMatchObject({ suspense: true });
    expect(byCode["1000"]).toMatchObject({ suspense: false });
  });

  it("backfills chart accounts a tenant was seeded before, and leaves the rest alone", async () => {
    const r = await seed(db, { password: "gonxt-test-password" });

    // The state an already-deployed tenant is in after the chart gained a row:
    // everything present except the newcomer, plus one locally-added account
    // that is not in the catalogue and must survive.
    await db.delete(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.code, "3100"));
    await db.insert(schema.ledgerAccounts).values({
      id: "acc_local_one",
      tenantId: r.tenantId,
      code: "9900",
      nameJson: JSON.stringify({ en: "Suspense", ar: "معلق" }),
      type: "asset",
      normalSide: "debit",
      clientMoney: false,
      currency: "AED",
      status: "active",
      createdAt: 1
    });

    expect(await syncChartOfAccounts(db, r.tenantId)).toEqual(["3100"]);

    const codes = (await db.select().from(schema.ledgerAccounts)).map((a) => a.code);
    expect(codes).toContain("3100");
    expect(codes).toContain("9900");
    expect(codes).toHaveLength(CHART_OF_ACCOUNTS.length + 1);

    // Idempotent: the second call is a no-op, so the post-deploy step is safe
    // to repeat and safe to run on a tenant that never missed anything.
    expect(await syncChartOfAccounts(db, r.tenantId)).toEqual([]);
  });

  // ADR-0090: a tenant provisioned before the chart carried an IAS 7 class has
  // `cash_flow` null on every row; the resync gives the seeded codes theirs and
  // leaves a class a tenant set by hand alone.
  it("backfills the cash-flow class onto existing accounts without overriding one set by hand", async () => {
    const r = await seed(db, { password: "gonxt-test-password" });
    await db.update(schema.ledgerAccounts).set({ cashFlow: null });
    await db
      .update(schema.ledgerAccounts)
      .set({ cashFlow: "financing" })
      .where(eq(schema.ledgerAccounts.code, "1100"));

    await syncChartOfAccounts(db, r.tenantId);

    const byCode = new Map((await db.select().from(schema.ledgerAccounts)).map((a) => [a.code, a.cashFlow]));
    expect(byCode.get("1000")).toBe("cash");
    expect(byCode.get("1100")).toBe("financing");
    expect(byCode.get("1010")).toBeNull();
  });

  it("seeds the panel with GONXT's own paper plus five external providers", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const providers = await db.select().from(schema.providers);
    const byName = Object.fromEntries(providers.map((p) => [p.name, p]));

    expect(byName["GONXT Underwriting"]).toMatchObject({ kind: "insurer", isInternal: true, panelStatus: "active" });
    expect(JSON.parse(byName["GONXT Underwriting"]!.linesJson!)).toEqual(["motor", "travel"]);

    expect(byName["Falcon Insurance"]).toMatchObject({ kind: "insurer", isInternal: false });
    expect(JSON.parse(byName["Falcon Insurance"]!.linesJson!)).toEqual(["motor", "home"]);
    expect(JSON.parse(byName["Falcon Insurance"]!.quoteEndpointJson!)).toEqual({
      url: "https://api.falcon.example/quote",
      authRef: "CARRIER_FALCON_API_KEY"
    });
    expect(JSON.parse(byName["Falcon Insurance"]!.settlementTermsJson!)).toEqual({ frequency: "monthly", netDays: 30 });

    expect(JSON.parse(byName["Cedar General Insurance"]!.linesJson!)).toEqual(["motor", "home", "travel"]);
    expect(JSON.parse(byName["Cedar General Insurance"]!.settlementTermsJson!)).toEqual({ frequency: "monthly", netDays: 45 });

    expect(JSON.parse(byName["Oryx Takaful"]!.linesJson!)).toEqual(["motor", "life"]);
    expect(JSON.parse(byName["Oryx Takaful"]!.settlementTermsJson!)).toEqual({ frequency: "monthly", netDays: 60 });

    expect(JSON.parse(byName["Gulf Health Assurance"]!.linesJson!)).toEqual(["health"]);
    expect(JSON.parse(byName["Gulf Health Assurance"]!.settlementTermsJson!)).toEqual({ frequency: "monthly", netDays: 30 });

    expect(byName["Meridian Bank"]).toMatchObject({ kind: "financier", isInternal: false });
    expect(JSON.parse(byName["Meridian Bank"]!.linesJson!)).toEqual(["loan"]);
  });

  it("lists the five insurance products with their bilingual names", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const products = await db.select().from(schema.products);
    const byLine = Object.fromEntries(products.map((p) => [p.line, p]));

    expect(JSON.parse(byLine["motor"]!.nameJson)).toEqual({ en: "Motor comprehensive", ar: "تأمين شامل للمركبات" });
    expect(JSON.parse(byLine["health"]!.nameJson)).toEqual({ en: "Health – individual", ar: "تأمين صحي – فردي" });
    expect(JSON.parse(byLine["travel"]!.nameJson)).toEqual({ en: "Travel", ar: "تأمين السفر" });
    expect(JSON.parse(byLine["home"]!.nameJson)).toEqual({ en: "Home contents", ar: "تأمين محتويات المنزل" });
    expect(byLine["life"]).toMatchObject({ structure: "takaful" });
    expect(JSON.parse(byLine["life"]!.nameJson)).toEqual({ en: "Term life", ar: "تأمين على الحياة" });
  });

  it("opens five distribution channels with their commission and settlement terms", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const channels = await db.select().from(schema.distChannels);
    const byKey = Object.fromEntries(channels.map((c) => [c.key, c]));

    expect(byKey["gonxt-web"]).toMatchObject({ kind: "b2c", medium: "web", collectsPayment: "us" });
    expect(byKey["gonxt-app"]).toMatchObject({ kind: "b2c", medium: "app", collectsPayment: "us" });
    expect(byKey["gonxt-call"]).toMatchObject({ kind: "b2c", medium: "call_centre", collectsPayment: "us" });

    expect(byKey["alpha-brokers"]).toMatchObject({ kind: "b2b", medium: "portal", defaultCommissionPpm: 300_000 });
    expect(JSON.parse(byKey["alpha-brokers"]!.settlementTermsJson!)).toEqual({
      frequency: "monthly",
      dayOfMonth: 10,
      netDays: 15,
      minPayoutMinor: 50_000
    });

    expect(byKey["meridian-embed"]).toMatchObject({
      kind: "b2b",
      medium: "embed",
      collectsPayment: "partner",
      defaultCommissionPpm: 400_000
    });
    expect(JSON.parse(byKey["meridian-embed"]!.settlementTermsJson!)).toEqual({
      frequency: "monthly",
      dayOfMonth: 5,
      netDays: 30
    });
  });

  it("prices the panel's nine offerings with their code, name and commission", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const offerings = await db.select().from(schema.distOfferings);
    const byCode = Object.fromEntries(offerings.map((o) => [o.code, o]));

    expect(byCode["GNX-MOT-STD"]).toMatchObject({ baseCommissionPpm: 0, pricingMode: "table" });
    expect(byCode["FAL-MOT-COMP"]).toMatchObject({ baseCommissionPpm: 150_000, pricingMode: "table" });
    expect(byCode["CDR-MOT-ESS"]).toMatchObject({ baseCommissionPpm: 125_000, pricingMode: "table" });
    expect(byCode["CDR-MOT-PLUS"]).toMatchObject({ baseCommissionPpm: 175_000 });
    expect(byCode["CDR-MOT-PLUS"]!.upsellOfOfferingId).toBe(byCode["CDR-MOT-ESS"]!.id);
    expect(byCode["ORX-MOT-TKF"]).toMatchObject({ baseCommissionPpm: 140_000, pricingMode: "manual", slaSeconds: 120 });
    expect(byCode["GHA-IND-SILVER"]).toMatchObject({ baseCommissionPpm: 100_000, pricingMode: "referral", slaSeconds: 300 });
    expect(byCode["GNX-TRV-ANN"]).toMatchObject({ baseCommissionPpm: 0, pricingMode: "table" });
    expect(byCode["CDR-HOM-CONT"]).toMatchObject({ baseCommissionPpm: 200_000, pricingMode: "table" });
    expect(byCode["ORX-LIF-TERM"]).toMatchObject({ baseCommissionPpm: 300_000, pricingMode: "manual" });

    // Two rows share zero external commission: our own paper keeps the whole margin.
    expect(offerings.filter((o) => o.baseCommissionPpm === 0)).toHaveLength(2);
  });

  it("sets channel commission rates per product, offering and line", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const rates = await db.select().from(schema.distCommissionRates);
    expect(rates).toHaveLength(4);
    const byShare = Object.fromEntries(rates.map((r) => [r.channelSharePpm, r]));

    expect(byShare[350_000]).toMatchObject({ earnedOn: "collection", clawbackDays: 30, flatFeeMinor: 0 });
    expect(byShare[450_000]).toMatchObject({ earnedOn: "collection", clawbackDays: 30 });
    expect(byShare[250_000]).toMatchObject({ earnedOn: "collection", flatFeeMinor: 2_500, clawbackDays: 0 });
    expect(byShare[400_000]).toMatchObject({ earnedOn: "issue", clawbackDays: 45 });
  });

  it("shops with full consent so the fan-out is licensed to share data", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const [customer] = await db.select().from(schema.customers);
    expect(JSON.parse(customer!.nameJson)).toEqual({ en: "Rania Haddad", ar: "رانيا حداد" });
    expect(customer!.kycStatus).toBe("verified");

    const [consent] = await db.select().from(schema.consents);
    expect(JSON.parse(consent!.purposesJson)).toEqual({
      marketing: true,
      profiling: true,
      dataSharing: true,
      crossBorder: false
    });
  });

  it("issues the case and both policies with their exact reference numbers", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const [kase] = await db.select().from(schema.axisCases);
    expect(kase!.ref).toBe("GNX-2601-0001");
    expect(kase!.status).toBe("issued");

    // Other module seeders add their own policies to round out the book, so
    // this asserts the two core-story policy numbers are present, not that
    // they are the only ones.
    const policyNos = (await db.select().from(schema.axisPolicies)).map((p) => p.policyNo);
    expect(policyNos).toEqual(expect.arrayContaining(["CDR-MOT-2501-664118", "CDR-MOT-2601-778201"]));
  });

  it("proposes the motor-to-home cross-sell as the seeded next best offer", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const [nbo] = await db.select().from(schema.distNextBestOffers);
    expect(nbo!.kind).toBe("cross_sell");
    expect(nbo!.reasonKey).toBe("nbo.reason.motor_to_home");
    expect(nbo!.score).toBe(72);
    expect(nbo!.expectedValueMinor).toBe(96_000);
  });

  it("registers one AI agent per module with its tier, autonomy and guardrails", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const agents = await db.select().from(schema.aiAgents);
    const byKey = Object.fromEntries(agents.map((a) => [a.key, a]));

    expect(byKey["quoting"]).toMatchObject({ module: "dist", tier: "standard", autonomyLevel: "suggest" });
    expect(byKey["copilot"]).toMatchObject({ module: "axis", tier: "standard", autonomyLevel: "act_with_approval" });
    expect(byKey["renewal"]).toMatchObject({ module: "orbit", tier: "fast", autonomyLevel: "suggest" });
    expect(byKey["service"]).toMatchObject({ module: "orbit", tier: "fast", autonomyLevel: "suggest" });
    expect(byKey["creative"]).toMatchObject({ module: "signal", tier: "standard", autonomyLevel: "suggest" });
    expect(byKey["discovery"]).toMatchObject({ module: "scout", tier: "reasoning", autonomyLevel: "suggest" });
    expect(byKey["briefing"]).toMatchObject({ module: "north", tier: "reasoning", autonomyLevel: "suggest" });
    expect(byKey["recon"]).toMatchObject({ module: "ledger", tier: "fast", autonomyLevel: "suggest" });
    expect(byKey["qa"]).toMatchObject({ module: "core", tier: "standard", autonomyLevel: "suggest" });

    // Only the two customer-facing modules require consent, and only the
    // one agent with approval-gated autonomy demands a human in the loop.
    for (const agent of agents) {
      const guardrails = JSON.parse(agent.guardrailsJson!);
      expect(guardrails.requiresConsent).toBe(agent.module === "dist" || agent.module === "orbit");
      expect(guardrails.humanApproval).toBe(agent.autonomyLevel === "act_with_approval");
    }

    const prompts = await db.select().from(schema.aiPrompts);
    expect(prompts).toHaveLength(10);
    const arPrompt = prompts.find((p) => p.locale === "ar");
    expect(arPrompt?.key).toBe("prompt.quoting.system");
    expect(arPrompt?.body).toContain("أنت تقارن عروض التأمين");
  });

  it("registers every NORTH metric with its exact unit, owner and target", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const rows = await db.select().from(schema.northMetrics);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    const expected: Record<
      string,
      { unit: string; grain: string; direction: string; owner: string; sensitivity: string; target: unknown }
    > = {
      gwp: {
        unit: "money",
        grain: "month",
        direction: "up",
        owner: "faisal.omar",
        sensitivity: "internal",
        target: { value: 230_000_000, scale: "minor", currency: "AED" }
      },
      net_commission: {
        unit: "money",
        grain: "month",
        direction: "up",
        owner: "faisal.omar",
        sensitivity: "internal",
        target: { value: 21_000_000, scale: "minor", currency: "AED" }
      },
      active_policies: {
        unit: "count",
        grain: "month",
        direction: "up",
        owner: "omar.farouk",
        sensitivity: "internal",
        target: { value: 4_800, scale: "count" }
      },
      renewal_retention: {
        unit: "percent",
        grain: "month",
        direction: "up",
        owner: "yusuf.karim",
        sensitivity: "internal",
        target: { value: 8_500, scale: "bps" }
      },
      cac_per_policy: {
        unit: "money",
        grain: "month",
        direction: "down",
        owner: "noor.jamal",
        sensitivity: "internal",
        target: { value: 19_000, scale: "minor", currency: "AED" }
      },
      broker_channel_share: {
        unit: "percent",
        grain: "month",
        direction: "up",
        owner: "dana.aziz",
        sensitivity: "internal",
        target: { value: 4_000, scale: "bps" }
      },
      loss_ratio: {
        unit: "ratio",
        grain: "month",
        direction: "down",
        owner: "faisal.omar",
        sensitivity: "restricted",
        target: { value: 6_000, scale: "bps" }
      },
      ai_cost_per_case: {
        unit: "money",
        grain: "month",
        direction: "down",
        owner: "raed.samir",
        sensitivity: "internal",
        target: { value: 100, scale: "minor", currency: "AED" }
      },
      policies_issued: {
        unit: "count",
        grain: "day",
        direction: "up",
        owner: "omar.farouk",
        sensitivity: "internal",
        target: { value: 55, scale: "count" }
      },
      quote_to_bind_rate: {
        unit: "percent",
        grain: "day",
        direction: "up",
        owner: "layla.hassan",
        sensitivity: "internal",
        target: { value: 2_400, scale: "bps" }
      },
      panel_response_rate: {
        unit: "percent",
        grain: "day",
        direction: "up",
        owner: "dana.aziz",
        sensitivity: "internal",
        target: { value: 9_700, scale: "bps" }
      },
      quote_latency_p95: {
        unit: "duration_ms",
        grain: "day",
        direction: "down",
        owner: "raed.samir",
        sensitivity: "public",
        target: { value: 2_500, scale: "ms" }
      },
      gross_written_premium: {
        unit: "money",
        grain: "day",
        direction: "up",
        owner: "faisal.omar",
        sensitivity: "internal",
        target: { value: 7_500_000, scale: "minor", currency: "AED" }
      },
      net_written_premium: {
        unit: "money",
        grain: "day",
        direction: "up",
        owner: "faisal.omar",
        sensitivity: "internal",
        target: { value: 6_800_000, scale: "minor", currency: "AED" }
      },
      expense_ratio: {
        unit: "ratio",
        grain: "month",
        direction: "down",
        owner: "faisal.omar",
        sensitivity: "restricted",
        target: { value: 1_500, scale: "bps" }
      },
      combined_ratio: {
        unit: "ratio",
        grain: "month",
        direction: "down",
        owner: "faisal.omar",
        sensitivity: "restricted",
        target: { value: 9_500, scale: "bps" }
      },
      quote_hit_rate: {
        unit: "percent",
        grain: "day",
        direction: "up",
        owner: "layla.hassan",
        sensitivity: "internal",
        target: { value: 2_400, scale: "bps" }
      },
      avg_handling_time_claims: {
        unit: "duration_ms",
        grain: "day",
        direction: "down",
        owner: "yusuf.karim",
        sensitivity: "internal",
        target: { value: 5 * 86_400_000, scale: "ms" }
      },
      avg_handling_time_cases: {
        unit: "duration_ms",
        grain: "day",
        direction: "down",
        owner: "raed.samir",
        sensitivity: "internal",
        target: { value: 2 * 86_400_000, scale: "ms" }
      },
      reserve_adequacy: {
        unit: "ratio",
        grain: "month",
        direction: "up",
        owner: "yusuf.karim",
        sensitivity: "restricted",
        target: { value: 10_000, scale: "bps" }
      },
      sla_breach_rate: {
        unit: "percent",
        grain: "day",
        direction: "down",
        owner: "raed.samir",
        sensitivity: "internal",
        target: { value: 500, scale: "bps" }
      },
      open_claim_count: {
        unit: "count",
        grain: "month",
        direction: "down",
        owner: "yusuf.karim",
        sensitivity: "internal",
        target: { value: 120, scale: "count" }
      },
      outstanding_reserve: {
        unit: "money",
        grain: "month",
        direction: "down",
        owner: "yusuf.karim",
        sensitivity: "restricted",
        target: { value: 12_000_000, scale: "minor", currency: "AED" }
      },
      whitespace_promotion_rate: {
        unit: "percent",
        grain: "month",
        direction: "up",
        owner: "layla.hassan",
        sensitivity: "internal",
        target: { value: 3_000, scale: "bps" }
      },
      campaign_return_on_spend: {
        unit: "ratio",
        grain: "month",
        direction: "up",
        owner: "layla.hassan",
        sensitivity: "internal",
        target: { value: 30_000, scale: "bps" }
      },
      cost_per_lead: {
        unit: "money",
        grain: "month",
        direction: "down",
        owner: "noor.jamal",
        sensitivity: "internal",
        target: { value: 3_500, scale: "minor", currency: "AED" }
      },
      cost_per_acquisition: {
        unit: "money",
        grain: "month",
        direction: "down",
        owner: "noor.jamal",
        sensitivity: "internal",
        target: { value: 25_000, scale: "minor", currency: "AED" }
      },
      commission_per_policy: {
        unit: "money",
        grain: "month",
        direction: "up",
        owner: "faisal.omar",
        sensitivity: "internal",
        target: { value: 48_000, scale: "minor", currency: "AED" }
      },
      revenue_per_customer: {
        unit: "money",
        grain: "month",
        direction: "up",
        owner: "noor.jamal",
        sensitivity: "internal",
        target: { value: 58_000, scale: "minor", currency: "AED" }
      }
    };

    expect(Object.keys(byKey).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, exp] of Object.entries(expected)) {
      const row = byKey[key]!;
      expect(row, key).toBeTruthy();
      expect(row.unit, key).toBe(exp.unit);
      expect(row.grain, key).toBe(exp.grain);
      expect(row.direction, key).toBe(exp.direction);
      expect(row.owner, key).toBe(exp.owner);
      expect(row.sensitivity, key).toBe(exp.sensitivity);
      expect(JSON.parse(row.targetJson!), key).toEqual(exp.target);
    }
  });

  it("writes the exact monthly and daily NORTH snapshot series", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const snaps = await db.select().from(schema.northSnapshots);
    const totalsFor = (metricKey: string, grain: "day" | "month"): number[] =>
      snaps
        .filter((s) => s.metricKey === metricKey && s.grain === grain && s.dimsHash === "")
        .sort((a, b) => a.period.localeCompare(b.period))
        .map((s) => s.value);

    expect(totalsFor("gwp", "month")).toEqual([186_400_000, 201_750_000, 238_900_000, 74_300_000]);
    expect(totalsFor("net_commission", "month")).toEqual([17_708_000, 19_166_000, 22_695_000, 7_058_000]);
    expect(totalsFor("active_policies", "month")).toEqual([4_182, 4_361, 4_608, 4_690]);
    expect(totalsFor("renewal_retention", "month")).toEqual([7_920, 8_050, 8_310, 8_180]);
    expect(totalsFor("cac_per_policy", "month")).toEqual([21_400, 20_150, 18_900, 24_600]);
    expect(totalsFor("broker_channel_share", "month")).toEqual([3_120, 3_380, 3_611, 3_740]);
    expect(totalsFor("loss_ratio", "month")).toEqual([6_140, 5_980, 6_420, 6_050]);
    expect(totalsFor("ai_cost_per_case", "month")).toEqual([118, 104, 96, 91]);

    expect(totalsFor("policies_issued", "day")).toEqual([41, 38, 52, 61, 57]);
    expect(totalsFor("quote_to_bind_rate", "day")).toEqual([2_310, 2_280, 2_405, 2_360, 1_890]);
    expect(totalsFor("panel_response_rate", "day")).toEqual([9_650, 9_720, 9_580, 9_240, 8_810]);
    expect(totalsFor("quote_latency_p95", "day")).toEqual([2_150, 2_080, 2_310, 3_040, 3_620]);

    // The December GWP split by channel sums to the same headline the
    // channel-less row reports — proven per-dimension, not just per-total.
    const decemberByChannel = snaps.filter(
      (s) => s.metricKey === "gwp" && s.period === "2025-12" && s.dimsHash.startsWith("channel=")
    );
    const byChannel = Object.fromEntries(decemberByChannel.map((s) => [s.dimsHash, s.value]));
    expect(byChannel["channel=gonxt-web"]).toBe(96_420_000);
    expect(byChannel["channel=gonxt-app"]).toBe(41_880_000);
    expect(byChannel["channel=gonxt-call"]).toBe(14_320_000);
    expect(byChannel["channel=alpha-brokers"]).toBe(62_190_000);
    expect(byChannel["channel=meridian-embed"]).toBe(24_090_000);
  });

  it("staggers NORTH briefings across audiences, statuses and locales", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const briefings = await db.select().from(schema.northBriefings);
    expect(briefings).toHaveLength(5);
    const byKey = Object.fromEntries(briefings.map((b) => [`${b.date}:${b.audience}:${b.locale}`, b]));

    expect(byKey["2026-01-05:exec:en"]).toMatchObject({ status: "published", approvedBy: "hala.zayed" });
    expect(byKey["2026-01-05:exec:ar"]).toMatchObject({ status: "published", approvedBy: "khalid.rashed" });
    expect(byKey["2026-01-04:exec:en"]).toMatchObject({ status: "published", approvedBy: "hala.zayed" });
    expect(byKey["2026-01-02:board:en"]).toMatchObject({ status: "review", approvedBy: null, publishedAt: null });
    expect(byKey["2025-12-31:investor:en"]).toMatchObject({ status: "draft", approvedBy: null, publishedAt: null });

    // narrativeRef holds the prose itself (engines/narrator.ts). The seed used
    // to hold an R2 key, and the reader printed the key as the briefing body.
    for (const briefing of briefings) {
      expect(briefing.narrativeRef).not.toMatch(/^briefings\//);
      expect(briefing.narrativeRef!.length).toBeGreaterThan(200);
      expect(briefing.narrativeRef).toContain("\n\n");
    }
  });

  it("detects NORTH anomalies with the right state, magnitude and driver", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const anomalies = await db.select().from(schema.northAnomalies);
    const byKey = Object.fromEntries(anomalies.map((a) => [`${a.metricKey}:${a.window}`, a]));

    expect(byKey["quote_to_bind_rate:2026-01-05"]).toMatchObject({
      state: "explained",
      magnitude: -1_923,
      expected: 2_340,
      actual: 1_890,
      explainedBy: "rana.hadid"
    });
    expect(byKey["panel_response_rate:2026-01-01..2026-01-05"]).toMatchObject({
      state: "action_created",
      magnitude: -861
    });
    expect(byKey["cac_per_policy:2026-01"]).toMatchObject({ state: "new", magnitude: 2_813, explainedBy: null });
    expect(byKey["gwp:2025-12"]).toMatchObject({ state: "dismissed", magnitude: 1_269 });
    expect(byKey["quote_latency_p95:2026-01-04"]).toMatchObject({ state: "new", magnitude: 6_606 });
  });

  it("records NORTH decisions with the chosen option and lifecycle status", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const decisions = await db.select().from(schema.northDecisions);
    const byTitle = Object.fromEntries(decisions.map((d) => [d.title, d]));

    expect(byTitle["Add a fifth motor underwriter to the panel"]).toMatchObject({
      chosen: "invite_two",
      owner: "hala.zayed",
      status: "open"
    });
    expect(byTitle["Raise the Alpha Brokers motor share to 40% for Q1"]).toMatchObject({
      chosen: "raise_40",
      owner: "dana.aziz",
      status: "open"
    });
    expect(byTitle["Move Oryx motor quotes off manual pricing"]).toMatchObject({
      chosen: "rate_table",
      owner: "omar.farouk",
      status: "open"
    });
    expect(byTitle["Pause the December brand campaign and move the budget to search"]).toMatchObject({
      chosen: "move_to_search",
      status: "reviewed"
    });
    expect(byTitle["Keep GONXT motor on own paper for the 25–39 age band"]).toMatchObject({
      chosen: "keep",
      status: "reviewed"
    });
    expect(byTitle["Withdraw Cedar Motor Essential from the call centre"]).toMatchObject({
      chosen: "keep",
      status: "reversed"
    });
  });

  it("models NORTH scenarios against real channels, offerings and authors", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const scenarios = await db.select().from(schema.northScenarios);
    expect(scenarios.map((s) => s.author)).toEqual(["hala.zayed", "rana.hadid", "rana.hadid"]);
    const brokerShare = scenarios.find((s) => s.question.includes("Alpha Brokers"))!;
    expect(JSON.parse(brokerShare.assumptionsJson)).toMatchObject({
      channelKey: "alpha-brokers",
      channelSharePpm: 450_000,
      currentChannelSharePpm: 350_000
    });
  });

  it("distributes the Q4 board pack while Q1's stays in draft", async () => {
    await seed(db, { password: "gonxt-test-password" });
    const packs = await db.select().from(schema.northBoardpacks);
    const byPeriod = Object.fromEntries(packs.map((p) => [p.period, p]));

    expect(byPeriod["2025-Q4"]).toMatchObject({ status: "distributed", approvedBy: "hala.zayed" });
    expect(byPeriod["2026-Q1"]).toMatchObject({ status: "draft", approvedBy: null });
  });
});
