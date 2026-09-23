import * as React from "react";
import { SectionShell } from "./shared.js";
import type { EmptySectionData, ScreenModule } from "./types.js";

export function EmptySection({ section, mod }: { section: EmptySectionData; mod: ScreenModule }) {
  return (
    <SectionShell title={section.title} mod={mod} flex={section.flex} min={section.min}>
      <div className="rounded-md border border-dashed border-line3 p-12 text-center transition-colors duration-150 ease-out hover:border-line4">
        <svg
          width="88"
          height="60"
          viewBox="0 0 88 60"
          fill="none"
          stroke="var(--line4)"
          strokeWidth={1}
          className="mx-auto mb-5"
          aria-hidden="true"
        >
          <path d="M14 42 L38 20 L62 32 L78 14" />
          <circle cx={14} cy={42} r={2.5} fill="var(--line4)" />
          <circle cx={38} cy={20} r={2.5} fill="var(--line4)" />
          <circle cx={62} cy={32} r={2.5} fill="var(--line4)" />
          <circle cx={78} cy={14} r={4} fill="var(--acc)" stroke="none" />
        </svg>
        <div className="mb-2 font-ui text-16 font-semibold text-text">{section.label}</div>
        <p className="mx-auto mb-4.5 max-w-[46ch] text-13 leading-relaxed text-subtle">{section.body}</p>
        {section.action ? (
          <span className="inline-block rounded-md bg-accent px-4 py-2 text-13 text-accent-contrast">{section.action}</span>
        ) : null}
      </div>
    </SectionShell>
  );
}
