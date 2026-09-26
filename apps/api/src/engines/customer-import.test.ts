import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { importCustomers } from "./customer-import.js";

// @accept:SA — a tenant that bought SIGNAL alone had no way to bring the people
// it markets to: customers came from AXIS cases, ORBIT inbound or one form at a
// time. A CSV is the door. Per-line honest like the other imports; an address
// already held is the same person, so a re-import merges tags, never doubles.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")).map((s) => s.trim()).filter(Boolean)) {
    await client.execute(s);
  }
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

const people = () => ctx.db.select().from(schema.customers).where(eq(schema.customers.tenantId, "t_1"));

describe("importCustomers", () => {
  it("creates a customer per line, announcing each so prospects and journeys hear it", async () => {
    const out = await importCustomers(ctx, "name,email,phone,locale,tags\nSara Ali,sara@x.test,+971500000001,ar,motor;vip\nOmar,,+971500000002,,\n");
    expect(out).toEqual({ created: 2, updated: 0, errors: [] });
    const rows = await people();
    const sara = rows.find((r) => JSON.parse(r.nameJson).en === "Sara Ali")!;
    expect(JSON.parse(sara.emailsJson!)).toEqual(["sara@x.test"]);
    expect(JSON.parse(sara.phonesJson!)).toEqual(["+971500000001"]);
    expect(JSON.parse(sara.tagsJson!)).toEqual(["motor", "vip"]);
    expect(sara.locale).toBe("ar");
    const events = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "core.customers.created"));
    expect(events).toHaveLength(2);
  });

  it("treats a known address as the same person: merges tags, creates nobody", async () => {
    await importCustomers(ctx, "name,email,tags\nSara Ali,sara@x.test,motor\n");
    const out = await importCustomers(ctx, "name,email,tags\nSara A.,SARA@x.test,home;motor\n");
    expect(out).toEqual({ created: 0, updated: 1, errors: [] });
    const rows = await people();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.tagsJson!)).toEqual(["motor", "home"]);
  });

  it("names every line it refused and writes the rest", async () => {
    const out = await importCustomers(ctx, "name,email,locale\n,a@x.test,en\nB,not-an-email,en\nC,c@x.test,fr\nD,d@x.test,en\n");
    expect(out.created).toBe(1);
    expect(out.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(await people()).toHaveLength(1);
  });

  it("refuses a file without a name column before writing anything", async () => {
    expect((await importCustomers(ctx, "email\na@x.test\n")).errors[0]).toMatchObject({ line: 1, error: "missing column name" });
    expect(await people()).toEqual([]);
  });
});
