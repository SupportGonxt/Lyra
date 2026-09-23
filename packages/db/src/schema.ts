// Single drizzle-kit entry point (see drizzle.config.ts). Table names collide
// across modules (experiments, approvals, messages), so every export is aliased
// with its module prefix — the same prefix the physical table carries.

export {
  tenants,
  users,
  sessions,
  roles,
  userRoles,
  teams,
  customers,
  consents,
  products,
  providers,
  files,
  auditLog,
  aiAuditLog,
  eventInbox,
  eventOutbox,
  eventDlq,
  apiKeys,
  identityProviders,
  webhooks,
  webhookDeliveries,
  notifications,
  approvals,
  mandates,
  identityVerifications,
  memories,
  notes,
  links,
  lenses,
  rulepacks,
  idempotencyKeys,
  onboardingSteps,
  delegations,
  featureFlags,
  impersonationSessions,
  sloDefinitions,
  deployments,
  messageTemplates,
  localeOverrides
} from "./schema/core.js";

export {
  channels as distChannels,
  offerings as distOfferings,
  commissionRates as distCommissionRates,
  quoteRequests as distQuoteRequests,
  quoteResponses as distQuoteResponses,
  commissionEntries as distCommissionEntries,
  nextBestOffers as distNextBestOffers,
  partnerAgreements as distPartnerAgreements
} from "./schema/dist.js";

export {
  cases as axisCases,
  quotes as axisQuotes,
  documents as axisDocuments,
  tasks as axisTasks,
  approvals as axisApprovals,
  policies as axisPolicies,
  policyVersions as axisPolicyVersions,
  escrowBatches as axisEscrowBatches,
  sops as axisSops,
  processEvents as axisProcessEvents,
  opsPolicies as axisOpsPolicies,
  claims as axisClaims,
  claimReserves as axisClaimReserves,
  claimPayments as axisClaimPayments,
  claimRecoveries as axisClaimRecoveries,
  bordereaux as axisBordereaux,
  bordereauLines as axisBordereauLines,
  complaints as axisComplaints,
  siuReferrals as axisSiuReferrals,
  referrals as axisReferrals,
  telemetryPoints as axisTelemetryPoints
} from "./schema/axis.js";

export {
  conversations as orbitConversations,
  messages as orbitMessages,
  renewals as orbitRenewals,
  journeys as orbitJourneys,
  journeyRuns as orbitJourneyRuns,
  partners as orbitPartners,
  partnerTxns as orbitPartnerTxns,
  handoverNotes as orbitHandoverNotes,
  qaScores as orbitQaScores,
  channelConnectors as orbitChannelConnectors,
  channelIdentities as orbitChannelIdentities,
  teams as orbitTeams,
  teamMembers as orbitTeamMembers,
  agentPresence as orbitAgentPresence,
  routingRules as orbitRoutingRules,
  slaPolicies as orbitSlaPolicies,
  kbArticles as orbitKbArticles,
  macros as orbitMacros,
  deflections as orbitDeflections
} from "./schema/orbit.js";

export {
  audiences as signalAudiences,
  campaigns as signalCampaigns,
  creatives as signalCreatives,
  experiments as signalExperiments,
  budgetMoves as signalBudgetMoves,
  aeoPages as signalAeoPages,
  attributionEvents as signalAttributionEvents,
  spend as signalSpend,
  outreach as signalOutreach
} from "./schema/signal.js";

export {
  signals as scoutSignals,
  clusters as scoutClusters,
  whitespaces as scoutWhitespaces,
  panelBench as scoutPanelBench,
  experiments as scoutExperiments,
  dataProducts as scoutDataProducts
} from "./schema/scout.js";

export {
  metrics as northMetrics,
  snapshots as northSnapshots,
  briefings as northBriefings,
  anomalies as northAnomalies,
  scenarios as northScenarios,
  boardpacks as northBoardpacks,
  decisions as northDecisions,
  alertRules as northAlertRules
} from "./schema/north.js";

export {
  txns as ledgerTxns,
  txnTransitions as ledgerTxnTransitions,
  sagaSteps as ledgerSagaSteps,
  accounts as ledgerAccounts,
  journalBatches as ledgerJournalBatches,
  journalLines as ledgerJournalLines,
  accountBalances as ledgerAccountBalances,
  periods as ledgerPeriods,
  reconRuns as ledgerReconRuns,
  reconMatches as ledgerReconMatches,
  clientMoneyChecks as ledgerClientMoneyChecks,
  subscriptions as ledgerSubscriptions,
  invoices as ledgerInvoices,
  revenueSchedules as ledgerRevenueSchedules,
  usageMeters as ledgerUsageMeters,
  payments as ledgerPayments,
  paymentPlans as ledgerPaymentPlans,
  fxRates as ledgerFxRates,
  taxRules as ledgerTaxRules,
  settlements as ledgerSettlements
} from "./schema/ledger.js";

export {
  agents as aiAgents,
  prompts as aiPrompts,
  runs as aiRuns,
  toolCalls as aiToolCalls,
  suggestions as aiSuggestions,
  budgets as aiBudgets,
  evals as aiEvals,
  knowledgeSources as aiKnowledgeSources,
  guardrailEvents as aiGuardrailEvents,
  commandProposals as aiCommandProposals
} from "./schema/ai.js";

export {
  dsarRequests,
  erasureLog,
  disclosures,
  screenings,
  retentionRuns,
  legalHolds,
  evidenceBundles,
  incidents,
  rulepackApplications,
  policyThresholds
} from "./schema/compliance.js";

export {
  dashboards,
  reports,
  reportRuns,
  exports as analyticsExports,
  schedules as analyticsSchedules,
  savedViews,
  unitEconomics,
  egressDays,
  journeyEvents
} from "./schema/analytics.js";
