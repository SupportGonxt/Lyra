# ADR-0085 — One frame; a module's own screens lead the rail

**Status:** accepted · 2026-09-23
**Supersedes:** the frame half of ADR-0061 (five forked `*Shell` components) and ADR-0052's "no module switcher" as it applied inside module shells.
**Keeps:** ADR-0061's layout routes (`routes/*-shell.tsx`), their `availableShells` 403 gate and the `LYRA_MODULES` standalone build; ADR-0011 (text-labelled rail); ADR-0031.
**Context:** senior design panel review, 2026-09-23 (menu/IA, 4/10).

## Context

Entering a module swapped the whole frame. `/axis` rendered in the shared
`Shell`; `/axis/board` rendered in `AxisShell`, a 300-line fork whose logo went
to `/axis/board`, whose rail held no Home, Approvals, Ledger or Admin, whose ⌘K
knew only that module's pages, and whose breadcrumb's first crumb dropped the
reader back into the other frame. Five such forks (1,560 lines) differed from
each other by the module name and, for NORTH, the Meridian. Each module had two
front doors with two different rails, and the module's own screens sat below
the module switcher and the shift, near the fold.

## Decision

1. **One frame.** `Shell` renders every signed-in screen. The five module
   shell components become thin wrappers that pass a `section`: the module,
   its label and its screens. No other component renders the frame, and
   `frame.test.ts` checks one file.
2. **Rail order.** Pinned first: Home and Inbox (approvals waiting on the
   reader, with its count). Then, inside a module, that module's screens under
   its own heading. Then every workspace the API's nav offers. Then the shift.
3. **Section items are permission-filtered** with the same expanded
   permission list the chrome already reads. A screen the reader cannot open
   is absent, not a door to a 403.
4. **The Meridian is NORTH's** (ADR-0061 already said so; the shared shell had
   drawn it on every generic screen).
5. **The demo journey leaves the rail.** Home already offers it as its first
   action; pinning it above every destination for every production user was
   a demo affordance shipped as navigation.

## Consequences

- One place decides chrome, so ⌘K, breadcrumbs, skip link, toast host and
  theme behave identically everywhere.
- The layout routes still gate a module (403 for an actor whose roles never
  resolve to it) and still let a build ship one module alone.
- `ModuleSwitcher` stays unmounted: the rail's workspace list is the switcher
  (ADR-0052's reasoning, now true inside modules too).

## Amendment — one menu per workspace (2026-09-23)

The module section became a **workspace menu** (`components/menu.ts`), computed
by the shell from the path on every screen rather than passed by the module
shells: a module's generic lists (`/axis/cases`) and its bespoke screens
(`/axis/board`) now show the same menu, and shared workspaces (Ledger, Admin,
Distribution, Analytics, Compliance) get one too. The menu is the workspace's
screens (modules: `modules/screens.ts`; shared: the spec's declared `links`),
then its record lists under a "Records" disclosure that is open while one is
on screen. The page's own tab strip is kept for phones only and its row of tool
links is gone — both said what the rail now says.
