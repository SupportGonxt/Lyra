import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, getTableColumns } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { decide, notFound, permissionsForRole, type Ctx } from "@lyra/core";
import { crudRouter, type Resource } from "./crud.js";
import { onError } from "./mw.js";
import { BY_MODULE } from "./resources.js";
import { scoutRoutes } from "./routes/scout.js";
import type { App } from "./env.js";

// Three classes of registry bug, none of which any other test can see:
//
// 1. A declared `amountField` that names no column is silent: the approval is
//    raised with no amount and a reviewer signs off on a money change without
//    seeing what it is worth (CLAUDE.md §12).
// 2. A `pii` key that names no column masks nothing — `orbit/messages` declared
//    `body` where the column is `content`, so every message body was readable
//    without `core:pii:view`.
// 3. A `secretColumns` entry that names no column strips nothing.
//
// All three fail open and all three look right in review. So the declarations
// are checked against the real Drizzle columns here — and, for the secrets, the
// declaration is not trusted either: the router is driven and the response is
// searched for the column and its value.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.UTC(2026, 5, 15, 12);

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const columnsOf = (r: Resource): Record<string, SQLiteColumn> =>
  getTableColumns(r.table) as Record<string, SQLiteColumn>;

const all = (): { module: string; r: Resource }[] =>
  Object.entries(BY_MODULE).flatMap(([module, rs]) => rs.map((r) => ({ module, r })));

describe("resource registry", () => {
  it("every declared amountField names a real column on its table", () => {
    const bad: string[] = [];
    for (const { module, r } of all()) {
      const field = r.approval?.amountField;
      if (field && !columnsOf(r)[field]) bad.push(`${module}/${r.path}: ${field}`);
    }
    expect(bad).toEqual([]);
  });

  it("every declared actorColumn names a real column on its table", () => {
    const bad: string[] = [];
    for (const { module, r } of all()) {
      const cols = columnsOf(r);
      for (const key of r.actorColumns ?? []) if (!cols[key]) bad.push(`${module}/${r.path}: ${key}`);
    }
    expect(bad).toEqual([]);
  });

  it("every declared pii key names a real column on its table", () => {
    const bad: string[] = [];
    for (const { module, r } of all()) {
      const cols = columnsOf(r);
      // A nested key like `nameJson.first` masks inside a JSON column; only the
      // root has to be a column.
      for (const key of Object.keys(r.pii ?? {})) {
        const [root = ""] = key.split(".");
        if (!cols[root]) bad.push(`${module}/${r.path}: ${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every declared secretColumn names a real column on its table", () => {
    const bad: string[] = [];
    for (const { module, r } of all()) {
      const cols = columnsOf(r);
      for (const key of r.secretColumns ?? []) if (!cols[key]) bad.push(`${module}/${r.path}: ${key}`);
    }
    expect(bad).toEqual([]);
  });
});

/* --------------------------------------------------- the router, driven */

let ctx: Ctx;

/** The generated router for one resource, with a fixed all-permissions context. */
function router(r: Resource, over: Partial<Ctx> = {}): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  // Mirrors index.ts: an unmatched route is a JSON 404 in prod, not Hono's
  // default plain-text fallback — a bare test router without this returns
  // "404 Not Found" text, which crashes send()'s JSON.parse before a status
  // assertion is ever reached.
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, ...over });
    await next();
  });
  app.route("/", crudRouter(r));
  return app;
}

const send = async (
  app: Hono<App>,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
) => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    })
  );
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null };
};

/**
 * A row that satisfies the table's NOT NULLs and nothing more. Hand-writing one
 * per resource would mean the loop below stops covering new resources the day
 * someone adds one, which is precisely when it is needed.
 */
function fillerRow(r: Resource, id: string, marker: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id, tenantId: ctx.tenantId };
  for (const [key, col] of Object.entries(columnsOf(r))) {
    if (key === "id" || key === "tenantId" || (!col.notNull && !(r.secretColumns ?? []).includes(key))) continue;
    if (col.hasDefault && !(r.secretColumns ?? []).includes(key)) continue;
    row[key] =
      col.dataType === "number"
        ? NOW
        : col.dataType === "boolean"
          ? false
          : (r.secretColumns ?? []).includes(key)
            ? marker
            : key.endsWith("Json")
              ? "{}"
              : `x_${key}`;
  }
  return row;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "test", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

describe("secret columns never reach a read response", () => {
  // Not "is it declared" — a declaration checked against a broken map passes.
  // The row is written with a known value and every read surface is searched for
  // the column name and for the value itself.
  const declaring = () => all().filter(({ r }) => (r.secretColumns ?? []).length);

  it("covers the credential tables", () => {
    expect(declaring().map(({ module, r }) => `${module}/${r.path}`).sort()).toEqual([
      "core/api-keys",
      "core/users",
      "core/webhooks",
      "orbit/channel-connectors"
    ]);
  });

  for (const { module, r } of Object.entries(BY_MODULE).flatMap(([m, rs]) =>
    rs.filter((x) => (x.secretColumns ?? []).length).map((x) => ({ module: m, r: x }))
  )) {
    it(`${module}/${r.path}: list and record hide ${(r.secretColumns ?? []).join(", ")}`, async () => {
      // No "secret"/"hash" in the id: the assertions below are substring checks.
      const rowId = `${r.idPrefix}_leakcheck`;
      const marker = "SECRET-MARKER-DO-NOT-LEAK";
      await ctx.db.insert(r.table).values(fillerRow(r, rowId, marker) as never);

      const app = router(r);
      for (const path of ["/", `/${rowId}`]) {
        const res = await send(app, "GET", path);
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(marker);
        for (const key of r.secretColumns ?? []) expect(res.text).not.toContain(key);
      }

      // ...and the audit before/after images, which are themselves readable
      // through `core/audit-log`.
      const editable = Object.entries(columnsOf(r)).find(
        ([key, col]) =>
          col.dataType === "string" &&
          !key.endsWith("Json") &&
          !["id", "tenantId"].includes(key) &&
          !(r.secretColumns ?? []).includes(key)
      );
      if (r.perms.update && !r.immutable && editable) {
        const patched = await send(app, "PATCH", `/${rowId}`, { [editable[0]]: "x_patched" });
        expect(patched.status).toBe(200);
        expect(patched.text).not.toContain(marker);
        const audits = await ctx.db.select().from(schema.auditLog);
        expect(JSON.stringify(audits)).not.toContain(marker);
      }
    });
  }
});

/* --------------------------------------------- ledger money tables (docs/19) */

const ledgerResource = (path: string): Resource => {
  const r = BY_MODULE.ledger?.find((x) => x.path === path);
  if (!r) throw new Error(`no ledger/${path} resource`);
  return r;
};

describe("ledger txns and payments are read-only through generic CRUD", () => {
  // CLAUDE.md §12: money moves through POST /v1/ledger/txn/:type — a state
  // machine, idempotency key and balanced journal. A generated create that
  // accepts client-supplied `state` and `grossMinor` is a second, unguarded
  // mint for money rows.
  it("txns declares no write permission", () => {
    const r = ledgerResource("txns");
    expect(r.perms.create).toBeUndefined();
    expect(r.perms.update).toBeUndefined();
    expect(r.perms.remove).toBeUndefined();
  });

  it("payments declares no write permission", () => {
    const r = ledgerResource("payments");
    expect(r.perms.create).toBeUndefined();
    expect(r.perms.update).toBeUndefined();
    expect(r.perms.remove).toBeUndefined();
  });

  it("POST /txns and POST /payments do not exist as routes", async () => {
    const txn = await send(router(ledgerResource("txns")), "POST", "/", {
      type: "BIND",
      idempotencyKey: "raw-mint",
      state: "settled",
      actorKind: "user",
      actorId: "u_test",
      currency: "AED",
      baseCurrency: "AED",
      grossMinor: 1_000_00
    });
    expect(txn.status).toBe(404);
    const pay = await send(router(ledgerResource("payments")), "POST", "/", {
      direction: "in",
      method: "bank",
      amountMinor: 1_000_00,
      currency: "AED",
      state: "settled"
    });
    expect(pay.status).toBe(404);
  });
});

describe("money columns in the generated shape", () => {
  const invoices = () => router(ledgerResource("invoices"));
  const invoice = (n: number, over: Record<string, unknown> = {}) => ({
    number: `INV-SHAPE-${n}`,
    customerRef: "cus_shape",
    subtotalMinor: 1000,
    totalMinor: 1000,
    currency: "AED",
    linesJson: {},
    ...over
  });

  it("refuses a negative minor amount", async () => {
    const res = await send(invoices(), "POST", "/", invoice(1, { subtotalMinor: -1000, totalMinor: -1000 }));
    expect(res.status).toBe(400);
  });

  it("refuses a fractional minor amount", async () => {
    const res = await send(invoices(), "POST", "/", invoice(2, { totalMinor: 10.5 }));
    expect(res.status).toBe(400);
  });

  it("still accepts a negative value on a declared signed column (recon delta)", async () => {
    await ctx.db.insert(schema.ledgerReconMatches).values({
      id: "rcm_signed",
      tenantId: ctx.tenantId,
      runId: "rcr_x",
      amountMinor: 5000,
      currency: "AED",
      method: "tolerance",
      createdAt: NOW
    });
    const res = await send(router(ledgerResource("recon-matches")), "PATCH", "/rcm_signed", { deltaMinor: -180 });
    expect(res.status).toBe(200);
    expect(res.body.deltaMinor).toBe(-180);
  });
});

describe("timestamp columns in the generated shape", () => {
  // Regression: `z.number().int()` is a *safe*-integer check, so the generated
  // shape let through (8.64e15, 9.007e15] — instants no `Date` can hold. AXIS
  // bounded them at its own FNOL endpoints, but `axisPolicies`/`axisClaims` are
  // also registered on this generic router with `update`, so
  // `PATCH /v1/axis/policies/:id {"endAt": 9e15}` walked straight past that
  // bound and persisted a value every downstream renderer throws on.
  const policies = (): Resource => {
    const r = BY_MODULE.axis?.find((x) => x.path === "policies");
    if (!r) throw new Error("no axis/policies resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_instant",
      tenantId: ctx.tenantId,
      customerId: "cus_instant",
      providerId: "prv_instant",
      policyNo: "POL-INSTANT",
      startAt: NOW,
      endAt: NOW,
      premiumMinor: 1000,
      currency: "AED",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  });

  const endAtOf = async (): Promise<number | undefined> => {
    const [row] = await ctx.db
      .select()
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.id, "pol_instant"));
    return row?.endAt;
  };

  it("refuses an *At past the end of the Date range", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_instant", { endAt: 9e15 });
    expect(res.status).toBe(400);
    expect(await endAtOf()).toBe(NOW);
  });

  it("refuses an *At past the start of the Date range", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_instant", { endAt: -9e15 });
    expect(res.status).toBe(400);
    expect(await endAtOf()).toBe(NOW);
  });

  it("still accepts an instant a Date can hold", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_instant", { endAt: NOW + 86_400_000 });
    expect(res.status).toBe(200);
    expect(await endAtOf()).toBe(NOW + 86_400_000);
  });
});

describe("payment plans in the generated shape", () => {
  // The generated shape validates a `*Json` column as "an object, an array, or
  // a string" and stops there, so `axis_policies.payment_plan_json` — the
  // schedule the lapse sweep reads to decide whether cover ends unpaid
  // (engines/axis-lifecycle.ts) — was writable as anything at all. A plan the
  // sweep cannot parse is not a loud failure: `missedInstalment` fails open, so
  // lapse-on-missed silently stops applying and the policy stays on risk.
  const policies = (): Resource => {
    const r = BY_MODULE.axis?.find((x) => x.path === "policies");
    if (!r) throw new Error("no axis/policies resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_plan",
      tenantId: ctx.tenantId,
      customerId: "cus_plan",
      providerId: "prv_plan",
      policyNo: "POL-PLAN",
      startAt: NOW,
      endAt: NOW,
      premiumMinor: 1000,
      currency: "AED",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  });

  const planOf = async (): Promise<string | null | undefined> => {
    const [row] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, "pol_plan"));
    return row?.paymentPlanJson;
  };

  it("refuses a plan the lapse sweep cannot read", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", {
      paymentPlanJson: { lapseOnMissed: true, instalments: [{ seq: "one", dueAt: "next month", state: "due" }] }
    });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  it("refuses a plan that is not a plan at all", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", { paymentPlanJson: [1, 2, 3] });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  // The doc comment on `PaymentPlanJson` said the `dueAt` bound "belongs on the
  // write door (apps/api/src/resources.ts)" — and the write door validated with
  // the same unbounded shape, so the bound existed nowhere at all.
  it("refuses an instalment due past the end of the Date range", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", {
      paymentPlanJson: { lapseOnMissed: true, instalments: [{ seq: 1, dueAt: 9e15, state: "due" }] }
    });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  // Every field defaults, so a plan-shaped-but-not-a-plan object parsed clean
  // and stored as `lapseOnMissed: false` — a "validated" plan that quietly
  // switched the lapse sweep off, while the 400 message promised the opposite.
  it("refuses an object that is not a plan rather than defaulting it", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", { paymentPlanJson: { foo: "bar" } });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  it("refuses an unknown key on an instalment", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", {
      paymentPlanJson: { lapseOnMissed: true, instalments: [{ seq: 1, dueAt: NOW, state: "due", paid: true }] }
    });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  // The sweep filters `state !== "paid" && state !== "waived"`, so a plan
  // stored with `"Paid"` reads as unpaid and lapses cover on a customer who
  // paid — through a PATCH that needs only `axis:policies:update`.
  it("refuses an instalment state the sweep would read as unpaid", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", {
      paymentPlanJson: { lapseOnMissed: true, instalments: [{ seq: 1, dueAt: NOW, state: "Paid" }] }
    });
    expect(res.status).toBe(400);
    expect(await planOf()).toBeNull();
  });

  // `graceDays` defaults to 0 in the write shape, and the default only reaches
  // the column if the normalised parse is what gets stored.
  it("stores the normalised plan, not the raw body", async () => {
    const res = await send(router(policies()), "PATCH", "/pol_plan", {
      paymentPlanJson: { lapseOnMissed: true, instalments: [{ seq: 1, dueAt: NOW, state: "due" }] }
    });
    expect(res.status).toBe(200);
    expect(JSON.parse((await planOf()) as string).graceDays).toBe(0);
  });

  it("accepts a plan the sweep can read", async () => {
    const plan = { graceDays: 7, lapseOnMissed: true, instalments: [{ seq: 1, dueAt: NOW, state: "due" }] };
    const res = await send(router(policies()), "PATCH", "/pol_plan", { paymentPlanJson: plan });
    expect(res.status).toBe(200);
    expect(JSON.parse((await planOf()) as string)).toEqual(plan);
  });
});

describe("effective-dating columns in the generated shape", () => {
  // `dist/offerings` gates its updates on `dist.offering_publish`; the gate is
  // cleared the way a tenant clears it, by putting the key on its own
  // `autoApprove` allowlist, so the 400 below is the instant bound and nothing
  // else.
  const autoApproved: Partial<Ctx> = { policy: PolicyJson.parse({ autoApprove: ["dist.offering_publish"] }) };

  // The `*At` bound above missed the other name the schema uses for an instant.
  // `dist/offerings` is registered read-write, so
  // `PATCH /v1/dist/offerings/:id {"effectiveFrom": 9e15}` returned 200 and
  // persisted — and apps/web's product detail renders it through
  // `<DateTime>`, which calls `toISOString()` on the resulting Invalid Date and
  // takes the page down for that tenant with a RangeError.
  const offerings = (): Resource => {
    const r = BY_MODULE.dist?.find((x) => x.path === "offerings");
    if (!r) throw new Error("no dist/offerings resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.distOfferings).values({
      id: "off_instant",
      tenantId: ctx.tenantId,
      productId: "prd_instant",
      providerId: "prv_instant",
      code: "OFF-INSTANT",
      nameJson: JSON.stringify({ en: "Instant" }),
      currency: "AED",
      effectiveFrom: NOW,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  });

  const effectiveFromOf = async (): Promise<number | undefined> => {
    const [row] = await ctx.db.select().from(schema.distOfferings).where(eq(schema.distOfferings.id, "off_instant"));
    return row?.effectiveFrom;
  };

  it("refuses an effectiveFrom past the end of the Date range", async () => {
    const res = await send(router(offerings(), autoApproved), "PATCH", "/off_instant", { effectiveFrom: 9e15 });
    expect(res.status).toBe(400);
    expect(await effectiveFromOf()).toBe(NOW);
  });

  it("still accepts an effectiveFrom a Date can hold", async () => {
    const res = await send(router(offerings(), autoApproved), "PATCH", "/off_instant", { effectiveFrom: NOW + 86_400_000 });
    expect(res.status).toBe(200);
    expect(await effectiveFromOf()).toBe(NOW + 86_400_000);
  });
});

describe("expiry columns in the generated shape", () => {
  // The third name the schema uses for an instant, and the one two review
  // rounds waved through on the claim that no registered read-write resource
  // carried it. `core/mandates` and `core/memories` are `ru("core:settings")`
  // (read + create/update/remove) and `core/consents` is creatable, so
  // `PATCH /v1/core/mandates/:id {"expiry": 9e15}` fell through `shapeOf` to a
  // plain `z.number().int()`, persisted, and reached
  // `packages/ui/src/format.tsx` `<DateTime>` — `toISOString()` on an Invalid
  // Date, RangeError, page down.
  const mandates = (): Resource => {
    const r = BY_MODULE.core?.find((x) => x.path === "mandates");
    if (!r) throw new Error("no core/mandates resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.mandates).values({
      id: "mnd_instant",
      tenantId: ctx.tenantId,
      principalRef: "customer:cus_instant",
      agentIdentity: "agent:test",
      scopeJson: JSON.stringify({ purchase: true }),
      expiry: NOW,
      createdAt: NOW
    } as never);
  });

  const expiryOf = async (): Promise<number | null | undefined> => {
    const [row] = await ctx.db.select().from(schema.mandates).where(eq(schema.mandates.id, "mnd_instant"));
    return row?.expiry;
  };

  it("refuses an expiry past the end of the Date range", async () => {
    const res = await send(router(mandates()), "PATCH", "/mnd_instant", { expiry: 9e15 });
    expect(res.status).toBe(400);
    expect(await expiryOf()).toBe(NOW);
  });

  it("refuses an expiry past the start of the Date range", async () => {
    const res = await send(router(mandates()), "PATCH", "/mnd_instant", { expiry: -9e15 });
    expect(res.status).toBe(400);
    expect(await expiryOf()).toBe(NOW);
  });

  it("still accepts an expiry a Date can hold", async () => {
    const res = await send(router(mandates()), "PATCH", "/mnd_instant", { expiry: NOW + 86_400_000 });
    expect(res.status).toBe(200);
    expect(await expiryOf()).toBe(NOW + 86_400_000);
  });
});

describe("instant columns named outside the four rules", () => {
  // The `isInstantKey` census claimed none of the seven off-rule instant columns
  // sat on a writable resource. Two do: `signal/aeo-pages` is `rw("signal:aeo")`
  // (resources.ts:608 — create + update + remove) and `signal/budget-moves`
  // takes `update` (resources.ts:604). So `freshness` and `reversibleUntil` fell
  // through `shapeOf` to a plain `z.number().int()` — a *safe*-integer check,
  // which lets (8.64e15, 9.007e15] through — and persisted an instant no `Date`
  // can hold. Both render through the guarded `<DateTime>` today, so the hole
  // was open rather than bleeding; it is closed at the write door here.
  const resource = (module: string, path: string): Resource => {
    const r = BY_MODULE[module]?.find((x) => x.path === path);
    if (!r) throw new Error(`no ${module}/${path} resource`);
    return r;
  };

  // `signal/budget-moves` gates its update on `signal.budget_move`; cleared the
  // way a tenant clears it, so the 400 below is the instant bound and nothing else.
  const autoApproved: Partial<Ctx> = {
    policy: PolicyJson.parse({ autoApprove: ["signal.budget_move"] })
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.signalAeoPages).values({
      id: "aeo_instant",
      tenantId: ctx.tenantId,
      queryCluster: "motor-renewal",
      contentRef: "cnt_instant",
      freshness: NOW,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
    await ctx.db.insert(schema.signalBudgetMoves).values({
      id: "bmv_instant",
      tenantId: ctx.tenantId,
      fromRef: "camp_a",
      toRef: "camp_b",
      amountMinor: 5000,
      currency: "AED",
      reason: "underspend",
      approvedBy: "auto",
      reversibleUntil: NOW,
      ts: NOW
    } as never);
  });

  const freshnessOf = async (): Promise<number | null | undefined> => {
    const [row] = await ctx.db.select().from(schema.signalAeoPages).where(eq(schema.signalAeoPages.id, "aeo_instant"));
    return row?.freshness;
  };
  const reversibleUntilOf = async (): Promise<number | undefined> => {
    const [row] = await ctx.db
      .select()
      .from(schema.signalBudgetMoves)
      .where(eq(schema.signalBudgetMoves.id, "bmv_instant"));
    return row?.reversibleUntil;
  };

  it("refuses a freshness past the end of the Date range", async () => {
    const res = await send(router(resource("signal", "aeo-pages")), "PATCH", "/aeo_instant", { freshness: 9e15 });
    expect(res.status).toBe(400);
    expect(await freshnessOf()).toBe(NOW);
  });

  it("still accepts a freshness a Date can hold", async () => {
    const res = await send(router(resource("signal", "aeo-pages")), "PATCH", "/aeo_instant", {
      freshness: NOW + 86_400_000
    });
    expect(res.status).toBe(200);
    expect(await freshnessOf()).toBe(NOW + 86_400_000);
  });

  it("refuses a reversibleUntil past the end of the Date range", async () => {
    const res = await send(router(resource("signal", "budget-moves"), autoApproved), "PATCH", "/bmv_instant", {
      reversibleUntil: 9e15
    });
    expect(res.status).toBe(400);
    expect(await reversibleUntilOf()).toBe(NOW);
  });

  it("still accepts a reversibleUntil a Date can hold", async () => {
    const res = await send(router(resource("signal", "budget-moves"), autoApproved), "PATCH", "/bmv_instant", {
      reversibleUntil: NOW + 86_400_000
    });
    expect(res.status).toBe(200);
    expect(await reversibleUntilOf()).toBe(NOW + 86_400_000);
  });
});

describe("invoice state machine through generic CRUD", () => {
  const invoices = () => router(ledgerResource("invoices"));
  const create = async (n: number, over: Record<string, unknown> = {}) => {
    const res = await send(invoices(), "POST", "/", {
      number: `INV-FLOW-${n}`,
      customerRef: "cus_flow",
      subtotalMinor: 1000,
      totalMinor: 1000,
      currency: "AED",
      linesJson: {},
      ...over
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; state: string };
  };

  it("a client cannot mint an already-paid invoice", async () => {
    const row = await create(1, { state: "paid" });
    expect(row.state).toBe("draft");
  });

  it("draft cannot jump straight to paid", async () => {
    const row = await create(2);
    const res = await send(invoices(), "PATCH", `/${row.id}`, { state: "paid" });
    expect(res.status).toBe(400);
  });

  it("draft -> issued -> paid walks the legal path", async () => {
    const row = await create(3);
    const issued = await send(invoices(), "PATCH", `/${row.id}`, { state: "issued" });
    expect(issued.status).toBe(200);
    expect(issued.body.state).toBe("issued");
    const paid = await send(invoices(), "PATCH", `/${row.id}`, { state: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body.state).toBe("paid");
  });

  it("a paid invoice cannot be reopened to draft, and void is terminal", async () => {
    const paidRow = await create(4);
    await send(invoices(), "PATCH", `/${paidRow.id}`, { state: "issued" });
    await send(invoices(), "PATCH", `/${paidRow.id}`, { state: "paid" });
    expect((await send(invoices(), "PATCH", `/${paidRow.id}`, { state: "draft" })).status).toBe(400);

    const voidRow = await create(5);
    expect((await send(invoices(), "PATCH", `/${voidRow.id}`, { state: "void" })).status).toBe(200);
    expect((await send(invoices(), "PATCH", `/${voidRow.id}`, { state: "issued" })).status).toBe(400);
  });
});

describe("a back-dated subscription does not back-bill", () => {
  it("defaults next_invoice_at to the current period, not to a start date in the past", async () => {
    const subs = router(ledgerResource("subscriptions"));
    const startAt = NOW - 200 * 24 * 60 * 60 * 1000;
    const res = await send(subs, "POST", "/", {
      customerRef: "cus_backdated",
      plan: "growth",
      priceMinor: 20_000,
      currency: "AED",
      interval: "month",
      startAt,
      state: "active"
    });
    expect(res.status).toBe(201);
    // The billing sweep invoices every period from next_invoice_at up to the
    // clock, so defaulting this to a term that started six months ago raises six
    // months of invoices on the next tick — for periods a migration of existing
    // customers has already billed by hand. The row is due now, once.
    expect(res.body.nextInvoiceAt).toBeGreaterThanOrEqual(NOW);
  });
});

/* ------------------------------------------------------------ notifications */

describe("notifications are visible to their addressee only", () => {
  // The hand-written inbox (routes/me.ts) filters on userId = actor; the CRUD
  // list must agree or any reader lists every user's notifications tenant-wide.
  const resource = (): Resource => {
    const r = BY_MODULE.core?.find((x) => x.path === "notifications");
    if (!r) throw new Error("no core/notifications resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.notifications).values([
      { id: "ntf_mine", tenantId: ctx.tenantId, userId: "u_test", kind: "chip", titleKey: "t.mine", createdAt: NOW },
      { id: "ntf_theirs", tenantId: ctx.tenantId, userId: "u_other", kind: "chip", titleKey: "t.theirs", createdAt: NOW }
    ]);
  });

  it("lists only the acting user's notifications", async () => {
    const res = await send(router(resource()), "GET", "/");
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((n) => n.id);
    expect(ids).toContain("ntf_mine");
    expect(ids).not.toContain("ntf_theirs");
  });

  it("404s another user's notification by id", async () => {
    const app = router(resource());
    expect((await send(app, "GET", "/ntf_mine")).status).toBe(200);
    expect((await send(app, "GET", "/ntf_theirs")).status).toBe(404);
  });
});

describe("rowVisible", () => {
  // No production resource declares one yet (the analytics predicates are not
  // exported — see the report), so the seam is proved on a synthetic resource:
  // what matters is that all four generated paths agree about one hidden row.
  const teams: Resource = {
    path: "visible-teams",
    table: schema.teams,
    idPrefix: "tm",
    module: "core",
    perms: { read: "core:teams:read", create: "core:teams:write", update: "core:teams:write", remove: "core:teams:write" },
    rowVisible: (_ctx, row) => row.name !== "hidden"
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.teams).values([
      { id: "tm_seen", tenantId: "t_test", name: "seen", createdAt: NOW },
      { id: "tm_hidden", tenantId: "t_test", name: "hidden", createdAt: NOW }
    ]);
  });

  it("hides the row from the list", async () => {
    const res = await send(router(teams), "GET", "/");
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((t) => t.id)).toEqual(["tm_seen"]);
  });

  it("answers 404 — not 403 — on the row's id, so the list and the record agree", async () => {
    const app = router(teams);
    expect((await send(app, "GET", "/tm_seen")).status).toBe(200);
    expect((await send(app, "GET", "/tm_hidden")).status).toBe(404);
  });

  it("refuses to update or delete a row the caller cannot see", async () => {
    const app = router(teams);
    expect((await send(app, "PATCH", "/tm_hidden", { name: "mine now" })).status).toBe(404);
    expect((await send(app, "DELETE", "/tm_hidden")).status).toBe(404);
    const rows = await ctx.db.select().from(schema.teams);
    expect(rows.find((t) => t.id === "tm_hidden")?.name).toBe("hidden");
  });
});

describe("scout/data-products: ROLE-028 hides drafts and suspended products from read-only viewers", () => {
  const resource = () => {
    const r = BY_MODULE.scout?.find((x) => x.path === "data-products");
    if (!r) throw new Error("no scout/data-products resource");
    return r;
  };
  // provider.viewer: scout:data_products:read only, no :publish.
  const viewer: Ctx["actor"] = {
    kind: "user",
    id: "u_provider_viewer",
    tenantId: "t_test",
    grants: [{ roleKey: "provider.viewer", permissions: ["scout:data_products:read", "scout:panel_bench:read"] }]
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.scoutDataProducts).values([
      {
        id: "dtp_draft",
        tenantId: "t_test",
        name: "draft product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "draft",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "dtp_published",
        tenantId: "t_test",
        name: "published product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "published",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "dtp_suspended",
        tenantId: "t_test",
        name: "suspended product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "suspended",
        createdAt: NOW,
        updatedAt: NOW
      }
    ]);
  });

  it("a provider.viewer only sees the published product in the list", async () => {
    const app = router(resource(), { actor: viewer });
    const res = await send(app, "GET", "/");
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((p) => p.id)).toEqual(["dtp_published"]);
  });

  it("a provider.viewer gets 404, not the row, for a draft or suspended product by id", async () => {
    const app = router(resource(), { actor: viewer });
    expect((await send(app, "GET", "/dtp_published")).status).toBe(200);
    expect((await send(app, "GET", "/dtp_draft")).status).toBe(404);
    expect((await send(app, "GET", "/dtp_suspended")).status).toBe(404);
  });

  it("a publisher (scout:data_products:publish) still sees drafts — they author them", async () => {
    const publisher: Ctx["actor"] = {
      kind: "user",
      id: "u_scout_lead",
      tenantId: "t_test",
      grants: [{ roleKey: "scout.admin", permissions: ["scout:*:*"] }]
    };
    const res = await send(router(resource(), { actor: publisher }), "GET", "/dtp_draft");
    expect(res.status).toBe(200);
  });
});

describe("scout/data-products: ROLE-028 scopes provider.viewer to its own provider's subscriptions", () => {
  const resource = () => {
    const r = BY_MODULE.scout?.find((x) => x.path === "data-products");
    if (!r) throw new Error("no scout/data-products resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.scoutDataProducts).values([
      {
        id: "dtp_falcon_only",
        tenantId: "t_test",
        name: "falcon-only product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "published",
        subscribersJson: JSON.stringify([{ providerId: "prv_falcon", since: NOW - 1 }]),
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "dtp_cedar_only",
        tenantId: "t_test",
        name: "cedar-only product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "published",
        subscribersJson: JSON.stringify([{ providerId: "prv_cedar", since: NOW - 1 }]),
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "dtp_no_subscribers",
        tenantId: "t_test",
        name: "unassigned product",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "published",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "dtp_falcon_suspended",
        tenantId: "t_test",
        name: "falcon subscription suspended",
        definitionJson: "{}",
        consentBasis: "contract",
        status: "published",
        subscribersJson: JSON.stringify([{ providerId: "prv_falcon", since: NOW - 10, suspendedAt: NOW - 1 }]),
        createdAt: NOW,
        updatedAt: NOW
      }
    ]);
  });

  const falconViewer: Ctx["actor"] = {
    kind: "user",
    id: "u_falcon_viewer",
    tenantId: "t_test",
    grants: [
      {
        roleKey: "provider.viewer",
        permissions: ["scout:data_products:read", "scout:panel_bench:read"],
        scope: { providerIds: ["prv_falcon"] }
      }
    ]
  };

  it("only sees published products its own provider subscribed to", async () => {
    const res = await send(router(resource(), { actor: falconViewer }), "GET", "/");
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((p) => p.id)).toEqual(["dtp_falcon_only"]);
  });

  it("gets 404, not the row, for a published product another provider subscribed to", async () => {
    const res = await send(router(resource(), { actor: falconViewer }), "GET", "/dtp_cedar_only");
    expect(res.status).toBe(404);
  });

  it("gets 404 for a published product where its own subscription was suspended", async () => {
    const res = await send(router(resource(), { actor: falconViewer }), "GET", "/dtp_falcon_suspended");
    expect(res.status).toBe(404);
  });

  it("a provider.viewer with no providerId recorded keeps the pre-existing published-only view (no lockout)", async () => {
    const unassignedViewer: Ctx["actor"] = {
      kind: "user",
      id: "u_provider_viewer",
      tenantId: "t_test",
      grants: [{ roleKey: "provider.viewer", permissions: ["scout:data_products:read", "scout:panel_bench:read"] }]
    };
    const res = await send(router(resource(), { actor: unassignedViewer }), "GET", "/");
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((p) => p.id).sort()).toEqual([
      "dtp_cedar_only",
      "dtp_falcon_only",
      "dtp_falcon_suspended",
      "dtp_no_subscribers",
      "dtp_published"
    ]);
  });
});

describe("scout negotiation pack: provider.viewer cannot download LYRA's own negotiation prep", () => {
  // scout:panel_bench:read is held by provider.viewer too (rbac.ts), and the
  // pack bakes every provider's price index/win-rate into one PDF — so the
  // route must gate on a permission provider.viewer does not hold, not on
  // panel_bench:read. See routes/scout.ts's negotiation-pack handler.
  const scoutApp = (over: Partial<Ctx> = {}): Hono<App> => {
    const app = new Hono<App>();
    app.onError(onError);
    app.notFound((c) => onError(notFound(c.req.path), c));
    app.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, ...over });
      await next();
    });
    app.route("/", scoutRoutes);
    return app;
  };

  it("a provider.viewer (panel_bench:read, no whitespaces:promote) is refused", async () => {
    const viewer: Ctx["actor"] = {
      kind: "user",
      id: "u_provider_viewer",
      tenantId: "t_test",
      grants: [{ roleKey: "provider.viewer", permissions: ["scout:data_products:read", "scout:panel_bench:read"] }]
    };
    const res = await send(scoutApp({ actor: viewer }), "GET", "/panel-bench/negotiation-pack");
    expect(res.status).toBe(403);
  });

  it("scout.lead (scout:whitespaces:promote) still gets the PDF", async () => {
    const lead: Ctx["actor"] = {
      kind: "user",
      id: "u_scout_lead",
      tenantId: "t_test",
      grants: [{ roleKey: "scout.lead", permissions: ["scout:panel_bench:read", "scout:whitespaces:promote"] }]
    };
    // A PDF response, not JSON — send()'s JSON.parse would choke on it.
    const res = await scoutApp({ actor: lead }).fetch(
      new Request("http://api.test/panel-bench/negotiation-pack")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("scout whitespace promotion goes through the approval engine, not a bare PATCH", () => {
  // docs/modules/scout.md §4: "whitespace approvals (promote/park)" — a PATCH
  // to status must raise (and require deciding) a scout.whitespace_promote
  // approval, same as offerings' publish gate.
  const resource = () => {
    const r = BY_MODULE.scout?.find((x) => x.path === "whitespaces");
    if (!r) throw new Error("no scout/whitespaces resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.scoutWhitespaces).values({
      id: "wsp_gate",
      tenantId: "t_test",
      description: "underinsured fleets, 20-49 vehicles",
      status: "candidate",
      createdAt: NOW,
      updatedAt: NOW
    });
  });

  it("refuses the first PATCH with approval_required and leaves the row unchanged", async () => {
    const res = await send(router(resource()), "PATCH", "/wsp_gate", { status: "validated" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("scout.whitespace_promote");
    expect(res.body.approval_id).toBeTruthy();

    const [row] = await ctx.db.select().from(schema.scoutWhitespaces).where(eq(schema.scoutWhitespaces.id, "wsp_gate"));
    expect(row?.status).toBe("candidate");
  });

  it("promotes once the approval is decided", async () => {
    const first = await send(router(resource()), "PATCH", "/wsp_gate", { status: "validated" });
    const approvalId = first.body.approval_id as string;
    await decide(ctx, approvalId, "approved");

    const res = await send(router(resource()), "PATCH", "/wsp_gate", { status: "validated" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
  });
});

describe("generic CRUD PATCH honours idempotency-key (regression: IMPORTANT 4/5)", () => {
  // The PATCH/PUT handler is shared by every REGISTRY resource, so this is
  // platform-wide: a client retrying a dropped response must get back the
  // row it already produced, not a second write or a spurious 409.
  const resource = () => {
    const r = BY_MODULE.axis?.find((x) => x.path === "cases");
    if (!r) throw new Error("no axis/cases resource");
    return r;
  };

  beforeAll(async () => {
    await ctx.db.insert(schema.axisCases).values({
      id: "cas_idem",
      tenantId: "t_test",
      ref: "CAS-IDEM",
      kind: "claim",
      status: "review",
      priority: "normal",
      source: "web",
      createdAt: NOW,
      updatedAt: NOW
    });
  });

  it("replays the same 200 instead of double-applying the update", async () => {
    const key = "idem-case-patch";
    const first = await send(router(resource()), "PATCH", "/cas_idem", { priority: "high" }, { "idempotency-key": key });
    expect(first.status).toBe(200);
    expect(first.body.priority).toBe("high");

    const replay = await send(router(resource()), "PATCH", "/cas_idem", { priority: "high" }, { "idempotency-key": key });
    expect(replay.status).toBe(200);
    expect(replay.body.updatedAt).toBe(first.body.updatedAt);

    const rows = await ctx.db.select().from(schema.axisCases).where(eq(schema.axisCases.id, "cas_idem"));
    expect(rows[0]?.priority).toBe("high");
  });

  it("409s a repeated key sent with a different body", async () => {
    const key = "idem-case-patch-conflict";
    const first = await send(router(resource()), "PATCH", "/cas_idem", { priority: "low" }, { "idempotency-key": key });
    expect(first.status).toBe(200);
    const conflict = await send(router(resource()), "PATCH", "/cas_idem", { priority: "urgent" }, { "idempotency-key": key });
    expect(conflict.status).toBe(409);
  });
});

describe("north briefings are not generically creatable", () => {
  // docs/modules/north.md §2.2: every numeric claim in a briefing is machine-
  // verified against the metric layer inside engines/narrator.ts's
  // generateBriefing(). A generic create would let anyone holding
  // north:briefings:generate POST an arbitrary narrativeRef straight to
  // "review" with no verification behind it — the real path is POST
  // /v1/north/briefings/generate (routes/north.ts).
  const resource = () => {
    const r = BY_MODULE.north?.find((x) => x.path === "briefings");
    if (!r) throw new Error("no north/briefings resource");
    return r;
  };

  it("declares no create permission", () => {
    expect(resource().perms.create).toBeUndefined();
  });

  it("POST /briefings does not exist as a route", async () => {
    const res = await send(router(resource()), "POST", "/", {
      date: "2026-01-06",
      audience: "exec",
      locale: "en",
      narrativeRef: "everything is fine, trust me",
      status: "review",
      generatedBy: "ai",
      approvedBy: "u_test"
    });
    expect(res.status).toBe(404);
  });
});

describe("core/roles: a role editor cannot define authority they do not hold", () => {
  // The hole this reproduces: `user-roles` guards *assigning* a role, but
  // `roles` guarded nothing, so `core:roles:update` alone was `*:*:*` — write
  // the wildcard into a role row, then assign it through the guarded path,
  // which by then passes because the actor legitimately holds it. The guard has
  // to sit on the definition too, and it has to cover the whole resulting set.
  const resource = () => {
    const r = BY_MODULE.core?.find((x) => x.path === "roles");
    if (!r) throw new Error("no core/roles resource");
    return r;
  };

  // Exactly the permissions the permission-matrix screen gates on: enough to
  // edit a role, nothing else.
  const editor = (): Partial<Ctx> => ({
    actor: {
      kind: "user",
      id: "u_editor",
      tenantId: "t_test",
      grants: [{ roleKey: "editor", permissions: ["core:roles:read", "core:roles:update"] }]
    }
  });

  // Only the client-writable columns: shapeOf() is strict, and id/tenantId/
  // createdAt are server-owned, so sending them is a 400 before the guard runs.
  const body = (key: string, permissionsJson: string) => ({
    key,
    name: `role ${key}`,
    permissionsJson,
    system: false
  });

  const seed = (id: string, key: string, permissionsJson: string) =>
    ctx.db.insert(schema.roles).values({ id, tenantId: "t_test", key, name: `role ${key}`, permissionsJson, system: false, createdAt: NOW });

  it("refuses to create a role carrying permissions the editor lacks", async () => {
    const res = await send(router(resource(), editor()), "POST", "/", body("escalated", JSON.stringify(["*:*:*"])));
    expect(res.status).toBe(403);
  });

  it("refuses to widen an existing role beyond what the editor holds", async () => {
    await seed("rl_widen", "widen_me", JSON.stringify(["core:roles:read"]));
    const res = await send(router(resource(), editor()), "PATCH", "/rl_widen", {
      permissionsJson: JSON.stringify(["ledger:payments:refund"])
    });
    expect(res.status).toBe(403);
  });

  it("refuses an empty permission list on a built-in key, which resolves to that key's bundle", async () => {
    // bundleOf falls back to the compiled table when the stored array is empty,
    // so `[]` on `tenant.admin` is not "a role with no authority" — it is
    // core:*:* — and must not slip past by looking harmless.
    const res = await send(
      router(resource(), editor()),
      "POST",
      "/",
      body("tenant.admin", JSON.stringify([]))
    );
    expect(res.status).toBe(403);
  });

  it("allows a role whose permissions the editor already holds", async () => {
    const res = await send(
      router(resource(), editor()),
      "POST",
      "/",
      body("reader_only", JSON.stringify(["core:roles:read"]))
    );
    expect(res.status).toBe(201);
  });

  it("leaves an edit that does not touch permissions alone", async () => {
    await seed("rl_rename", "rename_me", JSON.stringify(["*:*:*"]));
    const res = await send(router(resource(), editor()), "PATCH", "/rl_rename", { name: "renamed" });
    expect(res.status).toBe(200);
  });
});

/* --------------------------------------- the routing desk, through the API */

// engines/orbit-routing.ts reads teams, members, presence, rules and policies,
// and until these resources existed nothing but the seed could write them: a
// tenant could not build a desk at all. The grants are the point of the test —
// a supervisor runs the roster, an agent only flips their own availability.
describe("orbit routing tables are writable by the roles that own them", () => {
  const asRole = (roleKey: string): Partial<Ctx> => ({
    actor: {
      kind: "user",
      id: "u_role",
      tenantId: "t_test",
      grants: [{ roleKey, permissions: [...permissionsForRole(roleKey)] }]
    }
  });
  const find = (path: string): Resource => BY_MODULE.orbit!.find((r) => r.path === path)!;

  it("lets a lead stand up a team and put an agent on it", async () => {
    const lead = asRole("orbit.lead");
    const team = await send(router(find("teams"), lead), "POST", "/", {
      key: `desk_${NOW}`,
      nameJson: JSON.stringify({ en: "Motor desk", ar: "مكتب المركبات" }),
      isDefault: false
    });
    expect(team.status).toBe(201);

    const member = await send(router(find("team-members"), lead), "POST", "/", {
      teamId: team.body.id,
      userId: "u_sara",
      skillsJson: JSON.stringify(["motor"])
    });
    expect(member.status).toBe(201);
    expect(member.body.maxConcurrent).toBe(5); // the cap the router honours
  });

  it("lets an agent mark themselves available but not rewrite the roster", async () => {
    const agent = asRole("orbit.agent");
    const presence = await send(router(find("agent-presence"), agent), "POST", "/", {
      userId: "u_sara",
      status: "available"
    });
    expect(presence.status).toBe(201);

    const team = await send(router(find("teams"), agent), "POST", "/", {
      key: `nope_${NOW}`,
      nameJson: "{}"
    });
    expect(team.status).toBe(403);
  });
});

/**
 * docs/27 F27. `POLICY_TRANSITIONS` and `CLAIM_TRANSITIONS` (@lyra/core
 * lifecycle.ts) are enforced by the dedicated engines — `transitionClaim`,
 * `axis-lifecycle.ts` — and by nothing on the generic CRUD door, which is a
 * second writable path around the same contract. The AXIS workspace's own
 * `editable` spec offers `status` as a select (apps/web/app/modules/axis.ts),
 * so a desk could PATCH a freshly reported claim straight to `settled`, or
 * reopen a cancelled policy, with no hop check, no per-hop permission, no
 * transaction and no step on the audit trail.
 *
 * `invoices` above already enforces its machine here, and `complaints` and
 * `siu-referrals` do it in resources.ts with a `beforeWrite` — so this is the
 * pattern being applied, not a new one being invented.
 */
describe("AXIS state machines through generic CRUD (docs/27 F27)", () => {
  const claims = () => {
    const r = BY_MODULE.axis?.find((x) => x.path === "claims");
    if (!r) throw new Error("no axis/claims resource");
    return router(r);
  };
  const policies = () => {
    const r = BY_MODULE.axis?.find((x) => x.path === "policies");
    if (!r) throw new Error("no axis/policies resource");
    return router(r);
  };

  const claimRow = async (id: string) => {
    const [row] = await ctx.db.select().from(schema.axisClaims).where(eq(schema.axisClaims.id, id));
    return row;
  };
  const policyRow = async (id: string) => {
    const [row] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, id));
    return row;
  };

  /**
   * Every PATCH on a claim is gated by `axis.claim_settlement`, which is
   * `neverAutoApprove`, so a test about the machine grants the decision the
   * test is not about. `beforeWrite` runs before the gate (crud.ts), so an
   * illegal hop is refused without spending one.
   */
  let grantSeq = 0;
  async function grantClaimPatch(id: string): Promise<void> {
    await ctx.db.insert(schema.approvals).values({
      id: `apr_flow_${++grantSeq}`,
      tenantId: ctx.tenantId,
      subjectRef: `claims:${id}`,
      policyKey: "axis.claim_settlement",
      module: "axis",
      requestedBy: "user:tester",
      requestedAt: NOW,
      decidedBy: "user:approver",
      decision: "approved",
      reason: "test fixture",
      contextJson: JSON.stringify({ amountMinor: 10_000_00 }),
      decidedAt: NOW,
      delegationId: null
    } as never);
  }

  async function seedClaim(id: string, status: string): Promise<void> {
    await ctx.db.insert(schema.axisClaims).values({
      id,
      tenantId: ctx.tenantId,
      policyId: "pol_flow",
      customerId: "cus_flow",
      claimNo: `CLM-${id}`,
      reportedAt: NOW,
      currency: "AED",
      status,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  }

  async function seedPolicy(id: string, status: string): Promise<void> {
    await ctx.db.insert(schema.axisPolicies).values({
      id,
      tenantId: ctx.tenantId,
      customerId: "cus_flow",
      providerId: "prv_flow",
      policyNo: `POL-${id}`,
      startAt: NOW,
      endAt: NOW,
      premiumMinor: 1000,
      currency: "AED",
      status,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  }

  it("a reported claim cannot be PATCHed straight to settled", async () => {
    await seedClaim("clm_flow_1", "reported");
    const res = await send(claims(), "PATCH", "/clm_flow_1", { status: "settled" });
    expect(res.status).toBe(400);
    expect((await claimRow("clm_flow_1"))?.status).toBe("reported");
  });

  it("settling and settled are refused here whatever the current state", async () => {
    // Money owns both states (engines/axis-claims.ts `settlementTarget`), so
    // the CRUD door may not hand them out even from `approved`, where the
    // machine does allow the hop.
    await seedClaim("clm_flow_2", "approved");
    for (const status of ["settling", "settled"]) {
      const res = await send(claims(), "PATCH", "/clm_flow_2", { status });
      expect(res.status, `${status} was accepted`).toBe(400);
      expect(String(res.body?.detail ?? res.body?.title)).toMatch(/payment/i);
    }
    expect((await claimRow("clm_flow_2"))?.status).toBe("approved");
  });

  it("a legal hop still passes, and an unknown state is refused", async () => {
    await seedClaim("clm_flow_3", "reported");
    await grantClaimPatch("clm_flow_3");
    expect((await send(claims(), "PATCH", "/clm_flow_3", { status: "triage" })).status).toBe(200);
    expect((await claimRow("clm_flow_3"))?.status).toBe("triage");

    const bogus = await send(claims(), "PATCH", "/clm_flow_3", { status: "nearly_settled" });
    expect(bogus.status).toBe(400);
    expect((await claimRow("clm_flow_3"))?.status).toBe("triage");
  });

  it("a PATCH that does not touch status is unaffected", async () => {
    await seedClaim("clm_flow_4", "assessing");
    await grantClaimPatch("clm_flow_4");
    const res = await send(claims(), "PATCH", "/clm_flow_4", { assessorRef: "assessor:ahmed" });
    expect(res.status).toBe(200);
    expect((await claimRow("clm_flow_4"))?.status).toBe("assessing");
  });

  it("a cancelled policy is terminal, and active -> cancelled still works", async () => {
    await seedPolicy("pol_flow_1", "cancelled");
    expect((await send(policies(), "PATCH", "/pol_flow_1", { status: "active" })).status).toBe(400);
    expect((await policyRow("pol_flow_1"))?.status).toBe("cancelled");

    await seedPolicy("pol_flow_2", "active");
    expect((await send(policies(), "PATCH", "/pol_flow_2", { status: "cancelled" })).status).toBe(200);
    expect((await policyRow("pol_flow_2"))?.status).toBe("cancelled");
  });

  it("a policy cannot be minted straight into a state it has to be walked to", async () => {
    await seedPolicy("pol_flow_3", "bound");
    expect((await send(policies(), "PATCH", "/pol_flow_3", { status: "renewed" })).status).toBe(400);
    expect((await policyRow("pol_flow_3"))?.status).toBe("bound");
  });
});
