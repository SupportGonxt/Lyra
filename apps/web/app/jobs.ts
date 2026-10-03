// What each role comes to Lyra to do, and where that screen is (docs/06 §2).
//
// The role-adoption simulation (scripts/role-adoption.mjs) signed every demo
// seat in after a month of activity and found 12 of 62 jobs more than two
// clicks from home — the developer's three screens, the compliance officer's
// audit log, the provider viewer's only screen. Each was a bespoke route in
// HIDDEN_ROUTES or a resource tab one workspace deep, reachable and unfound.
// Home now draws this table as a strip, so every job is one click away.
//
// Keyed by role, never by persona: a seat sees the union over the roles it
// holds, filtered by the permission each target screen itself gates on and by
// the module shell it renders in, so a job is never a door into a 403. The
// labels are home's (`job.<id>` in routes/home.tsx), because no other screen
// says them.
//
// Guards (jobs.test.ts): every path resolves to a real screen, every role's
// own jobs are open to that role alone, every role in rbac is either here or
// excluded for a named reason, and every job the adoption script measures is in
// its seat's table.

import { moduleOf } from "./routing";

export interface Job {
  /** Label key suffix: home reads `job.<id>`. */
  id: string;
  path: string;
  /**
   * The permission the target screen gates on — the spec tab's `read`, the
   * spec link's `permission`, or the bespoke loader's own check. `null` is a
   * screen every signed-in seat may open (its own inbox, its own settings).
   */
  permission: string | null;
}

const job = (id: string, path: string, permission: string | null): Job => ({ id, path, permission });

/** Every job once, so two roles sharing a job share its wording. */
export const JOB = {
  approvals: job("approvals", "/approvals", null),
  center: job("center", "/center", "ai:command:read"),
  staff: job("staff", "/admin/staff", "core:users:read"),
  aiConsole: job("aiConsole", "/admin/ai/console", "ai:runs:read"),
  settings: job("settings", "/settings", "core:tenants:update"),

  auditLog: job("auditLog", "/admin/audit-log", "core:audit:read"),
  screenings: job("screenings", "/compliance/screenings", "compliance:screenings:read"),
  dsar: job("dsar", "/compliance/dsar-requests", "compliance:dsar:read"),

  exceptions: job("exceptions", "/axis/exceptions", "axis:cases:read"),
  claimsDesk: job("claimsDesk", "/axis/claims/desk", "axis:claims:read"),
  claimsNew: job("claimsNew", "/axis/claims/new", "axis:claims:create"),
  cases: job("cases", "/axis/cases", "axis:cases:read"),
  quoteRequests: job("quoteRequests", "/distribution/quote-requests", "dist:quote_requests:read"),
  bordereaux: job("bordereaux", "/axis/bordereaux", "axis:bordereaux:read"),
  axisAnalytics: job("axisAnalytics", "/axis/analytics", "axis:metrics:read"),
  processMap: job("processMap", "/axis/process-map", "axis:metrics:read"),
  axisAdmin: job("axisAdmin", "/axis/admin", "axis:sops:read"),
  renewals: job("renewals", "/axis/renewals", "axis:policies:read"),

  developer: job("developer", "/admin/developer", "core:api_keys:read"),
  apiKeys: job("apiKeys", "/admin/api-keys", "core:api_keys:read"),
  webhooks: job("webhooks", "/admin/webhook-deliveries", "core:webhooks:read"),

  moneyMap: job("moneyMap", "/ledger/money-map", "ledger:journals:read"),
  statement: job("statement", "/distribution/commission-entries/statement", "dist:commissions:read"),
  pnl: job("pnl", "/ledger/reports/pnl", "ledger:journals:read"),
  periodClose: job("periodClose", "/ledger/period-close", "ledger:periods:read"),
  settlement: job("settlement", "/ledger/settlement", "dist:commissions:read"),
  journal: job("journal", "/ledger/journal", "ledger:journals:draft"),
  recon: job("recon", "/ledger/recon", "ledger:recon:read"),

  explorer: job("explorer", "/north/explorer", "north:snapshots:read"),
  anomalies: job("anomalies", "/north/anomalies", "north:anomalies:read"),
  journeys: job("journeys", "/north/journeys", "north:metrics:read"),
  builder: job("builder", "/analytics/builder", "analytics:reports:run"),
  brief: job("brief", "/north/brief", "north:briefings:read"),
  board: job("board", "/north/board", "north:boardpacks:read"),
  whatif: job("whatif", "/north/whatif", "north:scenarios:read"),
  decisions: job("decisions", "/north/decisions", "north:decisions:read"),
  northAdmin: job("northAdmin", "/north/admin", "north:metrics:write"),

  connectors: job("connectors", "/orbit/channel-connectors", "orbit:channels:read"),
  routing: job("routing", "/orbit/routing-rules", "orbit:teams:read"),
  quality: job("quality", "/orbit/quality", "orbit:qa:read"),
  supervisor: job("supervisor", "/orbit/supervisor", "orbit:presence:read"),
  console: job("console", "/orbit/console", "orbit:conversations:read"),
  conversations: job("conversations", "/orbit/conversations", "orbit:conversations:read"),
  kb: job("kb", "/orbit/kb-articles", "orbit:kb:read"),
  partners: job("partners", "/orbit/partners", "orbit:partners:read"),
  pipeline: job("pipeline", "/orbit/pipeline", "orbit:renewals:read"),
  channels: job("channels", "/distribution/channels", "dist:channels:read"),
  save: job("save", "/orbit/save", "orbit:renewals:read"),
  offers: job("offers", "/distribution/next-best-offers/suggest", "dist:offers:read"),

  dataProducts: job("dataProducts", "/scout/data-products", "scout:data_products:read"),
  radar: job("radar", "/scout/radar", "scout:clusters:read"),
  panel: job("panel", "/scout/panel", "scout:panel_bench:read"),
  scoutExperiments: job("scoutExperiments", "/scout/experiments", "scout:experiments:read"),
  scoutAdmin: job("scoutAdmin", "/scout/admin", "scout:signals:read"),

  cockpit: job("cockpit", "/signal/cockpit", "signal:spend:read"),
  budget: job("budget", "/signal/budget", "signal:budget_moves:read"),
  studio: job("studio", "/signal/studio", "signal:campaigns:read"),
  answerEngines: job("answerEngines", "/signal/answer-engines", "signal:aeo:read"),
  signalAdmin: job("signalAdmin", "/signal/admin", "signal:campaigns:read")
} as const;

/**
 * Role → its jobs, most frequent first. Order matters twice: a seat's strip
 * keeps this order, and a seat holding many roles (the demo administrator holds
 * every tenant role) sees the first few roles' jobs before the fold — so the
 * cross-module roles lead.
 */
export const JOBS_BY_ROLE: Readonly<Record<string, readonly Job[]>> = {
  "tenant.admin": [JOB.approvals, JOB.center, JOB.staff, JOB.aiConsole, JOB.settings],
  "north.exec": [JOB.brief, JOB.board, JOB.whatif, JOB.decisions],
  "tenant.compliance": [JOB.auditLog, JOB.screenings, JOB.dsar, JOB.approvals],

  "axis.agent": [JOB.exceptions, JOB.claimsDesk, JOB.claimsNew, JOB.cases],
  "axis.lead": [JOB.exceptions, JOB.quoteRequests, JOB.bordereaux, JOB.approvals, JOB.axisAnalytics],
  "axis.admin": [JOB.axisAdmin, JOB.processMap, JOB.bordereaux, JOB.approvals],

  "orbit.agent": [JOB.console, JOB.conversations, JOB.kb],
  "orbit.lead": [JOB.supervisor, JOB.quality, JOB.console, JOB.kb, JOB.approvals],
  "orbit.retention": [JOB.save, JOB.renewals, JOB.offers],
  "orbit.partners": [JOB.partners, JOB.pipeline, JOB.channels],
  "orbit.admin": [JOB.connectors, JOB.routing, JOB.quality, JOB.supervisor],

  "signal.marketer": [JOB.studio, JOB.cockpit, JOB.answerEngines],
  "signal.lead": [JOB.cockpit, JOB.budget, JOB.studio, JOB.answerEngines],
  "signal.admin": [JOB.signalAdmin, JOB.budget, JOB.cockpit, JOB.approvals],

  "scout.pm": [JOB.radar, JOB.scoutExperiments, JOB.panel],
  "scout.lead": [JOB.radar, JOB.panel, JOB.scoutExperiments],
  "scout.admin": [JOB.scoutAdmin, JOB.dataProducts, JOB.radar],

  "north.analyst": [JOB.explorer, JOB.anomalies, JOB.journeys, JOB.builder],
  "north.board": [JOB.brief, JOB.board, JOB.decisions],
  "north.admin": [JOB.northAdmin, JOB.explorer, JOB.builder],

  "finance.analyst": [JOB.moneyMap, JOB.statement, JOB.pnl, JOB.recon],
  "finance.controller": [JOB.periodClose, JOB.settlement, JOB.journal, JOB.approvals, JOB.pnl, JOB.recon],
  "finance.director": [JOB.approvals, JOB.periodClose, JOB.pnl, JOB.moneyMap],

  "dev.developer": [JOB.webhooks],
  "dev.admin": [JOB.developer, JOB.apiKeys, JOB.webhooks],

  "provider.viewer": [JOB.dataProducts, JOB.panel]
};

/**
 * Roles with no strip, and why. jobs.test.ts holds every role in rbac to be in
 * JOBS_BY_ROLE or here, so a new role cannot ship without someone deciding.
 */
export const NO_JOBS: Readonly<Record<string, string>> = {
  "platform.admin": "goNXT staff: lands on /platform, outside any tenant's home",
  "platform.support": "goNXT staff: lands on /platform, outside any tenant's home",
  "platform.engineer": "goNXT staff: lands on /platform, outside any tenant's home",
  customer: "external: a customer's door is the tenant portal, and staff home is not theirs",
  "partner.developer": "external: works from the partner portal and its sandbox key",
  "partner.manager": "external: works from the partner portal"
};

/** Module shells gate their own layouts (axis-shell.tsx and siblings). */
function shellAllows(path: string, shells: readonly string[]): boolean {
  const module = moduleOf(path);
  return module === null || shells.includes(module);
}

/**
 * This seat's jobs: the union over its roles in table order, each path once,
 * kept only where the seat holds the target's permission and its shell. The
 * route stays the authority — this only decides which doors to draw.
 */
export function jobsFor(
  roles: readonly string[],
  permissions: readonly string[],
  shells: readonly string[]
): Job[] {
  const held = new Set(permissions);
  const mine = new Set(roles);
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const [role, jobs] of Object.entries(JOBS_BY_ROLE)) {
    if (!mine.has(role)) continue;
    for (const one of jobs) {
      if (seen.has(one.path)) continue;
      if (one.permission !== null && !held.has(one.permission)) continue;
      if (!shellAllows(one.path, shells)) continue;
      seen.add(one.path);
      out.push(one);
    }
  }
  return out;
}
