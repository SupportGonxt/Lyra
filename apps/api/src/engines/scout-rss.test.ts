import { describe, expect, it, vi } from "vitest";
import { PolicyJson } from "@lyra/db";
import { feedsOf, parseFeed, rssSource, RSS_MAX_BYTES, RSS_MAX_FEEDS, RSS_MAX_ITEMS } from "./scout-rss.js";

// docs/30 SCOUT 2, ADR-0101: the first adapter that fetches from outside LYRA.
// Every rule the ADR states about what may enter and what may leave is a test
// here — https only, no hostnames that name the inside, no document type
// declarations, nothing personal kept, one plain GET carrying nothing of the
// tenant's.

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0);
const DAY = 86_400_000;
const WINDOW = { since: NOW - 7 * DAY, until: NOW };

const policyWith = (settings: Record<string, unknown>): PolicyJson =>
  PolicyJson.parse({ moduleConfig: { scout: { settings } } });

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Gulf Logistics Weekly</title>
    <item>
      <title>Riders move to shift contracts &amp; fleets follow</title>
      <link>https://news.example.com/riders</link>
      <guid>riders-2026-09-25</guid>
      <pubDate>Fri, 25 Sep 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Two platforms <b>say</b> so.</p>]]></description>
      <author>editor@news.example.com (Jane Editor)</author>
    </item>
    <item>
      <title>No date on this one</title>
      <link>https://news.example.com/undated</link>
    </item>
    <item>
      <title>Old news</title>
      <guid>old-1</guid>
      <pubDate>Mon, 01 Jan 2024 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Insurance Authority circulars</title>
  <entry>
    <title type="text">Circular 14/2026 &#8212; health line</title>
    <link rel="alternate" href="https://regulator.example.gov/c/14"/>
    <id>tag:regulator.example.gov,2026:c14</id>
    <updated>2026-09-26T10:00:00Z</updated>
    <summary>What the circular says is counsel's to read.</summary>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("reads RSS 2.0 items: title, link, guid, date, and a tag-free excerpt with entities decoded", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe("Gulf Logistics Weekly");
    expect(feed.items).toHaveLength(3);
    const [first] = feed.items;
    expect(first).toEqual({
      title: "Riders move to shift contracts & fleets follow",
      link: "https://news.example.com/riders",
      guid: "riders-2026-09-25",
      publishedAt: Date.UTC(2026, 8, 25, 8),
      excerpt: "Two platforms say so."
    });
  });

  it("keeps no author: a byline is personal data and the ADR admits none", () => {
    expect(JSON.stringify(parseFeed(RSS))).not.toMatch(/editor@|Jane/);
  });

  it("reads Atom entries, the href of the link, and numeric character references", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Insurance Authority circulars");
    expect(feed.items).toEqual([
      {
        title: "Circular 14/2026 — health line",
        link: "https://regulator.example.gov/c/14",
        guid: "tag:regulator.example.gov,2026:c14",
        publishedAt: Date.UTC(2026, 8, 26, 10),
        excerpt: "What the circular says is counsel's to read."
      }
    ]);
  });

  it("gives an unparseable or absent date as null rather than NaN", () => {
    const [, undated] = parseFeed(RSS).items;
    expect(undated?.publishedAt).toBeNull();
    const bad = parseFeed("<rss><channel><item><title>x</title><pubDate>not a date</pubDate></item></channel></rss>");
    expect(bad.items[0]?.publishedAt).toBeNull();
  });

  it("refuses any document type declaration, so no entity is ever expanded", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss><channel><item><title>&lol2;</title></item></channel></rss>`;
    expect(() => parseFeed(bomb)).toThrow(/doctype/i);
    expect(() => parseFeed(`<rss><!doctype x><channel/></rss>`)).toThrow(/doctype/i);
    expect(() => parseFeed(`<rss><!ENTITY x "y"><channel/></rss>`)).toThrow(/doctype/i);
  });

  it("leaves an unknown named entity as text instead of resolving it", () => {
    const feed = parseFeed("<rss><channel><item><title>A &nbsp; B &unknown; &lt;C&gt;</title></item></channel></rss>");
    expect(feed.items[0]?.title).toBe("A &nbsp; B &unknown; <C>");
  });

  it("stops at RSS_MAX_ITEMS and ignores an item that never closes", () => {
    const many = Array.from({ length: RSS_MAX_ITEMS + 5 }, (_, i) => `<item><title>t${i}</title></item>`).join("");
    expect(parseFeed(`<rss><channel>${many}</channel></rss>`).items).toHaveLength(RSS_MAX_ITEMS);
    expect(parseFeed("<rss><channel><item><title>open").items).toEqual([]);
  });

  it("truncates a long title and excerpt", () => {
    const long = "x".repeat(5_000);
    const [item] = parseFeed(`<rss><channel><item><title>${long}</title><description>${long}</description></item></channel></rss>`).items;
    expect(item?.title.length).toBe(300);
    expect(item?.excerpt?.length).toBe(500);
  });

  it("drops an item with neither a title nor a link — there is nothing to record", () => {
    expect(parseFeed("<rss><channel><item><guid>g</guid></item></channel></rss>").items).toEqual([]);
  });
});

describe("feedsOf", () => {
  it("reads moduleConfig.scout.settings.rssFeeds, a string or {url, kind}", () => {
    const feeds = feedsOf(
      policyWith({
        rssFeeds: ["https://news.example.com/feed", { url: "https://regulator.example.gov/rss", kind: "regulatory" }]
      })
    );
    expect(feeds).toEqual([
      { url: "https://news.example.com/feed", kind: "news" },
      { url: "https://regulator.example.gov/rss", kind: "regulatory" }
    ]);
  });

  it("is empty for a tenant that configured nothing, or configured something that is not a list", () => {
    expect(feedsOf(PolicyJson.parse({}))).toEqual([]);
    expect(feedsOf(policyWith({ rssFeeds: "https://news.example.com/feed" }))).toEqual([]);
  });

  it.each([
    ["plain http", "http://news.example.com/feed"],
    ["a credential in the URL", "https://user:pw@news.example.com/feed"],
    ["localhost", "https://localhost/feed"],
    ["an IPv4 literal", "https://10.0.0.8/feed"],
    ["an IPv6 literal", "https://[::1]/feed"],
    ["a .local name", "https://printer.local/feed"],
    ["an .internal name", "https://api.internal/feed"],
    ["a bare hostname", "https://intranet/feed"],
    ["a non-URL", "not a url"],
    ["a kind the harvest does not know", { url: "https://news.example.com/feed", kind: "quotes" }],
    ["a number", 42]
  ])("drops %s: it fails toward fetching nothing", (_why, entry) => {
    expect(feedsOf(policyWith({ rssFeeds: [entry] }))).toEqual([]);
  });

  it("drops duplicates and stops at RSS_MAX_FEEDS", () => {
    const urls = Array.from({ length: RSS_MAX_FEEDS + 3 }, (_, i) => `https://news${i}.example.com/feed`);
    expect(feedsOf(policyWith({ rssFeeds: [...urls, urls[0]] }))).toHaveLength(RSS_MAX_FEEDS);
    expect(feedsOf(policyWith({ rssFeeds: [urls[0], urls[0]] }))).toHaveLength(1);
  });
});

const ok = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "application/rss+xml", ...headers } });

describe("rssSource", () => {
  it("is external, and harvests each item in the window keyed by feed host and guid", async () => {
    const fetcher = vi.fn(async () => ok(RSS));
    const source = rssSource([{ url: "https://news.example.com/feed", kind: "news" }], fetcher, NOW);
    expect(source.external).toBe(true);
    expect(source.id).toBe("external.rss");

    const items = await source.harvest(WINDOW);
    // The 2024 item is outside the window. The undated one was observed now.
    expect(items.map((one) => one.sourceRef)).toEqual([
      "rss:news.example.com/riders-2026-09-25",
      "rss:news.example.com/https://news.example.com/undated"
    ]);
    expect(items[0]).toMatchObject({
      source: "news",
      observedAt: Date.UTC(2026, 8, 25, 8),
      weight: 1,
      payload: {
        headline: "Riders move to shift contracts & fleets follow",
        link: "https://news.example.com/riders",
        publisher: "Gulf Logistics Weekly",
        feed: "https://news.example.com/feed",
        excerpt: "Two platforms say so."
      }
    });
    expect(items[1]?.observedAt).toBe(NOW);
  });

  it("sends one plain GET that carries nothing of the tenant's and follows no redirect", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ok(RSS));
    await rssSource([{ url: "https://news.example.com/feed", kind: "news" }], fetcher, NOW).harvest(WINDOW);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://news.example.com/feed");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
  });

  it("records a regulatory item's title and link but no excerpt — what it says is counsel's", async () => {
    const fetcher = vi.fn(async () => ok(ATOM));
    const [item] = await rssSource([{ url: "https://regulator.example.gov/rss", kind: "regulatory" }], fetcher, NOW).harvest(WINDOW);
    expect(item?.source).toBe("regulatory");
    expect(item?.payload).toEqual({
      title: "Circular 14/2026 — health line",
      link: "https://regulator.example.gov/c/14",
      publisher: "Insurance Authority circulars",
      feed: "https://regulator.example.gov/rss",
      state: "unread"
    });
  });

  it("one failing feed costs that feed, not the others — a redirect, a 500, a throw, a DOCTYPE, an oversize body", async () => {
    const good = "https://good.example.com/feed";
    const responses: Record<string, () => Promise<Response>> = {
      "https://redirect.example.com/feed": async () => new Response(null, { status: 301, headers: { location: "http://x" } }),
      "https://down.example.com/feed": async () => new Response("no", { status: 500 }),
      "https://throws.example.com/feed": async () => {
        throw new Error("connect ECONNREFUSED");
      },
      "https://doctype.example.com/feed": async () => ok(`<!DOCTYPE rss><rss><channel><item><title>x</title></item></channel></rss>`),
      "https://huge.example.com/feed": async () => ok("<rss>", { "content-length": String(RSS_MAX_BYTES + 1) }),
      "https://huger.example.com/feed": async () => ok(`<rss><channel><item><title>${"x".repeat(RSS_MAX_BYTES)}</title></item></channel></rss>`),
      [good]: async () => ok(RSS)
    };
    const fetcher = vi.fn(async (url: string) => responses[url]!());
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const feeds = Object.keys(responses).map((url) => ({ url, kind: "news" as const }));
    const items = await rssSource(feeds, fetcher, NOW).harvest(WINDOW);
    expect(items.map((one) => one.payload.feed)).toEqual([good, good]);
    expect(error).toHaveBeenCalledTimes(6);
    error.mockRestore();
  });

  it("fetches nothing when no feed is configured", async () => {
    const fetcher = vi.fn(async () => ok(RSS));
    expect(await rssSource([], fetcher, NOW).harvest(WINDOW)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
