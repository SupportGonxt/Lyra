import { data, redirect } from "react-router";
import type { CalendarPreference } from "@lyra/ui";
import type { Brand, NavItem } from "./api.server";
import { api, ApiError, fetchMe, names } from "./api.server";
import { calendarFrom, FALLBACK_CURRENCY, timezoneFrom } from "./calendar";
import type { Names } from "./names";
import type { Inbox } from "./components/shift";
import { chosenLocale } from "./i18n";
import { DEFAULT_PACK } from "./modules/vocabulary";
import { availableShellsForRoles } from "./routing";
import type { Env } from "./env";

// Everything behind a session hangs off one bootstrap call: actor, tenant
// brand, permissions, and the nav the API already filtered for them. Both
// workspace.tsx (every non-module screen) and north-shell.tsx (NORTH's own
// layout) call this identically — tenancy/RBAC/audit stay centralized in one
// place no matter how many module shells exist (CLAUDE.md rule 1).

export interface SessionBootstrap {
  locale: string;
  inbox: Inbox | null;
  names: Names;
  nav: NavItem[];
  roles: string[];
  permissions: string[];
  brand: Brand | null;
  tenantName: string;
  actorName: string | null;
  domainPack: string;
  calendar: CalendarPreference;
  /** The tenant's own zone, or absent — then a screen renders in the reader's. */
  timezone: string | undefined;
  currency: string;
  overrides: Record<string, string>;
  /** Every module workspace this actor's real roles resolve to (Task 1/2's
   *  availableShellsForRoles), not just the first-wins default. Powers the
   *  multi-role switcher — absent or length-1 means it never renders. */
  availableShells: string[];
  /** The AI kill switch (tenant policy): everything, or these modules. J-A3. */
  aiPause: AiPause;
}

export interface AiPause {
  all: boolean;
  modules: string[];
}

export async function bootstrapSession(env: Env, request: Request): Promise<SessionBootstrap> {
  let me;
  try {
    me = await fetchMe(env, request);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const next = new URL(request.url).pathname;
      throw redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    // Anything else keeps its status and carries the request id to the boundary,
    // so the message a user reads is the one support can look up.
    if (error instanceof ApiError) throw data(error.requestId ?? "", { status: error.status });
    throw error;
  }

  // The shell's day strip and shift block. Tolerant on purpose: this call is
  // decoration around the work, and a queue that failed to load must not take
  // the screen the actor asked for down with it. Both surfaces render nothing
  // when it is null.
  const inbox = await api<Inbox>("/v1/me/inbox", { env, request }).catch(() => null);

  // The rail lists the approvals by what they are about, and an approval holds a
  // ref, not a name. Batched into one call, and skipped entirely when the queue
  // is empty (names() returns {} for no refs without touching the network).
  const subjects = await names(
    (inbox?.approvals ?? []).map((approval) => approval.subjectRef),
    { env, request }
  );

  return {
    // The explicit choice wins over the stored one, because <html lang>/dir come
    // from that same cookie (root.tsx) and the two must not disagree. The pseudo
    // locale — which no profile can hold — is the case that makes it obvious.
    locale: chosenLocale(request) ?? me.locale,
    inbox,
    names: subjects,
    nav: me.nav,
    roles: me.roles,
    permissions: me.permissions,
    brand: me.tenant.brand,
    tenantName: me.tenant.name,
    actorName: me.profile?.name ?? null,
    // CLAUDE.md §14: the pack that renames every noun downstream of labelsFor.
    domainPack: typeof me.policy?.domainPack === "string" ? me.policy.domainPack : DEFAULT_PACK,
    calendar: calendarFrom(me.policy?.calendarPreference),
    // What "today" means for this tenant. The scheduler already reckons a
    // report's cron against a named zone (apps/api/src/routes/analytics.ts);
    // without this the screens reckoned against whatever zone the reader's
    // laptop was in, and the two disagreed about which day a cutoff fell on.
    timezone: timezoneFrom(me.policy?.timezone),
    // What a money figure is denominated in when the row itself does not say.
    // Same policy field the brand editor writes (settings.tsx).
    currency: typeof me.policy?.currency === "string" ? me.policy.currency : FALLBACK_CURRENCY,
    // A tenant admin's i18n key relabels (core_locale_overrides), merged by
    // translator() over the static catalogue — see apps/web/app/i18n.ts.
    overrides: me.overrides ?? {},
    availableShells: availableShellsForRoles(me.roles),
    aiPause: {
      all: me.policy?.aiPaused === true,
      modules: Array.isArray(me.policy?.aiPausedModules) ? me.policy.aiPausedModules.filter((m): m is string => typeof m === "string") : []
    }
  };
}
