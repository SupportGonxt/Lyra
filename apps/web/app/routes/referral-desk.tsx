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
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  Input,
  KPIWall,
  Money,
  Stat,
  Table,
  Textarea,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { daysUntil, safe, type Page } from "./orbit-shared";
import { labelsFrom } from "./detail-kit";
import { localeFrom } from "../i18n";

// §A.4/§D.6: the underwriter's side of the referral gate.ts opens on the bind
// path — a risk outside delegated authority, waiting on a person. One read
// (open referrals, soonest SLA first) and one write, POST
// /v1/axis/referrals/:id/decide.
//
// This is a route rather than three declarative ActionSpecs because the decide
// body carries its own `intent` field, and record.tsx already owns a form field
// of that name to route on: a declared field named `intent` is shadowed by the
// routing input, so the body would post {intent:"decide"} and the endpoint's
// z.enum(["accept","decline","counter"]) would reject it.

export const PERM = { decide: "axis:policies:decide_referral" } as const;

/* --------------------------------------------------------------- contract */

export interface Referral {
  id: string;
  caseId: string | null;
  policyId: string | null;
  quoteResponseId: string | null;
  kind: string;
  /** Which rule fired, with its values. Parsed by the API's `*Json` reader. */
  triggerJson: unknown;
  valueMinor: number | null;
  currency: string | null;
  state: string;
  decidedBy: string | null;
  decisionNote: string | null;
  counterTermsJson: unknown;
  approvalId: string | null;
  slaDueAt: number | null;
  createdAt: number;
}

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Referral desk",
    intro: "Risks held outside delegated authority, soonest deadline first. Accept, decline or counter.",
    empty: "Nothing is waiting on an underwriter.",
    count: "Waiting",
    referral: "Referral",
    value: "Value",
    slaDue: "Decision due",
    daysLeft: "Days left",
    trigger: "Why referred",
    triggerWhy: "The rule that fired",
    act: "Decision",
    accept: "Accept",
    decline: "Decline",
    counter: "Counter",
    reason: "Reason",
    counterTerms: "Counter terms",
    counterHint: 'The terms you will write back, as JSON — for example {"excessMinor": 50000}.',
    more: "Decline or counter",
    saved: "Decision recorded.",
    "kind.authority_limit": "Over authority",
    "kind.eligibility": "Eligibility",
    "kind.sanctions": "Sanctions",
    "kind.manual": "Referred by hand",
    "problem.missing_referral": "Pick a referral first.",
    "problem.missing_reason": "A declined referral needs a reason.",
    "problem.missing_terms": "A counter needs the terms you are offering.",
    "problem.bad_terms": "The counter terms must be a JSON object.",
    "problem.unknown_intent": "That control is not available.",
    "headline.clear": "Nothing is waiting on an underwriter",
    "headline.urgent": "{count} referrals are due within a day",
    "headline.waiting": "{count} referrals waiting, none due within a day",
    "headline.open": "Open the most urgent referral — {ref}"
  },
  ar: {
    title: "مكتب الإحالات",
    intro: "المخاطر خارج الصلاحية المفوَّضة، الأقرب موعدًا أولًا. اقبل أو ارفض أو اعرض بديلًا.",
    empty: "لا شيء ينتظر مكتتبًا.",
    count: "قيد الانتظار",
    referral: "الإحالة",
    value: "القيمة",
    slaDue: "موعد القرار",
    daysLeft: "الأيام المتبقية",
    trigger: "سبب الإحالة",
    triggerWhy: "القاعدة التي انطبقت",
    act: "القرار",
    accept: "قبول",
    decline: "رفض",
    counter: "عرض بديل",
    reason: "السبب",
    counterTerms: "شروط العرض البديل",
    counterHint: 'الشروط التي سترد بها، بصيغة JSON — مثال {"excessMinor": 50000}.',
    more: "رفض أو عرض بديل",
    saved: "تم تسجيل القرار.",
    "kind.authority_limit": "تجاوز الصلاحية",
    "kind.eligibility": "الأهلية",
    "kind.sanctions": "العقوبات",
    "kind.manual": "إحالة يدوية",
    "problem.missing_referral": "اختر إحالة أولًا.",
    "problem.missing_reason": "الرفض يحتاج سببًا.",
    "problem.missing_terms": "العرض البديل يحتاج الشروط المعروضة.",
    "problem.bad_terms": "يجب أن تكون شروط العرض البديل كائن JSON.",
    "problem.unknown_intent": "هذا الإجراء غير متاح.",
    "headline.clear": "لا شيء ينتظر مكتتبًا",
    "headline.urgent": "{count} إحالات مستحقة خلال يوم واحد",
    "headline.waiting": "{count} إحالة قيد الانتظار، لا شيء منها مستحق خلال يوم",
    "headline.open": "افتح الإحالة الأكثر إلحاحًا — {ref}"
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

export const labelsIn = labelsFrom(LABELS);

/** The days-left cut the desk already flags danger at (the `daysLeft` column). */
export const DAYS_LEFT_DANGER = 1;

// Arithmetic on counts the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11).
export function headlineFor(counts: { total: number; urgent: number }, l: Label): string {
  if (counts.total === 0) return l("headline.clear");
  if (counts.urgent > 0) return l("headline.urgent", { count: String(counts.urgent) });
  return l("headline.waiting", { count: String(counts.total) });
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request);
  const decide = new Set(me.permissions).has(PERM.decide);
  const empty: Page<Referral> = { data: [] };

  const page = decide
    ? await safe(
        () => api<Page<Referral>>("/v1/axis/referrals?state=open&sort=slaDueAt&order=asc&limit=50", opts),
        empty
      )
    : empty;

  return {
    locale: localeFrom(request),
    now: Date.now(),
    nonce: crypto.randomUUID(),
    may: { decide },
    rows: page.data
  };
}

/* ------------------------------------------------------------------ action */

export interface Refusal {
  title: string;
  status: number;
  code?: string;
  detail?: string;
}

export interface ActionResult {
  problem: Refusal | null;
  saved: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  saved: null
});

/** The endpoint takes `z.record(...)`, so an array, a scalar or a syntax error
 *  is a 400 from the API. Catch it here and say which of the two it was. */
export function parseTerms(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  if (intent !== "accept" && intent !== "decline" && intent !== "counter") return refuse("unknown_intent");
  if (!id) return refuse("missing_referral");

  const reason = String(form.get("reason") ?? "").trim();
  if (intent === "decline" && !reason) return refuse("missing_reason");

  let counterTermsJson: Record<string, unknown> | undefined;
  if (intent === "counter") {
    const raw = String(form.get("counterTerms") ?? "").trim();
    if (!raw) return refuse("missing_terms");
    const parsed = parseTerms(raw);
    if (!parsed) return refuse("bad_terms");
    counterTermsJson = parsed;
  }

  try {
    await api(`/v1/axis/referrals/${id}/decide`, {
      ...opts,
      method: "POST",
      headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
      body: {
        intent,
        ...(reason ? { reason } : {}),
        ...(counterTermsJson ? { counterTermsJson } : {})
      }
    });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, saved: null };
    throw error;
  }

  return { problem: null, saved: id };
}

export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/* --------------------------------------------------------------- component */

export default function ReferralDesk() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state === "submitting";

  if (!loaded.may.decide) {
    return <EmptyState title={l("title")} body={l("empty")} />;
  }

  const urgent = loaded.rows.filter((row) => {
    const days = daysUntil(row.slaDueAt, loaded.now);
    return days !== null && days <= DAYS_LEFT_DANGER;
  }).length;
  const headline = headlineFor({ total: loaded.rows.length, urgent }, l);
  const soonest = loaded.rows[0];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{headline}</h1>
        <p className="font-ui text-13 text-muted">{l("intro")}</p>
        {soonest?.caseId ? (
          <Link
            to={`/axis/cases/${soonest.caseId}`}
            className="w-fit font-ui text-13 text-accent underline"
          >
            {l("headline.open", { ref: soonest.caseId })}
          </Link>
        ) : null}
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {result?.saved ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l("saved")}</p>
        </div>
      ) : null}

      <KPIWall>
        <Stat label={l("count")} value={String(loaded.rows.length)} />
      </KPIWall>

      <Card title={l("title")} description={l("intro")}>
        {loaded.rows.length === 0 ? (
          <EmptyState title={l("empty")} body={l("intro")} />
        ) : (
          <Table
            caption={l("title")}
            rows={loaded.rows}
            rowKey={(row) => row.id}
            columns={
              [
                {
                  key: "referral",
                  header: l("referral"),
                  render: (row) => (
                    <div className="flex flex-col">
                      {row.caseId ? (
                        <Link
                          to={`/axis/cases/${row.caseId}`}
                          className="font-ui text-13 text-accent underline underline-offset-2"
                        >
                          {row.caseId}
                        </Link>
                      ) : (
                        <span className="font-ui text-13 text-text">{row.id}</span>
                      )}
                      <span className="font-mono text-12 text-subtle">{row.id}</span>
                    </div>
                  )
                },
                {
                  key: "kind",
                  header: l("trigger"),
                  render: (row) => (
                    <EvidenceLink
                      sourceLabel={l("triggerWhy")}
                      source={
                        <pre className="overflow-x-auto font-mono text-12 text-muted">
                          {JSON.stringify(row.triggerJson, null, 2)}
                        </pre>
                      }
                    >
                      <Badge tone={row.kind === "sanctions" ? "danger" : "warning"}>{l(`kind.${row.kind}`)}</Badge>
                    </EvidenceLink>
                  )
                },
                {
                  key: "value",
                  header: l("value"),
                  numeric: true,
                  render: (row) =>
                    row.valueMinor === null ? (
                      "—"
                    ) : (
                      <Money amountMinor={row.valueMinor} currency={row.currency ?? "USD"} locale={loaded.locale} />
                    )
                },
                {
                  key: "slaDueAt",
                  header: l("slaDue"),
                  render: (row) =>
                    row.slaDueAt ? <DateTime value={row.slaDueAt} locale={loaded.locale} precision="day" /> : "—"
                },
                {
                  key: "daysLeft",
                  header: l("daysLeft"),
                  numeric: true,
                  render: (row) => {
                    const days = daysUntil(row.slaDueAt, loaded.now);
                    if (days === null) return "—";
                    return (
                      <span className={days <= 1 ? "font-ui text-13 font-medium text-danger" : "font-ui text-13 text-text"}>
                        {days}
                      </span>
                    );
                  }
                },
                {
                  key: "act",
                  header: l("act"),
                  render: (row) => (
                    <div className="flex flex-col gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="accept" />
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="nonce" value={`accept:${loaded.nonce}:${row.id}`} />
                        <Button type="submit" size="sm" disabled={busy}>
                          {busy ? l("working") : l("accept")}
                        </Button>
                      </Form>
                      {/* ponytail: native disclosure, not a modal — docs/15 §4 keeps
                          the decision on the row it belongs to. */}
                      <details className="font-ui text-13 text-muted">
                        <summary className="cursor-pointer">{l("more")}</summary>
                        <div className="mt-2 flex flex-col gap-3">
                          <Form method="post" className="flex flex-col gap-2">
                            <input type="hidden" name="intent" value="decline" />
                            <input type="hidden" name="id" value={row.id} />
                            <input type="hidden" name="nonce" value={`decline:${loaded.nonce}:${row.id}`} />
                            <Field label={l("reason")}>
                              <Input name="reason" size="sm" required />
                            </Field>
                            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                              {l("decline")}
                            </Button>
                          </Form>
                          <Form method="post" className="flex flex-col gap-2">
                            <input type="hidden" name="intent" value="counter" />
                            <input type="hidden" name="id" value={row.id} />
                            <input type="hidden" name="nonce" value={`counter:${loaded.nonce}:${row.id}`} />
                            <Field label={l("counterTerms")} hint={l("counterHint")}>
                              <Textarea name="counterTerms" rows={3} required />
                            </Field>
                            <Field label={l("reason")}>
                              <Input name="reason" size="sm" />
                            </Field>
                            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                              {l("counter")}
                            </Button>
                          </Form>
                        </div>
                      </details>
                    </div>
                  )
                }
              ] satisfies Column<Referral>[]
            }
          />
        )}
      </Card>
    </div>
  );
}
