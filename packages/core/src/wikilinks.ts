// ADR-0089. The link grammar of a record note: `[[ref]]` or `[[ref|label]]`,
// the Obsidian shape, where `ref` is a record ref (`cu_…`, `customer:cu_…`)
// rather than a file name. Pure on purpose — the API derives `core_links` from
// this on every save, the vault export rewrites through it, and a parser that
// disagreed with itself between those two would make the backlinks panel and
// the exported vault tell different stories about the same note.

export interface Wikilink {
  /** The ref as written, trimmed. Never empty, never contains whitespace. */
  ref: string;
  /** Display text after the `|`, trimmed; absent when none was written. */
  label?: string;
  /** The exact source text, so a rewrite can leave everything else alone. */
  raw: string;
  /** Offset of `raw` in the source. */
  index: number;
}

/** A record ref is a prefixed ULID with an optional scope; 200 is generous. */
export const MAX_REF_LENGTH = 200;

const LINK = /\[\[([^[\]\n\r|]*)(?:\|([^[\]\n\r]*))?\]\]/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * Ranges a link inside must not be read from: fenced blocks and inline code.
 * Obsidian does not resolve a link written as code, and a note that documents
 * the syntax (`[[cu_…]]` in backticks) must not grow a backlink for it.
 */
function codeRanges(md: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fenceStart = -1;
  const prose: Array<[number, number]> = [];
  let proseStart = 0;
  for (const line of md.split("\n")) {
    const isFence = line.trimStart().startsWith("```");
    if (isFence && fenceStart < 0) {
      fenceStart = offset;
      prose.push([proseStart, offset]);
    } else if (isFence) {
      ranges.push([fenceStart, offset + line.length]);
      fenceStart = -1;
      proseStart = offset + line.length;
    }
    offset += line.length + 1;
  }
  // An unclosed fence runs to the end, as it renders.
  if (fenceStart >= 0) ranges.push([fenceStart, md.length]);
  else prose.push([proseStart, md.length]);

  for (const [from, to] of prose) {
    for (const m of md.slice(from, to).matchAll(INLINE_CODE)) {
      ranges.push([from + m.index, from + m.index + m[0].length]);
    }
  }
  return ranges;
}

/** Every link outside code, in order, duplicates included. */
export function parseWikilinks(md: string): Wikilink[] {
  const code = codeRanges(md);
  const out: Wikilink[] = [];
  for (const m of md.matchAll(LINK)) {
    const start = m.index;
    const end = start + m[0].length;
    if (code.some(([from, to]) => start < to && end > from)) continue;
    const ref = (m[1] ?? "").trim();
    if (!ref || /\s/.test(ref) || ref.length > MAX_REF_LENGTH) continue;
    const label = m[2]?.trim();
    out.push({ ref, ...(label ? { label } : {}), raw: m[0], index: start });
  }
  return out;
}

/** Each linked ref once, in order of first appearance, with the first label written for it. */
export function linkTargets(md: string): Array<{ ref: string; label?: string }> {
  const seen = new Map<string, { ref: string; label?: string }>();
  for (const link of parseWikilinks(md)) {
    const known = seen.get(link.ref);
    if (!known) seen.set(link.ref, link.label ? { ref: link.ref, label: link.label } : { ref: link.ref });
    else if (!known.label && link.label) known.label = link.label;
  }
  return [...seen.values()];
}

/** Replace each link (outside code) with whatever `to` returns; the rest is untouched. */
export function rewriteWikilinks(md: string, to: (link: Wikilink) => string): string {
  let out = "";
  let at = 0;
  for (const link of parseWikilinks(md)) {
    out += md.slice(at, link.index) + to(link);
    at = link.index + link.raw.length;
  }
  return out + md.slice(at);
}

/**
 * What the editor's `[[` picker inserts. A label is the record's display name,
 * which may hold any character a person can type — brackets, a pipe, a
 * backtick — so those become spaces rather than ending the link early.
 */
export function formatWikilink(ref: string, label?: string): string {
  const clean = (label ?? "").replace(/[[\]|`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `[[${ref}|${clean}]]` : `[[${ref}]]`;
}
