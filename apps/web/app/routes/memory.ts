import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { api, ApiError } from "../api.server";
import { cloudflare } from "../context";
import { recordHref } from "../record-href";

// A resource route, not a screen: MemoryPanel (components/memory-panel.tsx) is
// the only caller, for the same reason search.ts and companion.ts exist — the
// session cookie is server-only, so the browser cannot reach /v1/core itself.
// Loaded by the panel after the record renders, so a record screen costs no
// more than it did before the panel existed (ADR-0085).

/* ------------------------------------------------ mirrors of the API shape */

/** Mirrors apps/api/src/routes/notes.ts `GET/PUT /v1/core/notes`. */
export interface NoteResponse {
  subject: string;
  note: { id: string; bodyMd: string; version: number; authorRef: string; updatedAt: number } | null;
}
/** Where a record opens, as notes.ts `locate()` sends it. */
interface Located {
  module: string;
  resource: string;
  id: string;
}
/** Mirrors notes.ts `GET /v1/core/links`. */
export interface LinksResponse {
  to: string;
  links: Array<Located & { fromRef: string; updatedAt: number }>;
  names: Record<string, string>;
}
/** Mirrors notes.ts `GET /v1/core/graph`. */
export interface GraphResponse {
  subject: string;
  nodes: Array<Located & { ref: string; depth: number }>;
  edges: Array<{ from: string; to: string }>;
  truncated: boolean;
  names: Record<string, string>;
}
/** A `core_memories` row as generated CRUD sends it: `*Json` columns hydrated (crud.ts `hydrate`). */
export interface MemoryRow {
  id: string;
  subjectRef: string;
  kind: string;
  contentJson: unknown;
  provenance: string;
  sensitivity: string;
  purposesJson: unknown;
  expiry: number | null;
  createdAt: number;
}

/* ------------------------------------------------------ what the panel reads */

export interface PanelRecord {
  ref: string;
  name: string | null;
  href: string | null;
}

export interface PanelData {
  available: true;
  subject: string;
  note: NoteResponse["note"];
  links: Array<PanelRecord & { updatedAt: number }>;
  graph: { nodes: Array<PanelRecord & { depth: number }>; edges: GraphResponse["edges"]; truncated: boolean };
  /** Null when the reader may not read memories — the tab is absent, not empty. */
  memories: MemoryRow[] | null;
  /** Record id → name and screen, for the wikilinks in the note's body. */
  known: Record<string, { name: string | null; href: string | null }>;
}

export type PanelResponse = PanelData | { available: false; status: number };

const idOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

/** The four responses → the panel's one shape. Pure, so it is tested without a network. */
export function assemble(
  note: NoteResponse,
  links: LinksResponse | null,
  graph: GraphResponse | null,
  memories: MemoryRow[] | null
): PanelData {
  const known: PanelData["known"] = {};
  const place = (at: Located, ref: string, names: Record<string, string>): PanelRecord => {
    const record = { ref, name: names[ref] ?? null, href: recordHref(at.module, at.resource, at.id) };
    known[idOf(ref)] = { name: record.name, href: record.href };
    return record;
  };
  return {
    available: true,
    subject: note.subject,
    note: note.note,
    links: (links?.links ?? []).map((l) => ({ ...place(l, l.fromRef, links?.names ?? {}), updatedAt: l.updatedAt })),
    graph: {
      nodes: (graph?.nodes ?? []).map((n) => ({ ...place(n, n.ref, graph?.names ?? {}), depth: n.depth })),
      edges: graph?.edges ?? [],
      truncated: graph?.truncated ?? false
    },
    memories,
    known
  };
}

/** A panel call the API refused is a thinner panel, never a crashed record. */
const orNull = <T,>(promise: Promise<T>): Promise<T | null> =>
  promise.catch((error: unknown) => {
    if (error instanceof ApiError) return null;
    throw error;
  });

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const { env } = context.get(cloudflare);
  const url = new URL(request.url);
  const subject = url.searchParams.get("subject")?.trim();
  if (!subject) return Response.json({ available: false, status: 400 }, { status: 400 });
  const depth = url.searchParams.get("depth") === "2" ? 2 : 1;
  const opts = { env, request };

  let note: NoteResponse;
  try {
    note = await api<NoteResponse>(`/v1/core/notes?subject=${encodeURIComponent(subject)}`, opts);
  } catch (error) {
    // No notes permission, no read on the record, or no such record: the panel
    // has nothing to say, and says nothing. A signed-out reader included — the
    // record screen around it already owns the login redirect.
    if (error instanceof ApiError) return Response.json({ available: false, status: error.problem.status });
    throw error;
  }

  const canonical = encodeURIComponent(note.subject);
  // Memories are stored under more than one spelling (memory.ts: the seed's
  // `customer:cu_…`, an ORBIT run's bare id), so the filter asks for both.
  const spellings = encodeURIComponent([note.subject, idOf(note.subject)].join(","));
  const [links, graph, memories] = await Promise.all([
    orNull(api<LinksResponse>(`/v1/core/links?to=${canonical}`, opts)),
    orNull(api<GraphResponse>(`/v1/core/graph?subject=${canonical}&depth=${depth}`, opts)),
    orNull(api<{ data: MemoryRow[] }>(`/v1/core/memories?subjectRef=${spellings}&sort=createdAt&order=desc&limit=50`, opts))
  ]);
  return Response.json(assemble(note, links, graph, memories?.data ?? null));
}

export type MemoryActionResult = { ok: true } | { conflict: true } | { problem: ApiError["problem"] };

export async function action({ request, context }: ActionFunctionArgs): Promise<MemoryActionResult> {
  const { env } = context.get(cloudflare);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const opts = { env, request };
  try {
    if (intent === "save") {
      const subject = String(form.get("subject") ?? "");
      await api(`/v1/core/notes?subject=${encodeURIComponent(subject)}`, {
        ...opts,
        method: "PUT",
        body: { bodyMd: String(form.get("bodyMd") ?? ""), version: Number(form.get("version") ?? 0) }
      });
      return { ok: true };
    }
    if (intent === "forget") {
      const id = String(form.get("id") ?? "");
      await api(`/v1/core/memories/${encodeURIComponent(id)}`, { ...opts, method: "DELETE" });
      return { ok: true };
    }
    return { problem: { title: "Unknown intent", status: 400 } };
  } catch (error) {
    if (error instanceof ApiError) {
      return error.problem.status === 409 ? { conflict: true } : { problem: error.problem };
    }
    throw error;
  }
}
