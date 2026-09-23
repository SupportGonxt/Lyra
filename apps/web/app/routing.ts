// The URL map. This file says which paths exist and where an actor lands; it
// says nothing about what a person may see — visibility and labels come from
// /v1/me, so a role change takes effect on the next request (docs/07 §3).

import type { LyraModule } from "@lyra/ui";

/** Module workspaces, in rail order. Must match what /v1/me can emit, or the
 *  rail silently drops an item the actor is entitled to (isRouted filters it). */
export const WORKSPACE_PATHS = [
  "/axis",
  "/orbit",
  "/signal",
  "/scout",
  "/north",
  "/north/alerts",
  "/distribution",
  "/ledger",
  "/analytics",
  "/compliance",
  "/admin",
  "/platform",
  "/settings"
] as const;

export type WorkspacePath = (typeof WORKSPACE_PATHS)[number];

/**
 * Routes that will never appear in the nav, and why. The test asserts every
 * other route has a `nav.*` label key, so a new workspace cannot ship unlabelled.
 */
export const HIDDEN_ROUTES: Record<string, string> = {
  "/login": "pre-session: renders outside the shell, so there is no nav to be in",
  "/portal/:tenantSlug": "public comparison site, no session and no shell — reached from a tenant's own marketing link (ADR-0030)",
  "/portal/:tenantSlug/privacy":
    "public DSAR intake, no session and no shell — linked from the storefront footer (ADR-0042)",
  "/portal/:tenantSlug/register":
    "public self-registration, no session and no shell — it creates a pending customer and grants no access, so there is no nav for it to appear in (docs/modules/orbit.md §4)",
  "/portal/:tenantSlug/quotes/:id":
    "public quote comparison, no session and no shell — reached only with the one-time token in the link (ADR-0043)",
  "/portal/:tenantSlug/partners":
    "public partner sign-up and sandbox console, no session and no shell — the key itself authenticates it (docs/modules/orbit.md §4 screen 5)",
  "/portal/:tenantSlug/renewals/:id":
    "public one-tap renewal page, no session and no shell — reached only with the link token (docs/modules/orbit.md §2.2)",
  "/portal/:tenantSlug/feedback/:id":
    "public CSAT tap, no session and no shell — reached only with the link token sent after the conversation closed (docs/modules/orbit.md §5)",
  "/logout": "action only, no UI",
  "/settings": "reached from the account menu in the header, not the module rail",
  "/settings/:tab": "one settings section — profile, sign-in, brand, regional, data — reached from the tabs on /settings",
  "/approvals": "reached from the decisions-waiting panel on the home dashboard",
  "/search": "no UI of its own: the loader that feeds the command palette in the header",
  "/companion": "no UI of its own: the loader that feeds the agent-activity rail in the shell",
  "/design": "the design doctrine, reached from the link parked at the end of the status strip",
  "/admin/ai/console": "a screen inside the admin workspace, reached from its AI tabs",
  "/admin/ai/budget": "the AI spending ceilings, reached from the admin workspace tools list",
  "/admin/cost-explorer": "unit-cost drift report, reached from the admin workspace tools list",
  "/admin/ai/runs/:id": "opens one agent run from the AI runs list or the console",
  "/ledger/reports/:report": "a report inside the ledger workspace, reached from its tabs",
  "/ledger/transactions": "opens a transaction inside the ledger workspace, linked from its tools list",
  "/ledger/transactions/:id": "opens one transaction from the ledger transactions list",
  "/ledger/period-close": "closes an accounting period, linked from the ledger workspace tools list",
  "/ledger/year-end": "closes a fiscal year into retained earnings, linked from the ledger workspace tools list",
  "/ledger/fx-revaluation": "revalues open foreign balances at the closing rate, linked from the ledger workspace tools list",
  "/ledger/journal": "drafts a manual journal entry, linked from the ledger workspace tools list",
  "/ledger/statement": "one account's journal lines, linked from the ledger workspace tools list",
  "/ledger/money-map": "a period's value flow inside the ledger workspace, linked from its reports list",
  "/ledger/recon": "reconciliation runs inside the ledger workspace, linked from its tools list",
  "/ledger/settlement": "commission settlement runs inside the ledger workspace, linked from its tools list",
  "/ledger/settlements/:id": "opens one settlement from the settlement runs list",
  "/admin/staff": "a screen inside the admin workspace, reached from its staff tab",
  "/admin/staff/:id": "opens one staff member from the staff directory",
  "/analytics/report/:id": "opens one saved report from the analytics report list",
  "/analytics/dashboard/:id": "opens one dashboard from the analytics dashboard list",
  "/distribution/quote-requests/:id/compare": "opens from a single quote request record",
  "/orbit/conversations/:id/thread": "opens from a single conversation record",
  "/distribution/commission-entries/statement":
    "a report inside the distribution workspace, linked from its commission tab",
  "/distribution/commission-entries/:id/clawback":
    "opens from a single commission entry on the statement",
  "/distribution/next-best-offers/suggest":
    "asks for offers inside the distribution workspace, linked from its offers tab",
  "/compliance/run/:kind":
    "starts a screening, evidence export or retention run, linked from the compliance workspace",
  "/admin/permissions":
    "the per-role permission grid inside the admin workspace, linked from its tools list next to the roles tab",
  "/admin/developer":
    "the developer portal inside the admin workspace, linked from its tools list beside the API keys tab",
  "/admin/security":
    "the sign-in enforcement posture inside the admin workspace, linked from its tools list beside the sign-in providers tab",
  "/admin/audit-export":
    "a CSV download of the audit chain, linked from the audit log tab's export button",
  "/admin/automation":
    "the auto-approve allowlist inside the admin workspace, linked from its tools list beside security and access",
  "/axis/documents/:id/file": "streams one document's source file, opened from the verify-queue viewer",
  "/axis/cases/:id/evidence-bundles/:bundleId/download":
    "streams one recon evidence bundle's file, opened from the case detail evidence list",
  "/signal/creatives/:id/image": "streams one generated creative's image, opened from the studio's creative list",
  "/admin/customers/:id/360": "opens everything known about one customer from the customers list",
  "/admin/products/:id/detail": "opens one product definition from the products list",
  "/axis/policies/:id/detail": "opens one policy with its history from the policies list",
  "/axis/policies/:id/endorse": "prices and confirms a mid-term change, linked from a policy's detail page",
  "/axis/policies/:id/cancel": "prices and confirms a cancellation, linked from a policy's detail page",
  "/axis/claims/new": "opens a first notice of loss intake form, linked from the claims list",
  "/axis/claims/:id/detail": "opens one claim for assessment from the claims list",
  "/axis/cases/:id/detail": "opens one work item from the cases list",
  "/distribution/channels/:id/detail": "opens one distribution channel from the channels list",
  "/search/results": "the full result page behind the command palette, opened from its last row",
  // Staff onboarding is served by the same screen but has no opener: /admin/staff
  // is a bespoke route with no workspace tab, so there is no recordLink to hang
  // one on. Claim only what routing.reachable.test.ts can hold you to.
  "/onboarding/:kind/:ref": "one subject's onboarding checklist, opened from that partner or channel record",
  "/orbit/journeys/:id/builder": "opens one journey's steps from the journeys list",
  "/surface/:module/:screen":
    "one screen from the Constellation design pull, opened from the link that names it — there is no single rail slot for a whole design catalogue (routes/surface.tsx)",
  "/journey/axis": "the flagship Operations->Insight->Market->Marketing demo journey, reached from the home dashboard's journey card, not the module rail",
  "/journey/north": "next hop of the flagship demo journey, reached via JourneyContinue from /journey/axis",
  "/journey/scout": "next hop of the flagship demo journey, reached via JourneyContinue from /journey/north",
  "/journey/signal": "final hop of the flagship demo journey, reached via JourneyContinue from /journey/scout",
  // NORTH's eight sub-screens are deliberately NOT hidden: NorthShell owns its
  // own rail and lists all of them directly (docs/superpowers/specs
  // /2026-08-15-north-shell-fork-design.md §"Owns"). Only the detail route below
  // is hidden, same as every other module's :id routes.
  "/north/board/:id/file": "streams one board pack's rendered PDF, opened from the board pack list",
  "/scout/whitespace/:id":
    "the dossier for one theme, opened from a dot on the radar",
  "/:module": "the generic workspace list; the rail links the real paths",
  "/:module/:resource": "a resource tab inside a workspace, linked from its tab strip",
  "/:module/:resource/:id": "a single record, linked from the list that holds it"
};

/**
 * docs/07 §3: home per role is that role's primary workspace. Role keys are
 * `<prefix>.<level>`, and for module roles the prefix is the module — so
 * `axis.lead` lands on /axis without a table to maintain. Only the prefixes
 * that are not module names need an entry.
 */
const HOME_BY_ROLE_PREFIX: Record<string, string> = {
  tenant: "/admin",
  platform: "/platform",
  dev: "/admin",
  customer: "/settings"
};

interface NavHref {
  href: string;
  children?: readonly NavHref[];
}

/** Nav is now grouped (heading items wrap the real destinations in
 *  `children`), so a leaf-only view needs both levels collected. */
function flattenHrefs(nav: readonly NavHref[]): string[] {
  return nav.flatMap((item) => [item.href, ...flattenHrefs(item.children ?? [])]);
}

/**
 * Where "/" sends this actor. Never sends them somewhere their nav does not
 * offer — a landing redirect into a 403 is a worse first paint than a list.
 */
export function landingFor(roles: readonly string[], nav: readonly NavHref[]): string {
  const hrefs = flattenHrefs(nav);
  const offered = new Set(hrefs);
  for (const role of roles) {
    const prefix = role.split(".")[0] ?? "";
    const path = HOME_BY_ROLE_PREFIX[prefix] ?? `/${prefix}`;
    if (offered.has(path) && isRouted(path)) return path;
  }
  // No role matched: the first thing they are allowed to open, or their own
  // settings, which every actor can always reach.
  return hrefs.find((href) => href !== "/" && isRouted(href)) ?? "/settings";
}

export function isRouted(path: string): boolean {
  if (!(WORKSPACE_PATHS as readonly string[]).includes(path)) return false;
  const module = moduleOf(path);
  return module === null || shouldInclude(module);
}

/** `/axis` → `nav.axis`. The label itself comes from the catalogue. */
export function labelKeyFor(path: string): string {
  return `nav.${path.replace(/^\//, "") || "home"}`;
}

const MODULES = new Set<string>(["axis", "orbit", "signal", "scout", "north"]);

/**
 * LYRA_MODULES is a build-time flag (docs/superpowers/specs
 * /2026-08-15-north-shell-fork-design.md § Standalone/together build).
 * Comma-separated module list, e.g. "north" or "north,axis"; unset or "all"
 * includes everything (today's default build, zero behavior change).
 *
 * Read here rather than in routes.ts so route *registration* (routes.ts) and
 * workspace *resolution* (modules/index.ts) cannot disagree — a module excluded
 * from one but not the other still answers through the generic `:module`
 * catch-all. Only names in MODULES are gated: the shared workspaces (ledger,
 * admin, analytics…) are not modules and ship in every build.
 *
 * `process.env.LYRA_MODULES` is inlined by vite's `define` (apps/web/
 * vite.config.ts) in both the client and worker bundles, because workerd's
 * `process.env` holds wrangler vars, not the build machine's environment.
 */
export function shouldInclude(module: string): boolean {
  const raw = process.env.LYRA_MODULES;
  if (!raw || raw === "all") return true;
  return raw.split(",").map((m) => m.trim()).includes(module);
}

/**
 * The module a path belongs to, or null for the shared surfaces (ledger,
 * admin, settings). Screens use it to draw the module's hue beside their
 * title, so a workspace signs itself the same way the rail marks it.
 */
export function moduleOf(path: string): LyraModule | null {
  const first = path.split("/").filter(Boolean)[0];
  return first && MODULES.has(first) ? (first as LyraModule) : null;
}

/**
 * Web-local duplicate of packages/core/src/lens.ts's `availableShellsForRoles`
 * (that function's own header comment explains why: packages/core may not
 * depend on an app). Every workspace this actor's roles resolve to, not just
 * the first-wins default `defaultWorkspaceForRoles` returns — used by
 * bootstrapSession() (session.server.ts) to compute `session.availableShells`
 * for the multi-role switcher (docs/superpowers/specs
 * /2026-08-15-north-shell-fork-design.md §5).
 */
const WORKSPACE_BY_ROLE: Record<string, string> = {
  "tenant.compliance": "compliance"
};
const WORKSPACE_BY_ROLE_PREFIX: Record<string, string> = {
  tenant: "admin",
  platform: "admin",
  dev: "admin",
  partner: "distribution",
  provider: "scout",
  customer: "settings",
  finance: "ledger"
};

export function availableShellsForRoles(roles: readonly string[]): string[] {
  const found = new Set<string>();
  for (const role of roles) {
    // ADR-0054: orbit.retention finishes the AXIS renewal desk itself
    // (rbac.ts grants it axis:policies:renew), so it needs the AXIS shell
    // too, not just its own. A narrow, named exception, not a generic
    // "any foreign permission implies a shell" rule — north.exec also holds
    // cross-module axis:* reads but must stay 403'd on /axis/* (axis-shell.spec.ts).
    // Checked first and added unconditionally (no continue) so it can't be
    // silently shadowed by a future WORKSPACE_BY_ROLE_PREFIX["orbit"] entry's
    // own continue — orbit.retention still falls through below to also pick
    // up its own workspace exactly as before.
    if (role === "orbit.retention") found.add("axis");
    const exact = WORKSPACE_BY_ROLE[role];
    if (exact) {
      found.add(exact);
      continue;
    }
    const prefix = role.split(".")[0] ?? "";
    const mapped = WORKSPACE_BY_ROLE_PREFIX[prefix];
    if (mapped) {
      found.add(mapped);
      continue;
    }
    if (prefix) found.add(prefix);
  }
  return found.size ? [...found] : ["north"];
}
