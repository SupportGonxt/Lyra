/**
 * Each module's own screens, with the permission its loader's primary read
 * needs — checked against the loader and the API guard (2026-09-23). The rail
 * offers a screen only to a reader who holds it (ADR-0085). Plain data, so the
 * e2e specs assert the rail against the same table the shell renders.
 */
export interface ModuleScreen {
  href: string;
  /** Absent: anyone the module's layout already admits can use it. */
  permission?: string;
}

export const AXIS_SCREENS: readonly ModuleScreen[] = [
  { href: "/axis/exceptions", permission: "axis:cases:read" },
  { href: "/axis/board", permission: "axis:cases:read" },
  { href: "/axis/quote-desk", permission: "axis:cases:read" },
  { href: "/axis/doc-intelligence", permission: "axis:documents:read" },
  { href: "/axis/analytics", permission: "analytics:reports:run" },
  { href: "/axis/process-map", permission: "axis:metrics:read" },
  { href: "/axis/renewals", permission: "orbit:renewals:read" },
  { href: "/axis/referrals", permission: "axis:policies:decide_referral" },
  { href: "/axis/claims/desk", permission: "axis:claims:read" },
  { href: "/axis/bordereaux", permission: "axis:bordereaux:read" },
  { href: "/axis/admin", permission: "axis:sops:read" },
  { href: "/axis/dev", permission: "dev:sandbox:use" }
];

export const ORBIT_SCREENS: readonly ModuleScreen[] = [
  { href: "/orbit/console", permission: "orbit:conversations:read" },
  { href: "/orbit/supervisor", permission: "orbit:conversations:read" },
  { href: "/orbit/save", permission: "orbit:renewals:read" },
  { href: "/orbit/pipeline", permission: "orbit:renewals:read" },
  { href: "/orbit/quality", permission: "orbit:qa:read" },
  { href: "/orbit/analytics", permission: "orbit:conversations:read" },
  { href: "/orbit/admin", permission: "orbit:teams:read" },
  { href: "/orbit/dev", permission: "orbit:messages:send" }
];

export const SIGNAL_SCREENS: readonly ModuleScreen[] = [
  { href: "/signal/cockpit", permission: "signal:campaigns:read" },
  { href: "/signal/studio", permission: "signal:campaigns:read" },
  { href: "/signal/audience-value", permission: "signal:audiences:read" },
  { href: "/signal/answer-engines", permission: "signal:aeo:read" },
  { href: "/signal/experiments", permission: "signal:experiments:read" },
  { href: "/signal/budget", permission: "signal:campaigns:read" },
  { href: "/signal/analytics", permission: "signal:spend:read" },
  { href: "/signal/admin", permission: "signal:campaigns:read" },
  { href: "/signal/dev", permission: "signal:audiences:read" }
];

export const SCOUT_SCREENS: readonly ModuleScreen[] = [
  { href: "/scout/radar", permission: "scout:whitespaces:read" },
  { href: "/scout/panel", permission: "scout:panel_bench:read" },
  { href: "/scout/pricing", permission: "scout:panel_bench:read" },
  { href: "/scout/experiments", permission: "scout:experiments:read" },
  { href: "/scout/analytics", permission: "scout:panel_bench:read" },
  { href: "/scout/data-products", permission: "scout:data_products:read" },
  { href: "/scout/admin", permission: "scout:signals:read" },
  { href: "/scout/dev", permission: "scout:signals:read" }
];

export const NORTH_SCREENS: readonly ModuleScreen[] = [
  { href: "/north/brief", permission: "north:briefings:read" },
  { href: "/north/explorer", permission: "north:metrics:read" },
  { href: "/north/anomalies", permission: "north:anomalies:read" },
  { href: "/north/journeys", permission: "north:metrics:read" },
  { href: "/north/alerts", permission: "north:alerts:read" },
  { href: "/north/whatif", permission: "north:scenarios:read" },
  { href: "/north/board", permission: "north:boardpacks:read" },
  { href: "/north/decisions", permission: "north:decisions:read" },
  { href: "/north/admin", permission: "north:metrics:read" },
  { href: "/north/dev", permission: "north:metrics:read" }
];
