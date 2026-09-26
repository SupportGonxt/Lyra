import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DESIGN_SLOTS, TEMPLATES, type DesignEdit, type DesignFormat, type DesignSlot, type DesignTemplate } from "@lyra/ui";

// ST2: the studio's canvas editor. The frame is the engine's own SVG, drawn
// inline so its elements can be grabbed; an edit is a nudge and a size on one
// element (packages/ui/src/design.ts clamps both). Every move the pointer makes
// the keyboard makes too.

export type SlotEdits = Partial<Record<DesignSlot, DesignEdit>>;
export interface StoredDesign {
  template: DesignTemplate;
  edits: Partial<Record<DesignFormat, SlotEdits>>;
}

const STILL: DesignEdit = { dx: 0, dy: 0, scale: 1 };
const clampScale = (v: number) => Math.round(Math.min(2, Math.max(0.5, v)) * 100) / 100;

/** A creative's saved design (DesignJson), or the default layout for anything else. */
export function designOf(json: unknown): StoredDesign {
  const value = json as Partial<StoredDesign> | null;
  if (!value || !TEMPLATES.includes(value.template as DesignTemplate)) return { template: "spotlight", edits: {} };
  return { template: value.template as DesignTemplate, edits: value.edits && typeof value.edits === "object" ? value.edits : {} };
}

/** What one key does to the selected element; null for a key the canvas does not own. */
export function keyEdit(edit: DesignEdit, key: string, shift: boolean): DesignEdit | null {
  const step = shift ? 20 : 4;
  switch (key) {
    case "ArrowLeft":
      return { ...edit, dx: edit.dx - step };
    case "ArrowRight":
      return { ...edit, dx: edit.dx + step };
    case "ArrowUp":
      return { ...edit, dy: edit.dy - step };
    case "ArrowDown":
      return { ...edit, dy: edit.dy + step };
    case "+":
    case "=":
      return { ...edit, scale: clampScale(edit.scale + 0.05) };
    case "-":
      return { ...edit, scale: clampScale(edit.scale - 0.05) };
    case "0":
      return STILL;
    default:
      return null;
  }
}

export function DesignCanvas({
  svg,
  width,
  height,
  edits,
  onChange,
  l
}: {
  svg: string;
  width: number;
  height: number;
  edits: SlotEdits;
  onChange: (next: SlotEdits) => void;
  l: (key: string) => string;
}) {
  const [slot, setSlot] = useState<DesignSlot>("headline");
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const edit = edits[slot] ?? STILL;
  const set = (next: DesignEdit) => onChange({ ...edits, [slot]: next });

  // Outline the selected element: its box in frame units, drawn as a percentage
  // overlay so it follows the frame at any on-screen size.
  useEffect(() => {
    const g = frame.current?.querySelector<SVGGraphicsElement>(`[data-slot="${slot}"]`);
    if (!g) return setBox(null);
    const b = g.getBBox();
    const m = g.transform.baseVal.consolidate()?.matrix;
    const s = m ? m.a : 1;
    setBox({ x: b.x * s + (m?.e ?? 0), y: b.y * s + (m?.f ?? 0), w: b.width * s, h: b.height * s });
  }, [slot, svg]);

  const onKeyDown = (event: KeyboardEvent) => {
    const next = keyEdit(edit, event.key, event.shiftKey);
    if (!next) return;
    event.preventDefault();
    set(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const hit = (event.target as Element).closest?.("[data-slot]")?.getAttribute("data-slot") as DesignSlot | null;
    if (hit) setSlot(hit);
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !frame.current) return;
    // Screen pixels to frame pixels: the frame is drawn scaled to fit.
    const ratio = width / frame.current.getBoundingClientRect().width;
    const dx = (event.clientX - drag.current.x) * ratio;
    const dy = (event.clientY - drag.current.y) * ratio;
    drag.current = { x: event.clientX, y: event.clientY };
    const current = edits[slot] ?? STILL;
    onChange({ ...edits, [slot]: { ...current, dx: Math.round(current.dx + dx), dy: Math.round(current.dy + dy) } });
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={l("studio.canvasElement")} className="flex flex-wrap gap-1">
        {DESIGN_SLOTS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === slot}
            onClick={() => setSlot(name)}
            className={`rounded-md border px-2 py-1 font-ui text-12 ${name === slot ? "border-accent bg-surface-2 text-text" : "border-border text-muted"}`}
          >
            {l(`studio.slot.${name}`)}
          </button>
        ))}
      </div>
      <div
        ref={frame}
        role="application"
        tabIndex={0}
        aria-label={l("studio.canvasHint")}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        className="relative w-full max-w-[420px] cursor-move touch-none overflow-hidden rounded-md border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        {box ? (
          <span
            aria-hidden
            className="pointer-events-none absolute border-2 border-dashed border-accent"
            style={{ left: `${(box.x / width) * 100}%`, top: `${(box.y / height) * 100}%`, width: `${(box.w / width) * 100}%`, height: `${(box.h / height) * 100}%` }}
          />
        ) : null}
      </div>
      <p className="font-ui text-12 text-muted">{l("studio.canvasHint")}</p>
      <label className="flex items-center gap-2 font-ui text-12 text-muted">
        {l("studio.canvasSize")}
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={edit.scale}
          onChange={(event) => set({ ...edit, scale: clampScale(Number(event.target.value)) })}
        />
      </label>
    </div>
  );
}
