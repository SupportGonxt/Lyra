// GENERATED FILE — do not edit. Run `pnpm generate` (packages/sdk/scripts/generate.ts).
// Source of truth: apps/api/src/openapi.ts. src/sdk.test.ts fails if this file
// and that document disagree, so a contract break cannot land silently.

/** A page of rows. Pass `cursor` back as `?cursor=`; absent once the last page is read. */
export interface Page<T> {
  data: T[];
  cursor?: string;
}

/** One endpoint's shapes. `never` means the endpoint takes none of that kind. */
export interface Op<Params, Query, Body, Result> {
  params: Params;
  query: Query;
  body: Body;
  result: Result;
}

export interface OperationMeta {
  tag: string;
  summary: string;
  /** Permission the caller must hold, or null when the endpoint is self-scoped. */
  permission: string | null;
  /** Reachable without a session (the pre-session auth endpoints only). */
  public: boolean;
}

/* ------------------------------------------------------------------ schemas */

export interface AiAgents {
  id?: string;
  tenantId?: string;
  key: string;
  module: string;
  nameJson: string;
  descriptionJson?: string;
  autonomyLevel?: string;
  tier?: string;
  toolsJson?: string;
  guardrailsJson?: string;
  promptRef?: string;
  status?: string;
  pausedBy?: string;
  pausedReason?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AiAiAuditLog {
  id?: string;
  tenantId?: string;
  module: string;
  purpose: string;
  model: string;
  provider: string;
  tier: string;
  inputHash: string;
  outputHash?: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicro?: number;
  latencyMs?: number;
  toolCallsJson?: string;
  guardrailFlagsJson?: string;
  actorRef: string;
  subjectRef?: string;
  outcome?: string;
  ts: number;
}

export interface AiBudgets {
  id?: string;
  tenantId?: string;
  day: string;
  module?: string;
  tokensUsed?: number;
  costMicroUsed?: number;
  tokensLimit: number;
  costMicroLimit: number;
  thresholdNotifiedAt?: number;
  stoppedAt?: number;
  updatedAt?: number;
}

export interface AiEvals {
  id?: string;
  tenantId?: string;
  suite: string;
  caseKey: string;
  agentKey: string;
  model: string;
  score: number;
  passed: boolean;
  thresholdScore: number;
  detailJson?: string;
  gitSha?: string;
  ts: number;
}

export interface AiGuardrailEvents {
  id?: string;
  tenantId?: string;
  runId?: string;
  rule: string;
  severity?: string;
  detail?: string;
  subjectRef?: string;
  ts: number;
}

export interface AiKnowledgeSources {
  id?: string;
  tenantId?: string;
  name: string;
  kind: string;
  uri?: string;
  fileId?: string;
  locale?: string;
  piiLevel?: string;
  chunkCount?: number;
  indexNamespace?: string;
  status?: string;
  lastIndexedAt?: number;
  createdAt?: number;
}

export interface AiPrompts {
  id?: string;
  tenantId?: string;
  key: string;
  version?: number;
  locale?: string;
  body: string;
  variablesJson?: string;
  status?: string;
  createdBy?: string;
  createdAt?: number;
}

export interface AiRuns {
  id?: string;
  tenantId?: string;
  agentKey: string;
  module: string;
  purpose: string;
  subjectRef?: string;
  actorRef: string;
  autonomyLevel: string;
  trigger?: string;
  state?: string;
  inputHash: string;
  outputRef?: string;
  confidence?: number;
  evidenceJson?: string;
  reasoningRef?: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicro?: number;
  latencyMs?: number;
  approvalId?: string;
  errorCode?: string;
  startedAt: number;
  endedAt?: number;
}

export interface AiSuggestions {
  id?: string;
  tenantId?: string;
  runId?: string;
  surface: string;
  module: string;
  subjectRef?: string;
  userId: string;
  contentRef?: string;
  outcome?: string;
  editDistance?: number;
  shownAt: number;
  resolvedAt?: number;
}

export interface AiToolCalls {
  id?: string;
  tenantId?: string;
  runId: string;
  seq: number;
  tool: string;
  argsHash: string;
  argsRedactedJson?: string;
  consequential?: boolean;
  approvalId?: string;
  outcome?: string;
  resultHash?: string;
  durationMs?: number;
  ts: number;
}

export interface AnalyticsDashboards {
  id?: string;
  tenantId?: string;
  key: string;
  module: string;
  nameJson: string;
  layoutJson: string;
  scope?: string;
  ownerRef?: string;
  rolesJson?: string;
  isDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface AnalyticsExports {
  id?: string;
  tenantId?: string;
  runId?: string;
  reportId?: string;
  subjectRef?: string;
  format: string;
  fileId?: string;
  sizeBytes?: number;
  rowCount?: number;
  piiMasked?: boolean;
  piiJustification?: string;
  watermark?: string;
  requestedBy?: string;
  approvedBy?: string;
  state?: string;
  downloadCount?: number;
  expiresAt?: number;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AnalyticsJourneyEvents {
  id?: string;
  tenantId?: string;
  journeyId: string;
  step: string;
  actorRef: string;
  subjectRef?: string;
  outcome?: string;
  durationMs?: number;
  ts: number;
}

export interface AnalyticsReportRuns {
  id?: string;
  tenantId?: string;
  reportId: string;
  paramsJson?: string;
  requestedBy?: string;
  trigger?: string;
  state?: string;
  rowCount?: number;
  resultRef?: string;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  expiresAt?: number;
  startedAt: number;
  endedAt?: number;
}

export interface AnalyticsReports {
  id?: string;
  tenantId?: string;
  key: string;
  module: string;
  nameJson: string;
  descriptionJson?: string;
  definitionJson: string;
  piiLevel?: string;
  requiredPermission: string;
  ownerRef?: string;
  scope?: string;
  system?: boolean;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface AnalyticsSavedViews {
  id?: string;
  tenantId?: string;
  userId?: string;
  route: string;
  name: string;
  queryJson: string;
  columnsJson?: string;
  isDefault?: boolean;
  sharedWithJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AnalyticsSchedules {
  id?: string;
  tenantId?: string;
  reportId?: string;
  dashboardId?: string;
  nameJson: string;
  cron: string;
  timezone?: string;
  format?: string;
  recipientsJson: string;
  paramsJson?: string;
  locale?: string;
  status?: string;
  lastRunAt?: number;
  lastState?: string;
  nextRunAt?: number;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AnalyticsUnitEconomics {
  id?: string;
  tenantId?: string;
  day: string;
  module: string;
  unit: string;
  volume?: number;
  aiCostMicro?: number;
  mediaCostMicro?: number;
  humanMinutes?: number;
  revenueMinor?: number;
  currency: string;
  updatedAt?: number;
}

export interface AxisBordereauLines {
  id?: string;
  tenantId?: string;
  bordereauId: string;
  lineNo: number;
  policyId?: string;
  policyVersionId?: string;
  claimId?: string;
  externalRef?: string;
  riskRef?: string;
  effectiveFrom?: number;
  effectiveTo?: number;
  grossPremiumMinor?: number;
  taxMinor?: number;
  netPremiumMinor?: number;
  commissionMinor?: number;
  claimsPaidMinor?: number;
  reserveMinor?: number;
  currency: string;
  matchState?: string;
  varianceMinor?: number;
  rawJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisBordereaux {
  id?: string;
  tenantId?: string;
  direction: string;
  counterpartyKind: string;
  counterpartyId: string;
  kind: string;
  period: string;
  currency: string;
  lineCount?: number;
  grossPremiumMinor?: number;
  commissionMinor?: number;
  claimsPaidMinor?: number;
  reserveMinor?: number;
  varianceMinor?: number;
  state?: string;
  fileId?: string;
  sourceFileId?: string;
  escrowBatchId?: string;
  generatedBy?: string;
  generatedAt?: number;
  closedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisCaseApprovals {
  id?: string;
  tenantId?: string;
  approvalId: string;
  caseId: string;
  subjectRef: string;
  policyKey: string;
  decision?: string;
  ts: number;
}

export interface AxisCases {
  id?: string;
  tenantId?: string;
  ref: string;
  kind: string;
  customerId?: string;
  productLine?: string;
  channelId?: string;
  quoteRequestId?: string;
  status?: string;
  slaDueAt?: number;
  ownerRef?: string;
  teamId?: string;
  priority?: string;
  source?: string;
  riskScore?: number;
  valueMinor?: number;
  currency?: string;
  metaJson?: string;
  closedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface AxisClaims {
  id?: string;
  tenantId?: string;
  policyId: string;
  customerId: string;
  caseId?: string;
  claimNo: string;
  incidentAt?: number;
  reportedAt: number;
  amountMinor?: number;
  settledMinor?: number;
  currency: string;
  status?: string;
  fnolJson?: string;
  assessorRef?: string;
  policyVersionId?: string;
  coverageState?: string;
  coverageCheckedAt?: number;
  coverageJson?: string;
  perilCode?: string;
  causeCode?: string;
  catCode?: string;
  reserveMinor?: number;
  paidMinor?: number;
  recoveredMinor?: number;
  excessMinor?: number;
  handlerRef?: string;
  slaDueAt?: number;
  fraudScore?: number;
  siuState?: string;
  complexity?: string;
  reopenedAt?: number;
  closedAt?: number;
  lastTxnId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisComplaints {
  id?: string;
  tenantId?: string;
  ref: string;
  customerId?: string;
  policyId?: string;
  claimId?: string;
  caseId?: string;
  channel: string;
  categoryCode: string;
  summarySealed?: string;
  receivedAt: number;
  acknowledgedAt?: number;
  dueAt: number;
  resolvedAt?: number;
  state?: string;
  outcome?: string;
  rootCauseCode?: string;
  redressMinor?: number;
  currency?: string;
  regulatorRef?: string;
  ownerRef?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisDocuments {
  id?: string;
  tenantId?: string;
  caseId: string;
  fileId: string;
  docType: string;
  extractionJson?: string;
  extractionConfidence?: number;
  extractionModel?: string;
  verifiedBy?: string;
  verifiedAt?: number;
  status?: string;
  createdAt?: number;
}

export interface AxisEscrowBatches {
  id?: string;
  tenantId?: string;
  period: string;
  providerId: string;
  expectedMinor?: number;
  receivedMinor?: number;
  currency: string;
  status?: string;
  varianceReason?: string;
  evidenceFileId?: string;
  closedBy?: string;
  closedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisOpsPolicies {
  id?: string;
  tenantId?: string;
  key: string;
  kind: string;
  valueJson: string;
  status?: string;
  updatedBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisPolicies {
  id?: string;
  tenantId?: string;
  caseId?: string;
  customerId: string;
  providerId: string;
  productId?: string;
  offeringId?: string;
  channelId?: string;
  policyNo: string;
  startAt: number;
  endAt: number;
  premiumMinor: number;
  currency: string;
  commissionMinor?: number;
  docsJson?: string;
  escrowBatchId?: string;
  paymentPlanJson?: string;
  currentVersionId?: string;
  versionSeq?: number;
  taxMinor?: number;
  feesMinor?: number;
  grossMinor?: number;
  renewedFromPolicyId?: string;
  renewalSeq?: number;
  inceptedAt?: number;
  lapsedAt?: number;
  cancelledAt?: number;
  cancelReasonCode?: string;
  cancelEffectiveAt?: number;
  statusReason?: string;
  lastTxnId?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisProcessEvents {
  id?: string;
  tenantId?: string;
  caseId: string;
  step: string;
  actorRef: string;
  durationMs?: number;
  outcome?: string;
  ts: number;
}

export interface AxisQuotes {
  id?: string;
  tenantId?: string;
  caseId: string;
  providerId: string;
  offeringId?: string;
  responseId?: string;
  premiumMinor: number;
  currency: string;
  coverageJson?: string;
  validUntil?: number;
  winFlag?: boolean;
  declineReason?: string;
  source?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisReferrals {
  id?: string;
  tenantId?: string;
  caseId?: string;
  policyId?: string;
  quoteResponseId?: string;
  kind: string;
  triggerJson: string;
  valueMinor?: number;
  currency?: string;
  state?: string;
  decidedBy?: string;
  decisionNote?: string;
  counterTermsJson?: string;
  approvalId?: string;
  slaDueAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisSiuReferrals {
  id?: string;
  tenantId?: string;
  claimId: string;
  policyId?: string;
  score: number;
  reasonsJson: string;
  aiAuditId?: string;
  source?: string;
  state?: string;
  assignedTo?: string;
  outcome?: string;
  savedMinor?: number;
  currency?: string;
  openedAt: number;
  closedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisSops {
  id?: string;
  tenantId?: string;
  key: string;
  version?: number;
  nameJson: string;
  stepsJson: string;
  appliesTo?: string;
  status?: string;
  createdBy?: string;
  createdAt?: number;
}

export interface AxisTasks {
  id?: string;
  tenantId?: string;
  caseId?: string;
  type: string;
  titleKey: string;
  assigneeRef?: string;
  state?: string;
  dueAt?: number;
  checklistJson?: string;
  createdBy?: string;
  completedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AxisTelemetryPoints {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  source: string;
  at: number;
  value: number;
  txnId: string;
  createdAt?: number;
}

export interface ComplianceDisclosures {
  id?: string;
  tenantId?: string;
  key: string;
  locale?: string;
  subjectRef: string;
  customerId?: string;
  wordingHash: string;
  wordingRef?: string;
  criteriaJson?: string;
  channel: string;
  acknowledgedAt?: number;
  ts: number;
}

export interface ComplianceDsarRequests {
  id?: string;
  tenantId?: string;
  customerId?: string;
  subjectIdentifier: string;
  type: string;
  channel: string;
  verificationRef?: string;
  subjectNote?: string;
  state?: string;
  dueAt: number;
  fulfilledAt?: number;
  refusalReason?: string;
  bundleFileId?: string;
  completenessProofJson?: string;
  handledBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ComplianceErasureLog {
  id?: string;
  tenantId?: string;
  dsarId: string;
  tableName: string;
  rowsErased?: number;
  rowsTombstoned?: number;
  retainedReason?: string;
  ts: number;
}

export interface ComplianceEvidenceBundles {
  id?: string;
  tenantId?: string;
  purpose: string;
  scopeJson: string;
  manifestJson: string;
  bundleHash: string;
  fileId?: string;
  requestedBy?: string;
  approvedBy?: string;
  state?: string;
  deliveredTo?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ComplianceIncidents {
  id?: string;
  tenantId?: string;
  kind: string;
  severity?: string;
  title: string;
  summary?: string;
  affectedJson?: string;
  agentsPaused?: boolean;
  notifiableAt?: number;
  notifiedAt?: number;
  state?: string;
  openedBy?: string;
  resolvedAt?: number;
  postmortemRef?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ComplianceLegalHolds {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  reason: string;
  authority?: string;
  placedBy?: string;
  releasedBy?: string;
  releasedAt?: number;
  createdAt?: number;
}

export interface CompliancePolicyThresholds {
  id?: string;
  tenantId?: string;
  key: string;
  version?: number;
  valueJson: string;
  dualControl?: boolean;
  effectiveFrom: number;
  effectiveTo?: number;
  setBy?: string;
}

export interface ComplianceRetentionRuns {
  id?: string;
  tenantId?: string;
  policyKey: string;
  tableName: string;
  cutoffAt: number;
  rowsAffected?: number;
  rowsHeld?: number;
  state?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ComplianceRulepackApplications {
  id?: string;
  tenantId?: string;
  rulepackId: string;
  subjectRef: string;
  ruleKey: string;
  outcome: string;
  detailJson?: string;
  ts: number;
}

export interface ComplianceScreenings {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  kind: string;
  provider: string;
  queryHash: string;
  result: string;
  hitsJson?: string;
  dispositionedBy?: string;
  disposition?: string;
  blocked?: boolean;
  caseRef?: string;
  ts: number;
}

export interface CoreApiKeys {
  id?: string;
  tenantId?: string;
  name: string;
  prefix: string;
  keyHash: string;
  mode?: string;
  scopesJson: string;
  createdBy: string;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  createdAt?: number;
}

export interface CoreApprovals {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  policyKey: string;
  module: string;
  requestedBy: string;
  requestedAt: number;
  decidedBy?: string;
  decision?: string;
  reason?: string;
  contextJson?: string;
  decidedAt?: number;
  delegationId?: string;
}

export interface CoreAuditLog {
  id?: string;
  tenantId?: string;
  actorRef: string;
  action: string;
  subjectRef?: string;
  beforeHash?: string;
  afterHash?: string;
  prevHash?: string;
  chainHash: string;
  ip?: string;
  ua?: string;
  ts: number;
}

export interface CoreConsents {
  id?: string;
  tenantId?: string;
  customerId: string;
  purposesJson: string;
  channelOptinsJson: string;
  source: string;
  evidenceRef?: string;
  ts: number;
  expiry?: number;
  version?: number;
}

export interface CoreCustomers {
  id?: string;
  tenantId?: string;
  type?: string;
  nameJson: string;
  emailsJson?: string;
  phonesJson?: string;
  nationalIdHash?: string;
  registrationNo?: string;
  taxId?: string;
  country?: string;
  kycStatus?: string;
  consentId?: string;
  tagsJson?: string;
  ltvCached?: number;
  riskFlagsJson?: string;
  locale?: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface CoreDelegations {
  id?: string;
  tenantId?: string;
  fromUserId: string;
  toUserId: string;
  reason: string;
  scopeJson?: string;
  maxAmountMinor?: number;
  currency?: string;
  startsAt: number;
  endsAt: number;
  status?: string;
  createdBy: string;
  revokedBy?: string;
  revokedAt?: number;
  createdAt?: number;
}

export interface CoreEventDlq {
  id?: string;
  tenantId?: string;
  type: string;
  consumer: string;
  envelopeJson: string;
  error: string;
  attempts: number;
  replayedAt?: number;
  createdAt?: number;
}

export interface CoreFiles {
  id?: string;
  tenantId?: string;
  r2Key: string;
  kind: string;
  subjectRef?: string;
  sha256: string;
  sizeBytes?: number;
  contentType?: string;
  piiLevel?: string;
  createdAt?: number;
  deletedAt?: number;
}

export interface CoreIdentityProviders {
  id?: string;
  tenantId?: string;
  kind?: string;
  name: string;
  emailDomain: string;
  issuer: string;
  clientId?: string;
  clientSecretRef?: string;
  discoveryUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
  ssoUrl?: string;
  certificate?: string;
  defaultRoleKey?: string;
  enabled?: boolean;
  mfaAsserted?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreIdentityVerifications {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  method: string;
  evidenceLevel: string;
  providerRef?: string;
  expiry?: number;
  createdAt?: number;
}

export interface CoreLenses {
  id?: string;
  tenantId?: string;
  userId: string;
  lensJson: string;
  updatedAt?: number;
}

export interface CoreLocaleOverrides {
  id?: string;
  tenantId?: string;
  locale: string;
  key: string;
  value: string;
  updatedBy: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreMandates {
  id?: string;
  tenantId?: string;
  principalRef: string;
  agentIdentity: string;
  scopeJson: string;
  spendCapMinor?: number;
  currency?: string;
  verificationRef?: string;
  expiry?: number;
  status?: string;
  createdAt?: number;
}

export interface CoreMemories {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  kind: string;
  contentJson: string;
  provenance: string;
  sensitivity?: string;
  purposesJson?: string;
  expiry?: number;
  createdAt?: number;
}

export interface CoreMessageTemplates {
  id?: string;
  tenantId?: string;
  key: string;
  channel: string;
  subjectJson?: string;
  bodyJson: string;
  variablesJson?: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface CoreNotifications {
  id?: string;
  tenantId?: string;
  userId: string;
  kind: string;
  titleKey: string;
  paramsJson?: string;
  subjectRef?: string;
  readAt?: number;
  createdAt?: number;
}

export interface CoreOnboardingSteps {
  id?: string;
  tenantId?: string;
  subjectKind: string;
  subjectRef: string;
  template: string;
  key: string;
  labelJson: string;
  seq: number;
  required?: boolean;
  gatesStage: string;
  state?: string;
  evidenceKind?: string;
  evidenceRef?: string;
  ownerRef?: string;
  dueAt?: number;
  notesJson?: string;
  waivedApprovalId?: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreProducts {
  id?: string;
  tenantId?: string;
  line: string;
  nameJson: string;
  providerId?: string;
  termsRef?: string;
  status?: string;
  structure?: string;
  takafulJson?: string;
  parametricTriggerJson?: string;
  standardMappingJson?: string;
  pricingInputsJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreProviders {
  id?: string;
  tenantId?: string;
  name: string;
  kind?: string;
  isInternal?: boolean;
  linesJson?: string;
  integrationJson?: string;
  commissionJson?: string;
  settlementTermsJson?: string;
  currency?: string;
  quoteEndpointJson?: string;
  panelStatus?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreRoles {
  id?: string;
  tenantId?: string;
  key: string;
  name: string;
  permissionsJson: string;
  system?: boolean;
  createdAt?: number;
}

export interface CoreRulepacks {
  id?: string;
  tenantId?: string;
  market: string;
  version: string;
  effectiveAt: number;
  rulesJson: string;
  createdAt?: number;
}

export interface CoreTeams {
  id?: string;
  tenantId?: string;
  name: string;
  moduleScope?: string;
  createdAt?: number;
}

export interface CoreTenants {
  id?: string;
  slug: string;
  name: string;
  plan?: string;
  region?: string;
  dbBinding?: string;
  status?: string;
  brandJson?: string;
  policyJson?: string;
  entitlementsJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CoreUserRoles {
  id?: string;
  tenantId?: string;
  userId: string;
  roleId: string;
  scopeJson?: string;
  createdAt?: number;
}

export interface CoreUsers {
  id?: string;
  tenantId?: string;
  email: string;
  phone?: string;
  name: string;
  locale?: string;
  status?: string;
  authProvider?: string;
  passwordHash?: string;
  mfaEnrolled?: boolean;
  mfaSecret?: string;
  mfaRecoveryJson?: string;
  externalId?: string;
  providerId?: string;
  lastSeenAt?: number;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface CoreWebhookDeliveries {
  id?: string;
  tenantId?: string;
  webhookId: string;
  eventId: string;
  status: string;
  responseCode?: number;
  attempts?: number;
  nextAttemptAt?: number;
  error?: string;
  createdAt?: number;
}

export interface CoreWebhooks {
  id?: string;
  tenantId?: string;
  url: string;
  eventTypesJson: string;
  secret: string;
  status?: string;
  createdAt?: number;
}

export interface Dataset {
  key?: "policies" | "quotes" | "quoteResponses" | "commissions" | "cases" | "transactions" | "aiSpend" | "conversations" | "campaigns" | "spend" | "signals" | "whitespaces" | "boardpacks" | "decisions";
  module?: string;
  dimensions?: Record<string, unknown>[];
  metrics?: Record<string, unknown>[];
}

export interface DistChannels {
  id?: string;
  tenantId?: string;
  key: string;
  kind: string;
  nameJson: string;
  partnerId?: string;
  medium?: string;
  collectsPayment?: string;
  settlementTermsJson?: string;
  defaultCommissionPpm?: number;
  currency?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface DistCommissionEntries {
  id?: string;
  tenantId?: string;
  policyId: string;
  offeringId?: string;
  providerId: string;
  channelId: string;
  rateId?: string;
  kind?: string;
  premiumMinor: number;
  grossCommissionMinor: number;
  channelCommissionMinor?: number;
  netCommissionMinor: number;
  taxMinor?: number;
  currency: string;
  earnedOn?: string;
  earnedAt?: number;
  reversalOf?: string;
  providerSettlementId?: string;
  channelSettlementId?: string;
  txnId?: string;
  state?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DistCommissionRates {
  id?: string;
  tenantId?: string;
  channelId: string;
  offeringId?: string;
  productId?: string;
  line?: string;
  channelSharePpm: number;
  baseCommissionPpm?: number;
  flatFeeMinor?: number;
  currency?: string;
  earnedOn?: string;
  clawbackDays?: number;
  effectiveFrom: number;
  effectiveTo?: number;
  createdBy?: string;
  createdAt?: number;
}

export interface DistNextBestOffers {
  id?: string;
  tenantId?: string;
  customerId: string;
  kind: string;
  offeringId: string;
  anchorRef?: string;
  channelId?: string;
  score: number;
  expectedValueMinor?: number;
  currency?: string;
  reasonKey: string;
  reasonJson?: string;
  runId?: string;
  model?: string;
  state?: string;
  suppressReason?: string;
  surfacedAt?: number;
  decidedAt?: number;
  convertedRequestId?: string;
  expiresAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface DistOfferings {
  id?: string;
  tenantId?: string;
  productId: string;
  providerId: string;
  code: string;
  nameJson: string;
  currency: string;
  pricingMode?: string;
  ratingInputsJson?: string;
  ratingTableJson?: string;
  coverageJson?: string;
  eligibilityJson?: string;
  baseCommissionPpm?: number;
  maxDiscountPpm?: number;
  minPremiumMinor?: number;
  maxSumInsuredMinor?: number;
  slaSeconds?: number;
  channelKeysJson?: string;
  upsellOfOfferingId?: string;
  crossSellTagsJson?: string;
  status?: string;
  effectiveFrom: number;
  effectiveTo?: number;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface DistPartnerAgreements {
  id?: string;
  tenantId?: string;
  partnerId: string;
  version: number;
  kind?: string;
  termsJson: string;
  documentFileId?: string;
  signedByUserId?: string;
  signedByPartnerName?: string;
  signedAt?: number;
  effectiveFrom?: number;
  effectiveTo?: number;
  state?: string;
  supersedesId?: string;
  approvalId?: string;
  createdBy: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DistQuoteRequests {
  id?: string;
  tenantId?: string;
  caseId?: string;
  customerId?: string;
  channelId: string;
  productId: string;
  inputsJson: string;
  consentId?: string;
  fanoutCount?: number;
  respondedCount?: number;
  bestOfferingId?: string;
  bestPremiumMinor?: number;
  currency: string;
  sharedWithCustomerAt?: number;
  portalTokenHash?: string;
  state?: string;
  expiresAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface DistQuoteResponses {
  id?: string;
  tenantId?: string;
  requestId: string;
  offeringId: string;
  providerId: string;
  state?: string;
  premiumMinor?: number;
  taxMinor?: number;
  feesMinor?: number;
  currency?: string;
  commissionPpm?: number;
  commissionMinor?: number;
  channelCommissionMinor?: number;
  coverageJson?: string;
  priceRank?: number;
  valueScore?: number;
  rationaleKey?: string;
  declineReason?: string;
  latencyMs?: number;
  validUntil?: number;
  rawRef?: string;
  selectedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerAccountBalances {
  id?: string;
  tenantId?: string;
  accountCode: string;
  currency: string;
  debitMinor?: number;
  creditMinor?: number;
  baseDebitMinor?: number;
  baseCreditMinor?: number;
  updatedAt?: number;
}

export interface LedgerAccounts {
  id?: string;
  tenantId?: string;
  code: string;
  nameJson: string;
  type: string;
  normalSide: string;
  clientMoney?: boolean;
  currency?: string;
  parentCode?: string;
  status?: string;
  createdAt?: number;
}

export interface LedgerClientMoneyChecks {
  id?: string;
  tenantId?: string;
  assetMinor: number;
  liabilityMinor: number;
  currency: string;
  shortfallMinor?: number;
  breach?: boolean;
  triggeredBy: string;
  resolvedAt?: number;
  ts: number;
}

export interface LedgerFxRates {
  id?: string;
  tenantId?: string;
  fromCurrency: string;
  toCurrency: string;
  ratePpm: number;
  asOf: string;
  source?: string;
}

export interface LedgerInvoices {
  id?: string;
  tenantId?: string;
  number: string;
  customerRef: string;
  subscriptionId?: string;
  subtotalMinor: number;
  taxMinor?: number;
  totalMinor: number;
  currency: string;
  linesJson: string;
  state?: string;
  dueAt?: number;
  issuedAt?: number;
  paidAt?: number;
  pdfFileId?: string;
  txnId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerJournalBatches {
  id?: string;
  tenantId?: string;
  txnId: string;
  periodId: string;
  currency: string;
  baseCurrency: string;
  fxRatePpm?: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  baseTotalDebitMinor: number;
  baseTotalCreditMinor: number;
  reversalOfBatchId?: string;
  postedBy: string;
  postedAt: number;
}

export interface LedgerJournalLines {
  id?: string;
  tenantId?: string;
  batchId: string;
  txnId: string;
  seq: number;
  accountCode: string;
  side: string;
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  baseCurrency: string;
  memo?: string;
  dimsJson?: string;
  postedAt: number;
}

export interface LedgerPaymentPlans {
  id?: string;
  tenantId?: string;
  subjectRef: string;
  financierRef?: string;
  totalMinor: number;
  currency: string;
  instalments: number;
  scheduleJson: string;
  state?: string;
  missedStreak?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerPayments {
  id?: string;
  tenantId?: string;
  txnId?: string;
  direction: string;
  method: string;
  providerRef?: string;
  providerToken?: string;
  amountMinor: number;
  currency: string;
  feeMinor?: number;
  state?: string;
  failureCode?: string;
  settlementBatch?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerPeriods {
  id?: string;
  tenantId?: string;
  code: string;
  startAt: number;
  endAt: number;
  state?: string;
  checklistJson?: string;
  closePackFileId?: string;
  closedBy?: string;
  closedAt?: number;
}

export interface LedgerReconMatches {
  id?: string;
  tenantId?: string;
  runId: string;
  statementLineRef?: string;
  txnId?: string;
  amountMinor: number;
  currency: string;
  deltaMinor?: number;
  method: string;
  confidence?: number;
  state?: string;
  reasonCode?: string;
  confirmedBy?: string;
  confirmedAt?: number;
  createdAt?: number;
}

export interface LedgerReconRuns {
  id?: string;
  tenantId?: string;
  process: string;
  period: string;
  counterpartyRef?: string;
  statementFileId?: string;
  matchedCount?: number;
  varianceCount?: number;
  varianceMinor?: number;
  currency: string;
  state?: string;
  evidenceBundleFileId?: string;
  closedBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerRevenueSchedules {
  id?: string;
  tenantId?: string;
  invoiceId: string;
  accountCode: string;
  period: string;
  plannedMinor: number;
  recognizedMinor?: number;
  currency: string;
  txnId?: string;
  state?: string;
}

export interface LedgerSagaSteps {
  id?: string;
  tenantId?: string;
  txnId: string;
  seq: number;
  name: string;
  state?: string;
  requestHash?: string;
  resultJson?: string;
  compensationRef?: string;
  attempts?: number;
  lastError?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface LedgerSettlements {
  id?: string;
  tenantId?: string;
  counterpartyKind: string;
  counterpartyRef: string;
  period: string;
  grossMinor?: number;
  adjustmentsMinor?: number;
  netMinor?: number;
  currency: string;
  statementFileId?: string;
  state?: string;
  disputeReason?: string;
  externalRef?: string;
  paidVia?: string;
  approvedBy?: string;
  txnId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerSubscriptions {
  id?: string;
  tenantId?: string;
  customerRef: string;
  plan: string;
  edition?: string;
  priceMinor: number;
  currency: string;
  interval?: string;
  seats?: number;
  startAt: number;
  endAt?: number;
  nextInvoiceAt?: number;
  state?: string;
  termsJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LedgerTaxRules {
  id?: string;
  tenantId?: string;
  market: string;
  code: string;
  ratePpm: number;
  placeOfSupply?: string;
  reverseCharge?: boolean;
  exempt?: boolean;
  effectiveFrom: number;
  effectiveTo?: number;
}

export interface LedgerTxnTransitions {
  id?: string;
  tenantId?: string;
  txnId: string;
  fromState?: string;
  toState: string;
  actorRef: string;
  reason?: string;
  ts: number;
}

export interface LedgerTxns {
  id?: string;
  tenantId?: string;
  type: string;
  version?: number;
  idempotencyKey: string;
  correlationId?: string;
  parentTxnId?: string;
  reversalOf?: string;
  state?: string;
  actorKind: string;
  actorId: string;
  autonomyLevel?: string;
  subjectRefsJson?: string;
  currency: string;
  baseCurrency: string;
  fxRatePpm?: number;
  amountsJson?: string;
  grossMinor?: number;
  baseGrossMinor?: number;
  ledgerBatchId?: string;
  eventIdsJson?: string;
  evidenceRefsJson?: string;
  guardrailsJson?: string;
  failureCode?: string;
  failureDetail?: string;
  externalTimeoutAt?: number;
  metadataJson?: string;
  createdAt?: number;
  updatedAt?: number;
  settledAt?: number;
  failedAt?: number;
}

export interface LedgerUsageMeters {
  id?: string;
  tenantId?: string;
  subscriptionId?: string;
  meter: string;
  period: string;
  quantity?: number;
  includedQuantity?: number;
  unitPriceMicro?: number;
  overageInvoicedQuantity?: number;
  overageInvoicedAt?: number;
  updatedAt?: number;
}

export interface NorthAlert_rules {
  id?: string;
  tenantId?: string;
  metricKey: string;
  operator: string;
  thresholdValue: number;
  windowGrain?: string;
  notifyChannelRef?: string;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface NorthAnomalies {
  id?: string;
  tenantId?: string;
  metricKey: string;
  window: string;
  magnitude: number;
  expected?: number;
  actual?: number;
  driverAnalysisJson?: string;
  state?: string;
  linkedActionRef?: string;
  explainedBy?: string;
  detectedAt: number;
}

export interface NorthBoardpacks {
  id?: string;
  tenantId?: string;
  period: string;
  title: string;
  sectionsJson: string;
  pdfFileId?: string;
  xlsxFileId?: string;
  distributionLogJson?: string;
  status?: string;
  approvedBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface NorthBriefings {
  id?: string;
  tenantId?: string;
  date: string;
  audience?: string;
  locale?: string;
  narrativeRef?: string;
  highlightsJson?: string;
  anomaliesJson?: string;
  status?: string;
  generatedBy?: string;
  aiAuditId?: string;
  approvedBy?: string;
  publishedAt?: number;
  createdAt?: number;
}

export interface NorthDecisions {
  id?: string;
  tenantId?: string;
  title: string;
  contextRef?: string;
  optionsJson?: string;
  chosen?: string;
  owner: string;
  reviewAt?: number;
  outcomeReviewJson?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface NorthMetrics {
  id?: string;
  tenantId?: string;
  key: string;
  nameJson: string;
  definitionSqlRef: string;
  unit?: string;
  currency?: string;
  grain?: string;
  owner?: string;
  targetJson?: string;
  sensitivity?: string;
  direction?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface NorthScenarios {
  id?: string;
  tenantId?: string;
  question: string;
  assumptionsJson: string;
  modelRunRef?: string;
  resultJson?: string;
  author: string;
  sharedWithJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface NorthSnapshots {
  id?: string;
  tenantId?: string;
  metricKey: string;
  grain: string;
  period: string;
  dimsJson?: string;
  dimsHash?: string;
  value: number;
  ts: number;
}

export interface OrbitAgentPresence {
  id?: string;
  tenantId?: string;
  userId: string;
  status?: string;
  activeCount?: number;
  updatedAt?: number;
}

export interface OrbitChannelConnectors {
  id?: string;
  tenantId?: string;
  provider: string;
  transport: string;
  label: string;
  secretsJson: string;
  configJson?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitConversations {
  id?: string;
  tenantId?: string;
  customerId?: string;
  channel: string;
  externalRef?: string;
  connectorId?: string;
  doId?: string;
  state?: string;
  assigneeRef?: string;
  teamId?: string;
  csat?: number;
  summary?: string;
  lang?: string;
  intent?: string;
  sentiment?: number;
  firstResponseMs?: number;
  lastMessageAt?: number;
  closedAt?: number;
  priority?: number;
  slaPolicyKey?: string;
  requireSkillsJson?: string;
  queuedAt?: number;
  assignedAt?: number;
  firstResponseDueAt?: number;
  resolutionDueAt?: number;
  frtBreachedAt?: number;
  resolutionBreachedAt?: number;
  reopenCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitHandoverNotes {
  id?: string;
  tenantId?: string;
  conversationId: string;
  fromRef: string;
  toRef?: string;
  summary: string;
  factsJson?: string;
  generatedBy?: string;
  acceptedBy?: string;
  ts: number;
}

export interface OrbitJourneyRuns {
  id?: string;
  tenantId?: string;
  journeyId: string;
  customerId: string;
  node: string;
  state?: string;
  contextJson?: string;
  nextAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitJourneys {
  id?: string;
  tenantId?: string;
  key: string;
  version?: number;
  nameJson: string;
  graphJson: string;
  status?: string;
  createdBy?: string;
  createdAt?: number;
}

export interface OrbitMessages {
  id?: string;
  tenantId?: string;
  conversationId: string;
  role: string;
  modality?: string;
  content: string;
  attachmentsJson?: string;
  redactionsJson?: string;
  aiAuditId?: string;
  deliveryStatus?: string;
  externalRef?: string;
  ts: number;
}

export interface OrbitPartnerTxns {
  id?: string;
  tenantId?: string;
  partnerId: string;
  kind: string;
  payloadHash: string;
  amountMinor?: number;
  currency: string;
  revshareCalcMinor?: number;
  settlementBatch?: string;
  txnRef?: string;
  ts: number;
}

export interface OrbitPartners {
  id?: string;
  tenantId?: string;
  name: string;
  kind: string;
  apiKeyRef?: string;
  revshareJson?: string;
  sandboxFlag?: boolean;
  status?: string;
  contactJson?: string;
  stage?: string;
  ownerRef?: string;
  legalName?: string;
  registrationNo?: string;
  taxId?: string;
  country?: string;
  screeningId?: string;
  riskRating?: string;
  agreementId?: string;
  payoutMethodRef?: string;
  goLiveAt?: number;
  suspendedAt?: number;
  suspendedReason?: string;
  terminatedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitQaScores {
  id?: string;
  tenantId?: string;
  conversationId: string;
  rubricKey: string;
  score: number;
  breakdownJson?: string;
  flagsJson?: string;
  scoredBy?: string;
  disputedBy?: string;
  ts: number;
}

export interface OrbitRenewals {
  id?: string;
  tenantId?: string;
  policyRef: string;
  customerId: string;
  expiryAt: number;
  churnScore?: number;
  strategy?: string;
  requotesJson?: string;
  state?: string;
  outcomeReason?: string;
  ownerRef?: string;
  offeredAt?: number;
  decidedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitRoutingRules {
  id?: string;
  tenantId?: string;
  teamId: string;
  seq: number;
  enabled?: boolean;
  conditionsJson?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitSlaPolicies {
  id?: string;
  tenantId?: string;
  key: string;
  frtMinutes: number;
  resolutionMinutes: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface OrbitTeamMembers {
  id?: string;
  tenantId?: string;
  teamId: string;
  userId: string;
  skillsJson?: string;
  maxConcurrent?: number;
  createdAt?: number;
}

export interface OrbitTeams {
  id?: string;
  tenantId?: string;
  key: string;
  nameJson: string;
  isDefault?: boolean;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
}

export interface ScoutClusters {
  id?: string;
  tenantId?: string;
  theme: string;
  summary?: string;
  momentumScore?: number;
  size?: number;
  firstSeen: number;
  lastSeen: number;
  trailJson?: string;
  updatedAt?: number;
}

export interface ScoutDataProducts {
  id?: string;
  tenantId?: string;
  name: string;
  definitionJson: string;
  consentBasis: string;
  aggregationMin?: number;
  subscribersJson?: string;
  delivery?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ScoutPanelBench {
  id?: string;
  tenantId?: string;
  providerId: string;
  line: string;
  period: string;
  ourPriceIdx?: number;
  marketPriceIdx?: number;
  winRate?: number;
  volume?: number;
  coverageGapsJson?: string;
  updatedAt?: number;
}

export interface ScoutScoutExperiments {
  id?: string;
  tenantId?: string;
  whitespaceId: string;
  landingRef?: string;
  trafficPlanJson?: string;
  resultsJson?: string;
  state?: string;
  startedAt?: number;
  concludedAt?: number;
  createdAt?: number;
}

export interface ScoutSignals {
  id?: string;
  tenantId?: string;
  source: string;
  sourceRef?: string;
  payloadJson: string;
  embeddingRef?: string;
  clusterId?: string;
  weight?: number;
  observedAt: number;
  createdAt?: number;
}

export interface ScoutWhitespaces {
  id?: string;
  tenantId?: string;
  description: string;
  category?: string;
  clusterId?: string;
  evidenceRefsJson?: string;
  demandEstimate?: number;
  competitionScore?: number;
  status?: string;
  owner?: string;
  promotedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SignalAeoPages {
  id?: string;
  tenantId?: string;
  queryCluster: string;
  locale?: string;
  contentRef: string;
  citationsCheckJson?: string;
  freshness?: number;
  citedByJson?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SignalAttributionEvents {
  id?: string;
  tenantId?: string;
  customerId?: string;
  anonId?: string;
  touchType: string;
  channel: string;
  campaignId?: string;
  creativeId?: string;
  valueMinor?: number;
  currency?: string;
  subjectRef?: string;
  ts: number;
}

export interface SignalAudiences {
  id?: string;
  tenantId?: string;
  name: string;
  definitionJson: string;
  sizeCached?: number;
  refreshPolicy?: string;
  lastRefreshedAt?: number;
  consentPurposes?: string;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SignalBudgetMoves {
  id?: string;
  tenantId?: string;
  fromRef: string;
  toRef: string;
  amountMinor: number;
  currency: string;
  reason: string;
  evidenceJson?: string;
  approvedBy: string;
  reversedBy?: string;
  reversedAt?: number;
  reversibleUntil: number;
  ts: number;
}

export interface SignalCampaigns {
  id?: string;
  tenantId?: string;
  name: string;
  objective: string;
  audienceId?: string;
  channelsJson: string;
  budgetJson: string;
  state?: string;
  guardrailChecksJson?: string;
  planJson?: string;
  autonomyLevel?: string;
  startAt?: number;
  endAt?: number;
  ownerRef: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface SignalCreatives {
  id?: string;
  tenantId?: string;
  campaignId?: string;
  kind: string;
  locale?: string;
  contentRef: string;
  variantGroup?: string;
  complianceStatus?: string;
  complianceNotesJson?: string;
  performanceJson?: string;
  generatedBy?: string;
  aiAuditId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SignalOutreach {
  id?: string;
  tenantId?: string;
  campaignId: string;
  customerId: string;
  channel: string;
  locale?: string;
  text: string;
  state?: string;
  approvedBy: string;
  externalRef?: string;
  convertedRef?: string;
  aiAuditId?: string;
  ts: number;
  updatedAt?: number;
}

export interface SignalSignalExperiments {
  id?: string;
  tenantId?: string;
  campaignId?: string;
  hypothesis: string;
  variantsJson: string;
  metric: string;
  minSample?: number;
  state?: string;
  resultJson?: string;
  concludedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SignalSpend {
  id?: string;
  tenantId?: string;
  campaignId?: string;
  channel: string;
  day: string;
  amountMinor: number;
  currency: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  source?: string;
  ts: number;
}

/* --------------------------------------------------------------- operations */

export interface Operations {
  "GET /v1/ai/agents": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiAgents>>;
  "POST /v1/ai/agents": Op<never, never, AiAgents, AiAgents>;
  "GET /v1/ai/agents/{id}": Op<{ id: string }, never, never, AiAgents>;
  "PATCH /v1/ai/agents/{id}": Op<{ id: string }, never, AiAgents, AiAgents>;
  "DELETE /v1/ai/agents/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/ai/agents/{key}/autonomy": Op<{ key: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ai/agents/{key}/pause": Op<{ key: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ai/agents/{key}/resume": Op<{ key: string }, never, never, Record<string, unknown>>;
  "GET /v1/ai/ai-audit-log": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiAiAuditLog>>;
  "GET /v1/ai/ai-audit-log/{id}": Op<{ id: string }, never, never, AiAiAuditLog>;
  "GET /v1/ai/audit": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ai/audit/spend": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ai/budget": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/ai/budget/limits": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/budgets": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiBudgets>>;
  "POST /v1/ai/budgets": Op<never, never, AiBudgets, AiBudgets>;
  "GET /v1/ai/budgets/{id}": Op<{ id: string }, never, never, AiBudgets>;
  "PATCH /v1/ai/budgets/{id}": Op<{ id: string }, never, AiBudgets, AiBudgets>;
  "DELETE /v1/ai/budgets/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/ai/command/proposals": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/ai/command/proposals/{id}/action": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ai/command/proposals/{id}/dismiss": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ai/command/runs": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/evals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiEvals>>;
  "POST /v1/ai/evals": Op<never, never, AiEvals, AiEvals>;
  "GET /v1/ai/evals/{id}": Op<{ id: string }, never, never, AiEvals>;
  "GET /v1/ai/guardrail-events": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiGuardrailEvents>>;
  "GET /v1/ai/guardrail-events/{id}": Op<{ id: string }, never, never, AiGuardrailEvents>;
  "GET /v1/ai/kill-switches": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ai/knowledge-sources": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiKnowledgeSources>>;
  "POST /v1/ai/knowledge-sources": Op<never, never, AiKnowledgeSources, AiKnowledgeSources>;
  "GET /v1/ai/knowledge-sources/{id}": Op<{ id: string }, never, never, AiKnowledgeSources>;
  "PATCH /v1/ai/knowledge-sources/{id}": Op<{ id: string }, never, AiKnowledgeSources, AiKnowledgeSources>;
  "DELETE /v1/ai/knowledge-sources/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/ai/pause": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/prompts": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiPrompts>>;
  "POST /v1/ai/prompts": Op<never, never, AiPrompts, AiPrompts>;
  "GET /v1/ai/prompts/{id}": Op<{ id: string }, never, never, AiPrompts>;
  "PATCH /v1/ai/prompts/{id}": Op<{ id: string }, never, AiPrompts, AiPrompts>;
  "DELETE /v1/ai/prompts/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/ai/resume": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/runs": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiRuns>>;
  "POST /v1/ai/runs": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/runs/{id}": Op<{ id: string }, never, never, AiRuns>;
  "GET /v1/ai/runs/{id}/detail": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/ai/suggestions": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiSuggestions>>;
  "POST /v1/ai/suggestions": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/suggestions/acceptance": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ai/suggestions/{id}": Op<{ id: string }, never, never, AiSuggestions>;
  "PATCH /v1/ai/suggestions/{id}": Op<{ id: string }, never, AiSuggestions, AiSuggestions>;
  "POST /v1/ai/suggestions/{id}/outcome": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ai/tool-calls": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AiToolCalls>>;
  "GET /v1/ai/tool-calls/{id}": Op<{ id: string }, never, never, AiToolCalls>;
  "GET /v1/analytics/dashboards": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/analytics/dashboards": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/dashboards/{id}": Op<{ id: string }, never, never, AnalyticsDashboards>;
  "PATCH /v1/analytics/dashboards/{id}": Op<{ id: string }, never, AnalyticsDashboards, AnalyticsDashboards>;
  "DELETE /v1/analytics/dashboards/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/analytics/dashboards/{id}/data": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/datasets": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/analytics/exports": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/analytics/exports": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/exports/{id}": Op<{ id: string }, never, never, AnalyticsExports>;
  "GET /v1/analytics/exports/{id}/download": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/feed/{dataset}": Op<{ dataset: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/journey-events": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AnalyticsJourneyEvents>>;
  "GET /v1/analytics/journey-events/{id}": Op<{ id: string }, never, never, AnalyticsJourneyEvents>;
  "GET /v1/analytics/report-runs": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AnalyticsReportRuns>>;
  "POST /v1/analytics/report-runs": Op<never, never, AnalyticsReportRuns, AnalyticsReportRuns>;
  "GET /v1/analytics/report-runs/{id}": Op<{ id: string }, never, never, AnalyticsReportRuns>;
  "GET /v1/analytics/reports": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/analytics/reports": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/reports/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "PATCH /v1/analytics/reports/{id}": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "DELETE /v1/analytics/reports/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/analytics/reports/{id}/restore": Op<{ id: string }, never, never, AnalyticsReports>;
  "POST /v1/analytics/reports/{id}/run": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/analytics/run": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/runs/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/saved-views": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/analytics/saved-views": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/saved-views/{id}": Op<{ id: string }, never, never, AnalyticsSavedViews>;
  "PATCH /v1/analytics/saved-views/{id}": Op<{ id: string }, never, AnalyticsSavedViews, AnalyticsSavedViews>;
  "DELETE /v1/analytics/saved-views/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/schedules": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/analytics/schedules": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/analytics/schedules/{id}": Op<{ id: string }, never, never, AnalyticsSchedules>;
  "PATCH /v1/analytics/schedules/{id}": Op<{ id: string }, never, AnalyticsSchedules, AnalyticsSchedules>;
  "DELETE /v1/analytics/schedules/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/analytics/schedules/{id}/pause": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/analytics/schedules/{id}/resume": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/analytics/unit-economics": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/analytics/unit-economics/{id}": Op<{ id: string }, never, never, AnalyticsUnitEconomics>;
  "GET /v1/analytics/usage": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/demo/clock": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/auth/demo/login": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/auth/demo/personas": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/demo/resync-roles": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/demo/seed": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/login": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/auth/logout": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/mfa/disable": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/auth/mfa/enrol": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/auth/mfa/enrol/confirm": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/auth/mfa/verify": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/auth/sso/discover": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/auth/sso/{id}/callback": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/auth/sso/{id}/start": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/bordereau-lines": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisBordereauLines>>;
  "GET /v1/axis/bordereau-lines/{id}": Op<{ id: string }, never, never, AxisBordereauLines>;
  "GET /v1/axis/bordereaux": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisBordereaux>>;
  "POST /v1/axis/bordereaux": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/bordereaux/{id}": Op<{ id: string }, never, never, AxisBordereaux>;
  "POST /v1/axis/bordereaux/{id}/reconcile": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/case-approvals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisCaseApprovals>>;
  "GET /v1/axis/case-approvals/{id}": Op<{ id: string }, never, never, AxisCaseApprovals>;
  "GET /v1/axis/cases": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisCases>>;
  "POST /v1/axis/cases": Op<never, never, AxisCases, AxisCases>;
  "POST /v1/axis/cases/bulk": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/cases/import": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/cases/{id}": Op<{ id: string }, never, never, AxisCases>;
  "PATCH /v1/axis/cases/{id}": Op<{ id: string }, never, AxisCases, AxisCases>;
  "DELETE /v1/axis/cases/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/axis/cases/{id}/copilot": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/cases/{id}/quotes": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/cases/{id}/restore": Op<{ id: string }, never, never, AxisCases>;
  "POST /v1/axis/cases/{id}/sla-predict": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/cases/{id}/transition": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/claims": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisClaims>>;
  "POST /v1/axis/claims": Op<never, never, AxisClaims, AxisClaims>;
  "POST /v1/axis/claims/coverage-check": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/claims/{id}": Op<{ id: string }, never, never, AxisClaims>;
  "PATCH /v1/axis/claims/{id}": Op<{ id: string }, never, AxisClaims, AxisClaims>;
  "POST /v1/axis/claims/{id}/fraud-score": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/claims/{id}/payments": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/claims/{id}/payments": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/claims/{id}/recoveries": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/claims/{id}/recoveries": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/claims/{id}/reserve-recommendation": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/claims/{id}/reserves": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/claims/{id}/reserves": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/claims/{id}/transition": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/complaints": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisComplaints>>;
  "POST /v1/axis/complaints": Op<never, never, AxisComplaints, AxisComplaints>;
  "GET /v1/axis/complaints/{id}": Op<{ id: string }, never, never, AxisComplaints>;
  "PATCH /v1/axis/complaints/{id}": Op<{ id: string }, never, AxisComplaints, AxisComplaints>;
  "POST /v1/axis/dev/extract-sample": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/documents": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisDocuments>>;
  "POST /v1/axis/documents": Op<never, never, AxisDocuments, AxisDocuments>;
  "POST /v1/axis/documents/upload": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/documents/{id}": Op<{ id: string }, never, never, AxisDocuments>;
  "PATCH /v1/axis/documents/{id}": Op<{ id: string }, never, AxisDocuments, AxisDocuments>;
  "POST /v1/axis/documents/{id}/extract": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/documents/{id}/file": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/documents/{id}/reveal": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/documents/{id}/verify": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/escrow-batches": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisEscrowBatches>>;
  "GET /v1/axis/escrow-batches/{id}": Op<{ id: string }, never, never, AxisEscrowBatches>;
  "PATCH /v1/axis/escrow-batches/{id}": Op<{ id: string }, never, AxisEscrowBatches, AxisEscrowBatches>;
  "GET /v1/axis/ops-policies": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisOpsPolicies>>;
  "POST /v1/axis/ops-policies": Op<never, never, AxisOpsPolicies, AxisOpsPolicies>;
  "GET /v1/axis/ops-policies/{id}": Op<{ id: string }, never, never, AxisOpsPolicies>;
  "PATCH /v1/axis/ops-policies/{id}": Op<{ id: string }, never, AxisOpsPolicies, AxisOpsPolicies>;
  "DELETE /v1/axis/ops-policies/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/axis/policies": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisPolicies>>;
  "POST /v1/axis/policies": Op<never, never, AxisPolicies, AxisPolicies>;
  "GET /v1/axis/policies/{id}": Op<{ id: string }, never, never, AxisPolicies>;
  "PATCH /v1/axis/policies/{id}": Op<{ id: string }, never, AxisPolicies, AxisPolicies>;
  "POST /v1/axis/policies/{id}/bind": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/bind-group": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/broker-fee": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/cancel": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/cancel/preview": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/documents": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/endorse": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/endorse/preview": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/lapse": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/ntu": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/premium-financing-plan": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/premium-financing-plan/cancel": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/reinstate": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/renew": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/reprice": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/axis/policies/{id}/telemetry": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/policies/{id}/versions": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/process-events": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisProcessEvents>>;
  "GET /v1/axis/process-events/{id}": Op<{ id: string }, never, never, AxisProcessEvents>;
  "POST /v1/axis/quote-responses/{id}/bind": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/quote-responses/{id}/decline": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/quotes": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisQuotes>>;
  "GET /v1/axis/quotes/{id}": Op<{ id: string }, never, never, AxisQuotes>;
  "POST /v1/axis/recoveries/{id}/receipt": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/axis/recoveries/{id}/writeoff": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/referrals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisReferrals>>;
  "GET /v1/axis/referrals/{id}": Op<{ id: string }, never, never, AxisReferrals>;
  "POST /v1/axis/referrals/{id}/decide": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/axis/siu-referrals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisSiuReferrals>>;
  "POST /v1/axis/siu-referrals": Op<never, never, AxisSiuReferrals, AxisSiuReferrals>;
  "GET /v1/axis/siu-referrals/{id}": Op<{ id: string }, never, never, AxisSiuReferrals>;
  "PATCH /v1/axis/siu-referrals/{id}": Op<{ id: string }, never, AxisSiuReferrals, AxisSiuReferrals>;
  "GET /v1/axis/sops": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisSops>>;
  "POST /v1/axis/sops": Op<never, never, AxisSops, AxisSops>;
  "GET /v1/axis/sops/{id}": Op<{ id: string }, never, never, AxisSops>;
  "PATCH /v1/axis/sops/{id}": Op<{ id: string }, never, AxisSops, AxisSops>;
  "DELETE /v1/axis/sops/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/axis/sops/{id}/publish": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/axis/tasks": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisTasks>>;
  "POST /v1/axis/tasks": Op<never, never, AxisTasks, AxisTasks>;
  "GET /v1/axis/tasks/{id}": Op<{ id: string }, never, never, AxisTasks>;
  "PATCH /v1/axis/tasks/{id}": Op<{ id: string }, never, AxisTasks, AxisTasks>;
  "DELETE /v1/axis/tasks/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/axis/telemetry-points": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<AxisTelemetryPoints>>;
  "GET /v1/axis/telemetry-points/{id}": Op<{ id: string }, never, never, AxisTelemetryPoints>;
  "GET /v1/channels/{connectorId}/webhook": Op<{ connectorId: string }, never, never, Record<string, unknown>>;
  "POST /v1/channels/{connectorId}/webhook": Op<{ connectorId: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/compliance/disclosures": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceDisclosures>>;
  "POST /v1/compliance/disclosures/present": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/compliance/disclosures/{id}": Op<{ id: string }, never, never, ComplianceDisclosures>;
  "GET /v1/compliance/dsar-requests": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceDsarRequests>>;
  "POST /v1/compliance/dsar-requests": Op<never, never, ComplianceDsarRequests, ComplianceDsarRequests>;
  "GET /v1/compliance/dsar-requests/{id}": Op<{ id: string }, never, never, ComplianceDsarRequests>;
  "PATCH /v1/compliance/dsar-requests/{id}": Op<{ id: string }, never, ComplianceDsarRequests, ComplianceDsarRequests>;
  "GET /v1/compliance/erasure-log": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceErasureLog>>;
  "GET /v1/compliance/erasure-log/{id}": Op<{ id: string }, never, never, ComplianceErasureLog>;
  "GET /v1/compliance/evidence-bundles": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceEvidenceBundles>>;
  "POST /v1/compliance/evidence-bundles/export": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/compliance/evidence-bundles/{id}": Op<{ id: string }, never, never, ComplianceEvidenceBundles>;
  "GET /v1/compliance/evidence-bundles/{id}/download": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/compliance/incidents": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceIncidents>>;
  "POST /v1/compliance/incidents": Op<never, never, ComplianceIncidents, ComplianceIncidents>;
  "GET /v1/compliance/incidents/{id}": Op<{ id: string }, never, never, ComplianceIncidents>;
  "PATCH /v1/compliance/incidents/{id}": Op<{ id: string }, never, ComplianceIncidents, ComplianceIncidents>;
  "DELETE /v1/compliance/incidents/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/compliance/legal-holds": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceLegalHolds>>;
  "POST /v1/compliance/legal-holds": Op<never, never, ComplianceLegalHolds, ComplianceLegalHolds>;
  "GET /v1/compliance/legal-holds/{id}": Op<{ id: string }, never, never, ComplianceLegalHolds>;
  "PATCH /v1/compliance/legal-holds/{id}": Op<{ id: string }, never, ComplianceLegalHolds, ComplianceLegalHolds>;
  "DELETE /v1/compliance/legal-holds/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/compliance/policy-thresholds": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CompliancePolicyThresholds>>;
  "POST /v1/compliance/policy-thresholds": Op<never, never, CompliancePolicyThresholds, CompliancePolicyThresholds>;
  "GET /v1/compliance/policy-thresholds/{id}": Op<{ id: string }, never, never, CompliancePolicyThresholds>;
  "PATCH /v1/compliance/policy-thresholds/{id}": Op<{ id: string }, never, CompliancePolicyThresholds, CompliancePolicyThresholds>;
  "DELETE /v1/compliance/policy-thresholds/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/compliance/retention-runs": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceRetentionRuns>>;
  "GET /v1/compliance/retention-runs/{id}": Op<{ id: string }, never, never, ComplianceRetentionRuns>;
  "POST /v1/compliance/retention/run": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/compliance/rulepack-applications": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceRulepackApplications>>;
  "POST /v1/compliance/rulepack-applications": Op<never, never, ComplianceRulepackApplications, ComplianceRulepackApplications>;
  "GET /v1/compliance/rulepack-applications/{id}": Op<{ id: string }, never, never, ComplianceRulepackApplications>;
  "GET /v1/compliance/screenings": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ComplianceScreenings>>;
  "POST /v1/compliance/screenings/run": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/compliance/screenings/{id}": Op<{ id: string }, never, never, ComplianceScreenings>;
  "GET /v1/core/api-keys": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreApiKeys>>;
  "POST /v1/core/api-keys": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/core/api-keys/{id}": Op<{ id: string }, never, never, CoreApiKeys>;
  "DELETE /v1/core/api-keys/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/core/approvals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreApprovals>>;
  "GET /v1/core/approvals/{id}": Op<{ id: string }, never, never, CoreApprovals>;
  "GET /v1/core/audit-log": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreAuditLog>>;
  "GET /v1/core/audit-log/{id}": Op<{ id: string }, never, never, CoreAuditLog>;
  "GET /v1/core/consents": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreConsents>>;
  "POST /v1/core/consents": Op<never, never, CoreConsents, CoreConsents>;
  "GET /v1/core/consents/{id}": Op<{ id: string }, never, never, CoreConsents>;
  "GET /v1/core/customers": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreCustomers>>;
  "POST /v1/core/customers": Op<never, never, CoreCustomers, CoreCustomers>;
  "GET /v1/core/customers/{id}": Op<{ id: string }, never, never, CoreCustomers>;
  "PATCH /v1/core/customers/{id}": Op<{ id: string }, never, CoreCustomers, CoreCustomers>;
  "DELETE /v1/core/customers/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/customers/{id}/position": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/core/customers/{id}/restore": Op<{ id: string }, never, never, CoreCustomers>;
  "GET /v1/core/delegations": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreDelegations>>;
  "GET /v1/core/delegations/{id}": Op<{ id: string }, never, never, CoreDelegations>;
  "GET /v1/core/event-dlq": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreEventDlq>>;
  "GET /v1/core/event-dlq/{id}": Op<{ id: string }, never, never, CoreEventDlq>;
  "GET /v1/core/files": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreFiles>>;
  "POST /v1/core/files": Op<never, never, CoreFiles, CoreFiles>;
  "GET /v1/core/files/{id}": Op<{ id: string }, never, never, CoreFiles>;
  "DELETE /v1/core/files/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/core/files/{id}/restore": Op<{ id: string }, never, never, CoreFiles>;
  "GET /v1/core/identity-providers": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreIdentityProviders>>;
  "POST /v1/core/identity-providers": Op<never, never, CoreIdentityProviders, CoreIdentityProviders>;
  "GET /v1/core/identity-providers/{id}": Op<{ id: string }, never, never, CoreIdentityProviders>;
  "PATCH /v1/core/identity-providers/{id}": Op<{ id: string }, never, CoreIdentityProviders, CoreIdentityProviders>;
  "DELETE /v1/core/identity-providers/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/identity-verifications": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreIdentityVerifications>>;
  "GET /v1/core/identity-verifications/{id}": Op<{ id: string }, never, never, CoreIdentityVerifications>;
  "GET /v1/core/lenses": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreLenses>>;
  "POST /v1/core/lenses": Op<never, never, CoreLenses, CoreLenses>;
  "GET /v1/core/lenses/{id}": Op<{ id: string }, never, never, CoreLenses>;
  "PATCH /v1/core/lenses/{id}": Op<{ id: string }, never, CoreLenses, CoreLenses>;
  "DELETE /v1/core/lenses/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/locale-overrides": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreLocaleOverrides>>;
  "POST /v1/core/locale-overrides": Op<never, never, CoreLocaleOverrides, CoreLocaleOverrides>;
  "GET /v1/core/locale-overrides/{id}": Op<{ id: string }, never, never, CoreLocaleOverrides>;
  "PATCH /v1/core/locale-overrides/{id}": Op<{ id: string }, never, CoreLocaleOverrides, CoreLocaleOverrides>;
  "DELETE /v1/core/locale-overrides/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/mandates": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreMandates>>;
  "POST /v1/core/mandates": Op<never, never, CoreMandates, CoreMandates>;
  "GET /v1/core/mandates/{id}": Op<{ id: string }, never, never, CoreMandates>;
  "PATCH /v1/core/mandates/{id}": Op<{ id: string }, never, CoreMandates, CoreMandates>;
  "DELETE /v1/core/mandates/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/memories": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreMemories>>;
  "POST /v1/core/memories": Op<never, never, CoreMemories, CoreMemories>;
  "GET /v1/core/memories/{id}": Op<{ id: string }, never, never, CoreMemories>;
  "PATCH /v1/core/memories/{id}": Op<{ id: string }, never, CoreMemories, CoreMemories>;
  "DELETE /v1/core/memories/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/message-templates": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreMessageTemplates>>;
  "POST /v1/core/message-templates": Op<never, never, CoreMessageTemplates, CoreMessageTemplates>;
  "GET /v1/core/message-templates/{id}": Op<{ id: string }, never, never, CoreMessageTemplates>;
  "PATCH /v1/core/message-templates/{id}": Op<{ id: string }, never, CoreMessageTemplates, CoreMessageTemplates>;
  "DELETE /v1/core/message-templates/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/core/message-templates/{id}/restore": Op<{ id: string }, never, never, CoreMessageTemplates>;
  "GET /v1/core/modules/config": Op<never, never, never, Record<string, unknown>>;
  "PATCH /v1/core/modules/{module}/config": Op<{ module: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/core/notifications": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreNotifications>>;
  "GET /v1/core/notifications/{id}": Op<{ id: string }, never, never, CoreNotifications>;
  "GET /v1/core/onboarding-steps": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreOnboardingSteps>>;
  "GET /v1/core/onboarding-steps/{id}": Op<{ id: string }, never, never, CoreOnboardingSteps>;
  "GET /v1/core/products": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreProducts>>;
  "POST /v1/core/products": Op<never, never, CoreProducts, CoreProducts>;
  "GET /v1/core/products/{id}": Op<{ id: string }, never, never, CoreProducts>;
  "PATCH /v1/core/products/{id}": Op<{ id: string }, never, CoreProducts, CoreProducts>;
  "DELETE /v1/core/products/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/providers": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreProviders>>;
  "POST /v1/core/providers": Op<never, never, CoreProviders, CoreProviders>;
  "GET /v1/core/providers/{id}": Op<{ id: string }, never, never, CoreProviders>;
  "PATCH /v1/core/providers/{id}": Op<{ id: string }, never, CoreProviders, CoreProviders>;
  "DELETE /v1/core/providers/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/roles": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreRoles>>;
  "POST /v1/core/roles": Op<never, never, CoreRoles, CoreRoles>;
  "GET /v1/core/roles/{id}": Op<{ id: string }, never, never, CoreRoles>;
  "PATCH /v1/core/roles/{id}": Op<{ id: string }, never, CoreRoles, CoreRoles>;
  "DELETE /v1/core/roles/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/rulepacks": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreRulepacks>>;
  "POST /v1/core/rulepacks": Op<never, never, CoreRulepacks, CoreRulepacks>;
  "GET /v1/core/rulepacks/{id}": Op<{ id: string }, never, never, CoreRulepacks>;
  "PATCH /v1/core/rulepacks/{id}": Op<{ id: string }, never, CoreRulepacks, CoreRulepacks>;
  "GET /v1/core/security-posture": Op<never, never, never, Record<string, unknown>>;
  "PATCH /v1/core/settings/auto-approve": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/core/teams": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreTeams>>;
  "POST /v1/core/teams": Op<never, never, CoreTeams, CoreTeams>;
  "GET /v1/core/teams/{id}": Op<{ id: string }, never, never, CoreTeams>;
  "PATCH /v1/core/teams/{id}": Op<{ id: string }, never, CoreTeams, CoreTeams>;
  "DELETE /v1/core/teams/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/tenants": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreTenants>>;
  "GET /v1/core/tenants/{id}": Op<{ id: string }, never, never, CoreTenants>;
  "PATCH /v1/core/tenants/{id}": Op<{ id: string }, never, CoreTenants, CoreTenants>;
  "GET /v1/core/user-roles": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreUserRoles>>;
  "POST /v1/core/user-roles": Op<never, never, CoreUserRoles, CoreUserRoles>;
  "GET /v1/core/user-roles/{id}": Op<{ id: string }, never, never, CoreUserRoles>;
  "DELETE /v1/core/user-roles/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/core/users": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreUsers>>;
  "POST /v1/core/users": Op<never, never, CoreUsers, CoreUsers>;
  "GET /v1/core/users/{id}": Op<{ id: string }, never, never, CoreUsers>;
  "PATCH /v1/core/users/{id}": Op<{ id: string }, never, CoreUsers, CoreUsers>;
  "DELETE /v1/core/users/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/core/users/{id}/restore": Op<{ id: string }, never, never, CoreUsers>;
  "GET /v1/core/webhook-deliveries": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreWebhookDeliveries>>;
  "GET /v1/core/webhook-deliveries/{id}": Op<{ id: string }, never, never, CoreWebhookDeliveries>;
  "GET /v1/core/webhooks": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<CoreWebhooks>>;
  "POST /v1/core/webhooks": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/core/webhooks/{id}": Op<{ id: string }, never, never, CoreWebhooks>;
  "PATCH /v1/core/webhooks/{id}": Op<{ id: string }, never, CoreWebhooks, CoreWebhooks>;
  "DELETE /v1/core/webhooks/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/core/webhooks/{id}/rotate": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/core/webhooks/{id}/test": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/directory": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/dist/channels": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistChannels>>;
  "POST /v1/dist/channels": Op<never, never, DistChannels, DistChannels>;
  "GET /v1/dist/channels/{id}": Op<{ id: string }, never, never, DistChannels>;
  "PATCH /v1/dist/channels/{id}": Op<{ id: string }, never, DistChannels, DistChannels>;
  "DELETE /v1/dist/channels/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/dist/channels/{id}/restore": Op<{ id: string }, never, never, DistChannels>;
  "GET /v1/dist/commission-entries": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistCommissionEntries>>;
  "POST /v1/dist/commission-entries/accrue": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/commission-entries/statement": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/dist/commission-entries/{id}": Op<{ id: string }, never, never, DistCommissionEntries>;
  "POST /v1/dist/commission-entries/{id}/clawback": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/commission-rates": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistCommissionRates>>;
  "POST /v1/dist/commission-rates": Op<never, never, DistCommissionRates, DistCommissionRates>;
  "GET /v1/dist/commission-rates/{id}": Op<{ id: string }, never, never, DistCommissionRates>;
  "GET /v1/dist/next-best-offers": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistNextBestOffers>>;
  "POST /v1/dist/next-best-offers/propose": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/next-best-offers/{id}": Op<{ id: string }, never, never, DistNextBestOffers>;
  "PATCH /v1/dist/next-best-offers/{id}": Op<{ id: string }, never, DistNextBestOffers, DistNextBestOffers>;
  "POST /v1/dist/next-best-offers/{id}/decide": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/dist/next-best-offers/{id}/surface": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/offerings": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistOfferings>>;
  "POST /v1/dist/offerings": Op<never, never, DistOfferings, DistOfferings>;
  "GET /v1/dist/offerings/{id}": Op<{ id: string }, never, never, DistOfferings>;
  "PATCH /v1/dist/offerings/{id}": Op<{ id: string }, never, DistOfferings, DistOfferings>;
  "DELETE /v1/dist/offerings/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/dist/offerings/{id}/restore": Op<{ id: string }, never, never, DistOfferings>;
  "GET /v1/dist/partner-agreements": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistPartnerAgreements>>;
  "GET /v1/dist/partner-agreements/{id}": Op<{ id: string }, never, never, DistPartnerAgreements>;
  "GET /v1/dist/quote-requests": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistQuoteRequests>>;
  "POST /v1/dist/quote-requests": Op<never, never, DistQuoteRequests, DistQuoteRequests>;
  "POST /v1/dist/quote-requests/shop": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/quote-requests/{id}": Op<{ id: string }, never, never, DistQuoteRequests>;
  "PATCH /v1/dist/quote-requests/{id}": Op<{ id: string }, never, DistQuoteRequests, DistQuoteRequests>;
  "GET /v1/dist/quote-requests/{id}/comparison": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/dist/quote-requests/{id}/select": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/dist/quote-requests/{id}/share": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/dist/quote-responses": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<DistQuoteResponses>>;
  "GET /v1/dist/quote-responses/{id}": Op<{ id: string }, never, never, DistQuoteResponses>;
  "POST /v1/dist/referrals/qualify": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/dist/referrals/settle": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ledger/account-balances": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerAccountBalances>>;
  "GET /v1/ledger/account-balances/{id}": Op<{ id: string }, never, never, LedgerAccountBalances>;
  "GET /v1/ledger/accounts": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerAccounts>>;
  "POST /v1/ledger/accounts": Op<never, never, LedgerAccounts, LedgerAccounts>;
  "GET /v1/ledger/accounts/{code}/balance": Op<{ code: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/accounts/{code}/statement": Op<{ code: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/accounts/{id}": Op<{ id: string }, never, never, LedgerAccounts>;
  "PATCH /v1/ledger/accounts/{id}": Op<{ id: string }, never, LedgerAccounts, LedgerAccounts>;
  "DELETE /v1/ledger/accounts/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/ledger/balances/rebuild": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ledger/client-money-checks": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerClientMoneyChecks>>;
  "GET /v1/ledger/client-money-checks/{id}": Op<{ id: string }, never, never, LedgerClientMoneyChecks>;
  "GET /v1/ledger/fx-rates": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerFxRates>>;
  "POST /v1/ledger/fx-rates": Op<never, never, LedgerFxRates, LedgerFxRates>;
  "GET /v1/ledger/fx-rates/{id}": Op<{ id: string }, never, never, LedgerFxRates>;
  "GET /v1/ledger/invoices": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerInvoices>>;
  "POST /v1/ledger/invoices": Op<never, never, LedgerInvoices, LedgerInvoices>;
  "GET /v1/ledger/invoices/{id}": Op<{ id: string }, never, never, LedgerInvoices>;
  "PATCH /v1/ledger/invoices/{id}": Op<{ id: string }, never, LedgerInvoices, LedgerInvoices>;
  "GET /v1/ledger/journal-batches": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerJournalBatches>>;
  "GET /v1/ledger/journal-batches/{id}": Op<{ id: string }, never, never, LedgerJournalBatches>;
  "GET /v1/ledger/journal-lines": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerJournalLines>>;
  "GET /v1/ledger/journal-lines/{id}": Op<{ id: string }, never, never, LedgerJournalLines>;
  "GET /v1/ledger/payment-plans": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerPaymentPlans>>;
  "GET /v1/ledger/payment-plans/{id}": Op<{ id: string }, never, never, LedgerPaymentPlans>;
  "GET /v1/ledger/payments": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerPayments>>;
  "GET /v1/ledger/payments/{id}": Op<{ id: string }, never, never, LedgerPayments>;
  "GET /v1/ledger/period/{code}": Op<{ code: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/periods": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerPeriods>>;
  "POST /v1/ledger/periods/{code}/close": Op<{ code: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ledger/periods/{code}/reopen": Op<{ code: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/periods/{id}": Op<{ id: string }, never, never, LedgerPeriods>;
  "GET /v1/ledger/recon-matches": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerReconMatches>>;
  "GET /v1/ledger/recon-matches/{id}": Op<{ id: string }, never, never, LedgerReconMatches>;
  "PATCH /v1/ledger/recon-matches/{id}": Op<{ id: string }, never, LedgerReconMatches, LedgerReconMatches>;
  "GET /v1/ledger/recon-runs": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerReconRuns>>;
  "POST /v1/ledger/recon-runs": Op<never, never, LedgerReconRuns, LedgerReconRuns>;
  "GET /v1/ledger/recon-runs/{id}": Op<{ id: string }, never, never, LedgerReconRuns>;
  "POST /v1/ledger/recon/matches/{id}/decide": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ledger/recon/runs": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ledger/recon/runs/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/ledger/recon/runs/{id}/evidence-bundle": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/recon/runs/{id}/evidence-bundle/download": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/aged": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/balance-sheet": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/chart-of-accounts": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/client-money": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/commission": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/pnl": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/trial-balance": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/value-flow": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/value-flow/lines": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/reports/{report}/export": Op<{ report: string }, never, never, Record<string, unknown>>;
  "GET /v1/ledger/revenue-schedules": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerRevenueSchedules>>;
  "GET /v1/ledger/revenue-schedules/{id}": Op<{ id: string }, never, never, LedgerRevenueSchedules>;
  "GET /v1/ledger/saga-steps": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerSagaSteps>>;
  "GET /v1/ledger/saga-steps/{id}": Op<{ id: string }, never, never, LedgerSagaSteps>;
  "GET /v1/ledger/settlements": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerSettlements>>;
  "GET /v1/ledger/settlements/{id}": Op<{ id: string }, never, never, LedgerSettlements>;
  "GET /v1/ledger/subscriptions": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerSubscriptions>>;
  "POST /v1/ledger/subscriptions": Op<never, never, LedgerSubscriptions, LedgerSubscriptions>;
  "GET /v1/ledger/subscriptions/{id}": Op<{ id: string }, never, never, LedgerSubscriptions>;
  "PATCH /v1/ledger/subscriptions/{id}": Op<{ id: string }, never, LedgerSubscriptions, LedgerSubscriptions>;
  "DELETE /v1/ledger/subscriptions/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/ledger/tax-rules": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerTaxRules>>;
  "POST /v1/ledger/tax-rules": Op<never, never, LedgerTaxRules, LedgerTaxRules>;
  "GET /v1/ledger/tax-rules/{id}": Op<{ id: string }, never, never, LedgerTaxRules>;
  "PATCH /v1/ledger/tax-rules/{id}": Op<{ id: string }, never, LedgerTaxRules, LedgerTaxRules>;
  "DELETE /v1/ledger/tax-rules/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/ledger/txn-transitions": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerTxnTransitions>>;
  "GET /v1/ledger/txn-transitions/{id}": Op<{ id: string }, never, never, LedgerTxnTransitions>;
  "GET /v1/ledger/txn-types": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/ledger/txn/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/ledger/txn/{id}/reverse": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ledger/txn/{id}/transition": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/ledger/txn/{type}": Op<{ type: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/ledger/txns": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerTxns>>;
  "GET /v1/ledger/txns/{id}": Op<{ id: string }, never, never, LedgerTxns>;
  "GET /v1/ledger/usage-meters": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<LedgerUsageMeters>>;
  "GET /v1/ledger/usage-meters/{id}": Op<{ id: string }, never, never, LedgerUsageMeters>;
  "GET /v1/ledger/year-end/{year}": Op<{ year: string }, never, never, Record<string, unknown>>;
  "POST /v1/ledger/year-end/{year}": Op<{ year: string }, never, never, Record<string, unknown>>;
  "GET /v1/me": Op<never, never, never, Record<string, unknown>>;
  "PATCH /v1/me": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/me/approvals/{id}/decide": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/me/inbox": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/me/lens": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/me/lens/reset": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/me/lens/usage": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/me/notifications/{id}/read": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/me/password": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/me/sessions": Op<never, never, never, Record<string, unknown>>;
  "DELETE /v1/me/sessions/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/names": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/north/alert_rules": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthAlert_rules>>;
  "POST /v1/north/alert_rules": Op<never, never, NorthAlert_rules, NorthAlert_rules>;
  "GET /v1/north/alert_rules/{id}": Op<{ id: string }, never, never, NorthAlert_rules>;
  "PATCH /v1/north/alert_rules/{id}": Op<{ id: string }, never, NorthAlert_rules, NorthAlert_rules>;
  "DELETE /v1/north/alert_rules/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/north/anomalies": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthAnomalies>>;
  "GET /v1/north/anomalies/{id}": Op<{ id: string }, never, never, NorthAnomalies>;
  "PATCH /v1/north/anomalies/{id}": Op<{ id: string }, never, NorthAnomalies, NorthAnomalies>;
  "GET /v1/north/boardpacks": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthBoardpacks>>;
  "POST /v1/north/boardpacks": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/north/boardpacks/{id}": Op<{ id: string }, never, never, NorthBoardpacks>;
  "GET /v1/north/boardpacks/{id}/file": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/north/briefings": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthBriefings>>;
  "POST /v1/north/briefings/generate": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/north/briefings/{id}": Op<{ id: string }, never, never, NorthBriefings>;
  "PATCH /v1/north/briefings/{id}": Op<{ id: string }, never, NorthBriefings, NorthBriefings>;
  "GET /v1/north/data-health": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/north/decisions": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthDecisions>>;
  "POST /v1/north/decisions": Op<never, never, NorthDecisions, NorthDecisions>;
  "GET /v1/north/decisions/{id}": Op<{ id: string }, never, never, NorthDecisions>;
  "PATCH /v1/north/decisions/{id}": Op<{ id: string }, never, NorthDecisions, NorthDecisions>;
  "DELETE /v1/north/decisions/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/north/explore": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/north/forecast": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/north/metrics": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthMetrics>>;
  "POST /v1/north/metrics": Op<never, never, NorthMetrics, NorthMetrics>;
  "GET /v1/north/metrics/{id}": Op<{ id: string }, never, never, NorthMetrics>;
  "PATCH /v1/north/metrics/{id}": Op<{ id: string }, never, NorthMetrics, NorthMetrics>;
  "DELETE /v1/north/metrics/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/north/scenarios": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthScenarios>>;
  "POST /v1/north/scenarios": Op<never, never, NorthScenarios, NorthScenarios>;
  "GET /v1/north/scenarios/{id}": Op<{ id: string }, never, never, NorthScenarios>;
  "PATCH /v1/north/scenarios/{id}": Op<{ id: string }, never, NorthScenarios, NorthScenarios>;
  "GET /v1/north/snapshots": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<NorthSnapshots>>;
  "GET /v1/north/snapshots/{id}": Op<{ id: string }, never, never, NorthSnapshots>;
  "POST /v1/north/snapshotter/run": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/onboarding/agreements": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/agreements/{id}/send": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/onboarding/agreements/{id}/sign": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/partners/signup": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/partners/{id}/advance": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/onboarding/partners/{id}/resume": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/onboarding/partners/{id}/suspend": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/partners/{id}/terminate": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/onboarding/steps": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/onboarding/steps": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/steps/{id}/complete": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/steps/{id}/fail": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/onboarding/steps/{id}/waive": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/orbit/agent-presence": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitAgentPresence>>;
  "POST /v1/orbit/agent-presence": Op<never, never, OrbitAgentPresence, OrbitAgentPresence>;
  "GET /v1/orbit/agent-presence/{id}": Op<{ id: string }, never, never, OrbitAgentPresence>;
  "PATCH /v1/orbit/agent-presence/{id}": Op<{ id: string }, never, OrbitAgentPresence, OrbitAgentPresence>;
  "GET /v1/orbit/channel-connectors": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitChannelConnectors>>;
  "POST /v1/orbit/channel-connectors": Op<never, never, OrbitChannelConnectors, OrbitChannelConnectors>;
  "GET /v1/orbit/channel-connectors/{id}": Op<{ id: string }, never, never, OrbitChannelConnectors>;
  "PATCH /v1/orbit/channel-connectors/{id}": Op<{ id: string }, never, OrbitChannelConnectors, OrbitChannelConnectors>;
  "DELETE /v1/orbit/channel-connectors/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/orbit/conversations": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitConversations>>;
  "POST /v1/orbit/conversations": Op<never, never, OrbitConversations, OrbitConversations>;
  "GET /v1/orbit/conversations/{id}": Op<{ id: string }, never, never, OrbitConversations>;
  "PATCH /v1/orbit/conversations/{id}": Op<{ id: string }, never, OrbitConversations, OrbitConversations>;
  "POST /v1/orbit/conversations/{id}/reply": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/orbit/conversations/{id}/turns": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/orbit/drafts/sweep": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/orbit/handover-notes": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitHandoverNotes>>;
  "POST /v1/orbit/handover-notes": Op<never, never, OrbitHandoverNotes, OrbitHandoverNotes>;
  "GET /v1/orbit/handover-notes/{id}": Op<{ id: string }, never, never, OrbitHandoverNotes>;
  "PATCH /v1/orbit/handover-notes/{id}": Op<{ id: string }, never, OrbitHandoverNotes, OrbitHandoverNotes>;
  "DELETE /v1/orbit/handover-notes/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/orbit/journey-runs": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitJourneyRuns>>;
  "GET /v1/orbit/journey-runs/{id}": Op<{ id: string }, never, never, OrbitJourneyRuns>;
  "GET /v1/orbit/journeys": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitJourneys>>;
  "POST /v1/orbit/journeys": Op<never, never, OrbitJourneys, OrbitJourneys>;
  "GET /v1/orbit/journeys/{id}": Op<{ id: string }, never, never, OrbitJourneys>;
  "PATCH /v1/orbit/journeys/{id}": Op<{ id: string }, never, OrbitJourneys, OrbitJourneys>;
  "DELETE /v1/orbit/journeys/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/orbit/messages": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitMessages>>;
  "POST /v1/orbit/messages": Op<never, never, OrbitMessages, OrbitMessages>;
  "GET /v1/orbit/messages/{id}": Op<{ id: string }, never, never, OrbitMessages>;
  "GET /v1/orbit/partner-txns": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitPartnerTxns>>;
  "GET /v1/orbit/partner-txns/{id}": Op<{ id: string }, never, never, OrbitPartnerTxns>;
  "GET /v1/orbit/partners": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitPartners>>;
  "POST /v1/orbit/partners": Op<never, never, OrbitPartners, OrbitPartners>;
  "GET /v1/orbit/partners/{id}": Op<{ id: string }, never, never, OrbitPartners>;
  "POST /v1/orbit/partners/{id}/quotes": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/orbit/portal-links/{kind}/{id}": Op<{ kind: string; id: string }, never, never, Record<string, unknown>>;
  "GET /v1/orbit/qa-scores": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitQaScores>>;
  "POST /v1/orbit/qa-scores": Op<never, never, OrbitQaScores, OrbitQaScores>;
  "GET /v1/orbit/qa-scores/{id}": Op<{ id: string }, never, never, OrbitQaScores>;
  "GET /v1/orbit/renewals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitRenewals>>;
  "POST /v1/orbit/renewals/sweep": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/orbit/renewals/{id}": Op<{ id: string }, never, never, OrbitRenewals>;
  "PATCH /v1/orbit/renewals/{id}": Op<{ id: string }, never, OrbitRenewals, OrbitRenewals>;
  "GET /v1/orbit/routing-rules": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitRoutingRules>>;
  "POST /v1/orbit/routing-rules": Op<never, never, OrbitRoutingRules, OrbitRoutingRules>;
  "GET /v1/orbit/routing-rules/{id}": Op<{ id: string }, never, never, OrbitRoutingRules>;
  "PATCH /v1/orbit/routing-rules/{id}": Op<{ id: string }, never, OrbitRoutingRules, OrbitRoutingRules>;
  "DELETE /v1/orbit/routing-rules/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/orbit/routing/sweep": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/orbit/sla-policies": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitSlaPolicies>>;
  "POST /v1/orbit/sla-policies": Op<never, never, OrbitSlaPolicies, OrbitSlaPolicies>;
  "GET /v1/orbit/sla-policies/{id}": Op<{ id: string }, never, never, OrbitSlaPolicies>;
  "PATCH /v1/orbit/sla-policies/{id}": Op<{ id: string }, never, OrbitSlaPolicies, OrbitSlaPolicies>;
  "DELETE /v1/orbit/sla-policies/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/orbit/team-members": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitTeamMembers>>;
  "POST /v1/orbit/team-members": Op<never, never, OrbitTeamMembers, OrbitTeamMembers>;
  "GET /v1/orbit/team-members/{id}": Op<{ id: string }, never, never, OrbitTeamMembers>;
  "PATCH /v1/orbit/team-members/{id}": Op<{ id: string }, never, OrbitTeamMembers, OrbitTeamMembers>;
  "DELETE /v1/orbit/team-members/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/orbit/teams": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<OrbitTeams>>;
  "POST /v1/orbit/teams": Op<never, never, OrbitTeams, OrbitTeams>;
  "GET /v1/orbit/teams/{id}": Op<{ id: string }, never, never, OrbitTeams>;
  "PATCH /v1/orbit/teams/{id}": Op<{ id: string }, never, OrbitTeams, OrbitTeams>;
  "DELETE /v1/orbit/teams/{id}": Op<{ id: string }, never, never, void>;
  "POST /v1/platform/ai/kill": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/platform/ai/release": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/platform/deployments": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/platform/flags": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/platform/flags": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "PATCH /v1/platform/flags/{id}": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/platform/impersonation": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/platform/impersonation/start": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/platform/impersonation/{id}/end": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/platform/incidents": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/platform/ops/overview": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/platform/slo": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/portal/{tenantSlug}/feedback/{id}": Op<{ tenantSlug: string; id: string }, never, never, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/feedback/{id}": Op<{ tenantSlug: string; id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/leads": Op<{ tenantSlug: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/privacy-requests": Op<{ tenantSlug: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/portal/{tenantSlug}/quote-requests/{id}": Op<{ tenantSlug: string; id: string }, never, never, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/accept": Op<{ tenantSlug: string; id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/documents": Op<{ tenantSlug: string; id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/reprice": Op<{ tenantSlug: string; id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/registrations": Op<{ tenantSlug: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/portal/{tenantSlug}/renewals/{id}": Op<{ tenantSlug: string; id: string }, never, never, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/renewals/{id}/accept": Op<{ tenantSlug: string; id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/portal/{tenantSlug}/site": Op<{ tenantSlug: string }, never, never, Record<string, unknown>>;
  "POST /v1/portal/{tenantSlug}/track": Op<{ tenantSlug: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/realtime": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/scout/clusters": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutClusters>>;
  "GET /v1/scout/clusters/{id}": Op<{ id: string }, never, never, ScoutClusters>;
  "GET /v1/scout/data-products": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutDataProducts>>;
  "POST /v1/scout/data-products": Op<never, never, ScoutDataProducts, ScoutDataProducts>;
  "GET /v1/scout/data-products/{id}": Op<{ id: string }, never, never, ScoutDataProducts>;
  "PATCH /v1/scout/data-products/{id}": Op<{ id: string }, never, ScoutDataProducts, ScoutDataProducts>;
  "GET /v1/scout/panel-bench": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutPanelBench>>;
  "GET /v1/scout/panel-bench/negotiation-pack": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/scout/panel-bench/{id}": Op<{ id: string }, never, never, ScoutPanelBench>;
  "GET /v1/scout/scout-experiments": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutScoutExperiments>>;
  "POST /v1/scout/scout-experiments": Op<never, never, ScoutScoutExperiments, ScoutScoutExperiments>;
  "GET /v1/scout/scout-experiments/{id}": Op<{ id: string }, never, never, ScoutScoutExperiments>;
  "PATCH /v1/scout/scout-experiments/{id}": Op<{ id: string }, never, ScoutScoutExperiments, ScoutScoutExperiments>;
  "GET /v1/scout/signals": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutSignals>>;
  "POST /v1/scout/signals": Op<never, never, ScoutSignals, ScoutSignals>;
  "POST /v1/scout/signals/similar": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/scout/signals/{id}": Op<{ id: string }, never, never, ScoutSignals>;
  "GET /v1/scout/whitespaces": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<ScoutWhitespaces>>;
  "GET /v1/scout/whitespaces/commentary": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/scout/whitespaces/compute": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/scout/whitespaces/{id}": Op<{ id: string }, never, never, ScoutWhitespaces>;
  "PATCH /v1/scout/whitespaces/{id}": Op<{ id: string }, never, ScoutWhitespaces, ScoutWhitespaces>;
  "GET /v1/scout/whitespaces/{id}/commentary": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/scout/whitespaces/{id}/promote-to-signal": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/scout/wording-diff": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/search": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/settlement/runs": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/settlement/settlements/{id}": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/settlement/settlements/{id}/approve": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/settlement/settlements/{id}/dispute": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/settlement/settlements/{id}/lines": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/settlement/settlements/{id}/pay": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/settlement/settlements/{id}/reopen": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/settlement/settlements/{id}/statement": Op<{ id: string }, never, never, Record<string, unknown>>;
  "GET /v1/signal/aeo-pages": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalAeoPages>>;
  "POST /v1/signal/aeo-pages": Op<never, never, SignalAeoPages, SignalAeoPages>;
  "GET /v1/signal/aeo-pages/{id}": Op<{ id: string }, never, never, SignalAeoPages>;
  "PATCH /v1/signal/aeo-pages/{id}": Op<{ id: string }, never, SignalAeoPages, SignalAeoPages>;
  "DELETE /v1/signal/aeo-pages/{id}": Op<{ id: string }, never, never, void>;
  "GET /v1/signal/attribution-events": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalAttributionEvents>>;
  "GET /v1/signal/attribution-events/{id}": Op<{ id: string }, never, never, SignalAttributionEvents>;
  "GET /v1/signal/attribution/funnel": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/signal/audiences": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalAudiences>>;
  "POST /v1/signal/audiences": Op<never, never, SignalAudiences, SignalAudiences>;
  "POST /v1/signal/audiences/suggest": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/signal/audiences/{id}": Op<{ id: string }, never, never, SignalAudiences>;
  "PATCH /v1/signal/audiences/{id}": Op<{ id: string }, never, SignalAudiences, SignalAudiences>;
  "POST /v1/signal/autopilot/pause": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/signal/autopilot/resume": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/signal/autopilot/run": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/signal/budget-moves": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalBudgetMoves>>;
  "GET /v1/signal/budget-moves/{id}": Op<{ id: string }, never, never, SignalBudgetMoves>;
  "PATCH /v1/signal/budget-moves/{id}": Op<{ id: string }, never, SignalBudgetMoves, SignalBudgetMoves>;
  "GET /v1/signal/campaigns": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalCampaigns>>;
  "POST /v1/signal/campaigns": Op<never, never, SignalCampaigns, SignalCampaigns>;
  "GET /v1/signal/campaigns/{id}": Op<{ id: string }, never, never, SignalCampaigns>;
  "PATCH /v1/signal/campaigns/{id}": Op<{ id: string }, never, SignalCampaigns, SignalCampaigns>;
  "POST /v1/signal/campaigns/{id}/plan": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/signal/creatives": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalCreatives>>;
  "POST /v1/signal/creatives": Op<never, never, SignalCreatives, SignalCreatives>;
  "POST /v1/signal/creatives/generate": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/signal/creatives/image": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/signal/creatives/{id}": Op<{ id: string }, never, never, SignalCreatives>;
  "PATCH /v1/signal/creatives/{id}": Op<{ id: string }, never, SignalCreatives, SignalCreatives>;
  "GET /v1/signal/creatives/{id}/image": Op<{ id: string }, never, never, Record<string, unknown>>;
  "POST /v1/signal/demo/spend-tick": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/signal/outreach": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalOutreach>>;
  "POST /v1/signal/outreach/run": Op<never, never, never, Record<string, unknown>>;
  "GET /v1/signal/outreach/{id}": Op<{ id: string }, never, never, SignalOutreach>;
  "GET /v1/signal/signal-experiments": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalSignalExperiments>>;
  "POST /v1/signal/signal-experiments": Op<never, never, SignalSignalExperiments, SignalSignalExperiments>;
  "GET /v1/signal/signal-experiments/{id}": Op<{ id: string }, never, never, SignalSignalExperiments>;
  "PATCH /v1/signal/signal-experiments/{id}": Op<{ id: string }, never, SignalSignalExperiments, SignalSignalExperiments>;
  "GET /v1/signal/spend": Op<never, { limit?: number; cursor?: string; q?: string; sort?: string }, never, Page<SignalSpend>>;
  "GET /v1/signal/spend/{id}": Op<{ id: string }, never, never, SignalSpend>;
  "GET /v1/staff/delegations": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/staff/delegations": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/staff/delegations/expire": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/staff/delegations/{id}/revoke": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/staff/invitations": Op<never, never, Record<string, unknown>, Record<string, unknown>>;
  "GET /v1/staff/users": Op<never, never, never, Record<string, unknown>>;
  "POST /v1/staff/users/{id}/offboard": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/staff/users/{id}/onboarding": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
  "POST /v1/staff/users/{id}/roles": Op<{ id: string }, never, Record<string, unknown>, Record<string, unknown>>;
}

export type OperationId = keyof Operations;

/** Runtime side of `Operations`: what a caller needs before making the call. */
export const OPERATIONS: Record<OperationId, OperationMeta> = {
  "GET /v1/ai/agents": { tag: "ai", summary: "List agents", permission: "ai:agents:read", public: false },
  "POST /v1/ai/agents": { tag: "ai", summary: "Create a agent", permission: "ai:agents:write", public: false },
  "GET /v1/ai/agents/{id}": { tag: "ai", summary: "Fetch one agent", permission: "ai:agents:read", public: false },
  "PATCH /v1/ai/agents/{id}": { tag: "ai", summary: "Update a agent", permission: "ai:agents:write", public: false },
  "DELETE /v1/ai/agents/{id}": { tag: "ai", summary: "Soft-delete a agent", permission: "ai:agents:write", public: false },
  "POST /v1/ai/agents/{key}/autonomy": { tag: "ai", summary: "Change an agent's autonomy level", permission: "ai:agents:write", public: false },
  "POST /v1/ai/agents/{key}/pause": { tag: "ai", summary: "Pause an agent", permission: "ai:agents:pause", public: false },
  "POST /v1/ai/agents/{key}/resume": { tag: "ai", summary: "Resume a paused agent", permission: "ai:agents:write", public: false },
  "GET /v1/ai/ai-audit-log": { tag: "ai", summary: "List ai-audit-log", permission: "ai:audit:read", public: false },
  "GET /v1/ai/ai-audit-log/{id}": { tag: "ai", summary: "Fetch one ai audit log", permission: "ai:audit:read", public: false },
  "GET /v1/ai/audit": { tag: "ai", summary: "Every model call, prompt hash and cost", permission: "ai:audit:read", public: false },
  "GET /v1/ai/audit/spend": { tag: "ai", summary: "Spend rolled up by module and purpose", permission: "ai:budgets:read", public: false },
  "GET /v1/ai/budget": { tag: "ai", summary: "Remaining AI budget for the period", permission: "ai:budgets:read", public: false },
  "POST /v1/ai/budget/limits": { tag: "ai", summary: "Set per-module AI spend limits", permission: "ai:budgets:write", public: false },
  "GET /v1/ai/budgets": { tag: "ai", summary: "List budgets", permission: "ai:budgets:read", public: false },
  "POST /v1/ai/budgets": { tag: "ai", summary: "Create a budget", permission: "ai:budgets:write", public: false },
  "GET /v1/ai/budgets/{id}": { tag: "ai", summary: "Fetch one budget", permission: "ai:budgets:read", public: false },
  "PATCH /v1/ai/budgets/{id}": { tag: "ai", summary: "Update a budget", permission: "ai:budgets:write", public: false },
  "DELETE /v1/ai/budgets/{id}": { tag: "ai", summary: "Soft-delete a budget", permission: "ai:budgets:write", public: false },
  "GET /v1/ai/command/proposals": { tag: "ai", summary: "List command-center proposals by state (default: proposed)", permission: "ai:command:read", public: false },
  "POST /v1/ai/command/proposals/{id}/action": { tag: "ai", summary: "Execute a proposal through the module's real engine path; the approval gate fires there", permission: "core:approvals:decide", public: false },
  "POST /v1/ai/command/proposals/{id}/dismiss": { tag: "ai", summary: "Dismiss a proposal — an explicit human decision", permission: "ai:command:read", public: false },
  "POST /v1/ai/command/runs": { tag: "ai", summary: "Run the bounded multi-round command loop; consequential tools become proposals, never executions", permission: "core:ai:invoke", public: false },
  "GET /v1/ai/evals": { tag: "ai", summary: "List evals", permission: "ai:evals:read", public: false },
  "POST /v1/ai/evals": { tag: "ai", summary: "Create a eval", permission: "ai:evals:run", public: false },
  "GET /v1/ai/evals/{id}": { tag: "ai", summary: "Fetch one eval", permission: "ai:evals:read", public: false },
  "GET /v1/ai/guardrail-events": { tag: "ai", summary: "List guardrail-events", permission: "ai:audit:read", public: false },
  "GET /v1/ai/guardrail-events/{id}": { tag: "ai", summary: "Fetch one guardrail event", permission: "ai:audit:read", public: false },
  "GET /v1/ai/kill-switches": { tag: "ai", summary: "Which AI kill switches are engaged: global, tenant, per module", permission: "ai:agents:read", public: false },
  "GET /v1/ai/knowledge-sources": { tag: "ai", summary: "List knowledge-sources", permission: "ai:prompts:read", public: false },
  "POST /v1/ai/knowledge-sources": { tag: "ai", summary: "Create a knowledge source", permission: "ai:prompts:write", public: false },
  "GET /v1/ai/knowledge-sources/{id}": { tag: "ai", summary: "Fetch one knowledge source", permission: "ai:prompts:read", public: false },
  "PATCH /v1/ai/knowledge-sources/{id}": { tag: "ai", summary: "Update a knowledge source", permission: "ai:prompts:write", public: false },
  "DELETE /v1/ai/knowledge-sources/{id}": { tag: "ai", summary: "Soft-delete a knowledge source", permission: "ai:prompts:write", public: false },
  "POST /v1/ai/pause": { tag: "ai", summary: "Pause AI for the tenant, or for one module (docs/12 §4)", permission: "ai:killswitch:use", public: false },
  "GET /v1/ai/prompts": { tag: "ai", summary: "List prompts", permission: "ai:prompts:read", public: false },
  "POST /v1/ai/prompts": { tag: "ai", summary: "Create a prompt", permission: "ai:prompts:write", public: false },
  "GET /v1/ai/prompts/{id}": { tag: "ai", summary: "Fetch one prompt", permission: "ai:prompts:read", public: false },
  "PATCH /v1/ai/prompts/{id}": { tag: "ai", summary: "Update a prompt", permission: "ai:prompts:write", public: false },
  "DELETE /v1/ai/prompts/{id}": { tag: "ai", summary: "Soft-delete a prompt", permission: "ai:prompts:write", public: false },
  "POST /v1/ai/resume": { tag: "ai", summary: "Release the tenant or module AI pause", permission: "ai:agents:write", public: false },
  "GET /v1/ai/runs": { tag: "ai", summary: "List runs", permission: "ai:runs:read", public: false },
  "POST /v1/ai/runs": { tag: "ai", summary: "Run an agent through the gateway, budgeted and audited (needs the agent module's :ai:invoke)", permission: "core:ai:invoke", public: false },
  "GET /v1/ai/runs/{id}": { tag: "ai", summary: "Fetch one run", permission: "ai:runs:read", public: false },
  "GET /v1/ai/runs/{id}/detail": { tag: "ai", summary: "One agent run with its tool calls and audit trail", permission: "ai:runs:read", public: false },
  "GET /v1/ai/suggestions": { tag: "ai", summary: "List suggestions", permission: "ai:suggestions:read", public: false },
  "POST /v1/ai/suggestions": { tag: "ai", summary: "Record a suggestion shown to the current user", permission: "ai:suggestions:read", public: false },
  "GET /v1/ai/suggestions/acceptance": { tag: "ai", summary: "Acceptance rate by surface and module", permission: "ai:runs:read", public: false },
  "GET /v1/ai/suggestions/{id}": { tag: "ai", summary: "Fetch one suggestion", permission: "ai:suggestions:read", public: false },
  "PATCH /v1/ai/suggestions/{id}": { tag: "ai", summary: "Update a suggestion", permission: "ai:suggestions:read", public: false },
  "POST /v1/ai/suggestions/{id}/outcome": { tag: "ai", summary: "Record whether the current user accepted, edited or dismissed it", permission: "ai:suggestions:read", public: false },
  "GET /v1/ai/tool-calls": { tag: "ai", summary: "List tool-calls", permission: "ai:runs:read", public: false },
  "GET /v1/ai/tool-calls/{id}": { tag: "ai", summary: "Fetch one tool call", permission: "ai:runs:read", public: false },
  "GET /v1/analytics/dashboards": { tag: "analytics", summary: "Dashboards the caller may open", permission: "analytics:dashboards:read", public: false },
  "POST /v1/analytics/dashboards": { tag: "analytics", summary: "Create a dashboard from a set of report tiles", permission: "analytics:dashboards:write", public: false },
  "GET /v1/analytics/dashboards/{id}": { tag: "analytics", summary: "Fetch one dashboard", permission: "analytics:dashboards:read", public: false },
  "PATCH /v1/analytics/dashboards/{id}": { tag: "analytics", summary: "Update a dashboard", permission: "analytics:dashboards:write", public: false },
  "DELETE /v1/analytics/dashboards/{id}": { tag: "analytics", summary: "Soft-delete a dashboard", permission: "analytics:dashboards:write", public: false },
  "GET /v1/analytics/dashboards/{id}/data": { tag: "analytics", summary: "Every tile on a dashboard in one call", permission: "analytics:dashboards:read", public: false },
  "GET /v1/analytics/datasets": { tag: "analytics", summary: "Semantic layer the report builder may offer this caller", permission: null, public: false },
  "GET /v1/analytics/exports": { tag: "analytics", summary: "The caller's recent exports and their state", permission: "analytics:exports:create", public: false },
  "POST /v1/analytics/exports": { tag: "analytics", summary: "Render a run to xlsx, pdf, csv or json", permission: "analytics:exports:create", public: false },
  "GET /v1/analytics/exports/{id}": { tag: "analytics", summary: "Fetch one export", permission: "analytics:exports:download", public: false },
  "GET /v1/analytics/exports/{id}/download": { tag: "analytics", summary: "Download a rendered export", permission: "analytics:exports:download", public: false },
  "GET /v1/analytics/feed/{dataset}": { tag: "analytics", summary: "Incremental NDJSON feed of one dataset for a warehouse or BI tool", permission: "analytics:exports:create", public: false },
  "GET /v1/analytics/journey-events": { tag: "analytics", summary: "List journey-events", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/journey-events/{id}": { tag: "analytics", summary: "Fetch one journey event", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/report-runs": { tag: "analytics", summary: "List report-runs", permission: "analytics:reports:read", public: false },
  "POST /v1/analytics/report-runs": { tag: "analytics", summary: "Create a report run", permission: "analytics:reports:run", public: false },
  "GET /v1/analytics/report-runs/{id}": { tag: "analytics", summary: "Fetch one report run", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/reports": { tag: "analytics", summary: "Saved reports the caller may run, newest first", permission: "analytics:reports:read", public: false },
  "POST /v1/analytics/reports": { tag: "analytics", summary: "Save a report; it inherits the dataset's permission, never one from the body", permission: "analytics:reports:write", public: false },
  "GET /v1/analytics/reports/{id}": { tag: "analytics", summary: "One saved report definition", permission: "analytics:reports:read", public: false },
  "PATCH /v1/analytics/reports/{id}": { tag: "analytics", summary: "Edit a saved report (system reports must be cloned first)", permission: "analytics:reports:write", public: false },
  "DELETE /v1/analytics/reports/{id}": { tag: "analytics", summary: "Delete a saved report", permission: "analytics:reports:write", public: false },
  "POST /v1/analytics/reports/{id}/restore": { tag: "analytics", summary: "Restore a soft-deleted report", permission: "analytics:reports:write", public: false },
  "POST /v1/analytics/reports/{id}/run": { tag: "analytics", summary: "Run a saved report", permission: "analytics:reports:run", public: false },
  "POST /v1/analytics/run": { tag: "analytics", summary: "Run an ad-hoc report definition without saving it", permission: "analytics:reports:run", public: false },
  "GET /v1/analytics/runs/{id}": { tag: "analytics", summary: "A completed run with its rows, totals and truncation flag", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/saved-views": { tag: "analytics", summary: "The caller's saved list views", permission: "analytics:saved_views:read", public: false },
  "POST /v1/analytics/saved-views": { tag: "analytics", summary: "Save the current filters and columns of a list", permission: "analytics:saved_views:write", public: false },
  "GET /v1/analytics/saved-views/{id}": { tag: "analytics", summary: "Fetch one saved view", permission: "analytics:saved_views:read", public: false },
  "PATCH /v1/analytics/saved-views/{id}": { tag: "analytics", summary: "Update a saved view", permission: "analytics:saved_views:write", public: false },
  "DELETE /v1/analytics/saved-views/{id}": { tag: "analytics", summary: "Delete a saved view", permission: "analytics:saved_views:write", public: false },
  "GET /v1/analytics/schedules": { tag: "analytics", summary: "Report schedules and their next run", permission: "analytics:schedules:read", public: false },
  "POST /v1/analytics/schedules": { tag: "analytics", summary: "Schedule a report to run and deliver on a cron", permission: "analytics:schedules:write", public: false },
  "GET /v1/analytics/schedules/{id}": { tag: "analytics", summary: "Fetch one schedule", permission: "analytics:schedules:read", public: false },
  "PATCH /v1/analytics/schedules/{id}": { tag: "analytics", summary: "Update a schedule", permission: "analytics:schedules:write", public: false },
  "DELETE /v1/analytics/schedules/{id}": { tag: "analytics", summary: "Delete a schedule", permission: "analytics:schedules:write", public: false },
  "POST /v1/analytics/schedules/{id}/pause": { tag: "analytics", summary: "Pause a schedule", permission: "analytics:schedules:write", public: false },
  "POST /v1/analytics/schedules/{id}/resume": { tag: "analytics", summary: "Resume a paused schedule", permission: "analytics:schedules:write", public: false },
  "GET /v1/analytics/unit-economics": { tag: "analytics", summary: "Cost, revenue and margin per unit of work", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/unit-economics/{id}": { tag: "analytics", summary: "Fetch one unit economic", permission: "analytics:reports:read", public: false },
  "GET /v1/analytics/usage": { tag: "analytics", summary: "Per-tenant storage and daily egress bytes", permission: "analytics:reports:read", public: false },
  "POST /v1/auth/demo/clock": { tag: "auth", summary: "Advance the simulated clock used by non-production timestamps (non-production only)", permission: null, public: true },
  "POST /v1/auth/demo/login": { tag: "auth", summary: "Sign in as a seeded demo persona without a password (non-production only)", permission: null, public: true },
  "GET /v1/auth/demo/personas": { tag: "auth", summary: "Seeded demo personas offered as one-click sign-in (non-production only)", permission: null, public: true },
  "POST /v1/auth/demo/resync-roles": { tag: "auth", summary: "Refresh the demo tenant's system role permissions, chart of accounts and seeded personas to match the compiled tables (non-production only)", permission: null, public: true },
  "POST /v1/auth/demo/seed": { tag: "auth", summary: "Seed one demo tenant with its personas and starting data (non-production only)", permission: null, public: true },
  "POST /v1/auth/login": { tag: "auth", summary: "Password login, returns a session cookie", permission: null, public: true },
  "POST /v1/auth/logout": { tag: "auth", summary: "End the current session", permission: null, public: true },
  "POST /v1/auth/mfa/disable": { tag: "auth", summary: "Remove the second factor (refused for staff roles)", permission: null, public: true },
  "POST /v1/auth/mfa/enrol": { tag: "auth", summary: "Start TOTP enrolment; returns the secret once", permission: null, public: true },
  "POST /v1/auth/mfa/enrol/confirm": { tag: "auth", summary: "Confirm TOTP enrolment; returns single-use recovery codes once", permission: null, public: true },
  "POST /v1/auth/mfa/verify": { tag: "auth", summary: "Clear the second factor with a TOTP or recovery code", permission: null, public: true },
  "GET /v1/auth/sso/discover": { tag: "auth", summary: "Which identity provider, if any, owns an email domain", permission: null, public: true },
  "GET /v1/auth/sso/{id}/callback": { tag: "auth", summary: "Verify the id_token, link or provision the account, issue a session", permission: null, public: true },
  "GET /v1/auth/sso/{id}/start": { tag: "auth", summary: "Redirect to the provider's authorization endpoint (OIDC + PKCE)", permission: null, public: true },
  "GET /v1/axis/bordereau-lines": { tag: "axis", summary: "List bordereau-lines", permission: "axis:bordereaux:read", public: false },
  "GET /v1/axis/bordereau-lines/{id}": { tag: "axis", summary: "Fetch one bordereau line", permission: "axis:bordereaux:read", public: false },
  "GET /v1/axis/bordereaux": { tag: "axis", summary: "List bordereaux", permission: "axis:bordereaux:read", public: false },
  "POST /v1/axis/bordereaux": { tag: "axis", summary: "Generate an outbound bordereau from ledger data, or store an inbound one's raw lines (idempotent per period)", permission: "axis:bordereaux:generate", public: false },
  "GET /v1/axis/bordereaux/{id}": { tag: "axis", summary: "Fetch one bordereaux", permission: "axis:bordereaux:read", public: false },
  "POST /v1/axis/bordereaux/{id}/reconcile": { tag: "axis", summary: "Match an inbound bordereau's lines against our policies by policy number", permission: "axis:bordereaux:reconcile", public: false },
  "GET /v1/axis/case-approvals": { tag: "axis", summary: "List case-approvals", permission: "axis:cases:approve", public: false },
  "GET /v1/axis/case-approvals/{id}": { tag: "axis", summary: "Fetch one case approval", permission: "axis:cases:approve", public: false },
  "GET /v1/axis/cases": { tag: "axis", summary: "List cases", permission: "axis:cases:read", public: false },
  "POST /v1/axis/cases": { tag: "axis", summary: "Create a cas", permission: "axis:cases:create", public: false },
  "POST /v1/axis/cases/bulk": { tag: "axis", summary: "Bulk actions on cases — assign, reprioritise, close, tag (AXIS-007). Per-row permission checks and audit; the response names every case that failed and why", permission: "axis:cases:update", public: false },
  "POST /v1/axis/cases/import": { tag: "axis", summary: "Bulk-import cases from CSV (AXIS-001). Per-row honest: the response names every line that failed and why; duplicate refs are counted, not errors", permission: "axis:cases:create", public: false },
  "GET /v1/axis/cases/{id}": { tag: "axis", summary: "Fetch one cas", permission: "axis:cases:read", public: false },
  "PATCH /v1/axis/cases/{id}": { tag: "axis", summary: "Update a cas", permission: "axis:cases:update", public: false },
  "DELETE /v1/axis/cases/{id}": { tag: "axis", summary: "Soft-delete a cas", permission: "axis:cases:delete", public: false },
  "POST /v1/axis/cases/{id}/copilot": { tag: "axis", summary: "Answer a question about a case, grounded only in its own documents, events and tasks", permission: "axis:cases:read", public: false },
  "POST /v1/axis/cases/{id}/quotes": { tag: "axis", summary: "Key a quote received off-panel onto the case, as a quote response", permission: "axis:quotes:create", public: false },
  "POST /v1/axis/cases/{id}/restore": { tag: "axis", summary: "Restore a soft-deleted cas", permission: "axis:cases:delete", public: false },
  "POST /v1/axis/cases/{id}/sla-predict": { tag: "axis", summary: "Estimate SLA breach probability and time-to-breach for a case", permission: "axis:cases:read", public: false },
  "POST /v1/axis/cases/{id}/transition": { tag: "axis", summary: "Move a case through its state machine", permission: "axis:cases:update", public: false },
  "GET /v1/axis/claims": { tag: "axis", summary: "List claims", permission: "axis:claims:read", public: false },
  "POST /v1/axis/claims": { tag: "axis", summary: "Create a claim", permission: "axis:claims:create", public: false },
  "POST /v1/axis/claims/coverage-check": { tag: "axis", summary: "Cover in force on the incident date, without writing anything", permission: "axis:claims:register", public: false },
  "GET /v1/axis/claims/{id}": { tag: "axis", summary: "Fetch one claim", permission: "axis:claims:read", public: false },
  "PATCH /v1/axis/claims/{id}": { tag: "axis", summary: "Update a claim", permission: "axis:claims:update", public: false },
  "POST /v1/axis/claims/{id}/fraud-score": { tag: "axis", summary: "Score a claim for SIU referral and queue a referral above threshold", permission: "axis:siu:write", public: false },
  "GET /v1/axis/claims/{id}/payments": { tag: "axis", summary: "The payments made on this claim, newest first", permission: "axis:claims:read", public: false },
  "POST /v1/axis/claims/{id}/payments": { tag: "axis", summary: "Pay a claim out of the funded float", permission: "axis:claims:pay", public: false },
  "GET /v1/axis/claims/{id}/recoveries": { tag: "axis", summary: "The recoveries being pursued on this claim, newest first", permission: "axis:claims:read", public: false },
  "POST /v1/axis/claims/{id}/recoveries": { tag: "axis", summary: "Open a recovery against a settled claim", permission: "axis:claims:recover", public: false },
  "POST /v1/axis/claims/{id}/reserve-recommendation": { tag: "axis", summary: "Suggest and write an AI-recommended reserve from comparable closed claims", permission: "axis:claims:reserve", public: false },
  "GET /v1/axis/claims/{id}/reserves": { tag: "axis", summary: "The reserve history of this claim, newest first", permission: "axis:claims:read", public: false },
  "POST /v1/axis/claims/{id}/reserves": { tag: "axis", summary: "Append a reserve movement on one head", permission: "axis:claims:reserve", public: false },
  "POST /v1/axis/claims/{id}/transition": { tag: "axis", summary: "Move a claim through its state machine", permission: "axis:claims:update", public: false },
  "GET /v1/axis/complaints": { tag: "axis", summary: "List complaints", permission: "axis:complaints:read", public: false },
  "POST /v1/axis/complaints": { tag: "axis", summary: "Create a complaint", permission: "axis:complaints:write", public: false },
  "GET /v1/axis/complaints/{id}": { tag: "axis", summary: "Fetch one complaint", permission: "axis:complaints:read", public: false },
  "PATCH /v1/axis/complaints/{id}": { tag: "axis", summary: "Update a complaint", permission: "axis:complaints:write", public: false },
  "POST /v1/axis/dev/extract-sample": { tag: "axis", summary: "Developer console: run field extraction against pasted text, no document row created", permission: "dev:sandbox:use", public: false },
  "GET /v1/axis/documents": { tag: "axis", summary: "List documents", permission: "axis:documents:read", public: false },
  "POST /v1/axis/documents": { tag: "axis", summary: "Create a document", permission: "axis:documents:upload", public: false },
  "POST /v1/axis/documents/upload": { tag: "axis", summary: "Upload a captured document (multipart: caseId, docType, file) and file it against a case", permission: "axis:documents:upload", public: false },
  "GET /v1/axis/documents/{id}": { tag: "axis", summary: "Fetch one document", permission: "axis:documents:read", public: false },
  "PATCH /v1/axis/documents/{id}": { tag: "axis", summary: "Update a document", permission: "axis:documents:verify", public: false },
  "POST /v1/axis/documents/{id}/extract": { tag: "axis", summary: "Structure a document's raw text into named fields via the model gateway", permission: "axis:documents:extract", public: false },
  "GET /v1/axis/documents/{id}/file": { tag: "axis", summary: "Stream a document's underlying file", permission: "axis:documents:read", public: false },
  "POST /v1/axis/documents/{id}/reveal": { tag: "axis", summary: "Open the sealed identifier fields of an extraction (requires core:pii:view; audited)", permission: "axis:documents:read", public: false },
  "POST /v1/axis/documents/{id}/verify": { tag: "axis", summary: "Mark a document verified; the verifier and the time are stamped server-side", permission: "axis:documents:verify", public: false },
  "GET /v1/axis/escrow-batches": { tag: "axis", summary: "List escrow-batches", permission: "axis:escrow:read", public: false },
  "GET /v1/axis/escrow-batches/{id}": { tag: "axis", summary: "Fetch one escrow batche", permission: "axis:escrow:read", public: false },
  "PATCH /v1/axis/escrow-batches/{id}": { tag: "axis", summary: "Update a escrow batche", permission: "axis:escrow:reconcile", public: false },
  "GET /v1/axis/ops-policies": { tag: "axis", summary: "List ops-policies", permission: "axis:ops_policies:read", public: false },
  "POST /v1/axis/ops-policies": { tag: "axis", summary: "Create a ops policy", permission: "axis:ops_policies:write", public: false },
  "GET /v1/axis/ops-policies/{id}": { tag: "axis", summary: "Fetch one ops policy", permission: "axis:ops_policies:read", public: false },
  "PATCH /v1/axis/ops-policies/{id}": { tag: "axis", summary: "Update a ops policy", permission: "axis:ops_policies:write", public: false },
  "DELETE /v1/axis/ops-policies/{id}": { tag: "axis", summary: "Soft-delete a ops policy", permission: "axis:ops_policies:write", public: false },
  "GET /v1/axis/policies": { tag: "axis", summary: "List policies", permission: "axis:policies:read", public: false },
  "POST /v1/axis/policies": { tag: "axis", summary: "Create a policy", permission: "axis:policies:create", public: false },
  "GET /v1/axis/policies/{id}": { tag: "axis", summary: "Fetch one policy", permission: "axis:policies:read", public: false },
  "PATCH /v1/axis/policies/{id}": { tag: "axis", summary: "Update a policy", permission: "axis:policies:update", public: false },
  "POST /v1/axis/policies/{id}/bind": { tag: "axis", summary: "Bind a draft policy, issuing version 1", permission: "axis:policies:bind", public: false },
  "POST /v1/axis/policies/{id}/bind-group": { tag: "axis", summary: "Bind a group/SME scheme, posting a BIND-GROUP commission accrual (dual control)", permission: "axis:policies:bind", public: false },
  "POST /v1/axis/policies/{id}/broker-fee": { tag: "axis", summary: "Post a FEE-BROK brokerage/advisory fee accrual on a policy", permission: "axis:policies:bind", public: false },
  "POST /v1/axis/policies/{id}/cancel": { tag: "axis", summary: "Cancel a policy, refunding the unearned premium", permission: "axis:policies:cancel", public: false },
  "POST /v1/axis/policies/{id}/cancel/preview": { tag: "axis", summary: "Price a cancellation without writing anything", permission: "axis:policies:cancel", public: false },
  "POST /v1/axis/policies/{id}/documents": { tag: "axis", summary: "Issue a policy document for a version and attach it", permission: "axis:policies:document", public: false },
  "POST /v1/axis/policies/{id}/endorse": { tag: "axis", summary: "Endorse a policy, appending a priced version", permission: "axis:policies:endorse", public: false },
  "POST /v1/axis/policies/{id}/endorse/preview": { tag: "axis", summary: "Price a mid-term change without writing anything", permission: "axis:policies:endorse", public: false },
  "POST /v1/axis/policies/{id}/lapse": { tag: "axis", summary: "Lapse a policy for an unpaid instalment", permission: "axis:policies:lapse", public: false },
  "POST /v1/axis/policies/{id}/ntu": { tag: "axis", summary: "Mark a policy not-taken-up, clawing back the whole commission", permission: "axis:policies:ntu", public: false },
  "POST /v1/axis/policies/{id}/premium-financing-plan": { tag: "axis", summary: "Open a premium-financing plan on a bound policy", permission: "axis:policies:finance", public: false },
  "POST /v1/axis/policies/{id}/premium-financing-plan/cancel": { tag: "axis", summary: "Cancel a policy's live premium-financing plan", permission: "axis:policies:finance", public: false },
  "POST /v1/axis/policies/{id}/reinstate": { tag: "axis", summary: "Put cover back on risk after arrears are cleared", permission: "axis:policies:reinstate", public: false },
  "POST /v1/axis/policies/{id}/renew": { tag: "axis", summary: "Bind a successor term and close the prior one", permission: "axis:policies:renew", public: false },
  "POST /v1/axis/policies/{id}/reprice": { tag: "axis", summary: "Reprice a cover from its telemetry, endorsing it if the price moved", permission: "axis:policies:endorse", public: false },
  "POST /v1/axis/policies/{id}/telemetry": { tag: "axis", summary: "Ingest a batch of sensor points against this cover", permission: "axis:policies:telemetry", public: false },
  "GET /v1/axis/policies/{id}/versions": { tag: "axis", summary: "The endorsement history of this policy, newest first", permission: "axis:policies:read", public: false },
  "GET /v1/axis/process-events": { tag: "axis", summary: "List process-events", permission: "axis:metrics:read", public: false },
  "GET /v1/axis/process-events/{id}": { tag: "axis", summary: "Fetch one process event", permission: "axis:metrics:read", public: false },
  "POST /v1/axis/quote-responses/{id}/bind": { tag: "axis", summary: "Bind an accepted quote response into a policy at version 1", permission: "axis:policies:bind", public: false },
  "POST /v1/axis/quote-responses/{id}/decline": { tag: "axis", summary: "Rule a quote out, recording why", permission: "axis:quotes:create", public: false },
  "GET /v1/axis/quotes": { tag: "axis", summary: "List quotes", permission: "axis:quotes:read", public: false },
  "GET /v1/axis/quotes/{id}": { tag: "axis", summary: "Fetch one quote", permission: "axis:quotes:read", public: false },
  "POST /v1/axis/recoveries/{id}/receipt": { tag: "axis", summary: "Record money recovered, net of the handling fee", permission: "axis:claims:recover", public: false },
  "POST /v1/axis/recoveries/{id}/writeoff": { tag: "axis", summary: "Abandon pursuit and write the outstanding recovery off", permission: "axis:claims:recover", public: false },
  "GET /v1/axis/referrals": { tag: "axis", summary: "List referrals", permission: "axis:policies:decide_referral", public: false },
  "GET /v1/axis/referrals/{id}": { tag: "axis", summary: "Fetch one referral", permission: "axis:policies:decide_referral", public: false },
  "POST /v1/axis/referrals/{id}/decide": { tag: "axis", summary: "Accept, decline, or counter an open underwriting-authority referral", permission: "axis:policies:decide_referral", public: false },
  "GET /v1/axis/siu-referrals": { tag: "axis", summary: "List siu-referrals", permission: "axis:siu:read", public: false },
  "POST /v1/axis/siu-referrals": { tag: "axis", summary: "Create a siu referral", permission: "axis:siu:write", public: false },
  "GET /v1/axis/siu-referrals/{id}": { tag: "axis", summary: "Fetch one siu referral", permission: "axis:siu:read", public: false },
  "PATCH /v1/axis/siu-referrals/{id}": { tag: "axis", summary: "Update a siu referral", permission: "axis:siu:write", public: false },
  "GET /v1/axis/sops": { tag: "axis", summary: "List sops", permission: "axis:sops:read", public: false },
  "POST /v1/axis/sops": { tag: "axis", summary: "Create a sop", permission: "axis:sops:write", public: false },
  "GET /v1/axis/sops/{id}": { tag: "axis", summary: "Fetch one sop", permission: "axis:sops:read", public: false },
  "PATCH /v1/axis/sops/{id}": { tag: "axis", summary: "Update a sop", permission: "axis:sops:write", public: false },
  "DELETE /v1/axis/sops/{id}": { tag: "axis", summary: "Soft-delete a sop", permission: "axis:sops:write", public: false },
  "POST /v1/axis/sops/{id}/publish": { tag: "axis", summary: "Publish an SOP version, retiring whichever version of the same SOP was active", permission: "axis:sops:write", public: false },
  "GET /v1/axis/tasks": { tag: "axis", summary: "List tasks", permission: "axis:tasks:read", public: false },
  "POST /v1/axis/tasks": { tag: "axis", summary: "Create a task", permission: "axis:tasks:write", public: false },
  "GET /v1/axis/tasks/{id}": { tag: "axis", summary: "Fetch one task", permission: "axis:tasks:read", public: false },
  "PATCH /v1/axis/tasks/{id}": { tag: "axis", summary: "Update a task", permission: "axis:tasks:write", public: false },
  "DELETE /v1/axis/tasks/{id}": { tag: "axis", summary: "Soft-delete a task", permission: "axis:tasks:write", public: false },
  "GET /v1/axis/telemetry-points": { tag: "axis", summary: "List telemetry-points", permission: "axis:policies:read", public: false },
  "GET /v1/axis/telemetry-points/{id}": { tag: "axis", summary: "Fetch one telemetry point", permission: "axis:policies:read", public: false },
  "GET /v1/channels/{connectorId}/webhook": { tag: "orbit", summary: "Provider subscription handshake; echoes the challenge when the verify token matches", permission: null, public: true },
  "POST /v1/channels/{connectorId}/webhook": { tag: "orbit", summary: "Provider webhook delivery: signature-verified inbound messages and delivery receipts", permission: null, public: true },
  "GET /v1/compliance/disclosures": { tag: "compliance", summary: "List disclosures", permission: "compliance:disclosures:read", public: false },
  "POST /v1/compliance/disclosures/present": { tag: "compliance", summary: "Record that a required disclosure was shown, hashing the wording as evidence", permission: "compliance:disclosures:present", public: false },
  "GET /v1/compliance/disclosures/{id}": { tag: "compliance", summary: "Fetch one disclosure", permission: "compliance:disclosures:read", public: false },
  "GET /v1/compliance/dsar-requests": { tag: "compliance", summary: "List dsar-requests", permission: "compliance:dsar:read", public: false },
  "POST /v1/compliance/dsar-requests": { tag: "compliance", summary: "Create a dsar request", permission: "compliance:dsar:create", public: false },
  "GET /v1/compliance/dsar-requests/{id}": { tag: "compliance", summary: "Fetch one dsar request", permission: "compliance:dsar:read", public: false },
  "PATCH /v1/compliance/dsar-requests/{id}": { tag: "compliance", summary: "Update a dsar request", permission: "compliance:dsar:fulfil", public: false },
  "GET /v1/compliance/erasure-log": { tag: "compliance", summary: "List erasure-log", permission: "compliance:dsar:read", public: false },
  "GET /v1/compliance/erasure-log/{id}": { tag: "compliance", summary: "Fetch one erasure log", permission: "compliance:dsar:read", public: false },
  "GET /v1/compliance/evidence-bundles": { tag: "compliance", summary: "List evidence-bundles", permission: "compliance:evidence:read", public: false },
  "POST /v1/compliance/evidence-bundles/export": { tag: "compliance", summary: "Assemble an evidence bundle and record its manifest and hash", permission: "compliance:evidence:export", public: false },
  "GET /v1/compliance/evidence-bundles/{id}": { tag: "compliance", summary: "Fetch one evidence bundle", permission: "compliance:evidence:read", public: false },
  "GET /v1/compliance/evidence-bundles/{id}/download": { tag: "compliance", summary: "Download an assembled evidence bundle", permission: "compliance:evidence:read", public: false },
  "GET /v1/compliance/incidents": { tag: "compliance", summary: "List incidents", permission: "compliance:incidents:read", public: false },
  "POST /v1/compliance/incidents": { tag: "compliance", summary: "Create a incident", permission: "compliance:incidents:write", public: false },
  "GET /v1/compliance/incidents/{id}": { tag: "compliance", summary: "Fetch one incident", permission: "compliance:incidents:read", public: false },
  "PATCH /v1/compliance/incidents/{id}": { tag: "compliance", summary: "Update a incident", permission: "compliance:incidents:write", public: false },
  "DELETE /v1/compliance/incidents/{id}": { tag: "compliance", summary: "Soft-delete a incident", permission: "compliance:incidents:write", public: false },
  "GET /v1/compliance/legal-holds": { tag: "compliance", summary: "List legal-holds", permission: "compliance:legal_holds:read", public: false },
  "POST /v1/compliance/legal-holds": { tag: "compliance", summary: "Create a legal hold", permission: "compliance:legal_holds:write", public: false },
  "GET /v1/compliance/legal-holds/{id}": { tag: "compliance", summary: "Fetch one legal hold", permission: "compliance:legal_holds:read", public: false },
  "PATCH /v1/compliance/legal-holds/{id}": { tag: "compliance", summary: "Update a legal hold", permission: "compliance:legal_holds:write", public: false },
  "DELETE /v1/compliance/legal-holds/{id}": { tag: "compliance", summary: "Soft-delete a legal hold", permission: "compliance:legal_holds:write", public: false },
  "GET /v1/compliance/policy-thresholds": { tag: "compliance", summary: "List policy-thresholds", permission: "compliance:thresholds:read", public: false },
  "POST /v1/compliance/policy-thresholds": { tag: "compliance", summary: "Create a policy threshold", permission: "compliance:thresholds:write", public: false },
  "GET /v1/compliance/policy-thresholds/{id}": { tag: "compliance", summary: "Fetch one policy threshold", permission: "compliance:thresholds:read", public: false },
  "PATCH /v1/compliance/policy-thresholds/{id}": { tag: "compliance", summary: "Update a policy threshold", permission: "compliance:thresholds:write", public: false },
  "DELETE /v1/compliance/policy-thresholds/{id}": { tag: "compliance", summary: "Soft-delete a policy threshold", permission: "compliance:thresholds:write", public: false },
  "GET /v1/compliance/retention-runs": { tag: "compliance", summary: "List retention-runs", permission: "compliance:retention:read", public: false },
  "GET /v1/compliance/retention-runs/{id}": { tag: "compliance", summary: "Fetch one retention run", permission: "compliance:retention:read", public: false },
  "POST /v1/compliance/retention/run": { tag: "compliance", summary: "Run a retention class and record what it purged", permission: "compliance:retention:run", public: false },
  "GET /v1/compliance/rulepack-applications": { tag: "compliance", summary: "List rulepack-applications", permission: "compliance:rulepacks:read", public: false },
  "POST /v1/compliance/rulepack-applications": { tag: "compliance", summary: "Create a rulepack application", permission: "compliance:rulepacks:apply", public: false },
  "GET /v1/compliance/rulepack-applications/{id}": { tag: "compliance", summary: "Fetch one rulepack application", permission: "compliance:rulepacks:read", public: false },
  "GET /v1/compliance/screenings": { tag: "compliance", summary: "List screenings", permission: "compliance:screenings:read", public: false },
  "POST /v1/compliance/screenings/run": { tag: "compliance", summary: "Screen a customer or name against the watchlists and record the hashed query", permission: "compliance:screenings:run", public: false },
  "GET /v1/compliance/screenings/{id}": { tag: "compliance", summary: "Fetch one screening", permission: "compliance:screenings:read", public: false },
  "GET /v1/core/api-keys": { tag: "core", summary: "List api-keys", permission: "core:api_keys:read", public: false },
  "POST /v1/core/api-keys": { tag: "core", summary: "Mint an API key; the plaintext is returned once and never again", permission: "core:api_keys:create", public: false },
  "GET /v1/core/api-keys/{id}": { tag: "core", summary: "Fetch one api key", permission: "core:api_keys:read", public: false },
  "DELETE /v1/core/api-keys/{id}": { tag: "core", summary: "Revoke an API key; the row is kept for audit, the key stops authenticating", permission: "core:api_keys:revoke", public: false },
  "GET /v1/core/approvals": { tag: "core", summary: "List approvals", permission: "core:approvals:read", public: false },
  "GET /v1/core/approvals/{id}": { tag: "core", summary: "Fetch one approval", permission: "core:approvals:read", public: false },
  "GET /v1/core/audit-log": { tag: "core", summary: "List audit-log", permission: "core:audit:read", public: false },
  "GET /v1/core/audit-log/{id}": { tag: "core", summary: "Fetch one audit log", permission: "core:audit:read", public: false },
  "GET /v1/core/consents": { tag: "core", summary: "List consents", permission: "core:consents:read", public: false },
  "POST /v1/core/consents": { tag: "core", summary: "Create a consent", permission: "core:consents:create", public: false },
  "GET /v1/core/consents/{id}": { tag: "core", summary: "Fetch one consent", permission: "core:consents:read", public: false },
  "GET /v1/core/customers": { tag: "core", summary: "List customers", permission: "core:customers:read", public: false },
  "POST /v1/core/customers": { tag: "core", summary: "Create a customer", permission: "core:customers:create", public: false },
  "GET /v1/core/customers/{id}": { tag: "core", summary: "Fetch one customer", permission: "core:customers:read", public: false },
  "PATCH /v1/core/customers/{id}": { tag: "core", summary: "Update a customer", permission: "core:customers:update", public: false },
  "DELETE /v1/core/customers/{id}": { tag: "core", summary: "Soft-delete a customer", permission: "core:customers:delete", public: false },
  "GET /v1/core/customers/{id}/position": { tag: "core", summary: "Financial position: premium, commission and settled claims summed per currency", permission: "core:customers:read", public: false },
  "POST /v1/core/customers/{id}/restore": { tag: "core", summary: "Restore a soft-deleted customer", permission: "core:customers:delete", public: false },
  "GET /v1/core/delegations": { tag: "core", summary: "List delegations", permission: "core:delegations:read", public: false },
  "GET /v1/core/delegations/{id}": { tag: "core", summary: "Fetch one delegation", permission: "core:delegations:read", public: false },
  "GET /v1/core/event-dlq": { tag: "core", summary: "List event-dlq", permission: "admin:dlq:read", public: false },
  "GET /v1/core/event-dlq/{id}": { tag: "core", summary: "Fetch one event dlq", permission: "admin:dlq:read", public: false },
  "GET /v1/core/files": { tag: "core", summary: "List files", permission: "core:files:read", public: false },
  "POST /v1/core/files": { tag: "core", summary: "Create a file", permission: "core:files:create", public: false },
  "GET /v1/core/files/{id}": { tag: "core", summary: "Fetch one file", permission: "core:files:read", public: false },
  "DELETE /v1/core/files/{id}": { tag: "core", summary: "Soft-delete a file", permission: "core:files:delete", public: false },
  "POST /v1/core/files/{id}/restore": { tag: "core", summary: "Restore a soft-deleted file", permission: "core:files:delete", public: false },
  "GET /v1/core/identity-providers": { tag: "core", summary: "List identity-providers", permission: "core:identity_providers:read", public: false },
  "POST /v1/core/identity-providers": { tag: "core", summary: "Create a identity provider", permission: "core:identity_providers:write", public: false },
  "GET /v1/core/identity-providers/{id}": { tag: "core", summary: "Fetch one identity provider", permission: "core:identity_providers:read", public: false },
  "PATCH /v1/core/identity-providers/{id}": { tag: "core", summary: "Update a identity provider", permission: "core:identity_providers:write", public: false },
  "DELETE /v1/core/identity-providers/{id}": { tag: "core", summary: "Soft-delete a identity provider", permission: "core:identity_providers:write", public: false },
  "GET /v1/core/identity-verifications": { tag: "core", summary: "List identity-verifications", permission: "core:customers:read", public: false },
  "GET /v1/core/identity-verifications/{id}": { tag: "core", summary: "Fetch one identity verification", permission: "core:customers:read", public: false },
  "GET /v1/core/lenses": { tag: "core", summary: "List lenses", permission: "core:settings:read", public: false },
  "POST /v1/core/lenses": { tag: "core", summary: "Create a lens", permission: "core:settings:update", public: false },
  "GET /v1/core/lenses/{id}": { tag: "core", summary: "Fetch one lens", permission: "core:settings:read", public: false },
  "PATCH /v1/core/lenses/{id}": { tag: "core", summary: "Update a lens", permission: "core:settings:update", public: false },
  "DELETE /v1/core/lenses/{id}": { tag: "core", summary: "Soft-delete a lens", permission: "core:settings:update", public: false },
  "GET /v1/core/locale-overrides": { tag: "core", summary: "List locale-overrides", permission: "core:locale_overrides:read", public: false },
  "POST /v1/core/locale-overrides": { tag: "core", summary: "Create a locale override", permission: "core:locale_overrides:write", public: false },
  "GET /v1/core/locale-overrides/{id}": { tag: "core", summary: "Fetch one locale override", permission: "core:locale_overrides:read", public: false },
  "PATCH /v1/core/locale-overrides/{id}": { tag: "core", summary: "Update a locale override", permission: "core:locale_overrides:write", public: false },
  "DELETE /v1/core/locale-overrides/{id}": { tag: "core", summary: "Soft-delete a locale override", permission: "core:locale_overrides:write", public: false },
  "GET /v1/core/mandates": { tag: "core", summary: "List mandates", permission: "core:settings:read", public: false },
  "POST /v1/core/mandates": { tag: "core", summary: "Create a mandate", permission: "core:settings:update", public: false },
  "GET /v1/core/mandates/{id}": { tag: "core", summary: "Fetch one mandate", permission: "core:settings:read", public: false },
  "PATCH /v1/core/mandates/{id}": { tag: "core", summary: "Update a mandate", permission: "core:settings:update", public: false },
  "DELETE /v1/core/mandates/{id}": { tag: "core", summary: "Soft-delete a mandate", permission: "core:settings:update", public: false },
  "GET /v1/core/memories": { tag: "core", summary: "List memories", permission: "core:settings:read", public: false },
  "POST /v1/core/memories": { tag: "core", summary: "Create a memory", permission: "core:settings:update", public: false },
  "GET /v1/core/memories/{id}": { tag: "core", summary: "Fetch one memory", permission: "core:settings:read", public: false },
  "PATCH /v1/core/memories/{id}": { tag: "core", summary: "Update a memory", permission: "core:settings:update", public: false },
  "DELETE /v1/core/memories/{id}": { tag: "core", summary: "Soft-delete a memory", permission: "core:settings:update", public: false },
  "GET /v1/core/message-templates": { tag: "core", summary: "List message-templates", permission: "core:templates:read", public: false },
  "POST /v1/core/message-templates": { tag: "core", summary: "Create a message template", permission: "core:templates:write", public: false },
  "GET /v1/core/message-templates/{id}": { tag: "core", summary: "Fetch one message template", permission: "core:templates:read", public: false },
  "PATCH /v1/core/message-templates/{id}": { tag: "core", summary: "Update a message template", permission: "core:templates:write", public: false },
  "DELETE /v1/core/message-templates/{id}": { tag: "core", summary: "Soft-delete a message template", permission: "core:templates:write", public: false },
  "POST /v1/core/message-templates/{id}/restore": { tag: "core", summary: "Restore a soft-deleted message template", permission: "core:templates:write", public: false },
  "GET /v1/core/modules/config": { tag: "core", summary: "Every module's effective configuration — enabled flag, autonomy override, model tier and settings", permission: "core:settings:read", public: false },
  "PATCH /v1/core/modules/{module}/config": { tag: "core", summary: "Update one module's configuration; absent keys fall through to the tenant-wide defaults", permission: "core:settings:update", public: false },
  "GET /v1/core/notifications": { tag: "core", summary: "List notifications", permission: "core:notifications:read", public: false },
  "GET /v1/core/notifications/{id}": { tag: "core", summary: "Fetch one notification", permission: "core:notifications:read", public: false },
  "GET /v1/core/onboarding-steps": { tag: "core", summary: "List onboarding-steps", permission: "core:onboarding:read", public: false },
  "GET /v1/core/onboarding-steps/{id}": { tag: "core", summary: "Fetch one onboarding step", permission: "core:onboarding:read", public: false },
  "GET /v1/core/products": { tag: "core", summary: "List products", permission: "core:products:read", public: false },
  "POST /v1/core/products": { tag: "core", summary: "Create a product", permission: "core:products:write", public: false },
  "GET /v1/core/products/{id}": { tag: "core", summary: "Fetch one product", permission: "core:products:read", public: false },
  "PATCH /v1/core/products/{id}": { tag: "core", summary: "Update a product", permission: "core:products:write", public: false },
  "DELETE /v1/core/products/{id}": { tag: "core", summary: "Soft-delete a product", permission: "core:products:write", public: false },
  "GET /v1/core/providers": { tag: "core", summary: "List providers", permission: "core:providers:read", public: false },
  "POST /v1/core/providers": { tag: "core", summary: "Create a provider", permission: "core:providers:write", public: false },
  "GET /v1/core/providers/{id}": { tag: "core", summary: "Fetch one provider", permission: "core:providers:read", public: false },
  "PATCH /v1/core/providers/{id}": { tag: "core", summary: "Update a provider", permission: "core:providers:write", public: false },
  "DELETE /v1/core/providers/{id}": { tag: "core", summary: "Soft-delete a provider", permission: "core:providers:write", public: false },
  "GET /v1/core/roles": { tag: "core", summary: "List roles", permission: "core:roles:read", public: false },
  "POST /v1/core/roles": { tag: "core", summary: "Create a role", permission: "core:roles:update", public: false },
  "GET /v1/core/roles/{id}": { tag: "core", summary: "Fetch one role", permission: "core:roles:read", public: false },
  "PATCH /v1/core/roles/{id}": { tag: "core", summary: "Update a role", permission: "core:roles:update", public: false },
  "DELETE /v1/core/roles/{id}": { tag: "core", summary: "Soft-delete a role", permission: "core:roles:update", public: false },
  "GET /v1/core/rulepacks": { tag: "core", summary: "List rulepacks", permission: "compliance:rulepacks:read", public: false },
  "POST /v1/core/rulepacks": { tag: "core", summary: "Create a rulepack", permission: "compliance:rulepacks:apply", public: false },
  "GET /v1/core/rulepacks/{id}": { tag: "core", summary: "Fetch one rulepack", permission: "compliance:rulepacks:read", public: false },
  "PATCH /v1/core/rulepacks/{id}": { tag: "core", summary: "Update a rulepack", permission: "compliance:rulepacks:apply", public: false },
  "GET /v1/core/security-posture": { tag: "core", summary: "MFA enrolment and session posture for the tenant's people, against the estate-wide floor", permission: "core:settings:read", public: false },
  "PATCH /v1/core/settings/auto-approve": { tag: "core", summary: "Add or remove approval policy keys from the tenant's auto-approve allowlist; never-auto-approve policies are refused", permission: "core:settings:update", public: false },
  "GET /v1/core/teams": { tag: "core", summary: "List teams", permission: "core:teams:read", public: false },
  "POST /v1/core/teams": { tag: "core", summary: "Create a team", permission: "core:teams:write", public: false },
  "GET /v1/core/teams/{id}": { tag: "core", summary: "Fetch one team", permission: "core:teams:read", public: false },
  "PATCH /v1/core/teams/{id}": { tag: "core", summary: "Update a team", permission: "core:teams:write", public: false },
  "DELETE /v1/core/teams/{id}": { tag: "core", summary: "Soft-delete a team", permission: "core:teams:write", public: false },
  "GET /v1/core/tenants": { tag: "core", summary: "List tenants", permission: "core:tenants:read", public: false },
  "GET /v1/core/tenants/{id}": { tag: "core", summary: "Fetch one tenant", permission: "core:tenants:read", public: false },
  "PATCH /v1/core/tenants/{id}": { tag: "core", summary: "Update a tenant", permission: "core:tenants:update", public: false },
  "GET /v1/core/user-roles": { tag: "core", summary: "List user-roles", permission: "core:roles:read", public: false },
  "POST /v1/core/user-roles": { tag: "core", summary: "Create a user role", permission: "core:roles:assign", public: false },
  "GET /v1/core/user-roles/{id}": { tag: "core", summary: "Fetch one user role", permission: "core:roles:read", public: false },
  "DELETE /v1/core/user-roles/{id}": { tag: "core", summary: "Soft-delete a user role", permission: "core:roles:assign", public: false },
  "GET /v1/core/users": { tag: "core", summary: "List users", permission: "core:users:read", public: false },
  "POST /v1/core/users": { tag: "core", summary: "Create a user", permission: "core:users:create", public: false },
  "GET /v1/core/users/{id}": { tag: "core", summary: "Fetch one user", permission: "core:users:read", public: false },
  "PATCH /v1/core/users/{id}": { tag: "core", summary: "Update a user", permission: "core:users:update", public: false },
  "DELETE /v1/core/users/{id}": { tag: "core", summary: "Soft-delete a user", permission: "core:users:delete", public: false },
  "POST /v1/core/users/{id}/restore": { tag: "core", summary: "Restore a soft-deleted user", permission: "core:users:delete", public: false },
  "GET /v1/core/webhook-deliveries": { tag: "core", summary: "List webhook-deliveries", permission: "core:webhooks:read", public: false },
  "GET /v1/core/webhook-deliveries/{id}": { tag: "core", summary: "Fetch one webhook delivery", permission: "core:webhooks:read", public: false },
  "GET /v1/core/webhooks": { tag: "core", summary: "List webhooks", permission: "core:webhooks:read", public: false },
  "POST /v1/core/webhooks": { tag: "core", summary: "Register a webhook; the signing secret is generated server-side and returned once", permission: "core:webhooks:write", public: false },
  "GET /v1/core/webhooks/{id}": { tag: "core", summary: "Fetch one webhook", permission: "core:webhooks:read", public: false },
  "PATCH /v1/core/webhooks/{id}": { tag: "core", summary: "Update a webhook", permission: "core:webhooks:write", public: false },
  "DELETE /v1/core/webhooks/{id}": { tag: "core", summary: "Soft-delete a webhook", permission: "core:webhooks:write", public: false },
  "POST /v1/core/webhooks/{id}/rotate": { tag: "core", summary: "Rotate a webhook's signing secret to a fresh, server-generated one", permission: "core:webhooks:write", public: false },
  "POST /v1/core/webhooks/{id}/test": { tag: "core", summary: "Send a signed test delivery to a webhook, without a queued event behind it", permission: "core:webhooks:read", public: false },
  "GET /v1/directory": { tag: "search", summary: "List assignable staff and team refs (`?kind=user|team`) for the current tenant", permission: null, public: false },
  "GET /v1/dist/channels": { tag: "dist", summary: "List channels", permission: "dist:channels:read", public: false },
  "POST /v1/dist/channels": { tag: "dist", summary: "Create a channel", permission: "dist:channels:write", public: false },
  "GET /v1/dist/channels/{id}": { tag: "dist", summary: "Fetch one channel", permission: "dist:channels:read", public: false },
  "PATCH /v1/dist/channels/{id}": { tag: "dist", summary: "Update a channel", permission: "dist:channels:write", public: false },
  "DELETE /v1/dist/channels/{id}": { tag: "dist", summary: "Soft-delete a channel", permission: "dist:channels:write", public: false },
  "POST /v1/dist/channels/{id}/restore": { tag: "dist", summary: "Restore a soft-deleted channel", permission: "dist:channels:write", public: false },
  "GET /v1/dist/commission-entries": { tag: "dist", summary: "List commission-entries", permission: "dist:commissions:read", public: false },
  "POST /v1/dist/commission-entries/accrue": { tag: "dist", summary: "Accrue the commission split between the provider, us and the channel", permission: "dist:commissions:adjust", public: false },
  "GET /v1/dist/commission-entries/statement": { tag: "dist", summary: "Commission statement for a channel over a period", permission: "dist:commissions:read", public: false },
  "GET /v1/dist/commission-entries/{id}": { tag: "dist", summary: "Fetch one commission entry", permission: "dist:commissions:read", public: false },
  "POST /v1/dist/commission-entries/{id}/clawback": { tag: "dist", summary: "Claw back an accrued commission after a cancellation", permission: "dist:commissions:adjust", public: false },
  "GET /v1/dist/commission-rates": { tag: "dist", summary: "List commission-rates", permission: "dist:rates:read", public: false },
  "POST /v1/dist/commission-rates": { tag: "dist", summary: "Create a commission rate", permission: "dist:rates:write", public: false },
  "GET /v1/dist/commission-rates/{id}": { tag: "dist", summary: "Fetch one commission rate", permission: "dist:rates:read", public: false },
  "GET /v1/dist/next-best-offers": { tag: "dist", summary: "List next-best-offers", permission: "dist:offers:read", public: false },
  "POST /v1/dist/next-best-offers/propose": { tag: "dist", summary: "Rank cross-sell and upsell offers for a customer", permission: "dist:offers:surface", public: false },
  "GET /v1/dist/next-best-offers/{id}": { tag: "dist", summary: "Fetch one next best offer", permission: "dist:offers:read", public: false },
  "PATCH /v1/dist/next-best-offers/{id}": { tag: "dist", summary: "Update a next best offer", permission: "dist:offers:override", public: false },
  "POST /v1/dist/next-best-offers/{id}/decide": { tag: "dist", summary: "Record the customer's decision on a surfaced offer", permission: "dist:offers:override", public: false },
  "POST /v1/dist/next-best-offers/{id}/surface": { tag: "dist", summary: "Record that an offer was shown, and where", permission: "dist:offers:override", public: false },
  "GET /v1/dist/offerings": { tag: "dist", summary: "List offerings", permission: "dist:offerings:read", public: false },
  "POST /v1/dist/offerings": { tag: "dist", summary: "Create a offering", permission: "dist:offerings:write", public: false },
  "GET /v1/dist/offerings/{id}": { tag: "dist", summary: "Fetch one offering", permission: "dist:offerings:read", public: false },
  "PATCH /v1/dist/offerings/{id}": { tag: "dist", summary: "Update a offering", permission: "dist:offerings:write", public: false },
  "DELETE /v1/dist/offerings/{id}": { tag: "dist", summary: "Soft-delete a offering", permission: "dist:offerings:write", public: false },
  "POST /v1/dist/offerings/{id}/restore": { tag: "dist", summary: "Restore a soft-deleted offering", permission: "dist:offerings:write", public: false },
  "GET /v1/dist/partner-agreements": { tag: "dist", summary: "List partner-agreements", permission: "dist:agreements:read", public: false },
  "GET /v1/dist/partner-agreements/{id}": { tag: "dist", summary: "Fetch one partner agreement", permission: "dist:agreements:read", public: false },
  "GET /v1/dist/quote-requests": { tag: "dist", summary: "List quote-requests", permission: "dist:quote_requests:read", public: false },
  "POST /v1/dist/quote-requests": { tag: "dist", summary: "Create a quote request", permission: "dist:quote_requests:create", public: false },
  "POST /v1/dist/quote-requests/shop": { tag: "dist", summary: "Shop one risk to every eligible offering and collect provider quotes", permission: "dist:quote_requests:create", public: false },
  "GET /v1/dist/quote-requests/{id}": { tag: "dist", summary: "Fetch one quote request", permission: "dist:quote_requests:read", public: false },
  "PATCH /v1/dist/quote-requests/{id}": { tag: "dist", summary: "Update a quote request", permission: "dist:quote_requests:create", public: false },
  "GET /v1/dist/quote-requests/{id}/comparison": { tag: "dist", summary: "Ranked comparison across the responses received", permission: "dist:quote_requests:read", public: false },
  "POST /v1/dist/quote-requests/{id}/select": { tag: "dist", summary: "Record the quote the customer chose", permission: "dist:quote_requests:select", public: false },
  "POST /v1/dist/quote-requests/{id}/share": { tag: "dist", summary: "Share the comparison with the customer over their consented channel", permission: "dist:quote_requests:share", public: false },
  "GET /v1/dist/quote-responses": { tag: "dist", summary: "List quote-responses", permission: "dist:quote_requests:read", public: false },
  "GET /v1/dist/quote-responses/{id}": { tag: "dist", summary: "Fetch one quote respons", permission: "dist:quote_requests:read", public: false },
  "POST /v1/dist/referrals/qualify": { tag: "dist", summary: "Record a qualified referral lead/approval event (REFERRAL-QUAL)", permission: "dist:commissions:adjust", public: false },
  "POST /v1/dist/referrals/settle": { tag: "dist", summary: "Settle a qualified referral's revenue against the partner's statement (REFERRAL-SETL)", permission: "dist:commissions:settle", public: false },
  "GET /v1/ledger/account-balances": { tag: "ledger", summary: "List account-balances", permission: "ledger:accounts:read", public: false },
  "GET /v1/ledger/account-balances/{id}": { tag: "ledger", summary: "Fetch one account balance", permission: "ledger:accounts:read", public: false },
  "GET /v1/ledger/accounts": { tag: "ledger", summary: "List accounts", permission: "ledger:accounts:read", public: false },
  "POST /v1/ledger/accounts": { tag: "ledger", summary: "Create a account", permission: "ledger:accounts:write", public: false },
  "GET /v1/ledger/accounts/{code}/balance": { tag: "ledger", summary: "One account's balance as at a moment", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/accounts/{code}/statement": { tag: "ledger", summary: "Every line that hit one account, in order", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/accounts/{id}": { tag: "ledger", summary: "Fetch one account", permission: "ledger:accounts:read", public: false },
  "PATCH /v1/ledger/accounts/{id}": { tag: "ledger", summary: "Update a account", permission: "ledger:accounts:write", public: false },
  "DELETE /v1/ledger/accounts/{id}": { tag: "ledger", summary: "Soft-delete a account", permission: "ledger:accounts:write", public: false },
  "POST /v1/ledger/balances/rebuild": { tag: "ledger", summary: "Rebuild cached balances from the journal lines", permission: "ledger:journals:post", public: false },
  "GET /v1/ledger/client-money-checks": { tag: "ledger", summary: "List client-money-checks", permission: "ledger:client_money:read", public: false },
  "GET /v1/ledger/client-money-checks/{id}": { tag: "ledger", summary: "Fetch one client money check", permission: "ledger:client_money:read", public: false },
  "GET /v1/ledger/fx-rates": { tag: "ledger", summary: "List fx-rates", permission: "ledger:accounts:read", public: false },
  "POST /v1/ledger/fx-rates": { tag: "ledger", summary: "Create a fx rate", permission: "ledger:accounts:write", public: false },
  "GET /v1/ledger/fx-rates/{id}": { tag: "ledger", summary: "Fetch one fx rate", permission: "ledger:accounts:read", public: false },
  "GET /v1/ledger/invoices": { tag: "ledger", summary: "List invoices", permission: "ledger:invoices:read", public: false },
  "POST /v1/ledger/invoices": { tag: "ledger", summary: "Create a invoice", permission: "ledger:invoices:create", public: false },
  "GET /v1/ledger/invoices/{id}": { tag: "ledger", summary: "Fetch one invoice", permission: "ledger:invoices:read", public: false },
  "PATCH /v1/ledger/invoices/{id}": { tag: "ledger", summary: "Update a invoice", permission: "ledger:invoices:approve", public: false },
  "GET /v1/ledger/journal-batches": { tag: "ledger", summary: "List journal-batches", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/journal-batches/{id}": { tag: "ledger", summary: "Fetch one journal batche", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/journal-lines": { tag: "ledger", summary: "List journal-lines", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/journal-lines/{id}": { tag: "ledger", summary: "Fetch one journal line", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/payment-plans": { tag: "ledger", summary: "List payment-plans", permission: "ledger:payments:read", public: false },
  "GET /v1/ledger/payment-plans/{id}": { tag: "ledger", summary: "Fetch one payment plan", permission: "ledger:payments:read", public: false },
  "GET /v1/ledger/payments": { tag: "ledger", summary: "List payments", permission: "ledger:payments:read", public: false },
  "GET /v1/ledger/payments/{id}": { tag: "ledger", summary: "Fetch one payment", permission: "ledger:payments:read", public: false },
  "GET /v1/ledger/period/{code}": { tag: "ledger", summary: "One accounting period and its close checklist", permission: "ledger:periods:read", public: false },
  "GET /v1/ledger/periods": { tag: "ledger", summary: "List periods", permission: "ledger:periods:read", public: false },
  "POST /v1/ledger/periods/{code}/close": { tag: "ledger", summary: "Soft or hard close a period (dual control)", permission: "ledger:periods:close", public: false },
  "POST /v1/ledger/periods/{code}/reopen": { tag: "ledger", summary: "Reopen a soft-closed period", permission: "ledger:periods:close", public: false },
  "GET /v1/ledger/periods/{id}": { tag: "ledger", summary: "Fetch one period", permission: "ledger:periods:read", public: false },
  "GET /v1/ledger/recon-matches": { tag: "ledger", summary: "List recon-matches", permission: "ledger:recon:read", public: false },
  "GET /v1/ledger/recon-matches/{id}": { tag: "ledger", summary: "Fetch one recon matche", permission: "ledger:recon:read", public: false },
  "PATCH /v1/ledger/recon-matches/{id}": { tag: "ledger", summary: "Update a recon matche", permission: "ledger:recon:confirm", public: false },
  "GET /v1/ledger/recon-runs": { tag: "ledger", summary: "List recon-runs", permission: "ledger:recon:read", public: false },
  "POST /v1/ledger/recon-runs": { tag: "ledger", summary: "Create a recon run", permission: "ledger:recon:run", public: false },
  "GET /v1/ledger/recon-runs/{id}": { tag: "ledger", summary: "Fetch one recon run", permission: "ledger:recon:read", public: false },
  "POST /v1/ledger/recon/matches/{id}/decide": { tag: "ledger", summary: "Confirm or reject a proposed match", permission: "ledger:recon:confirm", public: false },
  "POST /v1/ledger/recon/runs": { tag: "ledger", summary: "Match an imported statement against the ledger", permission: "ledger:recon:run", public: false },
  "GET /v1/ledger/recon/runs/{id}": { tag: "ledger", summary: "One reconciliation run with its matches and exceptions", permission: "ledger:recon:read", public: false },
  "POST /v1/ledger/recon/runs/{id}/evidence-bundle": { tag: "ledger", summary: "Assemble a reconciliation run's evidence as a signed, hash-manifested bundle", permission: "ledger:recon:export", public: false },
  "GET /v1/ledger/recon/runs/{id}/evidence-bundle/download": { tag: "ledger", summary: "Download an assembled recon evidence bundle", permission: "ledger:recon:export", public: false },
  "GET /v1/ledger/reports/aged": { tag: "ledger", summary: "Aged receivables or payables by counterparty", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/balance-sheet": { tag: "ledger", summary: "Balance sheet as at a moment", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/chart-of-accounts": { tag: "ledger", summary: "The chart of accounts with current balances", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/client-money": { tag: "ledger", summary: "Client money sufficiency: what is held against what is owed", permission: "ledger:client_money:read", public: false },
  "GET /v1/ledger/reports/commission": { tag: "ledger", summary: "Commission earned, clawed back and payable by channel", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/pnl": { tag: "ledger", summary: "Profit and loss for a period", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/trial-balance": { tag: "ledger", summary: "Trial balance as at a moment", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/value-flow": { tag: "ledger", summary: "Money Map: premium in, remitted, retained, split and still held for a period", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/value-flow/lines": { tag: "ledger", summary: "The journal lines behind one Money Map node", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/reports/{report}/export": { tag: "ledger", summary: "Render any ledger report to xlsx, pdf, csv or json", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/revenue-schedules": { tag: "ledger", summary: "List revenue-schedules", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/revenue-schedules/{id}": { tag: "ledger", summary: "Fetch one revenue schedule", permission: "ledger:journals:read", public: false },
  "GET /v1/ledger/saga-steps": { tag: "ledger", summary: "List saga-steps", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/saga-steps/{id}": { tag: "ledger", summary: "Fetch one saga step", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/settlements": { tag: "ledger", summary: "List settlements", permission: "dist:commissions:read", public: false },
  "GET /v1/ledger/settlements/{id}": { tag: "ledger", summary: "Fetch one settlement", permission: "dist:commissions:read", public: false },
  "GET /v1/ledger/subscriptions": { tag: "ledger", summary: "List subscriptions", permission: "admin:billing:read", public: false },
  "POST /v1/ledger/subscriptions": { tag: "ledger", summary: "Create a subscription", permission: "admin:billing:write", public: false },
  "GET /v1/ledger/subscriptions/{id}": { tag: "ledger", summary: "Fetch one subscription", permission: "admin:billing:read", public: false },
  "PATCH /v1/ledger/subscriptions/{id}": { tag: "ledger", summary: "Update a subscription", permission: "admin:billing:write", public: false },
  "DELETE /v1/ledger/subscriptions/{id}": { tag: "ledger", summary: "Soft-delete a subscription", permission: "admin:billing:write", public: false },
  "GET /v1/ledger/tax-rules": { tag: "ledger", summary: "List tax-rules", permission: "ledger:accounts:read", public: false },
  "POST /v1/ledger/tax-rules": { tag: "ledger", summary: "Create a tax rule", permission: "ledger:accounts:write", public: false },
  "GET /v1/ledger/tax-rules/{id}": { tag: "ledger", summary: "Fetch one tax rule", permission: "ledger:accounts:read", public: false },
  "PATCH /v1/ledger/tax-rules/{id}": { tag: "ledger", summary: "Update a tax rule", permission: "ledger:accounts:write", public: false },
  "DELETE /v1/ledger/tax-rules/{id}": { tag: "ledger", summary: "Soft-delete a tax rule", permission: "ledger:accounts:write", public: false },
  "GET /v1/ledger/txn-transitions": { tag: "ledger", summary: "List txn-transitions", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/txn-transitions/{id}": { tag: "ledger", summary: "Fetch one txn transition", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/txn-types": { tag: "ledger", summary: "Every transaction type and the states it may move through", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/txn/{id}": { tag: "ledger", summary: "One transaction with its state, transitions and journal batches", permission: "ledger:txns:read", public: false },
  "POST /v1/ledger/txn/{id}/reverse": { tag: "ledger", summary: "Post a compensating reversal, leaving the original intact", permission: "ledger:txns:reverse", public: false },
  "POST /v1/ledger/txn/{id}/transition": { tag: "ledger", summary: "Advance a transaction through its state machine", permission: "ledger:txns:authorize", public: false },
  "POST /v1/ledger/txn/{type}": { tag: "ledger", summary: "Open a transaction of the given type and run its opening postings", permission: "ledger:txns:create", public: false },
  "GET /v1/ledger/txns": { tag: "ledger", summary: "List txns", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/txns/{id}": { tag: "ledger", summary: "Fetch one txn", permission: "ledger:txns:read", public: false },
  "GET /v1/ledger/usage-meters": { tag: "ledger", summary: "List usage-meters", permission: "admin:billing:read", public: false },
  "GET /v1/ledger/usage-meters/{id}": { tag: "ledger", summary: "Fetch one usage meter", permission: "admin:billing:read", public: false },
  "GET /v1/ledger/year-end/{year}": { tag: "ledger", summary: "The entry that would zero income and expense into retained earnings", permission: "ledger:journals:read", public: false },
  "POST /v1/ledger/year-end/{year}": { tag: "ledger", summary: "Post the year-end close (dual control)", permission: "ledger:periods:year_end", public: false },
  "GET /v1/me": { tag: "me", summary: "Bootstrap: actor, tenant, roles, permissions, entitlements, policy and navigation", permission: null, public: false },
  "PATCH /v1/me": { tag: "me", summary: "Update the caller's own profile", permission: null, public: false },
  "POST /v1/me/approvals/{id}/decide": { tag: "me", summary: "Approve or reject a pending approval (permission comes from the approval policy)", permission: null, public: false },
  "GET /v1/me/inbox": { tag: "me", summary: "Notifications and approvals waiting on the caller", permission: null, public: false },
  "GET /v1/me/lens": { tag: "me", summary: "The caller's lens: role default workspace or their own learned adaptation", permission: null, public: false },
  "POST /v1/me/lens/reset": { tag: "me", summary: "Discard learned adaptation and revert to the role default lens", permission: null, public: false },
  "POST /v1/me/lens/usage": { tag: "me", summary: "Record an interaction with a view/filter/pin, nudging its lens weight", permission: null, public: false },
  "POST /v1/me/notifications/{id}/read": { tag: "me", summary: "Mark one of the caller's notifications read", permission: null, public: false },
  "POST /v1/me/password": { tag: "me", summary: "Change the caller's password; other sessions are revoked", permission: null, public: false },
  "GET /v1/me/sessions": { tag: "me", summary: "The caller's active sessions, newest first", permission: null, public: false },
  "DELETE /v1/me/sessions/{id}": { tag: "me", summary: "Revoke one of the caller's sessions", permission: null, public: false },
  "GET /v1/names": { tag: "search", summary: "Resolve up to 200 record refs (`cu_…`, `user:us_…`) to display names, per resource read permission", permission: null, public: false },
  "GET /v1/north/alert_rules": { tag: "north", summary: "List alert_rules", permission: "north:alerts:read", public: false },
  "POST /v1/north/alert_rules": { tag: "north", summary: "Create a alert_rule", permission: "north:alerts:write", public: false },
  "GET /v1/north/alert_rules/{id}": { tag: "north", summary: "Fetch one alert_rule", permission: "north:alerts:read", public: false },
  "PATCH /v1/north/alert_rules/{id}": { tag: "north", summary: "Update a alert_rule", permission: "north:alerts:write", public: false },
  "DELETE /v1/north/alert_rules/{id}": { tag: "north", summary: "Soft-delete a alert_rule", permission: "north:alerts:write", public: false },
  "GET /v1/north/anomalies": { tag: "north", summary: "List anomalies", permission: "north:anomalies:read", public: false },
  "GET /v1/north/anomalies/{id}": { tag: "north", summary: "Fetch one anomaly", permission: "north:anomalies:read", public: false },
  "PATCH /v1/north/anomalies/{id}": { tag: "north", summary: "Update a anomaly", permission: "north:anomalies:assign", public: false },
  "GET /v1/north/boardpacks": { tag: "north", summary: "List boardpacks", permission: "north:boardpacks:read", public: false },
  "POST /v1/north/boardpacks": { tag: "north", summary: "Assemble a board pack PDF from the latest briefing, period metrics and open decisions", permission: "north:boardpacks:generate", public: false },
  "GET /v1/north/boardpacks/{id}": { tag: "north", summary: "Fetch one boardpack", permission: "north:boardpacks:read", public: false },
  "GET /v1/north/boardpacks/{id}/file": { tag: "north", summary: "Download the rendered board pack PDF", permission: "north:boardpacks:read", public: false },
  "GET /v1/north/briefings": { tag: "north", summary: "List briefings", permission: "north:briefings:read", public: false },
  "POST /v1/north/briefings/generate": { tag: "north", summary: "Generate an executive briefing from live metric snapshots, numeric claims verified against the input", permission: "north:briefings:generate", public: false },
  "GET /v1/north/briefings/{id}": { tag: "north", summary: "Fetch one briefing", permission: "north:briefings:read", public: false },
  "PATCH /v1/north/briefings/{id}": { tag: "north", summary: "Update a briefing", permission: "north:briefings:approve", public: false },
  "GET /v1/north/data-health": { tag: "north", summary: "Staleness per metric, computed live from the snapshot table", permission: "north:metrics:read", public: false },
  "GET /v1/north/decisions": { tag: "north", summary: "List decisions", permission: "north:decisions:read", public: false },
  "POST /v1/north/decisions": { tag: "north", summary: "Create a decision", permission: "north:decisions:write", public: false },
  "GET /v1/north/decisions/{id}": { tag: "north", summary: "Fetch one decision", permission: "north:decisions:read", public: false },
  "PATCH /v1/north/decisions/{id}": { tag: "north", summary: "Update a decision", permission: "north:decisions:write", public: false },
  "DELETE /v1/north/decisions/{id}": { tag: "north", summary: "Soft-delete a decision", permission: "north:decisions:write", public: false },
  "POST /v1/north/explore": { tag: "north", summary: "Query north_snapshots by metric keys, grain and period", permission: "north:snapshots:read", public: false },
  "GET /v1/north/forecast": { tag: "north", summary: "Project a metric forward from its closed snapshots — damped Holt, p10/p50/p90, with the fitted parameters", permission: "north:forecasts:read", public: false },
  "GET /v1/north/metrics": { tag: "north", summary: "List metrics", permission: "north:metrics:read", public: false },
  "POST /v1/north/metrics": { tag: "north", summary: "Create a metric", permission: "north:metrics:write", public: false },
  "GET /v1/north/metrics/{id}": { tag: "north", summary: "Fetch one metric", permission: "north:metrics:read", public: false },
  "PATCH /v1/north/metrics/{id}": { tag: "north", summary: "Update a metric", permission: "north:metrics:write", public: false },
  "DELETE /v1/north/metrics/{id}": { tag: "north", summary: "Soft-delete a metric", permission: "north:metrics:write", public: false },
  "GET /v1/north/scenarios": { tag: "north", summary: "List scenarios", permission: "north:scenarios:read", public: false },
  "POST /v1/north/scenarios": { tag: "north", summary: "Create a scenario", permission: "north:scenarios:run", public: false },
  "GET /v1/north/scenarios/{id}": { tag: "north", summary: "Fetch one scenario", permission: "north:scenarios:read", public: false },
  "PATCH /v1/north/scenarios/{id}": { tag: "north", summary: "Update a scenario", permission: "north:scenarios:run", public: false },
  "GET /v1/north/snapshots": { tag: "north", summary: "List snapshots", permission: "north:snapshots:read", public: false },
  "GET /v1/north/snapshots/{id}": { tag: "north", summary: "Fetch one snapshot", permission: "north:snapshots:read", public: false },
  "POST /v1/north/snapshotter/run": { tag: "north", summary: "Force the NORTH metric snapshot and anomaly scan now (also runs on the scheduled tick)", permission: "north:snapshots:run", public: false },
  "POST /v1/onboarding/agreements": { tag: "onboarding", summary: "Draft the next version of a partner agreement", permission: "dist:agreements:write", public: false },
  "POST /v1/onboarding/agreements/{id}/send": { tag: "onboarding", summary: "Send a drafted agreement for signature", permission: "dist:agreements:write", public: false },
  "POST /v1/onboarding/agreements/{id}/sign": { tag: "onboarding", summary: "Countersign an agreement (dual control; supersedes the previous version)", permission: "dist:agreements:write", public: false },
  "POST /v1/onboarding/partners/signup": { tag: "onboarding", summary: "Self-service partner signup: creates a prospect-stage partner and mints a sandbox API key", permission: null, public: true },
  "POST /v1/onboarding/partners/{id}/advance": { tag: "onboarding", summary: "Advance a partner one stage, refused while a step gating it is open", permission: "orbit:partners:update", public: false },
  "POST /v1/onboarding/partners/{id}/resume": { tag: "onboarding", summary: "Resume trading with a suspended partner", permission: "orbit:partners:update", public: false },
  "POST /v1/onboarding/partners/{id}/suspend": { tag: "onboarding", summary: "Stop trading with a partner without unwinding their diligence", permission: "orbit:partners:update", public: false },
  "POST /v1/onboarding/partners/{id}/terminate": { tag: "onboarding", summary: "End a partnership; the record and its agreements stay readable", permission: "orbit:partners:update", public: false },
  "GET /v1/onboarding/steps": { tag: "onboarding", summary: "One subject's checklist and which steps are blocking a given stage", permission: "core:onboarding:read", public: false },
  "POST /v1/onboarding/steps": { tag: "onboarding", summary: "Generate an onboarding checklist from a template for a partner, channel or member of staff", permission: "core:onboarding:write", public: false },
  "POST /v1/onboarding/steps/{id}/complete": { tag: "onboarding", summary: "Clear a step, attaching the evidence its kind requires", permission: "core:onboarding:write", public: false },
  "POST /v1/onboarding/steps/{id}/fail": { tag: "onboarding", summary: "Record that a step came back negative, with the reason", permission: "core:onboarding:write", public: false },
  "POST /v1/onboarding/steps/{id}/waive": { tag: "onboarding", summary: "Waive a required step (dual control; the waiver is recorded against it)", permission: "core:onboarding:waive", public: false },
  "GET /v1/orbit/agent-presence": { tag: "orbit", summary: "List agent-presence", permission: "orbit:presence:read", public: false },
  "POST /v1/orbit/agent-presence": { tag: "orbit", summary: "Create a agent presence", permission: "orbit:presence:write", public: false },
  "GET /v1/orbit/agent-presence/{id}": { tag: "orbit", summary: "Fetch one agent presence", permission: "orbit:presence:read", public: false },
  "PATCH /v1/orbit/agent-presence/{id}": { tag: "orbit", summary: "Update a agent presence", permission: "orbit:presence:write", public: false },
  "GET /v1/orbit/channel-connectors": { tag: "orbit", summary: "List channel-connectors", permission: "orbit:channels:read", public: false },
  "POST /v1/orbit/channel-connectors": { tag: "orbit", summary: "Create a channel connector", permission: "orbit:channels:write", public: false },
  "GET /v1/orbit/channel-connectors/{id}": { tag: "orbit", summary: "Fetch one channel connector", permission: "orbit:channels:read", public: false },
  "PATCH /v1/orbit/channel-connectors/{id}": { tag: "orbit", summary: "Update a channel connector", permission: "orbit:channels:write", public: false },
  "DELETE /v1/orbit/channel-connectors/{id}": { tag: "orbit", summary: "Soft-delete a channel connector", permission: "orbit:channels:write", public: false },
  "GET /v1/orbit/conversations": { tag: "orbit", summary: "List conversations", permission: "orbit:conversations:read", public: false },
  "POST /v1/orbit/conversations": { tag: "orbit", summary: "Create a conversation", permission: "orbit:conversations:reply", public: false },
  "GET /v1/orbit/conversations/{id}": { tag: "orbit", summary: "Fetch one conversation", permission: "orbit:conversations:read", public: false },
  "PATCH /v1/orbit/conversations/{id}": { tag: "orbit", summary: "Update a conversation", permission: "orbit:conversations:assign", public: false },
  "POST /v1/orbit/conversations/{id}/reply": { tag: "orbit", summary: "Send a reply out over the conversation's channel connector", permission: "orbit:messages:send", public: false },
  "POST /v1/orbit/conversations/{id}/turns": { tag: "orbit", summary: "Append a turn to a conversation, checkpointed to orbit_messages", permission: "orbit:messages:send", public: false },
  "POST /v1/orbit/drafts/sweep": { tag: "orbit", summary: "Force the AI reply-draft sweep now — drafts a pending agent_ai reply for every conversation waiting on us (also runs on the scheduled tick)", permission: "orbit:ai:invoke", public: false },
  "GET /v1/orbit/handover-notes": { tag: "orbit", summary: "List handover-notes", permission: "orbit:handover:read", public: false },
  "POST /v1/orbit/handover-notes": { tag: "orbit", summary: "Create a handover note", permission: "orbit:handover:write", public: false },
  "GET /v1/orbit/handover-notes/{id}": { tag: "orbit", summary: "Fetch one handover note", permission: "orbit:handover:read", public: false },
  "PATCH /v1/orbit/handover-notes/{id}": { tag: "orbit", summary: "Update a handover note", permission: "orbit:handover:write", public: false },
  "DELETE /v1/orbit/handover-notes/{id}": { tag: "orbit", summary: "Soft-delete a handover note", permission: "orbit:handover:write", public: false },
  "GET /v1/orbit/journey-runs": { tag: "orbit", summary: "List journey-runs", permission: "orbit:journeys:read", public: false },
  "GET /v1/orbit/journey-runs/{id}": { tag: "orbit", summary: "Fetch one journey run", permission: "orbit:journeys:read", public: false },
  "GET /v1/orbit/journeys": { tag: "orbit", summary: "List journeys", permission: "orbit:journeys:read", public: false },
  "POST /v1/orbit/journeys": { tag: "orbit", summary: "Create a journey", permission: "orbit:journeys:write", public: false },
  "GET /v1/orbit/journeys/{id}": { tag: "orbit", summary: "Fetch one journey", permission: "orbit:journeys:read", public: false },
  "PATCH /v1/orbit/journeys/{id}": { tag: "orbit", summary: "Update a journey", permission: "orbit:journeys:write", public: false },
  "DELETE /v1/orbit/journeys/{id}": { tag: "orbit", summary: "Soft-delete a journey", permission: "orbit:journeys:write", public: false },
  "GET /v1/orbit/messages": { tag: "orbit", summary: "List messages", permission: "orbit:messages:read", public: false },
  "POST /v1/orbit/messages": { tag: "orbit", summary: "Create a message", permission: "orbit:messages:send", public: false },
  "GET /v1/orbit/messages/{id}": { tag: "orbit", summary: "Fetch one message", permission: "orbit:messages:read", public: false },
  "GET /v1/orbit/partner-txns": { tag: "orbit", summary: "List partner-txns", permission: "orbit:partners:read", public: false },
  "GET /v1/orbit/partner-txns/{id}": { tag: "orbit", summary: "Fetch one partner txn", permission: "orbit:partners:read", public: false },
  "GET /v1/orbit/partners": { tag: "orbit", summary: "List partners", permission: "orbit:partners:read", public: false },
  "POST /v1/orbit/partners": { tag: "orbit", summary: "Create a partner", permission: "orbit:partners:create", public: false },
  "GET /v1/orbit/partners/{id}": { tag: "orbit", summary: "Fetch one partner", permission: "orbit:partners:read", public: false },
  "POST /v1/orbit/partners/{id}/quotes": { tag: "orbit", summary: "Request a partner pricing quote (sandbox partners get clearly-marked synthetic pricing)", permission: "orbit:partners:read", public: false },
  "GET /v1/orbit/portal-links/{kind}/{id}": { tag: "orbit", summary: "The tenant-branded public link for a renewal (one-tap accept) or a closed conversation (CSAT)", permission: "orbit:renewals:read", public: false },
  "GET /v1/orbit/qa-scores": { tag: "orbit", summary: "List qa-scores", permission: "orbit:qa:read", public: false },
  "POST /v1/orbit/qa-scores": { tag: "orbit", summary: "Create a qa score", permission: "orbit:qa:score", public: false },
  "GET /v1/orbit/qa-scores/{id}": { tag: "orbit", summary: "Fetch one qa score", permission: "orbit:qa:read", public: false },
  "GET /v1/orbit/renewals": { tag: "orbit", summary: "List renewals", permission: "orbit:renewals:read", public: false },
  "POST /v1/orbit/renewals/sweep": { tag: "orbit", summary: "Force the renewal sweep now (also runs on the scheduled tick)", permission: "orbit:renewals:update", public: false },
  "GET /v1/orbit/renewals/{id}": { tag: "orbit", summary: "Fetch one renewal", permission: "orbit:renewals:read", public: false },
  "PATCH /v1/orbit/renewals/{id}": { tag: "orbit", summary: "Update a renewal", permission: "orbit:renewals:update", public: false },
  "GET /v1/orbit/routing-rules": { tag: "orbit", summary: "List routing-rules", permission: "orbit:teams:read", public: false },
  "POST /v1/orbit/routing-rules": { tag: "orbit", summary: "Create a routing rule", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/routing-rules/{id}": { tag: "orbit", summary: "Fetch one routing rule", permission: "orbit:teams:read", public: false },
  "PATCH /v1/orbit/routing-rules/{id}": { tag: "orbit", summary: "Update a routing rule", permission: "orbit:teams:write", public: false },
  "DELETE /v1/orbit/routing-rules/{id}": { tag: "orbit", summary: "Soft-delete a routing rule", permission: "orbit:teams:write", public: false },
  "POST /v1/orbit/routing/sweep": { tag: "orbit", summary: "Force the routing sweep now — SLA breach escalation and absence reassignment (also runs on the scheduled tick)", permission: "orbit:conversations:assign", public: false },
  "GET /v1/orbit/sla-policies": { tag: "orbit", summary: "List sla-policies", permission: "orbit:teams:read", public: false },
  "POST /v1/orbit/sla-policies": { tag: "orbit", summary: "Create a sla policy", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/sla-policies/{id}": { tag: "orbit", summary: "Fetch one sla policy", permission: "orbit:teams:read", public: false },
  "PATCH /v1/orbit/sla-policies/{id}": { tag: "orbit", summary: "Update a sla policy", permission: "orbit:teams:write", public: false },
  "DELETE /v1/orbit/sla-policies/{id}": { tag: "orbit", summary: "Soft-delete a sla policy", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/team-members": { tag: "orbit", summary: "List team-members", permission: "orbit:teams:read", public: false },
  "POST /v1/orbit/team-members": { tag: "orbit", summary: "Create a team member", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/team-members/{id}": { tag: "orbit", summary: "Fetch one team member", permission: "orbit:teams:read", public: false },
  "PATCH /v1/orbit/team-members/{id}": { tag: "orbit", summary: "Update a team member", permission: "orbit:teams:write", public: false },
  "DELETE /v1/orbit/team-members/{id}": { tag: "orbit", summary: "Soft-delete a team member", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/teams": { tag: "orbit", summary: "List teams", permission: "orbit:teams:read", public: false },
  "POST /v1/orbit/teams": { tag: "orbit", summary: "Create a team", permission: "orbit:teams:write", public: false },
  "GET /v1/orbit/teams/{id}": { tag: "orbit", summary: "Fetch one team", permission: "orbit:teams:read", public: false },
  "PATCH /v1/orbit/teams/{id}": { tag: "orbit", summary: "Update a team", permission: "orbit:teams:write", public: false },
  "DELETE /v1/orbit/teams/{id}": { tag: "orbit", summary: "Soft-delete a team", permission: "orbit:teams:write", public: false },
  "POST /v1/platform/ai/kill": { tag: "platform", summary: "Throw the global AI kill switch — one click, no approval (docs/12 §4)", permission: "admin:flags:write", public: false },
  "POST /v1/platform/ai/release": { tag: "platform", summary: "Release the global AI kill switch (gates on the core.flag_toggle approval)", permission: "admin:flags:write", public: false },
  "GET /v1/platform/deployments": { tag: "platform", summary: "Deployment history, newest first", permission: "admin:diagnostics:read", public: false },
  "GET /v1/platform/flags": { tag: "platform", summary: "Every feature flag and its rollout", permission: "admin:flags:read", public: false },
  "POST /v1/platform/flags": { tag: "platform", summary: "Create a feature flag, disabled by default", permission: "admin:flags:write", public: false },
  "PATCH /v1/platform/flags/{id}": { tag: "platform", summary: "Update a flag's rollout or enable it (enabling gates on the core.flag_toggle approval)", permission: "admin:flags:write", public: false },
  "GET /v1/platform/impersonation": { tag: "platform", summary: "The caller's own live impersonation sessions", permission: "core:impersonate:use", public: false },
  "POST /v1/platform/impersonation/start": { tag: "platform", summary: "Start impersonating a user (dual control; never auto-approved)", permission: "core:impersonate:use", public: false },
  "POST /v1/platform/impersonation/{id}/end": { tag: "platform", summary: "End one of the caller's own impersonation sessions", permission: "core:impersonate:use", public: false },
  "GET /v1/platform/incidents": { tag: "platform", summary: "Outage incidents across every tenant, newest first", permission: "admin:diagnostics:read", public: false },
  "GET /v1/platform/ops/overview": { tag: "platform", summary: "Outbox backlog, DLQ depth and pending approvals, per tenant", permission: "admin:diagnostics:read", public: false },
  "GET /v1/platform/slo": { tag: "platform", summary: "Every SLO definition with its actual and burn percent over its window", permission: "admin:diagnostics:read", public: false },
  "GET /v1/portal/{tenantSlug}/feedback/{id}": { tag: "portal", summary: "Whether a closed conversation can still be rated, and its rating if already given", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/feedback/{id}": { tag: "portal", summary: "Submit the CSAT rating (1-5) for a closed conversation; one rating per conversation", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/leads": { tag: "portal", summary: "Submit a quote lead from the public storefront; rate-limited per email", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/privacy-requests": { tag: "portal", summary: "Data subject lodges an access/erasure/rectification request (J-C4); recorded unverified, staff verify before fulfilment", permission: null, public: true },
  "GET /v1/portal/{tenantSlug}/quote-requests/{id}": { tag: "portal", summary: "Re-open a self-serve comparison with the one-time token", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/accept": { tag: "portal", summary: "Customer accepts a quoted offer; converts the request, does not bind cover", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/documents": { tag: "portal", summary: "Upload a supporting document against a self-serve quote (multipart)", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/quote-requests/{id}/reprice": { tag: "portal", summary: "Indicative re-price of the same panel with moved rating criteria; persists nothing and binds nothing", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/registrations": { tag: "portal", summary: "Self-registration from the public storefront (person or business); records a pending customer, grants no access", permission: null, public: true },
  "GET /v1/portal/{tenantSlug}/renewals/{id}": { tag: "portal", summary: "Open a renewal offer with its link token (reference, expiry and state only)", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/renewals/{id}/accept": { tag: "portal", summary: "Customer accepts a renewal in one tap; records the decision, does not bind or charge", permission: null, public: true },
  "GET /v1/portal/{tenantSlug}/site": { tag: "portal", summary: "A tenant's public storefront: brand and active products", permission: null, public: true },
  "POST /v1/portal/{tenantSlug}/track": { tag: "portal", summary: "Record an acquisition touch (impression, click or visit) from the public tracking pixel; rate-limited per IP", permission: null, public: true },
  "GET /v1/realtime": { tag: "realtime", summary: "Server-Sent Events stream of the caller's own live updates", permission: null, public: false },
  "GET /v1/scout/clusters": { tag: "scout", summary: "List clusters", permission: "scout:clusters:read", public: false },
  "GET /v1/scout/clusters/{id}": { tag: "scout", summary: "Fetch one cluster", permission: "scout:clusters:read", public: false },
  "GET /v1/scout/data-products": { tag: "scout", summary: "List data-products", permission: "scout:data_products:read", public: false },
  "POST /v1/scout/data-products": { tag: "scout", summary: "Create a data product", permission: "scout:data_products:create", public: false },
  "GET /v1/scout/data-products/{id}": { tag: "scout", summary: "Fetch one data product", permission: "scout:data_products:read", public: false },
  "PATCH /v1/scout/data-products/{id}": { tag: "scout", summary: "Update a data product", permission: "scout:data_products:publish", public: false },
  "GET /v1/scout/panel-bench": { tag: "scout", summary: "List panel-bench", permission: "scout:panel_bench:read", public: false },
  "GET /v1/scout/panel-bench/negotiation-pack": { tag: "scout", summary: "Bench + whitespace negotiation pack as a downloadable PDF", permission: "scout:whitespaces:promote", public: false },
  "GET /v1/scout/panel-bench/{id}": { tag: "scout", summary: "Fetch one panel bench", permission: "scout:panel_bench:read", public: false },
  "GET /v1/scout/scout-experiments": { tag: "scout", summary: "List scout-experiments", permission: "scout:experiments:read", public: false },
  "POST /v1/scout/scout-experiments": { tag: "scout", summary: "Create a scout experiment", permission: "scout:experiments:create", public: false },
  "GET /v1/scout/scout-experiments/{id}": { tag: "scout", summary: "Fetch one scout experiment", permission: "scout:experiments:read", public: false },
  "PATCH /v1/scout/scout-experiments/{id}": { tag: "scout", summary: "Update a scout experiment", permission: "scout:experiments:decide", public: false },
  "GET /v1/scout/signals": { tag: "scout", summary: "List signals", permission: "scout:signals:read", public: false },
  "POST /v1/scout/signals": { tag: "scout", summary: "Create a signal", permission: "scout:signals:ingest", public: false },
  "POST /v1/scout/signals/similar": { tag: "scout", summary: "Nearest signals to a phrase, from the market embedding index", permission: "scout:signals:read", public: false },
  "GET /v1/scout/signals/{id}": { tag: "scout", summary: "Fetch one signal", permission: "scout:signals:read", public: false },
  "GET /v1/scout/whitespaces": { tag: "scout", summary: "List whitespaces", permission: "scout:whitespaces:read", public: false },
  "GET /v1/scout/whitespaces/commentary": { tag: "scout", summary: "Why each live whitespace is whitespace: the cached one-line commentary plus the evidence it was grounded against, for every candidate at once (the Radar's hover prefetch)", permission: "scout:whitespaces:read", public: false },
  "POST /v1/scout/whitespaces/compute": { tag: "scout", summary: "Run the whitespace sweep now against real quote demand vs. policy coverage", permission: "scout:whitespaces:promote", public: false },
  "GET /v1/scout/whitespaces/{id}": { tag: "scout", summary: "Fetch one whitespace", permission: "scout:whitespaces:read", public: false },
  "PATCH /v1/scout/whitespaces/{id}": { tag: "scout", summary: "Update a whitespace", permission: "scout:whitespaces:promote", public: false },
  "GET /v1/scout/whitespaces/{id}/commentary": { tag: "scout", summary: "One candidate's commentary, evidence and AI provenance", permission: "scout:whitespaces:read", public: false },
  "POST /v1/scout/whitespaces/{id}/promote-to-signal": { tag: "scout", summary: "Promote a whitespace into a draft SIGNAL campaign with AI-drafted brief and creative variants (approval-gated, idempotent, nothing sent)", permission: "scout:whitespaces:promote", public: false },
  "POST /v1/scout/wording-diff": { tag: "scout", summary: "Word-level diff of two coverage-wording texts (PDF extraction deferred, see ADR-0016)", permission: "scout:panel_bench:read", public: false },
  "GET /v1/search": { tag: "search", summary: "Search across every resource the caller may read", permission: "core:search:read", public: false },
  "POST /v1/settlement/runs": { tag: "settlement", summary: "Draft a counterparty's commission settlement for a period (arithmetic only, nothing posts)", permission: "dist:commissions:settle", public: false },
  "GET /v1/settlement/settlements/{id}": { tag: "settlement", summary: "One settlement with its totals and state", permission: "dist:commissions:read", public: false },
  "POST /v1/settlement/settlements/{id}/approve": { tag: "settlement", summary: "Approve the number and accrue it (dual control; the runner may not self-approve)", permission: "dist:commissions:settle", public: false },
  "POST /v1/settlement/settlements/{id}/dispute": { tag: "settlement", summary: "Mark a settlement disputed with the counterparty's reason", permission: "dist:commissions:settle", public: false },
  "GET /v1/settlement/settlements/{id}/lines": { tag: "settlement", summary: "The entries behind the total, with the agreement terms applied", permission: "dist:commissions:read", public: false },
  "POST /v1/settlement/settlements/{id}/pay": { tag: "settlement", summary: "Release the payout and post it, with the bank/PSP reference that proves it (a second signature, held by a controller)", permission: "ledger:payouts:approve", public: false },
  "POST /v1/settlement/settlements/{id}/reopen": { tag: "settlement", summary: "Reopen a disputed settlement so the period can be restated", permission: "dist:commissions:settle", public: false },
  "GET /v1/settlement/settlements/{id}/statement": { tag: "settlement", summary: "Remittance advice as pdf, xlsx, csv or json", permission: "dist:commissions:read", public: false },
  "GET /v1/signal/aeo-pages": { tag: "signal", summary: "List aeo-pages", permission: "signal:aeo:read", public: false },
  "POST /v1/signal/aeo-pages": { tag: "signal", summary: "Create a aeo page", permission: "signal:aeo:write", public: false },
  "GET /v1/signal/aeo-pages/{id}": { tag: "signal", summary: "Fetch one aeo page", permission: "signal:aeo:read", public: false },
  "PATCH /v1/signal/aeo-pages/{id}": { tag: "signal", summary: "Update a aeo page", permission: "signal:aeo:write", public: false },
  "DELETE /v1/signal/aeo-pages/{id}": { tag: "signal", summary: "Soft-delete a aeo page", permission: "signal:aeo:write", public: false },
  "GET /v1/signal/attribution-events": { tag: "signal", summary: "List attribution-events", permission: "signal:attribution:read", public: false },
  "GET /v1/signal/attribution-events/{id}": { tag: "signal", summary: "Fetch one attribution event", permission: "signal:attribution:read", public: false },
  "GET /v1/signal/attribution/funnel": { tag: "signal", summary: "The acquisition funnel aggregated per campaign and channel for a window — impressions, clicks, visits, leads, binds and value", permission: "signal:attribution:read", public: false },
  "GET /v1/signal/audiences": { tag: "signal", summary: "List audiences", permission: "signal:audiences:read", public: false },
  "POST /v1/signal/audiences": { tag: "signal", summary: "Create a audience", permission: "signal:audiences:create", public: false },
  "POST /v1/signal/audiences/suggest": { tag: "signal", summary: "Propose a targetable audience for a subject from k-anonymous attribute counts, with the reason each band was chosen (docs/17 §SIG-025; protected attributes excluded per §SIG-034)", permission: "signal:audiences:estimate", public: false },
  "GET /v1/signal/audiences/{id}": { tag: "signal", summary: "Fetch one audience", permission: "signal:audiences:read", public: false },
  "PATCH /v1/signal/audiences/{id}": { tag: "signal", summary: "Update a audience", permission: "signal:audiences:create", public: false },
  "POST /v1/signal/autopilot/pause": { tag: "signal", summary: "Pause the budget autopilot kill switch", permission: "signal:autopilot:pause", public: false },
  "POST /v1/signal/autopilot/resume": { tag: "signal", summary: "Resume the budget autopilot", permission: "signal:autopilot:pause", public: false },
  "POST /v1/signal/autopilot/run": { tag: "signal", summary: "Force the SIGNAL budget autopilot pass now", permission: "signal:autopilot:run", public: false },
  "GET /v1/signal/budget-moves": { tag: "signal", summary: "List budget-moves", permission: "signal:budget_moves:read", public: false },
  "GET /v1/signal/budget-moves/{id}": { tag: "signal", summary: "Fetch one budget move", permission: "signal:budget_moves:read", public: false },
  "PATCH /v1/signal/budget-moves/{id}": { tag: "signal", summary: "Update a budget move", permission: "signal:budget_moves:approve", public: false },
  "GET /v1/signal/campaigns": { tag: "signal", summary: "List campaigns", permission: "signal:campaigns:read", public: false },
  "POST /v1/signal/campaigns": { tag: "signal", summary: "Create a campaign", permission: "signal:campaigns:create", public: false },
  "GET /v1/signal/campaigns/{id}": { tag: "signal", summary: "Fetch one campaign", permission: "signal:campaigns:read", public: false },
  "PATCH /v1/signal/campaigns/{id}": { tag: "signal", summary: "Update a campaign", permission: "signal:campaigns:update", public: false },
  "POST /v1/signal/campaigns/{id}/plan": { tag: "signal", summary: "Plan a campaign in three ranked options, each with a probability of success and the reasons behind it, suggesting and linking a targeting pool when the campaign has none", permission: "signal:campaigns:update", public: false },
  "GET /v1/signal/creatives": { tag: "signal", summary: "List creatives", permission: "signal:creatives:read", public: false },
  "POST /v1/signal/creatives": { tag: "signal", summary: "Create a creative", permission: "signal:creatives:generate", public: false },
  "POST /v1/signal/creatives/generate": { tag: "signal", summary: "Generate ad-copy variants from a brief, compliance-checked and audited per locale", permission: "signal:creatives:generate", public: false },
  "POST /v1/signal/creatives/image": { tag: "signal", summary: "Generate a hero/post image from a prompt (ADR-0060); stores bytes to R2 and returns a data URL for immediate preview", permission: "signal:creatives:generate", public: false },
  "GET /v1/signal/creatives/{id}": { tag: "signal", summary: "Fetch one creative", permission: "signal:creatives:read", public: false },
  "PATCH /v1/signal/creatives/{id}": { tag: "signal", summary: "Update a creative", permission: "signal:creatives:approve", public: false },
  "GET /v1/signal/creatives/{id}/image": { tag: "signal", summary: "Re-stream a previously generated creative image's bytes", permission: "signal:creatives:read", public: false },
  "POST /v1/signal/demo/spend-tick": { tag: "signal", summary: "Insert a spend row per channel per live campaign, keyed off the simulated clock (non-production only)", permission: "signal:autopilot:run", public: false },
  "GET /v1/signal/outreach": { tag: "signal", summary: "List outreach", permission: "signal:outreach:read", public: false },
  "POST /v1/signal/outreach/run": { tag: "signal", summary: "Run the acquisition outreach sweep now — draft, consent-gate, approval-gate, send, and record the lead touch (also runs on the nightly tick)", permission: "signal:outreach:send", public: false },
  "GET /v1/signal/outreach/{id}": { tag: "signal", summary: "Fetch one outreach", permission: "signal:outreach:read", public: false },
  "GET /v1/signal/signal-experiments": { tag: "signal", summary: "List signal-experiments", permission: "signal:experiments:read", public: false },
  "POST /v1/signal/signal-experiments": { tag: "signal", summary: "Create a signal experiment", permission: "signal:experiments:create", public: false },
  "GET /v1/signal/signal-experiments/{id}": { tag: "signal", summary: "Fetch one signal experiment", permission: "signal:experiments:read", public: false },
  "PATCH /v1/signal/signal-experiments/{id}": { tag: "signal", summary: "Update a signal experiment", permission: "signal:experiments:decide", public: false },
  "GET /v1/signal/spend": { tag: "signal", summary: "List spend", permission: "signal:spend:read", public: false },
  "GET /v1/signal/spend/{id}": { tag: "signal", summary: "Fetch one spend", permission: "signal:spend:read", public: false },
  "GET /v1/staff/delegations": { tag: "staff", summary: "Who currently holds whose authority", permission: "core:delegations:read", public: false },
  "POST /v1/staff/delegations": { tag: "staff", summary: "Delegate the authority to approve for a window (itself approved)", permission: "core:delegations:write", public: false },
  "POST /v1/staff/delegations/expire": { tag: "staff", summary: "Sweep delegations whose window has closed (also runs on the scheduled tick)", permission: "core:delegations:write", public: false },
  "POST /v1/staff/delegations/{id}/revoke": { tag: "staff", summary: "Revoke a delegation; handing your own authority back needs no administrator", permission: "core:delegations:write", public: false },
  "POST /v1/staff/invitations": { tag: "staff", summary: "Create a staff account with its roles, teams and joiner checklist", permission: "core:users:create", public: false },
  "GET /v1/staff/users": { tag: "staff", summary: "People picker for assignment surfaces: id and display name only", permission: "core:users:read", public: false },
  "POST /v1/staff/users/{id}/offboard": { tag: "staff", summary: "Revoke every credential and reassign every open item to a named owner", permission: "core:users:update", public: false },
  "POST /v1/staff/users/{id}/onboarding": { tag: "staff", summary: "Re-run the joiner checklist for an account that already exists", permission: "core:onboarding:write", public: false },
  "POST /v1/staff/users/{id}/roles": { tag: "staff", summary: "Add or remove roles; never grants what the caller lacks", permission: "core:roles:assign", public: false },
};
