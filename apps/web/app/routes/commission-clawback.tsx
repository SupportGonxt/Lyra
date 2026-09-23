import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  Badge,
  Button,
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  GuardrailNotice,
  Money,
  Panel,
  Ref,
  shortRef,
  Textarea,
} from "@lyra/ui";
import {
  ApiError,
  api,
  fetchMe,
  names,
  type Problem as ApiProblem,
} from "../api.server";
import { toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { pseudoText, translator } from "../i18n";
import { optionLabel } from "../modules/spec";
import { Problem } from "./module";
import {
  labelsIn as statementLabels,
  type CommissionEntry,
} from "./commission-statement";
import { useShellData } from "./workspace";

// Reversing a commission entry. This is not an edit: the API writes a second,
// negated entry that points back at this one and moves the original to
// `clawed_back`, so the pair still adds up (CLAUDE.md §12). The screen's whole
// job is to show exactly what will be written before it is written, and to
// carry the reason the reversal needs.

/** apps/api/src/routes/dist.ts, the clawback handler. */
const PERM = {
  read: "dist:commissions:read",
  adjust: "dist:commissions:adjust",
} as const;

/** ClawbackBody: `reason: z.string().min(3).max(500)`. */
const REASON_MIN = 3;
const REASON_MAX = 500;

/** The lines shown side by side: what stands, and what will be written. */
const AMOUNT_KEYS = [
  "premiumMinor",
  "grossCommissionMinor",
  "channelCommissionMinor",
  "netCommissionMinor",
  "taxMinor",
] as const;

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Claw back commission",
    intro:
      "Writes a second entry that mirrors this one with the signs reversed, and moves this entry to clawed back. Nothing is deleted — both entries stay on the statement.",
    back: "Back to the statement",
    "headline.ready": "Reversing the commission entry for {policy}.",
    "headline.blocked": "{policy}: this reversal is blocked.",
    entry: "The entry standing today",
    preview: "What will be written",
    providerId: "Provider",
    channelId: "Channel",
    kind: "Kind",
    state: "State",
    earnedAt: "Earned",
    notEarned: "Not yet earned",
    grossCommissionMinor: "Gross commission",
    channelCommissionMinor: "Channel share",
    netCommissionMinor: "Net commission",
    taxMinor: "Tax",
    reason: "Why is this being reversed?",
    reasonHint:
      "Between {min} and {max} characters. This is read by whoever approves the reversal and stays on the audit trail.",
    confirm: "I have checked the figures above and want this reversal written.",
    submit: "Write the reversal",
    blockedTitle: "This entry cannot be reversed",
    blockedReversal:
      "It is already a reversal of another entry, and the API refuses a reversal of a reversal.",
    blockedClawedBack:
      "It has already been clawed back. Reversing it again would write the negative twice.",
    blockedPermission:
      "Reversing commission needs the commission adjustment permission.",
    deniedTitle: "You cannot read commission",
    missingTitle: "No such commission entry",
    missingBody:
      "It may have been written under another tenant, or the link is stale.",
    approvalTitle: "This reversal needs an approval first",
    approvalBody:
      "Policy {policy} holds commission adjustments for a second pair of eyes. The request has been raised — it is written once someone approves it.",
    doneTitle: "Reversal written",
    doneBody: "Entry {id} now stands against this one.",
    doneLink: "Back to the statement",
    "kind.new_business": "New business",
    "kind.renewal": "Renewal",
    "state.accrued": "Accrued",
  },
  ar: {
    title: "استرداد عمولة",
    intro:
      "يكتب قيدًا ثانيًا يعكس هذا القيد بإشارات معاكسة، وينقل هذا القيد إلى حالة الاسترداد. لا يُحذف شيء — يبقى القيدان في الكشف.",
    back: "العودة إلى الكشف",
    "headline.ready": "جارٍ عكس قيد العمولة الخاص بـ {policy}.",
    "headline.blocked": "{policy}: هذا القيد العكسي محظور.",
    entry: "القيد القائم حاليًا",
    preview: "ما سيتم كتابته",
    providerId: "المزود",
    channelId: "القناة",
    kind: "النوع",
    state: "الوضع",
    earnedAt: "تاريخ الاستحقاق",
    notEarned: "لم يستحق بعد",
    grossCommissionMinor: "إجمالي العمولة",
    channelCommissionMinor: "حصة القناة",
    netCommissionMinor: "صافي العمولة",
    taxMinor: "الضريبة",
    reason: "لماذا يتم عكس هذا القيد؟",
    reasonHint:
      "بين {min} و{max} حرفًا. يقرأه من يعتمد الاسترداد ويبقى في سجل التدقيق.",
    confirm: "راجعت الأرقام أعلاه وأريد كتابة هذا القيد العكسي.",
    submit: "كتابة القيد العكسي",
    blockedTitle: "لا يمكن عكس هذا القيد",
    blockedReversal: "هو أصلًا قيد عكسي لقيد آخر، والنظام يرفض عكس قيد عكسي.",
    blockedClawedBack:
      "تم استرداده بالفعل. عكسه مرة أخرى سيكتب المبلغ السالب مرتين.",
    blockedPermission: "عكس العمولة يتطلب صلاحية تسوية العمولات.",
    deniedTitle: "لا يمكنك قراءة العمولات",
    missingTitle: "لا يوجد قيد عمولة بهذا المعرف",
    missingBody: "قد يكون مكتوبًا تحت مستأجر آخر، أو أن الرابط قديم.",
    approvalTitle: "يحتاج هذا الاسترداد إلى موافقة أولًا",
    approvalBody:
      "سياسة {policy} تحتجز تسويات العمولة لمراجعة ثانية. تم رفع الطلب — ويُكتب بعد الموافقة.",
    doneTitle: "تمت كتابة القيد العكسي",
    doneBody: "القيد {id} أصبح مقابلًا لهذا القيد.",
    doneLink: "العودة إلى الكشف",
    "kind.new_business": "أعمال جديدة",
    "kind.renewal": "تجديد",
    "state.accrued": "مستحق",
  },
};

/**
 * The industry nouns are deliberately absent from LABELS above: they fall
 * through to commission-statement's resolver, which consults the domain pack
 * (CLAUDE.md §14). Keeping a copy of `policyId` here would have shadowed it.
 */
function labelsIn(
  locale: string,
  pack?: string,
): (key: string, vars?: Record<string, string>) => string {
  const table = LABELS[locale] ?? LABELS.en ?? {};
  const fallback = LABELS.en ?? {};
  const shared = statementLabels(locale, pack);
  return (key, vars) => {
    // `shared` is commission-statement's own resolver and pseudoizes itself.
    const own = table[key] ?? fallback[key];
    const raw = own === undefined ? shared(key) : pseudoText(locale, own);
    return vars
      ? raw.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match)
      : raw;
  };
}

/* ------------------------------------------------------------------- rules */

/** The mirror the API will insert: every amount negated, nothing else moved. */
export function reversalPreview(
  entry: CommissionEntry,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of AMOUNT_KEYS) out[key] = -entry[key];
  return out;
}

/** Why this entry cannot be reversed, or null when it can. */
export function blockedReason(
  entry: Pick<CommissionEntry, "reversalOf" | "state">,
  mayAdjust: boolean,
): string | null {
  if (!mayAdjust) return "blockedPermission";
  if (entry.reversalOf !== null) return "blockedReversal";
  if (entry.state === "clawed_back") return "blockedClawedBack";
  return null;
}

/** Header line: which policy this reversal is against, and — when
 *  `blockedReason` found a reason — that it cannot be written. */
export function clawbackHeadline(
  policyLabel: string,
  blocked: string | null,
  l: (key: string, vars?: Record<string, string>) => string,
): string {
  return l(blocked ? "headline.blocked" : "headline.ready", { policy: policyLabel });
}

/**
 * The approval gate, as `gate()` returns it: a 403 that is a queue position,
 * not a refusal. Told apart from a real refusal by `code`.
 */
export function approvalOf(
  problem: ApiProblem | null | undefined,
): { policyKey: string; approvalId?: string } | null {
  if (!problem || problem.status !== 403) return null;
  const extras = problem as ApiProblem & {
    code?: string;
    policy_key?: string;
    approval_id?: string;
  };
  if (extras.code !== "approval_required") return null;
  return {
    policyKey: extras.policy_key ?? problem.detail ?? problem.title,
    ...(extras.approval_id ? { approvalId: extras.approval_id } : {}),
  };
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";

  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = { read: held.has(PERM.read), adjust: held.has(PERM.adjust) };
  if (!may.read) return { may, entry: null, policyName: null, notFound: false };

  try {
    const entry = await api<CommissionEntry>(
      `/v1/dist/commission-entries/${id}`,
      { env, request },
    );
    // One ref on the page, so one lookup: the policy number, which is what this
    // reversal will be argued about by.
    const resolved = await names([entry.policyId], { env, request });
    return { may, entry, policyName: resolved[entry.policyId] ?? null, notFound: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { may, entry: null, policyName: null, notFound: true };
    }
    if (error instanceof ApiError && error.status === 403) {
      return { may: { ...may, read: false }, entry: null, policyName: null, notFound: false };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ action */

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const reason = String(form.get("reason") ?? "").trim();

  try {
    const reversal = await api<CommissionEntry>(
      `/v1/dist/commission-entries/${params.id ?? ""}/clawback`,
      { env, request, method: "POST", body: { reason } },
    );
    return { problem: null, reversal };
  } catch (error) {
    // An approval gate answers 403 here. That is not a failure, so it is read
    // out of the problem below rather than shown as an error.
    if (error instanceof ApiError)
      return { problem: error.problem, reversal: null };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function CommissionClawback() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  const entry = loaded.entry;

  if (!entry) {
    return (
      <Shell l={l}>
        <EmptyState
          title={loaded.notFound ? l("missingTitle") : l("deniedTitle")}
          body={loaded.notFound ? l("missingBody") : t("error.forbidden")}
        />
      </Shell>
    );
  }

  const reversal = result?.reversal ?? null;
  if (reversal) {
    return (
      <Shell l={l}>
        <EmptyState
          title={l("doneTitle")}
          body={l("doneBody", { id: reversal.id })}
          action={
            <Button asChild>
              <Link to="/distribution/commission-entries/statement">
                {l("doneLink")}
              </Link>
            </Button>
          }
        />
      </Shell>
    );
  }

  const blocked = blockedReason(entry, loaded.may.adjust);
  const approval = approvalOf(result?.problem);
  const preview = reversalPreview(entry);
  const policyLabel = loaded.policyName ?? shortRef(entry.policyId);

  return (
    <Shell l={l} description={clawbackHeadline(policyLabel, blocked, l)}>
      {/* The entry and its mirror are one thing to read, so they share one
          surface: the facts above, the side-by-side reversal below. */}
      <Panel>
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <Facet term={l("policyId")}>
            <Link
              to={`/distribution/policies/${entry.policyId}`}
              className="font-ui text-12 text-accent underline-offset-2 hover:underline"
            >
              {policyLabel}
            </Link>
          </Facet>
          <Facet term={l("providerId")}>
            <Ref value={entry.providerId} className="text-12" />
          </Facet>
          <Facet term={l("channelId")}>
            <Ref value={entry.channelId} className="text-12" />
          </Facet>
          <Facet term={l("kind")}>
            <span>{optionLabel(l, "kind", entry.kind)}</span>
          </Facet>
          <Facet term={l("state")}>
            <Badge tone={toneFor(entry.state)} size="sm" dot>
              {optionLabel(l, "state", entry.state)}
            </Badge>
          </Facet>
          <Facet term={l("earnedAt")}>
            {entry.earnedAt === null ? (
              <span className="text-subtle">{l("notEarned")}</span>
            ) : (
              <DateTime
                value={entry.earnedAt}
                locale={locale}
                precision="day"
              />
            )}
          </Facet>
        </dl>

        {/* Standing beside proposed, on one row each, so the reversal is read as
          the mirror it is rather than as five separate new figures. */}
        <table className="w-full max-w-2xl border-collapse text-start">
          <caption className="pb-2 text-start font-ui text-12 text-subtle">
            {l("preview")}
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="py-2 text-start font-ui text-12 font-medium text-subtle"
              />
              <th
                scope="col"
                className="py-2 text-end font-ui text-12 font-medium text-subtle"
              >
                {l("entry")}
              </th>
              <th
                scope="col"
                className="py-2 text-end font-ui text-12 font-medium text-subtle"
              >
                {l("preview")}
              </th>
            </tr>
          </thead>
          <tbody>
            {AMOUNT_KEYS.map((key) => (
              <tr key={key} className="border-b border-border/40">
                <th
                  scope="row"
                  className="py-2 text-start font-ui text-13 font-normal text-muted"
                >
                  {l(key)}
                </th>
                <td className="py-2 text-end font-ui text-13 tabular-nums text-text">
                  <Money
                    amountMinor={entry[key]}
                    currency={entry.currency}
                    locale={locale}
                  />
                </td>
                <td className="py-2 text-end font-ui text-13 tabular-nums">
                  <Money
                    amountMinor={preview[key] ?? 0}
                    currency={entry.currency}
                    locale={locale}
                    signed
                    toned
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {blocked ? (
        <GuardrailNotice title={l("blockedTitle")} reason={l(blocked)} />
      ) : (
        <>
          {approval ? (
            <GuardrailNotice
              title={l("approvalTitle")}
              reason={l("approvalBody", { policy: approval.policyKey })}
              action={
                <Link to="/approvals" className="underline underline-offset-2">
                  {l("approvalLink")}
                </Link>
              }
            />
          ) : result?.problem ? (
            <Problem problem={result.problem} />
          ) : null}

          <Panel className="max-w-2xl">
            <Form method="post" className="flex flex-col gap-4">
              <Field
                label={l("reason")}
                required
                hint={l("reasonHint", {
                  min: String(REASON_MIN),
                  max: String(REASON_MAX),
                })}
              >
                <Textarea
                  name="reason"
                  rows={3}
                  required
                  minLength={REASON_MIN}
                  maxLength={REASON_MAX}
                />
              </Field>
              {/* A checkbox, not a modal: the figures stay on screen while the
                  actor confirms them (docs/15 — AI and money never interrupt). */}
              <Checkbox name="confirm" required label={l("confirm")} />
              <div>
                <Button type="submit" variant="danger" loading={busy}>
                  {l("submit")}
                </Button>
              </div>
            </Form>
          </Panel>
        </>
      )}
    </Shell>
  );
}

function Shell({
  l,
  description,
  children,
}: {
  l: (key: string, vars?: Record<string, string>) => string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            to="/distribution/commission-entries/statement"
            className="w-fit font-ui text-12 text-subtle underline-offset-2 hover:underline"
          >
            {l("back")}
          </Link>
          <h1 className="page-title">
            {l("title")}
          </h1>
          <p className="max-w-prose font-ui text-13 text-muted">
            {description ?? l("intro")}
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

function Facet({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="font-ui text-13 text-text">{children}</dd>
    </div>
  );
}
