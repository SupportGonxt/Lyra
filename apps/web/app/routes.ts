import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";
import { shouldInclude } from "./routing";

// Two kinds of screen live behind the session. Most of a workspace is lists and
// records, so those are one pair of generic routes driven by the specs in
// app/modules — adding a module adds a spec file, not a route. The screens that
// are genuinely their own thing (a quote comparison, a trial balance, the
// approvals queue) get a static path, which React Router ranks above the
// dynamic `:module` segment, so they win the match without extra ceremony.

// LYRA_MODULES gating lives in app/routing.ts (`shouldInclude`) so this file and
// app/modules/index.ts gate on the same answer — see that function's comment.

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("portal/:tenantSlug", "routes/portal.$tenantSlug.tsx"),
  route("portal/:tenantSlug/privacy", "routes/portal.$tenantSlug.privacy.tsx"),
  route("portal/:tenantSlug/register", "routes/portal.$tenantSlug.register.tsx"),
  route("portal/:tenantSlug/quotes/:id", "routes/portal.$tenantSlug.quotes.$id.tsx"),
  route("portal/:tenantSlug/partners", "routes/portal.$tenantSlug.partners.tsx"),
  route("portal/:tenantSlug/renewals/:id", "routes/portal.$tenantSlug.renewals.$id.tsx"),
  route("portal/:tenantSlug/feedback/:id", "routes/portal.$tenantSlug.feedback.$id.tsx"),
  layout("routes/workspace.tsx", [
    index("routes/home.tsx"),

    route("settings", "routes/settings.tsx"),
    route("settings/:tab", "routes/settings.tsx", { id: "settings-tab" }),
    route("approvals", "routes/approvals.tsx"),
    route("admin/ai/console", "routes/ai-console.tsx"),
    route("center", "routes/command-center.tsx"),
    route("admin/ai/budget", "routes/ai-budget.tsx"),
    route("admin/ai/runs/:id", "routes/ai-run.tsx"),
    route("admin/cost-explorer", "routes/cost-explorer.tsx"),
    route("ledger/reports/:report", "routes/ledger-reports.tsx"),
    route("ledger/money-map", "routes/ledger-money-map.tsx"),
    route("ledger/transactions", "routes/ledger-open-txn.tsx"),
    route("ledger/transactions/:id", "routes/ledger-transaction.tsx"),
    route("ledger/period-close", "routes/ledger-periods.tsx"),
    route("ledger/year-end", "routes/ledger-year-end.tsx"),
    route("ledger/journal", "routes/ledger-journal.tsx"),
    route("ledger/statement", "routes/ledger-account.tsx"),
    route("ledger/recon", "routes/ledger-recon.tsx"),
    route("analytics/report/:id", "routes/analytics-report.tsx"),
    route("analytics/dashboard/:id", "routes/analytics-dashboard.tsx"),
    route("distribution/quote-requests/:id/compare", "routes/quote-compare.tsx"),
    route("distribution/commission-entries/statement", "routes/commission-statement.tsx"),
    route("distribution/commission-entries/:id/clawback", "routes/commission-clawback.tsx"),
    route("distribution/next-best-offers/suggest", "routes/dist-offers.tsx"),
    route("compliance/run/:kind", "routes/compliance-run.tsx"),
    route("ledger/settlement", "routes/settlement.tsx"),
    route("ledger/settlements/:id", "routes/settlement-detail.tsx"),
    route("admin/permissions", "routes/admin-roles.tsx"),
    route("admin/developer", "routes/admin-developer.tsx"),
    route("admin/security", "routes/admin-security.tsx"),
    route("admin/automation", "routes/admin-automation.tsx"),
    route("admin/staff", "routes/staff.tsx"),
    route("admin/staff/:id", "routes/staff-member.tsx"),
    route("platform", "routes/platform.tsx"),
    // The design system explaining itself. Every role may read it — the doctrine
    // is how the product behaves, not a staff tool.
    route("design", "routes/design.tsx"),
    route("search", "routes/search.ts"),
    // Feeds the shell's companion rail; no screen of its own (routes/companion.ts).
    route("companion", "routes/companion.ts"),
    route("search/results", "routes/search-results.tsx"),
    // The checklist is the same screen for every subject; the pair of segments
    // is what it is about (partners|channels|staff, then the subject's id).
    route("onboarding/:kind/:ref", "routes/onboarding.tsx"),

    // Record screens: a static last segment, so each still ranks above the
    // generic `:module/:resource/:id`.
    route("admin/customers/:id/360", "routes/customer-360.tsx"),
    route("admin/products/:id/detail", "routes/product-detail.tsx"),
    route("distribution/channels/:id/detail", "routes/channel-detail.tsx"),

    // Every screen from the Lyra Constellation design pull (packages/ui/src/
    // sections/types.ts) — a static `surface` first segment, so it ranks
    // above the generic `:module` fallback below with no ordering effort.
    route("surface/:module/:screen", "routes/surface.tsx"),

    // Flagship demo journey: AXIS -> NORTH -> SCOUT -> SIGNAL, real API data,
    // context carried forward via query params (see components/journey-nav.tsx).
    route("journey/axis", "routes/journey-axis.tsx"),
    route("journey/north", "routes/journey-north.tsx"),
    route("journey/scout", "routes/journey-scout.tsx"),
    route("journey/signal", "routes/journey-signal.tsx"),

    route(":module", "routes/module.tsx"),
    route(":module/:resource", "routes/module.tsx", { id: "module-resource" }),
    route(":module/:resource/:id", "routes/record.tsx")
  ]),
  ...(shouldInclude("axis")
    ? [
        layout("routes/axis-shell.tsx", [
          route("axis/exceptions", "routes/axis-exceptions.tsx"),
          route("axis/board", "routes/axis-board.tsx"),
          route("axis/quote-desk", "routes/axis-quote-desk.tsx"),
          route("axis/doc-intelligence", "routes/axis-doc-intel.tsx"),
          route("axis/documents/:id/file", "routes/axis-document-file.tsx"),
          route("axis/analytics", "routes/axis-analytics.tsx"),
          route("axis/admin", "routes/axis-admin.tsx"),
          route("axis/dev", "routes/axis-dev.tsx"),
          route("axis/process-map", "routes/axis-process-map.tsx"),
          route("axis/claims/new", "routes/fnol-intake.tsx"),
          route("axis/claims/desk", "routes/claims-desk.tsx"),
          route("axis/renewals", "routes/renewal-desk.tsx"),
          route("axis/referrals", "routes/referral-desk.tsx"),
          route("axis/policies/:id/detail", "routes/policy-detail.tsx"),
          route("axis/policies/:id/endorse", "routes/policy-endorse.tsx"),
          route("axis/policies/:id/cancel", "routes/policy-cancel.tsx"),
          route("axis/claims/:id/detail", "routes/claim-detail.tsx"),
          route("axis/cases/:id/evidence-bundles/:bundleId/download", "routes/case-evidence-download.tsx"),
          route("axis/cases/:id/detail", "routes/case-detail.tsx"),
          route("axis/bordereaux", "routes/axis-bordereaux.tsx")
        ])
      ]
    : []),
  ...(shouldInclude("orbit")
    ? [
        layout("routes/orbit-shell.tsx", [
          route("orbit/conversations/:id/thread", "routes/conversation.tsx"),
          route("orbit/console", "routes/orbit-console.tsx"),
          route("orbit/supervisor", "routes/orbit-supervisor.tsx"),
          route("orbit/save", "routes/orbit-save.tsx"),
          route("orbit/pipeline", "routes/orbit-pipeline.tsx"),
          route("orbit/quality", "routes/orbit-quality.tsx"),
          route("orbit/analytics", "routes/orbit-analytics.tsx"),
          route("orbit/admin", "routes/orbit-admin.tsx"),
          route("orbit/dev", "routes/orbit-dev.tsx"),
          route("orbit/journeys/:id/builder", "routes/orbit-journey.tsx")
        ])
      ]
    : []),
  ...(shouldInclude("signal")
    ? [
        layout("routes/signal-shell.tsx", [
          route("signal/cockpit", "routes/signal-cockpit.tsx"),
          route("signal/studio", "routes/signal-studio.tsx"),
          route("signal/creatives/:id/image", "routes/signal-creative-image.tsx"),
          route("signal/audience-value", "routes/signal-audience-value.tsx"),
          route("signal/answer-engines", "routes/signal-answer-engines.tsx"),
          route("signal/experiments", "routes/signal-experiments.tsx"),
          route("signal/budget", "routes/signal-budget.tsx"),
          route("signal/analytics", "routes/signal-analytics.tsx"),
          route("signal/admin", "routes/signal-admin.tsx"),
          route("signal/dev", "routes/signal-dev.tsx")
        ])
      ]
    : []),
  ...(shouldInclude("scout")
    ? [
        layout("routes/scout-shell.tsx", [
          route("scout/radar", "routes/scout-radar.tsx"),
          route("scout/whitespace/:id", "routes/scout-whitespace.tsx"),
          route("scout/panel", "routes/scout-panel.tsx"),
          route("scout/pricing", "routes/scout-pricing.tsx"),
          route("scout/experiments", "routes/scout-experiments.tsx"),
          route("scout/analytics", "routes/scout-analytics.tsx"),
          route("scout/data-products", "routes/scout-data-products.tsx"),
          route("scout/admin", "routes/scout-admin.tsx"),
          route("scout/dev", "routes/scout-dev.tsx")
        ])
      ]
    : []),
  ...(shouldInclude("north")
    ? [
        layout("routes/north-shell.tsx", [
          route("north/brief", "routes/north-brief.tsx"),
          route("north/explorer", "routes/north-explorer.tsx"),
          route("north/anomalies", "routes/north-anomalies.tsx"),
          route("north/journeys", "routes/north-journeys.tsx"),
          route("north/alerts", "routes/north-alerts.tsx"),
          route("north/whatif", "routes/north-whatif.tsx"),
          route("north/board", "routes/north-board.tsx"),
          route("north/board/:id/file", "routes/north-board-file.tsx"),
          route("north/decisions", "routes/north-decisions.tsx"),
          route("north/admin", "routes/north-admin.tsx"),
          route("north/dev", "routes/north-dev.tsx")
        ])
      ]
    : [])
] satisfies RouteConfig;
