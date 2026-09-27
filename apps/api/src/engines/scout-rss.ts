import { isSignalSourceKind, moduleSettings, type HarvestedSignal, type SignalSource } from "@lyra/core";
import type { PolicyJson } from "@lyra/db";

// docs/30 SCOUT 2, ADR-0101 (accepting ADR-0078's first candidate): a news and
// regulatory RSS/Atom reader, the first SCOUT source that fetches from outside
// LYRA. The rules that make it acceptable live here, in the adapter, and each is
// a test in scout-rss.test.ts:
//
//  - What enters: only a feed URL a tenant configured
//    (`moduleConfig.scout.settings.rssFeeds`), https, a public hostname. The
//    document is parsed by hand with no DTD support at all — any `<!DOCTYPE` or
//    `<!ENTITY` refuses the whole feed, so there is no entity to expand. Only
//    the five predefined entities and numeric references are decoded. Author
//    and byline fields are never read, so nothing personal is kept.
//  - What leaves: one plain GET per feed per harvest, with a generic
//    user-agent and an Accept header — no cookie, no credential, no tenant id,
//    no body — and no redirect followed (a 3xx is a failed feed, never a hop to
//    somewhere the tenant did not name).
//  - Politeness: the nightly harvest is the only caller on a schedule, so each
//    feed is read at most once a night plus whenever a person presses harvest.
//    It never follows an item's link: the feed is the publisher's own offer to
//    be read, a crawl would not be.

/** How many feeds one tenant may configure. A harvest is one request each. */
export const RSS_MAX_FEEDS = 20;
/** Items read from one feed, newest first as publishers order them. */
export const RSS_MAX_ITEMS = 100;
/** A feed larger than this is refused rather than read. */
export const RSS_MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const TITLE_MAX = 300;
const EXCERPT_MAX = 500;
const REF_MAX = 200;

const USER_AGENT = "LyraScout/1.0 (feed reader; one request per feed per night)";

export type FeedKind = "news" | "regulatory";

export interface FeedConfig {
  readonly url: string;
  readonly kind: FeedKind;
}

export interface FeedItem {
  readonly title: string;
  readonly link: string | null;
  readonly guid: string | null;
  /** Null when the feed gave no date, or one no Date can hold. */
  readonly publishedAt: number | null;
  readonly excerpt: string | null;
}

export interface ParsedFeed {
  readonly title: string | null;
  readonly items: FeedItem[];
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/* ---------------------------------------------------------------- config */

/**
 * A hostname that names the inside of a network rather than a publisher: an IP
 * literal of any kind, localhost, a single label, or a reserved private suffix.
 * A publisher's feed has a public DNS name; anything else is refused, which is
 * what keeps a settings blob from becoming a way to probe the deployment.
 */
function internalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.startsWith("[") || /^[\d.]+$/.test(h)) return true;
  if (!h.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(h);
}

function feedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (internalHost(url.hostname)) return null;
  return url.toString();
}

/**
 * The tenant's configured feeds. Read through `moduleSettings`, the one seam
 * every per-module knob goes through, so the existing module-config endpoint
 * is how an operator adds one. A malformed entry is dropped rather than
 * obeyed: the failure mode of a bad setting is fetching less, never more.
 */
export function feedsOf(policy: PolicyJson): FeedConfig[] {
  const raw = moduleSettings(policy, "scout").settings["rssFeeds"];
  if (!Array.isArray(raw)) return [];
  const out: FeedConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    const url = feedUrl(obj ? obj.url : entry);
    const kindRaw = obj?.kind ?? "news";
    const kind = typeof kindRaw === "string" && isSignalSourceKind(kindRaw) && (kindRaw === "news" || kindRaw === "regulatory") ? kindRaw : null;
    if (!url || !kind || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind });
    if (out.length === RSS_MAX_FEEDS) break;
  }
  return out;
}

/* ----------------------------------------------------------------- parse */

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[ref] ?? whole;
  });
}

/** Text content of an element: CDATA unwrapped, tags stripped, entities decoded, whitespace folded. */
function textOf(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const cdata = raw.indexOf("<![CDATA[", i);
    if (cdata === -1) {
      out += decode(raw.slice(i).replace(/<[^>]*>/g, " "));
      break;
    }
    out += decode(raw.slice(i, cdata).replace(/<[^>]*>/g, " "));
    const end = raw.indexOf("]]>", cdata + 9);
    const inner = raw.slice(cdata + 9, end === -1 ? raw.length : end);
    // CDATA holds markup as text; a feed puts HTML there, so strip it too.
    out += inner.replace(/<[^>]*>/g, " ");
    i = end === -1 ? raw.length : end + 3;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Every `<tag …>…</tag>` block in `xml`, by index scanning rather than a
 * backtracking pattern, so a hostile document costs one pass. A block that
 * never closes is dropped.
 */
function blocks(xml: string, tag: string, max: number): string[] {
  const out: string[] = [];
  const lower = xml.toLowerCase();
  const name = tag.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}>`;
  let from = 0;
  while (out.length < max) {
    let start = lower.indexOf(open, from);
    // `<item` must be the whole tag name, not the start of `<itemx`.
    while (start !== -1 && /[\w:-]/.test(lower[start + open.length] ?? "")) start = lower.indexOf(open, start + 1);
    if (start === -1) break;
    const bodyStart = lower.indexOf(">", start);
    if (bodyStart === -1) break;
    if (lower[bodyStart - 1] === "/") {
      out.push("");
      from = bodyStart + 1;
      continue;
    }
    const end = lower.indexOf(close, bodyStart);
    if (end === -1) break;
    out.push(xml.slice(bodyStart + 1, end));
    from = end + close.length;
  }
  return out;
}

const first = (xml: string, tag: string): string | null => {
  const [block] = blocks(xml, tag, 1);
  if (block === undefined) return null;
  const text = textOf(block);
  return text === "" ? null : text;
};

/** Atom puts the URL in an attribute: the alternate link, or the first one. */
function atomLink(xml: string): string | null {
  const tags = xml.match(/<link\b[^>]*>/gi) ?? [];
  const hrefOf = (tag: string): string | null => {
    const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    return m ? decode(m[2] ?? m[3] ?? "") : null;
  };
  const alternate = tags.find((tag) => !/\brel\s*=/i.test(tag) || /\brel\s*=\s*["']alternate["']/i.test(tag));
  return (alternate && hrefOf(alternate)) ?? (tags[0] ? hrefOf(tags[0]) : null);
}

function dateOf(raw: string | null): number | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

const clip = (text: string | null, max: number): string | null => (text === null ? null : text.slice(0, max));

/**
 * Parse an RSS 2.0 or Atom document. Throws on a document type declaration or
 * an entity declaration: a feed has no need of either, and refusing them is
 * the whole defence against entity expansion.
 */
export function parseFeed(xml: string): ParsedFeed {
  if (/<!doctype|<!entity/i.test(xml)) throw new Error("feed carries a DOCTYPE or ENTITY declaration; refused");
  const atom = !/<rss\b|<rdf:rdf\b/i.test(xml) && /<feed\b/i.test(xml);
  const tag = atom ? "entry" : "item";
  // The channel title is whatever precedes the first item.
  const firstItem = xml.search(new RegExp(`<${tag}[\\s>]`, "i"));
  const head = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const title = first(head, "title");

  const items: FeedItem[] = [];
  for (const block of blocks(xml, tag, RSS_MAX_ITEMS)) {
    const itemTitle = first(block, "title");
    const link = atom ? atomLink(block) : first(block, "link");
    if (!itemTitle && !link) continue;
    items.push({
      title: clip(itemTitle ?? link, TITLE_MAX) ?? "",
      link,
      guid: first(block, atom ? "id" : "guid"),
      publishedAt: dateOf(atom ? (first(block, "published") ?? first(block, "updated")) : (first(block, "pubDate") ?? first(block, "dc:date"))),
      excerpt: clip(atom ? (first(block, "summary") ?? first(block, "content")) : first(block, "description"), EXCERPT_MAX)
    });
  }
  return { title, items };
}

/* ----------------------------------------------------------------- fetch */

async function readFeed(fetcher: Fetcher, url: string): Promise<ParsedFeed> {
  const res = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (res.status !== 200) throw new Error(`feed answered ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RSS_MAX_BYTES) throw new Error(`feed is ${declared} bytes, over ${RSS_MAX_BYTES}`);
  const body = await res.text();
  if (body.length > RSS_MAX_BYTES) throw new Error(`feed is over ${RSS_MAX_BYTES} bytes`);
  return parseFeed(body);
}

/**
 * The adapter. `fetcher` is injected so a test never leaves the process and
 * the harvest passes the platform's own `fetch`. One feed failing is logged
 * and costs that feed only; the quiet-source panel shows the silence.
 */
export function rssSource(feeds: readonly FeedConfig[], fetcher: Fetcher, now: number): SignalSource {
  return {
    id: "external.rss",
    kind: "news",
    external: true,
    harvest: async (window) => {
      const out: HarvestedSignal[] = [];
      for (const feed of feeds) {
        let parsed: ParsedFeed;
        try {
          parsed = await readFeed(fetcher, feed.url);
        } catch (err) {
          console.error(`scout rss: ${feed.url} could not be read`, String(err));
          continue;
        }
        const host = new URL(feed.url).hostname;
        for (const item of parsed.items) {
          // An undated item was observed now: that is the only true date we have.
          const observedAt = item.publishedAt ?? now;
          if (observedAt < window.since || observedAt > window.until) continue;
          const key = item.guid ?? item.link ?? item.title;
          const common = { link: item.link, publisher: parsed.title, feed: feed.url };
          out.push({
            source: feed.kind,
            sourceRef: `rss:${host}/${key}`.slice(0, REF_MAX),
            // A regulatory item is recorded as having appeared, never summarised:
            // what it requires is counsel's to say (docs/12), not SCOUT's.
            payload:
              feed.kind === "regulatory"
                ? { title: item.title, ...common, state: "unread" }
                : { headline: item.title, ...common, ...(item.excerpt ? { excerpt: item.excerpt } : {}) },
            observedAt,
            weight: 1
          });
        }
      }
      return out;
    }
  };
}
