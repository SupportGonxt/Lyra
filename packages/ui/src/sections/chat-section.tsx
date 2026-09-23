import * as React from "react";
import { SectionShell } from "./shared.js";
import type { ChatSectionData, ScreenModule } from "./types.js";

export function ChatSection({ section, mod }: { section: ChatSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4.5 shadow-elev">
        {section.items.map((item, i) => (
          <div
            key={i}
            tabIndex={0}
            role="article"
            aria-label={`${item.who}, ${item.stamp}${item.delivery ? `, ${item.delivery}` : ""}`}
            className="max-w-[76%] rounded-md border p-3 outline-none transition-[box-shadow] duration-150 ease-out hover:shadow-elev focus-visible:shadow-elev focus-visible:ring-2 focus-visible:ring-accent"
            style={{
              alignSelf: item.align,
              borderColor: item.line,
              background: item.bg
            }}
          >
            <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
              <span className="text-12 uppercase tracking-wide" style={{ color: item.hue }}>
                {item.who}
              </span>
              <span className="font-mono text-12 text-subtle">{item.stamp}</span>
              {item.delivery ? (
                <span className="text-12" style={{ color: item.dhue }}>
                  {item.delivery}
                </span>
              ) : null}
            </div>
            <p className="text-14 leading-relaxed text-text">{item.body}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
