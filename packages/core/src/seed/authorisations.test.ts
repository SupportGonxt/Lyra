import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { seed } from "../seed.js";
import { MARKETS, PRODUCT_LINES, REGULATORS, productLineOf, type ProductLineKey } from "../operating-model.js";
import type { CoreDb } from "../context.js";

// ADR-0125. `REGULATORS` quotes two real licence numbers and, before this
// register, nothing in production read the file: a fresh tenant held no
// authorisation at all and the bind seam had nothing to refuse against.
//
// Same DB harness as the sibling seed tests: an in-memory libSQL db with the
// real migrations replayed.
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");
const T0 = Date.UTC(2026, 0, 6, 8, 0, 0);

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let db: CoreDb;
let tenantId: string;

beforeEach(async () => {
  const client: Client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;
  tenantId = (await seed(db, { password: "authorisations-test-password-2026", now: T0 })).tenantId;
});

const rows = () => db.select().from(schema.axisAuthorisations).where(eq(schema.axisAuthorisations.tenantId, tenantId));

describe("seedAuthorisations", () => {
  it("holds the two licences the client publishes, and invents no third", async () => {
    const seeded = await rows();
    expect(seeded.map((r) => r.licenceNumber).sort()).toEqual(["20", "BRK-00045"]);
    // The population is the regulators that have a number on file, not a
    // hand-written pair: a third regulator with a number would appear here, and
    // one without a number must not.
    expect(seeded).toHaveLength(REGULATORS.filter((r) => r.licenceNumber).length);
  });

  it("takes the market from MARKETS rather than stating a second list", async () => {
    const seeded = await rows();
    // Both known regulators are licensed by the same market, and every row's
    // market is one that names that regulator.
    expect([...new Set(seeded.map((r) => r.market))]).toEqual(["AE"]);
    for (const row of seeded) {
      const market = MARKETS.find((m) => m.code === row.market);
      expect(market?.regulators, row.regulatorKey).toContain(row.regulatorKey);
    }
  });

  it("carries each regulator's own scope, not a restated one", async () => {
    const byKey = new Map(REGULATORS.map((r) => [r.key, r]));
    for (const row of await rows()) {
      expect(row.scope).toBe(byKey.get(row.regulatorKey)?.scope);
    }
  });

  it("derives the covered lines from the operating model, so motor is covered by the broking licence", async () => {
    const seeded = await rows();
    const centralBank = seeded.find((r) => r.regulatorKey === "ae_central_bank");
    const dha = seeded.find((r) => r.regulatorKey === "dha");
    const linesOf = (json: string) => JSON.parse(json) as ProductLineKey[];

    // Every derived line really does point back at this regulator...
    for (const row of seeded) {
      for (const line of linesOf(row.productLinesJson)) {
        expect(PRODUCT_LINES[line], line).toBeDefined();
      }
    }
    // ...and the two the bind seam depends on are there: the motor desk sells
    // `car_insurance`, health intermediation is the DHA's whole purpose.
    expect(linesOf(centralBank!.productLinesJson)).toContain("car_insurance");
    expect(linesOf(dha!.productLinesJson)).toContain("health_insurance");
    expect(linesOf(dha!.productLinesJson)).not.toContain("car_insurance");

    // The bridge the register depends on: the catalogue's `motor` is the
    // model's `car_insurance`, and a line the model does not name answers null.
    expect(productLineOf("motor")).toBe("car_insurance");
    expect(linesOf(centralBank!.productLinesJson)).toContain(productLineOf("motor"));
  });

  it("records it as active with no expiry on file rather than an invented one", async () => {
    for (const row of await rows()) {
      expect(row.status).toBe("active");
      expect(row.validTo).toBeNull();
      expect(row.validFrom).toBe(T0);
    }
  });
});
