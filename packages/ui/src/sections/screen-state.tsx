/**
 * The six states any screen behind a loader can be in, as one small reusable
 * wrapper rather than six bespoke branches per route. Skeletons over
 * spinners (CLAUDE.md — "skeletons over spinners"): `loading` renders shaped
 * placeholders, never a centred spinner nobody can measure progress against.
 */
import * as React from "react";
import { EmptyState } from "../data.js";
import { Skeleton } from "../primitives.js";

export type ScreenStateKind = "ready" | "empty" | "loading" | "error" | "partial" | "offline" | "degraded-ai";

export interface ScreenStateProps {
  state: ScreenStateKind;
  title?: string;
  body?: string;
  /** Shown for `partial`/`degraded-ai`, which still have real content below
   * the notice — unlike `empty`/`error`/`offline`, which replace it. */
  children?: React.ReactNode;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-28 w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

export function ScreenState({ state, title, body, children }: ScreenStateProps) {
  switch (state) {
    case "loading":
      return <LoadingSkeleton />;
    case "empty":
      return <EmptyState title={title ?? "Nothing here yet"} body={body} />;
    case "error":
      return (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-4">
          <p className="font-ui text-14 font-medium text-danger">{title ?? "This screen could not load"}</p>
          {body ? <p className="mt-1 font-ui text-13 text-subtle">{body}</p> : null}
        </div>
      );
    case "offline":
      return (
        <div role="status" className="rounded-md border border-dashed border-line3 p-4">
          <p className="font-ui text-14 font-medium text-text">{title ?? "Working offline"}</p>
          <p className="mt-1 font-ui text-13 text-subtle">
            {body ?? "Showing the last data this device saved."}
          </p>
        </div>
      );
    case "partial":
      return (
        <div className="flex flex-col gap-4">
          <div role="status" className="rounded-md border border-warning/40 bg-warning/8 px-3 py-2">
            <p className="font-ui text-13 text-warning">{title ?? "Part of this screen did not load"}</p>
          </div>
          {children}
        </div>
      );
    case "degraded-ai":
      return (
        <div className="flex flex-col gap-4">
          <div role="status" className="rounded-md border border-line2 bg-surface-2 px-3 py-2">
            <p className="font-ui text-13 text-subtle">
              {title ?? "AI drafting is unavailable — showing the screen without it."}
            </p>
          </div>
          {children}
        </div>
      );
    case "ready":
    default:
      return <>{children}</>;
  }
}
