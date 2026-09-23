import * as React from "react";
import { SectionShell } from "./shared.js";
import type { TextSectionData, ScreenModule } from "./types.js";

export function TextSection({ section, mod }: { section: TextSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="rounded-md bg-surface-2 p-7 shadow-elev">
        {section.lede ? (
          <p className="mb-5 max-w-[60ch] text-pretty font-serif text-28 leading-snug text-text">{section.lede}</p>
        ) : null}
        <div className="flex max-w-[68ch] flex-col gap-4">
          {section.items.map((item, i) => (
            <p key={i} className="text-pretty text-18 leading-relaxed text-muted">
              {item.body}
            </p>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
