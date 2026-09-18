import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./ids.js";
export * from "./json.js";
export { VIEWS, viewSql } from "./views.js";
export * from "./tx.js";
export * from "./chart-of-accounts.js";
export * from "./tax-rulepack.js";
export * from "./policy-versions.js";
export * from "./claim-reserves.js";

/** Cloud home: D1. The on-prem twin uses `@lyra/db/libsql` — same schema object. */
export function makeDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type Db = ReturnType<typeof makeDb>;
