import * as React from "react";
import { cn } from "../cn.js";
import { SectionShell } from "./shared.js";
import type { QuotesSectionData, ScreenModule } from "./types.js";

export function QuotesSection({ section, mod }: { section: QuotesSectionData; mod: ScreenModule }) {
  const [selected, setSelected] = React.useState<number | null>(null);
  return (
    <SectionShell title={section.title} mod={mod}>
      <div className="flex flex-col gap-2.5">
        {section.items.map((item, i) => {
          const isSelected = selected === i;
          return (
            <div
              key={i}
              className={cn(
                "flex flex-wrap items-center gap-5 rounded-md border p-4.5 transition-shadow duration-150 ease-out",
                isSelected && "shadow-elev ring-2 ring-accent"
              )}
              style={{ borderColor: item.line, background: item.bg }}
            >
              <div className="min-w-0 flex-[1_1_13rem]">
                <div className="mb-1 font-ui text-16 font-semibold text-text">{item.insurer}</div>
                <div className="text-12 leading-relaxed text-subtle">{item.plan}</div>
              </div>
              <div className="flex flex-[1_1_17rem] flex-wrap gap-1.5">
                {item.tags.map((tag, j) => (
                  <span
                    key={j}
                    className="rounded-orbit border px-2.5 py-0.5 text-12"
                    style={{ borderColor: tag.line, color: tag.hue, background: tag.bg }}
                  >
                    {tag.label}
                  </span>
                ))}
              </div>
              <div className="shrink-0 text-end">
                <div className="font-mono text-18 font-bold tracking-tight tabular-nums" style={{ color: item.phue }}>
                  {item.price}
                </div>
                <div className="mt-1 text-12 text-subtle">{item.pnote}</div>
              </div>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelected((current) => (current === i ? null : i))}
                className="shrink-0 rounded-md border px-4 py-2 text-13 transition-[filter] duration-150 ease-out hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{ background: item.ctaBg, color: item.ctaTx, borderColor: item.ctaLine }}
              >
                {isSelected ? "Selected" : item.cta}
              </button>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
