import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx } from "@lyra/core";
import { aletheiaLearnUrl, ingestAletheia } from "./aletheia-ingest.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: {
      kind: "user",
      id: "u_1",
      tenantId: "t_1",
      grants: [{ roleKey: "north.analyst", permissions: permissionsForRole("north.analyst") }]
    },
    requestId: "req_1",
    now: 1_700_000_000_000,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

afterEach(() => vi.unstubAllGlobals());

describe("aletheiaLearnUrl", () => {
  it("is null without ALETHEIA_URL", () => {
    expect(aletheiaLearnUrl({}, "t_1")).toBeNull();
  });

  it("builds the per-tenant learn endpoint", () => {
    expect(aletheiaLearnUrl({ ALETHEIA_URL: "http://cortex0:8000/" }, "t_1")).toBe(
      "http://cortex0:8000/api/t_1/learn"
    );
  });
});

describe("ingestAletheia", () => {
  it("is a no-op when Aletheia is not configured", async () => {
    await expect(ingestAletheia(ctx, {})).resolves.toBeNull();
  });

  it("posts one flat series per metric key, grand-total rows only, in period order", async () => {
    await ctx.db.insert(schema.northSnapshots).values([
      { id: "s1", tenantId: "t_1", metricKey: "gwp", grain: "day", period: "2026-01-04", dimsHash: "", value: 100, ts: 1 },
      { id: "s2", tenantId: "t_1", metricKey: "gwp", grain: "day", period: "2026-01-05", dimsHash: "", value: 120, ts: 2 },
      { id: "s3", tenantId: "t_1", metricKey: "policies_issued", grain: "day", period: "2026-01-05", dimsHash: "", value: 3, ts: 3 },
      // A dimensional split is not a benchmark to learn — excluded.
      { id: "s4", tenantId: "t_1", metricKey: "gwp", grain: "day", period: "2026-01-05", dimsHash: "motor", value: 99, ts: 4 }
    ]);

    const calls: { url: string; body: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: String(init?.body ?? ""),
          auth: (init?.headers as Record<string, string>)["authorization"] ?? null
        });
        return new Response("{}", { status: 200 });
      }
    );

    const result = await ingestAletheia(ctx, { ALETHEIA_URL: "http://cortex0:8000", ALETHEIA_TOKEN: "tok" });
    expect(result).toEqual({ pushed: 2, samples: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://cortex0:8000/api/t_1/learn");
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.body)).toEqual({ gwp: [100, 120], policies_issued: [3] });
  });

  it("fails loudly on a non-2xx so the cron records it", async () => {
    await ctx.db.insert(schema.northSnapshots).values([
      { id: "s5", tenantId: "t_1", metricKey: "gwp", grain: "day", period: "2026-01-06", dimsHash: "", value: 100, ts: 1 }
    ]);
    vi.stubGlobal("fetch", async () => new Response("tenant unknown", { status: 404 }));
    await expect(ingestAletheia(ctx, { ALETHEIA_URL: "http://cortex0:8000" })).rejects.toThrow(/404/);
  });
});
