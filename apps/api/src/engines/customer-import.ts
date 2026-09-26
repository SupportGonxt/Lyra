import { and, eq, isNull, like } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, emit, type Ctx } from "@lyra/core";
import { parseCsv, type RowError } from "./axis-case-import.js";

// @accept:SA. People from a CSV, so a module bought alone — SIGNAL most of all —
// has someone to work with. Consent is not a column: it is evidence of what a
// person agreed to (docs/12), recorded by recordConsent, never asserted by a
// spreadsheet. An imported person is therefore reachable only once consented.

export interface CustomerImportResult {
  created: number;
  updated: number;
  errors: RowError[];
}

const EMAIL = /^[^\s@",;]+@[^\s@",;]+\.[^\s@",;]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

const tagsOf = (v: string | undefined): string[] => [...new Set((v ?? "").split(";").map((t) => t.trim()).filter(Boolean))];

export async function importCustomers(ctx: Ctx, csv: string): Promise<CustomerImportResult> {
  const { header, rows, parseErrors } = parseCsv(csv);
  if (!header.includes("name") && !parseErrors.length) return { created: 0, updated: 0, errors: [{ line: 1, ref: null, error: "missing column name" }] };
  const out: CustomerImportResult = { created: 0, updated: 0, errors: [...parseErrors] };
  if (!header.includes("name")) return out;
  const locales = ctx.policy.locales;

  for (const { line, cells } of rows) {
    const fail = (error: string) => out.errors.push({ line, ref: cells.email || cells.name || null, error });
    const name = (cells.name ?? "").trim();
    const email = (cells.email ?? "").trim().toLowerCase();
    const phone = (cells.phone ?? "").trim();
    const locale = (cells.locale ?? "").trim() || ctx.policy.defaultLocale;
    const type = (cells.type ?? "").trim() || "person";
    if (!name) { fail("name is required"); continue; }
    if (email && !EMAIL.test(email)) { fail("email is not an address"); continue; }
    if (phone && !PHONE.test(phone)) { fail("phone is not a number"); continue; }
    if (!locales.includes(locale)) { fail(`locale must be one of ${locales.join(", ")}`); continue; }
    if (type !== "person" && type !== "business") { fail("type must be person or business"); continue; }
    const tags = tagsOf(cells.tags);

    const [held] = email
      ? await ctx.db
          .select({ id: schema.customers.id, tagsJson: schema.customers.tagsJson })
          .from(schema.customers)
          .where(and(eq(schema.customers.tenantId, ctx.tenantId), isNull(schema.customers.deletedAt), like(schema.customers.emailsJson, `%"${email}"%`)))
          .limit(1)
      : [];
    if (held) {
      const merged = [...new Set([...(JSON.parse(held.tagsJson ?? "[]") as string[]), ...tags])];
      await ctx.db.update(schema.customers).set({ tagsJson: JSON.stringify(merged), updatedAt: ctx.now }).where(eq(schema.customers.id, held.id));
      out.updated++;
      continue;
    }
    const id = newId("cu", ctx.now);
    await ctx.db.insert(schema.customers).values({
      id,
      tenantId: ctx.tenantId,
      type,
      nameJson: JSON.stringify({ en: name }),
      emailsJson: email ? JSON.stringify([email]) : null,
      phonesJson: phone ? JSON.stringify([phone]) : null,
      tagsJson: tags.length ? JSON.stringify(tags) : null,
      locale,
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    // The same announcement a one-at-a-time create makes (crud.ts), so SIGNAL's
    // prospects and ORBIT's journeys cannot tell the two apart.
    await emit(ctx, { module: "core", type: "core.customers.created", subject: id, data: { id } });
    out.created++;
  }
  await audit(ctx, { action: "core.customers.import", subjectRef: "customers", after: { created: out.created, updated: out.updated, errors: out.errors.length } });
  return out;
}
