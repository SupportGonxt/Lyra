import * as React from "react";
import { SectionShell } from "./shared.js";
import type { TimelineSectionData, ScreenModule } from "./types.js";

export function TimelineSection({ section, mod }: { section: TimelineSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod} flex={section.flex} min={section.min}>
      <div className="flex flex-col rounded-md bg-surface-2 px-3 shadow-elev">
        {section.items.map((item, i) => (
          <div
            key={i}
            className="flex gap-4 border-b border-border px-1.5 py-3.5 transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-3"
          >
            <div className="w-20 shrink-0 pt-0.5 font-mono text-12 tabular-nums text-subtle">{item.when}</div>
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: item.hue }} />
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-14 leading-snug text-text">{item.title}</p>
              <p className="text-13 leading-relaxed text-subtle">{item.note}</p>
            </div>
            <div className="shrink-0 font-mono text-12 tabular-nums" style={{ color: item.hue }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
