import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, DateTime, EmptyState, Field, Input, Panel, Provenance, Table } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import {
  labelsFrom,
  parsed,
  readable,
  refuse,
  refused,
  type ActionResult,
  type Labels,
  type Page
} from "./north-shared";

// Board Room (docs/modules/north.md §4 screen 5, §2.5): the pack list, what
// each pack is assembled from, the rendered PDF, and who it went to.
//
// Assembly is one POST — the API joins the latest exec briefing, the period's
// snapshots and the open decision log, renders a PDF and stores it
// (apps/api/src/routes/north.ts). It lands on `review`, never `final`: rule 4
// says distribution is the consequential step, and no approval or
// distribution route exists yet (ADR-0017). The screen says so rather than
// offering a button that would do nothing.

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:boardpacks:read",
  generate: "north:boardpacks:generate"
} as const;

const PAGE = 50;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Board packs",
    kicker: "The quarter, assembled once and sent to the people who decide",
    intro:
      "A pack is the latest executive briefing, the period's metric snapshots and the open decision log, rendered together. Assembly is one click; sending it is not.",
    "link.brief": "The Brief",
    // The hero narrates the open pack's real assembly state rather than
    // restating the title (CLAUDE.md rule 11) — arithmetic on the loaded row,
    // never a count (a count needs a plural rule per locale; see home.tsx).
    "headline.draft": "The {period} pack has not been assembled yet.",
    "headline.review": "The {period} pack is assembled and waiting on distribution.",
    "headline.final": "The {period} pack is finalised.",
    "headline.distributed": "The {period} pack has gone out to the board.",
    "assemble.title": "Assemble a pack",
    "assemble.period": "Period",
    "assemble.period.hint": "The period the snapshots are stored under — 2026-07 for a month, 2026-Q3 for a quarter.",
    "assemble.packTitle": "Title",
    "assemble.packTitle.hint": "What the board will see on the cover.",
    "assemble.submit": "Assemble",
    "assemble.note":
      "Assembly renders the PDF and leaves the pack in review. Nothing distributes it — that step needs an approval route this build does not have yet.",
    "list.caption": "Every board pack in this tenant, most recent period first",
    "list.period": "Period",
    "list.packTitle": "Title",
    "list.status": "Status",
    "list.made": "Assembled",
    "list.pdf": "PDF",
    "list.open": "Open",
    "pdf.none": "Not rendered",
    "status.review": "In review",
    "status.final": "Final",
    "status.distributed": "Distributed",
    "detail.sections": "What it is assembled from",
    "detail.approved": "Approved by",
    "detail.unset": "Not recorded",
    "detail.distribution": "Who it went to",
    "detail.distribution.none": "This pack has not been sent to anybody.",
    "detail.rows": "{n} rows",
    "detail.metrics": "{n} metrics",
    "detail.decisions": "{n} decisions",
    "none.title": "No board packs yet",
    "none.body": "Assemble one for the period you are about to present.",
    denied: "You do not have permission to read board packs. Ask a tenant administrator for NORTH board pack access.",
    saved: "Pack assembled. It is in review until somebody approves distribution.",
    approvalTitle: "Queued for approval",
    approvalBody: "Assembling this pack needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_period": "Name the period — a pack assembled from no period has nothing in it.",
    "problem.missing_title": "Give the pack a title. The board reads it before anything else."
  },
  ar: {
    title: "حزم مجلس الإدارة",
    kicker: "الربع، يُجمَّع مرة ويُرسَل إلى من يقرر",
    intro:
      "الحزمة هي آخر ملخص تنفيذي، ولقطات مؤشرات الفترة، وسجل القرارات المفتوحة، مُخرجة معاً. التجميع بنقرة واحدة، أما الإرسال فلا.",
    "link.brief": "الموجز",
    "headline.draft": "حزمة {period} لم تُجمَّع بعد.",
    "headline.review": "حزمة {period} مُجمَّعة وتنتظر التوزيع.",
    "headline.final": "حزمة {period} نهائية.",
    "headline.distributed": "حزمة {period} أُرسلت إلى المجلس.",
    "assemble.title": "جمِّع حزمة",
    "assemble.period": "الفترة",
    "assemble.period.hint": "الفترة المحفوظة بها اللقطات — 2026-07 للشهر، و2026-Q3 للربع.",
    "assemble.packTitle": "العنوان",
    "assemble.packTitle.hint": "ما سيراه المجلس على الغلاف.",
    "assemble.submit": "جمِّع",
    "assemble.note":
      "التجميع يُخرج ملف PDF ويترك الحزمة قيد المراجعة. لا شيء يوزّعها — تلك الخطوة تحتاج مسار موافقة غير موجود في هذه النسخة.",
    "list.caption": "كل حزم مجلس الإدارة في هذا المستأجر، الأحدث فترةً أولاً",
    "list.period": "الفترة",
    "list.packTitle": "العنوان",
    "list.status": "الحالة",
    "list.made": "وقت التجميع",
    "list.pdf": "ملف PDF",
    "list.open": "افتح",
    "pdf.none": "غير مُخرج",
    "status.review": "قيد المراجعة",
    "status.final": "نهائية",
    "status.distributed": "موزَّعة",
    "detail.sections": "مما تتكون",
    "detail.approved": "اعتمدها",
    "detail.unset": "غير مسجل",
    "detail.distribution": "إلى من أُرسلت",
    "detail.distribution.none": "لم تُرسل هذه الحزمة إلى أحد.",
    "detail.rows": "{n} صفوف",
    "detail.metrics": "{n} مؤشرات",
    "detail.decisions": "{n} قرارات",
    "none.title": "لا توجد حزم بعد",
    "none.body": "جمِّع واحدة للفترة التي ستعرضها.",
    denied: "لا تملك صلاحية قراءة حزم المجلس. اطلب من مدير المستأجر صلاحية حزم نورث.",
    saved: "جُمِّعت الحزمة. تبقى قيد المراجعة حتى يوافق أحد على التوزيع.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "تجميع هذه الحزمة يحتاج موافقة بموجب سياسة {policy}. هي في الانتظار ولم تُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_period": "حدد الفترة — الحزمة المجمَّعة من لا فترة لا تحوي شيئاً.",
    "problem.missing_title": "أعطِ الحزمة عنواناً. المجلس يقرؤه قبل كل شيء."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface Boardpack {
  id: string;
  period: string;
  title: string;
  // `*Json` columns: objects from the generic CRUD, text from a module route.
  // Read with parsed() (north-shared), never JSON.parse().
  sectionsJson: unknown;
  distributionLogJson: unknown;
  pdfFileId: string | null;
  status: string;
  approvedBy: string | null;
  createdAt: number;
}

interface Delivery {
  to?: string;
  medium?: string;
  ts?: number;
  openedAt?: number;
}

/* ----------------------------------------------------------------- helpers */

/**
 * One line per section, from either shape `sections_json` holds: a template
 * section naming the metrics or decisions it pulls (`{key, metricKeys}`, what
 * the seed writes), or a rendered table the assembler already resolved
 * (`{title, rows}`, what POST /v1/north/boardpacks writes). A pack assembled
 * before and after that route existed must both read.
 */
export function sectionLine(section: unknown): { label: string; detail: string } | null {
  if (!section || typeof section !== "object") return null;
  const s = section as Record<string, unknown>;
  if (typeof s.title === "string") {
    return { label: s.title, detail: `rows:${Array.isArray(s.rows) ? s.rows.length : 0}` };
  }
  if (typeof s.key !== "string") return null;
  const metrics = Array.isArray(s.metricKeys) ? s.metricKeys.length : 0;
  const decisions = Array.isArray(s.decisionRefs) ? s.decisionRefs.length : 0;
  return {
    label: s.key.replace(/_/g, " "),
    detail: decisions > 0 ? `decisions:${decisions}` : `metrics:${metrics}`
  };
}

const TONE: Record<string, "neutral" | "warning" | "success"> = {
  draft: "neutral",
  review: "warning",
  final: "success",
  distributed: "success"
};

/**
 * What the hero says about the pack currently open: its real assembly state,
 * not the title restated. Arithmetic on the loaded row's own `status` column —
 * no ✦, this is not an agent's sentence (unlike The Brief's narrator text).
 */
export function headline(
  open: Pick<Boardpack, "period" | "status"> | null,
  l: (key: string, vars?: Record<string, string>) => string
): string {
  if (!open) return l("title");
  return l(`headline.${open.status}`, { period: open.period });
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);

  const page = await readable(
    api<Page<Boardpack>>(`/v1/north/boardpacks?sort=period&order=desc&limit=${PAGE}`, { env, request })
  );
  const packs = page?.data ?? null;
  const asked = url.searchParams.get("id");
  const open = packs?.find((row) => row.id === asked) ?? packs?.[0] ?? null;

  return { packs, open, idempotencyKey: crypto.randomUUID() };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();

  const period = String(form.get("period") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  if (!period) return refuse("missing_period");
  if (!title) return refuse("missing_title");

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    await api("/v1/north/boardpacks", {
      env,
      request,
      method: "POST",
      ...(key ? { headers: { "idempotency-key": key } } : {}),
      body: { period, title }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: "boardpack" };
}

/* -------------------------------------------------------------- the screen */

export default function NorthBoard() {
  const { packs, open, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);

  const shown =
    result?.problem && result.problem.code !== "approval_required"
      ? {
          title: l(`problem.${result.problem.code ?? ""}`),
          status: result.problem.status,
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : (result?.problem ?? null);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="eyebrow">{l("kicker")}</span>
        {/* The headline narrates the open pack's own assembly state rather
            than repeating the eyebrow's "Board packs" label — see headline()
            above. Lede's classes rather than <Lede>: the page needs a real h1
            in the outline, and the component is a <p>. */}
        <h1 className="page-title">{headline(open, l)}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        {/* routing.ts documents /north/brief as reached from the workspace
            tools list; The Brief itself links back to /north/board, so this
            closes the loop the same way north-brief.tsx already does. */}
        <Link
          to="/north/brief"
          className="w-fit font-ui text-12 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {l("link.brief")}
        </Link>
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("saved")}
        </p>
      ) : null}

      {held.has(PERM.generate) ? (
        <Panel module="north" eyebrow={l("assemble.title")} lede={l("assemble.note")}>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Field label={l("assemble.period")} hint={l("assemble.period.hint")}>
              <Input name="period" required aria-label={l("assemble.period")} />
            </Field>
            <Field label={l("assemble.packTitle")} hint={l("assemble.packTitle.hint")}>
              <Input name="title" required aria-label={l("assemble.packTitle")} />
            </Field>
            <div>
              <Button type="submit" disabled={busy}>
                {l("assemble.submit")}
              </Button>
            </div>
          </Form>
        </Panel>
      ) : null}

      {packs === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : packs.length === 0 ? (
        <EmptyState title={l("none.title")} body={l("none.body")} />
      ) : (
        <>
          {open ? <PackDetail pack={open} locale={locale} l={l} /> : null}

          <Panel eyebrow={l("title")}>
            <Table
              caption={l("list.caption")}
              rows={packs}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: "title",
                  header: l("list.packTitle"),
                  render: (row) => (
                    <a className="text-text underline decoration-border underline-offset-4" href={`?id=${row.id}`}>
                      {row.title}
                    </a>
                  )
                },
                { key: "period", header: l("list.period"), render: (row) => row.period },
                {
                  key: "status",
                  header: l("list.status"),
                  render: (row) => (
                    <Badge tone={TONE[row.status] ?? "neutral"}>{l(`status.${row.status}`) || row.status}</Badge>
                  )
                },
                {
                  key: "made",
                  header: l("list.made"),
                  render: (row) => <DateTime value={row.createdAt} locale={locale} />
                },
                {
                  key: "pdf",
                  header: l("list.pdf"),
                  // Streamed through the web app rather than linked at R2: the
                  // object is private and the download is audited.
                  render: (row) =>
                    row.pdfFileId ? (
                      <a
                        className="text-text underline decoration-border underline-offset-4"
                        href={`/north/board/${row.id}/file`}
                      >
                        {l("list.open")}
                      </a>
                    ) : (
                      <span className="text-subtle">{l("pdf.none")}</span>
                    )
                }
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}

function PackDetail({
  pack,
  locale,
  l
}: {
  pack: Boardpack;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const sections = parsed<unknown[]>(pack.sectionsJson, []);
  const log = parsed<Delivery[]>(pack.distributionLogJson, []);
  const lines = sections.map(sectionLine).filter((line): line is { label: string; detail: string } => line !== null);

  return (
    <Panel module="north" eyebrow={pack.period} lede={pack.title}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">{l("detail.sections")}</h2>
          <Provenance
            rows={[
              ...lines.map((line) => {
                const [kind, n] = line.detail.split(":");
                return {
                  label: line.label,
                  value: l(`detail.${kind}`, { n: n ?? "0" }),
                  mono: true
                };
              }),
              { label: l("detail.approved"), value: pack.approvedBy ?? l("detail.unset") }
            ]}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">{l("detail.distribution")}</h2>
          {log.length === 0 ? (
            <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("detail.distribution.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {log.map((entry, index) => (
                <li key={index} className="flex items-baseline justify-between gap-4 font-ui text-13">
                  <span className="text-text">{entry.to ?? "—"}</span>
                  <span className="text-subtle">
                    {entry.medium ? `${entry.medium} · ` : ""}
                    {typeof entry.ts === "number" ? <DateTime value={entry.ts} locale={locale} /> : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Panel>
  );
}
