import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed } from "@lyra/core";
import { BY_MODULE } from "./resources.js";

// A seeded journey that triggers on an event nothing emits can never enrol
// anybody; a seeded webhook subscribed to one can never receive anything.
// Both were true of eight seeded names (docs/27, 2026-09-23): `dist.policy.issued`
// where AXIS emits `axis.policy.issued`, `orbit.renewal.raised` which the renewal
// sweep never announced, `ledger.recon.completed` which closing a run never
// said, and five more. Each is a string compared against another string at
// runtime — invisible to the type checker, green in every unit test.
//
// So this guard derives the set of event types the code CAN emit from the
// source (every `emit(…)` call's `type:` and every runTxn `event: { name }`),
// seeds a tenant, and checks every seeded journey trigger and webhook
// subscription against it. Both halves select their own subjects, so both
// partition (CLAUDE.md: "a guard that selects its own subjects must assert that
// it selected all of them"): an emit call whose type the scanner cannot read,
// and a seeded name that matches nothing, each land in a leftover bucket that
// must be empty.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const MIGRATIONS = join(ROOT, "packages", "db", "migrations");
const SOURCE_DIRS = ["apps/api/src", "packages/core/src", "packages/ledger/src", "packages/db/src", "packages/model-gateway/src"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "seed" || entry.name === "node_modules" ? [] : sources(path);
    if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name) || /^seed/.test(entry.name)) return [];
    return [path];
  });
}

/** The balanced `(…)` starting at `open`, quotes and templates respected. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** The expression after `key:` up to the next top-level `,` / `}`. */
function propertyExpr(obj: string, key: string): string | null {
  const m = new RegExp(`(?<![\\w.])${key}\\s*:`).exec(obj);
  // Shorthand `{ type, … }`: the value is the variable of that name.
  if (!m) return new RegExp(`(?<![\\w.])${key}\\s*[,}]`).test(obj) ? key : null;
  let depth = 0;
  let quote: string | null = null;
  const start = m.index + m[0].length;
  for (let i = start; i < obj.length; i++) {
    const ch = obj[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if ((ch === "," || ch === "}") && depth === 0) return obj.slice(start, i).trim();
    else if (ch === "}") depth--;
  }
  return obj.slice(start).trim();
}

const SEGMENT = "[a-z0-9_-]+";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A template like `axis.claim.${to}` as a pattern: each `${…}` is one segment. */
function templatePattern(tpl: string): RegExp {
  const parts = tpl.split(/\$\{[^}]*\}/);
  return new RegExp(`^${parts.map(escape).join(SEGMENT)}$`);
}

interface Emitted {
  literals: Set<string>;
  patterns: { re: RegExp; from: string }[];
  /** emit sites whose type is passed in, keyed by file, with where each name comes from. */
  indirect: string[];
  leftover: string[];
}

/**
 * Emits whose `type` is a parameter. Each names the literals its callers pass,
 * and the guard proves every one of them appears in that file — so the list
 * cannot claim a name the file does not actually carry.
 */
const INDIRECT: Record<string, { reason: string; names: string[] }> = {
  "apps/api/src/engines/onboarding.ts": {
    reason: "moveStep(…, event) — its three callers in this file pass the step event name",
    names: ["core.onboarding.step_completed", "core.onboarding.step_failed", "core.onboarding.step_waived"]
  },
  "apps/api/src/resources.ts": {
    reason: "the renewals resource's afterWrite emits RENEWAL_EVENTS[state]",
    names: ["orbit.renewal.offered", "orbit.renewal.accepted", "orbit.renewal.lost"]
  },
  "packages/core/src/events.ts": {
    reason: "emit() itself: `type: input.type` is the parameter every other site fills",
    names: []
  },
  "packages/ledger/src/txn.ts": {
    reason: "runTxn: `opts.event.name` — every caller's `event: { name }` is scanned separately",
    names: []
  }
};

/** Generic CRUD announces every resource as `${module}.${path}.created|updated|deleted` (crud.ts). */
function crudEvents(): string[] {
  const out: string[] = [];
  for (const [, resources] of Object.entries(BY_MODULE)) {
    for (const r of resources) {
      const name = `${r.module}.${r.path.replace(/\//g, ".")}`;
      if (r.perms.create) out.push(`${name}.created`);
      if (r.perms.update && !r.immutable) out.push(`${name}.updated`);
      if (r.perms.remove && !r.immutable) out.push(`${name}.deleted`);
    }
  }
  return out;
}

function emittedTypes(): Emitted {
  const out: Emitted = { literals: new Set(crudEvents()), patterns: [], indirect: [], leftover: [] };
  for (const dir of SOURCE_DIRS) {
    for (const file of sources(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");

      const reads: string[] = [];
      for (const m of src.matchAll(/(?<![\w.])emit\s*\(/g)) {
        const before = src.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s*$/.test(before)) continue; // the definition, not a call
        reads.push(propertyExpr(balanced(src, m.index + m[0].length - 1), "type") ?? "<no type:>");
      }
      // runTxn's `event: { name }` — the one emit that is configured, not called.
      for (const m of src.matchAll(/event:\s*\{\s*name:/g)) {
        reads.push(propertyExpr(balanced(src, src.indexOf("{", m.index)), "name") ?? "<no name:>");
      }

      for (const expr of reads) {
        const literals = [...expr.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2] ?? "");
        const templates = [...expr.matchAll(/`([^`]*)`/g)].map((x) => x[1] ?? "");
        if (rel === "apps/api/src/crud.ts" && templates.every((t) => t.startsWith("${auditName}."))) {
          continue; // expanded exactly by crudEvents()
        }
        if (literals.length || templates.length) {
          for (const l of literals) out.literals.add(l);
          for (const t of templates) {
            if (t.includes("${")) out.patterns.push({ re: templatePattern(t), from: `${rel}: \`${t}\`` });
            else out.literals.add(t);
          }
          continue;
        }
        const indirect = INDIRECT[rel];
        if (indirect) {
          out.indirect.push(`${rel} (${expr})`);
          for (const n of indirect.names) out.literals.add(n);
          continue;
        }
        out.leftover.push(`${rel}: type: ${expr}`);
      }
    }
  }
  return out;
}

const matches = (e: Emitted, type: string): boolean =>
  e.literals.has(type) || e.patterns.some((p) => p.re.test(type));

/** A webhook subscription pattern: `*`, `module.*`, or an exact type. */
function subscriptionMatches(e: Emitted, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return [...e.literals].some((l) => l.startsWith(prefix)) || e.patterns.some((p) => p.from.includes(prefix));
  }
  return matches(e, pattern);
}

/**
 * Seeded names that are deliberately not an emitted event, each with why.
 * Empty on purpose: every name the seed ships is one the code emits.
 */
const EXCLUDED: Record<string, string> = {};

let database: Db;
let tenantId: string;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  tenantId = (await seed(database as never, {})).tenantId;
}, 120_000);

describe("the emitted-event registry the guard reads", () => {
  const emitted = emittedTypes();

  it("classifies every emit site: a literal, a template, or a named indirect", () => {
    expect(emitted.leftover).toEqual([]);
  });

  it("the indirect list names only literals its file really carries", () => {
    for (const [file, { names }] of Object.entries(INDIRECT)) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const n of names) expect(src.includes(`"${n}"`), `${file} carries ${n}`).toBe(true);
    }
  });

  it("finds the emitters it is meant to read", () => {
    // One per shape, so a scanner that silently stops matching fails here.
    expect(emitted.literals.has("axis.policy.issued")).toBe(true); // literal
    expect(emitted.literals.has("orbit.partner.went_live")).toBe(true); // ternary
    expect(emitted.literals.has("core.consents.created")).toBe(true); // CRUD family
    expect(emitted.patterns.some((p) => p.re.test("axis.claim.settled"))).toBe(true); // template
    expect(emitted.patterns.some((p) => p.re.test("ledger.txn.fx-reval.settled")) || emitted.literals.has("ledger.txn.fx-reval.settled")).toBe(true); // runTxn
  });
});

describe("seeded event names are events the code emits", () => {
  const emitted = emittedTypes();

  it("every seeded journey trigger and wait_for", async () => {
    const journeys = await database.select().from(schema.orbitJourneys).where(eq(schema.orbitJourneys.tenantId, tenantId));
    expect(journeys.length).toBeGreaterThan(0);
    const leftover: string[] = [];
    for (const j of journeys) {
      const graph = JSON.parse(j.graphJson) as { nodes?: { type?: string; on?: string; event?: string }[] };
      for (const node of graph.nodes ?? []) {
        // A `wait_for` names an event the same way a trigger does: one nothing
        // emits parks the run until its ceiling, every time.
        if (node.type !== "trigger" && node.type !== "wait_for") continue;
        const on = (node.type === "trigger" ? node.on : node.event) ?? "<none>";
        if (matches(emitted, on) || EXCLUDED[on]) continue;
        leftover.push(`${j.key} v${j.version}: ${on}`);
      }
    }
    expect(leftover).toEqual([]);
  });

  it("every seeded webhook subscription", async () => {
    const hooks = await database.select().from(schema.webhooks).where(eq(schema.webhooks.tenantId, tenantId));
    expect(hooks.length).toBeGreaterThan(0);
    const leftover: string[] = [];
    for (const h of hooks) {
      for (const pattern of JSON.parse(h.eventTypesJson) as string[]) {
        if (subscriptionMatches(emitted, pattern) || EXCLUDED[pattern]) continue;
        leftover.push(`${h.url}: ${pattern}`);
      }
    }
    expect(leftover).toEqual([]);
  });
});
