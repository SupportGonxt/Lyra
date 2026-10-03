import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MARK } from "@lyra/ui";

vi.mock("../api.server", () => ({ api: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { BriefProvenance, briefAge, loader, todayOf } from "./north-brief";

// J-E1 "the 7am read". After a simulated month with no model the newest exec
// brief was 31 days old and /north/brief presented it as the morning's read.
// The screen now says what day a brief is from, and says plainly when that is
// not today. And a template brief (generatedBy "template", written with no
// model) is not an AI artifact, so it carries no ✦ (docs/15).

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("briefAge", () => {
  it("counts whole days between the brief's date and today", () => {
    expect(briefAge("2026-09-29", "2026-09-29")).toBe(0);
    expect(briefAge("2026-09-28", "2026-09-29")).toBe(1);
    expect(briefAge("2026-08-29", "2026-09-29")).toBe(31);
  });

  it("has no age for a date it cannot read", () => {
    expect(briefAge("not-a-day", "2026-09-29")).toBeNull();
  });
});

describe("todayOf", () => {
  it("is the replay moment's day under ?asOf=, else the clock's", () => {
    expect(todayOf("1700000000000", Date.UTC(2026, 8, 29))).toBe("2023-11-14");
    expect(todayOf(undefined, Date.UTC(2026, 8, 29, 23, 59))).toBe("2026-09-29");
    expect(todayOf("abc", Date.UTC(2026, 8, 29))).toBe("2026-09-29");
  });
});

describe("BriefProvenance", () => {
  const model = { date: "2026-09-29", generatedBy: "ai", aiAuditId: "aud_1" };
  const template = { date: "2026-09-29", generatedBy: "template", aiAuditId: null };

  it("shows the brief's date, and no stale notice for today's", () => {
    const html = renderToStaticMarkup(<BriefProvenance brief={model} today="2026-09-29" locale="en" />);
    expect(strip(html)).toContain("2026-09-29");
    expect(strip(html)).not.toMatch(/not today/i);
  });

  it("says plainly when the newest brief is older than a day", () => {
    const html = renderToStaticMarkup(
      <BriefProvenance brief={{ ...model, date: "2026-08-29" }} today="2026-09-29" locale="en" />
    );
    expect(strip(html)).toMatch(/2026-08-29/);
    expect(strip(html)).toMatch(/31 days ago/);
    expect(strip(html)).toMatch(/not today's/i);
    expect(html).toContain('role="status"');
  });

  it("says it in Arabic to an Arabic reader", () => {
    const html = renderToStaticMarkup(
      <BriefProvenance brief={{ ...model, date: "2026-08-29" }} today="2026-09-29" locale="ar" />
    );
    expect(strip(html)).toContain("ليست إحاطة اليوم");
    expect(strip(html)).not.toMatch(/not today/i);
  });

  it("does not call yesterday's brief stale", () => {
    const html = renderToStaticMarkup(
      <BriefProvenance brief={{ ...model, date: "2026-09-28" }} today="2026-09-29" locale="en" />
    );
    expect(strip(html)).not.toMatch(/not today/i);
  });

  it("marks a model brief with ✦ and a template brief without it", () => {
    expect(renderToStaticMarkup(<BriefProvenance brief={model} today="2026-09-29" locale="en" />)).toContain(AGENT_MARK);
    const html = renderToStaticMarkup(<BriefProvenance brief={template} today="2026-09-29" locale="en" />);
    expect(html).not.toContain(AGENT_MARK);
    expect(strip(html)).toMatch(/template/i);
  });
});

describe("north-brief loader today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands the screen today's date, and the replay moment's under ?asOf=", async () => {
    vi.mocked(api).mockResolvedValue({ data: [] });
    const context = { get: () => ({ env: {} }) };
    const live = await loader({ request: new Request("https://lyra.test/north/brief"), context } as never);
    expect(live.today).toBe(new Date().toISOString().slice(0, 10));
    const replay = await loader({
      request: new Request("https://lyra.test/north/brief?asOf=1700000000000"),
      context
    } as never);
    expect(replay.today).toBe("2023-11-14");
  });
});
