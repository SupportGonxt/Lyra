import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { parseWikilinks } from "@lyra/core/wikilinks";

// ADR-0089. The smallest markdown a record note needs — headings, paragraphs,
// lists, quotes, code, emphasis, links and [[wikilinks]] — and no more, with no
// dependency. It returns React elements, never an HTML string: there is no
// `dangerouslySetInnerHTML` anywhere below, so whatever a person typed reaches
// the screen as text, and escaping is a property of the structure rather than a
// rule every branch has to remember.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Lines → blocks. Pure, so the structure is testable without rendering. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(pattern.exec(lines[i++]!)![1]!.trim());
      out.push({ kind: "list", ordered, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push({ kind: "quote", lines: quoted });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !HEADING.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !NUMBERED.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith("```")
    ) {
      para.push(lines[i++]!.trim());
    }
    out.push({ kind: "paragraph", lines: para });
  }
  return out;
}

/**
 * A link target a note may carry: the web, mail, or a path on this site. A
 * scheme-relative `//host` and the `/\` a browser normalises into one are both
 * another site wearing a path's clothes, and everything else — `javascript:`,
 * `data:`, `vbscript:` in any case or with leading space — is refused.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href) || /^mailto:[^\s]+$/i.test(href)) return href;
  if (/^\/(?![/\\])[^\s]*$/.test(href)) return href;
  return null;
}

export interface ResolvedLink {
  text: string;
  /** Absent when the record cannot be opened by this reader, or names nothing. */
  href?: string;
}

export interface MarkdownProps {
  source: string;
  /** A wikilink's display text and screen, from the panel's loaded names. */
  link: (ref: string, label?: string) => ResolvedLink;
  className?: string;
}

const LINK_CLASS = "text-accent underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Emphasis and markdown links within a run of text that holds no code and no wikilink. */
function emphasis(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = `${key}.${n++}`;
    if (m[1] ?? m[2]) out.push(<strong key={k}>{emphasis((m[1] ?? m[2])!, k)}</strong>);
    else if (m[3] ?? m[4]) out.push(<em key={k}>{emphasis((m[3] ?? m[4])!, k)}</em>);
    else {
      const href = safeHref(m[6]!);
      const label = m[5]!;
      if (!href) out.push(label);
      else if (href.startsWith("/"))
        out.push(
          <Link key={k} to={href} className={LINK_CLASS}>
            {label}
          </Link>
        );
      else
        out.push(
          <a key={k} href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
            {label}
          </a>
        );
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** One line of inline markdown: code spans first, then wikilinks, then emphasis. */
function inline(text: string, link: MarkdownProps["link"], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(`[^`\n]*`)/g);
  parts.forEach((part, p) => {
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={`${key}.c${p}`} className="rounded-sm bg-surface-2 px-1 font-mono text-12">
          {part.slice(1, -1)}
        </code>
      );
      return;
    }
    let at = 0;
    for (const wl of parseWikilinks(part)) {
      if (wl.index > at) out.push(...emphasis(part.slice(at, wl.index), `${key}.${p}.${at}`));
      const resolved = link(wl.ref, wl.label);
      const k = `${key}.w${p}.${wl.index}`;
      out.push(
        resolved.href ? (
          <Link key={k} to={resolved.href} className={LINK_CLASS} data-wikilink={wl.ref}>
            {resolved.text}
          </Link>
        ) : (
          // Named but not openable: shown as what it is, never a link to nowhere.
          <span key={k} className="text-subtle" data-wikilink={wl.ref}>
            {resolved.text}
          </span>
        )
      );
      at = wl.index + wl.raw.length;
    }
    if (at < part.length) out.push(...emphasis(part.slice(at), `${key}.${p}.${at}`));
  });
  return out;
}

/** Headings in a note sit under the record's own h1 and the panel's h2. */
const HEADINGS = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

export function Markdown({ source, link, className }: MarkdownProps) {
  return (
    <div className={`flex flex-col gap-2 font-ui text-13 leading-relaxed text-text ${className ?? ""}`}>
      {blocks(source).map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "heading": {
            const Tag = HEADINGS[block.level - 1] ?? "h6";
            return (
              <Tag key={key} className={block.level <= 2 ? "font-ui text-16 font-semibold text-text" : "font-ui text-13 font-medium text-text"}>
                {inline(block.text, link, key)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={key}>
                {block.lines.map((line, l) => (
                  <Fragment key={l}>
                    {l > 0 ? <br /> : null}
                    {inline(line, link, `${key}.${l}`)}
                  </Fragment>
                ))}
              </p>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key} className={`flex flex-col gap-1 ps-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
                {block.items.map((item, n) => (
                  <li key={n}>{inline(item, link, `${key}.${n}`)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="border-s-2 border-border ps-3 text-subtle">
                {block.lines.map((line, l) => (
                  <Fragment key={l}>
                    {l > 0 ? <br /> : null}
                    {inline(line, link, `${key}.${l}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "code":
            return (
              <pre key={key} className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-12">
                <code>{block.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
