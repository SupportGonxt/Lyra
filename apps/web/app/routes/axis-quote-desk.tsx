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
  DatePicker,
  DateTime,
  EmptyState,
  Field,
  Input,
  KPIWall,
  Money,
  shortRef,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, names } from "../api.server";
import { ConfirmButton } from "../components/confirm";
import { HeroStat, lensOf, useFocus, type Lens } from "../components/hero";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { labelsFrom } from "./detail-kit";

// One case, several providers, one decision. The quotes tab lists rows; a desk
// has to group them by the case they answer, mark the cheapest, say what expires
// tonight, and let the winner be picked and issued without leaving the screen.
//
// This is also the group-bid screen. A "bid" in this schema is not its own
// table: it is the set of `axis_quotes` against one case, and a scheme bid is
// that set against a `group_medical` case. So the module spec links here twice —
// once bare, once as `?kind=group_medical` — and the only difference is which
// cases are in scope. A second route would have been the same code with a
// different filter.

/* --------------------------------------------------------------- contract */

export const PERM = {
  cases: "axis:cases:read",
  quotes: "dist:quote_requests:read",
  /** Ruling a quote out is an AXIS desk judgment. */
  quoteWrite: "axis:quotes:create",
  /** Picking the winner is dist's `/select` verb — one table, one door (F13). */
  pick: "dist:quote_requests:select",
  /** The sale endpoint (`/quote-responses/:id/bind`). */
  issue: "axis:policies:bind"
} as const;

/** Cases in scope: the ones out with providers, waiting on paper to come back. */
export const OPEN_CASE_STATUSES = ["quoting", "review", "approval"] as const;

/** A quote inside this window is worth chasing tonight. */
export const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

const PAGE = 200;

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Quote desk",
    "title.group": "Group bids",
    intro:
      "Cases out with providers, grouped by the case each quote answers. The cheapest live quote is marked; picking a winner does not issue anything by itself.",
    "intro.group":
      "Scheme bids: the same desk narrowed to group cases, where several providers price one census and the spread is the whole negotiation.",
    "stat.cases": "Cases on the desk",
    "stat.quotes": "Live quotes",
    "stat.expiring": "Expiring within a week",
    "stat.silent": "Awaiting a first response",
    // The hero headline: arithmetic on the same groups the KPI wall counts, not
    // a count itself — a count in the sentence would need a plural rule per
    // locale to stay grammatical (Arabic has five), same reasoning as home.tsx.
    "headline.silent": "Some cases on the desk have not heard from a provider yet.",
    "headline.expiring": "A live quote on the desk is expiring within the week.",
    "headline.clear": "Every case on the desk has a live quote.",
    "headline.open": "Open {ref}",
    "group.silent": "No provider has priced this yet",
    "group.best": "Best live price",
    "group.spread": "Spread to the next price",
    "col.provider": "Provider",
    "col.premium": "Premium",
    "col.valid": "Valid until",
    "col.source": "Came from",
    "flag.best": "Cheapest",
    "flag.won": "Picked",
    "flag.expired": "Expired",
    "flag.soon": "Expires soon",
    "flag.declined": "Declined",
    "pick.submit": "Pick",
    "pick.hint": "Marks this quote as the one the case will be issued from.",
    "decline.submit": "Decline",
    "decline.reason": "Reason",
    "decline.confirm": "Declining {provider}'s quote takes it off this case for good. Continue?",
    "issue.title": "Issue from the picked quote",
    "issue.intro":
      "Issuing creates a contract and money follows it, so it goes through the platform's binding approval before it exists.",
    "issue.quote": "Picked quote",
    "issue.policyNo": "Contract number",
    "issue.customer": "Customer",
    "issue.start": "Cover starts",
    "issue.end": "Cover ends",
    "issue.submit": "Issue",
    "issue.noCustomer": "No customer named — this quote cannot be sold.",
    "issue.none": "Pick a winning quote first — there is nothing to issue from yet.",
    "done.pick": "Winner recorded.",
    "done.decline": "Quote declined.",
    "done.issue": "Contract issued.",
    "empty.title": "The desk is clear",
    "empty.body": "No case is out with a provider right now.",
    "problem.bad_intent": "The form did not carry an action this screen knows.",
    "problem.missing_quote": "No quote was named.",
    "problem.missing_reason": "A decline has to say why — it is what the provider is told.",
    "problem.missing_policy": "A contract needs its number and both cover dates.",
    "problem.bad_dates": "Cover cannot end before it starts."
  },
  ar: {
    title: "مكتب التسعير",
    "title.group": "عروض المجموعات",
    intro:
      "الحالات المطروحة على المزوّدين، مجمّعة حسب الحالة التي يجيبها كل عرض. أرخص عرض ساري مُعلَّم؛ واختيار الفائز لا يُصدر شيئًا بحد ذاته.",
    "intro.group":
      "عروض البرامج الجماعية: المكتب نفسه مقصورًا على الحالات الجماعية، حيث يسعّر عدة مزوّدين كشفًا واحدًا ويكون الفارق هو جوهر التفاوض.",
    "stat.cases": "حالات على المكتب",
    "stat.quotes": "عروض سارية",
    "stat.expiring": "تنتهي خلال أسبوع",
    "stat.silent": "بانتظار أول رد",
    "headline.silent": "بعض الحالات على المكتب لم تتلقَّ ردًا من أي مزوّد بعد.",
    "headline.expiring": "أحد العروض السارية على المكتب ينتهي خلال الأسبوع.",
    "headline.clear": "كل حالة على المكتب لديها عرض سارٍ.",
    "headline.open": "فتح {ref}",
    "group.silent": "لم يسعّرها أي مزوّد بعد",
    "group.best": "أفضل سعر ساري",
    "group.spread": "الفارق عن السعر التالي",
    "col.provider": "المزوّد",
    "col.premium": "القسط",
    "col.valid": "ساري حتى",
    "col.source": "المصدر",
    "flag.best": "الأرخص",
    "flag.won": "مُختار",
    "flag.expired": "منتهٍ",
    "flag.soon": "ينتهي قريبًا",
    "flag.declined": "مرفوض",
    "pick.submit": "اختيار",
    "pick.hint": "يعلّم هذا العرض بأنه العرض الذي ستُصدر منه الحالة.",
    "decline.submit": "رفض",
    "decline.reason": "السبب",
    "decline.confirm": "رفض عرض {provider} يزيله عن هذه الحالة نهائيًا. هل تريد المتابعة؟",
    "issue.title": "الإصدار من العرض المختار",
    "issue.intro": "الإصدار ينشئ عقدًا ويتبعه مال، لذا يمر بموافقة الارتباط في المنصة قبل أن يوجد.",
    "issue.quote": "العرض المختار",
    "issue.policyNo": "رقم العقد",
    "issue.customer": "العميل",
    "issue.start": "بداية التغطية",
    "issue.end": "نهاية التغطية",
    "issue.submit": "إصدار",
    "issue.noCustomer": "لا عميل مسمّى — لا يمكن بيع هذا العرض.",
    "issue.none": "اختر عرضًا فائزًا أولًا — لا يوجد ما يُصدر منه بعد.",
    "done.pick": "سُجّل الفائز.",
    "done.decline": "رُفض العرض.",
    "done.issue": "أُصدر العقد.",
    "empty.title": "المكتب خالٍ",
    "empty.body": "لا توجد حالة مطروحة على مزوّد الآن.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "problem.missing_quote": "لم يُحدَّد أي عرض.",
    "problem.missing_reason": "الرفض يجب أن يذكر سببه — فهو ما يُبلَّغ به المزوّد.",
    "problem.missing_policy": "العقد يحتاج رقمه وتاريخَي التغطية.",
    "problem.bad_dates": "لا يمكن أن تنتهي التغطية قبل بدايتها."
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- shapes */

export interface DeskCase {
  id: string;
  ref: string;
  kind: string;
  status: string;
  customerId: string | null;
  currency: string | null;
  slaDueAt: number | null;
  /** The shop this case is quoting through — where its bids live (F13). */
  quoteRequestId: string | null;
}

/** One row of `dist_quote_responses`, as the API returns it. */
export interface QuoteResponse {
  id: string;
  requestId: string;
  providerId: string;
  premiumMinor: number | null;
  currency: string | null;
  validUntil: number | null;
  declineReason: string | null;
  selectedAt: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface DeskQuote {
  id: string;
  requestId: string;
  caseId: string;
  providerId: string;
  premiumMinor: number;
  currency: string;
  validUntil: number | null;
  winFlag: boolean;
  declineReason: string | null;
  source: string;
  createdAt: number;
}

export type Expiry = "expired" | "soon" | "live";

export interface Bid extends DeskQuote {
  expiry: Expiry;
  /** Cheapest of the quotes still worth accepting on this case. */
  best: boolean;
}

export interface BidGroup {
  case: DeskCase;
  bids: Bid[];
  /** Cheapest live premium, or null while nobody has priced it. */
  bestMinor: number | null;
  /** Gap from the cheapest live quote to the next one — the negotiating room. */
  spreadMinor: number | null;
  expiringSoon: number;
}

/* ---------------------------------------------------------------- helpers */

/** A quote with no `validUntil` is open-ended, not expired. */
export function expiryOf(quote: { validUntil: number | null }, now: number, soonMs = EXPIRY_SOON_MS): Expiry {
  if (quote.validUntil === null) return "live";
  if (quote.validUntil < now) return "expired";
  return quote.validUntil - now <= soonMs ? "soon" : "live";
}

/** Declined and expired quotes cannot be picked, so they cannot be the best price. */
const acceptable = (bid: Bid): boolean => bid.expiry !== "expired" && bid.declineReason === null;

/**
 * Group the flat quote list under the case each quote answers, cheapest first,
 * and work out the best price and the spread behind it. Cases with no quote yet
 * stay in the result — "nobody has answered" is the desk's most urgent row.
 */
export function deskGroups(cases: DeskCase[], quotes: DeskQuote[], now: number): BidGroup[] {
  return cases.map((kase) => {
    const bids: Bid[] = quotes
      .filter((quote) => quote.caseId === kase.id)
      .map((quote) => ({ ...quote, expiry: expiryOf(quote, now), best: false }))
      .sort((a, b) => a.premiumMinor - b.premiumMinor || a.createdAt - b.createdAt);

    const live = bids.filter(acceptable);
    if (live[0]) live[0].best = true;

    return {
      case: kase,
      bids,
      bestMinor: live[0]?.premiumMinor ?? null,
      spreadMinor: live[1] ? live[1].premiumMinor - live[0]!.premiumMinor : null,
      expiringSoon: bids.filter((bid) => bid.expiry === "soon").length
    };
  });
}

/**
 * What each drillable hero figure counted. Two families because the wall counts
 * two different things: `stat.silent` counts cases, the other two count the bids
 * underneath them. `stat.cases` is the whole desk and needs no lens.
 */
export const GROUP_LENSES: Record<string, Lens<BidGroup>> = {
  silent: (entry) => entry.bids.length === 0
};

export const BID_LENSES: Record<string, Lens<Bid>> = {
  quotes: (bid) => bid.expiry !== "expired",
  expiring: (bid) => bid.expiry === "soon"
};

/**
 * The desk narrowed to one hero figure's rows. A case lens filters the cards; a
 * bid lens filters the bids inside each card and drops the cards it emptied —
 * otherwise a case with nothing expiring would appear inside the "expiring"
 * drill-down. Either way the rows on screen are the ones the figure counted.
 */
export function deskFocus(groups: BidGroup[], focus: string | null): BidGroup[] {
  if (focus === null) return groups;
  const byCase = GROUP_LENSES[focus];
  if (byCase) return groups.filter(byCase);
  const byBid = BID_LENSES[focus];
  if (!byBid) return groups;
  return groups
    .map((entry) => ({ ...entry, bids: entry.bids.filter(byBid) }))
    .filter((entry) => entry.bids.length > 0);
}

/** Cases nobody has answered first, then the ones with something expiring. */
export function byPressure(a: BidGroup, b: BidGroup): number {
  const silent = Number(b.bids.length === 0) - Number(a.bids.length === 0);
  if (silent !== 0) return silent;
  const soon = b.expiringSoon - a.expiringSoon;
  return soon !== 0 ? soon : a.case.ref.localeCompare(b.case.ref);
}

/**
 * The hero's headline, as a label key: the desk's own pressure, in the same
 * priority `byPressure` already sorts by — a case nobody has answered outranks
 * one merely expiring. `""` means there is nothing on the desk to narrate, and
 * the screen falls back to its plain title.
 */
export function deskHeadlineKey(groups: BidGroup[], silent: number, expiringSoon: number): string {
  if (groups.length === 0) return "";
  if (silent > 0) return "headline.silent";
  if (expiringSoon > 0) return "headline.expiring";
  return "headline.clear";
}

export function flagsOf(bid: Bid): { key: string; tone: BadgeTone }[] {
  const flags: { key: string; tone: BadgeTone }[] = [];
  if (bid.winFlag) flags.push({ key: "flag.won", tone: "accent" });
  if (bid.best) flags.push({ key: "flag.best", tone: "success" });
  if (bid.expiry === "expired") flags.push({ key: "flag.expired", tone: "danger" });
  if (bid.expiry === "soon") flags.push({ key: "flag.soon", tone: "warning" });
  if (bid.declineReason !== null) flags.push({ key: "flag.declined", tone: "neutral" });
  return flags;
}

/**
 * docs/27 F13. The desk reads `dist_quote_responses` — the panel's own answers
 * and the ones the desk keyed by hand, one table. A response carrying no
 * premium is a decline or a timeout the provider never priced: nothing to
 * compare, so it is not a bid on this screen.
 */
export function toDeskQuotes(cases: DeskCase[], responses: QuoteResponse[]): DeskQuote[] {
  const caseOf = new Map(
    cases.flatMap((kase) => (kase.quoteRequestId ? [[kase.quoteRequestId, kase] as const] : []))
  );
  return responses.flatMap((row) => {
    const kase = caseOf.get(row.requestId);
    if (!kase || row.premiumMinor === null) return [];
    return [
      {
        id: row.id,
        requestId: row.requestId,
        caseId: kase.id,
        providerId: row.providerId,
        premiumMinor: row.premiumMinor,
        currency: row.currency ?? kase.currency ?? "",
        validUntil: row.validUntil,
        winFlag: row.selectedAt !== null,
        declineReason: row.declineReason,
        // ponytail: the response table has no `source` column — every machine
        // path stamps a latency and the manual capture route does not. Display
        // only; a migration for one cell can wait for a second use.
        source: row.latencyMs === null ? "manual" : "api",
        createdAt: row.createdAt
      }
    ];
  });
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
  // `?kind=group_medical` is what makes this the group-bid screen. Anything else
  // the caller puts there is still a case kind, so it is passed through as one.
  const kind = new URL(request.url).searchParams.get("kind");

  const cases = await safe(
    api<{ data: DeskCase[] }>(
      `/v1/axis/cases?status=${OPEN_CASE_STATUSES.join(",")}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}&sort=slaDueAt&order=asc&limit=${PAGE}`,
      opts
    ),
    { data: [] as DeskCase[] }
  );

  // One call for every bid on those cases: the CRUD filter reads a comma as
  // "either", so the desk does not fan out one request per case. A case with no
  // shop open yet has no request id and simply has no bids.
  const ids = cases.data.flatMap((row) => (row.quoteRequestId ? [row.quoteRequestId] : []));
  const responses = ids.length
    ? await safe(
        api<{ data: QuoteResponse[] }>(
          `/v1/dist/quote-responses?requestId=${ids.map(encodeURIComponent).join(",")}&sort=validUntil&order=asc&limit=${PAGE}`,
          opts
        ),
        { data: [] as QuoteResponse[] }
      )
    : { data: [] as QuoteResponse[] };

  // Every bid on this desk named its insurer `prv_01KE…` and the issue form
  // asked for the customer as a pasted id. One batch names both (docs/07).
  const resolved = await names(
    [
      ...responses.data.map((row) => row.providerId),
      ...cases.data.map((row) => row.customerId)
    ],
    opts
  );

  return {
    now: Date.now(),
    kind,
    cases: cases.data,
    quotes: toDeskQuotes(cases.data, responses.data),
    resolved
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

/** A date input gives "2026-08-04"; the schema wants epoch millis. */
export function epochOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The sale a picked quote turns into. The bind endpoint reads the premium,
 * provider and customer off the quote on the server, so the form carries only
 * what the operator decides: the contract number and the cover dates. Pure so
 * every refusal can be tested without a request.
 */
export function bindFrom(
  form: FormData
): { quoteId: string; body: Record<string, unknown> } | { code: string } {
  const quoteId = String(form.get("quoteId") ?? "").trim();
  const policyNo = String(form.get("policyNo") ?? "").trim();
  const caseId = String(form.get("caseId") ?? "").trim();
  const startAt = epochOf(String(form.get("startAt") ?? ""));
  const endAt = epochOf(String(form.get("endAt") ?? ""));

  if (!quoteId) return { code: "missing_quote" };
  if (!policyNo || startAt === null || endAt === null) return { code: "missing_policy" };
  if (endAt < startAt) return { code: "bad_dates" };

  return { quoteId, body: { caseId, policyNo, startAt, endAt } };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const headers = { "idempotency-key": crypto.randomUUID() };

  try {
    if (intent === "pick" || intent === "decline") {
      const id = String(form.get("quoteId") ?? "").trim();
      if (!id) return refuse("missing_quote");

      // Picking a winner is `/select` on the shop the bid answered — the same
      // verb the customer-facing comparison uses, so a sale looks identical
      // whether the desk closed it or the customer did (F13).
      if (intent === "pick") {
        const requestId = String(form.get("requestId") ?? "").trim();
        if (!requestId) return refuse("missing_quote");
        await api(`/v1/dist/quote-requests/${encodeURIComponent(requestId)}/select`, {
          env,
          request,
          method: "POST",
          headers,
          body: { responseId: id }
        });
        return { problem: null, done: intent };
      }

      // Declining says why: `declineReason` is what the provider is told, and a
      // blank one turns a negotiation into an unexplained rejection.
      const reason = String(form.get("reason") ?? "").trim();
      if (!reason) return refuse("missing_reason");

      await api(`/v1/axis/quote-responses/${encodeURIComponent(id)}/decline`, {
        env,
        request,
        method: "POST",
        headers,
        body: { reason }
      });
      return { problem: null, done: intent };
    }

    if (intent === "issue") {
      const built = bindFrom(form);
      if ("code" in built) return refuse(built.code);

      // The sale: consequential and financial, so an over-threshold contract
      // comes back 403 `approval_required` (`axis.bind`) and the Gate says so.
      await api(`/v1/axis/quote-responses/${encodeURIComponent(built.quoteId)}/bind`, {
        env,
        request,
        method: "POST",
        headers,
        body: built.body
      });
      return { problem: null, done: "issue" };
    }
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }

  return refuse("bad_intent");
}

/** Codes this screen can phrase; anything else keeps the API's own wording. */
export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/* -------------------------------------------------------------- the screen */

export default function AxisQuoteDesk() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const held = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  // A panel member is an insurer with a name; `prv_01KE…` is how it is stored.
  const providerName = (id: string): string => loaded.resolved[id] ?? shortRef(id);
  const now = loaded.now;
  const group = loaded.kind === "group_medical";

  const groups = deskGroups(loaded.cases, loaded.quotes, now).sort(byPressure);
  // Every figure on the wall is counted through the same lens the card list is
  // filtered by, so clicking one cannot show a different number of rows than it
  // printed. The bid figures count bids-in-groups rather than `loaded.quotes`
  // for that reason: the cards are what a reader would count.
  const { focus, href } = useFocus({ ...GROUP_LENSES, ...BID_LENSES });
  const shown = deskFocus(groups, focus);
  const bids = groups.flatMap((entry) => entry.bids);
  const live = lensOf(bids, BID_LENSES, "quotes");
  const expiring = lensOf(bids, BID_LENSES, "expiring");
  const silent = lensOf(groups, GROUP_LENSES, "silent");
  const picked = loaded.quotes.filter((quote) => quote.winFlag);
  // `groups` is already sorted by pressure, so its head is the same case the
  // headline is talking about whenever there is one worth narrating.
  const headlineKey = deskHeadlineKey(groups, silent.length, expiring.length);
  const urgent = headlineKey === "headline.silent" || headlineKey === "headline.expiring" ? groups[0] : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        {/* Horizon: the desk answers rather than announces itself. The headline
            is arithmetic on the same groups the KPI wall below counts, not text
            an agent produced, so it carries no ✦ (CLAUDE.md §11). Falls back to
            the plain title once there is nothing on the desk to narrate. */}
        <h1 className="page-title">
          {headlineKey ? l(headlineKey) : l(group ? "title.group" : "title")}
        </h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l(group ? "intro.group" : "intro")}</p>
        {urgent ? (
          <Link
            to={`/axis/cases/${urgent.case.id}`}
            className="w-fit font-mono text-13 text-accent underline underline-offset-2"
          >
            {l("headline.open", { ref: urgent.case.ref })}
          </Link>
        ) : null}
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`done.${result.done}`)}
        </p>
      ) : null}

      {/* The case total is the whole desk, so it doubles as the way back out. */}
      <KPIWall>
        <HeroStat label={l("stat.cases")} value={groups.length} to={href(null)} active={focus === null} />
        <HeroStat
          label={l("stat.quotes")}
          value={live.length}
          to={href("quotes")}
          active={focus === "quotes"}
        />
        <HeroStat
          label={l("stat.expiring")}
          value={expiring.length}
          to={href("expiring")}
          active={focus === "expiring"}
        />
        <HeroStat
          label={l("stat.silent")}
          value={silent.length}
          to={href("silent")}
          active={focus === "silent"}
        />
      </KPIWall>

      {shown.length === 0 ? <EmptyState title={l("empty.title")} body={l("empty.body")} /> : null}

      {shown.map((entry) => (
        <Card
          key={entry.case.id}
          title={
            <Link
              to={`/axis/cases/${entry.case.id}`}
              className="font-mono text-13 text-accent underline underline-offset-2"
            >
              {entry.case.ref}
            </Link>
          }
          description={
            entry.bids.length === 0 ? (
              l("group.silent")
            ) : (
              <span className="flex flex-wrap gap-4 font-ui text-12 text-subtle">
                <span>
                  {l("group.best")}{" "}
                  {entry.bestMinor !== null ? (
                    <Money
                      amountMinor={entry.bestMinor}
                      currency={entry.bids[0]!.currency}
                      locale={locale}
                    />
                  ) : (
                    "—"
                  )}
                </span>
                {entry.spreadMinor !== null ? (
                  <span>
                    {l("group.spread")}{" "}
                    <Money
                      amountMinor={entry.spreadMinor}
                      currency={entry.bids[0]!.currency}
                      locale={locale}
                    />
                  </span>
                ) : null}
              </span>
            )
          }
        >
          {entry.bids.length ? (
            <ul className="flex flex-col divide-y divide-border">
              {entry.bids.map((bid) => (
                <li key={bid.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-ui text-12 text-text">{providerName(bid.providerId)}</span>
                  <span className="font-mono text-13 tabular-nums text-text">
                    <Money amountMinor={bid.premiumMinor} currency={bid.currency} locale={locale} />
                  </span>
                  {bid.validUntil !== null ? (
                    <DateTime value={bid.validUntil} locale={locale} precision="day" className="font-ui text-12 text-subtle" />
                  ) : null}
                  {flagsOf(bid).map((flag) => (
                    <Badge key={flag.key} tone={flag.tone} size="sm">
                      {l(flag.key)}
                    </Badge>
                  ))}

                  {/* Two verbs, two grants since F13: picking a winner is dist's
                      `/select`, ruling one out is the AXIS desk's own. A role
                      holding one and not the other sees only its own button. */}
                  {(held.has(PERM.pick) || held.has(PERM.quoteWrite)) && bid.expiry !== "expired" ? (
                    <span className="ms-auto flex flex-wrap items-end gap-2">
                      {bid.winFlag || !held.has(PERM.pick) ? null : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="pick" />
                          <input type="hidden" name="quoteId" value={bid.id} />
                          <input type="hidden" name="requestId" value={bid.requestId} />
                          <Button
                            type="submit"
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            // One "Pick" per bid: the provider is what tells them apart.
                            aria-label={`${l("pick.submit")}: ${providerName(bid.providerId)}`}
                          >
                            {l("pick.submit")}
                          </Button>
                        </Form>
                      )}
                      {held.has(PERM.quoteWrite) && !bid.declineReason ? (
                        <Form method="post" className="flex items-end gap-2">
                          <input type="hidden" name="intent" value="decline" />
                          <input type="hidden" name="quoteId" value={bid.id} />
                          <Field label={l("decline.reason")} labelHidden className="w-48">
                            <Input name="reason" size="sm" />
                          </Field>
                          {/* One-way from this desk: a declined bid is filtered
                              out of the list, so there is no button to undo it
                              with (CLAUDE.md §4). */}
                          <ConfirmButton
                            type="submit"
                            size="sm"
                            variant="ghost"
                            loading={busy}
                            aria-label={`${l("decline.submit")}: ${providerName(bid.providerId)}`}
                            message={l("decline.confirm", { provider: providerName(bid.providerId) })}
                          >
                            {l("decline.submit")}
                          </ConfirmButton>
                        </Form>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ))}

      {held.has(PERM.issue) ? (
        <Card title={l("issue.title")} description={l("issue.intro")}>
          {picked.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("issue.none")}</p>
          ) : (
            picked.map((quote) => {
              const kase = loaded.cases.find((row) => row.id === quote.caseId);
              return (
                <Form key={quote.id} method="post" className="flex flex-wrap items-end gap-4 py-2">
                  <input type="hidden" name="intent" value="issue" />
                  <input type="hidden" name="quoteId" value={quote.id} />
                  <input type="hidden" name="caseId" value={quote.caseId} />
                  <span className="flex flex-col gap-1">
                    <span className="font-ui text-13 font-medium text-muted">{l("issue.quote")}</span>
                    <span className="font-mono text-13 text-text">
                      {kase?.ref ?? shortRef(quote.caseId)} · {providerName(quote.providerId)} ·{" "}
                      <Money amountMinor={quote.premiumMinor} currency={quote.currency} locale={locale} />
                    </span>
                  </span>
                  <Field label={l("issue.policyNo")} className="w-40">
                    <Input name="policyNo" required />
                  </Field>
                  {/* Named at shop time and read off the quote by the server; the
                      desk shows who it is selling to and cannot change it. */}
                  <span className="flex flex-col gap-1">
                    <span className="font-ui text-13 font-medium text-muted">{l("issue.customer")}</span>
                    <span className="font-ui text-13 text-text">
                      {kase?.customerId ? (loaded.resolved[kase.customerId] ?? shortRef(kase.customerId)) : l("issue.noCustomer")}
                    </span>
                  </span>
                  <Field label={l("issue.start")} className="w-40">
                    <DatePicker name="startAt" required />
                  </Field>
                  <Field label={l("issue.end")} className="w-40">
                    <DatePicker name="endAt" required />
                  </Field>
                  <Button type="submit" variant="primary" loading={busy} disabled={!kase?.customerId}>
                    {l("issue.submit")}
                  </Button>
                </Form>
              );
            })
          )}
        </Card>
      ) : null}
    </div>
  );
}
