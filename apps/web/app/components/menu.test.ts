import { describe, expect, it } from "vitest";
import { translator } from "../i18n";
import { menuFor, switcherFor } from "./menu";

const t = translator("en");
const all = ["axis:cases:read", "axis:policies:read", "axis:claims:read", "ledger:txns:read", "ledger:journals:read"];

describe("menuFor", () => {
  // /axis/board showed Operations' screens and not its lists; /axis/cases the
  // other way round. The menu is the workspace's, wherever the reader stands.
  it("gives a module's list and its bespoke screen the same menu", () => {
    const fromList = menuFor("/axis/cases", all, t, "en");
    const fromScreen = menuFor("/axis/board", all, t, "en");
    expect(fromList).toEqual(fromScreen);
    expect(fromList?.label).toBe("Operations");
    expect(fromList?.screens.map((s) => s.href)).toContain("/axis/board");
    expect(fromList?.records.map((r) => r.href)).toContain("/axis/cases");
  });

  it("offers only what the reader may open", () => {
    const menu = menuFor("/axis", ["axis:cases:read"], t, "en");
    expect(menu?.records.map((r) => r.href)).toEqual(["/axis/cases"]);
    expect(menu?.screens.map((s) => s.href)).not.toContain("/axis/claims/desk");
  });

  it("gives a shared workspace its declared screens (the ledger's reports)", () => {
    const menu = menuFor("/ledger/txns", all, t, "en");
    expect(menu?.label).toBe("Ledger");
    expect(menu?.screens.map((s) => s.href)).toContain("/ledger/reports/trial-balance");
    expect(menu?.accent).toBe("var(--accent)");
  });

  it("has no menu outside a workspace", () => {
    expect(menuFor("/", all, t, "en")).toBeNull();
    expect(menuFor("/settings", all, t, "en")).toBeNull();
  });

  it("is translated", () => {
    expect(menuFor("/axis/cases", all, translator("ar"), "ar")?.label).toBe("العمليات");
  });
});

describe("menu entries are unique", () => {
  it("lists a screen that sits at a list's address once", () => {
    const menu = menuFor("/north/anomalies", ["north:anomalies:read", "north:metrics:read"], t, "en");
    const hrefs = [...(menu?.screens ?? []), ...(menu?.records ?? [])].map((e) => e.href);
    expect(hrefs.filter((h) => h === "/north/anomalies")).toHaveLength(1);
  });
});

describe("switcherFor", () => {
  const groups = [
    { heading: "Modules", items: [{ href: "/axis", label: "Operations" }, { href: "/scout", label: "Market" }] },
    { heading: "Records & finance", items: [{ href: "/ledger", label: "Ledger" }] }
  ];

  // The reader asked "which module am I in?" — every screen of a module answers
  // with that module, in its own hue, however deep the path.
  it("names the module the reader is in, from any depth", () => {
    const s = switcherFor("/scout/whitespace/wsp_1", groups);
    expect(s.current).toEqual({ href: "/scout", label: "Market", hue: "var(--module-scout)" });
    expect(s.entries.filter((e) => e.current).map((e) => e.href)).toEqual(["/scout"]);
  });

  it("offers every module, under the rail's own headings", () => {
    const s = switcherFor("/axis", groups);
    expect(s.entries.map((e) => [e.section, e.href])).toEqual([
      ["Modules", "/axis"],
      ["Modules", "/scout"],
      ["Records & finance", "/ledger"]
    ]);
    expect(s.entries.find((e) => e.href === "/ledger")?.hue).toBe("var(--accent)");
  });

  it("is in no module on Home, Settings or the Inbox", () => {
    for (const path of ["/", "/settings", "/approvals"]) expect(switcherFor(path, groups).current).toBeNull();
  });

  it("does not take /axis-like prefixes for the module", () => {
    expect(switcherFor("/axisx", groups).current).toBeNull();
  });
});
