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
  KPIWall,
  Money,
  ProgressBar,
  Select,
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
  WINDOWS,
  cacMinor,
  cohorts,
  explain,
  growthHeadline,
  labelsIn,
  ltvMinor,
  ltvToCac,
  channelLabel,
  multipleText,
  rollByChannel,
  safe,
  totalSpendMinor,
  windowDays,
  type ChannelRoll,
  type Cohort,
  type Label,
  type Page,
  type Problemish,
  type SpendRow,
  type TouchRow
} from "./signal.shared";

// The growth numbers: what a customer costs, what one is worth, which channel
// actually produced them, and whether last quarter's customers came back.
//
// None of these four figures has an endpoint — the autopilot computes cost per
// acquisition privately and exposes nothing — so they are derived here from the
// spend ledger and the attribution touches. The derivations live in
// signal.shared.ts so the cockpit's version of CAC is this one.
//
// The file at the bottom is the platform's own export pipeline
// (POST /v1/analytics/exports over the registered `spend` dataset), not a second
// spreadsheet writer: the API already renders xlsx and PDF and masks PII on the
// way out.

/** apps/api/src/routes/analytics.ts ExportBody.format. */
const FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/** apps/api/src/engines/report.ts DATASETS.spend — the only signal dataset with
 *  money in it, since a campaign's budget lives in JSON and JSON is not
 *  reportable. */
const DATASET = "spend";

interface ExportRow {
  id: string;
  format: string;
  /** queued|rendering|ready|failed|expired — rendering happens inside the POST,
   *  so what comes back is already final. */
  state: string;
  rowCount: number | null;
  expiresAt: number | null;
  error: string | null;
}

const empty = <T,>(): Page<T> => ({ data: [] });

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const days = windowDays(new URL(request.url).searchParams.get("days"));
  const from = Date.now() - days * 86_400_000;

  const [spend, touches] = await Promise.all([
    safe(
      () => api<Page<SpendRow>>(`/v1/signal/spend?sort=ts&from=${from}&limit=200`, { env, request }),
      empty<SpendRow>()
    ),
    safe(
      () =>
        api<Page<TouchRow>>(`/v1/signal/attribution-events?sort=ts&from=${from}&limit=200`, { env, request }),
      empty<TouchRow>()
    )
  ]);

  const rolls = rollByChannel(spend.data, touches.data);
  const binds = touches.data.filter((touch) => touch.touchType === "bind");
  const spentMinor = totalSpendMinor(spend.data);
  const cac = cacMinor(spentMinor, binds.length);
  const ltv = ltvMinor(touches.data);
  const clicks = rolls.reduce((sum, roll) => sum + roll.clicks, 0);

  return {
    days,
    from,
    apiOrigin: env.API_ORIGIN,
    currency: spend.data[0]?.currency ?? "ZAR",
    spentMinor,
    cacMinor: cac,
    ltvMinor: ltv,
    ratio: ltvToCac(ltv, cac),
    perClickMinor: clicks > 0 ? Math.round(spentMinor / clicks) : null,
    rolls,
    // ponytail: cohorts read the same window as everything else, so a 7-day view
    // has one cohort. The wider windows are what this table is for.
    cohorts: cohorts(touches.data)
  };
}

export interface ActionResult {
  problem: Problemish | null;
  exported: ExportRow | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const format = String(form.get("format") ?? "");
  if (String(form.get("intent") ?? "") !== "export")
    return { problem: { title: "bad_intent", status: 400, code: "bad_intent" }, exported: null };
  if (!FORMATS.some((allowed) => allowed === format))
    return { problem: { title: "format_required", status: 400, code: "format_required" }, exported: null };

  const days = windowDays(String(form.get("days") ?? ""));
  const now = Date.now();
  try {
    const exported = await api<ExportRow>("/v1/analytics/exports", {
      env,
      request,
      method: "POST",
      body: {
        format,
        // The window belongs inside the definition: the top-level from/to are
        // only merged for saved reports (analytics.ts §exports).
        definition: {
          dataset: DATASET,
          metrics: ["spend", "impressions", "clicks", "conversions"],
          dimensions: ["channel", "campaignId"],
          grain: "day",
          // One clock reading for both ends: two calls straddling a millisecond
          // boundary export a window a millisecond wider than the one asked for.
          from: now - days * 86_400_000,
          to: now
        },
        totals: true
      }
    });
    return { problem: null, exported };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, exported: null };
    throw error;
  }
}

export default function GrowthAnalytics() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const locale = shell?.locale ?? "en";
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const currency = loaded.currency;
  const exported = result?.exported ?? null;
  const money = (amountMinor: number) => <Money amountMinor={amountMinor} currency={currency} locale={locale} />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{growthHeadline(l, locale, loaded.ratio)}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("growth.lede")}</p>
        </div>
        <nav aria-label={l("growth.window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link
              key={days}
              to={`/signal/analytics?days=${days}`}
              aria-current={loaded.days === days ? "page" : undefined}
            >
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>{l("days", { n: String(days) })}</Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}

      <KPIWall>
        <Stat label={l("spend")} value={money(loaded.spentMinor)} hint={l("days", { n: String(loaded.days) })} />
        <Stat
          label={l("growth.blended")}
          value={loaded.cacMinor === null ? l("none") : money(loaded.cacMinor)}
        />
        <Stat
          label={l("growth.blendedLtv")}
          value={loaded.ltvMinor === null ? l("none") : money(loaded.ltvMinor)}
        />
        <Stat
          label={l("growth.ratio")}
          value={loaded.ratio === null ? l("none") : multipleText(locale, loaded.ratio)}
          hint={l("growth.ratioHint")}
        />
        <Stat
          label={l("growth.efficiency")}
          value={loaded.perClickMinor === null ? l("none") : money(loaded.perClickMinor)}
        />
      </KPIWall>

      <Card title={l("growth.attribution")} description={l("growth.attributionCaption")}>
        {loaded.rolls.length === 0 ? (
          <EmptyState title={l("growth.noSpend")} body={l("growth.noSpend.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("growth.attributionCaption")}
            captionHidden
            rowKey={(roll) => roll.channel}
            rows={loaded.rolls}
            columns={attributionColumns(l, locale, currency)}
          />
        )}
      </Card>

      <Card title={l("growth.cohorts")} description={l("growth.cohortsCaption")}>
        {loaded.cohorts.length === 0 ? (
          <EmptyState title={l("growth.noCohorts")} body={l("growth.noCohorts.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("growth.cohortsCaption")}
            captionHidden
            rowKey={(cohort) => cohort.month}
            rows={loaded.cohorts}
            columns={cohortColumns(l)}
          />
        )}
      </Card>

      {may.has(PERM.exportCreate) ? (
        <Card title={l("growth.export")} description={l("growth.exportHint")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="export" />
            <input type="hidden" name="days" value={String(loaded.days)} />
            <Field label={l("growth.format")} required>
              <Select
                name="format"
                defaultValue="xlsx"
                options={FORMATS.map((format) => ({ value: format, label: l(format) }))}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("growth.export")}
            </Button>
          </Form>

          {exported ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="font-ui text-13 text-text">
                {exported.state === "ready" ? l("growth.exportReady") : l("growth.exportQueued")}
              </span>
              <Badge tone={exported.state === "ready" ? "success" : "neutral"} size="sm" dot>
                {l(exported.format)}
              </Badge>
              {exported.error ? (
                <span role="alert" className="font-ui text-12 text-danger">
                  {exported.error}
                </span>
              ) : null}
              {exported.state === "ready" ? (
                // The API streams the file with its own content-disposition.
                // ponytail: straight to the API origin, as analytics-report.tsx
                // does — a web-origin proxy is that route's problem to solve too.
                <Button asChild variant="secondary" size="sm">
                  <a href={`${loaded.apiOrigin}/v1/analytics/exports/${exported.id}/download`} rel="noopener">
                    {l("growth.download")}
                  </a>
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <footer className="flex flex-wrap gap-4">
        <Link to="/signal/cockpit" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("cockpit.title")}
        </Link>
        <Link to="/signal/budget" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("cockpit.openBudget")}
        </Link>
      </footer>
    </div>
  );
}

/** Spend against outcome per channel — the table the budget decisions read. */
export function attributionColumns(l: Label, locale: string, currency: string): Array<Column<ChannelRoll>> {
  const money = (amountMinor: number) => <Money amountMinor={amountMinor} currency={currency} locale={locale} />;
  return [
    { key: "channel", header: l("channel"), render: (roll) => channelLabel(roll.channel, locale) },
    { key: "spend", header: l("spend"), numeric: true, render: (roll) => money(roll.spendMinor) },
    { key: "clicks", header: l("clicks"), numeric: true, render: (roll) => roll.clicks.toLocaleString(locale) },
    { key: "binds", header: l("binds"), numeric: true, render: (roll) => roll.binds.toLocaleString(locale) },
    {
      key: "cac",
      header: l("cac"),
      numeric: true,
      render: (roll) => {
        const cac = cacMinor(roll.spendMinor, roll.binds);
        return cac === null ? l("none") : money(cac);
      }
    },
    { key: "value", header: l("value"), numeric: true, render: (roll) => money(roll.valueMinor) },
    {
      key: "multiple",
      header: l("multiple"),
      numeric: true,
      render: (roll) => {
        // Per-channel value to cost: the mean value of this channel's binds over
        // what this channel cost to buy one.
        const cac = cacMinor(roll.spendMinor, roll.binds);
        const ltv = roll.binds > 0 ? Math.round(roll.valueMinor / roll.binds) : null;
        const ratio = ltvToCac(ltv, cac);
        return ratio === null ? (
          l("none")
        ) : (
          <span className={ratio < 1 ? "text-danger" : undefined}>{multipleText(locale, ratio)}</span>
        );
      }
    }
  ];
}

function cohortColumns(l: Label): Array<Column<Cohort>> {
  return [
    { key: "month", header: l("growth.cohort"), render: (cohort) => cohort.month },
    { key: "size", header: l("growth.size"), numeric: true, render: (cohort) => String(cohort.size) },
    { key: "retained", header: l("growth.retained"), numeric: true, render: (cohort) => String(cohort.retained) },
    {
      key: "rate",
      header: l("growth.retention"),
      render: (cohort) => {
        const pct = cohort.size === 0 ? 0 : Math.round((cohort.retained / cohort.size) * 100);
        // ProgressBar's label is its accessible name, so the figure is rendered
        // beside it rather than being swallowed by the aria attribute.
        return (
          <div className="flex items-center gap-2">
            <span className="font-ui text-12 tabular-nums text-text">{pct}%</span>
            <ProgressBar
              value={pct}
              label={l("growth.retention")}
              tone={pct < 30 ? "warning" : "accent"}
              className="w-24"
            />
          </div>
        );
      }
    }
  ];
}
