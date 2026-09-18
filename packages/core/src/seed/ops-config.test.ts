import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { seedOpsConfig } from "./ops-config.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 7, 20, 6, 0, 0);
const TENANT = "t_ops_config";

let client: Client;
let db: CoreDb;

/** A tenant as a deployed database holds it: core rows, no ORBIT desk config. */
async function givenTenant(teamNames: string[] = ["Motor desk", "Health desk", "Retention"]): Promise<void> {
  await db.insert(schema.teams).values(
    teamNames.map((name, i) => ({ id: `tm_${i}`, tenantId: TENANT, name, moduleScope: "axis", createdAt: NOW }))
  );
  await db.insert(schema.users).values(
    ["sara.nasser", "yusuf.karim", "dana.aziz"].map((local, i) => ({
      id: `usr_${i}`,
      tenantId: TENANT,
      email: `${local}@gonxt.ae`,
      name: local,
      createdAt: NOW,
      updatedAt: NOW
    }))
  );
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const stmt of migrationStatements()) await client.execute(stmt);
  db = drizzle(client) as unknown as CoreDb;
});

describe("seedOpsConfig", () => {
  it("writes the five tables the router reads and the two the desk answers from", async () => {
    await givenTenant();
    expect(await seedOpsConfig(db, TENANT, NOW)).toEqual({
      orbit_teams: 2,
      orbit_team_members: 3,
      orbit_agent_presence: 3,
      orbit_sla_policies: 2,
      orbit_routing_rules: 2,
      orbit_kb_articles: 4,
      orbit_macros: 2
    });
  });

  it("writes every knowledge-base article in both languages, published", async () => {
    await givenTenant();
    await seedOpsConfig(db, TENANT, NOW);
    const articles = await db.select().from(schema.orbitKbArticles);
    // One row per (key, locale): retrieval is per-language, so a key with only
    // an English row is an Arabic conversation that can never be deflected.
    const keys = [...new Set(articles.map((a) => a.key))];
    for (const key of keys) {
      expect(articles.filter((a) => a.key === key).map((a) => a.locale).sort()).toEqual(["ar", "en"]);
    }
    expect(articles.every((a) => a.status === "published")).toBe(true);
    // Never embedded here: seeding holds no Vectorize binding, and a vectorId
    // pointing at a vector that was never written is worse than none.
    expect(articles.every((a) => a.vectorId === null)).toBe(true);
  });

  it("writes macros with wording in both languages", async () => {
    await givenTenant();
    await seedOpsConfig(db, TENANT, NOW);
    const macros = await db.select().from(schema.orbitMacros);
    for (const macro of macros) {
      const body = JSON.parse(macro.bodyJson) as Record<string, string>;
      expect(body.en?.length).toBeGreaterThan(0);
      expect(body.ar?.length).toBeGreaterThan(0);
    }
  });

  it("gives the orbit team the id the core team already has", async () => {
    await givenTenant();
    await seedOpsConfig(db, TENANT, NOW);
    const [core] = await db.select().from(schema.teams).where(eq(schema.teams.name, "Motor desk"));
    const [orbit] = await db.select().from(schema.orbitTeams).where(eq(schema.orbitTeams.key, "motor"));
    // Conversations carry team_id from core_teams; the router reads orbit_teams.
    // One id is what keeps both readings of that column true.
    expect(orbit?.id).toBe(core?.id);
    expect(orbit?.isDefault).toBe(true);
  });

  it("ends with a wildcard rule, so nothing sits unrouted", async () => {
    await givenTenant();
    await seedOpsConfig(db, TENANT, NOW);
    const rules = await db
      .select()
      .from(schema.orbitRoutingRules)
      .where(eq(schema.orbitRoutingRules.tenantId, TENANT));
    const last = rules.sort((a, b) => a.seq - b.seq).at(-1);
    expect(last?.conditionsJson).toBe("{}");
  });

  it("writes nothing on a second run", async () => {
    await givenTenant();
    await seedOpsConfig(db, TENANT, NOW);
    expect(await seedOpsConfig(db, TENANT, NOW + 1_000)).toEqual({});
    const members = await db
      .select()
      .from(schema.orbitTeamMembers)
      .where(eq(schema.orbitTeamMembers.tenantId, TENANT));
    expect(members).toHaveLength(3);
  });

  it("tops up only the tables that are empty", async () => {
    await givenTenant();
    await db.insert(schema.orbitSlaPolicies).values({
      id: "slp_existing",
      tenantId: TENANT,
      key: "bespoke",
      frtMinutes: 30,
      resolutionMinutes: 900,
      createdAt: NOW,
      updatedAt: NOW
    });
    const written = await seedOpsConfig(db, TENANT, NOW);
    expect(written.orbit_sla_policies).toBeUndefined();
    expect(written.orbit_teams).toBe(2);
    const policies = await db
      .select()
      .from(schema.orbitSlaPolicies)
      .where(eq(schema.orbitSlaPolicies.tenantId, TENANT));
    expect(policies.map((p) => p.key)).toEqual(["bespoke"]);
  });

  it("names what it could not find rather than minting a team of its own", async () => {
    await givenTenant(["Motor desk"]);
    await expect(seedOpsConfig(db, TENANT, NOW)).rejects.toThrow(/Retention.*found: Motor desk/s);
  });

  it("refuses a tenant whose people are missing", async () => {
    await db.insert(schema.teams).values(
      ["Motor desk", "Retention"].map((name, i) => ({
        id: `tm_${i}`,
        tenantId: TENANT,
        name,
        moduleScope: "axis",
        createdAt: NOW
      }))
    );
    await expect(seedOpsConfig(db, TENANT, NOW)).rejects.toThrow("no user sara.nasser@");
  });
});
