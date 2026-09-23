import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import {
  backlinks,
  buildVault,
  canonicalRef,
  forgetNotes,
  kindOf,
  noteGraph,
  readNote,
  refId,
  saveNote
} from "./notes.js";
import { AppError } from "./errors.js";
import type { Ctx } from "./context.js";

// ADR-0085. One note per record, links derived on save, erased with the
// subject. These run against real SQLite because the interesting failures —
// a stale version, a link that survives its note, another tenant's row — are
// all things a mocked db would agree with.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

let client: Client;
const NOW = 1_700_000_000_000;

function makeCtx(tenantId = "t_1", now = NOW): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: { kind: "user", id: "us_1", tenantId, grants: [{ roleKey: "x", permissions: ["*:*:*"] }] },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

/** Test resolver: anything `<prefix>_<rest>` becomes `thing:<id>`; `cu_` is a customer. */
const resolve = (ref: string): string | null => {
  const id = refId(ref);
  if (!/^[a-z]+_\w+$/.test(id)) return null;
  return id.startsWith("cu_") ? `customer:${id}` : `thing:${id}`;
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
});

describe("record refs", () => {
  it("names a kind by the singular of its resource path", () => {
    expect(kindOf("customers")).toBe("customer");
    expect(kindOf("policies")).toBe("policy");
    expect(kindOf("cases")).toBe("case");
    expect(kindOf("whitespaces")).toBe("whitespace");
    expect(kindOf("dsar-requests")).toBe("dsar-request");
    expect(kindOf("addresses")).toBe("address");
    expect(canonicalRef("customers", "cu_1")).toBe("customer:cu_1");
  });

  it("reads the id out of any spelling", () => {
    expect(refId("cu_1")).toBe("cu_1");
    expect(refId("customer:cu_1")).toBe("cu_1");
  });
});

describe("saveNote", () => {
  it("creates at version 1 and derives canonical links, self-links and unknown refs dropped", async () => {
    const ctx = makeCtx();
    const note = await saveNote(ctx, {
      subjectRef: "customer:cu_1",
      bodyMd: "Owns [[pol_1|Motor]], see [[cu_1]] and [[not a ref]] and [[customer:cu_2]] [[pol_1]]",
      version: 0,
      resolve
    });
    expect(note.version).toBe(1);
    const rows = await ctx.db.select().from(schema.links).where(eq(schema.links.noteId, note.id));
    expect(rows.map((r) => r.toRef).sort()).toEqual(["customer:cu_2", "thing:pol_1"]);
    expect(rows.every((r) => r.fromRef === "customer:cu_1" && r.tenantId === "t_1")).toBe(true);
  });

  it("refuses a stale version with 409, and a fresh one replaces the links", async () => {
    const ctx = makeCtx();
    await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "[[pol_1]]", version: 0, resolve });
    const stale = await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "x", version: 0, resolve }).catch((e) => e);
    expect(stale).toBeInstanceOf(AppError);
    expect((stale as AppError).status).toBe(409);

    const next = await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "[[pol_2]]", version: 1, resolve });
    expect(next.version).toBe(2);
    const rows = await ctx.db.select().from(schema.links);
    expect(rows.map((r) => r.toRef)).toEqual(["thing:pol_2"]);
  });

  it("audits the save without copying the body", async () => {
    const ctx = makeCtx();
    await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "secret words [[pol_1]]", version: 0, resolve });
    const audit = await ctx.db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toEqual(["core.note.updated"]);
    expect(audit[0]!.subjectRef).toBe("customer:cu_1");
    expect(JSON.stringify(audit)).not.toContain("secret words");
  });

  it("is tenant-scoped: another tenant's note on the same ref is its own", async () => {
    await saveNote(makeCtx("t_1"), { subjectRef: "customer:cu_1", bodyMd: "one", version: 0, resolve });
    await saveNote(makeCtx("t_2"), { subjectRef: "customer:cu_1", bodyMd: "two", version: 0, resolve });
    expect((await readNote(makeCtx("t_1"), "customer:cu_1"))?.bodyMd).toBe("one");
    expect((await readNote(makeCtx("t_2"), "customer:cu_1"))?.bodyMd).toBe("two");
    expect(await backlinks(makeCtx("t_2"), "thing:pol_1")).toEqual([]);
  });

  it("refuses a body over the cap", async () => {
    const err = await saveNote(makeCtx(), {
      subjectRef: "customer:cu_1",
      bodyMd: "x".repeat(20_001),
      version: 0,
      resolve
    }).catch((e) => e);
    expect((err as AppError).status).toBe(400);
  });
});

describe("backlinks and graph", () => {
  beforeEach(async () => {
    const ctx = makeCtx();
    await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "[[pol_1]] [[cs_1]]", version: 0, resolve });
    await saveNote(makeCtx("t_1", NOW + 5), { subjectRef: "thing:cs_1", bodyMd: "[[pol_1]] [[cl_1]]", version: 0, resolve });
    await saveNote(ctx, { subjectRef: "thing:cl_1", bodyMd: "[[pol_9]]", version: 0, resolve });
  });

  it("lists who links to a record, newest note first", async () => {
    const got = await backlinks(makeCtx(), "thing:pol_1");
    expect(got.map((b) => b.fromRef)).toEqual(["thing:cs_1", "customer:cu_1"]);
  });

  it("walks one hop, both directions", async () => {
    const g = await noteGraph(makeCtx(), "thing:cs_1", { depth: 1 });
    expect(g.nodes.map((n) => n.ref).sort()).toEqual(["customer:cu_1", "thing:cl_1", "thing:cs_1", "thing:pol_1"]);
    expect(g.nodes.find((n) => n.ref === "thing:cs_1")?.depth).toBe(0);
    expect(g.edges).toContainEqual({ from: "customer:cu_1", to: "thing:cs_1" });
  });

  it("walks two hops and stops at the cap", async () => {
    const two = await noteGraph(makeCtx(), "customer:cu_1", { depth: 2 });
    expect(two.nodes.map((n) => n.ref)).toContain("thing:cl_1");
    expect(two.nodes.map((n) => n.ref)).not.toContain("thing:pol_9");
    const capped = await noteGraph(makeCtx(), "customer:cu_1", { depth: 2, maxNodes: 2 });
    expect(capped.nodes).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    for (const e of capped.edges) {
      expect(capped.nodes.map((n) => n.ref)).toEqual(expect.arrayContaining([e.from, e.to]));
    }
  });

  it("does not show or walk through a node the reader may not see", async () => {
    const g = await noteGraph(makeCtx(), "customer:cu_1", { depth: 2, visible: (ref) => ref !== "thing:cs_1" });
    expect(g.nodes.map((n) => n.ref).sort()).toEqual(["customer:cu_1", "thing:pol_1"]);
  });
});

describe("forgetNotes", () => {
  it("erases the subject's note, every link to or from it, and redacts it from other notes", async () => {
    const ctx = makeCtx();
    await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "about me [[pol_1]]", version: 0, resolve });
    await saveNote(ctx, { subjectRef: "thing:pol_1", bodyMd: "held by [[cu_1|Layla Haddad]] since 2024", version: 0, resolve });

    const out = await forgetNotes(ctx, "customer:cu_1", (ref) => refId(ref) === "cu_1");
    expect(out).toEqual({ notes: 1, links: 2, redacted: 1 });
    expect(await readNote(ctx, "customer:cu_1")).toBeNull();
    const other = await readNote(ctx, "thing:pol_1");
    expect(other?.bodyMd).toBe("held by […] since 2024");
    expect(other?.version).toBe(2);
    expect(await ctx.db.select().from(schema.links)).toEqual([]);
    const actions = (await ctx.db.select().from(schema.auditLog)).map((a) => a.action);
    expect(actions).toContain("core.note.erased");
  });

  it("leaves another tenant alone", async () => {
    await saveNote(makeCtx("t_2"), { subjectRef: "customer:cu_1", bodyMd: "kept", version: 0, resolve });
    await forgetNotes(makeCtx("t_1"), "customer:cu_1");
    expect((await readNote(makeCtx("t_2"), "customer:cu_1"))?.bodyMd).toBe("kept");
  });
});

describe("buildVault", () => {
  const entry = (ref: string) =>
    ({
      "customer:cu_1": { folder: "Customer", name: "Falcon Freight" },
      "thing:pol_1": { folder: "Thing", name: "Motor/2026: A*B" },
      "thing:pol_2": { folder: "Thing", name: "Motor/2026: A*B" }
    })[ref] ?? null;

  // pol_1 has no body, so it gets no file — but a link to it still needs a
  // path, and that path must not be the one pol_2 (same name) was given.
  it("writes one file per note with front matter and Obsidian-form links", () => {
    const files = buildVault(
      [
        { subjectRef: "customer:cu_1", bodyMd: "Owns [[pol_1|the motor]] and [[zz_9|gone]] and `[[pol_1]]`", updatedAt: Date.UTC(2026, 0, 2) },
        { subjectRef: "thing:pol_1", bodyMd: "", updatedAt: 0 },
        { subjectRef: "thing:pol_2", bodyMd: "twin", updatedAt: 0 }
      ],
      entry,
      resolve
    );
    expect(files.map((f) => f.path)).toEqual(["Customer/Falcon Freight.md", "Thing/Motor 2026 A B.md"]);
    expect(files[0]!.content).toBe(
      [
        "---",
        'ref: "customer:cu_1"',
        'type: "Customer"',
        'updated: "2026-01-02T00:00:00.000Z"',
        "---",
        "",
        "Owns [[Thing/Motor 2026 A B (pol_1)|the motor]] and [[zz_9|gone]] and `[[pol_1]]`",
        ""
      ].join("\n")
    );
  });

  it("disambiguates two records that share a name", () => {
    const files = buildVault(
      [
        { subjectRef: "thing:pol_1", bodyMd: "a", updatedAt: 0 },
        { subjectRef: "thing:pol_2", bodyMd: "b", updatedAt: 0 }
      ],
      entry,
      resolve
    );
    expect(files.map((f) => f.path)).toEqual(["Thing/Motor 2026 A B.md", "Thing/Motor 2026 A B (pol_2).md"]);
  });
});
