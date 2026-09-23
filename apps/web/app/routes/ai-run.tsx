import * as React from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  AGENT_MARK,
  ApprovalStrip,
  Badge,
  Button,
  Card,
  cn,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  EvidenceLink,
  focusRing,
  GuardrailNotice,
  Money,
  Ref,
  shortRef,
  Table,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { ApiError, api, directory, type DirectoryEntry } from "../api.server";
import { whoIs } from "../people";
import { cloudflare } from "../context";
import { moduleName, pseudoText, translator } from "../i18n";
import { humanise, optionLabel } from "../modules/spec";
import { useShellData } from "./workspace";

// One agent run, opened. `GET /v1/ai/runs/:id/detail` (apps/api/src/routes/ai.ts)
// is hand-written — the generated `/:id` returns the row alone — and joins the
// run to its tool calls and to the immutable ai_audit_log entry behind it. It
// had no caller: the console listed runs and there was nowhere to go from one.
//
// This is the "why" that docs/15 §4 requires behind every AI artifact: what was
// asked, what the agent was allowed to do at the time, which tools it reached
// for, what it cost, and the audit hash that proves the answer was not edited.

/* --------------------------------------------------------------- constants */

const COST_CURRENCY = "USD";
const minorOf = (costMicro: number): number => Math.ceil(costMicro / 10_000);

/** Where the run's audit entry lives in the admin workspace. */
const AUDIT_RECORD = "/admin/ai-audit-log";
const RUNS_LIST = "/admin/runs";

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    back: "All agent runs",
    "run.purpose": "Asked for",
    "run.module": "Asked by",
    "run.trigger": "Started by",
    "run.autonomy": "Autonomy at the time",
    "run.actor": "On behalf of",
    "run.subject": "About",
    "run.started": "Started",
    "run.ended": "Ended",
    "run.latency": "Took",
    "run.cost": "Cost",
    "run.tokens": "Tokens in and out",
    "run.confidence": "Model confidence",
    "run.why": "Why this ran",
    "run.model": "Model",
    "run.provider": "Provider",
    "run.flags": "Guardrails that fired",
    "run.inputHash": "Input fingerprint",
    "run.reasoning": "Reasoning retained",
    "failed.title": "This run did not produce an answer",
    "failed.reason": "The run ended in this state and nothing was written on the back of it.",
    "stopped.title": "Stopped by budget",
    "stopped.reason":
      "The daily ceiling was already spent when this run asked for a model, so it was refused before any tokens were bought.",
    "stopped.link": "Open spending ceilings",
    "approval.region": "Pending approval",
    "approval.summary": "This run is waiting for a decision before it can finish.",
    "approval.consequence":
      "The agent reached a step it is not allowed to take on its own at its current autonomy level.",
    "approval.blocked": "Decide it on the approvals screen, where the full request is shown.",
    "tools.title": "Tools it reached for",
    "tools.seq": "Step",
    "tools.tool": "Tool",
    "tools.outcome": "Outcome",
    "tools.duration": "Took",
    "tools.consequential": "Consequential",
    "tools.args": "Arguments",
    "tools.argsHash": "Argument fingerprint",
    "tools.resultHash": "Result fingerprint",
    "tools.approval": "Approval",
    "tools.none.title": "No tools were used",
    "tools.none.body": "The agent answered from the prompt and its context alone.",
    "audit.title": "The model call behind it",
    "audit.tier": "Tier",
    "audit.outcome": "Outcome",
    "audit.inputHash": "Input fingerprint",
    "audit.outputHash": "Output fingerprint",
    "audit.open": "Open the audit entry",
    "audit.none.title": "No audit entry is linked",
    "audit.none.body":
      "This run has not recorded an output reference, which happens while it is still running or when it was refused before a model was called.",
    "unit.ms": "ms",
    "state.running": "Running",
    "state.awaiting_approval": "Awaiting approval",
    "state.succeeded": "Succeeded",
    "state.refused": "Refused",
    "state.failed": "Failed",
    "state.cancelled": "Cancelled",
    "state.budget_stopped": "Stopped by budget",
    "outcome.ok": "Ok",
    "outcome.error": "Error",
    "outcome.blocked": "Blocked",
    "outcome.refused": "Refused",
    "outcome.awaiting_approval": "Awaiting approval",
    "outcome.budget_exceeded": "Over budget",
    "outcome.killed": "AI paused",
    "autonomy.suggest": "Suggest only",
    "autonomy.act_with_approval": "Act with approval",
    "autonomy.act_within_limits": "Act within limits",
    "autonomy.autonomous": "Autonomous",
    "lede.succeeded": "This run finished and its output is ready below.",
    "lede.running": "This run is still in progress.",
    "lede.refused": "This run refused to act — see why below.",
    "lede.cancelled": "This run was cancelled before it finished."
  },
  ar: {
    back: "كل تشغيلات الوكلاء",
    "run.purpose": "المطلوب",
    "run.module": "الطالب",
    "run.trigger": "بدأه",
    "run.autonomy": "مستوى الاستقلالية حينها",
    "run.actor": "بالنيابة عن",
    "run.subject": "بشأن",
    "run.started": "بدأ",
    "run.ended": "انتهى",
    "run.latency": "استغرق",
    "run.cost": "التكلفة",
    "run.tokens": "الرموز الداخلة والخارجة",
    "run.confidence": "ثقة النموذج",
    "run.why": "لماذا شُغّل",
    "run.model": "النموذج",
    "run.provider": "المزوّد",
    "run.flags": "الضوابط التي عملت",
    "run.inputHash": "بصمة المدخل",
    "run.reasoning": "الاستدلال محفوظ",
    "failed.title": "لم ينتج عن هذا التشغيل جواب",
    "failed.reason": "انتهى التشغيل بهذه الحالة ولم يُكتب شيء بناءً عليه.",
    "stopped.title": "أوقفته الميزانية",
    "stopped.reason":
      "كان الحد اليومي مستنفدًا عندما طلب هذا التشغيل نموذجًا، فرُفض قبل شراء أي رموز.",
    "stopped.link": "فتح حدود الإنفاق",
    "approval.region": "بانتظار الموافقة",
    "approval.summary": "هذا التشغيل بانتظار قرار قبل أن يكتمل.",
    "approval.consequence": "بلغ الوكيل خطوة لا يُسمح له باتخاذها وحده عند مستوى استقلاليته الحالي.",
    "approval.blocked": "احسمه من شاشة الموافقات حيث يظهر الطلب كاملًا.",
    "tools.title": "الأدوات التي استخدمها",
    "tools.seq": "الخطوة",
    "tools.tool": "الأداة",
    "tools.outcome": "النتيجة",
    "tools.duration": "استغرق",
    "tools.consequential": "ذو أثر",
    "tools.args": "الوسائط",
    "tools.argsHash": "بصمة الوسائط",
    "tools.resultHash": "بصمة النتيجة",
    "tools.approval": "الموافقة",
    "tools.none.title": "لم تُستخدم أي أداة",
    "tools.none.body": "أجاب الوكيل من التوجيه وسياقه وحدهما.",
    "audit.title": "نداء النموذج خلفه",
    "audit.tier": "الفئة",
    "audit.outcome": "النتيجة",
    "audit.inputHash": "بصمة المدخل",
    "audit.outputHash": "بصمة المخرج",
    "audit.open": "فتح قيد التدقيق",
    "audit.none.title": "لا يوجد قيد تدقيق مرتبط",
    "audit.none.body":
      "لم يسجّل هذا التشغيل مرجع مخرج، وهو ما يحدث أثناء استمراره أو عند رفضه قبل نداء أي نموذج.",
    "unit.ms": "مللي ثانية",
    "state.running": "قيد التشغيل",
    "state.awaiting_approval": "بانتظار الموافقة",
    "state.succeeded": "نجح",
    "state.refused": "رُفض",
    "state.failed": "فشل",
    "state.cancelled": "أُلغي",
    "state.budget_stopped": "أوقفته الميزانية",
    "outcome.ok": "سليم",
    "outcome.error": "خطأ",
    "outcome.blocked": "محجوب",
    "outcome.refused": "رُفض",
    "outcome.awaiting_approval": "بانتظار الموافقة",
    "outcome.budget_exceeded": "تجاوز الميزانية",
    "outcome.killed": "الذكاء الاصطناعي موقوف",
    "autonomy.suggest": "اقتراح فقط",
    "autonomy.act_with_approval": "التنفيذ بموافقة",
    "autonomy.act_within_limits": "التنفيذ ضمن حدود",
    "autonomy.autonomous": "مستقل",
    "lede.succeeded": "اكتمل هذا التشغيل ومخرجه جاهز أدناه.",
    "lede.running": "هذا التشغيل ما زال جاريًا.",
    "lede.refused": "رفض هذا التشغيل التصرف — السبب أدناه.",
    "lede.cancelled": "أُلغي هذا التشغيل قبل اكتماله."
  }
};

type Label = (key: string, fallback?: string) => string;

function labeller(locale: string): Label {
  const t = translator(locale);
  return (key, fallback) => {
    const mine = LABELS[locale]?.[key] ?? LABELS["en"]?.[key];
    if (mine !== undefined) return pseudoText(locale, mine);
    // The shared catalogue is the last stop before the caller's own fallback —
    // the same fall-through `labelsFrom` (detail-kit.tsx) gives every screen
    // built on it, so words that read identically everywhere (an agent key, an
    // AI purpose) live in `common.` once instead of in each route's table.
    const shared = t(`common.${key}`);
    if (shared !== `common.${key}`) return shared;
    return pseudoText(locale, fallback ?? key);
  };
}

/* ------------------------------------------------------------------ shapes */

interface Run {
  id: string;
  agentKey: string;
  module: string;
  purpose: string;
  subjectRef: string | null;
  actorRef: string;
  autonomyLevel: string;
  trigger: string;
  state: string;
  inputHash: string;
  outputRef: string | null;
  confidence: number | null;
  evidenceJson: unknown;
  reasoningRef: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
  latencyMs: number;
  approvalId: string | null;
  errorCode: string | null;
  startedAt: number;
  endedAt: number | null;
}

interface ToolCall {
  id: string;
  seq: number;
  tool: string;
  argsHash: string;
  argsRedactedJson: unknown;
  consequential: boolean;
  approvalId: string | null;
  outcome: string;
  resultHash: string | null;
  durationMs: number | null;
  ts: number;
}

interface AuditRow {
  id: string;
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
  ts: number;
}

interface RunDetail {
  run: Run;
  toolCalls: ToolCall[];
  audit: AuditRow | null;
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  try {
    const detail = await api<RunDetail>(
      `/v1/ai/runs/${encodeURIComponent(params["id"] ?? "")}/detail`,
      { env, request }
    );
    // Who asked for this run is a colleague, and the audit trail stored them
    // as a ref. The directory names them; an actor who is a scheduler or a
    // webhook is not in it and keeps the ref.
    const people = await directory({ env, request });
    return { detail, people, status: 200 };
  } catch (error) {
    // A run the actor may not read, or one that is not there, is a page with an
    // explanation on it — never a blank screen or an error boundary.
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return { detail: null, people: [] as DirectoryEntry[], status: error.status };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ helpers */

function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parsed(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  blocked: "danger",
  budget_exceeded: "danger",
  killed: "danger"
};

const toneOf = (value: string): BadgeTone => STATE_TONES[value] ?? "neutral";

/**
 * A one-line status for the hero — only for states that have nothing else on
 * the page explaining them. `awaiting_approval`, `budget_stopped` and `failed`
 * already get their own notice further down (stopped.*, failed.*, approval.*);
 * repeating that here would be the same sentence twice.
 */
export function runLede(state: string, L: Label): string | null {
  switch (state) {
    case "succeeded":
      return L("lede.succeeded");
    case "running":
      return L("lede.running");
    case "refused":
      return L("lede.refused");
    case "cancelled":
      return L("lede.cancelled");
    default:
      return null;
  }
}

/** term/detail pairs, so the "why" reads as a record rather than a paragraph. */
function Pair({ term, detail }: { term: string; detail: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="min-w-0 break-words text-end font-ui text-13 text-text">{detail}</dd>
    </div>
  );
}

/* --------------------------------------------------------------- the screen */

export default function AiRun() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const L = labeller(locale);
  const nf = new Intl.NumberFormat(locale);

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link to={RUNS_LIST}>{L("back")}</Link>
    </Button>
  );

  if (!loaded.detail) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          title={loaded.status === 403 ? t("error.title") : t("error.notFound")}
          body={loaded.status === 403 ? t("error.forbidden") : t("error.generic")}
          action={back}
        />
      </div>
    );
  }

  const { run, toolCalls, audit } = loaded.detail;
  const evidence = parsed(run.evidenceJson);
  const flags = Array.isArray(evidence?.["flags"])
    ? (evidence["flags"] as unknown[]).filter((f): f is string => typeof f === "string")
    : [];

  const toolColumns: Array<Column<ToolCall>> = [
    { key: "seq", header: L("tools.seq"), numeric: true, render: (call) => nf.format(call.seq) },
    {
      key: "tool",
      header: L("tools.tool"),
      render: (call) => (
        <EvidenceLink
          sourceLabel={L("tools.args")}
          source={
            <dl className="flex max-w-xs flex-col gap-1">
              <Pair
                term={L("tools.argsHash")}
                detail={<code className="font-mono text-12 break-all">{call.argsHash}</code>}
              />
              {call.resultHash ? (
                <Pair
                  term={L("tools.resultHash")}
                  detail={<code className="font-mono text-12 break-all">{call.resultHash}</code>}
                />
              ) : null}
              {/* Focusable: redacted args run wide, and a scroller only a mouse
                  can reach strands the keyboard (WCAG 2.2 AA). */}
              {call.argsRedactedJson ? (
                <pre
                  tabIndex={0}
                  className={cn(
                    "overflow-x-auto rounded-sm bg-surface-1 p-2 font-mono text-12 text-muted",
                    focusRing
                  )}
                >
                  {JSON.stringify(call.argsRedactedJson, null, 2)}
                </pre>
              ) : null}
            </dl>
          }
        >
          <span className="font-mono text-12">{call.tool}</span>
        </EvidenceLink>
      )
    },
    {
      key: "consequential",
      header: L("tools.consequential"),
      // CLAUDE.md §4: a consequential step is the one a reader must be able to
      // find, so it is a column rather than a detail behind a popover.
      render: (call) =>
        call.consequential ? (
          <Badge tone="warning" size="sm">
            {t("common.yes")}
          </Badge>
        ) : (
          <span className="font-ui text-12 text-subtle">{t("common.no")}</span>
        )
    },
    {
      key: "outcome",
      header: L("tools.outcome"),
      render: (call) => (
        <Badge tone={toneOf(call.outcome)} size="sm">
          {L(`outcome.${call.outcome}`, call.outcome)}
        </Badge>
      )
    },
    {
      key: "durationMs",
      header: L("tools.duration"),
      numeric: true,
      render: (call) => (call.durationMs === null ? "—" : `${nf.format(call.durationMs)} ${L("unit.ms")}`)
    },
    {
      key: "approvalId",
      header: L("tools.approval"),
      render: (call) =>
        call.approvalId ? (
          <Link
            to="/approvals"
            className="font-mono text-12 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {shortRef(call.approvalId)}
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 page-title">
            <span aria-hidden="true">{AGENT_MARK}</span>{" "}
            <span className="font-mono">{run.agentKey}</span>
          </h1>
          <Badge tone={toneOf(run.state)}>{L(`state.${run.state}`, run.state)}</Badge>
        </div>
        {runLede(run.state, L) ? (
          <p className="max-w-prose font-ui text-13 text-muted">{runLede(run.state, L)}</p>
        ) : null}
        <p className="font-ui text-13 text-subtle">
          <DateTime value={run.startedAt} locale={locale} precision="second" />
          {" · "}
          {nf.format(run.latencyMs)} {L("unit.ms")}
          {" · "}
          <Money amountMinor={minorOf(run.costMicro)} currency={COST_CURRENCY} locale={locale} />
        </p>
      </header>

      {run.state === "budget_stopped" ? (
        <GuardrailNotice
          tone="danger"
          title={L("stopped.title")}
          reason={L("stopped.reason")}
          action={
            <Link
              to="/admin/ai/budget"
              className="font-ui text-13 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {L("stopped.link")}
            </Link>
          }
        />
      ) : run.state === "failed" || run.state === "refused" ? (
        <GuardrailNotice
          tone={run.state === "failed" ? "danger" : "warning"}
          title={L("failed.title")}
          reason={
            <span>
              {L("failed.reason")}
              {run.errorCode ? <code className="ms-2 font-mono text-12">{run.errorCode}</code> : null}
            </span>
          }
        />
      ) : null}

      {run.state === "awaiting_approval" ? (
        <ApprovalStrip
          label={L("approval.region")}
          summary={L("approval.summary")}
          consequence={L("approval.consequence")}
          blockedReason={
            <Link
              to="/approvals"
              className="text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {L("approval.blocked")}
            </Link>
          }
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {/* ------------------------------------------------------- tools */}
          <Card title={L("tools.title")}>
            <Table
              columns={toolColumns}
              rows={toolCalls}
              rowKey={(call) => call.id}
              caption={L("tools.title")}
              density="compact"
              empty={<EmptyState title={L("tools.none.title")} body={L("tools.none.body")} />}
            />
          </Card>

          {/* ------------------------------------------------------- audit */}
          <Card
            title={L("audit.title")}
            {...(audit
              ? {
                  actions: (
                    <Button variant="secondary" size="sm" asChild>
                      <Link to={`${AUDIT_RECORD}/${audit.id}`}>{L("audit.open")}</Link>
                    </Button>
                  )
                }
              : {})}
          >
            {audit ? (
              <dl className="flex flex-col gap-2">
                <Pair term={L("run.model")} detail={<span className="font-mono text-12">{audit.model}</span>} />
                <Pair term={L("run.provider")} detail={audit.provider} />
                <Pair term={L("audit.tier")} detail={audit.tier} />
                <Pair
                  term={L("audit.outcome")}
                  detail={
                    <Badge tone={toneOf(audit.outcome)} size="sm">
                      {L(`outcome.${audit.outcome}`, audit.outcome)}
                    </Badge>
                  }
                />
                <Pair
                  term={L("run.tokens")}
                  detail={`${nf.format(audit.tokensIn)} / ${nf.format(audit.tokensOut)}`}
                />
                <Pair
                  term={L("run.cost")}
                  detail={
                    <Money amountMinor={minorOf(audit.costMicro)} currency={COST_CURRENCY} locale={locale} />
                  }
                />
                <Pair
                  term={L("audit.inputHash")}
                  detail={<code className="font-mono text-12 break-all">{audit.inputHash}</code>}
                />
                <Pair
                  term={L("audit.outputHash")}
                  detail={
                    audit.outputHash ? (
                      <code className="font-mono text-12 break-all">{audit.outputHash}</code>
                    ) : (
                      "—"
                    )
                  }
                />
              </dl>
            ) : (
              <EmptyState title={L("audit.none.title")} body={L("audit.none.body")} />
            )}
          </Card>
        </div>

        {/* ---------------------------------------------------------- why */}
        <aside className="lg:sticky lg:top-6">
          <Card title={L("run.why")}>
            <div className="flex flex-col gap-4">
              <dl className="flex flex-col gap-2">
                <Pair term={L("run.purpose")} detail={optionLabel(L, "purpose", run.purpose)} />
                <Pair term={L("run.module")} detail={moduleName(t, run.module)} />
                <Pair term={L("run.trigger")} detail={humanise(run.trigger)} />
                <Pair
                  term={L("run.autonomy")}
                  detail={L(`autonomy.${run.autonomyLevel}`, run.autonomyLevel)}
                />
                <Pair
                  term={L("run.actor")}
                  detail={<span className="break-all">{whoIs(loaded.people, run.actorRef) ?? run.actorRef}</span>}
                />
                {run.subjectRef ? (
                  <Pair
                    term={L("run.subject")}
                    detail={<Ref value={run.subjectRef} className="break-all text-12" />}
                  />
                ) : null}
                {run.endedAt ? (
                  <Pair
                    term={L("run.ended")}
                    detail={<DateTime value={run.endedAt} locale={locale} precision="second" />}
                  />
                ) : null}
                <Pair
                  term={L("run.inputHash")}
                  detail={<code className="font-mono text-12 break-all">{run.inputHash}</code>}
                />
                {flags.length ? <Pair term={L("run.flags")} detail={flags.join(", ")} /> : null}
                {run.reasoningRef ? (
                  <Pair term={L("run.reasoning")} detail={t("common.yes")} />
                ) : null}
              </dl>
              {run.confidence === null ? null : (
                <ConfidenceMeter value={run.confidence / 100} label={L("run.confidence")} />
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
