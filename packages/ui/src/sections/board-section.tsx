import * as React from "react";
import { AGENT_MARK } from "../ai.js";
import { SectionShell } from "./shared.js";
import type { BoardSectionData, ScreenModule } from "./types.js";

export function BoardSection({ section, mod }: { section: BoardSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="flex gap-3 overflow-x-auto pb-1.5">
        {section.items.map((col, ci) => (
          <div key={ci} className="w-64.5 shrink-0 rounded-md bg-surface-1 p-3 shadow-elev">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-12 uppercase tracking-wide" style={{ color: col.hue }}>
                {col.name}
              </span>
              <span className="font-mono text-12 text-subtle">{col.count}</span>
            </div>
            <div className="flex flex-col gap-2">
              {col.cards.map((card, i) => (
                <div
                  key={i}
                  tabIndex={0}
                  role="group"
                  aria-label={`${card.title}, ${card.who}, ${card.value}${card.ai ? ", produced by the agent" : ""}`}
                  className="rounded-md border bg-surface-2 p-3 outline-none transition-[box-shadow,transform] duration-150 ease-out hover:shadow-elev focus-visible:shadow-elev focus-visible:ring-2 focus-visible:ring-accent motion-safe:hover:-translate-y-0.5 motion-safe:focus-visible:-translate-y-0.5"
                  style={{ borderColor: card.line }}
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="text-12 leading-snug text-text">{card.title}</span>
                    <span className="shrink-0 font-mono text-12 tabular-nums" style={{ color: col.hue }}>
                      {card.clock}
                    </span>
                  </div>
                  <p className="mb-2 text-12 leading-relaxed text-subtle">{card.note}</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-12 text-subtle">{card.who}</span>
                    {card.ai ? (
                      <span className="text-accent" title="Produced by the agent">
                        {AGENT_MARK}
                        <span className="sr-only"> Produced by the agent</span>
                      </span>
                    ) : null}
                    <div className="flex-1" />
                    <span className="font-mono text-12 tabular-nums text-muted">{card.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
