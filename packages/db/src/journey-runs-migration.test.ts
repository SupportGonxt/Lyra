import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

// 0037 is the first table rebuild in this repo (customer_id loses NOT NULL,
// partner_id arrives). A rebuild copies rows into a new table and drops the old
// one, so the one thing it must never do is lose a run a tenant already has.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function statementsOf(files: string[]): string[] {
  return files
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("migration 0037 (orbit_journey_runs rebuild)", () => {
  it("keeps every existing run and lets a partner run exist beside it", async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const cut = files.findIndex((f) => f.startsWith("0037_"));
    expect(cut).toBeGreaterThan(0);

    const client = createClient({ url: ":memory:" });
    for (const sql of statementsOf(files.slice(0, cut))) await client.execute(sql);
    await client.execute(
      "INSERT INTO orbit_journey_runs (id, tenant_id, journey_id, customer_id, node, state, context_json, next_at, created_at, updated_at) " +
        "VALUES ('jrr_1', 't_1', 'jrn_1', 'cus_1', 'wait_5d', 'waiting', '{\"waitFrom\":\"wait_5d\"}', 42, 1, 2)"
    );

    for (const sql of statementsOf(files.slice(cut))) await client.execute(sql);

    const kept = await client.execute("SELECT * FROM orbit_journey_runs WHERE id = 'jrr_1'");
    expect(kept.rows[0]).toMatchObject({ customer_id: "cus_1", partner_id: null, node: "wait_5d", next_at: 42 });

    await client.execute(
      "INSERT INTO orbit_journey_runs (id, tenant_id, journey_id, partner_id, node, state, created_at, updated_at) " +
        "VALUES ('jrr_2', 't_1', 'jrn_1', 'ptn_1', 'start', 'running', 1, 1)"
    );
    // One run per journey per partner, as there is one per journey per customer.
    await expect(
      client.execute(
        "INSERT INTO orbit_journey_runs (id, tenant_id, journey_id, partner_id, node, state, created_at, updated_at) " +
          "VALUES ('jrr_3', 't_1', 'jrn_1', 'ptn_1', 'start', 'running', 1, 1)"
      )
    ).rejects.toThrow(/UNIQUE/);
  });
});
