import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useFetcher } from "react-router";
import { AgentBadge, Badge, Button, DateTime, Tabs, Textarea } from "@lyra/ui";
import { formatWikilink } from "@lyra/core/wikilinks";
import type { Translate } from "../i18n";
import { ConfirmButton } from "./confirm";
import { Markdown, type ResolvedLink } from "./markdown";
import type { MemoryActionResult, MemoryRow, PanelData, PanelRecord, PanelResponse } from "../routes/memory";
import type { SearchItem } from "../routes/search";

// ADR-0089, docs/16 H11: a record's memory, Obsidian-shaped. Four views over
// one subject — the note people write about it (with [[links]] to other
// records), the notes that link *to* it, a small graph of what it is connected
// to, and what the platform itself remembers (core_memories), each shown as an
// AI artifact with its ✦ and its "why" (docs/15 §4 pattern 5, inspectable
// provenance). Loaded after the record renders (routes/memory.ts), so the
// record's own fields never wait on it, and absent — not empty — for a reader
// who may read neither notes nor memories (ui.md §4 rule 2).

/* ------------------------------------------------------------ pure helpers */

/**
 * The `[[…` a person is typing at the caret, or null. The picker opens on it;
 * a closed link, a newline or a `|` (already labelled) ends it.
 */
export function pickerQuery(text: string, caret: number): string | null {
  const m = /\[\[([^[\]\n|]*)$/.exec(text.slice(0, caret));
  return m ? m[1]! : null;
}

/** Replace the open `[[query` before the caret with a whole link; answers the new text and caret. */
export function insertLink(text: string, caret: number, id: string, label: string): { text: string; caret: number } {
  const query = pickerQuery(text, caret) ?? "";
  const start = caret - query.length - 2;
  const link = formatWikilink(id, label);
  return { text: text.slice(0, start) + link + text.slice(caret), caret: start + link.length };
}

export interface Placed {
  ref: string;
  x: number;
  y: number;
}

/** Radial layout: the subject at the centre, each ring a hop further out. */
export function layoutGraph(
  nodes: ReadonlyArray<{ ref: string; depth: number }>,
  size = { width: 360, height: 240 }
): Placed[] {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const radii = [0, Math.min(cx, cy) * 0.55, Math.min(cx, cy) * 0.9];
  const byDepth = new Map<number, string[]>();
  for (const n of nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n.ref]);
  const out: Placed[] = [];
  for (const [depth, refs] of byDepth) {
    refs.forEach((ref, i) => {
      if (depth === 0) return out.push({ ref, x: cx, y: cy });
      // Offset each ring by half a step so rings do not line their dots up.
      const angle = (2 * Math.PI * (i + (depth === 2 ? 0.5 : 0))) / refs.length - Math.PI / 2;
      const r = radii[Math.min(depth, 2)]!;
      out.push({ ref, x: Math.round(cx + r * Math.cos(angle)), y: Math.round(cy + r * Math.sin(angle)) });
    });
  }
  return out;
}

/** A memory's content as a person reads it: a sentence, not JSON. */
export function readableContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    try {
      return readableContent(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(readableContent).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? readableContent(v) : String(v)}`)
      .join(" · ");
  }
  return String(value);
}

/**
 * The purposes a memory is bound to. Rows written by `remember()` hold a list;
 * rows seeded earlier hold a `{ purpose: boolean }` map — both are real, so
 * both read (memory.ts `boundTo` accepts only the list, which is its business).
 */
export function purposesOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (Array.isArray(parsed)) return parsed.map(String);
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).filter(([, on]) => on === true).map(([k]) => k);
  }
  return [];
}

const idOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

/* ------------------------------------------------------------- the view */

export interface MemoryViewProps {
  data: PanelData;
  t: Translate;
  locale: string;
  permissions: ReadonlySet<string>;
  /** Which hop count the graph was loaded at. */
  depth: 1 | 2;
  onDepth: (depth: 1 | 2) => void;
  onSave: (bodyMd: string, version: number) => void;
  onForget: (id: string) => void;
  /** Whatever the last save or forget answered. */
  result?: MemoryActionResult | undefined;
  busy?: boolean;
  onReload: () => void;
  /** For a test that renders a tab other than the note. */
  initialTab?: string;
  /** Record search behind the `[[` picker; the container fetches /search. */
  search?: (query: string) => Promise<SearchItem[]>;
}

export function MemoryView(props: MemoryViewProps) {
  const { data, t, permissions } = props;
  const mayNotes = permissions.has("core:notes:read");
  const items = [
    ...(mayNotes
      ? [
          { value: "note", label: t("memory.tab.note"), content: <NotePane {...props} /> },
          {
            value: "links",
            label: `${t("memory.tab.links")} (${data.links.length})`,
            content: <LinksPane {...props} />
          },
          { value: "graph", label: t("memory.tab.graph"), content: <GraphPane {...props} /> }
        ]
      : []),
    // Absent, not empty, for a reader the memories resource refused.
    ...(data.memories
      ? [
          {
            value: "ai",
            label: `${t("memory.tab.ai")} (${data.memories.length})`,
            content: <AiPane {...props} memories={data.memories} />
          }
        ]
      : [])
  ];
  if (!items.length) return null;
  return (
    <section aria-labelledby="memory-title" className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4">
      <h2 id="memory-title" className="eyebrow">
        {t("memory.title")}
      </h2>
      <Tabs items={items} label={t("memory.title")} defaultValue={props.initialTab ?? items[0]!.value} />
    </section>
  );
}

function resolverFor(data: PanelData, t: Translate): (ref: string, label?: string) => ResolvedLink {
  return (ref, label) => {
    const known = data.known[idOf(ref)];
    const text = label ?? known?.name ?? t("memory.note.unnamed");
    return known?.href ? { text, href: known.href } : { text };
  };
}

function NotePane({ data, t, locale, permissions, onSave, result, busy, onReload, search }: MemoryViewProps) {
  const mayWrite = permissions.has("core:notes:write");
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(data.note?.bodyMd ?? "");
  const [caret, setCaret] = useState(0);
  const [hits, setHits] = useState<SearchItem[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const query = editing ? pickerQuery(body, caret) : null;
  const open = query !== null && query !== dismissed;

  // A save that landed closes the editor; the container reloads the panel.
  useEffect(() => {
    if (result && "ok" in result) setEditing(false);
  }, [result]);

  useEffect(() => {
    if (!open || !search || (query ?? "").trim().length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    // ponytail: one timer is the whole debounce, as in search.tsx.
    const timer = setTimeout(() => {
      void search(query!.trim()).then((found) => live && setHits(found.slice(0, 8)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query, search]);

  const pick = (item: SearchItem) => {
    const next = insertLink(body, caret, item.id, item.label);
    setBody(next.text);
    setCaret(next.caret);
    setHits([]);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(body, data.note?.version ?? 0);
  };

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        {data.note?.bodyMd.trim() ? (
          <>
            <Markdown source={data.note.bodyMd} link={resolverFor(data, t)} />
            <p className="font-ui text-12 text-subtle">
              {t("memory.note.edited")} <DateTime value={data.note.updatedAt} locale={locale} precision="minute" />
            </p>
          </>
        ) : (
          <p className="font-ui text-13 text-subtle">{t("memory.note.empty")}</p>
        )}
        {mayWrite ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setBody(data.note?.bodyMd ?? "");
                setEditing(true);
              }}
            >
              {data.note ? t("memory.note.edit") : t("memory.note.write")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="memory-note-body" className="font-ui text-12 text-subtle">
        {t("memory.note.label")}
      </label>
      <Textarea
        id="memory-note-body"
        ref={area}
        name="bodyMd"
        rows={8}
        maxLength={20_000}
        value={body}
        dir="auto"
        aria-describedby="memory-note-hint"
        aria-expanded={open}
        aria-controls={open ? "memory-note-picker" : undefined}
        onChange={(event) => {
          setBody(event.target.value);
          track(event.target);
        }}
        onSelect={(event) => track(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setDismissed(query);
          }
        }}
        className="w-full font-mono text-13"
      />
      <p id="memory-note-hint" className="font-ui text-12 text-subtle">
        {t("memory.note.hint")}
      </p>
      {open ? (
        <div id="memory-note-picker" className="rounded-md border border-border bg-surface-2 p-1">
          {hits.length ? (
            <ul aria-label={t("memory.picker.label")} className="flex flex-col">
              {hits.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => pick(item)}
                    className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-start font-ui text-13 text-text hover:bg-surface-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="ms-auto shrink-0 font-ui text-12 text-subtle">{item.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-1 font-ui text-12 text-subtle" role="status">
              {(query ?? "").trim().length < 2 ? t("memory.picker.prompt") : t("memory.picker.none")}
            </p>
          )}
        </div>
      ) : null}
      {result && "conflict" in result ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 font-ui text-13 text-text">
          <span>{t("memory.note.conflict")}</span>
          <Button type="button" size="sm" variant="ghost" onClick={onReload}>
            {t("memory.note.reload")}
          </Button>
        </div>
      ) : null}
      {result && "problem" in result ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {t("memory.note.failed")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={Boolean(busy)}>
          {t("memory.note.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t("memory.note.cancel")}
        </Button>
      </div>
    </form>
  );
}

function RecordLink({ record, t }: { record: PanelRecord; t: Translate }) {
  const text = record.name ?? t("memory.note.unnamed");
  return record.href ? (
    <Link to={record.href} className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

function LinksPane({ data, t, locale }: MemoryViewProps) {
  if (!data.links.length) return <p className="font-ui text-13 text-subtle">{t("memory.links.empty")}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {data.links.map((link) => (
        <li key={link.ref} className="flex items-baseline gap-3 py-1.5 font-ui text-13">
          <RecordLink record={link} t={t} />
          <span className="ms-auto shrink-0 text-12 text-subtle">
            <DateTime value={link.updatedAt} locale={locale} precision="day" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function GraphPane({ data, t, depth, onDepth }: MemoryViewProps) {
  const size = { width: 360, height: 240 };
  const placed = new Map(layoutGraph(data.graph.nodes, size).map((p) => [p.ref, p]));
  const byRef = new Map(data.graph.nodes.map((n) => [n.ref, n]));
  const lonely = data.graph.nodes.length <= 1;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={t("memory.graph.hops")} className="flex gap-1">
        {([1, 2] as const).map((d) => (
          <Button key={d} type="button" size="sm" variant={d === depth ? "primary" : "ghost"} aria-pressed={d === depth} onClick={() => onDepth(d)}>
            {t(`memory.graph.depth${d}`)}
          </Button>
        ))}
      </div>
      {lonely ? (
        <p className="font-ui text-13 text-subtle">{t("memory.graph.empty")}</p>
      ) : (
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="group"
          aria-label={t("memory.graph.label")}
          className="h-auto w-full max-w-[480px] text-text"
        >
          {data.graph.edges.map((edge) => {
            const a = placed.get(edge.from);
            const b = placed.get(edge.to);
            return a && b ? (
              <line key={`${edge.from}>${edge.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong, currentColor)" strokeOpacity="0.5" strokeWidth="1" />
            ) : null;
          })}
          {data.graph.nodes.map((node) => {
            const at = placed.get(node.ref);
            if (!at) return null;
            const name = byRef.get(node.ref)?.name ?? t("memory.note.unnamed");
            const short = name.length > 18 ? `${name.slice(0, 17)}…` : name;
            const dot = (
              <>
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={node.depth === 0 ? 7 : 5}
                  fill={node.depth === 0 ? "var(--accent)" : "var(--surface-1)"}
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                />
                <text x={at.x} y={at.y + 17} textAnchor="middle" fontSize="10" fill="currentColor">
                  {short}
                </text>
              </>
            );
            // Every other node is a link to its record, reachable by Tab.
            return node.depth > 0 && node.href ? (
              <Link key={node.ref} to={node.href} aria-label={name} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <title>{name}</title>
                {dot}
              </Link>
            ) : (
              <g key={node.ref}>
                <title>{name}</title>
                {dot}
              </g>
            );
          })}
        </svg>
      )}
      {data.graph.truncated ? (
        <p className="font-ui text-12 text-subtle">{t("memory.graph.truncated", { count: data.graph.nodes.length })}</p>
      ) : null}
    </div>
  );
}

function AiPane({ memories, t, locale, permissions, onForget, busy }: MemoryViewProps & { memories: MemoryRow[] }) {
  const mayForget = permissions.has("core:settings:update");
  if (!memories.length) return <p className="font-ui text-13 text-subtle">{t("memory.ai.empty")}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {memories.map((m) => {
        const purposes = purposesOf(m.purposesJson);
        return (
          <li key={m.id} className="flex flex-col gap-1 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <AgentBadge
                why={t("memory.ai.why", {
                  provenance: m.provenance,
                  purposes: purposes.length ? purposes.join(", ") : t("memory.ai.unbound"),
                  sensitivity: m.sensitivity
                })}
              />
              <span className="font-ui text-13 font-medium text-text">{m.kind}</span>
              <Badge tone={m.sensitivity === "high" ? "danger" : m.sensitivity === "medium" ? "warning" : "neutral"}>
                {m.sensitivity}
              </Badge>
            </div>
            <p className="font-ui text-13 text-text" dir="auto">
              {readableContent(m.contentJson)}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 font-ui text-12 text-subtle">
              <span>
                {t("memory.ai.provenance")}: <span className="font-mono">{m.provenance}</span>
              </span>
              <span>
                {t("memory.ai.expires")}:{" "}
                {m.expiry ? <DateTime value={m.expiry} locale={locale} precision="day" /> : t("memory.ai.noExpiry")}
              </span>
              {mayForget ? (
                // The ask re-submits this form once confirmed (confirm.tsx).
                <form
                  className="inline"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onForget(m.id);
                  }}
                >
                  <ConfirmButton type="submit" size="sm" variant="ghost" loading={Boolean(busy)} message={t("memory.ai.forgetConfirm")}>
                    {t("memory.ai.forget")}
                  </ConfirmButton>
                </form>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------------------------------- the container */

export interface MemoryPanelProps {
  /** Any spelling of the record's ref; a bare id is enough. */
  subject: string;
  t: Translate;
  locale: string;
  /** The shell's permission list — decides whether the panel renders at all. */
  permissions: readonly string[];
  className?: string;
}

export function MemoryPanel({ subject, t, locale, permissions, className }: MemoryPanelProps) {
  const held = new Set(permissions);
  const wanted = held.has("core:notes:read") || held.has("core:settings:read");
  const loader = useFetcher<PanelResponse>();
  const writer = useFetcher<MemoryActionResult>();
  const [depth, setDepth] = useState<1 | 2>(1);
  const href = `/memory?subject=${encodeURIComponent(subject)}&depth=${depth}`;

  useEffect(() => {
    if (wanted) void loader.load(href);
    // `loader` is stable per mount; reloading on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href, wanted]);

  // A save or a forget that landed: read the panel again, so the note, its
  // version and the links it derived all come from the server.
  useEffect(() => {
    if (writer.state === "idle" && writer.data && "ok" in writer.data) void loader.load(href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writer.state, writer.data]);

  if (!wanted) return null;
  const data = loader.data;
  if (!data) {
    return (
      <p role="status" className="font-ui text-12 text-subtle">
        {t("memory.loading")}
      </p>
    );
  }
  if (!data.available) return null;

  return (
    <div className={className}>
      <MemoryView
        data={data}
        t={t}
        locale={locale}
        permissions={held}
        depth={depth}
        onDepth={setDepth}
        busy={writer.state !== "idle"}
        result={writer.data}
        onReload={() => void loader.load(href)}
        onSave={(bodyMd, version) =>
          writer.submit({ intent: "save", subject: data.subject, bodyMd, version: String(version) }, { method: "post", action: "/memory" })
        }
        onForget={(id) => writer.submit({ intent: "forget", id }, { method: "post", action: "/memory" })}
        search={(q) =>
          fetch(`/search?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } })
            .then((r) => (r.ok ? (r.json() as Promise<{ items: SearchItem[] }>) : { items: [] }))
            .then((b) => b.items)
            .catch(() => [])
        }
      />
    </div>
  );
}
