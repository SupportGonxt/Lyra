import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import { applyMacro, deflect, DEFLECT_MIN_SCORE, publishArticle, scoreArticle, searchKb } from "./orbit-kb.js";

// docs/27 F32: "No KB/RAG article manager, no macros, no deflection." The three
// are one engine because they are one loop — an article is retrieved, a macro
// is the short form of one, and a deflection is the record of whether the
// retrieval answered the customer or a human had to.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function actor(roleKey = "orbit.lead"): Actor {
  return { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey, permissions: permissionsForRole(roleKey) }] };
}

function makeCtx(): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now: 1_770_000_000_000,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

/** A gateway that embeds nothing: the shape a deploy with no Vectorize index bound has. */
const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]] })) } as unknown as Gateway;

async function seedArticle(
  id: string,
  patch: { key?: string; locale?: string; title?: string; body?: string; status?: string } = {}
): Promise<void> {
  await ctx.db.insert(schema.orbitKbArticles).values({
    id,
    tenantId: ctx.tenantId,
    key: patch.key ?? id,
    locale: patch.locale ?? "en",
    title: patch.title ?? "How to renew your motor cover",
    body: patch.body ?? "Open the renewal link we sent, check the details and confirm. Payment is taken on confirmation.",
    tagsJson: "[]",
    status: patch.status ?? "published",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

async function seedConversation(id = "cnv_1"): Promise<void> {
  await ctx.db.insert(schema.orbitConversations).values({
    id,
    tenantId: ctx.tenantId,
    customerId: "cus_1",
    channel: "whatsapp",
    state: "bot",
    lang: "en",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = makeCtx();
});

describe("scoreArticle", () => {
  const article = { title: "Renew your motor cover", body: "Open the renewal link, confirm the details, pay." };

  it("scores a question the article answers above one it does not", () => {
    const near = scoreArticle("how do I renew my motor cover", article);
    const far = scoreArticle("where is my nearest garage", article);
    expect(near).toBeGreaterThan(far);
  });

  it("weighs a title hit above a body hit, because a title is what the article is about", () => {
    const titled = scoreArticle("motor", article);
    const bodied = scoreArticle("pay", article);
    expect(titled).toBeGreaterThan(bodied);
  });

  it("stays inside 0..100 so the column and the threshold agree", () => {
    expect(scoreArticle("renew your motor cover open the renewal link confirm the details pay", article)).toBeLessThanOrEqual(100);
    expect(scoreArticle("", article)).toBe(0);
  });
});

describe("searchKb", () => {
  it("finds published articles in the reader's language and ignores drafts and other locales", async () => {
    await seedArticle("kb_en");
    await seedArticle("kb_draft", { key: "draft", status: "draft" });
    await seedArticle("kb_ar", { key: "ar_one", locale: "ar", title: "تجديد وثيقة التأمين" });

    const results = await searchKb(ctx, gateway, undefined, { query: "renew motor cover", locale: "en" });
    expect(results.map((r) => r.article.id)).toEqual(["kb_en"]);
    // No index bound, so retrieval is the deterministic fallback and says so.
    expect(results[0]!.via).toBe("lexical");
  });

  it("returns nothing rather than a bad match when nothing scores", async () => {
    await seedArticle("kb_en");
    const results = await searchKb(ctx, gateway, undefined, { query: "xyzzy plugh", locale: "en" });
    expect(results).toEqual([]);
  });
});

describe("publishArticle", () => {
  it("publishes and embeds, so a published article is retrievable and a draft is not", async () => {
    await seedArticle("kb_1", { status: "draft" });
    const index = { upsert: vi.fn(async () => undefined), query: vi.fn(async () => ({ matches: [] })) };
    await publishArticle(ctx, gateway, index as never, "kb_1");

    const [row] = await ctx.db.select().from(schema.orbitKbArticles);
    expect(row!.status).toBe("published");
    expect(row!.vectorId).toBe("kb_1");
    expect(index.upsert).toHaveBeenCalled();
  });

  it("publishes with no index bound rather than failing — Vectorize is optional", async () => {
    await seedArticle("kb_1", { status: "draft" });
    await publishArticle(ctx, gateway, undefined, "kb_1");
    const [row] = await ctx.db.select().from(schema.orbitKbArticles);
    expect(row!.status).toBe("published");
    expect(row!.vectorId).toBeNull();
  });
});

describe("deflect", () => {
  it("answers from the article, logs the deflection and leaves the conversation with the bot", async () => {
    await seedConversation();
    await seedArticle("kb_en");

    const result = await deflect(ctx, gateway, undefined, {
      conversationId: "cnv_1",
      question: "how do I renew my motor cover?"
    });
    expect(result.outcome).toBe("deflected");
    expect(result.articleId).toBe("kb_en");
    expect(result.score).toBeGreaterThanOrEqual(DEFLECT_MIN_SCORE);

    const messages = await ctx.db.select().from(schema.orbitMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("agent_ai");
    expect(messages[0]!.content).toContain("renewal link");

    const [log] = await ctx.db.select().from(schema.orbitDeflections);
    expect(log!.outcome).toBe("deflected");
    expect(log!.articleId).toBe("kb_en");
  });

  it("escalates when nothing answers, and still logs the miss so containment is a real ratio", async () => {
    await seedConversation();
    await seedArticle("kb_en");

    const result = await deflect(ctx, gateway, undefined, {
      conversationId: "cnv_1",
      question: "my neighbour reversed into a lamppost, what happens now"
    });
    expect(result.outcome).toBe("escalated");
    expect(result.articleId).toBeNull();
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);

    const [log] = await ctx.db.select().from(schema.orbitDeflections);
    expect(log!.outcome).toBe("escalated");
    expect(log!.articleId).toBeNull();
  });

  it("never deflects a conversation a human already holds", async () => {
    await seedConversation();
    await ctx.db
      .update(schema.orbitConversations)
      .set({ state: "human" })
      .where(eq(schema.orbitConversations.id, "cnv_1"));
    await seedArticle("kb_en");

    const result = await deflect(ctx, gateway, undefined, {
      conversationId: "cnv_1",
      question: "how do I renew my motor cover?"
    });
    expect(result.outcome).toBe("escalated");
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });

  it("answers an Arabic conversation from the Arabic article", async () => {
    await seedConversation();
    await ctx.db.update(schema.orbitConversations).set({ lang: "ar" }).where(eq(schema.orbitConversations.id, "cnv_1"));
    await seedArticle("kb_en");
    await seedArticle("kb_ar", { key: "renew", locale: "ar", title: "تجديد التأمين", body: "افتح رابط التجديد وأكد التفاصيل." });

    const result = await deflect(ctx, gateway, undefined, { conversationId: "cnv_1", question: "تجديد التأمين" });
    expect(result.articleId).toBe("kb_ar");
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    expect(message!.content).toContain("رابط التجديد");
  });
});

describe("applyMacro", () => {
  beforeEach(async () => {
    await ctx.db.insert(schema.orbitMacros).values({
      id: "mac_1",
      tenantId: ctx.tenantId,
      key: "renewal_link",
      nameJson: JSON.stringify({ en: "Send renewal link", ar: "إرسال رابط التجديد" }),
      bodyJson: JSON.stringify({ en: "Here is your renewal link.", ar: "هذا رابط التجديد الخاص بك." }),
      category: "renewal",
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
  });

  it("replies in the conversation's language and counts the use", async () => {
    await seedConversation();
    await ctx.db.update(schema.orbitConversations).set({ lang: "ar" }).where(eq(schema.orbitConversations.id, "cnv_1"));

    await applyMacro(ctx, { conversationId: "cnv_1", macroKey: "renewal_link" });
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    expect(message!.content).toBe("هذا رابط التجديد الخاص بك.");
    expect(message!.role).toBe("agent_human");

    const [macro] = await ctx.db
      .select()
      .from(schema.orbitMacros)
      .where(and(eq(schema.orbitMacros.tenantId, ctx.tenantId), eq(schema.orbitMacros.key, "renewal_link")));
    expect(macro!.usageCount).toBe(1);
  });

  it("falls back to English when the macro has no wording in the conversation's language", async () => {
    await seedConversation();
    await ctx.db.update(schema.orbitConversations).set({ lang: "fr" }).where(eq(schema.orbitConversations.id, "cnv_1"));
    await applyMacro(ctx, { conversationId: "cnv_1", macroKey: "renewal_link" });
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    expect(message!.content).toBe("Here is your renewal link.");
  });

  it("refuses a disabled macro rather than sending a withdrawn wording", async () => {
    await seedConversation();
    await ctx.db.update(schema.orbitMacros).set({ status: "disabled" }).where(eq(schema.orbitMacros.id, "mac_1"));
    await expect(applyMacro(ctx, { conversationId: "cnv_1", macroKey: "renewal_link" })).rejects.toMatchObject({ status: 409 });
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });
});
