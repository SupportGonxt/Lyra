import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema, ulidTime } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";
import { seedAnalytics } from "./analytics.js";
import { DashboardLayoutSchema } from "../dashboard-layout.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// A calendar instant whose UTC time-of-day (02:30) sits strictly between two of
// the utcOffsetMs values the module schedules against (2h and 1.5h below it,
// 3h and 4h above it) — so the four `nextAt` calls the seed makes exercise both
// the "already past today's slot, roll to tomorrow" loop and the "today's slot
// is still ahead" no-loop path, without exporting the private helper.
const NOW = Date.UTC(2026, 0, 15, 2, 30, 0, 0);

const ROLE_KEYS = [
  "north.analyst",
  "north.exec",
  "tenant.admin",
  "finance.controller",
  "signal.lead",
  "axis.agent",
  "finance.analyst",
  "tenant.compliance",
  "axis.lead",
  "orbit.retention"
] as const;

function userIdFor(role: string): string {
  return `usr_${role.replace(/\./g, "_")}`;
}

function ref(role: string): string {
  return `user:${userIdFor(role)}`;
}

let client: Client;
let db: CoreDb;
let ctx: SeedContext;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  const users: Record<string, string> = {};
  for (const role of ROLE_KEYS) users[role] = userIdFor(role);

  ctx = {
    db,
    now: NOW,
    tenantId: "tn_test",
    users,
    teams: { motor: "team_motor", health: "team_health", retention: "team_retention" },
    providers: {
      gonxt: "prov_gonxt",
      falcon: "prov_falcon",
      cedar: "prov_cedar",
      oryx: "prov_oryx",
      gulfHealth: "prov_gulf_health",
      meridian: "prov_meridian"
    },
    products: { motor: "prod_motor", health: "prod_health", travel: "prod_travel", home: "prod_home", life: "prod_life" },
    offerings: {
      gonxtMotor: "off_gonxt_motor",
      falconMotor: "off_falcon_motor",
      cedarMotor: "off_cedar_motor",
      oryxMotor: "off_oryx_motor",
      cedarMotorPlus: "off_cedar_motor_plus",
      gulfHealth: "off_gulf_health",
      gonxtTravel: "off_gonxt_travel",
      cedarHome: "off_cedar_home",
      oryxLife: "off_oryx_life"
    },
    channels: {
      web: "chn_web",
      app: "chn_app",
      callCentre: "chn_call_centre",
      brokerAlpha: "chn_broker_alpha",
      bankEmbed: "chn_bank_embed"
    },
    customerId: "cu_test",
    consentId: "cn_test",
    quoteRequestId: "qr_test",
    caseId: "cs_test",
    policyId: "pol_test",
    renewalPolicyId: "pol_renew_test",
    issuedAt: NOW + 2 * DAY
  };
});

describe("seedAnalytics", () => {
  it("writes exactly eight system-and-personal reports over the real dataset registry", async () => {
    await seedAnalytics(ctx);
    const reports = await db.select().from(schema.reports);
    expect(reports).toHaveLength(8);
    for (const r of reports) {
      expect(r.tenantId).toBe("tn_test");
      expect(r.deletedAt).toBeNull();
    }

    const byKey = new Map(reports.map((r) => [r.key, r]));
    expect([...byKey.keys()].sort()).toEqual(
      [
        "gwp.by-channel",
        "panel.response-by-provider",
        "commission.earned",
        "quotes.daily-funnel",
        "ai.spend-by-purpose",
        "cases.by-status",
        "book.premium-by-customer",
        "ledger.txns-by-state"
      ].sort()
    );

    const yearBack = NOW - 365 * DAY;
    const monthBack = NOW - 30 * DAY;
    const monthAhead = NOW + 30 * DAY;

    const gwp = byKey.get("gwp.by-channel")!;
    expect(gwp.id.startsWith("rep_")).toBe(true);
    expect(ulidTime(gwp.id)).toBe(NOW + 1);
    expect(gwp.module).toBe("axis");
    expect(gwp.piiLevel).toBe("none");
    expect(gwp.requiredPermission).toBe("axis:policies:read");
    expect(gwp.scope).toBe("tenant");
    expect(gwp.system).toBe(true);
    expect(gwp.ownerRef).toBeNull();
    expect(gwp.createdAt).toBe(NOW - 30 * DAY);
    expect(gwp.updatedAt).toBe(NOW - 30 * DAY);
    expect(JSON.parse(gwp.definitionJson)).toEqual({
      dataset: "policies",
      metrics: ["policies", "gwp", "avgPremium"],
      dimensions: ["channelId", "status"],
      from: yearBack,
      to: monthAhead,
      sort: { field: "gwp", dir: "desc" }
    });

    const panel = byKey.get("panel.response-by-provider")!;
    expect(ulidTime(panel.id)).toBe(NOW + 2);
    expect(panel.module).toBe("dist");
    expect(panel.requiredPermission).toBe("dist:quote_requests:read");
    expect(panel.system).toBe(true);
    expect(panel.updatedAt).toBe(NOW - 12 * DAY);
    expect(JSON.parse(panel.definitionJson)).toEqual({
      dataset: "quoteResponses",
      metrics: ["responses", "premium", "latency", "valueScore"],
      dimensions: ["providerId", "state"],
      from: monthBack,
      to: monthAhead,
      sort: { field: "responses", dir: "desc" }
    });

    const commission = byKey.get("commission.earned")!;
    expect(ulidTime(commission.id)).toBe(NOW + 3);
    expect(commission.module).toBe("dist");
    expect(commission.requiredPermission).toBe("dist:commissions:read");
    expect(commission.system).toBe(true);
    expect(JSON.parse(commission.definitionJson)).toEqual({
      dataset: "commissions",
      metrics: ["entries", "premium", "gross", "channel", "net"],
      dimensions: ["kind", "channelId", "state"],
      from: yearBack,
      to: monthAhead,
      sort: { field: "net", dir: "desc" }
    });

    const funnel = byKey.get("quotes.daily-funnel")!;
    expect(ulidTime(funnel.id)).toBe(NOW + 4);
    expect(funnel.module).toBe("dist");
    expect(funnel.system).toBe(false);
    expect(funnel.createdAt).toBe(NOW - 20 * DAY);
    expect(JSON.parse(funnel.definitionJson)).toEqual({
      dataset: "quotes",
      metrics: ["requests", "responded", "bestPremium"],
      grain: "day",
      from: monthBack,
      to: monthAhead
    });

    const aiSpend = byKey.get("ai.spend-by-purpose")!;
    expect(ulidTime(aiSpend.id)).toBe(NOW + 5);
    expect(aiSpend.module).toBe("ai");
    expect(aiSpend.requiredPermission).toBe("ai:budgets:read");
    expect(aiSpend.system).toBe(false);
    expect(aiSpend.createdAt).toBe(NOW - 18 * DAY);
    expect(aiSpend.updatedAt).toBe(NOW - 4 * DAY);
    expect(JSON.parse(aiSpend.definitionJson)).toEqual({
      dataset: "aiSpend",
      metrics: ["calls", "tokensIn", "tokensOut", "costMicro", "latency"],
      dimensions: ["purpose", "model"],
      from: monthBack,
      to: monthAhead,
      sort: { field: "costMicro", dir: "desc" }
    });

    const cases = byKey.get("cases.by-status")!;
    expect(ulidTime(cases.id)).toBe(NOW + 6);
    expect(cases.module).toBe("axis");
    expect(cases.requiredPermission).toBe("axis:cases:read");
    expect(cases.system).toBe(false);
    expect(JSON.parse(cases.definitionJson)).toEqual({
      dataset: "cases",
      metrics: ["cases", "value", "avgRisk", "customers"],
      dimensions: ["status", "productLine"],
      from: monthBack,
      to: monthAhead,
      sort: { field: "cases", dir: "desc" }
    });

    // The one PII-high, personally-scoped report: proof the scope filter has
    // something real to hide.
    const book = byKey.get("book.premium-by-customer")!;
    expect(ulidTime(book.id)).toBe(NOW + 7);
    expect(book.module).toBe("axis");
    expect(book.piiLevel).toBe("high");
    expect(book.scope).toBe("personal");
    expect(book.ownerRef).toBe(ref("north.analyst"));
    expect(book.system).toBe(false);
    expect(book.createdAt).toBe(NOW - 9 * DAY);
    expect(JSON.parse(book.definitionJson)).toEqual({
      dataset: "policies",
      metrics: ["policies", "gwp", "commission"],
      dimensions: ["customerId", "productId"],
      from: yearBack,
      to: monthAhead,
      sort: { field: "gwp", dir: "desc" },
      limit: 200
    });

    const txns = byKey.get("ledger.txns-by-state")!;
    expect(ulidTime(txns.id)).toBe(NOW + 8);
    expect(txns.module).toBe("ledger");
    expect(txns.requiredPermission).toBe("ledger:txns:read");
    expect(txns.system).toBe(false);
    expect(txns.createdAt).toBe(NOW - 11 * DAY);
    expect(JSON.parse(txns.definitionJson)).toEqual({
      dataset: "transactions",
      metrics: ["txns", "gross"],
      dimensions: ["type", "state", "currency"],
      from: monthBack,
      to: monthAhead,
      sort: { field: "gross", dir: "desc" }
    });
  });

  it("writes four dashboards with the right tile counts, defaults and role gates", async () => {
    await seedAnalytics(ctx);
    const dashboards = await db.select().from(schema.dashboards);
    expect(dashboards).toHaveLength(4);
    const byKey = new Map(dashboards.map((d) => [d.key, d]));

    const funnel = byKey.get("dist.funnel")!;
    expect(funnel.id.startsWith("dsh_")).toBe(true);
    expect(ulidTime(funnel.id)).toBe(NOW + 11);
    expect(funnel.module).toBe("dist");
    expect(funnel.isDefault).toBe(true);
    expect(funnel.scope).toBe("tenant");
    expect(funnel.ownerRef).toBeNull();
    expect(funnel.rolesJson).toBeNull();
    expect(JSON.parse(funnel.layoutJson).tiles).toHaveLength(4);

    const finance = byKey.get("finance.commission")!;
    expect(ulidTime(finance.id)).toBe(NOW + 12);
    expect(finance.module).toBe("ledger");
    expect(finance.isDefault).toBe(false);
    expect(JSON.parse(finance.rolesJson!)).toEqual([
      "finance.controller",
      "finance.analyst",
      "north.exec",
      "tenant.admin"
    ]);
    expect(JSON.parse(finance.layoutJson).tiles).toHaveLength(4);

    const service = byKey.get("orbit.service")!;
    expect(ulidTime(service.id)).toBe(NOW + 13);
    expect(service.module).toBe("orbit");
    expect(service.isDefault).toBe(false);
    expect(JSON.parse(service.rolesJson!)).toEqual(["orbit.agent", "orbit.retention", "axis.lead", "tenant.admin"]);
    expect(JSON.parse(service.layoutJson).tiles).toHaveLength(4);

    const desk = byKey.get("analyst.desk")!;
    expect(ulidTime(desk.id)).toBe(NOW + 14);
    expect(desk.module).toBe("north");
    expect(desk.scope).toBe("personal");
    expect(desk.ownerRef).toBe(ref("north.analyst"));
    expect(desk.rolesJson).toBeNull();
    expect(desk.isDefault).toBe(false);
    expect(JSON.parse(desk.layoutJson).tiles).toHaveLength(2);
  });

  // The seed writes the table directly, past the write-time check the API makes,
  // so it is held to the same schema here: a seeded board the editor would
  // refuse to save is a board nobody can edit (docs/30 Analytics 5).
  it("writes only layouts the dashboard schema accepts", async () => {
    await seedAnalytics(ctx);
    const dashboards = await db.select().from(schema.dashboards);
    for (const d of dashboards) {
      expect(DashboardLayoutSchema.safeParse(JSON.parse(d.layoutJson)).success, d.key).toBe(true);
    }
  });

  it("registers eight report runs across every terminal and in-flight state", async () => {
    await seedAnalytics(ctx);
    const reports = await db.select().from(schema.reports);
    const reportIdByKey = new Map(reports.map((r) => [r.key, r.id]));
    const runs = await db.select().from(schema.reportRuns);
    expect(runs).toHaveLength(8);

    const byReport = new Map(runs.map((r) => [r.reportId, r]));

    const gwpRun = byReport.get(reportIdByKey.get("gwp.by-channel")!)!;
    expect(gwpRun.id.startsWith("run_")).toBe(true);
    expect(ulidTime(gwpRun.id)).toBe(NOW + 21);
    expect(gwpRun.requestedBy).toBe("system:scheduler");
    expect(gwpRun.trigger).toBe("schedule");
    expect(gwpRun.state).toBe("done");
    expect(gwpRun.rowCount).toBe(4);
    expect(gwpRun.durationMs).toBe(412);
    expect(gwpRun.startedAt).toBe(NOW - 21 * HOUR);
    expect(gwpRun.endedAt).toBe(NOW - 21 * HOUR + 412);
    expect(gwpRun.expiresAt).toBe(NOW - 21 * HOUR + 24 * HOUR);

    const panelRun = byReport.get(reportIdByKey.get("panel.response-by-provider")!)!;
    expect(ulidTime(panelRun.id)).toBe(NOW + 22);
    expect(panelRun.requestedBy).toBe(ref("north.analyst"));
    expect(panelRun.trigger).toBe("user");
    expect(panelRun.rowCount).toBe(4);
    expect(panelRun.durationMs).toBe(138);
    expect(panelRun.startedAt).toBe(NOW - 3 * HOUR);
    expect(panelRun.endedAt).toBe(NOW - 3 * HOUR + 138);

    const commissionRun = byReport.get(reportIdByKey.get("commission.earned")!)!;
    expect(ulidTime(commissionRun.id)).toBe(NOW + 23);
    expect(commissionRun.requestedBy).toBe(ref("finance.controller"));
    expect(commissionRun.trigger).toBe("api");
    expect(commissionRun.rowCount).toBe(1);
    expect(commissionRun.durationMs).toBe(96);
    expect(commissionRun.startedAt).toBe(NOW - 2 * HOUR);

    const funnelRun = byReport.get(reportIdByKey.get("quotes.daily-funnel")!)!;
    expect(ulidTime(funnelRun.id)).toBe(NOW + 24);
    expect(funnelRun.requestedBy).toBe(ref("signal.lead"));
    expect(funnelRun.rowCount).toBe(1);
    expect(funnelRun.durationMs).toBe(74);
    expect(funnelRun.startedAt).toBe(NOW - 40 * MINUTE);

    const aiRun = byReport.get(reportIdByKey.get("ai.spend-by-purpose")!)!;
    expect(ulidTime(aiRun.id)).toBe(NOW + 25);
    expect(aiRun.state).toBe("failed");
    expect(aiRun.rowCount).toBeNull();
    expect(aiRun.durationMs).toBe(11);
    expect(aiRun.error).toBe("unknown dimension agentRef on aiSpend");
    expect(aiRun.startedAt).toBe(NOW - 4 * DAY);
    expect(aiRun.endedAt).toBe(NOW - 4 * DAY + 11);

    const casesRun = byReport.get(reportIdByKey.get("cases.by-status")!)!;
    expect(ulidTime(casesRun.id)).toBe(NOW + 26);
    expect(casesRun.state).toBe("running");
    expect(casesRun.rowCount).toBeNull();
    expect(casesRun.durationMs).toBeNull();
    expect(casesRun.error).toBeNull();
    expect(casesRun.startedAt).toBe(NOW - 20_000);
    expect(casesRun.endedAt).toBeNull();
    expect(casesRun.expiresAt).toBe(NOW + 24 * HOUR);

    const bookRun = byReport.get(reportIdByKey.get("book.premium-by-customer")!)!;
    expect(ulidTime(bookRun.id)).toBe(NOW + 27);
    expect(bookRun.state).toBe("queued");
    expect(bookRun.startedAt).toBe(NOW - 4_000);
    expect(bookRun.endedAt).toBeNull();

    const txnsRun = byReport.get(reportIdByKey.get("ledger.txns-by-state")!)!;
    expect(ulidTime(txnsRun.id)).toBe(NOW + 28);
    expect(txnsRun.state).toBe("expired");
    expect(txnsRun.requestedBy).toBe(ref("finance.analyst"));
    expect(txnsRun.rowCount).toBe(3);
    expect(txnsRun.durationMs).toBe(88);
    expect(txnsRun.startedAt).toBe(NOW - 2 * DAY);
    expect(txnsRun.expiresAt).toBe(NOW - 2 * DAY + 24 * HOUR);

    const states = runs.map((r) => r.state).sort();
    expect(states).toEqual(["done", "done", "done", "done", "expired", "failed", "queued", "running"].sort());
  });

  it("registers six export artefacts, including the dual-control unmasked one", async () => {
    await seedAnalytics(ctx);
    const exports = await db.select().from(schema.analyticsExports);
    expect(exports).toHaveLength(6);
    // Every export in this seed is a placeholder awaiting a real render.
    for (const e of exports) expect(e.fileId).toBeNull();

    const gwpExport = exports.find((e) => e.format === "pdf" && e.state === "ready")!;
    expect(gwpExport.id.startsWith("exp_")).toBe(true);
    expect(ulidTime(gwpExport.id)).toBe(NOW + 31);
    expect(gwpExport.sizeBytes).toBe(48_210);
    expect(gwpExport.rowCount).toBe(4);
    expect(gwpExport.piiMasked).toBe(true);
    expect(gwpExport.requestedBy).toBe("system:scheduler");
    expect(gwpExport.approvedBy).toBeNull();
    expect(gwpExport.downloadCount).toBe(2);
    expect(gwpExport.expiresAt).toBe(NOW - 21 * HOUR + 7 * DAY);
    expect(gwpExport.watermark).toBe(`system:scheduler · ${new Date(NOW - 21 * HOUR).toISOString().slice(0, 19)}`);

    const xlsxReady = exports.find((e) => e.format === "xlsx" && e.state === "ready")!;
    expect(ulidTime(xlsxReady.id)).toBe(NOW + 32);
    expect(xlsxReady.sizeBytes).toBe(12_884);
    expect(xlsxReady.downloadCount).toBe(1);
    expect(xlsxReady.requestedBy).toBe(ref("finance.controller"));
    expect(xlsxReady.watermark).toBe(`${ref("finance.controller")} · ${new Date(NOW - 2 * HOUR).toISOString().slice(0, 19)}`);

    // Unmasked: dual control means both a justification and an approver.
    const unmasked = exports.find((e) => e.piiMasked === false)!;
    expect(ulidTime(unmasked.id)).toBe(NOW + 33);
    expect(unmasked.format).toBe("xlsx");
    expect(unmasked.state).toBe("rendering");
    expect(unmasked.runId).toBeNull();
    expect(unmasked.piiJustification).toBe(
      "Regulator sample request REG-2026-014: named policyholders for the January motor book."
    );
    expect(unmasked.requestedBy).toBe(ref("north.analyst"));
    expect(unmasked.approvedBy).toBe(ref("tenant.compliance"));
    expect(unmasked.watermark).toBe(`${ref("north.analyst")} · ${new Date(NOW - 30 * MINUTE).toISOString().slice(0, 19)}`);
    expect(unmasked.expiresAt).toBe(NOW - 30 * MINUTE + 7 * DAY);

    const csvQueued = exports.find((e) => e.format === "csv")!;
    expect(ulidTime(csvQueued.id)).toBe(NOW + 34);
    expect(csvQueued.state).toBe("queued");
    expect(csvQueued.requestedBy).toBe(ref("axis.agent"));
    expect(csvQueued.watermark).toBeNull();
    expect(csvQueued.expiresAt).toBe(NOW + 7 * DAY);

    const failed = exports.find((e) => e.state === "failed")!;
    expect(ulidTime(failed.id)).toBe(NOW + 35);
    expect(failed.error).toBe("unknown dimension agentRef on aiSpend");
    expect(failed.requestedBy).toBe(ref("north.analyst"));
    expect(failed.expiresAt).toBe(NOW - 4 * DAY + 7 * DAY);

    // The case pack: no report or run, a subject instead.
    const casePack = exports.find((e) => e.reportId === null)!;
    expect(ulidTime(casePack.id)).toBe(NOW + 36);
    expect(casePack.runId).toBeNull();
    expect(casePack.subjectRef).toBe(`axis_case:${ctx.caseId}`);
    expect(casePack.format).toBe("pdf");
    expect(casePack.sizeBytes).toBe(96_400);
    expect(casePack.state).toBe("expired");
    expect(casePack.downloadCount).toBe(3);
    expect(casePack.requestedBy).toBe(ref("axis.lead"));
    expect(casePack.expiresAt).toBe(NOW - 2 * DAY);
    expect(casePack.watermark).toBe(`${ref("axis.lead")} · ${new Date(NOW - 9 * DAY).toISOString().slice(0, 19)}`);
  });

  it("computes nextRunAt on both sides of today's slot, and delivers to real recipients", async () => {
    await seedAnalytics(ctx);
    const schedules = await db.select().from(schema.analyticsSchedules);
    expect(schedules).toHaveLength(5);
    const byName = new Map(schedules.map((s) => [JSON.parse(s.nameJson).en as string, s]));

    // Today's UTC time-of-day is 02:30. A 3h/4h slot is still ahead today, so
    // nextAt returns it without looping to tomorrow.
    const exec = byName.get("Executive 7am read")!;
    expect(exec.id.startsWith("sch_")).toBe(true);
    expect(ulidTime(exec.id)).toBe(NOW + 41);
    expect(exec.cron).toBe("0 7 * * *");
    expect(exec.status).toBe("active");
    expect(exec.lastRunAt).toBe(NOW - 21 * HOUR);
    expect(exec.lastState).toBe("done");
    expect(exec.createdBy).toBe(ref("north.analyst"));
    expect(JSON.parse(exec.recipientsJson)).toEqual([userIdFor("north.exec"), userIdFor("tenant.admin")]);
    expect(exec.nextRunAt).toBe(Date.UTC(2026, 0, 15, 3, 0, 0, 0));

    const panel = byName.get("Monday panel pack")!;
    expect(ulidTime(panel.id)).toBe(NOW + 42);
    expect(panel.cron).toBe("0 8 * * 1");
    expect(panel.format).toBe("xlsx");
    expect(JSON.parse(panel.paramsJson!)).toEqual({ grain: "week" });
    expect(JSON.parse(panel.recipientsJson)).toEqual([userIdFor("axis.lead"), userIdFor("north.analyst")]);
    expect(panel.createdBy).toBe(ref("axis.lead"));
    expect(panel.nextRunAt).toBe(Date.UTC(2026, 0, 20, 4, 0, 0, 0));

    // A 2h slot is behind today's 02:30, so nextAt has to roll to tomorrow —
    // the loop-runs branch, on a `from` shifted 18 days out.
    const commission = byName.get("Month-end commission file")!;
    expect(ulidTime(commission.id)).toBe(NOW + 43);
    expect(commission.cron).toBe("0 6 1 * *");
    expect(commission.lastState).toBe("partial");
    expect(commission.createdBy).toBe(ref("finance.controller"));
    expect(JSON.parse(commission.recipientsJson)).toEqual([userIdFor("finance.controller"), userIdFor("finance.analyst")]);
    expect(commission.nextRunAt).toBe(Date.UTC(2026, 1, 3, 2, 0, 0, 0));

    // Paused and dashboard-linked rather than report-linked; a failed last run
    // is exactly why it stays paused.
    const dashboards = await db.select().from(schema.dashboards);
    const funnelDashboardId = dashboards.find((d) => d.key === "dist.funnel")!.id;
    const daily = byName.get("Daily funnel board")!;
    expect(ulidTime(daily.id)).toBe(NOW + 44);
    expect(daily.reportId).toBeNull();
    expect(daily.dashboardId).toBe(funnelDashboardId);
    expect(daily.status).toBe("paused");
    expect(daily.lastState).toBe("failed");
    expect(daily.nextRunAt).toBeNull();
    expect(JSON.parse(daily.recipientsJson)).toEqual([userIdFor("signal.lead")]);

    // The 1.5h slot is also behind 02:30 — second instance of the loop branch,
    // and the only schedule addressed to a raw email rather than a user id.
    const aiDigest = byName.get("Daily AI spend digest")!;
    expect(ulidTime(aiDigest.id)).toBe(NOW + 45);
    expect(aiDigest.lastState).toBe("undelivered");
    expect(JSON.parse(aiDigest.recipientsJson)).toEqual(["finance@gonxt.ae"]);
    expect(aiDigest.nextRunAt).toBe(Date.UTC(2026, 0, 16, 1, 30, 0, 0));
  });

  it("writes six saved views, split between tenant-shared and per-user", async () => {
    await seedAnalytics(ctx);
    const views = await db.select().from(schema.savedViews);
    expect(views).toHaveLength(6);
    const byName = new Map(views.map((v) => [v.name, v]));

    const motorBinds = byName.get("Motor binds in flight")!;
    expect(motorBinds.id.startsWith("sv_")).toBe(true);
    expect(ulidTime(motorBinds.id)).toBe(NOW + 51);
    expect(motorBinds.route).toBe("/axis/cases");
    expect(motorBinds.userId).toBeNull();
    expect(motorBinds.isDefault).toBe(true);
    expect(JSON.parse(motorBinds.queryJson)).toEqual({ kind: "bind", productLine: "motor", status: "in_progress" });

    const waiting = byName.get("Panels still waiting on an underwriter")!;
    expect(ulidTime(waiting.id)).toBe(NOW + 52);
    expect(waiting.route).toBe("/distribution/quote-requests");
    expect(waiting.isDefault).toBe(false);
    expect(JSON.parse(waiting.queryJson)).toEqual({ state: "fanned_out" });

    const failedRuns = byName.get("Runs that failed")!;
    expect(ulidTime(failedRuns.id)).toBe(NOW + 53);
    expect(failedRuns.route).toBe("/analytics/report-runs");
    expect(JSON.parse(failedRuns.queryJson)).toEqual({ state: "failed" });

    const unmaskedView = byName.get("Unmasked artefacts")!;
    expect(ulidTime(unmaskedView.id)).toBe(NOW + 54);
    expect(unmaskedView.route).toBe("/analytics/exports");
    expect(JSON.parse(unmaskedView.queryJson)).toEqual({ piiMasked: false });
    expect(unmaskedView.userId).toBeNull();
    expect(JSON.parse(unmaskedView.sharedWithJson!)).toEqual([userIdFor("tenant.compliance"), userIdFor("finance.controller")]);

    // Private views: scoped to one user, invisible to everyone else on the
    // same route.
    const recon = byName.get("My reconciliation queue")!;
    expect(ulidTime(recon.id)).toBe(NOW + 55);
    expect(recon.route).toBe("/ledger/txns");
    expect(recon.userId).toBe(userIdFor("finance.controller"));
    expect(recon.isDefault).toBe(true);
    expect(recon.sharedWithJson).toBeNull();
    expect(JSON.parse(recon.queryJson)).toEqual({ state: "pending", type: "commission" });

    const renewalWindow = byName.get("My 30-day window")!;
    expect(ulidTime(renewalWindow.id)).toBe(NOW + 56);
    expect(renewalWindow.route).toBe("/orbit/renewals");
    expect(renewalWindow.userId).toBe(userIdFor("orbit.retention"));
    expect(renewalWindow.isDefault).toBe(false);
    expect(JSON.parse(renewalWindow.queryJson)).toEqual({ status: "raised", withinDays: 30 });
  });

  it("books unit economics that tie the bind's revenue to no other row", async () => {
    await seedAnalytics(ctx);
    const rows = await db.select().from(schema.unitEconomics);
    expect(rows).toHaveLength(6);
    const byUnit = new Map(rows.map((r) => [r.unit, r]));

    const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

    const bind = byUnit.get("bind")!;
    expect(bind.id.startsWith("uec_")).toBe(true);
    expect(ulidTime(bind.id)).toBe(NOW + 61);
    expect(bind.module).toBe("dist");
    expect(bind.day).toBe(dayOf(ctx.issuedAt));
    expect(bind.volume).toBe(1);
    expect(bind.aiCostMicro).toBe(41_200);
    expect(bind.mediaCostMicro).toBe(0);
    expect(bind.humanMinutes).toBe(12);
    // The only unit economics row that books real revenue — everything else
    // is cost against work whose money already landed here.
    expect(bind.revenueMinor).toBe(51_563);
    expect(bind.currency).toBe("AED");
    expect(bind.updatedAt).toBe(ctx.issuedAt + HOUR);

    const kase = byUnit.get("case")!;
    expect(ulidTime(kase.id)).toBe(NOW + 62);
    expect(kase.module).toBe("axis");
    expect(kase.day).toBe(dayOf(NOW - DAY));
    expect(kase.volume).toBe(9);
    expect(kase.aiCostMicro).toBe(214_000);
    expect(kase.humanMinutes).toBe(143);
    expect(kase.revenueMinor).toBe(0);

    const conversation = byUnit.get("conversation")!;
    expect(ulidTime(conversation.id)).toBe(NOW + 63);
    expect(conversation.module).toBe("orbit");
    expect(conversation.volume).toBe(34);
    expect(conversation.aiCostMicro).toBe(612_000);
    expect(conversation.humanMinutes).toBe(96);
    expect(conversation.revenueMinor).toBe(0);

    const renewal = byUnit.get("renewal")!;
    expect(ulidTime(renewal.id)).toBe(NOW + 64);
    expect(renewal.module).toBe("orbit");
    expect(renewal.volume).toBe(7);
    expect(renewal.aiCostMicro).toBe(158_000);
    expect(renewal.humanMinutes).toBe(21);
    expect(renewal.revenueMinor).toBe(0);

    const campaign = byUnit.get("campaign")!;
    expect(ulidTime(campaign.id)).toBe(NOW + 65);
    expect(campaign.module).toBe("signal");
    expect(campaign.day).toBe(dayOf(NOW - 2 * DAY));
    expect(campaign.volume).toBe(1);
    expect(campaign.aiCostMicro).toBe(96_000);
    expect(campaign.mediaCostMicro).toBe(1_250_000_000);
    expect(campaign.humanMinutes).toBe(34);
    expect(campaign.revenueMinor).toBe(0);

    const brief = byUnit.get("brief")!;
    expect(ulidTime(brief.id)).toBe(NOW + 66);
    expect(brief.module).toBe("north");
    expect(brief.day).toBe(dayOf(NOW - 2 * DAY));
    expect(brief.volume).toBe(2);
    expect(brief.aiCostMicro).toBe(380_000);
    expect(brief.mediaCostMicro).toBe(0);
    expect(brief.humanMinutes).toBe(15);
    expect(brief.revenueMinor).toBe(0);

    for (const r of rows) {
      expect(r.currency).toBe("AED");
      expect(r.tenantId).toBe("tn_test");
    }
  });

  it("traces J-C1 across a completed sale and two distinct drop-offs", async () => {
    await seedAnalytics(ctx);
    const events = await db.select().from(schema.journeyEvents);
    expect(events).toHaveLength(12);
    for (const e of events) {
      expect(e.tenantId).toBe("tn_test");
      expect(e.journeyId).toBe("J-C1");
    }

    const byStepActor = new Map(events.map((e) => [`${e.step}:${e.actorRef}`, e]));
    const customer = `customer:${ctx.customerId}`;

    const landed = byStepActor.get(`landed:${customer}`)!;
    expect(landed.id.startsWith("jev_")).toBe(true);
    expect(ulidTime(landed.id)).toBe(NOW + 71);
    expect(landed.subjectRef).toBe(`dist_channel:${ctx.channels.web}`);
    expect(landed.outcome).toBe("progressed");
    expect(landed.durationMs).toBeNull();
    expect(landed.ts).toBe(NOW - 4 * MINUTE);

    const quoteRequested = byStepActor.get(`quote_requested:${customer}`)!;
    expect(ulidTime(quoteRequested.id)).toBe(NOW + 72);
    expect(quoteRequested.subjectRef).toBe(`dist_quote_request:${ctx.quoteRequestId}`);
    expect(quoteRequested.durationMs).toBe(4 * MINUTE);
    expect(quoteRequested.ts).toBe(NOW);

    const offersRanked = byStepActor.get(`offers_ranked:${customer}`)!;
    expect(ulidTime(offersRanked.id)).toBe(NOW + 73);
    expect(offersRanked.durationMs).toBe(40_000);
    expect(offersRanked.ts).toBe(NOW + 40_000);

    const offerChosen = byStepActor.get(`offer_chosen:${customer}`)!;
    expect(ulidTime(offerChosen.id)).toBe(NOW + 74);
    expect(offerChosen.subjectRef).toBe(`dist_offering:${ctx.offerings.cedarMotor}`);
    expect(offerChosen.durationMs).toBe(110_000);
    expect(offerChosen.ts).toBe(NOW + 150_000);

    const docsUploaded = byStepActor.get(`documents_uploaded:${customer}`)!;
    expect(ulidTime(docsUploaded.id)).toBe(NOW + 75);
    expect(docsUploaded.subjectRef).toBe(`axis_case:${ctx.caseId}`);
    expect(docsUploaded.durationMs).toBe(5 * MINUTE);
    expect(docsUploaded.ts).toBe(NOW + 8 * MINUTE);

    const paymentOk = byStepActor.get(`payment_authorised:${customer}`)!;
    expect(ulidTime(paymentOk.id)).toBe(NOW + 76);
    expect(paymentOk.subjectRef).toBe(`axis_case:${ctx.caseId}`);
    expect(paymentOk.durationMs).toBe(70_000);
    expect(paymentOk.ts).toBe(NOW + 9 * MINUTE);

    const issued = byStepActor.get(`policy_issued:${customer}`)!;
    expect(ulidTime(issued.id)).toBe(NOW + 77);
    expect(issued.subjectRef).toBe(`axis_policy:${ctx.policyId}`);
    expect(issued.outcome).toBe("completed");
    expect(issued.durationMs).toBe(ctx.issuedAt - (NOW - 4 * MINUTE));
    expect(issued.ts).toBe(ctx.issuedAt);

    const crossSell = byStepActor.get(`cross_sell_offered:${customer}`)!;
    expect(ulidTime(crossSell.id)).toBe(NOW + 78);
    expect(crossSell.subjectRef).toBe(`dist_offering:${ctx.offerings.cedarHome}`);
    expect(crossSell.outcome).toBe("progressed");
    expect(crossSell.durationMs).toBeNull();
    expect(crossSell.ts).toBe(ctx.issuedAt + 2 * MINUTE);

    // Session one: drops off before a quote request ever exists.
    const abandonedLanded = byStepActor.get("landed:session:gnx-web-4471")!;
    expect(ulidTime(abandonedLanded.id)).toBe(NOW + 79);
    expect(abandonedLanded.subjectRef).toBe(`dist_channel:${ctx.channels.web}`);
    expect(abandonedLanded.ts).toBe(NOW - 3 * HOUR);
    const abandonedQuote = byStepActor.get("quote_requested:session:gnx-web-4471")!;
    expect(ulidTime(abandonedQuote.id)).toBe(NOW + 80);
    expect(abandonedQuote.subjectRef).toBeNull();
    expect(abandonedQuote.outcome).toBe("abandoned");
    expect(abandonedQuote.durationMs).toBe(70_000);
    expect(abandonedQuote.ts).toBe(NOW - 3 * HOUR + 70_000);

    // Session two: gets a panel, but the card is declined — a step failure,
    // not an abandonment.
    const declinedRanked = byStepActor.get("offers_ranked:session:gnx-web-5290")!;
    expect(ulidTime(declinedRanked.id)).toBe(NOW + 81);
    expect(declinedRanked.outcome).toBe("progressed");
    expect(declinedRanked.durationMs).toBe(52_000);
    expect(declinedRanked.ts).toBe(NOW - 90 * MINUTE);
    const declinedPayment = byStepActor.get("payment_authorised:session:gnx-web-5290")!;
    expect(ulidTime(declinedPayment.id)).toBe(NOW + 82);
    expect(declinedPayment.subjectRef).toBeNull();
    expect(declinedPayment.outcome).toBe("failed");
    expect(declinedPayment.durationMs).toBe(145_000);
    expect(declinedPayment.ts).toBe(NOW - 90 * MINUTE + 145_000);
  });
});
