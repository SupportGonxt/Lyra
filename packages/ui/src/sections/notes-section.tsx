import * as React from "react";
import { SectionShell } from "./shared.js";
import type { NotesSectionData, ScreenModule } from "./types.js";

export function NotesSection({ section, mod }: { section: NotesSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod} flex={section.flex} min={section.min}>
      <div className="flex flex-col gap-4">
        {section.items.map((item, i) => (
          <div
            key={i}
            className="border-s-2 py-0.5 ps-3.5 transition-colors duration-150 ease-out hover:bg-surface-3"
            style={{ borderColor: item.hue }}
          >
            <div className="mb-1 text-12 uppercase tracking-wide text-muted">{item.label}</div>
            <p className="text-13 leading-relaxed text-text">{item.body}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
