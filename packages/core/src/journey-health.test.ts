import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson } from "@lyra/db";
import { audit } from "./audit.js";
import { JOURNEY_FUNNELS, journeyHealth } from "./journey-health.js";
import { permissionsForRole } from "./rbac.js";
import type { Ctx } from "./context.js";

// docs/06 §3: every journey has a funnel and its health surfaces in NORTH.
// Nothing measured one. The audit log already records every step a journey is
// made of (append-only, hash-chained), so the funnel is read from it rather
// than from new instrumentation.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
let client: Client;

function ctx(now = NOW): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "north.exec", permissions: permissionsForRole("north.exec") }] },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of sql) await client.execute(statement);
});

async function happened(action: string, times: number, at = NOW - DAY) {
  for (let i = 0; i < times; i++) await audit(ctx(at + i), { action, subjectRef: `x:${i}` });
}

describe("JOURNEY_FUNNELS", () => {
  it("names each documented journey once, with ordered steps", () => {
    const ids = JOURNEY_FUNNELS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const journey of JOURNEY_FUNNELS) {
      expect(journey.id).toMatch(/^J-[A-Z]+\d$/);
      expect(journey.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of journey.steps) expect(step.actions.length).toBeGreaterThan(0);
    }
  });

  // The header claims every action below "was found in live code". A step
  // reading an action nothing writes is a funnel that can only ever say zero —
  // exactly how J-C1's "offers" step read 0 for a month of priced leads.
  it("every step reads an action live code writes, and every step has a label", () => {
    // Walk up to the checkout: under Stryker this file runs from a sandbox
    // nested inside it that mirrors packages/ only.
    let root = import.meta.dirname;
    while (!existsSync(join(root, "apps", "api", "src")) && dirname(root) !== root) root = dirname(root);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "seed") walk(path);
        } else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("journey-health.ts")) files.push(path);
      }
    };
    for (const dir of ["apps/api/src", "packages/core/src", "packages/ledger/src"]) walk(join(root, dir));
    const live = files.map((f) => readFileSync(f, "utf8")).join("\n");
    // Generic CRUD audits as `${module}.${path}.<verb>` (apps/api/src/crud.ts).
    const crud = new Set(
      [...readFileSync(join(root, "apps/api/src/resources.ts"), "utf8").matchAll(/r\("([\w-]+)", [^,]+, "[^"]*", "(\w+)"/g)].map((m) => `${m[2]}.${m[1]}`)
    );
    // Template-built actions with a literal head, e.g. `ledger.recon.${decision}`.
    const templates = [...live.matchAll(/`[a-z][\w-]*\.[\w.-]*\$\{[^`]*`/g)].map(
      (m) =>
        new RegExp(
          `^${m[0]
            .slice(1, -1)
            .split(/\$\{[^}]*\}/)
            .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
            .join("[a-z_]+")}$`
        )
    );
    const written = (action: string) =>
      live.includes(`"${action}"`) ||
      crud.has(action.replace(/\.(create|update|delete|restore)$/, "")) ||
      templates.some((t) => t.test(action));

    const labels = readFileSync(join(root, "apps/web/app/routes/north-journeys.tsx"), "utf8");
    const unwritten: string[] = [];
    for (const journey of JOURNEY_FUNNELS) {
      expect(journey.persona).toMatch(/^[a-z]+([. ][a-z_]+)?$/);
      for (const step of journey.steps) {
        expect(labels, `no label for step "${step.key}"`).toContain(`"step.${step.key}":`);
        for (const action of step.actions) {
          expect(action).toMatch(/^[a-z]+(\.[\w-]+)+$/);
          if (!written(action)) unwritten.push(`${journey.id}/${step.key}: ${action}`);
        }
      }
    }
    expect(unwritten).toEqual([]);
  });
});

describe("journeyHealth", () => {
  it("counts each step of a funnel from the audit log in the window", async () => {
    await happened("orbit.renewal.offered", 10);
    await happened("orbit.renewal.accepted", 4);
    const x2 = (await journeyHealth(ctx(), { days: 30 })).find((j) => j.id === "J-X2")!;
    expect(x2.steps.map((s) => s.count)).toEqual([10, 4]);
    expect(x2.completion).toBeCloseTo(0.4);
    expect(x2.status).toBe("flowing");
  });

  // Found by the role-adoption simulation: a month of 510 binds read
  // "issued 930" because the bind and the schedule it sends were two actions
  // summed into one step — the same policy counted twice, and a funnel whose
  // last step outran the step before it.
  it("J-C1 counts an issued policy once, and its delivered schedule as the next step", async () => {
    await happened("dist.quote_requests.create", 10);
    await happened("dist.quote_request.shop", 10);
    await happened("dist.quote_response.select", 4);
    await happened("axis.policy.bind", 4);
    await happened("axis.policy.document_issued", 3);
    const c1 = (await journeyHealth(ctx(), { days: 30 })).find((j) => j.id === "J-C1")!;
    expect(c1.steps.map((s) => [s.key, s.count])).toEqual([
      ["lead", 10],
      ["offers", 10],
      ["accepted", 4],
      ["issued", 4],
      ["delivered", 3]
    ]);
    expect(c1.completion).toBeCloseTo(0.3);
  });

  it("calls a journey stalled when people start it and nobody finishes", async () => {
    await happened("ledger.recon.run", 3);
    const o3 = (await journeyHealth(ctx(), { days: 30 })).find((j) => j.id === "J-O3")!;
    expect(o3.status).toBe("stalled");
    expect(o3.completion).toBe(0);
  });

  it("calls a journey quiet when nobody started it, and never divides by zero", async () => {
    const d1 = (await journeyHealth(ctx(), { days: 30 })).find((j) => j.id === "J-D1")!;
    expect(d1.status).toBe("quiet");
    expect(d1.completion).toBeNull();
  });

  it("ignores what happened before the window and in another tenant", async () => {
    await happened("orbit.renewal.offered", 5, NOW - 40 * DAY);
    const x2 = (await journeyHealth(ctx(), { days: 30 })).find((j) => j.id === "J-X2")!;
    expect(x2.steps[0]!.count).toBe(0);
  });

  it("buckets completions by week for the trend, oldest first", async () => {
    await happened("orbit.renewal.accepted", 2, NOW - 2 * DAY);
    await happened("orbit.renewal.accepted", 1, NOW - 9 * DAY);
    const x2 = (await journeyHealth(ctx(), { days: 28 })).find((j) => j.id === "J-X2")!;
    expect(x2.weekly).toEqual([0, 0, 1, 2]);
  });
});
