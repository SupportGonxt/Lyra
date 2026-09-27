import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS, POLL_MS, VISITOR_COOKIE, visitorCookie, visitorFrom } from "./portal.$tenantSlug.chat";

// docs/30 ORBIT 4, ADR-0099: the storefront's web chat. The visitor token is
// the only credential the conversation has, so it lives in an HttpOnly cookie
// scoped to this one page and is handed to the API as a header by the loader —
// never to page script, never in a URL.

describe("the visitor cookie", () => {
  it("is HttpOnly and scoped to this tenant's chat page alone", () => {
    const cookie = visitorCookie("gonxt", "tok_abc", { secure: true });
    expect(cookie).toContain(`${VISITOR_COOKIE}=tok_abc`);
    expect(cookie).toContain("Path=/portal/gonxt/chat");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("drops Secure on plain http, where the browser would otherwise refuse to store it", () => {
    expect(visitorCookie("gonxt", "tok_abc", { secure: false })).not.toContain("Secure");
  });

  it("reads the token back out of a cookie header among others", () => {
    expect(visitorFrom(`lyra_session=s1; ${VISITOR_COOKIE}=tok_abc; theme=dark`)).toBe("tok_abc");
  });

  it("is nothing when the header is absent or carries no token", () => {
    expect(visitorFrom(null)).toBeNull();
    expect(visitorFrom("lyra_session=s1")).toBeNull();
    expect(visitorFrom(`${VISITOR_COOKIE}=`)).toBeNull();
  });
});

describe("polling", () => {
  it("asks no faster than the API's per-IP poll ceiling allows for a few tabs", () => {
    // 600 polls per 10 minutes per IP (routes/portal.ts CHAT_POLL_IP_MAX).
    expect(POLL_MS).toBeGreaterThanOrEqual(4000);
  });
});

describe("the page carries the tenant's brand, never ours", () => {
  it("has no hard-coded platform name anywhere in the surface", () => {
    const source = readFileSync(join(import.meta.dirname, "portal.$tenantSlug.chat.tsx"), "utf8");
    expect(source).not.toMatch(/\bLYRA\b/);
    for (const table of Object.values(LABELS)) {
      for (const value of Object.values(table)) expect(value).not.toMatch(/LYRA/i);
    }
  });

  it("never names an industry noun, so the page sells outside insurance too", () => {
    for (const value of Object.values(LABELS.en ?? {})) expect(value).not.toMatch(/\b(policy|premium|insurer|claim)/i);
  });
});

describe("this screen's own labels speak both locales", () => {
  it("has the same keys in en and ar", () => {
    expect(Object.keys(LABELS.ar ?? {}).sort()).toEqual(Object.keys(LABELS.en ?? {}).sort());
  });

  it("never leaves an Arabic string empty or identical to the English", () => {
    for (const [key, english] of Object.entries(LABELS.en ?? {})) {
      const arabic = LABELS.ar?.[key] ?? "";
      expect(arabic.trim(), key).not.toBe("");
      expect(arabic, key).not.toBe(english);
    }
  });
});
