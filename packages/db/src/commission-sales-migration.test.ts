import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

// 0040 rebuilds dist_commission_entries so policy_id may be null (ADR-0094: a
// tenant without AXIS earns commission on a confirmed sale, not a policy). A
// rebuild copies every row across, and these rows are money: none may be lost,
// and the one-accrual-per-subject rule must hold for both kinds of subject.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function statementsOf(files: string[]): string[] {
  return files
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const entry = (id: string, policy: string | null, sale: string | null, kind = "new_business") =>
  "INSERT INTO dist_commission_entries (id, tenant_id, policy_id, sale_ref, provider_id, channel_id, kind, premium_minor, gross_commission_minor, net_commission_minor, currency, created_at, updated_at) " +
  `VALUES ('${id}', 't_1', ${policy ? `'${policy}'` : "NULL"}, ${sale ? `'${sale}'` : "NULL"}, 'prv_1', 'chn_1', '${kind}', 100000, 10000, 8000, 'AED', 1, 1)`;

describe("migration 0040 (dist_commission_entries rebuild)", () => {
  it("keeps every accrual, and holds one accrual per policy and per sale", async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const cut = files.findIndex((f) => f.startsWith("0040_"));
    expect(cut).toBeGreaterThan(0);

    const client = createClient({ url: ":memory:" });
    for (const sql of statementsOf(files.slice(0, cut))) await client.execute(sql);
    await client.execute(
      "INSERT INTO dist_commission_entries (id, tenant_id, policy_id, provider_id, channel_id, kind, premium_minor, gross_commission_minor, net_commission_minor, currency, state, created_at, updated_at) " +
        "VALUES ('ce_1', 't_1', 'pol_1', 'prv_1', 'chn_1', 'new_business', 250000, 25000, 20000, 'AED', 'payable', 1, 2)"
    );

    for (const sql of statementsOf(files.slice(cut))) await client.execute(sql);

    const kept = await client.execute("SELECT * FROM dist_commission_entries WHERE id = 'ce_1'");
    expect(kept.rows[0]).toMatchObject({ policy_id: "pol_1", sale_ref: null, gross_commission_minor: 25000, state: "payable" });

    await client.execute(entry("ce_2", null, "qs_1"));
    await expect(client.execute(entry("ce_3", null, "qs_1"))).rejects.toThrow(/UNIQUE/);
    await expect(client.execute(entry("ce_4", "pol_1", null))).rejects.toThrow(/UNIQUE/);
    // A clawback reverses an accrual and is exempt from both rules.
    await client.execute(entry("ce_5", null, "qs_1", "clawback"));
  });
});
