import { isOpaqueRef, shortRef } from "@lyra/ui";
import { humanise } from "./modules/spec";

// The client half of /v1/names. The fetch lives in api.server.ts (server only);
// this is what a component renders with, so it may not import that file.

/** Ref → display name. A ref that resolved to nothing is absent, not null. */
export type Names = Readonly<Record<string, string>>;

/** Ref → the name a person expects, or the shortest honest thing we have. */
export function who(ref: string | null | undefined, resolved: Names): string | null {
  if (!ref) return null;
  const named = resolved[ref];
  if (named) return named;
  const short = shortRef(ref);
  // An opaque id shortens to its head and tail; anything else comes back whole,
  // and a whole `scope:key` is the shape /v1/names does not own — an engine that
  // numbers its own subjects (`settlements:cedar-2512`, `ai_budget:signal`).
  // Nobody reads a colon-joined key, so say the scope as words and leave the key
  // it belongs to alone: that half is the business's own name for the thing.
  if (short !== ref) return short;
  const colon = ref.indexOf(":");
  if (colon < 0) return ref;
  const scope = humanise(ref.slice(0, colon));
  const key = ref.slice(colon + 1);
  // A create has no row yet, so crud.ts names the subject after the request:
  // `commission-rates:new:<sha256 of the body>`. The digest is what stops a
  // retry raising a second approval — nobody reads it.
  return /^new:[0-9a-f]{16,}$/i.test(key) ? `New ${scope.toLowerCase()}` : `${scope} ${key}`;
}

/** Every ref-shaped string in a page of rows, whichever column it happens to sit in. */
export function refsIn(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): string[] {
  return rows.flatMap((row) =>
    Object.values(row).filter((value): value is string => typeof value === "string" && isOpaqueRef(value))
  );
}
