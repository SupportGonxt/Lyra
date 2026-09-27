import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GridPreview, TileList } from "./dashboard-editor";
import type { TileSpec } from "../dashboard-layout";

// docs/30 Analytics 5: reordering tiles must not be drag-only (WCAG 2.2 2.5.7).
// The web suite has no DOM, so `TileList` is stateless on purpose: its element
// tree is walked here and the handlers a key press or a click would reach are
// called directly — the same functions the browser calls.

const tile = (key: string, span = 4): TileSpec => ({ key, viz: "number", span, definition: { dataset: "policies", metrics: ["gwp"] } });
const TILES = [tile("A"), tile("B", 6), tile("C", 12)];
const l = (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key);

function props(onChange = vi.fn()) {
  return { tiles: TILES, onChange, describe: (t: TileSpec) => `about ${t.key}`, l, idBase: "ed", announcement: "" };
}

type Node = React.ReactElement<Record<string, unknown>>;

/** Every element in the tree `TileList` returns, without rendering components. */
function walk(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;
  const el = node as Node;
  out.push(el);
  walk(el.props.children, out);
  return out;
}

const items = (tree: unknown) => walk(tree).filter((el) => el.type === "li");
const press = (key: string, altKey = true) => {
  const preventDefault = vi.fn();
  return { event: { key, altKey, preventDefault }, preventDefault };
};

describe("TileList keyboard reorder", () => {
  it("moves the focused tile down one place with Alt+ArrowDown and says where it went", () => {
    const onChange = vi.fn();
    const li = items(TileList(props(onChange)))[0]!;
    const { event, preventDefault } = press("ArrowDown");
    (li.props.onKeyDown as (e: unknown) => void)(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next, moved] = onChange.mock.calls[0]!;
    expect((next as TileSpec[]).map((t) => t.key)).toEqual(["B", "A", "C"]);
    expect(moved).toBe(1);
  });

  it("moves to either end with Alt+Home and Alt+End", () => {
    const onChange = vi.fn();
    const list = items(TileList(props(onChange)));
    (list[2]!.props.onKeyDown as (e: unknown) => void)(press("Home").event);
    expect((onChange.mock.calls[0]![0] as TileSpec[]).map((t) => t.key)).toEqual(["C", "A", "B"]);
    (list[0]!.props.onKeyDown as (e: unknown) => void)(press("End").event);
    expect((onChange.mock.calls[1]![0] as TileSpec[]).map((t) => t.key)).toEqual(["B", "C", "A"]);
  });

  it("leaves plain arrows to the page and does nothing at the edge", () => {
    const onChange = vi.fn();
    const list = items(TileList(props(onChange)));
    const plain = press("ArrowDown", false);
    (list[0]!.props.onKeyDown as (e: unknown) => void)(plain.event);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    (list[0]!.props.onKeyDown as (e: unknown) => void)(press("ArrowUp").event);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers every move as a labelled button too, disabled where it cannot go", () => {
    const onChange = vi.fn();
    const buttons = walk(TileList(props(onChange))).filter((el) => typeof el.props["aria-label"] === "string" && el.props.onClick);
    const up = buttons.filter((b) => String(b.props["aria-label"]).startsWith("moveUp"));
    const down = buttons.filter((b) => String(b.props["aria-label"]).startsWith("moveDown"));
    expect(up.map((b) => Boolean(b.props.disabled))).toEqual([true, false, false]);
    expect(down.map((b) => Boolean(b.props.disabled))).toEqual([false, false, true]);
    (up[2]!.props.onClick as () => void)();
    expect((onChange.mock.calls[0]![0] as TileSpec[]).map((t) => t.key)).toEqual(["A", "C", "B"]);
    const remove = buttons.find((b) => String(b.props["aria-label"]).startsWith("removeTile:B"))!;
    (remove.props.onClick as () => void)();
    expect((onChange.mock.calls[1]![0] as TileSpec[]).map((t) => t.key)).toEqual(["A", "C"]);
  });

  it("renders each tile focusable, names the shortcut, and carries a polite live region", () => {
    const html = renderToStaticMarkup(<TileList {...props()} announcement="moved" />);
    expect(html.match(/tabindex="0"/g)?.length).toBe(3);
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End"');
    expect(html).toContain('id="ed-tile-1"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("moved");
    expect(html).toContain("reorderHint");
    expect(html).toContain("about B");
  });
});

describe("GridPreview", () => {
  it("lays the tiles out at their spans on the twelve-column grid", () => {
    const html = renderToStaticMarkup(<GridPreview tiles={TILES} label={l("preview")} />);
    expect(html).toContain("lg:col-span-4");
    expect(html).toContain("lg:col-span-6");
    expect(html).toContain("lg:col-span-12");
    expect(html).toContain(`aria-label=${JSON.stringify(l("preview"))}`);
  });
});
