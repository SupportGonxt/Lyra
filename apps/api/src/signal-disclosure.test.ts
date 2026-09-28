import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, sha256Hex, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// @accept:M4 docs/17 SIG-013 (mandatory disclosures auto-appended per product
// line) and SIG-015 (no creative publishes without passing pre-flight; bypass
// impossible by configuration). ADR-0108.
//
// The wording below is fixture wording. The tenant's compliance team supplies
// the real text — the platform never writes regulatory copy (CLAUDE.md).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };
const WORDING_EN = "FIXTURE-DISCLOSURE-EN: tenant-supplied motor wording.";
const WORDING_EN_V2 = "FIXTURE-DISCLOSURE-EN: tenant-supplied motor wording, revised.";

let env: Env;
let database: Db;
let seeded: SeedResult;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(who: string, method: string, path: string, payload?: unknown): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = (res.headers.get("content-type") ?? "").includes("json") ? await res.text() : "";
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function login(local: string): Promise<string> {
  const first = await app.fetch(
    new Request("http://api.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" })
    }),
    env as never,
    exec as never
  );
  const token = ((await first.json()) as { token: string }).token;
  const verified = await app.fetch(
    new Request("http://api.test/v1/auth/mfa/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) })
    }),
    env as never,
    exec as never
  );
  expect(verified.status).toBe(200);
  return token;
}

async function setPolicy(policy: Record<string, unknown>): Promise<void> {
  await database
    .update(schema.tenants)
    .set({ policyJson: JSON.stringify(policy) })
    .where(eq(schema.tenants.id, seeded.tenantId));
}

async function creativeRow(id: string) {
  const [row] = await database
    .select()
    .from(schema.signalCreatives)
    .where(and(eq(schema.signalCreatives.tenantId, seeded.tenantId), eq(schema.signalCreatives.id, id)));
  return row!;
}

let wordingId: string;

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
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    // Workers AI stubbed at the binding: two lines, so two variants per locale.
    AI: { run: async () => ({ response: "Cover that fits your car.\nQuote in minutes, drive today." }) }
  } as unknown as Env;
  // Publishing is approval-gated (`signal.creative_publish`); the allowlist is
  // the documented way through it, and exactly the configuration SIG-015 says
  // must not reach the disclosure lane.
  await setPolicy({ autoApprove: ["signal.creative_publish"] });
  tokens.signal = await login("noor.jamal");
  tokens.compliance = await login("khalid.rashed");

  const created = ok(
    await call("compliance", "POST", "/v1/compliance/disclosure-wordings", {
      productLine: "motor",
      locale: "en",
      key: "motor_ad",
      wording: WORDING_EN
    }),
    201
  );
  wordingId = created.id;
}, 120_000);

describe("SIG-013: the product line's disclosure is appended to every generated creative", () => {
  it("appends the tenant's wording verbatim and passes pre-flight", async () => {
    const out = ok(
      await call("signal", "POST", "/v1/signal/creatives/generate", {
        kind: "ad",
        brief: "Motor cover for young drivers.",
        productLine: "motor",
        locales: ["en"],
        count: 2
      }),
      201
    );
    expect(out.variants).toHaveLength(2);
    for (const v of out.variants) {
      expect(v.text.endsWith(WORDING_EN)).toBe(true);
      expect(v.complianceStatus).toBe("passed");
      const row = await creativeRow(v.id);
      expect(row.productLine).toBe("motor");
      expect(row.contentRef).toBe(v.text);
      expect(JSON.parse(row.complianceNotesJson!).disclosure).toEqual({ id: wordingId, version: 1, key: "motor_ad" });
    }
  });

  it("soft-flags a product line with no disclosure configured, into the human review lane (ADR-0108)", async () => {
    const out = ok(
      await call("signal", "POST", "/v1/signal/creatives/generate", {
        kind: "ad",
        brief: "Travel cover for the summer.",
        productLine: "travel",
        locales: ["en"],
        count: 1
      }),
      201
    );
    const v = out.variants[0];
    expect(v.complianceStatus).toBe("flagged");
    expect(v.text).toBe("Cover that fits your car.");
    const notes = JSON.parse((await creativeRow(v.id)).complianceNotesJson!);
    expect(notes.lane).toBe("soft_flag");
    expect(notes.findings.map((f: { rule: string }) => f.rule)).toEqual(["disclosure_unconfigured"]);
  });

  it("soft-flags a locale the product line has no wording for, rather than borrowing another language's", async () => {
    const out = ok(
      await call("signal", "POST", "/v1/signal/creatives/generate", {
        kind: "ad",
        brief: "Motor cover.",
        productLine: "motor",
        locales: ["ar"],
        count: 1
      }),
      201
    );
    expect(out.variants[0].complianceStatus).toBe("flagged");
    expect(out.variants[0].text).not.toContain(WORDING_EN);
  });
});

describe("SIG-015: a creative missing its disclosure is hard-blocked, and no configuration lifts it", () => {
  let creativeId: string;

  beforeAll(async () => {
    const out = ok(
      await call("signal", "POST", "/v1/signal/creatives/generate", {
        kind: "ad",
        brief: "Motor cover.",
        productLine: "motor",
        locales: ["en"],
        count: 1
      }),
      201
    );
    creativeId = out.variants[0].id;
  });

  it("blocks a creative once a person edits the disclosure out", async () => {
    const edited = ok(
      await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, { contentRef: "Cover that fits your car." })
    );
    expect(edited.complianceStatus).toBe("blocked");
    const notes = JSON.parse((await creativeRow(creativeId)).complianceNotesJson!);
    expect(notes.lane).toBe("hard_block");
    expect(notes.findings.map((f: { rule: string }) => f.rule)).toContain("disclosure_missing");
  });

  it("refuses to publish it, naming the field and the reason", async () => {
    const res = await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, { complianceStatus: "passed" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ contentRef: "disclosure_missing" });
    expect((await creativeRow(creativeId)).complianceStatus).toBe("blocked");
  });

  it("refuses the same publish under every tenant setting that could plausibly switch it off", async () => {
    await setPolicy({
      autoApprove: ["signal.creative_publish"],
      autonomyDefault: "act_and_report",
      moduleConfig: {
        signal: { enabled: true, autonomy: "act_and_report", settings: { disclosures: false, preflight: "off", skipDisclosure: true } },
        compliance: { enabled: false, settings: { disclosures: false } }
      }
    });
    try {
      const res = await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, { complianceStatus: "passed" });
      expect(res.status).toBe(422);
      // Nor can the edit and the publish ride one request together.
      const both = await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, {
        contentRef: "Still no disclosure.",
        complianceStatus: "passed"
      });
      expect(both.status).toBe(422);
    } finally {
      await setPolicy({ autoApprove: ["signal.creative_publish"] });
    }
  });

  it("refuses to clear the product line — that would turn the hard block into a soft flag", async () => {
    const res = await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, {
      productLine: null,
      complianceStatus: "passed"
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ productLine: "required" });
    expect((await creativeRow(creativeId)).productLine).toBe("motor");
  });

  it("refuses a hand-created creative that claims `passed` without its disclosure", async () => {
    const res = await call("signal", "POST", "/v1/signal/creatives", {
      kind: "ad",
      productLine: "motor",
      locale: "en",
      contentRef: "Hand-written motor ad.",
      complianceStatus: "passed"
    });
    expect(res.status).toBe(422);
  });

  it("publishes once the wording is restored verbatim, and records the presentation against the wording's version", async () => {
    const published = ok(
      await call("compliance", "PATCH", `/v1/signal/creatives/${creativeId}`, {
        contentRef: `Cover that fits your car.\n\n${WORDING_EN}`,
        complianceStatus: "passed"
      })
    );
    expect(published.complianceStatus).toBe("passed");

    const shown = await database
      .select()
      .from(schema.disclosures)
      .where(
        and(eq(schema.disclosures.tenantId, seeded.tenantId), eq(schema.disclosures.subjectRef, `signal_creative:${creativeId}`))
      );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.key).toBe("motor_ad");
    expect(shown[0]!.locale).toBe("en");
    expect(shown[0]!.channel).toBe("signal");
    expect(shown[0]!.wordingRef).toBe(`compliance_disclosure_wording:${wordingId}@v1`);
    expect(shown[0]!.wordingHash).toBe(await sha256Hex(WORDING_EN));

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.action, "compliance.disclosure.present")));
    expect(audits.some((a) => a.subjectRef === `signal_creative:${creativeId}`)).toBe(true);
  });
});

describe("disclosure wordings are versioned", () => {
  it("bumps the version when the wording changes, and a creative carrying the old wording is then blocked", async () => {
    const updated = ok(
      await call("compliance", "PATCH", `/v1/compliance/disclosure-wordings/${wordingId}`, { wording: WORDING_EN_V2 })
    );
    expect(updated.version).toBe(2);

    const out = ok(
      await call("signal", "POST", "/v1/signal/creatives/generate", {
        kind: "ad",
        brief: "Motor cover.",
        productLine: "motor",
        locales: ["en"],
        count: 1
      }),
      201
    );
    expect(out.variants[0].text.endsWith(WORDING_EN_V2)).toBe(true);
    expect(JSON.parse((await creativeRow(out.variants[0].id)).complianceNotesJson!).disclosure.version).toBe(2);
  });
});
