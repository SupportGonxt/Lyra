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
  GuardrailNotice,
  KPIWall,
  Stat,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  aeoCoverage,
  aeoHeadline,
  citationsOf,
  explain,
  isStale,
  labelsIn,
  mintKey,
  safe,
  type AeoRow,
  type Label,
  type Page,
  type Problemish
} from "./signal.shared";

// Answer-engine coverage: which question clusters this tenant answers, whether
// the engines are quoting those answers back, and which published pages have
// gone unverified long enough to be answering from stale facts.
//
// The `aeo-pages` tab lists and edits the pages. This screen is the read across
// them — coverage and citation share are a shape, not a row — plus the one write
// the shape implies: moving a page's status when the reading says it should
// change (publish it, flag it for re-checking, retire it).

/** packages/db/src/schema/signal.ts aeoPages.status. */
export const STATUSES = ["draft", "published", "stale", "retired"] as const;

/** A published page unverified for longer than this is answering from old facts. */
const FRESH_DAYS = 30;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const pages = await safe(
    () => api<Page<AeoRow>>("/v1/signal/aeo-pages?sort=updatedAt&order=desc&limit=200", { env, request }),
    { data: [] as AeoRow[] }
  );
  const now = Date.now();
  return {
    now,
    pages: pages.data,
    roll: aeoCoverage(pages.data),
    staleCount: pages.data.filter((page) => page.status === "published" && isStale(page, now, FRESH_DAYS)).length,
    key: mintKey("signal-aeo")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: string | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const refuse = (code: string): ActionResult => ({ problem: { title: code, status: 400, code }, done: null });

  if (String(form.get("intent") ?? "") !== "set-status") return refuse("bad_intent");
  const id = String(form.get("pageId") ?? "").trim();
  if (!id) return refuse("page_required");
  const status = String(form.get("status") ?? "").trim();
  if (!STATUSES.some((allowed) => allowed === status)) return refuse("status_required");

  try {
    await api(`/v1/signal/aeo-pages/${id}`, {
      env,
      request,
      method: "PATCH",
      headers: { "idempotency-key": String(form.get("key") ?? "") || mintKey("signal-aeo") },
      // Publishing sets the verification clock: a page published today is fresh
      // by definition, and leaving `freshness` untouched would show it as stale.
      body: status === "published" ? { status, freshness: Date.now() } : { status }
    });
    return { problem: null, done: status };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function AnswerEngines() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const locale = shell?.locale ?? "en";
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const roll = loaded.roll;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">
          {aeoHeadline(l, { staleCount: loaded.staleCount, published: roll.published, citationSharePct: roll.citationSharePct })}
        </h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("aeo.lede")}</p>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done ? <p className="font-ui text-13 text-success">{l("saved")}</p> : null}

      <KPIWall>
        <Stat label={l("aeo.coverage")} value={String(roll.clusters)} />
        <Stat label={l("aeo.publishedPages")} value={String(roll.published)} />
        <Stat label={l("aeo.citedPages")} value={String(roll.cited)} />
        <Stat label={l("aeo.share")} value={`${roll.citationSharePct}%`} />
        <Stat label={l("aeo.stalePages")} value={String(loaded.staleCount)} />
      </KPIWall>

      {loaded.staleCount > 0 ? (
        <GuardrailNotice
          title={l("aeo.stalePages")}
          reason={l("aeo.staleWarning", { n: String(loaded.staleCount) })}
          tone="warning"
        />
      ) : null}

      <Card title={l("aeo.title")} description={l("aeo.caption")}>
        {loaded.pages.length === 0 ? (
          <EmptyState
            title={l("aeo.noPages")}
            body={l("aeo.noPages.body")}
            className="mt-4"
            action={
              <Link to="/signal/aeo-pages" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
                {l("aeo.openPages")}
              </Link>
            }
          />
        ) : (
          <Table
            className="mt-4"
            caption={l("aeo.caption")}
            captionHidden
            rowKey={(page) => page.id}
            rows={loaded.pages}
            columns={[
              ...pageColumns(l, locale, loaded.now),
              {
                key: "act",
                header: l("state"),
                headerLabel: l("aeo.markStale"),
                render: (page: AeoRow) =>
                  may.has(PERM.aeoWrite) ? (
                    <StatusControls page={page} l={l} formKey={loaded.key} busy={busy} />
                  ) : (
                    <span className="font-ui text-12 text-subtle">{l("noPermission")}</span>
                  )
              }
            ]}
          />
        )}
      </Card>

      <footer className="flex flex-wrap gap-4">
        <Link to="/signal/aeo-pages" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("aeo.openPages")}
        </Link>
        <Link to="/signal/analytics" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("growth.title")}
        </Link>
      </footer>
    </div>
  );
}

function pageColumns(l: Label, locale: string, now: number): Array<Column<AeoRow>> {
  return [
    { key: "cluster", header: l("aeo.cluster"), render: (page) => page.queryCluster },
    { key: "locale", header: l("growth.format"), render: (page) => l(`locale.${page.locale}`) },
    {
      key: "status",
      header: l("state"),
      render: (page) => (
        <Badge tone={page.status === "published" ? "success" : page.status === "retired" ? "neutral" : "warning"} dot>
          {l(page.status)}
        </Badge>
      )
    },
    {
      key: "citedBy",
      header: l("aeo.citedBy"),
      render: (page) => {
        const engines = citationsOf(page);
        return engines.length === 0 ? <span className="text-subtle">{l("none")}</span> : engines.join(", ");
      }
    },
    {
      key: "freshness",
      header: l("aeo.freshness"),
      render: (page) =>
        page.freshness === null ? (
          <span className="text-subtle">{l("aeo.never")}</span>
        ) : (
          <span className={isStale(page, now, FRESH_DAYS) ? "text-warning" : undefined}>
            <DateTime value={page.freshness} locale={locale} precision="day" />
          </span>
        )
    }
  ];
}

/** The status moves that make sense from where the page is now. */
function StatusControls({
  page,
  l,
  formKey,
  busy
}: {
  page: AeoRow;
  l: Label;
  formKey: string;
  busy: boolean;
}) {
  const next: Array<{ status: string; label: string }> = [];
  if (page.status !== "published") next.push({ status: "published", label: l("aeo.publish") });
  if (page.status === "published") next.push({ status: "stale", label: l("aeo.markStale") });
  if (page.status !== "retired") next.push({ status: "retired", label: l("aeo.retire") });

  return (
    <div className="flex flex-wrap gap-2">
      {next.map((move) => (
        <Form method="post" key={move.status}>
          <input type="hidden" name="intent" value="set-status" />
          <input type="hidden" name="key" value={formKey} />
          <input type="hidden" name="pageId" value={page.id} />
          <input type="hidden" name="status" value={move.status} />
          <Button type="submit" size="sm" variant="secondary" disabled={busy}>
            {move.label}
          </Button>
        </Form>
      ))}
    </div>
  );
}
