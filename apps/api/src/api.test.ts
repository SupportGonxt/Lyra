import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { isKnownPermission, permissionsForRole, type Ctx } from "@lyra/core";
import { BY_MODULE } from "./resources.js";
import { DATASETS, runReport, totalsOf } from "./engines/report.js";
import { toXlsx } from "./engines/export/xlsx.js";
import { pdfSafe, toPdf } from "./engines/export/pdf.js";
import { crc32 } from "./engines/export/zip.js";
import { nextRun } from "./routes/analytics.js";
import { COOKIE } from "./auth.js";
import { openapi } from "./openapi.js";
import { app } from "./index.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now: Date.UTC(2026, 5, 15, 12),
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/**
 * AppError carries the generic title in `message` ("Bad request") and the cause
 * in `detail`, so assertions read the detail.
 */
async function detailOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { detail?: string }).detail ?? String(e);
  }
  return "";
}

/* ------------------------------------------------------------- permissions */

describe("permission vocabulary", () => {
  // A typo in a permission string is silent: `can()` simply never matches, so
  // the endpoint denies everyone and nobody notices until go-live. This is the
  // test that makes the vocabulary a compile-time-ish fact.
  it("every string the API checks is a real permission", () => {
    const unknown = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          for (const m of readFileSync(path, "utf8").matchAll(/"([a-z_]+:[a-z_]+:[a-z_]+)"/g)) {
            const p = m[1] as string;
            if (!isKnownPermission(p)) unknown.add(`${entry.name}: ${p}`);
          }
        }
      }
    };
    walk(import.meta.dirname);
    expect([...unknown]).toEqual([]);
  });

  it("every CRUD resource names permissions that exist", () => {
    const bad: string[] = [];
    for (const [module, resources] of Object.entries(BY_MODULE)) {
      for (const r of resources) {
        for (const p of Object.values(r.perms)) {
          if (typeof p === "string" && !isKnownPermission(p)) bad.push(`${module}/${r.path}: ${p}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("gives a viewer read only", () => {
    const viewer = permissionsForRole("provider.viewer");
    expect(viewer.length).toBeGreaterThan(0);
    expect(viewer.filter((p) => !p.endsWith(":read") && p !== "*")).toEqual([]);
  });
});

/* ---------------------------------------------------------------- datasets */

describe("semantic layer", () => {
  it("every dataset points at real columns and a real permission", async () => {
    const bad: string[] = [];
    for (const [key, ds] of Object.entries(DATASETS)) {
      if (!isKnownPermission(ds.permission)) bad.push(`${key}: permission ${ds.permission}`);
      const cols = [
        ds.timeColumn,
        "tenant_id",
        ...Object.values(ds.dimensions).map((d) => d.column),
        ...Object.values(ds.metrics).flatMap((m) => (m.column ? [m.column] : []))
      ];
      for (const col of cols) {
        // A wrong table or column name would otherwise surface on a customer's
        // first report run; this turns it into a red test instead.
        await ctx.db.all(sql.raw(`select "${col}" from ${ds.table} limit 0`)).catch(() => {
          bad.push(`${key}: ${ds.table}.${col}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });

  it("every metric's aggregate compiles — a `when` predicate names real columns too", async () => {
    // The column walk above cannot see inside a count_if/pct_if predicate, so
    // run each dataset with every metric and every dimension at once.
    const bad: string[] = [];
    for (const [key, ds] of Object.entries(DATASETS)) {
      await runReport(ctx, {
        dataset: key,
        metrics: Object.keys(ds.metrics),
        dimensions: Object.keys(ds.dimensions),
        grain: "day"
      }).catch((e: unknown) => bad.push(`${key}: ${e instanceof Error ? e.message : String(e)}`));
    }
    expect(bad).toEqual([]);
  });

  it("refuses a dimension that is not in the registry", async () => {
    expect(
      await detailOf(() =>
        runReport(ctx, { dataset: "policies", metrics: ["policies"], dimensions: ["'; drop table core_users; --"] })
      )
    ).toMatch(/unknown dimension/);
  });

  it("refuses a metric that is not in the registry", async () => {
    expect(
      await detailOf(() => runReport(ctx, { dataset: "policies", metrics: ["sum(premium_minor) from core_users"] }))
    ).toMatch(/unknown metric/);
  });

  it("refuses an unknown dataset", async () => {
    expect(await detailOf(() => runReport(ctx, { dataset: "core_users", metrics: ["policies"] }))).toMatch(
      /unknown dataset/
    );
  });

  it("refuses a report with no metric", async () => {
    expect(await detailOf(() => runReport(ctx, { dataset: "policies", metrics: [] }))).toMatch(/at least one metric/);
  });

  it("scopes every query to the caller's tenant", async () => {
    await seedPolicies();
    const mine = await runReport(ctx, { dataset: "policies", metrics: ["policies"] });
    const theirs = await runReport({ ...ctx, tenantId: "t_other" }, { dataset: "policies", metrics: ["policies"] });
    expect(mine.rows[0]?.policies).toBe(2);
    expect(theirs.rows[0]?.policies).toBe(0);
  });

  it("groups by period and totals money", async () => {
    await seedPolicies();
    const r = await runReport(ctx, { dataset: "policies", metrics: ["gwp", "policies"], grain: "month" });
    expect(r.columns[0]?.key).toBe("period");
    expect(r.rows[0]?.period).toBe("2026-06");
    expect(totalsOf(r).gwp).toBe(300_00);
  });

  it("binds filter values instead of splicing them", async () => {
    await seedPolicies();
    const r = await runReport(ctx, {
      dataset: "policies",
      metrics: ["gwp"],
      filters: [{ field: "status", op: "eq", value: "active' or '1'='1" }]
    });
    // If the value were spliced into the SQL, this would match both rows.
    expect(r.rows[0]?.gwp).toBe(null);
  });

  it("hashes a PII dimension unless the caller is entitled", async () => {
    await seedPolicies();
    const def = { dataset: "policies", metrics: ["policies"], dimensions: ["customerId"] };
    const masked = await runReport(ctx, def);
    const clear = await runReport(ctx, def, { unmasked: true });
    // Masking groups the same way — it changes the label, never the shape.
    expect(masked.rows.length).toBe(clear.rows.length);
    expect(clear.rows.map((r) => r.customerId).sort()).toEqual(["cus_1", "cus_2"]);
    expect(masked.rows.some((r) => String(r.customerId).includes("cus_"))).toBe(false);
  });

  it("caps the row count rather than streaming the table", async () => {
    await seedPolicies();
    const r = await runReport(ctx, { dataset: "policies", metrics: ["gwp"], dimensions: ["customerId"], limit: 1 });
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(true);
  });

  // docs/27 P2: only signals and whitespaces were registered; clusters,
  // experiments and data products are the same shape (a plain count/aggregate,
  // no thin-cell counterparty risk) and were simply missing.
  it("reports on the SCOUT tables that were missing from the registry", async () => {
    await ctx.db.insert(schema.scoutClusters).values([
      { id: "clu_1", tenantId: ctx.tenantId, theme: "flood cover", momentumScore: 80, size: 12, firstSeen: ctx.now, lastSeen: ctx.now, updatedAt: ctx.now },
      { id: "clu_2", tenantId: ctx.tenantId, theme: "ev add-on", momentumScore: 40, size: 4, firstSeen: ctx.now, lastSeen: ctx.now, updatedAt: ctx.now }
    ]);
    await ctx.db.insert(schema.scoutExperiments).values([
      { id: "sxp_1", tenantId: ctx.tenantId, whitespaceId: "wsp_1", state: "running", createdAt: ctx.now }
    ]);
    await ctx.db.insert(schema.scoutDataProducts).values([
      {
        id: "dtp_1",
        tenantId: ctx.tenantId,
        name: "Demand curve",
        definitionJson: "{}",
        consentBasis: "contract",
        aggregationMin: 25,
        status: "published",
        createdAt: ctx.now,
        updatedAt: ctx.now
      }
    ]);

    const clusters = await runReport(ctx, { dataset: "clusters", metrics: ["clusters", "avgMomentum"] });
    expect(clusters.rows[0]?.clusters).toBe(2);
    expect(clusters.rows[0]?.avgMomentum).toBe(60);

    const experiments = await runReport(ctx, { dataset: "experiments", metrics: ["experiments"] });
    expect(experiments.rows[0]?.experiments).toBe(1);

    const dataProducts = await runReport(ctx, { dataset: "dataProducts", metrics: ["dataProducts", "avgFloor"] });
    expect(dataProducts.rows[0]?.dataProducts).toBe(1);
    expect(dataProducts.rows[0]?.avgFloor).toBe(25);
  });

  it("keeps panel bench out of the registry: a generic group-by has no k-anonymity floor", async () => {
    expect(DATASETS["panelBench"]).toBeUndefined();
  });
});

/* ----------------------------------------------------------------- exports */

const TABLE = {
  title: "Premium by month",
  columns: [
    { key: "period", label: "Month", kind: "text" as const },
    { key: "gwp", label: "Premium", kind: "money" as const },
    { key: "policies", label: "Policies", kind: "number" as const }
  ],
  rows: [
    { period: "2026-05", gwp: 125_00, policies: 3 },
    { period: "2026-06", gwp: 175_00, policies: 4 }
  ],
  currency: "AED",
  generatedAt: Date.UTC(2026, 5, 15)
};

describe("exports", () => {
  it("computes the CRC the ZIP spec expects", () => {
    // Canonical vector: CRC-32 of "123456789" is 0xCBF43926.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a workbook Excel can open", () => {
    const bytes = toXlsx([TABLE]);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 22, 22);
    expect(view.getUint32(0, true)).toBe(0x06054b50); // end of central directory
    expect(view.getUint16(10, true)).toBe(6); // one entry per part, one sheet
  });

  it("writes money as a number, not a formatted string", () => {
    const text = new TextDecoder().decode(toXlsx([TABLE]));
    expect(text).toContain("<v>125</v>"); // 125_00 minor units, as major
    expect(text).not.toContain("AED 125.00");
  });

  it("writes a PDF with a valid trailer and one page per table", () => {
    const text = new TextDecoder("latin1").decode(toPdf([TABLE], { totals: { gwp: 300_00 } }));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text.match(/\/Type \/Page[^s]/g)?.length).toBe(1);
    expect(text).toContain("startxref");
  });

  it("stamps a watermark when one is asked for", () => {
    const plain = new TextDecoder("latin1").decode(toPdf([TABLE]));
    const stamped = new TextDecoder("latin1").decode(toPdf([TABLE], { watermark: "user:u_1 - 2026-06-15" }));
    expect(plain).not.toContain("user:u_1");
    expect(stamped).toContain("user:u_1 - 2026-06-15");
  });

  it("reports Arabic as unsafe rather than drawing boxes", () => {
    expect(pdfSafe([TABLE])).toBe(true);
    expect(pdfSafe([{ ...TABLE, rows: [{ period: "يونيو", gwp: 1, policies: 1 }] }])).toBe(false);
    expect(pdfSafe([{ ...TABLE, title: "تقرير" }])).toBe(false);
  });
});

/* --------------------------------------------------------------- schedules */

describe("cron", () => {
  const at = (s: string): number => Date.parse(s);

  it("finds the next daily fire time", () => {
    expect(nextRun("0 6 * * *", at("2026-06-15T05:00:00Z"))).toBe(at("2026-06-15T06:00:00Z"));
    expect(nextRun("0 6 * * *", at("2026-06-15T07:00:00Z"))).toBe(at("2026-06-16T06:00:00Z"));
  });

  it("handles steps, lists and day-of-week", () => {
    expect(nextRun("*/15 * * * *", at("2026-06-15T05:01:00Z"))).toBe(at("2026-06-15T05:15:00Z"));
    expect(nextRun("0 9 * * 1", at("2026-06-15T10:00:00Z"))).toBe(at("2026-06-22T09:00:00Z"));
    expect(nextRun("30 8,17 * * *", at("2026-06-15T09:00:00Z"))).toBe(at("2026-06-15T17:30:00Z"));
  });

  it("never returns a time at or before `from`", () => {
    const from = at("2026-06-15T06:00:00Z");
    expect(nextRun("0 6 * * *", from)).toBe(at("2026-06-16T06:00:00Z"));
  });

  it("rejects a malformed expression instead of silently never running", async () => {
    expect(await detailOf(() => nextRun("0 6 *", 0))).toMatch(/five fields/);
  });
});

/* ----------------------------------------------------------------- openapi */

describe("openapi", () => {
  const spec = openapi() as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };
  const resourceCount = Object.values(BY_MODULE).reduce((n, rs) => n + rs.length, 0);

  it("names the cookie a client actually has to send", () => {
    // openapi() takes the name rather than reading env, so the SDK can be
    // generated with no environment; the default therefore duplicates auth.ts's
    // COOKIE, and this is what stops the duplicate drifting. A deployment that
    // renames the cookie serves its own name — index.ts passes it in.
    const scheme = (openapi().components as { securitySchemes: { session: { name: string } } })
      .securitySchemes.session;
    expect(scheme.name).toBe(COOKIE);
    const renamed = (
      openapi("lyra_session_staging").components as {
        securitySchemes: { session: { name: string } };
      }
    ).securitySchemes.session;
    expect(renamed.name).toBe("lyra_session_staging");
  });

  it("describes every registered resource", () => {
    expect(Object.keys(spec.components.schemas).length).toBeGreaterThanOrEqual(resourceCount);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(resourceCount);
  });

  it("leaves no documented endpoint unauthenticated", () => {
    // J-X3 adds one deliberate exception outside /v1/auth: signup has no
    // session to authenticate against yet, which is the entire point of the
    // route (routes/onboarding.ts, mw.ts PUBLIC set). ADR-0030 adds a second:
    // the public comparison site has no session by design either
    // (routes/portal.ts). ADR-0037 adds a third: a provider's webhook call
    // carries no session and never will — the adapter's HMAC over the raw body
    // is the authentication, and the connector id in the URL resolves the
    // tenant (routes/channels.ts). Every other unauthenticated path here would
    // be a real bug.
    const open = Object.entries(spec.paths)
      .filter(
        ([p]) =>
          !p.startsWith("/v1/auth") &&
          !p.startsWith("/v1/portal") &&
          !p.startsWith("/v1/channels/") &&
          p !== "/health" &&
          p !== "/openapi.json" &&
          p !== "/v1/onboarding/partners/signup"
      )
      .flatMap(([p, ops]) => Object.entries(ops).filter(([, op]) => !op.security).map(([m]) => `${m} ${p}`));
    expect(open).toEqual([]);
  });

  /**
   * A documented path that no handler answers is a lie, and a documented path
   * answered by a *different* handler is a worse one. Hono returns handlers in
   * registration order, so a generated `/:id` route registered before a
   * hand-written `/statement` route silently swallows it. Both failures show up
   * as "the first route matching this path is not the route we documented".
   */
  it("routes every documented path to the handler that documents it", () => {
    const registered = app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => ({ method: r.method.toLowerCase(), segments: r.path.split("/") }));

    const wrong: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      // `{id}` in the spec is `:id` on the router; compare on shape, not name.
      const want = path.replace(/\{\w+\}/g, ":p").split("/");
      for (const method of Object.keys(ops)) {
        const first = registered.find((r) => r.method === method && matches(r.segments, want));
        if (!first) wrong.push(`${method} ${path} — no handler`);
        else if (!same(first.segments, want)) wrong.push(`${method} ${path} — shadowed by ${first.segments.join("/")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The other direction, and the one that was missing. The test above walks the
   * spec and asks whether a handler answers it, so it can only ever catch a
   * documented endpoint — `POST /v1/core/api-keys` shipped with a handler, a
   * permission and no entry, and nothing failed. Walk the router instead: every
   * route it mounts is either in the document or in `UNDOCUMENTED` with a reason.
   */
  it("documents every route the router mounts", () => {
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((method) => `${method} ${path.replace(/\{\w+\}/g, ":p")}`)
      )
    );
    const missing = app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:\w+/g, ":p")}`)
      .filter((id) => !documented.has(id))
      // PUT on an item path is registered as a byte-identical alias of PATCH
      // (crud.ts); one entry describes both.
      .filter((id) => !documented.has(id.replace(/^put /, "patch ")))
      .filter((id) => !UNDOCUMENTED.has(id));
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});

/**
 * Routes deliberately outside the published contract. An addition here is a
 * decision to keep an endpoint off the SDK and out of every integrator's view,
 * so it needs the reason beside it — the empty case is a route someone forgot.
 */
const UNDOCUMENTED = new Set([
  // Operational, not part of /v1: a load balancer's probe and the spec itself.
  "get /health",
  "get /openapi.json",
  // The reference underwriter (ADR-0072). It is a carrier we happen to host,
  // not a LYRA capability: it has no tenant, no session and no data, and the
  // only client it is built for is engines/dist-quoter.ts over a service
  // binding. Publishing it would put a foreign wire contract in our SDK.
  "post /carrier-sandbox/quote",
  // Shadows that exist only to answer 400. These three rows are produced by a
  // run endpoint and may never be written directly (routes/compliance.ts
  // §run-only rows), so documenting them as creatable would be the lie.
  "post /v1/compliance/screenings",
  "post /v1/compliance/evidence-bundles",
  "post /v1/compliance/retention-runs"
]);

/** Whether a registered route pattern would answer a request for `want`. */
function matches(route: string[], want: string[]): boolean {
  if (route.length !== want.length) return false;
  return route.every((seg, i) => seg.startsWith(":") || seg === want[i]);
}

/** Same shape: literals equal, parameters in the same positions. */
function same(route: string[], want: string[]): boolean {
  if (route.length !== want.length) return false;
  return route.every((seg, i) => (seg.startsWith(":") ? want[i]?.startsWith(":") === true : seg === want[i]));
}

/* -------------------------------------------------------------------- seed */

async function seedPolicies(): Promise<void> {
  const base = {
    tenantId: ctx.tenantId,
    providerId: "prv_1",
    offeringId: "off_1",
    status: "active",
    currency: "AED",
    startAt: ctx.now,
    endAt: ctx.now + 365 * 24 * 3600 * 1000,
    commissionMinor: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisPolicies).values([
    { ...base, id: "pol_1", policyNo: "P-1", customerId: "cus_1", premiumMinor: 125_00 },
    { ...base, id: "pol_2", policyNo: "P-2", customerId: "cus_2", premiumMinor: 175_00 }
  ]);
}
