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
  Button,
  Card,
  DateTime,
  EmptyState,
  KPIWall,
  Select,
  Sparkline,
  Stat,
  Textarea
} from "@lyra/ui";
import { Eyebrow, Figure, Hairline, Lede, Panel, Ref } from "@lyra/ui";
import type { LyraModule } from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { moduleName, translator } from "../i18n";
import { policyTitle } from "../policy";
import { ConfirmButton } from "../components/confirm";
import { labelsFrom, type Label } from "./detail-kit";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// ADR-0073 — the Command Center. One surface where the tenant sees what its AI
// is doing across every module: the proposals waiting for a human, the runs
// that produced them, and one box to put the loop to work. The grammar is
// Horizon (eyebrow → lede → panel); AI artifacts carry the single ✦ mark and an
// inspectable "why" (docs/15 §4). Nothing here auto-runs: actioning a proposal
// walks the module's real engine path, where the approval gate fires.

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Command center",
    intro: "One loop across every module. The AI reads, reasons and proposes — a person decides.",
    "ask.title": "Put the loop to work",
    "ask.placeholder": 'Ask across modules — e.g. "Which motor policies renewed last month and had a claim within 30 days?"',
    "ask.run": "Run",
    "ask.running": "Running…",
    "ask.agent": "Agent",
    "feed.why": "Why",
    "feed.title": "Waiting for a decision",
    "feed.empty": "Nothing is waiting on you.",
    "feed.empty.body": "Proposals appear here when a run wants to change something.",
    "feed.act": "Act",
    "feed.actConfirm": "{what} needs an approval before it takes effect. Raise it now?",
    "feed.dismiss": "Dismiss",
    "feed.done.title": "Recently decided",
    "runs.title": "Recent runs",
    "runs.empty": "No runs yet.",
    "runs.empty.body": "Start with a question above — a run reads the platform and comes back with what it found.",
    "runs.rounds": "rounds",
    "runs.proposals": "proposals",
    "answer.title": "The loop's answer",
    "hero.waiting": "Waiting on you",
    "hero.runs24h": "Runs · 24h",
    "hero.modules": "Modules connected",
    "hero.autonomy": "Autonomy",
    "constellation.title": "The loop's reach",
    "constellation.hint": "Each module the registry can read. Connections light where a run touched two."
  },
  ar: {
    title: "مركز القيادة",
    intro: "حلقة واحدة عبر كل الوحدات. يقرأ الذكاء الاصطناعي ويستنتج ويقترح — والإنسان يقرر.",
    "ask.title": "شغّل الحلقة",
    "ask.placeholder": "اسأل عبر الوحدات — مثال: «أي وثائق المحرك جدّدت الشهر الماضي وكان لها مطالبة خلال 30 يوماً؟»",
    "ask.run": "تشغيل",
    "ask.running": "جارٍ التشغيل…",
    "ask.agent": "الوكيل",
    "feed.why": "لماذا",
    "feed.title": "بانتظار قرارك",
    "feed.empty": "لا شيء بانتظارك.",
    "feed.empty.body": "تظهر المقترحات هنا عندما يريد تشغيل ما تغيير شيء.",
    "feed.act": "تنفيذ",
    "feed.actConfirm": "يحتاج {what} إلى موافقة قبل أن يسري. هل ترفع الطلب الآن؟",
    "feed.dismiss": "تجاهل",
    "feed.done.title": "قرارات حديثة",
    "runs.title": "التشغيلات الأخيرة",
    "runs.empty": "لا تشغيلات بعد.",
    "runs.empty.body": "ابدأ بسؤال أعلاه — يقرأ التشغيل المنصّة ويعود بما وجده.",
    "runs.rounds": "جولات",
    "runs.proposals": "مقترحات",
    "answer.title": "إجابة الحلقة",
    "hero.waiting": "بانتظار قرارك",
    "hero.runs24h": "تشغيلات · 24س",
    "hero.modules": "وحدات متصلة",
    "hero.autonomy": "الاستقلالية",
    "constellation.title": "مدى الحلقة",
    "constellation.hint": "كل وحدة يستطيع السجل قراءتها. تضيء الروابط حيث لمست التشغيل وحدتين."
  }
};

/** Pack-aware via the shared kit (detail-kit labelsFrom): a domain pack may
 *  rename "policy" nouns on this surface too, so the tenant's pack rides the
 *  same resolution chain as every other screen. */

/* ------------------------------------------------------------------- shapes */

interface Proposal {
  id: string;
  runId: string;
  module: string;
  toolName: string;
  subjectRef: string | null;
  policyKey: string | null;
  argsJson: string;
  whyJson: string | null;
  state: string;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

interface RunRow {
  id: string;
  agentKey: string;
  module: string;
  state: string;
  evidenceJson: string | null;
  startedAt: number;
}

interface AgentOption {
  key: string;
  module: string;
}

interface Page<T> {
  data: T[];
}

async function readable<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.problem.status === 403 || error.problem.status === 404)) return null;
    throw error;
  }
}

/* ------------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };

  const [proposed, decidedRows, runs, agents] = await Promise.all([
    readable(api<Page<Proposal>>("/v1/ai/command/proposals?state=proposed", opts)),
    readable(api<Page<Proposal>>("/v1/ai/command/proposals?state=actioned", opts)),
    readable(api<Page<RunRow>>("/v1/ai/runs?sort=startedAt&order=desc&limit=12", opts)),
    readable(api<Page<AgentOption>>("/v1/ai/agents?sort=key&order=asc&limit=100", opts))
  ]);

  // The session's locale rides the shell data; read it through the cookie the
  // same way workspace.tsx does rather than re-running its loader.
  const cookie = request.headers.get("cookie") ?? "";
  const match = /lyra_locale=([^;]+)/.exec(cookie);
  const locale = match ? decodeURIComponent(match[1]!) : "en";

  return {
    proposals: proposed?.data ?? [],
    decided: (decidedRows?.data ?? []).slice(0, 10),
    runs: runs?.data ?? [],
    agents: agents?.data ?? [],
    locale
  };
}

/* ------------------------------------------------------------------- action */

interface ActionResult {
  problem: { title: string; detail?: string; requestId?: string } | null;
  /** The loop's answer when a run completed. */
  answer: { runId: string; text: string; rounds: number; proposalCount: number } | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "run") {
      const res = await api<{ runId: string; text: string; rounds: unknown[]; proposalIds: string[] }>(
        "/v1/ai/command/runs",
        {
          env,
          request,
          method: "POST",
          body: JSON.stringify({
            agentKey: String(form.get("agentKey") ?? "copilot"),
            purpose: "command.center",
            input: String(form.get("input") ?? "")
          })
        }
      );
      return {
        problem: null,
        answer: {
          runId: res.runId,
          text: res.text,
          rounds: res.rounds.length,
          proposalCount: res.proposalIds.length
        }
      };
    }

    if (intent === "act" || intent === "dismiss") {
      const id = String(form.get("proposalId") ?? "");
      await api(`/v1/ai/command/proposals/${id}/${intent === "act" ? "action" : "dismiss"}`, {
        env,
        request,
        method: "POST",
        body: JSON.stringify({})
      });
      return { problem: null, answer: null };
    }

    return { problem: { title: "Unknown intent" }, answer: null };
  } catch (error) {
    if (error instanceof ApiError) {
      const { title, detail } = error.problem;
      return {
        problem: { title, ...(detail ? { detail } : {}), ...(error.requestId ? { requestId: error.requestId } : {}) },
        answer: null
      };
    }
    throw error;
  }
}

/* --------------------------------------------------------------------- view */

const MODULE_TONE: Record<string, "info" | "success" | "warning" | "neutral"> = {
  axis: "info",
  orbit: "success",
  signal: "warning",
  scout: "neutral",
  north: "info",
  ledger: "success"
};

/** The modules the Horizon hue knows (packages/ui nav.tsx); "ai" itself is not
 *  one, so those panels fall back to the shell's own accent. */
function hueModule(module: string): LyraModule | null {
  return ["axis", "orbit", "signal", "scout", "north"].includes(module) ? (module as LyraModule) : null;
}

/** The five shells the constellation draws. Ledger and dist read through the
 *  registry too but carry no hue of their own; they light through the five. */
const CONSTELLATION: { id: LyraModule; label: string; labelAr: string }[] = [
  { id: "axis", label: "Operations", labelAr: "العمليات" },
  { id: "orbit", label: "Conversations", labelAr: "المحادثات" },
  { id: "signal", label: "Marketing", labelAr: "التسويق" },
  // The rail's own names (nav.scout, nav.north): one module, one name.
  { id: "scout", label: "Market", labelAr: "السوق" },
  { id: "north", label: "Insight", labelAr: "التحليلات التنفيذية" }
];

function humaniseTool(name: string): string {
  return name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function Why({ proposal, t }: { proposal: Proposal; t: Label }) {
  const [open, setOpen] = React.useState(false);
  let reason = "";
  try {
    reason = (JSON.parse(proposal.whyJson ?? "{}") as { reason?: string }).reason ?? "";
  } catch {
    // unparseable why renders as nothing rather than raw JSON
  }
  if (!reason) return <span className="text-13 text-subtle">—</span>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-13 underline decoration-dotted underline-offset-2 hover:opacity-80"
      >
        <span aria-hidden="true">{AGENT_MARK}</span> {t("feed.why")}
      </button>
      {open ? (
        <p className="mt-1 max-w-prose border-s-2 border-current/20 ps-2 text-13 text-muted">{reason}</p>
      ) : null}
    </div>
  );
}

export default function CommandCenter() {
  const { proposals, decided, runs, agents, locale } = useLoaderData<typeof loader>();
  const action = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const shell = useShellData();
  const t = labelsFrom(LABELS)(locale, shell?.domainPack);
  const shared = translator(locale, shell?.overrides);
  const running = navigation.state !== "idle";

  // Hero numbers: what is waiting, how hard the loop has worked today, and
  // which modules it can reach. Derived from the same loader data the feed
  // renders — no second round trip.
  const dayAgo = Date.now() - 24 * 3_600_000;
  const runs24h = runs.filter((r) => r.startedAt >= dayAgo).length;
  const touchedModules = new Set<string>([...proposals.map((p) => p.module), ...runs.map((r) => r.module)]);
  const connectedCount = CONSTELLATION.filter((m) => touchedModules.has(m.id)).length;
  const roundsByRun = runs.map((r) => {
    try {
      return ((JSON.parse(r.evidenceJson ?? "{}") as { rounds?: unknown[] }).rounds ?? []).length;
    } catch {
      return 0;
    }
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <Eyebrow>
        <span aria-hidden="true">{AGENT_MARK}</span> {shared("nav.ai")}
      </Eyebrow>
      <h1 className="page-title">{t("title")}</h1>
      <Lede className="mt-2 max-w-prose">{t("intro")}</Lede>

      {/* ------------------------------------------------------- hero wall */}
      <KPIWall className="mt-8">
        <Stat label={t("hero.waiting")} value={proposals.length} live />
        <Stat label={t("hero.runs24h")} value={runs24h} hint={`${runs.length} ${t("runs.title").toLowerCase()}`} />
        <Stat label={t("hero.modules")} value={`${connectedCount}/${CONSTELLATION.length}`} />
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{t("hero.autonomy")}</span>
          <Sparkline values={roundsByRun.length ? roundsByRun : [0]} label={t("runs.rounds")} tone="info" className="max-w-32" />
        </div>
      </KPIWall>

      {/* --------------------------------------------------- constellation */}
      <section className="mt-10" aria-labelledby="cc-map">
        <h2 id="cc-map" className="section-title">{t("constellation.title")}</h2>
        <Hairline className="my-3" />
        <ul className="flex flex-wrap items-center gap-x-8 gap-y-4">
          {CONSTELLATION.map((m) => {
            const lit = touchedModules.has(m.id);
            const count = proposals.filter((p) => p.module === m.id).length;
            return (
              <li key={m.id} className="flex items-center gap-2" title={lit ? `${count} ${t("runs.proposals")}` : undefined}>
                <span
                  aria-hidden="true"
                  className={`size-2.5 rounded-full transition-opacity ${lit ? "" : "opacity-25"}`}
                  style={{ background: `var(--module-${m.id})` }}
                />
                <span className={`text-13 ${lit ? "font-medium text-text" : "text-subtle"}`}>
                  {locale === "ar" ? m.labelAr : m.label}
                </span>
                {count > 0 ? (
                  <Badge tone="warning" size="sm">{count}</Badge>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-12 text-subtle">{t("constellation.hint")}</p>
      </section>

      {action?.problem ? (
        <div className="mt-6">
          <Problem problem={action.problem} />
        </div>
      ) : null}

      {/* ---------------------------------------------------- ask the loop */}
      <section className="mt-8" aria-labelledby="cc-ask">
        <h2 id="cc-ask" className="sr-only">
          {t("ask.title")}
        </h2>
        <Card className="p-5">
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="run" />
            <div className="flex items-center gap-3">
              <label htmlFor="cc-agent" className="text-13 font-medium whitespace-nowrap">
                {t("ask.agent")}
              </label>
              <Select
                name="agentKey"
                defaultValue="copilot"
                aria-label={t("ask.agent")}
                options={agents.map((a) => ({ value: a.key, label: `${humaniseTool(a.key)} · ${moduleName(shared, a.module)}` }))}
              />
            </div>
            <Textarea
              name="input"
              required
              minLength={2}
              rows={3}
              placeholder={t("ask.placeholder")}
              aria-label={t("ask.title")}
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={running}>
                {running ? t("ask.running") : t("ask.run")}
              </Button>
            </div>
          </Form>

          {action?.answer ? (
            <div className="mt-4 border-t border-current/10 pt-4">
              <p className="text-13 font-medium text-muted">
                <span aria-hidden="true">{AGENT_MARK}</span> {t("answer.title")}
              </p>
              <p className="mt-1 max-w-prose whitespace-pre-wrap text-16 leading-relaxed">{action.answer.text}</p>
              <p className="mt-2 text-12 text-subtle">
                {action.answer.rounds} {t("runs.rounds")} ·{" "}
                {action.answer.proposalCount > 0
                  ? `${action.answer.proposalCount} ${t("runs.proposals")} ↓`
                  : `0 ${t("runs.proposals")}`}
              </p>
            </div>
          ) : null}
        </Card>
      </section>

      {/* ------------------------------------------------ proposal feed */}
      <section className="mt-10" aria-labelledby="cc-feed">
        <h2 id="cc-feed" className="section-title">
          {t("feed.title")}
        </h2>
        <Hairline className="my-3" />
        {proposals.length === 0 ? (
          <EmptyState title={t("feed.empty")} body={t("feed.empty.body")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {proposals.map((p) => {
              let argSummary = "";
              try {
                const args = JSON.parse(p.argsJson) as Record<string, unknown>;
                argSummary = Object.entries(args)
                  .filter(([k]) => k !== "policyId")
                  .slice(0, 3)
                  .map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : String(v).slice(0, 40)}`)
                  .join(" · ");
              } catch {
                // malformed args render as nothing rather than raw JSON
              }
              return (
              <li key={p.id}>
                <Panel module={hueModule(p.module)} className="p-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Badge tone={MODULE_TONE[p.module] ?? "neutral"}>{moduleName(shared, p.module)}</Badge>
                    <span className="text-14 font-medium">{humaniseTool(p.toolName)}</span>
                    {p.subjectRef ? <Ref value={p.subjectRef} className="text-12 text-subtle" /> : null}
                    {/* Which approval acting would raise, named as the queue names it. */}
                    {p.policyKey ? (
                      <Badge tone="warning" size="sm">{policyTitle(p.policyKey, p.module, locale)}</Badge>
                    ) : null}
                    <span className="ms-auto text-12 text-subtle">
                      <DateTime value={p.createdAt} relative />
                    </span>
                  </div>
                  {argSummary ? (
                    <p className="mt-1.5 truncate font-mono text-12 text-subtle" dir="ltr">{argSummary}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <Why proposal={p} t={t} />
                    <div className="flex gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="dismiss" />
                        <input type="hidden" name="proposalId" value={p.id} />
                        <Button type="submit" variant="ghost" disabled={running}>
                          {t("feed.dismiss")}
                        </Button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="act" />
                        <input type="hidden" name="proposalId" value={p.id} />
                        {/* A proposal that names an approval policy is
                            consequential (CLAUDE.md §4): ask once first. */}
                        {p.policyKey ? (
                          <ConfirmButton type="submit" disabled={running} message={t("feed.actConfirm", { what: humaniseTool(p.toolName) })}>
                            {t("feed.act")}
                          </ConfirmButton>
                        ) : (
                          <Button type="submit" disabled={running}>
                            {t("feed.act")}
                          </Button>
                        )}
                      </Form>
                    </div>
                  </div>
                </Panel>
              </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------------- runs */}
      <section className="mt-10" aria-labelledby="cc-runs">
        <h2 id="cc-runs" className="section-title">
          {t("runs.title")}
        </h2>
        <Hairline className="my-3" />
        {runs.length === 0 ? (
          <EmptyState title={t("runs.empty")} body={t("runs.empty.body")} />
        ) : (
          <ul className="flex flex-col divide-y divide-current/10">
            {runs.map((r) => {
              let rounds = 0;
              try {
                rounds = ((JSON.parse(r.evidenceJson ?? "{}") as { rounds?: unknown[] }).rounds ?? []).length;
              } catch {
                // evidence is optional
              }
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <Badge tone={r.state === "succeeded" ? "success" : r.state === "failed" ? "danger" : "neutral"}>
                    {r.state}
                  </Badge>
                  <span className="text-13 font-medium">{r.agentKey}</span>
                  <span className="text-12 text-subtle">{moduleName(shared, r.module)}</span>
                  <Figure size="sm" value={`${rounds}`} unit={t("runs.rounds")} />
                  <span className="ms-auto text-12 text-subtle">
                    <DateTime value={r.startedAt} relative />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------- decided */}
      {decided.length > 0 ? (
        <section className="mt-10" aria-labelledby="cc-decided">
          <h2 id="cc-decided" className="section-title">
            {t("feed.done.title")}
          </h2>
          <Hairline className="my-3" />
          <ul className="flex flex-col divide-y divide-current/10">
            {decided.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <Badge tone={p.state === "actioned" ? "success" : "neutral"}>{p.state}</Badge>
                <span className="text-13">{humaniseTool(p.toolName)}</span>
                <span className="ms-auto text-12 text-subtle">
                  {p.decidedAt ? <DateTime value={p.decidedAt} relative /> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
