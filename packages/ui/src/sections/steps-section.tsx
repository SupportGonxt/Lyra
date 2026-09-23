import * as React from "react";
import { SectionShell } from "./shared.js";
import type { StepsSectionData, ScreenModule } from "./types.js";

export function StepsSection({ section, mod }: { section: StepsSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="flex items-stretch gap-0 overflow-x-auto rounded-md bg-surface-2 p-2 shadow-elev">
        {section.items.map((item, i) => (
          <div
            key={`${item.code}-${i}`}
            className="flex min-w-[11rem] flex-1 flex-col gap-2 border-s border-border px-4 py-1 transition-colors duration-150 ease-out hover:bg-surface-3"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: item.dot }} />
              <span className="truncate font-mono text-12 tracking-wide text-subtle">{item.code}</span>
            </div>
            <p className="font-ui text-13 leading-snug text-text">{item.title}</p>
            <p className="font-mono text-13 tabular-nums" style={{ color: item.hue }}>
              {item.money}
            </p>
            <p className="font-ui text-12 leading-relaxed text-subtle">{item.note}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
