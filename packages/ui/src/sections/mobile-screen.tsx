/**
 * Renders a `MobileScreen` (`kind: "mobile"` in ./types.ts) — the one phone
 * gallery screen (`out-mobile`). A row of static phone mocks: status bar,
 * card stack, tab bar and a caption underneath, transcribed from the design
 * file's own phone-frame markup.
 */
import * as React from "react";
import type { MobileScreen } from "./types.js";

export function MobileScreenView({ screen }: { screen: MobileScreen }) {
  return (
    <div className="flex flex-wrap gap-7">
      {screen.phones.map((phone, i) => (
        <div key={i} className="w-75 shrink-0">
          <div className="flex h-151 flex-col overflow-hidden rounded-3xl border border-line3 bg-surface-2 shadow-elev2">
            <div className="flex h-8.5 shrink-0 items-center justify-between px-4.5 font-mono text-12 text-subtle">
              <span>{phone.time}</span>
              <span>{phone.net}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
              <div className="mb-1.5 text-12 uppercase tracking-wide text-muted">{phone.eyebrow}</div>
              <div className="mb-4 font-ui text-18 font-semibold leading-snug text-text">{phone.title}</div>
              <div className="flex flex-col gap-2.5">
                {phone.cards.map((card, j) => (
                  <div
                    key={j}
                    className="rounded-md border p-3"
                    style={{ borderColor: card.line, background: card.bg }}
                  >
                    <div className="mb-1.5 flex items-baseline justify-between gap-2">
                      <div className="text-12 uppercase tracking-wide" style={{ color: card.hue }}>
                        {card.tag}
                      </div>
                      <div className="font-mono text-12 text-subtle">{card.stamp}</div>
                    </div>
                    <div className="mb-1.5 text-13 leading-snug text-text">{card.head}</div>
                    <div className="text-12 leading-relaxed text-subtle">{card.body}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex h-13.5 shrink-0 items-center border-t border-line bg-surface-1">
              {phone.tabs.map((tab, j) => (
                <div key={j} className="flex-1 text-center text-12" style={{ color: tab.hue }}>
                  {tab.label}
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3.5 max-w-75 text-12 leading-relaxed text-subtle">{phone.caption}</p>
        </div>
      ))}
    </div>
  );
}
