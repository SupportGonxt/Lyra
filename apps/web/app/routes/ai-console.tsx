import * as React from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AGENT_MARK,
  Badge,
  BudgetMeter,
  Button,
  Card,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  EvidenceLink,
  GuardrailNotice,
  Money,
  Ref,
  Select,
  shortRef,
  Table,
  Textarea,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { ApiError, api, names } from "../api.server";
import { who, type Names } from "../names";
import { cloudflare } from "../context";
import { moduleName, pseudoText, translator } from "../i18n";
import { humanise, optionLabel } from "../modules/spec";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// The operator's view of the AI running inside the platform: which agents exist,
// what each one is allowed to do without asking, what they spent, how the last
// runs went, which guardrails fired and what the audit spine recorded.
//
// Everything here is read from apps/api/src/routes/ai.ts and the generated CRUD
// in apps/api/src/resources.ts. Two things are deliberately absent: the system
// prompt body (ai_prompts.body — the console shows the prompt_ref key and never
// loads the text behind it) and anything resembling a provider credential (the
// gateway holds those as worker secrets; no endpoint on this screen returns one).

/* --------------------------------------------------------------- constants */

/**
 * The exact enum `POST /v1/ai/agents/:key/autonomy` accepts, ascending by how
 * much the agent may do without asking. Offering a fifth option would be a 400
 * the operator cannot act on, so this list is copied, never invented.
 */
const AUTONOMY_LEVELS = ["suggest", "act_with_approval", "act_within_limits", "autonomous"] as const;
type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * Spellings written before the ladder was declared (packages/db json.ts
 * AGENT_AUTONOMY). Nine of the ten seeded agents carry `suggest_only`, which
 * is on no ladder anywhere: the badge printed the raw key and the picker below
 * it opened with nothing selected, because the stored value matched none of
 * its options. Unknown reads as the most cautious rung, never the freest.
 */
const AUTONOMY_SYNONYMS: Record<string, AutonomyLevel> = {
  suggest_only: "suggest",
  observe_only: "suggest",
  draft: "suggest",
  act: "act_within_limits",
  act_and_report: "act_within_limits",
  act_and_notify: "act_within_limits",
  act_autonomously: "autonomous"
};

/** A stored autonomy value as a rung of the ladder. */
export const autonomyRung = (level: string): AutonomyLevel =>
  AUTONOMY_LEVELS.includes(level as AutonomyLevel)
    ? (level as AutonomyLevel)
    : (AUTONOMY_SYNONYMS[level] ?? "suggest");

const rankOf = (level: string): number => AUTONOMY_LEVELS.indexOf(autonomyRung(level));

/** A level nobody recognises ranks lowest, so any change off it asks first. */
const raises = (from: string, to: string): boolean => rankOf(to) > rankOf(from);

/**
 * cost_micro is micro-USD (packages/model-gateway/src/models.ts), and money is
 * never a bare float: it converts to minor units for <Money>. Rounded up like
 * the gateway's own costing, so a call that really cost something never renders
 * as free.
 */
const COST_CURRENCY = "USD";
const minorOf = (costMicro: number): number => Math.ceil(costMicro / 10_000);

const SPEND_DAYS = 30; // matches the "last 30 days" label below
const RUN_LIMIT = 25;
const EVENT_LIMIT = 25;
const AUDIT_LIMIT = 50;

/* ------------------------------------------------------------------ labels */

// This screen owns its vocabulary rather than adding to the shared catalogue:
// apps/web/app/i18n/en.ts and ar.ts belong to the shell. `common.*` is reused
// through translator(locale); everything AI-specific lives here.
const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "AI console",
    intro: "What the agents are doing, what it costs, and what they were allowed to do.",
    "budget.title": "Budget",
    "budget.today": "Today",
    "budget.tokens": "Tokens",
    "budget.cost": "Cost",
    "budget.over.title": "Over budget",
    "budget.over.tokens": "The daily token limit is spent. Agent runs are refused until the window resets or the cap is raised.",
    "budget.over.cost": "The daily cost limit is spent. Agent runs are refused until the window resets or the cap is raised.",
    "budget.over.stopped": "This budget was stopped by an administrator.",
    "budget.near.title": "Approaching the budget cap",
    "budget.near.reason": "Used so far today:",
    "budget.unavailable": "You do not have access to budget figures.",
    "spend.title": "Spend by module and purpose",
    "spend.window": "Last 30 days",
    "spend.module": "Module",
    "spend.purpose": "Purpose",
    "spend.calls": "Calls",
    "spend.tokens": "Tokens",
    "spend.cost": "Cost",
    "spend.errors": "Errors",
    "spend.total": "Total",
    "kill.title": "Kill switches",
    "kill.intro": "Stop model calls for this tenant or for one module. Every switch is recorded against your name.",
    "kill.global": "Platform-wide",
    "kill.globalOn": "Platform operations has paused AI. Nothing here will release it.",
    "kill.globalOff": "No platform-wide pause.",
    "kill.tenant": "This tenant",
    "kill.tenantOn": "AI is paused for the whole tenant. Every model call is refused.",
    "kill.tenantOff": "Running.",
    "kill.modules": "Paused modules",
    "kill.none": "None",
    "kill.pauseTenant": "Pause all AI",
    "kill.resumeTenant": "Resume AI",
    "kill.pauseModule": "Pause module",
    "kill.resumeModule": "Resume",
    "kill.module": "Module",
    "kill.reason": "Reason",
    "kill.noControls": "Your roles do not include the AI kill switch.",
    "kill.unavailable": "You do not have access to the AI kill switches.",
    "agents.title": "Agents",
    "agents.module": "Module",
    "agents.tier": "Tier",
    // ai_agents.tier picks how much model an agent gets. The cards printed the
    // stored key — "reasoning", "standard", "fast" — under a heading reading
    // Tier, which reads as three unrelated words rather than one scale.
    "tier.reasoning": "Deep reasoning",
    "tier.standard": "Standard",
    "tier.fast": "Fast",
    "agents.autonomy": "Autonomy",
    "agents.autonomyConfirmed": "Level confirmed by the API",
    "agents.status": "Status",
    "agents.tools": "Tools allowed",
    "agents.prompt": "Prompt reference",
    "agents.pausedReason": "Paused because",
    "agents.pausedBy": "Paused by",
    "agents.updated": "Updated",
    "agents.reason": "Reason",
    "agents.pause": "Pause agent",
    "agents.resume": "Resume agent",
    "agents.setAutonomy": "Change autonomy",
    "agents.confirmRaise":
      "I understand this widens what the agent may do without asking, and that it is recorded against my name.",
    "agents.confirmMissing": "A raise in autonomy needs the confirmation ticked.",
    "agents.pendingTitle": "Autonomy change is waiting for approval",
    "agents.pendingReason":
      "The level shown above is the one the API still holds. It changes only once the approval is granted.",
    "agents.noControls": "Your roles do not include changing agents.",
    "agents.unavailable": "You do not have access to the agent roster.",
    "headline.noAgents": "No agents are configured for this tenant.",
    "headline.agentsActive": "agent(s) are active.",
    "headline.allPaused": "Every configured agent is paused.",
    "autonomy.suggest": "Suggests only",
    "autonomy.act_with_approval": "Acts with approval",
    "autonomy.act_within_limits": "Acts within limits",
    "autonomy.autonomous": "Autonomous",
    // An agent is not a policy: detail-kit's shared `status.*` words are the
    // axis_policies vocabulary, feminine in Arabic and wrong for a وكيل.
    "agentStatus.active": "Active",
    "agentStatus.paused": "Paused",
    "agentStatus.retired": "Retired",
    "runs.title": "Recent runs",
    "runs.when": "Started",
    "runs.agent": "Agent",
    "runs.askedBy": "Asked by",
    "runs.purpose": "Purpose",
    "runs.state": "State",
    "runs.latency": "Latency",
    "runs.cost": "Cost",
    "runs.why": "Why this ran",
    "runs.model": "Model",
    "runs.provider": "Provider",
    "runs.tokens": "Tokens in / out",
    "runs.trigger": "Trigger",
    "runs.autonomyAtRun": "Autonomy at run time",
    "runs.confidence": "Model confidence",
    "runs.flags": "Guardrail flags",
    "runs.error": "Error",
    "runs.auditRef": "Audit reference",
    "runs.unavailable": "You do not have access to agent runs.",
    "state.running": "Running",
    "state.awaiting_approval": "Awaiting approval",
    "state.succeeded": "Succeeded",
    "state.refused": "Refused",
    "state.failed": "Failed",
    "state.cancelled": "Cancelled",
    "state.budget_stopped": "Stopped by budget",
    "guardrails.title": "Guardrail events",
    "guardrails.when": "When",
    "guardrails.rule": "Rule",
    "guardrails.severity": "Severity",
    "guardrails.detail": "Detail",
    "guardrails.run": "Run",
    "guardrails.subject": "Subject",
    "severity.info": "Information",
    "severity.warn": "Warning",
    "severity.block": "Blocked",
    // ai_guardrail_events.rule is the rule that fired. A tenant may write its
    // own, so these are the ones the platform ships, not the whole vocabulary.
    "rule.prompt_injection": "Prompt injection",
    "rule.regulated_claim": "Regulated claim",
    "rule.hallucinated_placeholder": "Invented value",
    "rule.secret_in_output": "Secret in output",
    "rule.intent_mismatch": "Intent mismatch",
    "rule.comparison_claim_requires_source": "Comparison without a source",
    "rule.no_guarantee_of_cover": "Guarantee of cover",
    "audit.title": "AI audit log",
    "audit.note": "Content is never stored here — every row carries hashes only.",
    "audit.when": "When",
    "audit.actor": "Actor",
    "audit.module": "Module",
    "audit.purpose": "Purpose",
    "audit.model": "Model",
    "audit.outcome": "Outcome",
    "audit.cost": "Cost",
    "audit.hashes": "Hashes",
    "audit.inputHash": "Input hash",
    "audit.outputHash": "Output hash",
    "audit.latency": "Latency",
    "audit.unavailable": "You do not have access to the AI audit log.",
    "outcome.ok": "OK",
    "outcome.refused": "Refused",
    "outcome.error": "Error",
    "outcome.budget_exceeded": "Budget exceeded",
    "outcome.killed": "AI paused",
    "unit.ms": "ms"
  },
  ar: {
    title: "لوحة الذكاء الاصطناعي",
    intro: "ما تفعله الوكلاء، وكم تكلفته، وما المسموح لها به.",
    "budget.title": "الميزانية",
    "budget.today": "اليوم",
    "budget.tokens": "الرموز",
    "budget.cost": "التكلفة",
    "budget.over.title": "تجاوز الميزانية",
    "budget.over.tokens":
      "استُنفد حد الرموز اليومي. تُرفض تشغيلات الوكلاء حتى تُجدَّد النافذة أو يُرفع الحد.",
    "budget.over.cost":
      "استُنفد حد التكلفة اليومي. تُرفض تشغيلات الوكلاء حتى تُجدَّد النافذة أو يُرفع الحد.",
    "budget.over.stopped": "أوقف مسؤولٌ هذه الميزانية.",
    "budget.near.title": "اقتراب من حد الميزانية",
    "budget.near.reason": "المستهلك اليوم حتى الآن:",
    "budget.unavailable": "لا تملك صلاحية الاطلاع على أرقام الميزانية.",
    "spend.title": "الإنفاق حسب الوحدة والغرض",
    "spend.window": "آخر ٣٠ يومًا",
    "spend.module": "الوحدة",
    "spend.purpose": "الغرض",
    "spend.calls": "الاستدعاءات",
    "spend.tokens": "الرموز",
    "spend.cost": "التكلفة",
    "spend.errors": "الأخطاء",
    "spend.total": "الإجمالي",
    "kill.title": "مفاتيح الإيقاف",
    "kill.intro": "أوقف استدعاءات النماذج لهذا المستأجر أو لوحدة واحدة. كل إيقاف يُسجَّل باسمك.",
    "kill.global": "على مستوى المنصة",
    "kill.globalOn": "أوقفت عمليات المنصة الذكاء الاصطناعي. لا شيء هنا يرفع هذا الإيقاف.",
    "kill.globalOff": "لا يوجد إيقاف على مستوى المنصة.",
    "kill.tenant": "هذا المستأجر",
    "kill.tenantOn": "الذكاء الاصطناعي موقوف للمستأجر بأكمله. تُرفض كل استدعاءات النماذج.",
    "kill.tenantOff": "يعمل.",
    "kill.modules": "الوحدات الموقوفة",
    "kill.none": "لا شيء",
    "kill.pauseTenant": "إيقاف الذكاء الاصطناعي بالكامل",
    "kill.resumeTenant": "استئناف الذكاء الاصطناعي",
    "kill.pauseModule": "إيقاف الوحدة",
    "kill.resumeModule": "استئناف",
    "kill.module": "الوحدة",
    "kill.reason": "السبب",
    "kill.noControls": "أدوارك لا تشمل مفتاح إيقاف الذكاء الاصطناعي.",
    "kill.unavailable": "لا تملك صلاحية الاطلاع على مفاتيح الإيقاف.",
    "agents.title": "الوكلاء",
    "agents.module": "الوحدة",
    "agents.tier": "الفئة",
    "tier.reasoning": "استدلال عميق",
    "tier.standard": "قياسي",
    "tier.fast": "سريع",
    "agents.autonomy": "مستوى الاستقلالية",
    "agents.autonomyConfirmed": "المستوى المؤكَّد من الواجهة البرمجية",
    "agents.status": "الحالة",
    "agents.tools": "الأدوات المسموح بها",
    "agents.prompt": "مرجع التوجيه",
    "agents.pausedReason": "سبب الإيقاف",
    "agents.pausedBy": "أوقفه",
    "agents.updated": "آخر تحديث",
    "agents.reason": "السبب",
    "agents.pause": "إيقاف الوكيل",
    "agents.resume": "استئناف الوكيل",
    "agents.setAutonomy": "تغيير مستوى الاستقلالية",
    "agents.confirmRaise":
      "أفهم أن هذا يوسّع ما يمكن للوكيل فعله دون سؤال، وأنه يُسجَّل باسمي.",
    "agents.confirmMissing": "رفع مستوى الاستقلالية يتطلب تأكيدًا.",
    "agents.pendingTitle": "تغيير الاستقلالية بانتظار الموافقة",
    "agents.pendingReason":
      "المستوى المعروض أعلاه هو ما تحتفظ به الواجهة البرمجية، ولا يتغير إلا بعد منح الموافقة.",
    "agents.noControls": "أدوارك لا تشمل تغيير الوكلاء.",
    "agents.unavailable": "لا تملك صلاحية الاطلاع على قائمة الوكلاء.",
    "headline.noAgents": "لا يوجد وكلاء مهيّأون لهذا المستأجر.",
    "headline.agentsActive": "وكيل نشط.",
    "headline.allPaused": "كل وكيل مهيّأ متوقف مؤقتًا.",
    "autonomy.suggest": "يقترح فقط",
    "autonomy.act_with_approval": "يتصرف بموافقة",
    "autonomy.act_within_limits": "يتصرف ضمن حدود",
    "autonomy.autonomous": "مستقل",
    "agentStatus.active": "نشط",
    "agentStatus.paused": "موقوف",
    "agentStatus.retired": "مسحوب",
    "runs.title": "التشغيلات الأخيرة",
    "runs.when": "البداية",
    "runs.agent": "الوكيل",
    "runs.askedBy": "طلبته",
    "runs.purpose": "الغرض",
    "runs.state": "الحالة",
    "runs.latency": "زمن الاستجابة",
    "runs.cost": "التكلفة",
    "runs.why": "سبب هذا التشغيل",
    "runs.model": "النموذج",
    "runs.provider": "المزوّد",
    "runs.tokens": "الرموز داخل / خارج",
    "runs.trigger": "المُطلِق",
    "runs.autonomyAtRun": "الاستقلالية وقت التشغيل",
    "runs.confidence": "ثقة النموذج",
    "runs.flags": "إشارات الحواجز",
    "runs.error": "الخطأ",
    "runs.auditRef": "مرجع التدقيق",
    "runs.unavailable": "لا تملك صلاحية الاطلاع على تشغيلات الوكلاء.",
    "state.running": "قيد التشغيل",
    "state.awaiting_approval": "بانتظار الموافقة",
    "state.succeeded": "نجح",
    "state.refused": "رُفض",
    "state.failed": "فشل",
    "state.cancelled": "أُلغي",
    "state.budget_stopped": "أوقفته الميزانية",
    "guardrails.title": "أحداث الحواجز",
    "guardrails.when": "الوقت",
    "guardrails.rule": "القاعدة",
    "guardrails.severity": "الخطورة",
    "guardrails.detail": "التفاصيل",
    "guardrails.run": "التشغيل",
    "guardrails.subject": "الموضوع",
    "severity.info": "معلومة",
    "severity.warn": "تحذير",
    "severity.block": "حجب",
    "rule.prompt_injection": "حقن التعليمات",
    "rule.regulated_claim": "ادعاء خاضع للتنظيم",
    "rule.hallucinated_placeholder": "قيمة مختلقة",
    "rule.secret_in_output": "سر في المخرجات",
    "rule.intent_mismatch": "عدم تطابق الغرض",
    "rule.comparison_claim_requires_source": "مقارنة بلا مصدر",
    "rule.no_guarantee_of_cover": "ضمان التغطية",
    "audit.title": "سجل تدقيق الذكاء الاصطناعي",
    "audit.note": "لا يُخزَّن المحتوى هنا إطلاقًا — كل سطر يحمل بصمات فقط.",
    "audit.when": "الوقت",
    "audit.actor": "الفاعل",
    "audit.module": "الوحدة",
    "audit.purpose": "الغرض",
    "audit.model": "النموذج",
    "audit.outcome": "النتيجة",
    "audit.cost": "التكلفة",
    "audit.hashes": "البصمات",
    "audit.inputHash": "بصمة المدخل",
    "audit.outputHash": "بصمة المخرج",
    "audit.latency": "زمن الاستجابة",
    "audit.unavailable": "لا تملك صلاحية الاطلاع على سجل التدقيق.",
    "outcome.ok": "سليم",
    "outcome.refused": "رُفض",
    "outcome.error": "خطأ",
    "outcome.budget_exceeded": "تجاوز الميزانية",
    "outcome.killed": "الذكاء الاصطناعي موقوف",
    "unit.ms": "مللي ثانية"
  }
};

type Label = (key: string, fallback?: string) => string;

/** Locale first, English next, then whatever the API actually said. */
function labeller(locale: string): Label {
  const t = translator(locale);
  return (key, fallback) => {
    const mine = LABELS[locale]?.[key] ?? LABELS["en"]?.[key];
    if (mine !== undefined) return pseudoText(locale, mine);
    // Same fall-through as ai-run.tsx and as `labelsFrom` (detail-kit.tsx):
    // the shared catalogue answers before the caller's fallback, so an agent
    // key or an AI purpose reads the same here as on the home screen.
    const shared = t(`common.${key}`);
    if (shared !== `common.${key}`) return shared;
    return pseudoText(locale, fallback ?? key);
  };
}

/* ------------------------------------------------------------------- shapes */

interface Page<T> {
  data: T[];
  cursor?: string;
}

interface Agent {
  id: string;
  key: string;
  module: string;
  nameJson: unknown;
  descriptionJson: unknown;
  autonomyLevel: string;
  tier: string;
  toolsJson: unknown;
  promptRef: string | null;
  status: string;
  pausedBy: string | null;
  pausedReason: string | null;
  updatedAt: number;
}

/** The three wider kill-switch tiers as `GET /v1/ai/kill-switches` reports them. */
interface KillState {
  /** Held by platform operations, not by this tenant — read-only here. */
  global: boolean;
  tenant: boolean;
  modules: string[];
}

interface BudgetCheck {
  ok: boolean;
  usedPct: number;
  reason?: "tokens" | "cost";
  state: {
    day: string;
    module: string;
    tokensUsed: number;
    costMicroUsed: number;
    tokensLimit: number;
    costMicroLimit: number;
    stoppedAt: number | null;
  };
}

interface SpendRow {
  module: string;
  purpose: string;
  calls: number;
  tokens: number;
  costMicro: number;
  errors: number;
}

interface Spend {
  data: SpendRow[];
  totals: { calls: number; tokens: number; costMicro: number };
}

interface Run {
  id: string;
  agentKey: string;
  module: string;
  purpose: string;
  state: string;
  trigger: string;
  autonomyLevel: string;
  confidence: number | null;
  evidenceJson: unknown;
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
  latencyMs: number;
  outputRef: string | null;
  errorCode: string | null;
  startedAt: number;
}

interface GuardrailEvent {
  id: string;
  runId: string | null;
  rule: string;
  severity: string;
  detail: string | null;
  subjectRef: string | null;
  ts: number;
}

interface AuditRow {
  id: string;
  module: string;
  purpose: string;
  model: string;
  provider: string;
  tier: string;
  inputHash: string;
  outputHash: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
  latencyMs: number;
  outcome: string;
  actorRef: string;
  subjectRef: string | null;
  ts: number;
}

/* ------------------------------------------------------------------ loader */

/**
 * A section the actor may not read is absent, not an error. The API is the
 * authority on what they may see, so a 403 renders as a missing card and the
 * rest of the console still loads.
 */
async function readable<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };

  const [budget, spend, agents, runs, guardrails, audit, kill] = await Promise.all([
    readable(api<BudgetCheck>("/v1/ai/budget", opts)),
    readable(api<Spend>(`/v1/ai/audit/spend?days=${SPEND_DAYS}`, opts)),
    readable(api<Page<Agent>>("/v1/ai/agents?sort=key&order=asc&limit=100", opts)),
    readable(api<Page<Run>>(`/v1/ai/runs?sort=startedAt&order=desc&limit=${RUN_LIMIT}`, opts)),
    readable(api<Page<GuardrailEvent>>(`/v1/ai/guardrail-events?sort=ts&order=desc&limit=${EVENT_LIMIT}`, opts)),
    readable(api<{ data: AuditRow[] }>(`/v1/ai/audit?limit=${AUDIT_LIMIT}`, opts)),
    readable(api<KillState>("/v1/ai/kill-switches", opts))
  ]);

  // Every ref on this page is a person: who paused an agent, who asked for a
  // run, who a guardrail fired about. They arrived as `user:us_01KE9…` and
  // were rendered as that.
  const resolved = await names(
    [
      ...(agents?.data ?? []).map((agent) => agent.pausedBy),
      ...(audit?.data ?? []).flatMap((row) => [row.actorRef, row.subjectRef]),
      ...(guardrails?.data ?? []).map((event) => event.subjectRef)
    ],
    opts
  );

  return {
    budget,
    spend,
    agents: agents?.data ?? null,
    runs: runs?.data ?? null,
    guardrails: guardrails?.data ?? [],
    audit: audit?.data ?? null,
    kill,
    names: resolved
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: { title: string; status: number; detail?: string } | null;
  /** An autonomy change the API accepted but has not applied yet. */
  pending: { agentKey: string; requested: string } | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    // The tenant and module tiers of the kill switch (docs/12 §4) are not
    // scoped to an agent, so they are handled before an agent key is demanded.
    // A missing `module` is the tenant-wide switch, which is why it is omitted
    // rather than sent empty — the API reads absence as "everything".
    if (intent === "ai-pause" || intent === "ai-resume") {
      const pausing = intent === "ai-pause";
      const module = String(form.get("module") ?? "");
      await api(pausing ? "/v1/ai/pause" : "/v1/ai/resume", {
        env,
        request,
        method: "POST",
        body: {
          ...(module ? { module } : {}),
          ...(pausing ? { reason: String(form.get("reason") ?? "") } : {})
        }
      });
      return { problem: null, pending: null };
    }

    const key = String(form.get("agentKey") ?? "");
    if (!key) return { problem: { title: "agent key missing", status: 400 }, pending: null };
    const agent = `/v1/ai/agents/${encodeURIComponent(key)}`;

    if (intent === "pause") {
      await api(`${agent}/pause`, {
        env,
        request,
        method: "POST",
        body: { reason: String(form.get("reason") ?? "") }
      });
    } else if (intent === "resume") {
      await api(`${agent}/resume`, { env, request, method: "POST" });
    } else if (intent === "autonomy") {
      const level = String(form.get("autonomyLevel") ?? "");
      if (!AUTONOMY_LEVELS.includes(level as AutonomyLevel)) {
        return { problem: { title: `unknown autonomy level ${level}`, status: 400 }, pending: null };
      }
      // Raising autonomy is consequential (CLAUDE.md §4): the browser asked for
      // an explicit confirmation, and this re-checks it rather than trusting the
      // markup that carried it. The API's own approval gate is the real control;
      // this only stops an accidental raise from ever reaching it.
      if (raises(String(form.get("currentLevel") ?? ""), level) && form.get("confirm") !== "on") {
        return { problem: { title: "confirmation required", status: 400 }, pending: null };
      }
      const result = await api<{ approval?: { id: string; decision: string } } | null>(
        `${agent}/autonomy`,
        {
          env,
          request,
          method: "POST",
          body: { autonomyLevel: level, reason: String(form.get("reason") ?? "") }
        }
      );
      // 202: the gate holds an approval that is not granted yet, so the agent
      // row still carries the old level. Say so instead of showing the new one.
      if (result && "approval" in result && result.approval) {
        return { problem: null, pending: { agentKey: key, requested: level } };
      }
    } else {
      return { problem: { title: "unknown intent", status: 400 }, pending: null };
    }
  } catch (error) {
    // A refused write is information: an approval_required 403 belongs on the
    // page next to the agent it was refused for, not in an error boundary.
    if (error instanceof ApiError) return { problem: error.problem, pending: null };
    throw error;
  }
  return { problem: null, pending: null };
}

/* ------------------------------------------------------------------ helpers */

/** JSON columns arrive parsed from generated CRUD and as text from the
 *  hand-written /audit routes. One reader covers both. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `{ en, ar }` name bags, with the raw string tolerated. */
function localised(value: unknown, locale: string): string | null {
  const bag = asRecord(value);
  if (!bag) return typeof value === "string" ? value : null;
  const hit = bag[locale] ?? bag["en"];
  return typeof hit === "string" ? hit : null;
}

/**
 * The runs table listed an agent by its key (`renewal`), the one machine string
 * on a screen that already holds every agent's name. An agent the roster no
 * longer carries — retired, or unreadable to this role — keeps the key.
 */
export function agentNames(
  agents: readonly { key: string; nameJson: unknown }[],
  locale: string
): Record<string, string> {
  return Object.fromEntries(agents.map((agent) => [agent.key, localised(agent.nameJson, locale) ?? agent.key]));
}

/**
 * The rule that fired, in words: the platform's own rules are named, and a rule
 * a tenant wrote for itself is humanised rather than printed as
 * `hallucinated_placeholder`.
 */
export const ruleLabel = (L: Label, rule: string): string => L(`rule.${rule}`, humanise(rule));

/**
 * One true line for the hero. A tenant- or global-level pause outranks
 * anything else on the roster — nothing below runs while it stands. Whether
 * the budget is over or near is already its own notice right under the hero,
 * so the headline stays on what the roster itself says rather than repeating
 * that notice.
 */
export function consoleHeadline(
  kill: { global: boolean; tenant: boolean } | null,
  agents: readonly { status: string }[] | null,
  L: Label
): string {
  if (kill?.global) return L("kill.globalOn");
  if (kill?.tenant) return L("kill.tenantOn");
  if (!agents) return L("agents.unavailable");
  if (agents.length === 0) return L("headline.noAgents");
  const active = agents.filter((agent) => agent.status === "active").length;
  return active > 0 ? `${active} ${L("headline.agentsActive")}` : L("headline.allPaused");
}

const STATE_TONES: Record<string, BadgeTone> = {
  succeeded: "success",
  running: "info",
  awaiting_approval: "warning",
  refused: "warning",
  failed: "danger",
  cancelled: "neutral",
  budget_stopped: "danger",
  ok: "success",
  error: "danger",
  budget_exceeded: "danger",
  killed: "danger",
  active: "success",
  paused: "warning",
  retired: "neutral",
  info: "info",
  warn: "warning",
  block: "danger"
};

const toneOf = (value: string): BadgeTone => STATE_TONES[value] ?? "neutral";

/* --------------------------------------------------------------- the screen */

export default function AiConsole() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const held = new Set(shell?.permissions ?? []);
  const t = translator(locale);
  const L = labeller(locale);
  const nf = new Intl.NumberFormat(locale);
  const busy = navigation.state !== "idle";
  const budget = loaded.budget;

  // Which modules the module-level kill switch can name: the ones this tenant
  // actually runs agents in, plus anything already paused (an agent can be
  // retired while its module pause stands, and that pause must stay releasable).
  const moduleChoices = [
    ...new Set([...(loaded.agents ?? []).map((agent) => agent.module), ...(loaded.kill?.modules ?? [])])
  ].sort();

  const named = agentNames(loaded.agents ?? [], locale);

  const runColumns: Array<Column<Run>> = [
    {
      key: "startedAt",
      header: L("runs.when"),
      render: (run) => <DateTime value={run.startedAt} locale={locale} precision="minute" />
    },
    {
      key: "agentKey",
      header: L("runs.agent"),
      // docs/15: the single ✦ plus a "why" one interaction away. The glyph comes
      // from AGENT_MARK so there is exactly one sparkle in the product.
      render: (run) => (
        <EvidenceLink sourceLabel={L("runs.why")} source={<RunWhy run={run} L={L} locale={locale} />}>
          <span aria-hidden="true">{AGENT_MARK}</span> {named[run.agentKey] ?? run.agentKey}
        </EvidenceLink>
      )
    },
    { key: "module", header: L("runs.askedBy"), render: (run) => moduleName(t, run.module) },
    { key: "purpose", header: L("runs.purpose"), render: (run) => optionLabel(L, "purpose", run.purpose) },
    {
      key: "state",
      header: L("runs.state"),
      render: (run) => (
        <Badge tone={toneOf(run.state)} size="sm">
          {L(`state.${run.state}`, run.state)}
        </Badge>
      )
    },
    {
      key: "latencyMs",
      header: L("runs.latency"),
      numeric: true,
      render: (run) => `${nf.format(run.latencyMs)} ${L("unit.ms")}`
    },
    {
      key: "costMicro",
      header: L("runs.cost"),
      numeric: true,
      render: (run) => (
        <Money amountMinor={minorOf(run.costMicro)} currency={COST_CURRENCY} locale={locale} />
      )
    }
  ];

  const spendColumns: Array<Column<SpendRow>> = [
    // Spend and the audit log are keyed by module code (`dist`, `core`); the
    // person reading the table navigates by the name on the rail.
    { key: "module", header: L("spend.module"), render: (row) => moduleName(t, row.module) },
    { key: "purpose", header: L("spend.purpose"), render: (row) => optionLabel(L, "purpose", row.purpose) },
    { key: "calls", header: L("spend.calls"), numeric: true, render: (row) => nf.format(row.calls) },
    { key: "tokens", header: L("spend.tokens"), numeric: true, render: (row) => nf.format(row.tokens) },
    {
      key: "errors",
      header: L("spend.errors"),
      numeric: true,
      render: (row) =>
        row.errors ? (
          <Badge tone="danger" size="sm">
            {nf.format(row.errors)}
          </Badge>
        ) : (
          nf.format(0)
        )
    },
    {
      key: "costMicro",
      header: L("spend.cost"),
      numeric: true,
      render: (row) => (
        <Money amountMinor={minorOf(row.costMicro)} currency={COST_CURRENCY} locale={locale} />
      )
    }
  ];

  const guardrailColumns: Array<Column<GuardrailEvent>> = [
    {
      key: "ts",
      header: L("guardrails.when"),
      render: (event) => <DateTime value={event.ts} locale={locale} precision="minute" />
    },
    {
      key: "rule",
      header: L("guardrails.rule"),
      render: (event) => ruleLabel(L, event.rule)
    },
    {
      key: "severity",
      header: L("guardrails.severity"),
      render: (event) => (
        <Badge tone={toneOf(event.severity)} size="sm">
          {L(`severity.${event.severity}`, event.severity)}
        </Badge>
      )
    },
    { key: "detail", header: L("guardrails.detail"), render: (event) => event.detail ?? "—" },
    {
      key: "runId",
      header: L("guardrails.run"),
      render: (event) => <Ref value={event.runId} className="text-12" />
    },
    {
      key: "subjectRef",
      header: L("guardrails.subject"),
      render: (event) => (event.subjectRef ? who(event.subjectRef, loaded.names) : "—")
    }
  ];

  const auditColumns: Array<Column<AuditRow>> = [
    {
      key: "ts",
      header: L("audit.when"),
      render: (row) => <DateTime value={row.ts} locale={locale} precision="second" />
    },
    { key: "actorRef", header: L("audit.actor"), render: (row) => who(row.actorRef, loaded.names) },
    { key: "module", header: L("audit.module"), render: (row) => moduleName(t, row.module) },
    { key: "purpose", header: L("audit.purpose"), render: (row) => optionLabel(L, "purpose", row.purpose) },
    {
      key: "model",
      header: L("audit.model"),
      // Claim → source: the row proves what happened by hash, never by content.
      render: (row) => (
        <EvidenceLink
          sourceLabel={L("audit.hashes")}
          source={
            <dl className="flex flex-col gap-1 font-ui text-12">
              <Pair term={L("audit.inputHash")} detail={<code className="font-mono">{row.inputHash}</code>} />
              <Pair
                term={L("audit.outputHash")}
                detail={<code className="font-mono">{row.outputHash ?? "—"}</code>}
              />
              <Pair term={L("runs.provider")} detail={`${row.provider} · ${row.tier}`} />
              <Pair
                term={L("audit.latency")}
                detail={`${nf.format(row.latencyMs)} ${L("unit.ms")}`}
              />
              <Pair
                term={L("runs.tokens")}
                detail={`${nf.format(row.tokensIn)} / ${nf.format(row.tokensOut)}`}
              />
            </dl>
          }
        >
          {row.model}
        </EvidenceLink>
      )
    },
    {
      key: "outcome",
      header: L("audit.outcome"),
      render: (row) => (
        <Badge tone={toneOf(row.outcome)} size="sm">
          {L(`outcome.${row.outcome}`, row.outcome)}
        </Badge>
      )
    },
    {
      key: "costMicro",
      header: L("audit.cost"),
      numeric: true,
      render: (row) => (
        <Money amountMinor={minorOf(row.costMicro)} currency={COST_CURRENCY} locale={locale} />
      )
    }
  ];

  const emptyState = <EmptyState title={t("common.empty.title")} body={t("common.empty.body")} />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{L("title")}</h1>
        <p className="font-ui text-13 text-muted">{consoleHeadline(loaded.kill, loaded.agents, L)}</p>
      </header>

      {/* Over budget is the first thing an operator must read, before any chart:
          a meter that quietly maxes out tells them nothing. */}
      {budget && !budget.ok ? (
        <GuardrailNotice
          tone="danger"
          title={L("budget.over.title")}
          reason={
            <span>
              {budget.reason === "tokens" ? L("budget.over.tokens") : L("budget.over.cost")}{" "}
              {budget.reason === "tokens" ? (
                <span className="tabular-nums">
                  {nf.format(budget.state.tokensUsed)} / {nf.format(budget.state.tokensLimit)}
                </span>
              ) : (
                <span>
                  <Money
                    amountMinor={minorOf(budget.state.costMicroUsed)}
                    currency={COST_CURRENCY}
                    locale={locale}
                  />
                  {" / "}
                  <Money
                    amountMinor={minorOf(budget.state.costMicroLimit)}
                    currency={COST_CURRENCY}
                    locale={locale}
                  />
                </span>
              )}
              {budget.state.stoppedAt ? <span> {L("budget.over.stopped")}</span> : null}
            </span>
          }
        />
      ) : budget && budget.usedPct >= 80 ? (
        <GuardrailNotice
          tone="warning"
          title={L("budget.near.title")}
          reason={`${L("budget.near.reason")} ${budget.usedPct}%`}
        />
      ) : null}

      {result?.problem ? <Problem problem={result.problem} /> : null}

      {/* ------------------------------------------------------------ budget */}
      <Card
        title={L("budget.title")}
        description={budget ? `${L("budget.today")} · ${budget.state.day}` : L("budget.unavailable")}
      >
        {budget ? (
          <div className="grid gap-6 sm:grid-cols-2">
            <BudgetMeter
              label={L("budget.tokens")}
              used={budget.state.tokensUsed}
              limit={budget.state.tokensLimit}
              unit={L("budget.tokens")}
              locale={locale}
            />
            <div className="flex flex-col gap-2">
              {/* The authoritative figures are money and render as money; the
                  meter below is the shape of the same two numbers. */}
              <p className="font-ui text-13 text-text">
                <Money
                  amountMinor={minorOf(budget.state.costMicroUsed)}
                  currency={COST_CURRENCY}
                  locale={locale}
                />
                {" / "}
                <Money
                  amountMinor={minorOf(budget.state.costMicroLimit)}
                  currency={COST_CURRENCY}
                  locale={locale}
                />
              </p>
              <BudgetMeter
                label={L("budget.cost")}
                used={minorOf(budget.state.costMicroUsed)}
                limit={minorOf(budget.state.costMicroLimit)}
                currency={COST_CURRENCY}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------- spend */}
      {loaded.spend ? (
        <Card title={L("spend.title")} description={L("spend.window")}>
          <Table
            columns={spendColumns}
            rows={loaded.spend.data}
            rowKey={(row) => `${row.module}/${row.purpose}`}
            caption={`${L("spend.title")} — ${L("spend.window")}`}
            density="compact"
            empty={emptyState}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 font-ui text-12 text-subtle">
                <span>
                  {L("spend.total")} · {nf.format(loaded.spend.totals.calls)} {L("spend.calls")} ·{" "}
                  {nf.format(loaded.spend.totals.tokens)} {L("spend.tokens")}
                </span>
                <Money
                  amountMinor={minorOf(loaded.spend.totals.costMicro)}
                  currency={COST_CURRENCY}
                  locale={locale}
                  className="text-13 text-text"
                />
              </div>
            }
          />
        </Card>
      ) : null}

      {/* ------------------------------------------------------ kill switches */}
      <KillSwitches
        kill={loaded.kill}
        L={L}
        busy={busy}
        canPause={held.has("ai:killswitch:use")}
        canResume={held.has("ai:agents:write")}
        modules={moduleChoices}
      />

      {/* ------------------------------------------------------------ agents */}
      <section className="flex flex-col gap-4">
        <h2 className="eyebrow">{L("agents.title")}</h2>
        {loaded.agents ? (
          loaded.agents.length ? (
            loaded.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                L={L}
                locale={locale}
                busy={busy}
                canPause={held.has("ai:agents:pause")}
                canWrite={held.has("ai:agents:write")}
                resolved={loaded.names}
                pending={
                  result?.pending && result.pending.agentKey === agent.key ? result.pending : null
                }
              />
            ))
          ) : (
            emptyState
          )
        ) : (
          <p className="font-ui text-13 text-subtle">{L("agents.unavailable")}</p>
        )}
      </section>

      {/* -------------------------------------------------------------- runs */}
      <Card title={L("runs.title")}>
        {loaded.runs ? (
          <Table
            columns={runColumns}
            rows={loaded.runs}
            rowKey={(run) => run.id}
            caption={L("runs.title")}
            density="compact"
            empty={emptyState}
            footer={
              <span className="font-ui text-12 tabular-nums text-subtle">
                {t("common.rows", { count: String(loaded.runs.length) })}
              </span>
            }
          />
        ) : (
          <p className="font-ui text-13 text-subtle">{L("runs.unavailable")}</p>
        )}
      </Card>

      {/* -------------------------------------------------------- guardrails */}
      <Card title={L("guardrails.title")}>
        <Table
          columns={guardrailColumns}
          rows={loaded.guardrails}
          rowKey={(event) => event.id}
          caption={L("guardrails.title")}
          density="compact"
          empty={emptyState}
        />
      </Card>

      {/* ------------------------------------------------------------- audit */}
      <Card title={L("audit.title")} description={L("audit.note")}>
        {loaded.audit ? (
          <Table
            columns={auditColumns}
            rows={loaded.audit}
            rowKey={(row) => row.id}
            caption={L("audit.title")}
            density="compact"
            rowState={() => "sealed"}
            empty={emptyState}
          />
        ) : (
          <p className="font-ui text-13 text-subtle">{L("audit.unavailable")}</p>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- parts */

function Pair({ term, detail }: { term: string; detail: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="text-subtle">{term}</dt>
      <dd className="text-text">{detail}</dd>
    </div>
  );
}

/** The inspectable "why" behind one run: what it cost, what ran it, what fired. */
function RunWhy({ run, L, locale }: { run: Run; L: Label; locale: string }) {
  const nf = new Intl.NumberFormat(locale);
  const evidence = asRecord(run.evidenceJson);
  const flags = asList(evidence?.["flags"]);
  return (
    <div className="flex max-w-xs flex-col gap-2">
      <dl className="flex flex-col gap-1 font-ui text-12">
        <Pair term={L("runs.model")} detail={String(evidence?.["model"] ?? "—")} />
        <Pair term={L("runs.provider")} detail={String(evidence?.["provider"] ?? "—")} />
        <Pair term={L("runs.trigger")} detail={run.trigger} />
        <Pair
          term={L("runs.autonomyAtRun")}
          detail={L(`autonomy.${run.autonomyLevel}`, run.autonomyLevel)}
        />
        <Pair
          term={L("runs.tokens")}
          detail={`${nf.format(run.tokensIn)} / ${nf.format(run.tokensOut)}`}
        />
        <Pair
          term={L("runs.cost")}
          detail={<Money amountMinor={minorOf(run.costMicro)} currency={COST_CURRENCY} locale={locale} />}
        />
        {flags.length ? <Pair term={L("runs.flags")} detail={flags.join(", ")} /> : null}
        {run.errorCode ? <Pair term={L("runs.error")} detail={run.errorCode} /> : null}
        {run.outputRef ? (
          <Pair
            term={L("runs.auditRef")}
            detail={<code className="font-mono">{shortRef(run.outputRef)}</code>}
          />
        ) : null}
      </dl>
      {run.confidence === null ? null : (
        <ConfidenceMeter value={run.confidence / 100} label={L("runs.confidence")} />
      )}
    </div>
  );
}

interface KillSwitchesProps {
  kill: KillState | null;
  L: Label;
  busy: boolean;
  canPause: boolean;
  canResume: boolean;
  modules: string[];
}

/**
 * docs/12 §4: the tenant and module tiers, one submit each. The global tier is
 * shown but never operable here — it belongs to platform operations, and an
 * operator staring at a dead assistant needs to know the release is not theirs
 * to make rather than hunting for a control that would 403.
 *
 * Pausing takes `ai:killswitch:use` and resuming takes `ai:agents:write`, the
 * same split the API enforces: the party that stops AI mid-incident is not
 * automatically the party that decides the incident is over.
 */
function KillSwitches({ kill, L, busy, canPause, canResume, modules }: KillSwitchesProps) {
  if (!kill) {
    return (
      <Card title={L("kill.title")}>
        <p className="font-ui text-13 text-subtle">{L("kill.unavailable")}</p>
      </Card>
    );
  }

  const paused = new Set(kill.modules);
  const pausable = modules.filter((module) => !paused.has(module));

  return (
    <Card title={L("kill.title")} description={L("kill.intro")}>
      <div className="flex flex-col gap-4">
        {kill.global ? <GuardrailNotice tone="danger" title={L("kill.global")} reason={L("kill.globalOn")} /> : null}
        {kill.tenant ? <GuardrailNotice tone="danger" title={L("kill.tenant")} reason={L("kill.tenantOn")} /> : null}

        <dl className="grid gap-x-8 gap-y-2 font-ui text-13 sm:grid-cols-2">
          <Pair
            term={L("kill.global")}
            detail={
              <Badge tone={kill.global ? "danger" : "success"} size="sm">
                {kill.global ? L("kill.globalOn") : L("kill.globalOff")}
              </Badge>
            }
          />
          <Pair
            term={L("kill.tenant")}
            detail={
              <Badge tone={kill.tenant ? "danger" : "success"} size="sm">
                {kill.tenant ? L("kill.tenantOn") : L("kill.tenantOff")}
              </Badge>
            }
          />
          <Pair
            term={L("kill.modules")}
            detail={
              kill.modules.length ? (
                <span className="flex flex-wrap gap-1">
                  {kill.modules.map((module) => (
                    <Badge key={module} tone="warning" size="sm">
                      {module}
                    </Badge>
                  ))}
                </span>
              ) : (
                L("kill.none")
              )
            }
          />
        </dl>

        {canPause || canResume ? (
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            {kill.tenant
              ? canResume && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="ai-resume" />
                    <Button type="submit" variant="secondary" loading={busy}>
                      {L("kill.resumeTenant")}
                    </Button>
                  </Form>
                )
              : canPause && (
                  <Form method="post" className="flex flex-col gap-2">
                    <input type="hidden" name="intent" value="ai-pause" />
                    <label className="flex flex-col gap-1 font-ui text-12 text-subtle">
                      <span>{L("kill.reason")}</span>
                      <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
                    </label>
                    <div>
                      <Button type="submit" variant="danger" loading={busy}>
                        {L("kill.pauseTenant")}
                      </Button>
                    </div>
                  </Form>
                )}

            {canResume && kill.modules.length ? (
              <div className="flex flex-wrap items-center gap-2">
                {kill.modules.map((module) => (
                  <Form key={module} method="post">
                    <input type="hidden" name="intent" value="ai-resume" />
                    <input type="hidden" name="module" value={module} />
                    <Button type="submit" variant="secondary" loading={busy}>
                      {L("kill.resumeModule")} · {module}
                    </Button>
                  </Form>
                ))}
              </div>
            ) : null}

            {canPause && pausable.length ? (
              <Form method="post" className="flex flex-col gap-2">
                <input type="hidden" name="intent" value="ai-pause" />
                <div className="flex flex-wrap items-end gap-3">
                  <Select
                    name="module"
                    aria-label={L("kill.module")}
                    options={pausable.map((module) => ({ value: module, label: module }))}
                  />
                  <Button type="submit" variant="danger" loading={busy}>
                    {L("kill.pauseModule")}
                  </Button>
                </div>
                <label className="flex flex-col gap-1 font-ui text-12 text-subtle">
                  <span>{L("kill.reason")}</span>
                  <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
                </label>
              </Form>
            ) : null}
          </div>
        ) : (
          <p className="font-ui text-12 text-subtle">{L("kill.noControls")}</p>
        )}
      </div>
    </Card>
  );
}

interface AgentCardProps {
  agent: Agent;
  L: Label;
  locale: string;
  busy: boolean;
  canPause: boolean;
  canWrite: boolean;
  pending: { agentKey: string; requested: string } | null;
  /** Ref → name, so "Paused by" reads as a colleague and not as a ULID. */
  resolved: Names;
}

function AgentCard({ agent, L, locale, busy, canPause, canWrite, pending, resolved }: AgentCardProps) {
  const name = localised(agent.nameJson, locale) ?? agent.key;
  const description = localised(agent.descriptionJson, locale);
  const tools = asList(agent.toolsJson);

  return (
    <Card
      title={
        <span>
          <span aria-hidden="true">{AGENT_MARK}</span> {name}{" "}
          <span className="font-mono text-12 text-subtle">{agent.key}</span>
        </span>
      }
      description={
        description ??
        `${L("agents.module")}: ${moduleName(translator(locale), agent.module)} · ${L("agents.tier")}: ${L(`tier.${agent.tier}`, agent.tier)}`
      }
      actions={
        <Badge tone={toneOf(agent.status)}>{L(`agentStatus.${agent.status}`, agent.status)}</Badge>
      }
    >
      <div className="flex flex-col gap-4">
        <dl className="grid gap-x-8 gap-y-2 font-ui text-13 sm:grid-cols-2">
          {/* Only ever the level the API last confirmed — a requested level is
              not a level. */}
          <Pair
            term={L("agents.autonomy")}
            detail={
              <Badge tone="accent" size="sm">
                {L(`autonomy.${autonomyRung(agent.autonomyLevel)}`)}
              </Badge>
            }
          />
          <Pair
            term={L("agents.updated")}
            detail={<DateTime value={agent.updatedAt} locale={locale} precision="minute" />}
          />
          <Pair term={L("agents.module")} detail={moduleName(translator(locale), agent.module)} />
          <Pair term={L("agents.tier")} detail={L(`tier.${agent.tier}`, agent.tier)} />
          {/* The prompt reference, never the prompt: ai_prompts.body is the
              system text and this screen does not load it. */}
          <Pair
            term={L("agents.prompt")}
            detail={<code className="font-mono text-12">{agent.promptRef ? shortRef(agent.promptRef) : "—"}</code>}
          />
          {tools.length ? (
            <Pair
              term={L("agents.tools")}
              detail={
                <span className="flex flex-wrap gap-1">
                  {tools.map((tool) => (
                    <Badge key={tool} size="sm">
                      {tool}
                    </Badge>
                  ))}
                </span>
              }
            />
          ) : null}
          {agent.pausedReason ? (
            <Pair term={L("agents.pausedReason")} detail={agent.pausedReason} />
          ) : null}
          {agent.pausedBy ? (
            <Pair term={L("agents.pausedBy")} detail={who(agent.pausedBy, resolved)} />
          ) : null}
        </dl>

        {pending ? (
          <GuardrailNotice
            tone="info"
            title={L("agents.pendingTitle")}
            reason={
              <span>
                {L(`autonomy.${pending.requested}`, pending.requested)} — {L("agents.pendingReason")}
              </span>
            }
          />
        ) : null}

        {canPause || canWrite ? (
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            {agent.status === "paused"
              ? canWrite && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="resume" />
                    <input type="hidden" name="agentKey" value={agent.key} />
                    <Button type="submit" variant="secondary" loading={busy}>
                      {L("agents.resume")}
                    </Button>
                  </Form>
                )
              : canPause && (
                  // The killswitch, reachable in one submit — docs/15 §7.
                  <Form method="post" className="flex flex-col gap-2">
                    <input type="hidden" name="intent" value="pause" />
                    <input type="hidden" name="agentKey" value={agent.key} />
                    <label className="flex flex-col gap-1 font-ui text-12 text-subtle">
                      <span>{L("agents.reason")}</span>
                      <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
                    </label>
                    <div>
                      <Button type="submit" variant="danger" loading={busy}>
                        {L("agents.pause")}
                      </Button>
                    </div>
                  </Form>
                )}

            {canWrite ? <AutonomyForm agent={agent} L={L} busy={busy} /> : null}
          </div>
        ) : (
          <p className="font-ui text-12 text-subtle">{L("agents.noControls")}</p>
        )}
      </div>
    </Card>
  );
}

/**
 * Changing autonomy is consequential, so raising it asks first. ponytail: a
 * required checkbox is the confirmation — it blocks the submit in the browser
 * with no dialog, which is also what docs/15 wants (never a modal), and the
 * action re-checks it server-side.
 */
function AutonomyForm({ agent, L, busy }: { agent: Agent; L: Label; busy: boolean }) {
  const level = autonomyRung(agent.autonomyLevel);
  const [next, setNext] = React.useState<string>(level);
  const raising = raises(level, next);

  return (
    <Form method="post" className="flex flex-col gap-3">
      <input type="hidden" name="intent" value="autonomy" />
      <input type="hidden" name="agentKey" value={agent.key} />
      <input type="hidden" name="currentLevel" value={level} />
      <div className="flex flex-wrap items-end gap-3">
        <Select
          name="autonomyLevel"
          value={next}
          onValueChange={setNext}
          aria-label={L("agents.setAutonomy")}
          options={AUTONOMY_LEVELS.map((level) => ({
            value: level,
            label: L(`autonomy.${level}`, level)
          }))}
        />
        <Button
          type="submit"
          variant={raising ? "danger" : "secondary"}
          loading={busy}
          disabled={next === level}
        >
          {L("agents.setAutonomy")}
        </Button>
      </div>
      <label className="flex flex-col gap-1 font-ui text-12 text-subtle">
        <span>{L("agents.reason")}</span>
        <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
      </label>
      {raising ? (
        <label className="flex items-start gap-2 font-ui text-13 text-warning">
          <input type="checkbox" name="confirm" required className="mt-1" />
          <span>{L("agents.confirmRaise")}</span>
        </label>
      ) : null}
    </Form>
  );
}
