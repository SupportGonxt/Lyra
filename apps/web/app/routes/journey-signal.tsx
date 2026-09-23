import * as React from "react";
import { AgentBadge, Badge, Button, Card, Hero, hueVar, renderSection, type HeroChip, type Section } from "@lyra/ui";
import { Form, Link, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { JourneyHeader, JourneyNav, counted, journeyLabels } from "../components/journey-nav";
import { translator, DEFAULT_LOCALE } from "../i18n";
import { RequestId } from "./module";
import { readable } from "./north-shared";
import { useShellData } from "./workspace";

interface Attribute {
  axis: string;
  value: string;
}

interface DemographicReason extends Attribute {
  reason: string;
}

interface TargetingProposal {
  name: string;
  summary: string;
  demographics: Attribute[];
  reasons: DemographicReason[];
}

/** Mirrors `SuggestedAudience` in apps/api/src/engines/signal-audience.ts. */
interface SuggestedAudience {
  audienceId: string;
  proposal: TargetingProposal;
  source: "ai" | "fallback";
}

interface ComplianceFinding {
  code: string;
  message: string;
}

/** Mirrors `GeneratedVariant` in apps/api/src/engines/signal-creative.ts. */
interface GeneratedVariant {
  id: string;
  locale: string;
  text: string;
  complianceStatus: "passed" | "flagged";
  complianceFindings: ComplianceFinding[];
}

interface GenerateCreativesResult {
  variants: GeneratedVariant[];
}

/** The whitespace fields the brief is written from (GET /v1/scout/whitespaces/:id/commentary). */
interface WhitespaceContext {
  category: string | null;
  commentary: string | null;
  why: string[];
}

/** The fields of the created `signal_campaigns` row this screen says anything about. */
interface CampaignRow {
  id: string;
  name: string;
  state: string;
}

/** `briefSchema.brief` in apps/api/src/routes/signal.ts is `.max(4_000)`. */
const BRIEF_MAX = 4_000;
/** The approval a campaign's move to live runs through (apps/api/src/resources.ts, campaigns). */
const LAUNCH_POLICY = "signal.campaign_launch";

const LABELS = {
  en: {
    title: "Turn the gap into a campaign",
    heroEyebrow: "Campaign draft",
    drafting: "Drafting for {subject}.",
    draftingBlank: "Name what the campaign is about to start a draft.",
    "creative.one": "{n} creative drafted",
    "creative.other": "{n} creatives drafted",
    audience: "Audience",
    creatives: "Creatives",
    "compliance.passed": "Passed compliance",
    "compliance.flagged": "Needs review",
    passedNote: "{pct} ready for review",
    flaggedNote: "{pct} need changes before review",
    complianceBars: "Creatives by compliance status",
    ofTotal: "{n} of {total}",
    subject: "What the campaign is about",
    suggestCard: "Suggest an audience",
    suggest: "Suggest audience",
    audienceWhy: "Proposed by the audience agent from attribute counts above this business's privacy floor, for “{subject}”. The reasons below are its own.",
    fallback: "Proposed by the rules fallback because no model answered; no AI was used.",
    generateCard: "Draft the creatives",
    generate: "Draft creatives",
    brief: "Brief: {summary}",
    briefCarries: "The brief also carries the gap you chose in the Market step.",
    creativeWhy: "Drafted by the creative agent from the brief above, in English and Arabic. Each draft was checked for compliance on the way out. Nothing has been sent or published.",
    saveCard: "Save as a draft campaign",
    saveBody: "Saves the campaign with this audience, no channels and no budget. Nothing goes live and nothing is sent.",
    saveBodyBare: "Saves the campaign with no audience, no channels and no budget yet. Nothing goes live and nothing is sent.",
    save: "Save as draft campaign",
    savedTitle: "Saved as a draft",
    savedBody: "“{name}” is a draft. Nothing is live and nothing was sent.",
    nextTitle: "Next: going live",
    nextBody: "Moving this campaign to live runs through the {policy} approval. Your business's policy decides whether a person has to sign it off — nothing here launches it.",
    openCampaign: "Open the campaign",
    openStudio: "Write more copy in the studio",
    "problem.subject_required": "Name what the campaign is about first.",
    "problem.brief_required": "There is no brief to draft from yet — suggest an audience first.",
    "problem.no_pool": "There are not enough customers sharing any one attribute to propose an audience without singling people out. You can still save the draft and choose an audience later.",
    "problem.currency_missing": "This business has no currency set, so a budget cannot be drafted. An administrator can set one in settings.",
    "problem.forbidden": "Your roles do not let you do this step. Someone who runs marketing can.",
    "problem.failed": "That did not go through. Nothing was saved, and you can try again."
  },
  ar: {
    title: "حوّل الفجوة إلى حملة",
    heroEyebrow: "مسودة حملة",
    drafting: "صياغة لـ{subject}.",
    draftingBlank: "اذكر موضوع الحملة لبدء مسودة.",
    "creative.zero": "لم تُصَغ أي مادة إبداعية",
    "creative.one": "صيغت مادة إبداعية واحدة",
    "creative.two": "صيغت مادتان إبداعيتان",
    "creative.few": "صيغت {n} مواد إبداعية",
    "creative.many": "صيغت {n} مادة إبداعية",
    "creative.other": "صيغت {n} مادة إبداعية",
    audience: "الجمهور",
    creatives: "المواد الإبداعية",
    "compliance.passed": "اجتازت الامتثال",
    "compliance.flagged": "تحتاج مراجعة",
    passedNote: "{pct} جاهزة للمراجعة",
    flaggedNote: "{pct} تحتاج تعديلًا قبل المراجعة",
    complianceBars: "المواد الإبداعية حسب حالة الامتثال",
    ofTotal: "{n} من {total}",
    subject: "موضوع الحملة",
    suggestCard: "اقترح جمهورًا",
    suggest: "اقتراح الجمهور",
    audienceWhy: "اقترحه وكيل الجمهور من أعداد السمات التي تتجاوز حد الخصوصية لهذا العمل، لموضوع «{subject}». الأسباب أدناه أسبابه.",
    fallback: "اقترحته القواعد الاحتياطية لأن أي نموذج لم يُجب؛ لم يُستخدم الذكاء الاصطناعي.",
    generateCard: "صِغ المواد الإبداعية",
    generate: "صياغة المواد الإبداعية",
    brief: "الموجز: {summary}",
    briefCarries: "يحمل الموجز أيضًا الفجوة التي اخترتها في خطوة السوق.",
    creativeWhy: "صاغها الوكيل الإبداعي من الموجز أعلاه بالعربية والإنجليزية. فُحصت كل مسودة للامتثال عند صياغتها. لم يُرسل أو يُنشر أي شيء.",
    saveCard: "احفظ كمسودة حملة",
    saveBody: "تُحفظ الحملة بهذا الجمهور دون قنوات ودون ميزانية. لا يصبح شيء مباشرًا ولا يُرسل شيء.",
    saveBodyBare: "تُحفظ الحملة دون جمهور ودون قنوات ودون ميزانية حتى الآن. لا يصبح شيء مباشرًا ولا يُرسل شيء.",
    save: "حفظ كمسودة حملة",
    savedTitle: "حُفظت كمسودة",
    savedBody: "«{name}» مسودة. لا شيء مباشر ولم يُرسل شيء.",
    nextTitle: "التالي: الإطلاق",
    nextBody: "يمرّ نقل هذه الحملة إلى الإطلاق بموافقة {policy}. تحدد سياسة عملك ما إذا كان يلزم توقيع شخص — لا شيء هنا يطلقها.",
    openCampaign: "افتح الحملة",
    openStudio: "اكتب مزيدًا من النصوص في الاستوديو",
    "problem.subject_required": "اذكر موضوع الحملة أولًا.",
    "problem.brief_required": "لا يوجد موجز للصياغة منه بعد — اقترح جمهورًا أولًا.",
    "problem.no_pool": "لا يوجد عدد كافٍ من العملاء يشتركون في سمة واحدة لاقتراح جمهور دون تمييز أفراد بعينهم. لا يزال بإمكانك حفظ المسودة واختيار جمهور لاحقًا.",
    "problem.currency_missing": "لم تُحدَّد عملة لهذا العمل، لذا لا يمكن صياغة ميزانية. يمكن للمسؤول تحديدها من الإعدادات.",
    "problem.forbidden": "لا تسمح لك أدوارك بهذه الخطوة. يستطيع ذلك من يدير التسويق.",
    "problem.failed": "لم يتم ذلك. لم يُحفظ شيء، ويمكنك المحاولة مجددًا."
  }
};

export const labelsIn = journeyLabels(LABELS);

/** Titles this screen raises itself; anything else is read by its status. */
const OWN_PROBLEMS = new Set(["subject_required", "brief_required", "no_pool", "currency_missing"]);

/** The label key for a problem. A raw API title (`subject_required`) is never shown. */
export function problemKey(problem: Pick<Problem, "title" | "status">): string {
  if (OWN_PROBLEMS.has(problem.title)) return `problem.${problem.title}`;
  if (problem.status === 403) return "problem.forbidden";
  return "problem.failed";
}

/**
 * The creative brief: what the campaign is about, what the Market step found
 * about that gap and why, then who it is for. The creatives route has no
 * context field for a campaign nobody planned (apps/api/src/routes/signal.ts
 * GenerateBody), so the whitespace travels in the brief itself.
 */
export function draftBrief({
  subject,
  summary,
  whitespace
}: {
  subject: string;
  summary: string;
  whitespace: WhitespaceContext | null;
}): string {
  const found = whitespace ? [whitespace.commentary ?? "", ...whitespace.why].filter(Boolean).join("\n") : "";
  const parts = [subject, found, summary].filter(Boolean);
  const brief = parts.join("\n\n");
  if (brief.length <= BRIEF_MAX) return brief;
  // Trim what the Market step found, never who the campaign is for.
  const room = BRIEF_MAX - subject.length - summary.length - 4;
  return [subject, found.slice(0, Math.max(0, room)), summary].filter(Boolean).join("\n\n").slice(0, BRIEF_MAX);
}

/**
 * The create body for POST /v1/signal/campaigns (resources.ts `campaigns`,
 * required columns from packages/db/src/schema/signal.ts). A draft carries no
 * channel and no budget — those are spend decisions, the same line
 * scout-promote.ts draws — and never a `state`: the default is "draft", and
 * going live is an update gated by `signal.campaign_launch`.
 */
export function campaignDraft({
  subject,
  audienceId,
  audienceName,
  ownerRef,
  currency
}: {
  subject: string;
  audienceId: string;
  audienceName: string;
  ownerRef: string;
  currency: string;
}) {
  return {
    name: [subject, audienceName].filter(Boolean).join(" — ").slice(0, 200),
    objective: "acq",
    ...(audienceId ? { audienceId } : {}),
    channelsJson: [] as string[],
    budgetJson: { currency, dailyMinor: 0, totalMinor: 0 },
    ownerRef
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    subject: url.searchParams.get("subject") ?? "",
    whitespaceId: url.searchParams.get("whitespaceId") ?? ""
  };
}

export interface ActionResult {
  problem: Problem | null;
  audience: (SuggestedAudience & { subject: string }) | null;
  creatives: GenerateCreativesResult | null;
  campaign: CampaignRow | null;
}

const refuse = (title: string): ActionResult => ({
  problem: { title, status: 400 },
  audience: null,
  creatives: null,
  campaign: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const subject = String(form.get("subject") ?? "").trim();
  const none = { problem: null, audience: null, creatives: null, campaign: null };

  try {
    if (intent === "suggest_audience") {
      if (subject === "") return refuse("subject_required");
      try {
        const audience = await api<SuggestedAudience>("/v1/signal/audiences/suggest", {
          env,
          request,
          method: "POST",
          body: { subject }
        });
        return { ...none, audience: { ...audience, subject } };
      } catch (error) {
        // 409 here is signal-audience.ts saying no customer attribute survives
        // the k-anonymity floor — a fact about the book, not a retryable fault.
        if (error instanceof ApiError && error.status === 409) {
          return { ...none, problem: { ...error.problem, title: "no_pool", ...(error.requestId ? { requestId: error.requestId } : {}) } };
        }
        throw error;
      }
    }

    if (intent === "generate_creatives") {
      const summary = String(form.get("brief") ?? "").trim();
      if (summary === "") return refuse("brief_required");
      const whitespaceId = String(form.get("whitespaceId") ?? "").trim();
      // The gap the reader chose. One they may not read (no scout grant) or
      // that has gone is not a reason to refuse the draft: it is briefed from
      // the audience alone, which is what this step did before.
      const whitespace = whitespaceId
        ? await readable(
            api<WhitespaceContext>(`/v1/scout/whitespaces/${encodeURIComponent(whitespaceId)}/commentary`, {
              env,
              request
            })
          )
        : null;
      const creatives = await api<GenerateCreativesResult>("/v1/signal/creatives/generate", {
        env,
        request,
        method: "POST",
        body: { kind: "ad", brief: draftBrief({ subject, summary, whitespace }), count: 3, locales: ["en", "ar"] }
      });
      return { ...none, creatives };
    }

    if (intent === "save_draft") {
      if (subject === "") return refuse("subject_required");
      const audienceId = String(form.get("audienceId") ?? "").trim();
      const whitespaceId = String(form.get("whitespaceId") ?? "").trim();
      const me = await fetchMe(env, request);
      const currency = typeof me.policy?.currency === "string" ? me.policy.currency : "";
      if (currency === "") return refuse("currency_missing");
      const campaign = await api<CampaignRow>("/v1/signal/campaigns", {
        env,
        request,
        method: "POST",
        // One draft per reader per audience (or, before there is one, per
        // whitespace or subject): a double submit replays the first create
        // instead of writing a second campaign (packages/core idempotency.ts).
        // The actor is in the key so two people are never handed each other's.
        headers: { "idempotency-key": `journey-draft:${me.actor.id}:${audienceId || whitespaceId || subject}` },
        body: campaignDraft({
          subject,
          audienceId,
          audienceName: String(form.get("audienceName") ?? "").trim(),
          ownerRef: `${me.actor.kind}:${me.actor.id}`,
          currency
        })
      });
      return { ...none, campaign: { id: campaign.id, name: campaign.name, state: campaign.state } };
    }

    return refuse("bad_intent");
  } catch (error) {
    if (error instanceof ApiError) {
      return { ...none, problem: { ...error.problem, ...(error.requestId ? { requestId: error.requestId } : {}) } };
    }
    throw error;
  }
}

function groupByComplianceStatus(variants: GeneratedVariant[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of variants) counts.set(v.complianceStatus, (counts.get(v.complianceStatus) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
}

export default function JourneySignal({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { subject, whitespaceId } = loaderData;
  const shell = useShellData();
  const locale = shell?.locale ?? DEFAULT_LOCALE;
  const pack = shell?.domainPack;
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, pack);
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [audience, setAudience] = React.useState<ActionResult["audience"]>(null);
  const [creatives, setCreatives] = React.useState<GenerateCreativesResult | null>(null);
  const [campaign, setCampaign] = React.useState<CampaignRow | null>(null);

  React.useEffect(() => {
    if (result?.audience) {
      setAudience(result.audience);
      setCreatives(null);
      setCampaign(null);
    }
    if (result?.creatives) setCreatives(result.creatives);
    if (result?.campaign) setCampaign(result.campaign);
  }, [result]);

  const num = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const total = creatives?.variants.length ?? 0;
  const complianceGroups = creatives ? groupByComplianceStatus(creatives.variants) : [];
  const maxComplianceCount = Math.max(1, ...complianceGroups.map((g) => g.count));
  const statusLabel = (status: string) => l(`compliance.${status === "passed" ? "passed" : "flagged"}`);
  const share = (count: number) => pct.format(count / (total || 1));
  const drafting = audience?.subject || subject;

  const complianceBars: Section = {
    kind: "bars",
    title: l("complianceBars"),
    items: complianceGroups.map((g) => ({
      label: statusLabel(g.status),
      value: l("ofTotal", { n: num.format(g.count), total: num.format(total) }),
      w: `${Math.max(4, Math.round((g.count / maxComplianceCount) * 100))}%`,
      hue: g.status === "passed" ? "var(--success)" : "var(--warning)",
      note: l(g.status === "passed" ? "passedNote" : "flaggedNote", { pct: share(g.count) })
    }))
  };

  const heroChips: HeroChip[] = [
    ...(creatives
      ? [
          { label: l("creatives"), value: num.format(total), hue: hueVar("signal") },
          ...complianceGroups.map((g) => ({
            label: statusLabel(g.status),
            value: num.format(g.count),
            hue: hueVar("signal"),
            detail: share(g.count)
          }))
        ]
      : []),
    ...(audience
      ? [{ label: l("audience"), value: audience.proposal.name, detail: audience.proposal.summary, hue: hueVar("signal") }]
      : [])
  ];

  return (
    <div className="flex flex-col gap-6 pb-12">
      <JourneyNav current="signal" locale={locale} pack={pack} t={t} />
      <JourneyHeader step="signal" title={l("title")} locale={locale} pack={pack} />
      <Hero
        eyebrow={l("heroEyebrow")}
        title={[
          drafting ? l("drafting", { subject: drafting }) : l("draftingBlank"),
          creatives ? `${counted(l, "creative", total, locale)}.` : ""
        ]
          .filter(Boolean)
          .join(" ")}
        mod="signal"
        {...(heroChips.length > 0 ? { hero: { chips: heroChips } } : {})}
      />

      {result?.problem ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-4">
          <p className="font-ui text-14 font-medium text-danger">{l(problemKey(result.problem))}</p>
          <RequestId id={result.problem.requestId} />
        </div>
      ) : null}

      <Card title={l("suggestCard")}>
        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="suggest_audience" />
          <label className="flex flex-col gap-1">
            <span className="font-ui text-12 text-subtle">{l("subject")}</span>
            <input
              name="subject"
              defaultValue={subject}
              required
              className="rounded-md border border-border bg-surface-2 px-3 py-2 font-ui text-13"
            />
          </label>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {l("suggest")}
            </Button>
          </div>
        </Form>
      </Card>

      {audience ? (
        <Card title={audience.proposal.name}>
          <div className="flex flex-col gap-3">
            {audience.source === "ai" ? (
              <div>
                <AgentBadge why={<p className="text-13">{l("audienceWhy", { subject: audience.subject })}</p>} />
              </div>
            ) : (
              <p className="text-12 text-subtle">{l("fallback")}</p>
            )}
            <p className="font-ui text-13 leading-relaxed text-text">{audience.proposal.summary}</p>
            <div className="flex flex-wrap gap-2">
              {audience.proposal.demographics.map((d, i) => (
                <Badge key={i} tone="neutral" size="sm">
                  {d.axis}: {d.value}
                </Badge>
              ))}
            </div>
            {audience.proposal.reasons.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {audience.proposal.reasons.map((r, i) => (
                  <li key={i} className="font-ui text-12 text-subtle">
                    {r.axis}: {r.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>
      ) : null}

      {audience ? (
        <Card title={l("generateCard")}>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="generate_creatives" />
            <input type="hidden" name="brief" value={audience.proposal.summary} />
            <input type="hidden" name="subject" value={audience.subject} />
            <input type="hidden" name="whitespaceId" value={whitespaceId} />
            <p className="font-ui text-13 text-subtle">{l("brief", { summary: audience.proposal.summary })}</p>
            {whitespaceId ? <p className="font-ui text-12 text-subtle">{l("briefCarries")}</p> : null}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>
                {l("generate")}
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}

      {creatives && complianceGroups.length > 1 ? <div>{renderSection(complianceBars, "signal")}</div> : null}

      {creatives ? (
        <section aria-labelledby="journey-signal-creatives" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="journey-signal-creatives" className="section-title">
              {l("creatives")}
            </h2>
            <AgentBadge agent={l("agentKey.creative")} why={<p className="text-13">{l("creativeWhy")}</p>} />
          </div>
          {creatives.variants.map((v) => (
            <Card key={v.id} title={l(`lang.${v.locale}`)}>
              <div className="flex flex-col gap-2">
                <p lang={v.locale} dir="auto" className="font-ui text-13 leading-relaxed text-text">
                  {v.text}
                </p>
                <div>
                  <Badge tone={v.complianceStatus === "passed" ? "success" : "warning"} size="sm">
                    {statusLabel(v.complianceStatus)}
                  </Badge>
                </div>
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      {drafting && !campaign ? (
        <Card title={l("saveCard")}>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="save_draft" />
            <input type="hidden" name="subject" value={drafting} />
            <input type="hidden" name="whitespaceId" value={whitespaceId} />
            <input type="hidden" name="audienceId" value={audience?.audienceId ?? ""} />
            <input type="hidden" name="audienceName" value={audience?.proposal.name ?? ""} />
            <p className="font-ui text-13 text-subtle">{l(audience ? "saveBody" : "saveBodyBare")}</p>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>
                {l("save")}
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}

      {campaign ? (
        <div role="status" className="flex flex-col gap-4 rounded-md border border-border bg-surface-1 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="section-title">{l("savedTitle")}</h2>
            <p className="text-13 text-text">{l("savedBody", { name: campaign.name })}</p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-14 font-medium text-text">{l("nextTitle")}</h3>
            <p className="text-13 text-subtle">
              {l("nextBody", { policy: LAUNCH_POLICY })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="primary">
              <Link to={`/signal/campaigns/${encodeURIComponent(campaign.id)}`}>{l("openCampaign")}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to={`/signal/studio?campaignId=${encodeURIComponent(campaign.id)}`}>{l("openStudio")}</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
