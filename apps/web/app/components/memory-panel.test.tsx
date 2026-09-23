import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { translator } from "../i18n";
import { insertLink, layoutGraph, MemoryView, pickerQuery, purposesOf, readableContent } from "./memory-panel";
import type { PanelData } from "../routes/memory";

// ADR-0085. The panel's rules that do not need a browser: what the `[[`
// picker reads and writes, where the graph puts a dot, how a memory reads,
// and that each tab is withheld — not emptied — for a reader who may not
// read what is behind it (ui.md §4 rule 2).

const t = translator("en");
const noop = () => undefined;

const DATA: PanelData = {
  available: true,
  subject: "customer:cu_1",
  note: { id: "nte_1", bodyMd: "Renewal due. See [[pol_1|motor]] and [[zz_9]].", version: 2, authorRef: "user:us_1", updatedAt: 1_700_000_000_000 },
  links: [{ ref: "policy:pol_1", name: "MTR-0001", href: "/axis/policies/pol_1", updatedAt: 1_700_000_000_000 }],
  graph: {
    nodes: [
      { ref: "customer:cu_1", depth: 0, name: "Falcon Freight", href: "/admin/customers/cu_1" },
      { ref: "policy:pol_1", depth: 1, name: "MTR-0001", href: "/axis/policies/pol_1" }
    ],
    edges: [{ from: "customer:cu_1", to: "policy:pol_1" }],
    truncated: false
  },
  memories: [
    {
      id: "mem_1",
      subjectRef: "customer:cu_1",
      kind: "preference",
      contentJson: { preferredChannel: "whatsapp" },
      provenance: "stated_by_customer",
      sensitivity: "low",
      purposesJson: { marketing: false, profiling: true },
      expiry: null,
      createdAt: 1_699_000_000_000
    }
  ],
  known: { pol_1: { name: "MTR-0001", href: "/axis/policies/pol_1" } }
};

function render(perms: string[], tab?: string, data: PanelData = DATA) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MemoryView
        data={data}
        t={t}
        locale="en"
        permissions={new Set(perms)}
        depth={1}
        onDepth={noop}
        onSave={noop}
        onForget={noop}
        onReload={noop}
        {...(tab ? { initialTab: tab } : {})}
      />
    </MemoryRouter>
  );
}

describe("the [[ picker", () => {
  it("reads the open link at the caret, and nothing once it closes", () => {
    expect(pickerQuery("see [[fal", 9)).toBe("fal");
    expect(pickerQuery("see [[", 6)).toBe("");
    expect(pickerQuery("see [[cu_1]] x", 14)).toBeNull();
    expect(pickerQuery("see [[cu_1|lab", 14)).toBeNull();
    expect(pickerQuery("[[a\nb", 5)).toBeNull();
  });

  it("replaces what was typed with a whole link and puts the caret after it", () => {
    const out = insertLink("see [[fal and more", 9, "cu_1", "Falcon [Freight]");
    expect(out.text).toBe("see [[cu_1|Falcon Freight]] and more");
    expect(out.caret).toBe("see [[cu_1|Falcon Freight]]".length);
  });
});

describe("layoutGraph", () => {
  it("centres the subject and rings each hop further out, inside the frame", () => {
    const placed = layoutGraph([
      { ref: "a", depth: 0 },
      { ref: "b", depth: 1 },
      { ref: "c", depth: 1 },
      { ref: "d", depth: 2 }
    ]);
    expect(placed.find((p) => p.ref === "a")).toEqual({ ref: "a", x: 180, y: 120 });
    const dist = (r: string) => {
      const p = placed.find((q) => q.ref === r)!;
      return Math.hypot(p.x - 180, p.y - 120);
    };
    expect(dist("d")).toBeGreaterThan(dist("b"));
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(360);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(240);
    }
  });
});

describe("memory content", () => {
  it("reads as a sentence, and both stored purpose shapes read", () => {
    expect(readableContent({ language: "en", vehicles: 1 })).toBe("language: en · vehicles: 1");
    expect(readableContent('{"text":"x"}')).toBe("text: x");
    expect(purposesOf(["orbit.reply"])).toEqual(["orbit.reply"]);
    expect(purposesOf({ marketing: false, profiling: true })).toEqual(["profiling"]);
    expect(purposesOf("not json")).toEqual([]);
  });
});

describe("MemoryView", () => {
  it("renders the note with its links resolved, and an edit door for a writer", () => {
    const html = render(["core:notes:read", "core:notes:write"]);
    expect(html).toContain('href="/axis/policies/pol_1"');
    const shown = "motor";
    expect(html).toContain(`>${shown}</a>`);
    expect(html).toContain(t("memory.note.edit"));
    // Named nothing the panel knows: text, not a link to nowhere.
    expect(html).toContain(t("memory.note.unnamed"));
  });

  it("offers no edit to a reader who may only read", () => {
    expect(render(["core:notes:read"])).not.toContain(t("memory.note.edit"));
  });

  it("withholds the note tabs from a reader without notes, and the AI tab when memories were refused", () => {
    const aiOnly = render(["core:settings:read"]);
    expect(aiOnly).not.toContain(t("memory.tab.note"));
    expect(aiOnly).toContain(t("memory.tab.ai"));
    const notesOnly = render(["core:notes:read"], undefined, { ...DATA, memories: null });
    expect(notesOnly).not.toContain(t("memory.tab.ai"));
    expect(render([], undefined, { ...DATA, memories: null })).toBe("");
  });

  it("marks every remembered fact as the platform's, with its why", () => {
    const html = render(["core:settings:read", "core:settings:update"], "ai");
    expect(html).toContain("✦");
    expect(html).toContain("preferredChannel: whatsapp");
    expect(html).toContain(t("memory.ai.forget"));
    expect(render(["core:settings:read"], "ai")).not.toContain(t("memory.ai.forget"));
  });

  it("draws the graph as links a keyboard can reach", () => {
    const html = render(["core:notes:read"], "graph");
    expect(html).toContain("<svg");
    const anchor = html.match(/<a [^>]*href="\/axis\/policies\/pol_1"[^>]*>/)?.[0] ?? "";
    expect(anchor).toContain(`aria-label=${JSON.stringify(DATA.graph.nodes[1]!.name)}`);
  });

  it("says so when nothing links here", () => {
    const html = render(["core:notes:read"], "links", { ...DATA, links: [] });
    expect(html).toContain(t("memory.links.empty").replace("'", "&#x27;"));
  });
});
