import {
  Form,
  Link,
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
  ConfidenceMeter,
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  Input,
  Table,
  shortRef,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { HeroStat, HeroWall, lensOf, useFocus, type Lens } from "../components/hero";
import { api, asRouteError, fetchMe, names, type Problem as ProblemShape } from "../api.server";
import { cloudflare } from "../context";
import { humanise } from "../modules/spec";
import { who } from "../names";
import { Gate } from "./staff";
import { ORBIT, labelsFrom, refusal, safe, type Label, type Labels, type Page } from "./orbit-shared";
import { localeFrom } from "../i18n";

// Conversation QA. The scores are written by the quality agent, so every one of
// them carries the ✦ and an inspectable breakdown (docs/15 §4): a reviewer
// should be able to see what the model counted before disagreeing with it.
//
// A correction is a new score row, not an edit. `orbit:qa:score` is create-only
// in apps/api/src/resources.ts and `scoredBy` is an actor column — which is the
// right shape for an audit trail: the model's read and the reviewer's read both
// survive, and the newest one wins by time.

/* --------------------------------------------------------------- contract */

export interface QaScore {
  id: string;
  conversationId: string | null;
  rubricKey: string;
  score: number;
  breakdownJson: unknown;
  flagsJson: unknown;
  scoredBy: string | null;
  disputedBy: string | null;
  ts: number;
}

export interface SampledConversation {
  id: string;
  customerId: string | null;
  channel: string;
  csat: number | null;
  sentiment: number | null;
  summary: string | null;
  closedAt: number | null;
}

export const SCORE_MAX = 100;

/** `scoredBy` is `user:<id>` or `agent:<key>` (packages/db/src/schema/orbit.ts). */
export function isAgentScored(row: QaScore): boolean {
  return (row.scoredBy ?? "").startsWith("agent:");
}

export function scoreTone(score: number): BadgeTone {
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "danger";
}

/**
 * The wall's two drillable figures, one rule each over the score rows the table
 * below renders — the figure is a count through the lens and the table is a
 * filter through it, so "flagged: 7" opens onto those seven rows. `flagged`
 * uses scoreTone's failing band; `corrections` is the complement of the ✦ mark
 * every agent-written row carries.
 */
export const LENSES: Record<string, Lens<QaScore>> = {
  flagged: (row) => row.score < 60,
  corrections: (row) => !isAgentScored(row)
};

/** Whatever the model listed, as label-and-number pairs a table can render. */
export function breakdownOf(value: unknown): Array<[string, string]> {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([key, item]) => [
    key,
    typeof item === "object" ? JSON.stringify(item) : String(item)
  ]);
}

export function flagsOf(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, on]) => Boolean(on))
      .map(([key]) => key);
  }
  return [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Everything a score row needs before it is worth a round trip. */
export function checkScore(input: { conversationId: string; rubricKey: string; score: string }): string | null {
  if (!input.conversationId) return "needConversation";
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(input.rubricKey)) return "needRubric";
  const score = Number(input.score);
  if (!Number.isInteger(score) || score < 0 || score > SCORE_MAX) return "needScore";
  return null;
}

export function mean(rows: QaScore[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((total, row) => total + row.score, 0) / rows.length);
}

/** What the reviewer should look at first: flagged scores, else the running average. */
export function qualityHeadline(flagged: number, avg: number, reviewed: number, l: Label): string {
  if (reviewed === 0) return l("headlineNone");
  if (flagged > 0) return l("headlineFlagged", { n: String(flagged) });
  return l("headlineClean", { n: String(avg) });
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Conversation quality",
    lede: "What the quality agent scored, why it scored it that way, and where a reviewer disagreed.",
    headlineNone: "No conversations scored yet",
    headlineFlagged: "{n} conversations scored below 60",
    headlineClean: "Average score {n}, nothing below 60",
    reviewFlagged: "Review the lowest score",
    reviewed: "Scored conversations",
    heroAll: "Show everything",
    average: "Average score",
    flagged: "Below 60",
    corrections: "Reviewer corrections",
    scores: "Scores",
    scoresBody: "Newest first. Every agent score opens its own breakdown.",
    sample: "Sample to review",
    sampleBody: "Recently closed conversations. Score one to add a reviewer read alongside the agent's.",
    conversation: "Conversation",
    rubric: "Rubric",
    score: "Score",
    scoredBy: "Scored by",
    disputed: "Disputed by",
    flags: "Flags",
    when: "When",
    breakdown: "What the agent counted",
    breakdownEmpty: "The agent recorded no breakdown for this score.",
    whyLabel: "Why this score",
    correct: "Record my score",
    correcting: "Recording",
    correctBody: "A correction is added as a new score under your name; the agent's score is kept.",
    reason: "Note for the record",
    scoreField: "Score out of 100",
    rubricField: "Rubric key",
    openThread: "Open thread",
    customer: "Customer",
    channel: "Channel",
    csat: "Satisfaction",
    closed: "Closed",
    hasScore: "Scored",
    notScored: "Not scored",
    reviewerRead: "Reviewer",
    agentRead: "Quality agent",
    noScores: "No scores yet",
    noScoresBody: "The quality agent scores conversations as they close.",
    noSample: "No closed conversations",
    noSampleBody: "A conversation appears here once it is closed.",
    saved: "Recorded.",
    needConversation: "Pick the conversation being scored.",
    needRubric: "A rubric key is lowercase letters, digits, dots, dashes or underscores.",
    needScore: "A score is a whole number between 0 and 100.",
    unknownIntent: "That control is not available.",
    disputeGap: "Disputes are read-only here",
    disputeGapBody:
      "The API has no way to mark an existing score disputed, so a disagreement is recorded as your own score instead.",
    whatsapp: "WhatsApp",
    web: "Web",
    voice: "Voice",
    email: "Email",
    agent: "Agent channel",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "جودة المحادثات",
    lede: "ما منحه وكيل الجودة من درجات، وسبب ذلك، وحيث اختلف معه المراجع.",
    headlineNone: "لا محادثات مقيّمة بعد",
    headlineFlagged: "{n} محادثة سُجّلت بأقل من 60",
    headlineClean: "متوسط الدرجات {n}، لا شيء تحت 60",
    reviewFlagged: "راجع أدنى درجة",
    reviewed: "المحادثات المقيَّمة",
    heroAll: "إظهار الكل",
    average: "المعدل",
    flagged: "أقل من 60",
    corrections: "تصحيحات المراجعين",
    scores: "الدرجات",
    scoresBody: "الأحدث أولًا. كل درجة من الوكيل تفتح تفصيلها.",
    sample: "عيّنة للمراجعة",
    sampleBody: "محادثات أُغلقت حديثًا. قيّم واحدة لتضيف قراءة مراجع إلى جانب قراءة الوكيل.",
    conversation: "المحادثة",
    rubric: "المعيار",
    score: "الدرجة",
    scoredBy: "المقيّم",
    disputed: "المعترض",
    flags: "التنبيهات",
    when: "الوقت",
    breakdown: "ما احتسبه الوكيل",
    breakdownEmpty: "لم يسجّل الوكيل تفصيلًا لهذه الدرجة.",
    whyLabel: "سبب هذه الدرجة",
    correct: "سجّل درجتي",
    correcting: "جارٍ التسجيل",
    correctBody: "التصحيح يُضاف كدرجة جديدة باسمك، وتبقى درجة الوكيل محفوظة.",
    reason: "ملاحظة للسجل",
    scoreField: "الدرجة من 100",
    rubricField: "مفتاح المعيار",
    openThread: "افتح المحادثة",
    customer: "العميل",
    channel: "القناة",
    csat: "رضا العميل",
    closed: "الإغلاق",
    hasScore: "مقيَّمة",
    notScored: "غير مقيَّمة",
    reviewerRead: "مراجع",
    agentRead: "وكيل الجودة",
    noScores: "لا درجات بعد",
    noScoresBody: "يقيّم وكيل الجودة المحادثات عند إغلاقها.",
    noSample: "لا محادثات مغلقة",
    noSampleBody: "تظهر المحادثة هنا بعد إغلاقها.",
    saved: "تم التسجيل.",
    needConversation: "اختر المحادثة المقيَّمة.",
    needRubric: "مفتاح المعيار حروف صغيرة أو أرقام أو نقاط أو شرطات.",
    needScore: "الدرجة عدد صحيح بين 0 و100.",
    unknownIntent: "هذا الإجراء غير متاح.",
    disputeGap: "الاعتراضات للعرض فقط هنا",
    disputeGapBody:
      "لا تتيح الواجهة الخلفية وسمَ درجة قائمة بالاعتراض، لذا يُسجَّل الخلاف كدرجة خاصة بك.",
    whatsapp: "واتساب",
    web: "الويب",
    voice: "صوت",
    email: "البريد الإلكتروني",
    agent: "قناة الوكيل",
    approvalLink: "افتح الموافقات"
  }
};

export function labelsIn(locale: string): Label {
  return labelsFrom(LABELS, locale);
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const rubric = new URL(request.url).searchParams.get("rubric") ?? "";

  const [scores, sample] = await Promise.all([
    held.has(ORBIT.qa)
      ? safe(
          () =>
            api<Page<QaScore>>(
              `/v1/orbit/qa-scores?sort=ts&order=desc&limit=50&count=true${
                rubric ? `&rubricKey=${encodeURIComponent(rubric)}` : ""
              }`,
              opts
            ),
          { data: [], total: 0 } as Page<QaScore>
        )
      : Promise.resolve({ data: [], total: 0 } as Page<QaScore>),
    held.has(ORBIT.conversations)
      ? safe(
          () =>
            api<Page<SampledConversation>>(
              "/v1/orbit/conversations?state=closed&sort=closedAt&order=desc&limit=20",
              opts
            ),
          { data: [] } as Page<SampledConversation>
        )
      : Promise.resolve({ data: [] } as Page<SampledConversation>)
  ]);

  // The table's DISPUTED BY column read `user:us_01KE…S9M` and its sample's
  // CUSTOMER column a bare `cu_01KE…`: rows carry refs and no names for them.
  const resolved = await names(
    [
      ...scores.data.map((row) => row.disputedBy),
      ...sample.data.map((row) => row.customerId)
    ].filter((one): one is string => Boolean(one)),
    opts
  );

  return {
    locale: localeFrom(request),
    nonce: crypto.randomUUID(),
    rubric,
    may: { read: held.has(ORBIT.qa), score: held.has(ORBIT.qaScore) },
    scores,
    sample: sample.data,
    resolved
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  error: string | null;
  saved: boolean;
}

const nothing: ActionResult = { problem: null, error: null, saved: false };

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "score") return { ...nothing, error: "unknownIntent" };

  const input = {
    conversationId: String(form.get("conversationId") ?? ""),
    rubricKey: String(form.get("rubricKey") ?? "").trim(),
    score: String(form.get("score") ?? "")
  };
  const wrong = checkScore(input);
  if (wrong) return { ...nothing, error: wrong };

  const correctionOf = String(form.get("correctionOf") ?? "");
  const reason = String(form.get("reason") ?? "").trim();

  try {
    await api("/v1/orbit/qa-scores", {
      env,
      request,
      method: "POST",
      headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
      body: {
        conversationId: input.conversationId,
        rubricKey: input.rubricKey,
        score: Number(input.score),
        // `scoredBy` is an actor column — the API stamps who this was.
        breakdownJson: {
          source: "reviewer",
          ...(correctionOf ? { correctionOf } : {}),
          ...(reason ? { note: reason } : {})
        }
      }
    });
    return { ...nothing, saved: true };
  } catch (error) {
    return { ...nothing, problem: refusal(error) };
  }
}

/* --------------------------------------------------------------- component */

export default function ConversationQuality() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state === "submitting";
  const { focus, href } = useFocus(LENSES);
  const rows = loaded.scores.data;
  // Figures counted through the same lenses the table is filtered by below.
  const reviewerRows = lensOf(rows, LENSES, "corrections");
  const scored = new Set(rows.map((row) => row.conversationId).filter(Boolean) as string[]);
  const flagged = lensOf(rows, LENSES, "flagged");
  const shown = lensOf(rows, LENSES, focus);
  const worst = [...flagged]
    .filter((row) => row.conversationId)
    .sort((a, b) => a.score - b.score)[0];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">
          <span aria-hidden="true">{AGENT_MARK}</span> {qualityHeadline(flagged.length, mean(rows), rows.length, l)}
        </h1>
        <p className="font-ui text-13 text-muted">{l("lede")}</p>
        {worst ? (
          <Link
            to={`/orbit/conversations/${worst.conversationId}/thread`}
            className="w-fit font-ui text-13 text-accent underline underline-offset-2"
          >
            {l("reviewFlagged")}
          </Link>
        ) : null}
      </header>

      {result?.error ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{l(result.error)}</p>
        </div>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}
      {result?.saved ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l("saved")}</p>
        </div>
      ) : null}

      <HeroWall focus={focus} allLabel={l("heroAll")}>
        {/* The list route reads the same endpoint with no filter, so it counts
            the same rows — but only while this screen is unfiltered too. A
            rubric in the URL narrows the figure and `qa-scores` declares no
            rubric filter (modules/orbit.ts), so the door closes rather than
            open onto a bigger set than it promised. */}
        <HeroStat
          label={l("reviewed")}
          value={String(loaded.scores.total ?? rows.length)}
          {...(loaded.rubric === "" ? { to: "/orbit/qa-scores" } : {})}
        />
        {/* No door: a mean has no rows. */}
        <HeroStat label={l("average")} value={String(mean(rows))} />
        <HeroStat label={l("flagged")} value={String(flagged.length)} to={href("flagged")} active={focus === "flagged"} />
        <HeroStat
          label={l("corrections")}
          value={String(reviewerRows.length)}
          to={href("corrections")}
          active={focus === "corrections"}
        />
      </HeroWall>

      <Card title={l("scores")} description={l("scoresBody")}>
        {shown.length === 0 ? (
          <EmptyState title={l("noScores")} body={l("noScoresBody")} />
        ) : (
          <Table
            caption={l("scores")}
            rows={shown}
            rowKey={(row) => row.id}
            columns={[
              {
                key: "conversationId",
                header: l("conversation"),
                render: (row) =>
                  row.conversationId ? (
                    <Link
                      to={`/orbit/conversations/${row.conversationId}/thread`}
                      className="font-mono text-12 text-accent underline underline-offset-2"
                      title={row.conversationId}
                    >
                      {shortRef(row.conversationId)}
                    </Link>
                  ) : (
                    "—"
                  )
              },
                            // `orbit.retention_call` is the key the agent writes; a reviewer
              // reads "Orbit retention call". Rubrics are tenant-defined, so
              // there is no label table to look them up in.
              { key: "rubricKey", header: l("rubric"), render: (row) => humanise(row.rubricKey) },
              {
                key: "score",
                header: l("score"),
                numeric: true,
                render: (row) => {
                  const chip = (
                    <Badge tone={scoreTone(row.score)}>
                      {isAgentScored(row) ? <span aria-hidden="true">{AGENT_MARK}</span> : null}
                      <span>{row.score}</span>
                    </Badge>
                  );
                  if (!isAgentScored(row)) return chip;
                  const pairs = breakdownOf(row.breakdownJson);
                  return (
                    <EvidenceLink
                      sourceLabel={l("whyLabel")}
                      source={
                        <div className="flex flex-col gap-2">
                          <ConfidenceMeter value={row.score / SCORE_MAX} label={l("breakdown")} />
                          {pairs.length === 0 ? (
                            <p className="font-ui text-13 text-muted">{l("breakdownEmpty")}</p>
                          ) : (
                            <dl className="flex flex-col gap-1">
                              {pairs.map(([key, value]) => (
                                <div key={key} className="flex items-baseline justify-between gap-4">
                                  <dt className="font-mono text-12 text-subtle">{key}</dt>
                                  <dd className="font-ui text-12 text-text">{value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      }
                    >
                      {chip}
                    </EvidenceLink>
                  );
                }
              },
              {
                key: "scoredBy",
                header: l("scoredBy"),
                render: (row) => (
                  <Badge tone={isAgentScored(row) ? "accent" : "neutral"} size="sm">
                    {isAgentScored(row) ? l("agentRead") : l("reviewerRead")}
                  </Badge>
                )
              },
              {
                key: "flagsJson",
                header: l("flags"),
                render: (row) => {
                  const flags = flagsOf(row.flagsJson);
                  if (flags.length === 0) return "—";
                  return (
                    <span className="flex flex-wrap gap-1">
                      {flags.map((flag) => (
                        <Badge key={flag} tone="warning" size="sm">
                          {humanise(flag)}
                        </Badge>
                      ))}
                    </span>
                  );
                }
              },
              {
                key: "disputedBy",
                header: l("disputed"),
                render: (row) => (row.disputedBy ? who(row.disputedBy, loaded.resolved) : "—")
              },
              {
                key: "ts",
                header: l("when"),
                render: (row) => <DateTime value={row.ts} locale={loaded.locale} relative />
              },
              ...(loaded.may.score
                ? [
                    {
                      key: "correct",
                      header: l("correct"),
                      width: "18rem",
                      render: (row: QaScore) => (
                        <Form method="post" replace className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="intent" value="score" />
                          <input type="hidden" name="conversationId" value={row.conversationId ?? ""} />
                          <input type="hidden" name="rubricKey" value={row.rubricKey} />
                          <input type="hidden" name="correctionOf" value={row.id} />
                          <input type="hidden" name="nonce" value={`fix:${loaded.nonce}:${row.id}`} />
                          <Field label={l("scoreField")} labelHidden>
                            <Input
                              name="score"
                              type="number"
                              min={0}
                              max={SCORE_MAX}
                              step={1}
                              required
                              aria-label={l("scoreField")}
                              className="w-20"
                            />
                          </Field>
                          <Field label={l("reason")} labelHidden>
                            <Input name="reason" aria-label={l("reason")} className="w-32" />
                          </Field>
                          <Button type="submit" variant="ghost" size="sm" disabled={busy}>
                            {busy ? l("correcting") : l("correct")}
                          </Button>
                        </Form>
                      )
                    }
                  ]
                : [])
            ] satisfies Column<QaScore>[]}
          />
        )}
        <p className="mt-3 font-ui text-12 text-subtle">{l("correctBody")}</p>
        <p className="font-ui text-12 text-subtle">{l("disputeGapBody")}</p>
      </Card>

      {/* The sample is closed conversations, not score rows: the focused
          figure never counted them, so it would be a list on screen the wall
          above disowns. Back when the reader shows everything. */}
      {focus ? null : (
        <Card title={l("sample")} description={l("sampleBody")}>
          {loaded.sample.length === 0 ? (
            <EmptyState title={l("noSample")} body={l("noSampleBody")} />
          ) : (
            <Table
              caption={l("sample")}
              rows={loaded.sample}
              rowKey={(row) => row.id}
              density="compact"
              columns={[
                {
                  key: "customerId",
                  header: l("customer"),
                  render: (row) => (
                    <Link
                      to={`/orbit/conversations/${row.id}/thread`}
                      className="font-ui text-13 text-accent underline underline-offset-2"
                    >
                      {row.customerId ? who(row.customerId, loaded.resolved) : shortRef(row.id)}
                    </Link>
                  )
                },
                { key: "channel", header: l("channel"), render: (row) => <Badge tone="neutral">{l(row.channel)}</Badge> },
                { key: "csat", header: l("csat"), numeric: true, render: (row) => row.csat ?? "—" },
                {
                  key: "closedAt",
                  header: l("closed"),
                  render: (row) =>
                    row.closedAt ? <DateTime value={row.closedAt} locale={loaded.locale} relative /> : "—"
                },
                {
                  key: "state",
                  header: l("score"),
                  render: (row) => (
                    <Badge tone={scored.has(row.id) ? "success" : "neutral"} size="sm">
                      {scored.has(row.id) ? l("hasScore") : l("notScored")}
                    </Badge>
                  )
                },
                ...(loaded.may.score
                  ? [
                      {
                        key: "score-it",
                        header: l("correct"),
                        width: "22rem",
                        render: (row: SampledConversation) => (
                          <Form method="post" replace className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="intent" value="score" />
                            <input type="hidden" name="conversationId" value={row.id} />
                            <input type="hidden" name="nonce" value={`new:${loaded.nonce}:${row.id}`} />
                            <Field label={l("rubricField")} labelHidden>
                              <Input
                                name="rubricKey"
                                required
                                aria-label={l("rubricField")}
                                className="w-32"
                                defaultValue={loaded.rubric}
                              />
                            </Field>
                            <Field label={l("scoreField")} labelHidden>
                              <Input
                                name="score"
                                type="number"
                                min={0}
                                max={SCORE_MAX}
                                step={1}
                                required
                                aria-label={l("scoreField")}
                                className="w-20"
                              />
                            </Field>
                            <Button type="submit" variant="ghost" size="sm" disabled={busy}>
                              {l("correct")}
                            </Button>
                          </Form>
                        )
                      }
                    ]
                  : [])
              ] satisfies Column<SampledConversation>[]}
            />
          )}
        </Card>
      )}
    </div>
  );
}
