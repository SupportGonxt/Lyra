import { and, desc, eq, inArray, or } from "drizzle-orm";
import { atomically, id as newId, schema, type Write } from "@lyra/db";
import { audit } from "./audit.js";
import { actorRef, type Ctx } from "./context.js";
import { badRequest, conflict } from "./errors.js";
import { linkTargets, rewriteWikilinks } from "./wikilinks.js";

// ADR-0085, docs/16 H11. The human half of per-record memory: one markdown note
// per record, its `[[wikilinks]]` derived into `core_links` on every save so
// "linked from" and the graph are a query rather than a full-text scan. The AI
// half is `core_memories` (memory.ts); the two share a subject ref and an
// erasure path, and nothing else — a note is what a person wrote, a memory is
// what the platform concluded, and a reader must always be able to tell which.

/** A note is a working page, not a document store. */
export const MAX_NOTE_LENGTH = 20_000;
/** Links kept per note; past this a note is an index, and an index is a report. */
export const MAX_LINKS_PER_NOTE = 200;
/** What a graph returns at most, subject included. A picture of 200 dots says nothing. */
export const MAX_GRAPH_NODES = 40;
/** What a redacted link reads as once its record is erased. */
export const ERASED_LINK = "[…]";

export interface NoteRow {
  id: string;
  tenantId: string;
  subjectRef: string;
  bodyMd: string;
  authorRef: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------ record refs */

/**
 * The kind a ref names, from a resource's URL path: `customers` → `customer`,
 * the spelling the seed and the audit log already use (`customer:cu_…`,
 * `policy:pol_…`, `case:cs_…`).
 */
export function kindOf(resourcePath: string): string {
  const last = resourcePath.split("/").pop() ?? resourcePath;
  if (/ies$/.test(last)) return last.replace(/ies$/, "y");
  if (/(ss|x|ch|sh)es$/.test(last)) return last.replace(/es$/, "");
  return last.replace(/s$/, "");
}

/** `customers` + `cu_1` → `customer:cu_1`. */
export function canonicalRef(resourcePath: string, id: string): string {
  return `${kindOf(resourcePath)}:${id}`;
}

/** The id inside any spelling of a ref: `customer:cu_1` and `cu_1` both give `cu_1`. */
export function refId(ref: string): string {
  const colon = ref.lastIndexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/* ----------------------------------------------------------------- notes */

export async function readNote(ctx: Ctx, subjectRef: string): Promise<NoteRow | null> {
  const rows = await ctx.db
    .select()
    .from(schema.notes)
    .where(and(eq(schema.notes.tenantId, ctx.tenantId), eq(schema.notes.subjectRef, subjectRef)))
    .limit(1);
  return (rows[0] as NoteRow | undefined) ?? null;
}

export interface SaveNoteInput {
  /** Canonical ref of the record the note is about. */
  subjectRef: string;
  bodyMd: string;
  /** The version the editor loaded; 0 when there was no note yet. */
  version: number;
  /**
   * A linked ref's canonical form, or null when it names no record. The API
   * passes a resolver over its resource registry; core cannot know the prefixes.
   */
  resolve: (ref: string) => string | null;
}

/** The link rows a body derives, canonical, deduped, self-links dropped. */
function derivedTargets(bodyMd: string, subjectRef: string, resolve: (ref: string) => string | null): string[] {
  const out = new Set<string>();
  for (const { ref } of linkTargets(bodyMd)) {
    const to = resolve(ref);
    if (to && to !== subjectRef) out.add(to);
    if (out.size >= MAX_LINKS_PER_NOTE) break;
  }
  return [...out];
}

function linkWrites(ctx: Ctx, noteId: string, fromRef: string, targets: readonly string[]): Write[] {
  const writes: Write[] = [
    ctx.db.delete(schema.links).where(and(eq(schema.links.tenantId, ctx.tenantId), eq(schema.links.noteId, noteId)))
  ];
  if (targets.length) {
    writes.push(
      ctx.db.insert(schema.links).values(
        targets.map((toRef, i) => ({
          id: newId("lnk", ctx.now + i),
          tenantId: ctx.tenantId,
          noteId,
          fromRef,
          toRef,
          createdAt: ctx.now
        }))
      )
    );
  }
  return writes;
}

/**
 * Write a note, or refuse with 409 when someone saved since the editor loaded
 * it. The version check is in the UPDATE's own WHERE, so two editors racing
 * cannot both win. Links are rebuilt after the note lands; they are derived, so
 * a crash between the two leaves them stale until the next save, never wrong
 * about who wrote what.
 */
export async function saveNote(ctx: Ctx, input: SaveNoteInput): Promise<NoteRow> {
  if (input.bodyMd.length > MAX_NOTE_LENGTH) {
    throw badRequest(`a note holds at most ${MAX_NOTE_LENGTH} characters`, { bodyMd: "too_long" });
  }
  const targets = derivedTargets(input.bodyMd, input.subjectRef, input.resolve);
  const existing = await readNote(ctx, input.subjectRef);
  const author = actorRef(ctx);
  let note: NoteRow;

  if (!existing) {
    if (input.version !== 0) throw conflict("this note was removed since it was opened");
    note = {
      id: newId("nte", ctx.now),
      tenantId: ctx.tenantId,
      subjectRef: input.subjectRef,
      bodyMd: input.bodyMd,
      authorRef: author,
      version: 1,
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
    try {
      await ctx.db.insert(schema.notes).values(note);
    } catch {
      // The unique (tenant, subject) index: someone created it first.
      throw conflict("someone else saved this note since it was opened");
    }
  } else {
    if (existing.version !== input.version) throw conflict("someone else saved this note since it was opened");
    const updated = await ctx.db
      .update(schema.notes)
      .set({ bodyMd: input.bodyMd, authorRef: author, version: existing.version + 1, updatedAt: ctx.now })
      .where(
        and(
          eq(schema.notes.tenantId, ctx.tenantId),
          eq(schema.notes.id, existing.id),
          eq(schema.notes.version, existing.version)
        )
      )
      .returning({ id: schema.notes.id });
    if (!updated.length) throw conflict("someone else saved this note since it was opened");
    note = { ...existing, bodyMd: input.bodyMd, authorRef: author, version: existing.version + 1, updatedAt: ctx.now };
  }

  await atomically(ctx.db as never, linkWrites(ctx, note.id, note.subjectRef, targets));
  await audit(ctx, {
    action: "core.note.updated",
    subjectRef: note.subjectRef,
    // What changed and how much, never the text: the audit log must not become
    // a second copy of what a person wrote about a customer (docs/12 §4).
    after: { id: note.id, version: note.version, length: note.bodyMd.length, links: targets.length }
  });
  return note;
}

/* ------------------------------------------------------- links and graph */

export interface Backlink {
  fromRef: string;
  noteId: string;
  updatedAt: number;
}

/** Every note that links to `toRef`, most recently edited first. */
export async function backlinks(ctx: Ctx, toRef: string, limit = 100): Promise<Backlink[]> {
  const rows = await ctx.db
    .select({ fromRef: schema.links.fromRef, noteId: schema.links.noteId, updatedAt: schema.notes.updatedAt })
    .from(schema.links)
    .innerJoin(schema.notes, and(eq(schema.notes.id, schema.links.noteId), eq(schema.notes.tenantId, ctx.tenantId)))
    .where(and(eq(schema.links.tenantId, ctx.tenantId), eq(schema.links.toRef, toRef)))
    .orderBy(desc(schema.notes.updatedAt))
    .limit(limit);
  return rows;
}

export interface GraphNode {
  ref: string;
  /** Hops from the subject; the subject is 0. */
  depth: number;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface NoteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the cap cut the walk short. */
  truncated: boolean;
}

export interface GraphOptions {
  depth: 1 | 2;
  maxNodes?: number;
  /**
   * Whether the reader may see a record. A node that fails is neither shown nor
   * walked through — a hop via a record you cannot read is a read of it.
   */
  visible?: (ref: string) => boolean;
}

/** Breadth-first over links in both directions, capped. */
export async function noteGraph(ctx: Ctx, subjectRef: string, opts: GraphOptions): Promise<NoteGraph> {
  const cap = Math.max(1, Math.min(opts.maxNodes ?? MAX_GRAPH_NODES, MAX_GRAPH_NODES));
  const visible = opts.visible ?? (() => true);
  const nodes = new Map<string, number>([[subjectRef, 0]]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [subjectRef];
  let truncated = false;

  for (let depth = 1; depth <= opts.depth && frontier.length; depth++) {
    const rows = await ctx.db
      .select({ from: schema.links.fromRef, to: schema.links.toRef })
      .from(schema.links)
      .where(
        and(
          eq(schema.links.tenantId, ctx.tenantId),
          or(inArray(schema.links.fromRef, frontier), inArray(schema.links.toRef, frontier))
        )
      )
      .orderBy(desc(schema.links.createdAt))
      .limit(cap * 10);
    const next: string[] = [];
    for (const row of rows) {
      for (const ref of [row.from, row.to]) {
        if (nodes.has(ref) || !visible(ref)) continue;
        if (nodes.size >= cap) {
          truncated = true;
          continue;
        }
        nodes.set(ref, depth);
        next.push(ref);
      }
      if (nodes.has(row.from) && nodes.has(row.to)) edges.set(`${row.from}\u0000${row.to}`, row);
    }
    frontier = next;
  }

  return {
    nodes: [...nodes].map(([ref, depth]) => ({ ref, depth })),
    edges: [...edges.values()].map(({ from, to }) => ({ from, to })),
    truncated
  };
}

/* --------------------------------------------------------------- erasure */

export interface ForgetNotesResult {
  notes: number;
  links: number;
  redacted: number;
}

/**
 * Erasure link (docs/12 §3), the note-side twin of `forgetMemories`. Deletes
 * the note about the subject, every link to or from it, and — because another
 * record's note may name this person in a link label — rewrites those links in
 * other notes to `[…]`. Answers how many of each, which is what an erasure-log
 * row records.
 *
 * `sameRecord` decides whether a ref *as written in a body* names the subject;
 * a person may have typed a bare id where the link table holds the canonical one.
 */
export async function forgetNotes(
  ctx: Ctx,
  subjectRef: string,
  sameRecord: (ref: string) => boolean = (ref) => ref === subjectRef
): Promise<ForgetNotesResult> {
  const own = await readNote(ctx, subjectRef);
  const linked = await ctx.db
    .select({ id: schema.links.id, noteId: schema.links.noteId, toRef: schema.links.toRef })
    .from(schema.links)
    .where(
      and(
        eq(schema.links.tenantId, ctx.tenantId),
        or(eq(schema.links.fromRef, subjectRef), eq(schema.links.toRef, subjectRef))
      )
    );

  // Other notes that name the subject in their text, found through the link
  // table (the one place that says so without scanning every body).
  const otherIds = [...new Set(linked.filter((l) => l.toRef === subjectRef).map((l) => l.noteId))].filter(
    (noteId) => noteId !== own?.id
  );
  const others = otherIds.length
    ? ((await ctx.db
        .select()
        .from(schema.notes)
        .where(and(eq(schema.notes.tenantId, ctx.tenantId), inArray(schema.notes.id, otherIds)))) as NoteRow[])
    : [];

  const writes: Write[] = [];
  if (linked.length) {
    writes.push(
      ctx.db.delete(schema.links).where(
        and(
          eq(schema.links.tenantId, ctx.tenantId),
          inArray(
            schema.links.id,
            linked.map((l) => l.id)
          )
        )
      )
    );
  }
  if (own) {
    writes.push(ctx.db.delete(schema.notes).where(and(eq(schema.notes.tenantId, ctx.tenantId), eq(schema.notes.id, own.id))));
  }
  for (const note of others) {
    const body = rewriteWikilinks(note.bodyMd, (link) => (sameRecord(link.ref) ? ERASED_LINK : link.raw));
    writes.push(
      ctx.db
        .update(schema.notes)
        .set({ bodyMd: body, version: note.version + 1, updatedAt: ctx.now })
        .where(and(eq(schema.notes.tenantId, ctx.tenantId), eq(schema.notes.id, note.id)))
    );
  }
  await atomically(ctx.db as never, writes);

  const result = { notes: own ? 1 : 0, links: linked.length, redacted: others.length };
  if (result.notes || result.links || result.redacted) {
    await audit(ctx, { action: "core.note.erased", subjectRef, before: result });
  }
  return result;
}

/* ----------------------------------------------------------------- vault */

export interface VaultNote {
  subjectRef: string;
  bodyMd: string;
  updatedAt: number;
}
export interface VaultEntry {
  /** The folder a record's file sits in — its kind, as a reader names it. */
  folder: string;
  /** The record's display name. */
  name: string;
}
export interface VaultFile {
  path: string;
  content: string;
}

/** Characters no file name can carry across the three desktop filesystems, plus Obsidian's link syntax. */
function fileSafe(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

/**
 * An Obsidian vault from a tenant's notes: one `<Folder>/<name>.md` per
 * non-empty note, YAML front matter naming the ref, and every wikilink to a
 * record the vault can name rewritten to `[[<Folder>/<name>|label]]` — the form
 * Obsidian resolves by path. A link to a record it cannot name is left as
 * written, which Obsidian shows as unresolved rather than wrong.
 *
 * Pure; the API does the reads and the zip.
 */
export function buildVault(
  notes: readonly VaultNote[],
  entryFor: (ref: string) => VaultEntry | null,
  resolve: (ref: string) => string | null
): VaultFile[] {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  const pathOf = (ref: string): string | null => {
    const known = paths.get(ref);
    if (known) return known;
    const entry = entryFor(ref);
    if (!entry) return null;
    const folder = fileSafe(entry.folder) || "Records";
    const base = fileSafe(entry.name) || fileSafe(refId(ref)) || "Untitled";
    let path = `${folder}/${base}`;
    if (taken.has(path.toLowerCase())) path = `${folder}/${base} (${fileSafe(refId(ref))})`;
    taken.add(path.toLowerCase());
    paths.set(ref, path);
    return path;
  };

  const written = notes.filter((n) => n.bodyMd.trim());
  // Exported notes claim their paths first, so a record that has a file keeps
  // the plain name and a link-only record is the one that gets disambiguated.
  for (const note of written) pathOf(note.subjectRef);

  return written.flatMap((note) => {
    const path = pathOf(note.subjectRef);
    if (!path) return [];
    const folder = path.slice(0, path.indexOf("/"));
    const body = rewriteWikilinks(note.bodyMd, (link) => {
      const target = resolve(link.ref);
      const to = target ? pathOf(target) : null;
      if (!to) return link.raw;
      return link.label ? `[[${to}|${link.label}]]` : `[[${to}]]`;
    });
    const front = [
      "---",
      `ref: ${JSON.stringify(note.subjectRef)}`,
      `type: ${JSON.stringify(folder)}`,
      `updated: ${JSON.stringify(new Date(note.updatedAt).toISOString())}`,
      "---",
      ""
    ];
    return [{ path: `${path}.md`, content: [...front, body, ""].join("\n") }];
  });
}
