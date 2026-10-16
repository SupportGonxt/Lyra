import { eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import type { SeedContext } from "./context.js";
import type { CoreDb } from "../context.js";
import {
  MARKETS,
  PRODUCT_LINES,
  REGULATORS,
  regulatorsForProductLine,
  type ProductLineKey
} from "../operating-model.js";

// ADR-0125. `MARKETS` and `REGULATORS` (../operating-model.ts) hold the two
// licence numbers the client publishes and nothing read them: AXIS could place a
// risk anywhere and record nowhere which licence it was placed under. A tenant
// provisioned from this seed holds both, so the register is populated the day
// the workspace opens rather than the day somebody remembers to type them in.
//
// Nothing here is re-typed. A row is built from the definitions themselves —
// the licence number, the scope and the market all come off `REGULATORS` and
// `MARKETS`, and the covered lines are **derived** from
// `regulatorsForProductLine` rather than written out, so a line whose scope
// changes moves this register with it.

export async function seedAuthorisations(ctx: SeedContext): Promise<void> {
  const { db, now, tenantId } = ctx;
  const rows: (typeof schema.axisAuthorisations.$inferInsert)[] = [];
  let n = 0;

  for (const regulator of REGULATORS) {
    // A regulator with no number on file is a definition, not an authorisation.
    // CLAUDE.md forbids inventing one, so it seeds nothing — the same absence the
    // `licenceNumber: null` states, carried to the register.
    if (!regulator.licenceNumber) continue;

    // Which market(s) this regulator licenses is `MARKETS`' own statement, not a
    // second list typed here.
    for (const market of MARKETS.filter((m) => m.regulators.includes(regulator.key))) {
      const lines = (Object.keys(PRODUCT_LINES) as ProductLineKey[]).filter((line) =>
        regulatorsForProductLine(line).some((r) => r.key === regulator.key)
      );

      rows.push({
        id: id("aut", now + n++),
        tenantId,
        market: market.code,
        regulatorKey: regulator.key,
        licenceNumber: regulator.licenceNumber,
        scope: regulator.scope,
        productLinesJson: JSON.stringify(lines),
        // When the platform recorded it. `REGULATORS` states no effective date
        // and an invented one would be a regulatory claim; `validTo` is null
        // because no expiry is on file, which is not the same as never expiring
        // and is what a renewal PATCHes.
        validFrom: now,
        validTo: null,
        evidenceFileId: null,
        status: "active",
        createdAt: now,
        updatedAt: now
      });
    }
  }

  if (rows.length) await db.insert(schema.axisAuthorisations).values(rows);
}

/**
 * The same register, for a tenant that was provisioned **before** it existed
 * (migration `0057`).
 *
 * This is the eleventh instance of a shape this codebase has hit ten times
 * already, and the resync route's own comments name the others: `PEOPLE` reaches
 * a deployed tenant exactly once, `TAX_RULEPACK` likewise, and of that one the
 * comment says *"the one whose absence is loudest — `taxTreatment()` refuses a
 * supply it has no rule for, so a tenant seeded before the rulepack existed
 * cannot bind at all."*
 *
 * **The authorisation register is louder still, and I created the problem.** It
 * is checked on the bind path, so a tenant seeded before `0057` holds no licence
 * row and **every bind is refused** — not one market's, all of them. Adding the
 * register without this would have turned a missing feature into an outage for
 * every existing tenant, which is exactly the sighting-9 shape: a compiled table
 * read only at provisioning time has a single delivery.
 *
 * Idempotent: it inserts only the (market, regulator) pairs the tenant is
 * missing, so running it twice creates nothing, and it never edits a row an
 * operator has since changed — a licence number corrected by hand is the
 * tenant's statement, not this function's to overwrite.
 */
export async function ensureSeedAuthorisations(
  db: CoreDb,
  tenantId: string,
  opts: { now?: number } = {}
): Promise<{ created: string[] }> {
  const now = opts.now ?? Date.now();
  const existing = await db
    .select({ market: schema.axisAuthorisations.market, regulatorKey: schema.axisAuthorisations.regulatorKey })
    .from(schema.axisAuthorisations)
    .where(eq(schema.axisAuthorisations.tenantId, tenantId));
  const held = new Set(existing.map((row) => `${row.market}:${row.regulatorKey}`));

  const rows: (typeof schema.axisAuthorisations.$inferInsert)[] = [];
  const created: string[] = [];
  let n = 0;
  for (const regulator of REGULATORS) {
    if (!regulator.licenceNumber) continue;
    for (const market of MARKETS.filter((m) => m.regulators.includes(regulator.key))) {
      const key = `${market.code}:${regulator.key}`;
      if (held.has(key)) continue;
      const lines = (Object.keys(PRODUCT_LINES) as ProductLineKey[]).filter((line) =>
        regulatorsForProductLine(line).some((r) => r.key === regulator.key)
      );
      rows.push({
        id: id("aut", now + n++),
        tenantId,
        market: market.code,
        regulatorKey: regulator.key,
        licenceNumber: regulator.licenceNumber,
        scope: regulator.scope,
        productLinesJson: JSON.stringify(lines),
        validFrom: now,
        validTo: null,
        evidenceFileId: null,
        status: "active",
        createdAt: now,
        updatedAt: now
      });
      created.push(key);
    }
  }
  if (rows.length) await db.insert(schema.axisAuthorisations).values(rows);
  return { created };
}
