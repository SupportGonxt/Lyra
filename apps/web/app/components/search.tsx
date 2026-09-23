import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { CommandBar } from "@lyra/ui";
import type { Translate } from "../i18n";
import type { SearchItem } from "../routes/search";

// The one client-side fetch in the shell. It goes to /search (this app), not the
// API — the session cookie is deliberately unreadable by script, so the loader
// there is what holds it.

/** A place the nav can already reach, named the way the nav names it. */
export interface Destination {
  href: string;
  label: string;
  /** A tab inside a workspace: found by typing, not listed before a query. */
  deep?: boolean;
}

/**
 * The destinations that match what has been typed — the design's "Where"
 * overlay, folded into the palette instead of living as a second overlay
 * (ADR-0031). CommandBar's own filter is off here (onQueryChange is set,
 * because the record rows beside these are matched by the server on fields no
 * label shows), so the workspace rows are filtered here.
 */
export function matchingDestinations(
  destinations: readonly Destination[],
  query: string
): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return destinations.filter((d) => !d.deep);
  return destinations.filter((d) => d.label.toLowerCase().includes(q)).slice(0, 12);
}

export function SearchPalette({ t, destinations }: { t: Translate; destinations: readonly Destination[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  // The key cap says what this keyboard has: ⌘ on a Mac, Ctrl elsewhere. The
  // server cannot know, so it renders ⌘ and the client corrects it.
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setItems([]);
      return;
    }
    const abort = new AbortController();
    // ponytail: one timer is the whole debounce. Reach for a library when the
    // palette needs more than "wait, then ask once".
    const timer = setTimeout(() => {
      void fetch(`/search?q=${encodeURIComponent(term)}`, {
        signal: abort.signal,
        headers: { accept: "application/json" }
      })
        .then((response) => (response.ok ? (response.json() as Promise<{ items: SearchItem[] }>) : { items: [] }))
        .then((body) => setItems(body.items))
        // Aborted, offline, or signed out mid-keystroke: the last results stand
        // rather than the palette flashing empty on every dropped request.
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);

  return (
    <>
      {/* Horizon's ask bar: the widest thing in the top bar, because asking is
          the first move on every screen. It is a button, not an input — the
          typing happens in the palette, and a second focusable field in the
          header would only be somewhere to lose a query. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group hidden h-[31px] min-w-0 max-w-[680px] flex-1 items-center gap-2.5 rounded-[4px] border border-border bg-surface-2/50 px-3 text-start font-ui text-13 text-subtle transition-colors duration-150 hover:border-border-strong hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex"
      >
        {/* Still, not pulsing: docs/15 §4.5 keeps the pulse for "an agent
            found something material", and this dot found nothing. */}
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-orbit bg-accent" />
        <span className="truncate">{t("search.open")}</span>
        {/* The scope chip. Not its own button — everything here opens the same
            palette, and a button inside a button is invalid anyway. */}
        <span className="ms-auto hidden shrink-0 items-center gap-1.5 rounded-[3px] border border-border px-2 py-[3px] text-12 text-subtle transition-colors duration-150 group-hover:border-border-strong group-hover:text-text md:flex">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <rect x="0.5" y="0.5" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="0.8" />
            <rect x="5.5" y="0.5" width="4" height="4" fill="currentColor" opacity="0.5" />
            <rect x="0.5" y="5.5" width="4" height="4" fill="currentColor" opacity="0.3" />
            <rect x="5.5" y="5.5" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="0.8" />
          </svg>
          {t("search.allSurfaces")}
          {/* A key cap, not a word: the same two glyphs in every locale. */}
          <kbd className="font-mono text-12 text-muted">{mac ? "⌘K" : "Ctrl K"}</kbd>
        </span>
      </button>
      {/* Phones: the ask bar is hidden below sm, and touch has no ⌘K, so
          search had no way in at all. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("search.open")}
        title={t("search.open")}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:hidden"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <CommandBar
        open={open}
        onOpenChange={setOpen}
        onQueryChange={setQuery}
        items={[
          ...matchingDestinations(destinations, query).map((destination) => ({
            id: `where:${destination.href}`,
            label: destination.label,
            group: t("search.goTo"),
            onSelect: () => navigate(destination.href)
          })),
          ...items.map((item) => ({
            id: item.id,
            label: item.label,
            hint: item.hint,
            group: t("search.results"),
            onSelect: () => navigate(item.href)
          })),
          // The door to the full results page. /search answers this palette with
          // ten rows per resource; when that is not enough, the same query goes
          // to a screen that can group and page it. Labelled with the palette's
          // own name because that is exactly what it does, in full.
          ...(query.trim().length < 2
            ? []
            : [
                {
                  id: "search-all",
                  label: t("search.label"),
                  group: t("search.results"),
                  onSelect: () => navigate(`/search/results?q=${encodeURIComponent(query.trim())}`)
                }
              ])
        ]}
        label={t("search.label")}
        placeholder={t("search.placeholder")}
        emptyLabel={query.trim().length < 2 ? t("search.prompt") : t("search.none")}
      />
    </>
  );
}
