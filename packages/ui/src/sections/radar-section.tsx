import * as React from "react";
import { SectionShell } from "./shared.js";
import type { RadarSectionData, ScreenModule } from "./types.js";

export function RadarSection({ section, mod }: { section: RadarSectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="rounded-md bg-surface-2 p-5 shadow-elev">
        <div className="relative h-82.5 border-s border-b border-line2">
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
          <div className="absolute inset-y-0 start-1/2 border-s border-dashed border-line" />
          <div className="absolute end-3 top-2 text-12 uppercase tracking-wide text-subtle">worth building</div>
          <div className="absolute end-3 bottom-2 text-12 uppercase tracking-wide text-subtle">keep watching</div>
          <div className="absolute start-3 top-2 text-12 uppercase tracking-wide text-subtle">crowded</div>
          <div className="absolute start-3 bottom-2 text-12 uppercase tracking-wide text-subtle">let it go</div>
          {section.items.map((item, i) => (
            <div
              key={i}
              tabIndex={0}
              role="img"
              aria-label={item.label}
              className="group absolute cursor-default outline-none"
              style={{ insetInlineStart: item.x, bottom: item.y }}
            >
              <div
                aria-hidden="true"
                className="absolute rounded-full opacity-40 blur-[1px]"
                style={{
                  width: item.size,
                  height: item.size,
                  insetInlineStart: "-25%",
                  bottom: "-25%",
                  background: item.trail
                }}
              />
              <div
                className="relative rounded-full opacity-[0.92] shadow-elev transition-transform duration-150 ease-out group-hover:scale-125 group-focus-visible:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-accent"
                style={{ width: item.size, height: item.size, background: item.hue }}
              />
              <div className="mt-0.5 whitespace-nowrap ps-4 text-12 text-muted transition-colors duration-150 ease-out group-hover:text-text group-focus-visible:text-text">
                {item.label}
              </div>
            </div>
          ))}
        </div>
        {section.xlab || section.ylab ? (
          <div className="mt-3 flex justify-between text-12 text-subtle">
            <span>{section.xlab}</span>
            <span>{section.ylab}</span>
          </div>
        ) : null}
      </div>
    </SectionShell>
  );
}
