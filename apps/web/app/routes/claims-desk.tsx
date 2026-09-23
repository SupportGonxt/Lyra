import * as React from "react";
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
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Money,
  Ref,
  Select,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, directory, names } from "../api.server";
import { ConfirmButton } from "../components/confirm";
import { who } from "../names";
import { cloudflare } from "../context";
import { optionLabel } from "../modules/spec";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { labelsFrom } from "./detail-kit";

// The board (axis-board.tsx) reports pile-ups because cases have no transition
// endpoint. Claims do — `POST /v1/axis/claims/:id/transition` — so this screen
// is a real worklist, not a read-only mirror: one prioritised queue across every
// open claim, with assign and advance actions on it. §D.2, docs/27 F25.

/* --------------------------------------------------------------- contract */

export const PERM = {
  read: "axis:claims:read",
  update: "axis:claims:update"
} as const;

/**
 * Claims a handler still has work on. `settled`, `closed` and `withdrawn` are
 * done; `rejected` still gets a count (a claimant may appeal it) but is not
 * ranked into the priority queue below alongside live work.
 */
export const OPEN_CLAIM_STATES = [
  "reported",
  "triage",
  "assessing",
  "awaiting_docs",
  "approved",
  "rejected",
  "settling",
  "recovering",
  "reopened"
] as const;

const DESK_PAGE = 200;

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Claims desk",
    intro:
      "Every open claim, highest priority first — value, fraud risk and how overdue it is. Advance a claim here; settling and settled are reached by requesting a payment, not from this form.",
    "col.ref": "Claim",
    "col.holder": "Claimant",
    "col.peril": "Peril",
    "col.incurred": "Incurred",
    "col.reserve": "Reserve",
    "col.daysOpen": "Days open",
    "col.fraud": "Fraud score",
    "col.siu": "SIU",
    "col.handler": "Handler",
    "reserve.unpriced": "Not yet priced",
    "count.reported": "Reported",
    "count.triage": "Triage",
    "count.assessing": "Assessing",
    "count.awaiting_docs": "Awaiting docs",
    "count.approved": "Approved",
    "count.rejected": "Rejected",
    "count.settling": "Settling",
    "count.recovering": "Recovering",
    "count.reopened": "Reopened",
    // Terminal states: never counted in the strip, but offered as outcomes.
    "count.withdrawn": "Withdrawn",
    "count.settled": "Settled",
    "count.closed": "Closed",
    unassigned: "Nobody",
    "sev.breach": "Overdue",
    "sev.due": "Due soon",
    "siu.referred": "SIU referred",
    "siu.clearing": "SIU clearing",
    "siu.substantiated": "SIU substantiated",
    "empty.title": "The desk is empty",
    "empty.body": "No open claim is waiting right now.",
    "empty.action": "Register a claim",
    "assign.title": "Assign a handler",
    "assign.claim": "Claim",
    "assign.handler": "Handler",
    "assign.pick": "Choose a colleague or team",
    "assign.submit": "Assign",
    "done.assign": "Handler updated.",
    "done.transition": "Claim advanced.",
    "hop.title": "Advance",
    "hop.outcome": "Outcome",
    "hop.reasonCode": "Reason code",
    "hop.reason": "Note",
    "hop.submit": "Advance",
    "hop.confirm":
      "{outcome} closes {ref} against the claimant. It is recorded against your name and the claimant is told. Continue?",
    "hop.none": "No hop from here — settling and settled follow a payment.",
    "problem.missing_claim": "Pick a claim first.",
    "problem.missing_handler": "Name a handler before assigning.",
    "problem.bad_transition": "That outcome is not open from this claim's current state.",
    "problem.bad_intent": "The form did not carry an action this screen knows.",
    "headline.clear": "The desk is empty",
    "headline.breached": "{count} claims are past their SLA",
    "headline.moving": "{count} claims open, none overdue",
    "headline.open": "Open the top-priority claim — {ref}"
  },
  ar: {
    title: "مكتب المطالبات",
    intro:
      "كل مطالبة مفتوحة، الأعلى أولوية أولًا — القيمة، مخاطر الاحتيال، ومدى تأخرها. قدّم المطالبة من هنا؛ التسوية الجارية والتسوية النهائية تُبلغان بطلب دفع، لا من هذا النموذج.",
    "col.ref": "المطالبة",
    "col.holder": "صاحب المطالبة",
    "col.peril": "الخطر",
    "col.incurred": "المتكبد",
    "col.reserve": "الاحتياطي",
    "col.daysOpen": "أيام مفتوحة",
    "col.fraud": "درجة الاحتيال",
    "col.siu": "وحدة التحقيق",
    "col.handler": "المعالج",
    "reserve.unpriced": "لم تُسعَّر بعد",
    "count.reported": "مُبلَّغة",
    "count.triage": "فرز",
    "count.assessing": "تقييم",
    "count.awaiting_docs": "بانتظار مستندات",
    "count.approved": "معتمدة",
    "count.rejected": "مرفوضة",
    "count.settling": "قيد التسوية",
    "count.recovering": "قيد الاسترداد",
    "count.reopened": "أُعيد فتحها",
    "count.withdrawn": "مسحوبة",
    "count.settled": "مسوّاة",
    "count.closed": "مغلقة",
    unassigned: "بلا معالج",
    "sev.breach": "متأخرة",
    "sev.due": "قريبة الاستحقاق",
    "siu.referred": "أُحيلت لوحدة التحقيق",
    "siu.clearing": "قيد تصفية وحدة التحقيق",
    "siu.substantiated": "ثبت الاحتيال",
    "empty.title": "المكتب فارغ",
    "empty.body": "لا توجد مطالبة مفتوحة الآن.",
    "empty.action": "سجّل مطالبة",
    "assign.title": "تعيين معالج",
    "assign.claim": "المطالبة",
    "assign.handler": "المعالج",
    "assign.pick": "اختر زميلاً أو فريقاً",
    "assign.submit": "تعيين",
    "done.assign": "تم تحديث المعالج.",
    "done.transition": "تم تقديم المطالبة.",
    "hop.title": "تقديم",
    "hop.outcome": "النتيجة",
    "hop.reasonCode": "رمز السبب",
    "hop.reason": "ملاحظة",
    "hop.submit": "تقديم",
    "hop.confirm": "{outcome} يُنهي {ref} ضد المُطالِب. يُسجَّل باسمك ويُبلَّغ المُطالِب. هل تريد المتابعة؟",
    "hop.none": "لا انتقال متاح من هنا — التسوية الجارية والنهائية تأتيان بعد طلب دفع.",
    "problem.missing_claim": "اختر مطالبة أولًا.",
    "problem.missing_handler": "حدّد معالجًا قبل التعيين.",
    "problem.bad_transition": "تلك النتيجة غير متاحة من حالة المطالبة الحالية.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "headline.clear": "المكتب فارغ",
    "headline.breached": "{count} مطالبة تجاوزت مهلة الخدمة",
    "headline.moving": "{count} مطالبة مفتوحة، لا شيء متأخر",
    "headline.open": "افتح المطالبة الأعلى أولوية — {ref}"
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- shapes */

export interface ClaimRow {
  id: string;
  claimNo: string;
  customerId: string;
  status: string;
  perilCode: string | null;
  /**
   * `axis_claims.amount_minor` is nullable: a claim can be notified before
   * anyone has put a number on it. Typing it `number` made an unpriced claim
   * render as a zero reserve, which is a different — and much less alarming —
   * fact than "nobody has priced this yet". See `reserveOf`.
   */
  amountMinor: number | null;
  /** `axis_claims.currency` is NOT NULL — every claim carries its own. */
  currency: string;
  reserveMinor: number | null;
  paidMinor: number;
  recoveredMinor: number;
  handlerRef: string | null;
  fraudScore: number | null;
  siuState: string | null;
  slaDueAt: number | null;
  reportedAt: number;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Mirrors packages/core/src/lifecycle.ts. The web app cannot import @lyra/core
 * (same reason claim-detail.tsx restates this map). Drift is caught by the
 * API, which refuses a hop this map would wrongly allow.
 */
export const CLAIM_TRANSITIONS: Record<string, readonly string[]> = {
  reported: ["triage", "withdrawn"],
  triage: ["assessing", "rejected", "withdrawn"],
  assessing: ["awaiting_docs", "approved", "rejected", "withdrawn"],
  awaiting_docs: ["assessing", "withdrawn"],
  approved: ["settling"],
  settling: ["settled", "approved"],
  settled: ["recovering", "closed", "reopened"],
  recovering: ["closed", "reopened"],
  rejected: ["reopened", "closed"],
  closed: ["reopened"],
  reopened: ["assessing"],
  withdrawn: []
};

/** The hops this desk may offer — `settling`/`settled` come from a payment. */
export function hopsFor(status: string): readonly string[] {
  return (CLAIM_TRANSITIONS[status] ?? []).filter((to) => to !== "settling" && to !== "settled");
}

/**
 * Outcomes that end the claim against the claimant. They are still offered like
 * any other hop, but marked as destructive and asked about before they are sent
 * (CLAUDE.md §4) — on a 200-row worklist the Advance button sits inches from
 * the next row's.
 *
 * ponytail: restated in claim-detail.tsx beside its own copy of
 * `CLAIM_TRANSITIONS`, which is duplicated there for the same reason (the web
 * app cannot import @lyra/core). One shared home when a third screen wants it.
 */
export const ADVERSE_HOPS = ["rejected", "withdrawn", "closed"] as const;

export const isAdverseHop = (to: string): boolean =>
  (ADVERSE_HOPS as readonly string[]).includes(to);

/**
 * What is being held for this claim, or `null` when nobody has priced it.
 * `amountMinor` is the claimant's notified figure and stands in until the desk
 * posts its first reserve movement; with neither, the claim is unpriced and the
 * column has to say so rather than print a zero.
 */
export function reserveOf(row: ClaimRow): number | null {
  return row.reserveMinor ?? row.amountMinor;
}

/**
 * Mirrors claim-detail.tsx's inline formula (packages/core/src/claims.ts is
 * also out of reach here). An unpriced claim has incurred whatever has actually
 * moved — nothing is being held for it yet.
 */
export function incurredOf(row: ClaimRow): number {
  return (reserveOf(row) ?? 0) + row.paidMinor - row.recoveredMinor;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENCY_CAP_DAYS = 30;
/** How urgent a claim with no SLA date reads — worse than "plenty of time", better than "overdue". */
const DEFAULT_URGENCY_DAYS = 14;

export const WEIGHTS = {
  money: 1 / 100_000, // one point per 1,000 currency units incurred
  fraud: 2, // fraud score is 0-100
  urgency: 10 // points per day closer than the cap, negative once overdue
} as const;

/** Higher is worse: costlier, riskier, more overdue claims sort first. */
export function priorityScore(
  row: ClaimRow,
  now: number,
  weights: typeof WEIGHTS = WEIGHTS
): number {
  const urgencyDays = row.slaDueAt === null ? DEFAULT_URGENCY_DAYS : (row.slaDueAt - now) / DAY_MS;
  const urgencyScore = URGENCY_CAP_DAYS - urgencyDays;
  return (
    incurredOf(row) * weights.money +
    (row.fraudScore ?? 0) * weights.fraud +
    urgencyScore * weights.urgency
  );
}

export function byPriority(now: number, weights: typeof WEIGHTS = WEIGHTS) {
  return (a: ClaimRow, b: ClaimRow): number => {
    const diff = priorityScore(b, now, weights) - priorityScore(a, now, weights);
    if (diff !== 0) return diff;
    const dueDiff = (a.slaDueAt ?? Infinity) - (b.slaDueAt ?? Infinity);
    if (dueDiff !== 0) return dueDiff;
    return a.reportedAt - b.reportedAt;
  };
}

// Arithmetic on counts the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11).
export function headlineFor(counts: { total: number; breached: number }, l: Label): string {
  if (counts.total === 0) return l("headline.clear");
  if (counts.breached > 0) return l("headline.breached", { count: String(counts.breached) });
  return l("headline.moving", { count: String(counts.total) });
}

async function safe<T>(call: Promise<T>, fallback: T): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const states = OPEN_CLAIM_STATES.join(",");

  const [page, totals] = await Promise.all([
    safe(
      api<{ data: ClaimRow[] }>(
        `/v1/axis/claims?status=${states}&sort=slaDueAt&order=asc&limit=${DESK_PAGE}`,
        opts
      ),
      { data: [] as ClaimRow[] }
    ),
    Promise.all(
      OPEN_CLAIM_STATES.map(async (state) => {
        const got = await safe(
          api<{ total?: number }>(`/v1/axis/claims?status=${state}&count=true&limit=1`, opts),
          {}
        );
        return [state, got.total ?? 0] as const;
      })
    )
  ]);

  // The handler and claimant columns carried `user:us_…` and `cu_…` refs; a
  // desk lists claims by who is on them, not by which ULID is on them.
  const resolved = await names(
    page.data.flatMap((row) => [row.handlerRef, row.customerId]),
    opts
  );

  // Assigning a handler took a typed `user:us_…`, which nobody knows (ADR-0047).
  const assignees = await directory(opts);

  return {
    now: Date.now(),
    names: resolved,
    assignees,
    claims: page.data,
    counts: Object.fromEntries(totals) as Partial<Record<(typeof OPEN_CLAIM_STATES)[number], number>>
  };
}

/* ----------------------------------------------------------------- action */

export interface Refusal {
  title: string;
  status: number;
  code?: string;
  detail?: string;
}

export interface ActionResult {
  problem: Refusal | null;
  done: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "assign") {
      const claimId = String(form.get("claimId") ?? "").trim();
      const handlerRef = String(form.get("handlerRef") ?? "").trim();
      if (!claimId) return refuse("missing_claim");
      if (!handlerRef) return refuse("missing_handler");

      await api(`/v1/axis/claims/${encodeURIComponent(claimId)}`, {
        env,
        request,
        method: "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { handlerRef }
      });
      return { problem: null, done: "assign" };
    }

    if (intent === "transition") {
      const claimId = String(form.get("claimId") ?? "").trim();
      const from = String(form.get("from") ?? "").trim();
      const to = String(form.get("to") ?? "").trim();
      if (!claimId) return refuse("missing_claim");
      if (!hopsFor(from).includes(to)) return refuse("bad_transition");

      const reasonCode = String(form.get("reasonCode") ?? "").trim();
      const reason = String(form.get("reason") ?? "").trim();

      await api(`/v1/axis/claims/${encodeURIComponent(claimId)}/transition`, {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { to, ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) }
      });
      return { problem: null, done: "transition" };
    }
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }

  // "bulk-chase" is not offered here — it is the Chaser agent (task 16, §G.6),
  // and per CLAUDE.md an AI feature does not ship before its eval set does.
  return refuse("bad_intent");
}

/** Codes this screen can phrase; anything else keeps the API's own wording. */
export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/* -------------------------------------------------------------- the screen */

const FRAUD_TONE = (score: number): BadgeTone => (score >= 70 ? "danger" : score >= 40 ? "warning" : "neutral");
const SIU_TONE: Record<string, BadgeTone> = { referred: "info", clearing: "warning", substantiated: "danger" };

function urgencyFlag(row: ClaimRow, now: number, l: Label): { key: string; tone: BadgeTone } | null {
  if (row.slaDueAt === null) return null;
  if (row.slaDueAt < now) return { key: l("sev.breach"), tone: "danger" };
  if (row.slaDueAt - now <= DAY_MS) return { key: l("sev.due"), tone: "warning" };
  return null;
}

// Nine values a row and not one heading: the desk rendered "— AED 0.00 AED
// 0.00 277 Nobody" and left the reader to guess which number was the reserve
// and which was a day count. A real table is out (every row carries its own
// Advance form), so the columns are a grid with one heading row on top, and
// each cell repeats its own label on a narrow screen where the heading row is
// not there to align with.
const DESK_GRID =
  "grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(9rem,1.1fr)_minmax(8rem,1.3fr)_6rem_7rem_7rem_5rem_5rem_7rem_minmax(7rem,1fr)] sm:items-center";

const COLUMNS = [
  "col.ref",
  "col.holder",
  "col.peril",
  "col.incurred",
  "col.reserve",
  "col.daysOpen",
  "col.fraud",
  "col.siu",
  "col.handler"
] as const;

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The heading row above is `aria-hidden` (it is a decorative grid, not a
          table header a cell can point at), so hiding the per-cell label on a
          wide screen left a screen reader nine unlabelled values in a row.
          `sr-only` keeps the visual alignment and gives the label back. */}
      <span className="font-ui text-12 uppercase tracking-wide text-subtle sm:sr-only">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/**
 * One row's Advance form. The outcome is state rather than an uncontrolled
 * `defaultValue` because the button beside it has to know whether the hop being
 * sent ends the claim against the claimant, and swap itself for one that asks.
 */
function HopForm({ row, hops, l, busy }: { row: ClaimRow; hops: readonly string[]; l: Label; busy: boolean }) {
  const [to, setTo] = React.useState(hops[0] ?? "");
  const outcome = optionLabel(l, "count", to);
  // Every button on a 200-row worklist reads "Advance"; the row it belongs to
  // is only obvious to someone who can see it.
  const label = `${l("hop.submit")}: ${row.claimNo}`;

  return (
    <Form method="post" className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="transition" />
      <input type="hidden" name="claimId" value={row.id} />
      <input type="hidden" name="from" value={row.status} />
      <Field label={l("hop.outcome")}>
        <Select
          name="to"
          value={to}
          onValueChange={setTo}
          options={hops.map((hop) => ({
            value: hop,
            // The desk already names every state under `count.*`; reusing those
            // keeps one wording for a state whether it is a column heading or
            // an outcome to pick.
            label: optionLabel(l, "count", hop)
          }))}
        />
      </Field>
      <Field label={l("hop.reasonCode")}>
        <Input name="reasonCode" />
      </Field>
      {/* The action reads `reason` and always has; the form never offered it,
          so every hop went to the ledger with an empty note. */}
      <Field label={l("hop.reason")}>
        <Input name="reason" />
      </Field>
      {isAdverseHop(to) ? (
        <ConfirmButton
          type="submit"
          size="sm"
          variant="danger"
          loading={busy}
          aria-label={label}
          message={l("hop.confirm", { outcome, ref: row.claimNo })}
        >
          {l("hop.submit")}
        </ConfirmButton>
      ) : (
        <Button type="submit" size="sm" loading={busy} aria-label={label}>
          {l("hop.submit")}
        </Button>
      )}
    </Form>
  );
}

export default function ClaimsDesk() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const held = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const now = loaded.now;

  const rows = [...loaded.claims].sort(byPriority(now));
  const breached = rows.filter((row) => row.slaDueAt !== null && row.slaDueAt < now).length;
  const headline = headlineFor({ total: rows.length, breached }, l);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
        {rows[0] ? (
          <Link to={`/axis/claims/${rows[0].id}/detail`} className="w-fit font-ui text-13 text-accent underline">
            {l("headline.open", { ref: rows[0].claimNo })}
          </Link>
        ) : null}
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {/* A hop that succeeded said nothing at all: the row re-rendered with a new
          status somewhere down a 200-row list, which is not feedback. */}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`done.${result.done}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {OPEN_CLAIM_STATES.map((state) => (
          <Badge key={state} tone="neutral" size="sm">
            {l(`count.${state}`)}: {loaded.counts[state] ?? 0}
          </Badge>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={l("empty.title")}
          body={l("empty.body")}
          action={
            <Button asChild size="sm" variant="ghost">
              <Link to="/axis/claims/new">{l("empty.action")}</Link>
            </Button>
          }
        />
      ) : (
        <>
        <div
          aria-hidden="true"
          className={`${DESK_GRID} hidden px-3 font-ui text-12 uppercase tracking-wide text-subtle sm:grid`}
        >
          {COLUMNS.map((key) => (
            <span key={key}>{l(key)}</span>
          ))}
        </div>
        <ul className="space-y-2">
          {rows.map((row) => {
            const hops = hopsFor(row.status);
            const reserve = reserveOf(row);
            const flag = urgencyFlag(row, now, l);
            const daysOpen = Math.floor((now - row.reportedAt) / DAY_MS);
            return (
              <li key={row.id} className="rounded-lg border border-border bg-surface-1 p-3">
                <div className={DESK_GRID}>
                  <Cell label={l("col.ref")}>
                    <Link to={`/axis/claims/${row.id}/detail`} className="flex items-center gap-2">
                      <Ref value={row.claimNo} className="text-accent" />
                      {flag ? (
                        <Badge tone={flag.tone} size="sm" dot>
                          {flag.key}
                        </Badge>
                      ) : null}
                    </Link>
                  </Cell>
                  <Cell label={l("col.holder")}>
                    <Link to={`/admin/customers/${row.customerId}/360`} className="text-accent hover:underline">
                      {who(row.customerId, loaded.names)}
                    </Link>
                  </Cell>
                  <Cell label={l("col.peril")}>{row.perilCode ?? "—"}</Cell>
                  <Cell label={l("col.incurred")}>
                    <Money amountMinor={incurredOf(row)} currency={row.currency} locale={locale} />
                  </Cell>
                  <Cell label={l("col.reserve")}>
                    {reserve === null ? (
                      <span className="text-subtle">{l("reserve.unpriced")}</span>
                    ) : (
                      <Money amountMinor={reserve} currency={row.currency} locale={locale} />
                    )}
                  </Cell>
                  <Cell label={l("col.daysOpen")}>{daysOpen}</Cell>
                  <Cell label={l("col.fraud")}>
                    {row.fraudScore !== null ? (
                      <Badge tone={FRAUD_TONE(row.fraudScore)} size="sm">
                        {row.fraudScore}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Cell>
                  <Cell label={l("col.siu")}>
                    {row.siuState ? (
                      <Badge tone={SIU_TONE[row.siuState] ?? "neutral"} size="sm">
                        {l(`siu.${row.siuState}`)}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Cell>
                  <Cell label={l("col.handler")}>
                    {who(row.handlerRef, loaded.names) ?? l("unassigned")}
                  </Cell>
                </div>

                {held.has(PERM.update) && hops.length > 0 ? (
                  <HopForm row={row} hops={hops} l={l} busy={busy} />
                ) : null}
              </li>
            );
          })}
        </ul>
        </>
      )}

      {held.has(PERM.update) && loaded.claims.length ? (
        <Card title={l("assign.title")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="assign" />
            <Field label={l("assign.claim")} className="w-64">
              <Select name="claimId" options={loaded.claims.map((row) => ({ value: row.id, label: row.claimNo }))} />
            </Field>
            <Field label={l("assign.handler")} className="w-64">
              <Select
                name="handlerRef"
                placeholder={l("assign.pick")}
                options={loaded.assignees.map((one) => ({ value: one.ref, label: one.name }))}
              />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("assign.submit")}
            </Button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}
