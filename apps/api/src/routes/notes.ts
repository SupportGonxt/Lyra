import { Hono } from "hono";
import { asc, eq, getTableColumns } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { schema } from "@lyra/db";
import {
  audit,
  backlinks,
  badRequest,
  buildVault,
  can,
  canonicalRef,
  forbidden,
  kindOf,
  linkTargets,
  MAX_NOTE_LENGTH,
  noteGraph,
  notFound,
  readNote,
  refId,
  require_,
  saveNote,
  scoped,
  type Ctx,
  type NoteRow
} from "@lyra/core";
import type { Resource } from "../crud.js";
import { body } from "../http.js";
import { utf8, zip } from "../engines/export/zip.js";
import { resolveNames, resourceOf } from "./names.js";
import type { App } from "../env.js";

// ADR-0089, docs/16 H11: per-record memory, Obsidian-shaped. Every record a
// resource registers can carry one markdown note; its `[[wikilinks]]` become
// `core_links`, which is what "linked from", the graph and the vault export
// read. Mounted under /v1/core ahead of generated CRUD (index.ts).
//
// Two gates on every read, never one. `core:notes:*` says whether the caller
// works with notes at all; the record's own read permission says whether they
// may know anything about *this* record — and a note is knowledge about its
// record. The same rule filters every other record a response names: a
// backlink from a policy the caller cannot open is a read of that policy.

export const noteRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/** Most notes one export reads. A vault past this wants a background job, not a request. */
const MAX_EXPORT_NOTES = 5_000;

interface RecordRef {
  canonical: string;
  resource: Resource;
  id: string;
}

/** Any spelling of a ref → the record it names, or null when no resource owns the prefix. */
function recordOf(ref: string): RecordRef | null {
  const found = resourceOf(ref.trim());
  if (!found) return null;
  return { canonical: canonicalRef(found.resource.path, found.id), resource: found.resource, id: found.id };
}

const canonical = (ref: string): string | null => recordOf(ref)?.canonical ?? null;

function mayRead(ctx: Ctx, resource: Resource): boolean {
  return can(ctx.actor, resource.perms.read, { tenantId: ctx.tenantId, module: resource.module });
}

/** Where the web opens a record: the API's own module and resource path. */
const locate = (rec: RecordRef) => ({ module: rec.resource.module, resource: rec.resource.path, id: rec.id });

/**
 * The subject of a request, checked: it names a resource (400), the caller may
 * read that resource (403), and the row exists in this tenant and is visible to
 * them (404 — never 403, which would confirm another tenant's row exists).
 */
async function subjectOf(ctx: Ctx, raw: string | undefined, param: string): Promise<RecordRef> {
  if (!raw?.trim()) throw badRequest(`${param} is required`);
  const rec = recordOf(raw);
  if (!rec) throw badRequest(`${param} does not name a record`, { [param]: "unknown_ref" });
  if (!mayRead(ctx, rec.resource)) throw forbidden(rec.resource.perms.read);
  const cols = getTableColumns(rec.resource.table) as Record<string, SQLiteColumn>;
  const rows = (await ctx.db
    .select()
    .from(rec.resource.table as never)
    .where(scoped(ctx, rec.resource.table as never, eq(cols.id!, rec.id)))
    .limit(1)) as Record<string, unknown>[];
  const row = rows[0];
  if (!row || (rec.resource.rowVisible && !(await rec.resource.rowVisible(ctx, row)))) {
    throw notFound(rec.resource.path);
  }
  return rec;
}

/** Whether the caller may see a ref named in someone else's note. */
function visibleTo(ctx: Ctx): (ref: string) => boolean {
  return (ref) => {
    const rec = recordOf(ref);
    return Boolean(rec && mayRead(ctx, rec.resource));
  };
}

const view = (note: NoteRow | null) =>
  note
    ? { id: note.id, bodyMd: note.bodyMd, version: note.version, authorRef: note.authorRef, updatedAt: note.updatedAt }
    : null;

noteRoutes.get("/notes/export", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:notes:read", { tenantId: ctx.tenantId, module: "core" });

  const rows = (await ctx.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.tenantId, ctx.tenantId))
    .orderBy(asc(schema.notes.subjectRef))
    .limit(MAX_EXPORT_NOTES)) as NoteRow[];

  // Same two gates as a single read: only notes about records the caller may open.
  const readable = rows.filter((n) => visibleTo(ctx)(n.subjectRef));
  const wanted = new Set<string>(readable.map((n) => n.subjectRef));
  for (const note of readable) {
    for (const { ref } of linkTargets(note.bodyMd)) {
      const to = canonical(ref);
      if (to) wanted.add(to);
    }
  }
  const names = await resolveNames(ctx, [...wanted]);
  // A resource with a per-row predicate only exports a note whose row the name
  // resolver found visible; everywhere else the permission above is the rule.
  const kept = readable.filter((n) => !recordOf(n.subjectRef)?.resource.rowVisible || names[n.subjectRef]);
  const noted = new Set(kept.map((n) => n.subjectRef));

  const folderOf = (ref: string): string => {
    const kind = kindOf(recordOf(ref)?.resource.path ?? ref.slice(0, ref.indexOf(":")));
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  };
  const files = buildVault(
    kept,
    (ref) => {
      const name = names[ref];
      if (name) return { folder: folderOf(ref), name };
      return noted.has(ref) ? { folder: folderOf(ref), name: refId(ref) } : null;
    },
    canonical
  );

  const archive = zip(files.map((f) => ({ path: f.path, data: utf8(f.content) })));
  await audit(ctx, {
    action: "core.note.exported",
    subjectRef: `tenants:${ctx.tenantId}`,
    after: { files: files.length, bytes: archive.length }
  });
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  return new Response(archive, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="notes-vault-${day}.zip"`,
      "cache-control": "no-store"
    }
  });
});

noteRoutes.get("/notes", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:notes:read", { tenantId: ctx.tenantId, module: "core" });
  const rec = await subjectOf(ctx, c.req.query("subject"), "subject");
  return c.json({ subject: rec.canonical, note: view(await readNote(ctx, rec.canonical)) });
});

/**
 * `.strict()`: the author, the id and the timestamps are the server's. A body
 * naming one is a 400, not a field silently dropped.
 */
const NoteBody = z
  .object({
    bodyMd: z.string().max(MAX_NOTE_LENGTH),
    /** The version the editor loaded; 0 for a note that did not exist yet. */
    version: z.number().int().min(0)
  })
  .strict();

noteRoutes.put("/notes", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:notes:write", { tenantId: ctx.tenantId, module: "core" });
  const rec = await subjectOf(ctx, c.req.query("subject"), "subject");
  const input = await body(c, NoteBody);
  const note = await saveNote(ctx, {
    subjectRef: rec.canonical,
    bodyMd: input.bodyMd,
    version: input.version,
    resolve: canonical
  });
  return c.json({ subject: rec.canonical, note: view(note) });
});

noteRoutes.get("/links", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:notes:read", { tenantId: ctx.tenantId, module: "core" });
  const rec = await subjectOf(ctx, c.req.query("to"), "to");
  const visible = visibleTo(ctx);
  const links = (await backlinks(ctx, rec.canonical)).flatMap((link) => {
    const from = recordOf(link.fromRef);
    if (!from || !visible(link.fromRef)) return [];
    return [{ fromRef: link.fromRef, updatedAt: link.updatedAt, ...locate(from) }];
  });
  const names = await resolveNames(ctx, links.map((l) => l.fromRef));
  return c.json({ to: rec.canonical, links, names });
});

const Depth = z.enum(["1", "2"]).default("1");

noteRoutes.get("/graph", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:notes:read", { tenantId: ctx.tenantId, module: "core" });
  const rec = await subjectOf(ctx, c.req.query("subject"), "subject");
  const depth = Depth.safeParse(c.req.query("depth") ?? undefined);
  if (!depth.success) throw badRequest("depth is 1 or 2", { depth: "out_of_range" });
  const graph = await noteGraph(ctx, rec.canonical, {
    depth: Number(depth.data) as 1 | 2,
    visible: visibleTo(ctx)
  });
  const nodes = graph.nodes.flatMap((node) => {
    const at = recordOf(node.ref);
    return at ? [{ ...node, ...locate(at) }] : [];
  });
  const names = await resolveNames(ctx, nodes.map((n) => n.ref));
  return c.json({ subject: rec.canonical, nodes, edges: graph.edges, truncated: graph.truncated, names });
});
