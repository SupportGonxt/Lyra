// The phone's half of "your jobs" (mobile parity for the web home strip,
// apps/web/app/routes/home.tsx). The role -> jobs table is not here: it is
// @lyra/core/jobs, the one the web reads, so the two cannot drift. What is
// the phone's own is which jobs it has a screen for, and the words.
//
// Filtering is the table's: a job shows only where the seat holds the
// permission the desk screen gates on. A phone screen that reads something
// stricter names it in `perm` (approvals: the web's /approvals is the actor's
// own inbox, the phone's reads the queue). The API still decides every read.

import { JOB, SHELLED_MODULES, jobsFor } from "@lyra/core/jobs";
import type { Me } from "./api";
import type { MessageKey } from "./i18n";

type JobId = keyof typeof JOB;

/** Jobs with a screen on the phone, and where it is. */
export const PHONE_ROUTE: Partial<Record<JobId, { route: string; perm?: string }>> = {
  approvals: { route: "/j/approvals", perm: "core:approvals:read" },
  brief: { route: "/j/brief" },
  board: { route: "/j/boardpack" },
  decisions: { route: "/j/decisions" },
  auditLog: { route: "/j/audit" },
  dsar: { route: "/j/requests" },
  recon: { route: "/m/ledger-recon" },
  cases: { route: "/j/queue" },
  console: { route: "/j/threads" },
  conversations: { route: "/j/threads" },
  save: { route: "/j/renewals" },
  radar: { route: "/j/whitespace" },
  panel: { route: "/j/panel" },
  cockpit: { route: "/j/attribution" },
  studio: { route: "/j/campaigns" },
  budget: { route: "/j/campaigns?view=budget" },
  staff: { route: "/m/admin" },
  quoteRequests: { route: "/m/distribution" }
};

/**
 * Jobs with no phone screen yet: desk work (configuration, builders, long
 * forms, statements) that docs/08 leaves to the web. Listed rather than
 * implied, so a job added to the table must be placed on one side or the
 * other (jobs.test.ts).
 */
export const DESK_ONLY: readonly JobId[] = [
  "center", "aiConsole", "settings", "screenings", "exceptions", "claimsDesk", "claimsNew",
  "bordereaux", "axisAnalytics", "processMap", "axisAdmin", "renewals", "developer", "apiKeys",
  "webhooks", "moneyMap", "statement", "pnl", "periodClose", "settlement", "journal", "explorer",
  "anomalies", "journeys", "builder", "whatif", "northAdmin", "connectors", "routing", "quality",
  "supervisor", "kb", "partners", "pipeline", "channels", "offers", "dataProducts",
  "scoutExperiments", "scoutAdmin", "answerEngines", "signalAdmin"
];

export interface PhoneJob {
  id: string;
  route: string;
  labelKey: MessageKey;
}

/**
 * This seat's phone jobs, in the table's order, each screen once. The phone
 * has no module shells to enter, so every shell counts as open; the
 * permission check is the same one the web applies.
 */
export function phoneJobsFor(me: Pick<Me, "roles" | "permissions">): PhoneJob[] {
  const seen = new Set<string>();
  const out: PhoneJob[] = [];
  for (const one of jobsFor(me.roles, me.permissions, SHELLED_MODULES)) {
    const entry = PHONE_ROUTE[one.id as JobId];
    if (!entry || seen.has(entry.route)) continue;
    if (entry.perm && !me.permissions.includes(entry.perm)) continue;
    seen.add(entry.route);
    out.push({ id: one.id, route: entry.route, labelKey: `job.${one.id}` as MessageKey });
  }
  return out;
}
