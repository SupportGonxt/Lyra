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
  Checkbox,
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  GuardrailNotice,
  Select,
  Table,
  shortRef,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { HeroStat, HeroWall, lensOf, useFocus, type Lens } from "../components/hero";
import { api, asRouteError, fetchMe, names, type Problem as ProblemShape } from "../api.server";
import { cloudflare } from "../context";
import { who, type Names } from "../names";
import { Gate } from "./staff";
import {
  ORBIT,
  daysUntil,
  labelsFrom,
  refusal,
  safe,
  type Label,
  type Labels,
  type Page
} from "./orbit-shared";
import { useShellData } from "./workspace";
import { localeFrom } from "../i18n";

// The retention queue: who is about to leave, what we offered them, and how it
// ended. A renewal is raised by the expiry sweep and its state machine lives in
// apps/api/src/resources.ts (RENEWAL_TRANSITIONS) — this screen offers only the
// moves that machine allows and lets the API refuse the rest.
//
// Making an offer is consequential (CLAUDE.md §4): it is an outbound promise
// about price. So it asks for a deliberate confirmation, sends an idempotency
// key, and when the API answers `approval_required` the screen says so rather
// than pretending the offer went out.

/* --------------------------------------------------------------- contract */

export interface Renewal {
  id: string;
  policyRef: string | null;
  customerId: string | null;
  expiryAt: number | null;
  churnScore: number | null;
  strategy: string;
  state: string;
  outcomeReason: string | null;
  ownerRef: string | null;
  offeredAt: number | null;
  decidedAt: number | null;
  requotesJson: unknown;
  createdAt: number;
}

/** Churn score at or above this is a save case, not a routine renewal. */
export const HIGH_RISK_FLOOR = 65;

export const STRATEGIES = ["auto_requote", "human", "do_not_contact"] as const;
export const RESOLUTIONS = ["accepted", "lost"] as const;

/** Why it ended. Free text in the schema; a closed list is what gets analysed. */
export const REASONS = [
  "saved_discount",
  "saved_service",
  "price",
  "competitor",
  "no_longer_needed",
  "unreachable",
  "expired_no_response"
] as const;

/** One rule, so the hero's count and `atRisk`'s list cannot disagree. */
const riskAt =
  (floor: number): Lens<Renewal> =>
  (row) =>
    (row.churnScore ?? 0) >= floor;

/** The wall's drillable figure: the risky head of the queue, as a lens. */
export const LENSES: Record<string, Lens<Renewal>> = { risk: riskAt(HIGH_RISK_FLOOR) };

export function atRisk(rows: Renewal[], floor = HIGH_RISK_FLOOR): Renewal[] {
  return rows.filter(riskAt(floor));
}

export function riskTone(score: number | null): BadgeTone {
  if (score === null) return "neutral";
  if (score >= 80) return "danger";
  if (score >= HIGH_RISK_FLOOR) return "warning";
  return "success";
}

/** The API's transition table, client side, so a control that cannot work is absent. */
export function canOffer(row: Renewal): boolean {
  return row.state === "scheduled" && row.strategy !== "do_not_contact";
}

export function canResolve(row: Renewal): boolean {
  return row.state === "scheduled" || row.state === "offered";
}

/** What the desk needs worked first: the risky head of the queue, else whatever else is waiting. */
export function saveHeadline(riskyCount: number, queueCount: number, l: Label): string {
  if (riskyCount > 0) return l("headlineRisk", { n: String(riskyCount) });
  if (queueCount > 0) return l("headlineQueue", { n: String(queueCount) });
  return l("headlineClear");
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Save desk",
    lede: "Renewals the churn model flagged, the offer that went out, and how it ended.",
    headlineRisk: "{n} renewals at high risk of churn",
    headlineQueue: "{n} renewals waiting on us",
    headlineClear: "Nothing waiting on us right now",
    openRenewal: "Open the highest-risk renewal",
    atRisk: "High churn risk",
    heroAll: "Show everything",
    scheduledCount: "Waiting on us",
    offeredCount: "Offer out",
    savedRate: "Saved this window",
    queue: "Save queue",
    queueBody: "Highest churn risk first. Nothing has been offered on these yet.",
    outstanding: "Offers outstanding",
    outstandingBody: "Sent and undecided. The sweep marks these lost if the expiry passes.",
    settled: "Recently settled",
    settledBody: "Accepted or lost, newest decision first.",
    customer: "Customer",
    policyRef: "Policy reference",
    expires: "Expires",
    daysLeft: "Days left",
    daysLate: "{n} days late",
    risk: "Churn risk",
    strategy: "Strategy",
    state: "State",
    outcome: "Outcome",
    owner: "Owner",
    offered: "Offered",
    decided: "Decided",
    act: "Action",
    offer: "Make the offer",
    offerTitle: "Send a save offer",
    offerBody:
      "This is an outbound promise about price. Confirm it, and it is recorded against the renewal.",
    confirm: "I have checked the price and want this to go out",
    confirmMissing: "Tick the confirmation before the offer goes out.",
    resolve: "Record the outcome",
    resolution: "Result",
    reason: "Reason",
    setStrategy: "Change strategy",
    saved: "Recorded.",
    unknownIntent: "That control is not available.",
    missingRenewal: "Pick a renewal first.",
    badResolution: "Choose accepted or lost.",
    notOfferable: "That renewal cannot be offered from its current state.",
    riskWhy: "Why this score",
    riskWhyBody:
      "The churn score is written by the retention model on the renewal record. It reads tenure, claims history, payment behaviour and recent conversation sentiment. It is a ranking aid, not a decision.",
    noOffer: "No offer figures yet",
    noOfferBody:
      "Nothing in the platform generates a re-quote today, so the offer recorded here is the fact that one was made, not its price.",
    noneQueue: "Nothing is at risk right now.",
    noneOutstanding: "No offer is waiting on a customer.",
    noneSettled: "Nothing has been decided yet.",
    noneBody: "The expiry sweep raises these as policies approach their end date.",
    saved_discount: "Saved with a discount",
    saved_service: "Saved on service",
    price: "Price",
    competitor: "Went to a competitor",
    no_longer_needed: "No longer needed",
    unreachable: "Could not reach them",
    expired_no_response: "Expired without an answer",
    auto_requote: "Auto re-quote",
    human: "Handled by a person",
    do_not_contact: "Do not contact",
    accepted: "Renewed",
    lost: "Lost",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "مكتب الاستبقاء",
    lede: "التجديدات التي رصدها نموذج التسرب، والعرض الذي أُرسل، وكيف انتهى.",
    headlineRisk: "{n} تجديد بخطر تسرب مرتفع",
    headlineQueue: "{n} تجديد بانتظار إجراء منّا",
    headlineClear: "لا شيء بانتظارنا الآن",
    openRenewal: "افتح التجديد الأعلى خطرًا",
    atRisk: "خطر تسرب مرتفع",
    heroAll: "إظهار الكل",
    scheduledCount: "بانتظار إجراء منّا",
    offeredCount: "عرض قائم",
    savedRate: "استُبقيت في هذه الفترة",
    queue: "قائمة انتظار الاستبقاء",
    queueBody: "الأعلى خطرًا أولًا. لم يُقدَّم أي عرض على هذه بعد.",
    outstanding: "عروض قائمة",
    outstandingBody: "أُرسلت ولم يُحسم أمرها. المسح الدوري يعدّها خسارة إذا انتهى تاريخ الانتهاء.",
    settled: "حُسمت مؤخرًا",
    settledBody: "مقبولة أو خسارة، الأحدث قرارًا أولًا.",
    customer: "العميل",
    policyRef: "مرجع الوثيقة",
    expires: "تنتهي",
    daysLeft: "الأيام المتبقية",
    daysLate: "متأخر {n} يومًا",
    risk: "خطر التسرب",
    strategy: "الأسلوب",
    state: "الحالة",
    outcome: "النتيجة",
    owner: "المسؤول",
    offered: "وقت العرض",
    decided: "وقت القرار",
    act: "إجراء",
    offer: "قدّم العرض",
    offerTitle: "إرسال عرض استبقاء",
    offerBody: "هذا وعد سعري صادر للعميل. أكّده ليُسجَّل على التجديد.",
    confirm: "راجعت السعر وأريد إرسال العرض",
    confirmMissing: "أكّد الخيار قبل إرسال العرض.",
    resolve: "سجّل النتيجة",
    resolution: "النتيجة",
    reason: "السبب",
    setStrategy: "تغيير الأسلوب",
    saved: "تم التسجيل.",
    unknownIntent: "هذا الإجراء غير متاح.",
    missingRenewal: "اختر تجديدًا أولًا.",
    badResolution: "اختر مقبول أو خسارة.",
    notOfferable: "لا يمكن تقديم عرض على هذا التجديد من حالته الحالية.",
    riskWhy: "سبب هذه الدرجة",
    riskWhyBody:
      "درجة التسرب يكتبها نموذج الاستبقاء على سجل التجديد، بناءً على مدة العلاقة وسجل المطالبات وسلوك الدفع ونبرة المحادثات الأخيرة. هي مساعدة في الترتيب وليست قرارًا.",
    noOffer: "لا توجد أرقام عرض بعد",
    noOfferBody:
      "لا يوجد في المنصة ما يُنشئ إعادة تسعير اليوم، لذا ما يُسجَّل هنا هو حدوث العرض لا سعره.",
    noneQueue: "لا شيء معرّض للخطر الآن.",
    noneOutstanding: "لا عرض بانتظار عميل.",
    noneSettled: "لم يُحسم شيء بعد.",
    noneBody: "المسح الدوري يرفع هذه السجلات مع اقتراب انتهاء الوثائق.",
    saved_discount: "أُنقذ بخصم",
    saved_service: "أُنقذ بالخدمة",
    price: "السعر",
    competitor: "انتقل إلى منافس",
    no_longer_needed: "لم تعد هناك حاجة",
    unreachable: "تعذّر الوصول إليه",
    expired_no_response: "انتهى دون رد",
    auto_requote: "إعادة تسعير تلقائية",
    human: "يتولاها موظف",
    do_not_contact: "عدم التواصل",
    accepted: "مُجدَّد",
    lost: "خسارة",
    approvalLink: "افتح الموافقات"
  }
};

export function labelsIn(locale: string, pack?: string): Label {
  return labelsFrom(LABELS, locale, pack);
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const empty: Page<Renewal> = { data: [], total: 0 };
  const list = (query: string) =>
    held.has(ORBIT.renewals)
      ? safe(() => api<Page<Renewal>>(`/v1/orbit/renewals?${query}`, opts), empty)
      : Promise.resolve(empty);

  // ponytail: churnScore has no range filter (the generic lister does exact
  // match plus from/to on the sort column only), so the desk sorts by risk and
  // counts the high-risk head client-side. A dedicated endpoint would push the
  // floor into SQL if the queue ever outgrows a page.
  const [queue, outstanding, settled] = await Promise.all([
    list("state=scheduled&sort=churnScore&order=desc&limit=50&count=true"),
    list("state=offered&sort=offeredAt&order=desc&limit=50&count=true"),
    list("state=accepted&sort=decidedAt&order=desc&limit=25")
  ]);
  const lost = await list("state=lost&sort=decidedAt&order=desc&limit=25");

  // Every desk column that names a person read a ULID: CUSTOMER showed
  // `cu_01KE…KPZ1` and OWNER `user:us_…`. One batch names all three tables.
  const resolved = await names(
    [...queue.data, ...outstanding.data, ...settled.data, ...lost.data].flatMap((row) => [
      row.customerId,
      row.ownerRef
    ]),
    opts
  );

  return {
    locale: localeFrom(request),
    now: Date.now(),
    nonce: crypto.randomUUID(),
    may: { read: held.has(ORBIT.renewals), write: held.has(ORBIT.renewalsWrite) },
    queue,
    outstanding,
    settled: [...settled.data, ...lost.data].sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)),
    resolved,
    savedCount: settled.data.length,
    lostCount: lost.data.length
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  saved: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status },
  saved: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  if (!["offer", "resolve", "strategy"].includes(intent)) return refuse("unknown_intent");
  if (!id) return refuse("missing_renewal");

  const now = Date.now();
  let body: Record<string, unknown>;
  if (intent === "offer") {
    // Consequential: nothing goes out on a stray click.
    if (form.get("confirm") !== "on") return refuse("confirm_missing");
    body = { state: "offered", offeredAt: now };
  } else if (intent === "resolve") {
    const state = String(form.get("state") ?? "");
    if (!RESOLUTIONS.includes(state as (typeof RESOLUTIONS)[number])) return refuse("bad_resolution");
    const reason = String(form.get("reason") ?? "");
    body = { state, decidedAt: now, ...(reason ? { outcomeReason: reason } : {}) };
  } else {
    const strategy = String(form.get("strategy") ?? "");
    if (!STRATEGIES.includes(strategy as (typeof STRATEGIES)[number])) return refuse("bad_strategy");
    body = { strategy };
  }

  try {
    await api(`/v1/orbit/renewals/${id}`, {
      env,
      request,
      method: "PATCH",
      headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
      body
    });
    return { problem: null, saved: id };
  } catch (error) {
    return { problem: refusal(error), saved: null };
  }
}

/* --------------------------------------------------------------- component */

export default function SaveDesk() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale, useShellData()?.domainPack);
  const busy = navigation.state === "submitting";
  const { focus, href } = useFocus(LENSES);
  // Counted through the lens the queue below is filtered by, so the figure and
  // the desk it opens are the same rows.
  const risky = lensOf(loaded.queue.data, LENSES, "risk");
  const settledTotal = loaded.savedCount + loaded.lostCount;
  const savedRate = settledTotal === 0 ? 0 : Math.round((loaded.savedCount / settledTotal) * 100);

  const localised: Record<string, string> = {
    unknown_intent: l("unknownIntent"),
    missing_renewal: l("missingRenewal"),
    bad_resolution: l("badResolution"),
    bad_strategy: l("badResolution"),
    confirm_missing: l("confirmMissing")
  };
  const local = result?.problem ? localised[result.problem.title] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">
          {saveHeadline(risky.length, loaded.queue.total ?? loaded.queue.data.length, l)}
        </h1>
        <p className="font-ui text-13 text-muted">{l("lede")}</p>
        {risky[0] ? (
          <Link to={`/orbit/renewals/${risky[0].id}`} className="w-fit font-ui text-13 text-accent underline">
            {l("openRenewal")}
          </Link>
        ) : null}
      </header>

      {local ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{local}</p>
        </div>
      ) : null}
      {result?.problem && !local ? <Gate problem={result.problem} l={l} /> : null}
      {result?.saved ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l("saved")}</p>
        </div>
      ) : null}

      <HeroWall focus={focus} allLabel={l("heroAll")}>
        <HeroStat
          label={l("atRisk")}
          value={String(risky.length)}
          live={risky.length > 0}
          to={href("risk")}
          active={focus === "risk"}
        />
        {/* One state, one endpoint, one declared filter (modules/orbit.ts): the
            list route counts exactly the rows behind this figure. */}
        <HeroStat
          label={l("scheduledCount")}
          value={String(loaded.queue.total ?? loaded.queue.data.length)}
          to="/orbit/renewals?state=scheduled"
        />
        <HeroStat
          label={l("offeredCount")}
          value={String(loaded.outstanding.total ?? loaded.outstanding.data.length)}
          to="/orbit/renewals?state=offered"
        />
        {/* No door: a rate has no rows, and its two counts span states this
            screen does not list in full. */}
        <HeroStat label={l("savedRate")} value={`${savedRate}%`} hint={l("noOffer")} />
      </HeroWall>

      <GuardrailNotice title={l("noOffer")} reason={l("noOfferBody")} tone="info" />

      <Card title={l("queue")} description={l("queueBody")}>
        <Desk
          rows={lensOf(loaded.queue.data, LENSES, focus)}
          l={l}
          locale={loaded.locale}
          resolved={loaded.resolved}
          now={loaded.now}
          nonce={loaded.nonce}
          writable={loaded.may.write}
          busy={busy}
          caption={l("queue")}
          emptyTitle={l("noneQueue")}
        />
      </Card>

      {/* Neither card holds a row the risk figure counted — an offer is out
          and a settlement is done — so while the lens is on they would be lists
          the wall above disowns. Back on "show everything". */}
      {focus ? null : (
        <>
          <Card title={l("outstanding")} description={l("outstandingBody")}>
            <Desk
              rows={loaded.outstanding.data}
              l={l}
              locale={loaded.locale}
              resolved={loaded.resolved}
              now={loaded.now}
              nonce={loaded.nonce}
              writable={loaded.may.write}
              busy={busy}
              caption={l("outstanding")}
              emptyTitle={l("noneOutstanding")}
            />
          </Card>

          <Card title={l("settled")} description={l("settledBody")}>
            {loaded.settled.length === 0 ? (
              <EmptyState title={l("noneSettled")} body={l("noneBody")} />
            ) : (
              <Table
                caption={l("settled")}
                rows={loaded.settled}
                rowKey={(row) => row.id}
                density="compact"
                columns={[
                  {
                    key: "customerId",
                    header: l("customer"),
                    render: (row) => (row.customerId ? who(row.customerId, loaded.resolved) : "—")
                  },
                  {
                    key: "policyRef",
                    header: l("policyRef"),
                    render: (row) =>
                      row.policyRef ? (
                        <span className="font-mono text-12" title={row.policyRef}>
                          {shortRef(row.policyRef)}
                        </span>
                      ) : (
                        "—"
                      )
                  },
                  {
                    key: "state",
                    header: l("state"),
                    render: (row) => (
                      <Badge tone={row.state === "accepted" ? "success" : "danger"}>{l(row.state)}</Badge>
                    )
                  },
                  {
                    key: "outcomeReason",
                    header: l("outcome"),
                    render: (row) => (row.outcomeReason ? l(row.outcomeReason) : "—")
                  },
                  {
                    key: "decidedAt",
                    header: l("decided"),
                    render: (row) =>
                      row.decidedAt ? <DateTime value={row.decidedAt} locale={loaded.locale} relative /> : "—"
                  }
                ] satisfies Column<Renewal>[]}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Desk({
  rows,
  l,
  locale,
  resolved,
  now,
  nonce,
  writable,
  busy,
  caption,
  emptyTitle
}: {
  rows: Renewal[];
  l: Label;
  locale: string;
  resolved: Names;
  now: number;
  nonce: string;
  writable: boolean;
  busy: boolean;
  caption: string;
  emptyTitle: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} body={l("noneBody")} />;

  const columns: Column<Renewal>[] = [
    {
      key: "customerId",
      header: l("customer"),
      render: (row) => (
        <div className="flex flex-col">
          <Link to={`/orbit/renewals/${row.id}`} className="font-ui text-13 text-accent underline underline-offset-2">
            {row.customerId ? who(row.customerId, resolved) : shortRef(row.id)}
          </Link>
          <span className="font-mono text-12 text-subtle" title={row.policyRef ?? undefined}>
            {row.policyRef ? shortRef(row.policyRef) : ""}
          </span>
        </div>
      )
    },
    {
      key: "expiryAt",
      header: l("expires"),
      render: (row) => (row.expiryAt ? <DateTime value={row.expiryAt} locale={locale} precision="day" /> : "—")
    },
    {
      key: "daysLeft",
      header: l("daysLeft"),
      numeric: true,
      render: (row) => {
        const days = daysUntil(row.expiryAt, now);
        if (days === null) return "—";
        // A renewal the sweep never closed reads `-197` under a column headed
        // "Days left", which is not a thing a person can say out loud.
        return (
          <span className={days <= 7 ? "font-ui text-13 font-medium text-danger" : "font-ui text-13 text-text"}>
            {days < 0 ? l("daysLate").replace("{n}", String(-days)) : days}
          </span>
        );
      }
    },
    {
      key: "churnScore",
      header: l("risk"),
      numeric: true,
      // The score is model output, so it carries the ✦ and an inspectable why.
      render: (row) => (
        <EvidenceLink
          sourceLabel={l("riskWhy")}
          source={<p className="font-ui text-13 text-muted">{l("riskWhyBody")}</p>}
        >
          <Badge tone={riskTone(row.churnScore)}>
            <span aria-hidden="true">{AGENT_MARK}</span>
            <span>{row.churnScore ?? "—"}</span>
          </Badge>
        </EvidenceLink>
      )
    },
    { key: "strategy", header: l("strategy"), render: (row) => <Badge tone="neutral">{l(row.strategy)}</Badge> },
    {
      key: "ownerRef",
      header: l("owner"),
      render: (row) => (row.ownerRef ? who(row.ownerRef, resolved) : "—")
    }
  ];

  if (writable) {
    columns.push({
      key: "act",
      header: l("act"),
      width: "22rem",
      render: (row) => {
        // Every row's buttons read "Offer", "Resolve", "Apply". Screen-reader
        // names carry the renewal they act on; the eye gets it from the row.
        const who = row.policyRef ?? row.customerId ?? row.id;
        return (
          <div className="flex flex-col gap-3">
            {canOffer(row) ? (
              <Form method="post" replace className="flex flex-col gap-2">
                <input type="hidden" name="intent" value="offer" />
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="nonce" value={`offer:${nonce}:${row.id}`} />
                <Checkbox name="confirm" label={l("confirm")} />
                <Button type="submit" size="sm" disabled={busy} aria-label={`${l("offer")}: ${who}`}>
                  {busy ? l("working") : l("offer")}
                </Button>
              </Form>
            ) : null}

            {canResolve(row) ? (
              <Form method="post" replace className="flex flex-col gap-2">
                <input type="hidden" name="intent" value="resolve" />
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="nonce" value={`resolve:${nonce}:${row.id}`} />
                <Field label={l("resolution")} labelHidden>
                  <Select
                    name="state"
                    aria-label={l("resolution")}
                    options={RESOLUTIONS.map((value) => ({ value, label: l(value) }))}
                    defaultValue="accepted"
                  />
                </Field>
                <Field label={l("reason")} labelHidden>
                  <Select
                    name="reason"
                    aria-label={l("reason")}
                    options={REASONS.map((value) => ({ value, label: l(value) }))}
                    defaultValue="saved_discount"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={`${l("resolve")}: ${who}`}
                >
                  {l("resolve")}
                </Button>
              </Form>
            ) : null}

            <Form method="post" replace className="flex items-end gap-2">
              <input type="hidden" name="intent" value="strategy" />
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="nonce" value={`strategy:${nonce}:${row.id}`} />
              <Field label={l("setStrategy")} labelHidden>
                <Select
                  name="strategy"
                  aria-label={l("setStrategy")}
                  options={STRATEGIES.map((value) => ({ value, label: l(value) }))}
                  defaultValue={row.strategy}
                />
              </Field>
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${l("apply")}: ${who}`}
              >
                {l("apply")}
              </Button>
            </Form>
          </div>
        );
      }
    });
  }

  return <Table caption={caption} rows={rows} rowKey={(row) => row.id} columns={columns} />;
}
