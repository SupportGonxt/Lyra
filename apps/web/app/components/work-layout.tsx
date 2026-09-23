import type { ReactNode } from "react";

/**
 * Data first, the form beside it. A register screen (decisions, scenarios,
 * transactions) used to open on its composer and put what was already recorded
 * a screen below it. On a wide screen the two now sit side by side, the
 * composer sticky while the register scrolls; narrower, the register comes
 * first and the composer follows it.
 */
export function WorkLayout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-4">{aside}</aside>
    </div>
  );
}
