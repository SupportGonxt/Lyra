import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import type { CoreDb } from "../context.js";

// The config rows ORBIT routes on, written to a tenant that already exists.
//
// `seed()` refuses to run twice against the same tenant ("gonxt tenant already
// seeded"), so a deployed database only ever holds the tables the fixture wrote
// on the day it was seeded. The five tables below were added to seed/orbit.ts
// after the demo tenant was created, and there has been no way to give them to
// it since: `wrangler d1 migrations apply` writes shape, not rows.
//
// Without them engines/orbit-routing.ts queues every conversation and assigns
// none, and the desk-configuration screens render empty. The knowledge-base
// articles and macros at the end are here for the same reason and reach a
// deployed tenant by the same one door.
//
// Deliberately NOT here: orbit_channel_connectors. A connector carries sealed
// provider credentials; a fixture one would be a channel that looks connected
// and cannot send. An empty channel list is the honest reading.
//
// Idempotent per table: a table that already holds a row for the tenant is left
// exactly as it is, so this can be re-run against any database.

/** Rows written, keyed by physical table name. All zero on a re-run. */
export type OpsConfigResult = Record<string, number>;

/** Any tenant-scoped table: the two columns this check needs, whatever else it has. */
type ScopedTable = SQLiteTable & { id: AnySQLiteColumn; tenantId: AnySQLiteColumn };

async function isEmpty(db: CoreDb, table: ScopedTable, tenantId: string): Promise<boolean> {
  const rows = await db.select({ id: table.id }).from(table).where(eq(table.tenantId, tenantId)).limit(1);
  return !rows[0];
}

export async function seedOpsConfig(db: CoreDb, tenantId: string, now: number): Promise<OpsConfigResult> {
  const written: OpsConfigResult = {};

  // The orbit team id IS the core team id (seed/orbit.ts says so): conversations
  // carry `team_id` from the core `teams` table and the router reads
  // `orbit_teams`, so one id keeps both readings of that column true. Read them
  // back rather than minting new ones, or the conversations already on the
  // database point at teams the router cannot see.
  const coreTeams = await db
    .select({ id: schema.teams.id, name: schema.teams.name, moduleScope: schema.teams.moduleScope })
    .from(schema.teams)
    .where(eq(schema.teams.tenantId, tenantId));
  const motor = coreTeams.find((t) => t.name === "Motor desk");
  const retention = coreTeams.find((t) => t.name === "Retention");
  if (!motor || !retention) {
    throw new Error(
      `expected core teams "Motor desk" and "Retention" on ${tenantId}, found: ${coreTeams.map((t) => t.name).join(", ") || "none"}`
    );
  }

  const users = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.tenantId, tenantId));
  const byLocal = (local: string): string => {
    const found = users.find((u) => u.email.split("@")[0] === local);
    if (!found) throw new Error(`no user ${local}@ on ${tenantId}`);
    return found.id;
  };
  const sara = byLocal("sara.nasser"); // customer agent
  const yusuf = byLocal("yusuf.karim"); // retention
  const dana = byLocal("dana.aziz"); // partner desk

  if (await isEmpty(db, schema.orbitTeams, tenantId)) {
    await db.insert(schema.orbitTeams).values([
      {
        id: motor.id,
        tenantId,
        key: "motor",
        nameJson: JSON.stringify({ en: "Motor desk", ar: "مكتب المركبات" }),
        isDefault: true, // the catch-all rule below points here
        createdAt: now,
        updatedAt: now
      },
      {
        id: retention.id,
        tenantId,
        key: "retention",
        nameJson: JSON.stringify({ en: "Retention", ar: "الاحتفاظ بالعملاء" }),
        createdAt: now,
        updatedAt: now
      }
    ]);
    written.orbit_teams = 2;
  }

  if (await isEmpty(db, schema.orbitTeamMembers, tenantId)) {
    await db.insert(schema.orbitTeamMembers).values([
      {
        // Sara answers the Arabic accident thread, so "ar" is a skill she is
        // actually picked on, not decoration.
        id: id("tmm", now + 1),
        tenantId,
        teamId: motor.id,
        userId: sara,
        skillsJson: JSON.stringify(["motor", "ar"]),
        maxConcurrent: 6,
        createdAt: now
      },
      {
        id: id("tmm", now + 2),
        tenantId,
        teamId: retention.id,
        userId: yusuf,
        skillsJson: JSON.stringify(["renewal", "motor"]),
        maxConcurrent: 4,
        createdAt: now
      },
      {
        id: id("tmm", now + 3),
        tenantId,
        teamId: motor.id,
        userId: dana,
        skillsJson: JSON.stringify(["partner"]),
        maxConcurrent: 3,
        createdAt: now
      }
    ]);
    written.orbit_team_members = 3;
  }

  if (await isEmpty(db, schema.orbitAgentPresence, tenantId)) {
    await db.insert(schema.orbitAgentPresence).values([
      { id: id("ap", now + 1), tenantId, userId: sara, status: "available", updatedAt: now },
      { id: id("ap", now + 2), tenantId, userId: yusuf, status: "available", updatedAt: now },
      // Dana works the partner desk, not the customer queue.
      { id: id("ap", now + 3), tenantId, userId: dana, status: "away", updatedAt: now }
    ]);
    written.orbit_agent_presence = 3;
  }

  if (await isEmpty(db, schema.orbitSlaPolicies, tenantId)) {
    await db.insert(schema.orbitSlaPolicies).values([
      { id: id("slp", now + 1), tenantId, key: "standard", frtMinutes: 15, resolutionMinutes: 480, createdAt: now, updatedAt: now },
      { id: id("slp", now + 2), tenantId, key: "urgent", frtMinutes: 5, resolutionMinutes: 120, createdAt: now, updatedAt: now }
    ]);
    written.orbit_sla_policies = 2;
  }

  if (await isEmpty(db, schema.orbitRoutingRules, tenantId)) {
    await db.insert(schema.orbitRoutingRules).values([
      {
        id: id("rr", now + 1),
        tenantId,
        teamId: retention.id,
        seq: 1,
        conditionsJson: JSON.stringify({ intent: "renewal.offer" }),
        createdAt: now,
        updatedAt: now
      },
      {
        // Last rule wins nothing on its own — it is the wildcard that stops a
        // conversation sitting unrouted because no condition matched it.
        id: id("rr", now + 2),
        tenantId,
        teamId: motor.id,
        seq: 2,
        conditionsJson: JSON.stringify({}),
        createdAt: now,
        updatedAt: now
      }
    ]);
    written.orbit_routing_rules = 2;
  }

  // docs/27 F32. The desk has nothing to answer from until somebody writes an
  // article, and a knowledge base that ships empty is a feature nobody sees.
  // Both languages for every key, because retrieval is per-language
  // (orbit_kb_articles is one row per key+locale) — an English-only knowledge
  // base is an Arabic conversation that can never be deflected.
  //
  // Published, but `vectorId` stays null: seeding runs in a CLI with no
  // Vectorize binding, so these are lexically retrievable until somebody
  // re-publishes them through the API. A vectorId pointing at a vector nobody
  // wrote would be the worse lie.
  if (await isEmpty(db, schema.orbitKbArticles, tenantId)) {
    const article = (
      seq: number,
      key: string,
      locale: "en" | "ar",
      title: string,
      body: string,
      tags: string[]
    ) => ({
      id: id("kba", now + seq),
      tenantId,
      key,
      locale,
      title,
      body,
      tagsJson: JSON.stringify(tags),
      status: "published",
      createdAt: now,
      updatedAt: now
    });
    await db.insert(schema.orbitKbArticles).values([
      article(
        1,
        "renewal_how_to",
        "en",
        "How to renew your cover",
        "Open the renewal link we sent you, check that the details are still right, and confirm. Payment is taken when you confirm, and your documents arrive by email within a few minutes.",
        ["renewal", "self-service"]
      ),
      article(
        2,
        "renewal_how_to",
        "ar",
        "كيف تجدد تغطيتك",
        "افتح رابط التجديد الذي أرسلناه إليك، وتأكد من صحة البيانات، ثم أكد التجديد. يُخصم المبلغ عند التأكيد وتصلك المستندات بالبريد الإلكتروني خلال دقائق.",
        ["renewal", "self-service"]
      ),
      article(
        3,
        "documents_where",
        "en",
        "Where to find your documents",
        "Every document we issue is on your account page under Documents, newest first. If you cannot see one you expect, reply here and a member of the team will send it.",
        ["documents", "self-service"]
      ),
      article(
        4,
        "documents_where",
        "ar",
        "أين تجد مستنداتك",
        "كل مستند نصدره موجود في صفحة حسابك ضمن المستندات، الأحدث أولًا. إن لم تجد مستندًا تتوقعه، فردّ هنا وسيرسله لك أحد أعضاء الفريق.",
        ["documents", "self-service"]
      )
    ]);
    written.orbit_kb_articles = 4;
  }

  if (await isEmpty(db, schema.orbitMacros, tenantId)) {
    await db.insert(schema.orbitMacros).values([
      {
        id: id("mac", now + 1),
        tenantId,
        key: "renewal_link",
        nameJson: JSON.stringify({ en: "Send the renewal link", ar: "إرسال رابط التجديد" }),
        bodyJson: JSON.stringify({
          en: "Here is your renewal link. It is valid for seven days and shows the price before you confirm anything.",
          ar: "هذا رابط التجديد الخاص بك. صالح لسبعة أيام ويعرض السعر قبل أن تؤكد أي شيء."
        }),
        category: "renewal",
        createdAt: now,
        updatedAt: now
      },
      {
        id: id("mac", now + 2),
        tenantId,
        key: "documents_chase",
        nameJson: JSON.stringify({ en: "Ask for a missing document", ar: "طلب مستند ناقص" }),
        bodyJson: JSON.stringify({
          en: "To finish this we still need one document from you. Reply with a photo of it here and we will take it from there.",
          ar: "لإتمام الطلب ما زلنا بحاجة إلى مستند واحد منك. أرسل صورة له هنا وسنكمل الباقي."
        }),
        category: "documents",
        createdAt: now,
        updatedAt: now
      }
    ]);
    written.orbit_macros = 2;
  }

  return written;
}
