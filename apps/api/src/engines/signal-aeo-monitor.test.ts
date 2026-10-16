import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { openFields, permissionsForRole, sealFields, type Ctx } from "@lyra/core";
import {
  AEO_TRANSPORT,
  aeoAssistants,
  aeoWeeks,
  citedBy,
  citedDomains,
  domainOf,
  sampleAeoCitations,
  urlsIn,
  weekStart,
  type AskAssistant
} from "./signal-aeo-monitor.js";

// docs/modules/signal.md §2.4 / §4.5 and J-M3 ("citation share trend over 8
// weeks"). The KPI the whole AEO effort is judged by had no sampler: the only
// writer of a citation in the repository was the demo seed, so every real
// tenant read 0%. These tests hold the two halves that make it a measurement —
// a citation is matched against *our* domains and nobody else's, and a week with
// no sample is not a week of zero citations.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-encryption-secret";
const NOW = Date.parse("2026-10-01T06:00:00Z");
const TENANT = "t_1";
const WEEK = 7 * 86_400_000;

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const open = (sealed: string) => openFields(FIELD_KEY, JSON.parse(sealed) as Record<string, string>);

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "system", id: "scheduler", tenantId: TENANT, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function assistant(config: Record<string, unknown> = { baseUrl: "https://api.example/v1", model: "gpt-4o-mini", domains: ["nxt.ae"] }) {
  await ctx.db.insert(schema.orbitChannelConnectors).values({
    id: "con_aeo",
    tenantId: TENANT,
    provider: "openai-compatible",
    transport: AEO_TRANSPORT,
    label: "ChatGPT",
    secretsJson: JSON.stringify(await sealFields(FIELD_KEY, { apiKey: "sk-test" }, ["apiKey"])),
    configJson: JSON.stringify(config),
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function page(id: string, queryCluster: string, over: Partial<{ status: string; locale: string; freshness: number }> = {}) {
  await ctx.db.insert(schema.signalAeoPages).values({
    id,
    tenantId: TENANT,
    queryCluster,
    locale: over.locale ?? "en",
    contentRef: `content/${id}.md`,
    status: over.status ?? "published",
    freshness: over.freshness ?? NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("reading citations out of an answer", () => {
  it("takes every absolute URL, once, in order, without trailing punctuation", () => {
    expect(urlsIn("See https://nxt.ae/quote, and https://www.insurer.ae/x. Also https://nxt.ae/quote again.")).toEqual([
      "https://nxt.ae/quote",
      "https://www.insurer.ae/x"
    ]);
  });

  it("reads a host and drops www", () => {
    expect(domainOf("https://www.nxt.ae/quote")).toBe("nxt.ae");
    expect(domainOf("https://quotes.nxt.ae")).toBe("quotes.nxt.ae");
    expect(domainOf("not a url")).toBeNull();
  });

  it("counts our domain and our subdomains as ours", () => {
    expect(citedBy(["https://nxt.ae/a"], ["nxt.ae"])).toBe(true);
    expect(citedBy(["https://www.nxt.ae/a"], ["nxt.ae"])).toBe(true);
    expect(citedBy(["https://quotes.nxt.ae/a"], ["nxt.ae"])).toBe(true);
  });

  it("does not mistake a lookalike domain for a citation", () => {
    // `notnxt.ae` ends with the letters but not on a dot boundary.
    expect(citedBy(["https://notnxt.ae/a"], ["nxt.ae"])).toBe(false);
    expect(citedBy(["https://nxt.ae.evil.com/a"], ["nxt.ae"])).toBe(false);
    expect(citedBy(["https://insurer.ae/a"], ["nxt.ae"])).toBe(false);
  });

  it("names who the answer did cite", () => {
    expect(citedDomains(["https://a.ae/1", "https://www.b.ae/2", "https://a.ae/3"])).toEqual(["a.ae", "b.ae"]);
  });

  it("buckets an instant into the Monday of its ISO week", () => {
    expect(weekStart(Date.parse("2026-10-01T06:00:00Z"))).toBe("2026-09-28");
    expect(weekStart(Date.parse("2026-09-28T00:00:00Z"))).toBe("2026-09-28");
    // Sunday belongs to the week that began six days earlier, not the next one.
    expect(weekStart(Date.parse("2026-10-04T23:00:00Z"))).toBe("2026-09-28");
  });
});

describe("sampleAeoCitations", () => {
  const answering = (answer: { text: string; citations: string[] }): AskAssistant => async () => answer;

  it("does nothing at all when the tenant has no assistant connected", async () => {
    await page("aep_1", "how much is car insurance in dubai");
    const summary = await sampleAeoCitations(ctx, open, answering({ text: "…", citations: [] }));
    expect(summary).toEqual({ assistants: 0, queries: 0, sampled: 0, cited: 0, errors: [] });
    expect(await ctx.db.select().from(schema.signalAeoCitations)).toHaveLength(0);
  });

  it("records one observation per query per assistant, and counts the citation", async () => {
    await assistant();
    await page("aep_1", "how much is car insurance in dubai");
    await page("aep_2", "cheapest health cover uae");

    const summary = await sampleAeoCitations(
      ctx,
      open,
      answering({ text: "Nine insurers… https://nxt.ae/motor", citations: ["https://nxt.ae/motor"] })
    );

    expect(summary).toMatchObject({ assistants: 1, queries: 2, sampled: 2, cited: 2, errors: [] });
    const rows = await ctx.db.select().from(schema.signalAeoCitations);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.pageId)).toEqual(["aep_2", "aep_1"]); // stalest/id first: a stable sample
    for (const row of rows) {
      expect(row).toMatchObject({ assistant: "ChatGPT", cited: true });
      expect(JSON.parse(row.citedDomainsJson!)).toEqual(["nxt.ae"]);
    }
  });

  it("records a miss as a miss rather than skipping the query", async () => {
    await assistant();
    await page("aep_1", "how much is car insurance in dubai");
    const summary = await sampleAeoCitations(
      ctx,
      open,
      answering({ text: "…", citations: ["https://notnxt.ae/", "https://insurer.ae/x"] })
    );
    expect(summary).toMatchObject({ sampled: 1, cited: 0 });
    const [row] = await ctx.db.select().from(schema.signalAeoCitations);
    expect(row).toMatchObject({ cited: false });
    // Who took the box is kept, so the board can name them.
    expect(JSON.parse(row!.citedDomainsJson!)).toEqual(["notnxt.ae", "insurer.ae"]);
  });

  it("leaves drafts out of the sample", async () => {
    await assistant();
    await page("aep_draft", "an unpublished question", { status: "draft" });
    const summary = await sampleAeoCitations(ctx, open, answering({ text: "…", citations: [] }));
    expect(summary.queries).toBe(0);
  });

  it("keeps asking after one query fails", async () => {
    await assistant();
    await page("aep_1", "first query");
    await page("aep_2", "second query");
    let call = 0;
    const flaky: AskAssistant = async () => {
      call += 1;
      if (call === 1) throw new Error("assistant 502");
      return { text: "… https://nxt.ae/x", citations: ["https://nxt.ae/x"] };
    };

    const summary = await sampleAeoCitations(ctx, open, flaky);
    expect(summary.sampled).toBe(1);
    expect(summary.errors).toEqual(["ChatGPT: assistant 502"]);
    expect(await ctx.db.select().from(schema.signalAeoCitations)).toHaveLength(1);
  });

  it("audits the sample, and the citation when one was earned", async () => {
    await assistant();
    await page("aep_1", "how much is car insurance in dubai");
    await sampleAeoCitations(ctx, open, answering({ text: "…", citations: ["https://nxt.ae/motor"] }));

    const actions = (await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT))).map((r) => r.action);
    expect(actions).toContain("signal.aeo.sampled");
    expect(actions).toContain("signal.aeo.cited");
  });

  it("ignores a connector that is not configured well enough to ask", async () => {
    // Missing the domains: the monitor would have nothing to score against.
    await assistant({ baseUrl: "https://api.example/v1", model: "gpt-4o-mini" });
    await page("aep_1", "how much is car insurance in dubai");
    expect(await aeoAssistants(ctx, open)).toEqual([]);
  });

  it("ignores an inactive connector", async () => {
    await assistant();
    await ctx.db.update(schema.orbitChannelConnectors).set({ status: "paused" }).where(eq(schema.orbitChannelConnectors.id, "con_aeo"));
    await page("aep_1", "how much is car insurance in dubai");
    expect((await sampleAeoCitations(ctx, open, answering({ text: "…", citations: [] }))).assistants).toBe(0);
  });
});

describe("aeoWeeks", () => {
  it("reports a share per week and null for a week nobody sampled", async () => {
    await assistant();
    await page("aep_1", "query");
    const rows = [
      { at: NOW, cited: true },
      { at: NOW - WEEK, cited: false },
      { at: NOW - 2 * WEEK, cited: true },
      { at: NOW - 4 * WEEK, cited: true } // week -3 is deliberately empty
    ];
    for (const [i, r] of rows.entries()) {
      await ctx.db.insert(schema.signalAeoCitations).values({
        id: `aec_${i}`,
        tenantId: TENANT,
        pageId: "aep_1",
        query: "query",
        locale: "en",
        assistant: "ChatGPT",
        cited: r.cited,
        citedDomainsJson: "[]",
        sampledAt: r.at
      });
    }

    const weeks = await aeoWeeks(ctx, 8);
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toMatchObject({ sampled: 1, cited: 1, share: 1 });
    expect(weeks[6]).toMatchObject({ sampled: 1, cited: 0, share: 0 });
    expect(weeks[5]).toMatchObject({ sampled: 1, cited: 1, share: 1 });
    // Nobody asked that week — not a collapse to zero.
    expect(weeks[4]).toMatchObject({ sampled: 0, cited: 0, share: null });
  });
});
