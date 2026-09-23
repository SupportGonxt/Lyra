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
  Field,
  Input,
  KPIWall,
  ProgressBar,
  Select,
  Stat,
  Table,
  Textarea,
  type Column
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useSignalSessionData } from "./signal-shell";
import {
  DECISION_BOUNDARY_BPS,
  PERM,
  crossedBoundary,
  expHeadline,
  explain,
  labelsIn,
  metricLabel,
  mintKey,
  nextExperimentStates,
  resultOf,
  safe,
  samplePct,
  samplesSeen,
  variantsOf,
  verdictTone,
  type CampaignRow,
  type ExperimentResult,
  type ExperimentRow,
  type Label,
  type Page,
  type Problemish,
  type Variant
} from "./signal.shared";

// The experiment log (docs/modules/signal.md §4 screen 4): the registry of every
// test, and one test opened with its arms, its reading and the decision it drove.
//
// Nothing but this screen and the seed writes `signal_experiments` — no engine
// concludes a test — so the decide form records the verdict, the winner and the
// note alongside the state. A stop that only moves the state leaves a row whose
// reading is null forever, which is how experiment logs turn into folklore.

/** The metrics the seed and the module doc name; a tenant's own slugs are added
 *  from whatever the ledger already holds, so this list is a floor not a fence. */
const METRICS = ["quote_start_rate", "click_to_bind_rate", "renewal_accept_rate", "aeo_citation_share"] as const;

/** What a stop may be called. `abandoned` is the shape with a reason, not a rate. */
const VERDICTS = ["won", "lost", "inconclusive", "abandoned"] as const;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const [experiments, campaigns] = await Promise.all([
    safe(
      () =>
        api<Page<ExperimentRow>>("/v1/signal/signal-experiments?sort=createdAt&order=desc&limit=200", {
          env,
          request
        }),
      { data: [] as ExperimentRow[] }
    ),
    safe(() => api<Page<CampaignRow>>("/v1/signal/campaigns?limit=200", { env, request }), {
      data: [] as CampaignRow[]
    })
  ]);
  const rows = experiments.data;
  const asked = new URL(request.url).searchParams.get("id");
  return {
    rows,
    campaigns: campaigns.data.map((campaign) => ({ id: campaign.id, name: campaign.name })),
    // Metrics anyone here has actually measured, ahead of the four we ship with.
    metrics: [...new Set([...rows.map((row) => row.metric), ...METRICS])],
    selected: rows.find((row) => row.id === asked) ?? rows.find((row) => row.state === "running") ?? rows[0] ?? null,
    key: mintKey("signal-exp")
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
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const key = text("key") || mintKey("signal-exp");
  const intent = text("intent");

  if (intent === "create") {
    const hypothesis = text("hypothesis");
    if (hypothesis.length < 10) return refuse("hypothesis_required");
    const metric = text("metric");
    if (!metric) return refuse("metric_required");
    const control = text("control");
    const challenger = text("challenger");
    if (!control || !challenger) return refuse("arms_required");
    const minSample = Number(text("minSample"));
    const campaignId = text("campaignId");

    try {
      await api("/v1/signal/signal-experiments", {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": key },
        body: {
          hypothesis,
          metric,
          campaignId: campaignId || null,
          minSample: Number.isFinite(minSample) && minSample > 0 ? Math.round(minSample) : null,
          // Even split: an uneven one is a decision nobody asked for on a screen
          // that starts tests, and the arms carry their own share if it changes.
          variantsJson: [
            { key: "control", label: control, splitBps: 5_000 },
            { key: "challenger", label: challenger, splitBps: 5_000 }
          ] satisfies Variant[]
        }
      });
      return { problem: null, done: "created" };
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }
  }

  if (intent !== "decide") return refuse("bad_intent");

  const id = text("experimentId");
  if (!id) return refuse("experiment_required");
  const state = text("state");
  if (!nextExperimentStates(text("from")).includes(state)) return refuse("state_required");
  const verdict = text("verdict");
  const note = text("note");
  const stopping = state === "concluded" || state === "abandoned";
  if (stopping && !VERDICTS.some((allowed) => allowed === verdict)) return refuse("verdict_required");

  // Whatever reading the row already carries is kept: a decision annotates the
  // measurement, it does not replace it.
  let existing: ExperimentResult = {};
  try {
    const raw: unknown = JSON.parse(String(form.get("result") ?? "{}"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) existing = raw as ExperimentResult;
  } catch {
    existing = {};
  }

  const winner = text("winner");
  // An abandonment files its sentence as the reason it was dropped; every other
  // stop files it as the note. Empty stays absent rather than becoming "".
  const said = verdict === "abandoned" ? note || existing.reason : note || existing.note;
  const result: ExperimentResult = stopping
    ? {
        ...existing,
        verdict,
        winner: verdict === "won" ? winner || null : null,
        ...(said ? (verdict === "abandoned" ? { reason: said } : { note: said }) : {})
      }
    : existing;

  try {
    await api(`/v1/signal/signal-experiments/${id}`, {
      env,
      request,
      method: "PATCH",
      headers: { "idempotency-key": key },
      body: stopping
        ? { state, concludedAt: Date.now(), resultJson: result }
        : { state, concludedAt: null, resultJson: null }
    });
    return { problem: null, done: state };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function Experiments() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const names = new Map(loaded.campaigns.map((campaign) => [campaign.id, campaign.name]));
  const decided = loaded.rows.filter((row) => row.state === "concluded");
  const won = decided.filter((row) => resultOf(row)?.verdict === "won");
  const running = loaded.rows.filter((row) => row.state === "running").length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-22 leading-[1.2] text-text">{expHeadline(l, { won: won.length, running })}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("exp.lede")}</p>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p className="font-ui text-13 text-success">{result.done === "created" ? l("exp.created") : l("exp.decideSaved")}</p>
      ) : null}

      <KPIWall>
        <Stat label={l("exp.runningNow")} value={String(running)} />
        <Stat label={l("exp.decidedCount")} value={String(decided.length)} />
        <Stat label={l("exp.wonCount")} value={String(won.length)} />
      </KPIWall>

      <Card title={l("exp.title")} description={l("exp.caption")}>
        {loaded.rows.length === 0 ? (
          <EmptyState title={l("exp.none")} body={l("exp.none.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("exp.caption")}
            captionHidden
            rowKey={(row) => row.id}
            rows={loaded.rows}
            columns={registryColumns(l, locale, names)}
          />
        )}
      </Card>

      {loaded.selected ? (
        <Detail
          row={loaded.selected}
          l={l}
          locale={locale}
          campaignName={loaded.selected.campaignId ? names.get(loaded.selected.campaignId) : undefined}
          formKey={loaded.key}
          busy={busy}
          mayDecide={may.has(PERM.experimentsDecide)}
        />
      ) : null}

      {may.has(PERM.experimentsCreate) ? (
        <Card title={l("exp.new")} description={l("exp.newHint")}>
          <Form method="post" className="mt-4 flex flex-col gap-4">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="key" value={loaded.key} />
            <Field label={l("exp.hypothesisField")} required>
              <Textarea name="hypothesis" rows={2} required minLength={10} maxLength={400} />
            </Field>
            <div className="flex flex-wrap items-end gap-4">
              <Field label={l("exp.metricField")} required>
                <Select
                  name="metric"
                  defaultValue={loaded.metrics[0] ?? METRICS[0]}
                  options={loaded.metrics.map((metric) => ({ value: metric, label: metricLabel(metric, l) }))}
                />
              </Field>
              <Field label={l("exp.minSampleField")}>
                <Input name="minSample" type="number" min={1} step={1} defaultValue={1000} />
              </Field>
              <Field label={l("exp.campaignField")}>
                <Select
                  name="campaignId"
                  defaultValue=""
                  options={[
                    { value: "", label: l("exp.unattached") },
                    ...loaded.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))
                  ]}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <Field label={l("exp.controlField")} required>
                <Input name="control" required maxLength={120} />
              </Field>
              <Field label={l("exp.challengerField")} required>
                <Input name="challenger" required maxLength={120} />
              </Field>
              <Button type="submit" disabled={busy}>
                {l("exp.create")}
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}

      <footer className="flex flex-wrap gap-4">
        <Link to="/signal/cockpit" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("cockpit.title")}
        </Link>
        <Link to="/signal/studio" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("studio.title")}
        </Link>
      </footer>
    </div>
  );
}

function registryColumns(l: Label, locale: string, names: Map<string, string>): Array<Column<ExperimentRow>> {
  return [
    {
      key: "hypothesis",
      header: l("exp.hypothesis"),
      render: (row) => <span className="line-clamp-2 max-w-prose">{row.hypothesis}</span>
    },
    {
      key: "campaign",
      header: l("campaign"),
      render: (row) =>
        row.campaignId && names.has(row.campaignId) ? (
          names.get(row.campaignId)
        ) : (
          <span className="text-subtle">{l("exp.unattached")}</span>
        )
    },
    { key: "metric", header: l("exp.metric"), render: (row) => metricLabel(row.metric, l) },
    {
      key: "state",
      header: l("exp.state"),
      render: (row) => (
        <Badge tone={row.state === "running" ? "accent" : row.state === "draft" ? "neutral" : "info"} dot>
          {l(`exp.state.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "sample",
      header: l("exp.sample"),
      render: (row) => {
        const pct = samplePct(row);
        if (pct === null) return <span className="text-subtle">{l("exp.noTarget")}</span>;
        return (
          <div className="flex items-center gap-2">
            <span className="font-ui text-12 tabular-nums text-text">{pct}%</span>
            <ProgressBar
              value={pct}
              label={l("exp.progress", { n: String(row.minSample ?? 0) })}
              tone={pct >= 100 ? "success" : "accent"}
              className="w-24"
            />
          </div>
        );
      }
    },
    {
      key: "verdict",
      header: l("exp.verdict"),
      render: (row) => {
        const verdict = resultOf(row)?.verdict;
        return verdict ? (
          <Badge tone={verdictTone(row)} dot>
            {l(`exp.verdict.${verdict}`)}
          </Badge>
        ) : (
          <span className="text-subtle">{l("exp.pending")}</span>
        );
      }
    },
    {
      key: "concluded",
      header: l("exp.concluded"),
      render: (row) =>
        row.concludedAt === null ? (
          <span className="text-subtle">{l("exp.pending")}</span>
        ) : (
          <DateTime value={row.concludedAt} locale={locale} precision="day" />
        )
    },
    {
      key: "open",
      header: l("exp.open"),
      render: (row) => (
        <Link
          to={`/signal/experiments?id=${row.id}`}
          className="font-ui text-13 text-accent underline-offset-2 hover:underline"
        >
          {l("exp.open")}
        </Link>
      )
    }
  ];
}

/** One test: its arms, the reading at the stop, and the decision form. */
function Detail({
  row,
  l,
  locale,
  campaignName,
  formKey,
  busy,
  mayDecide
}: {
  row: ExperimentRow;
  l: Label;
  locale: string;
  campaignName: string | undefined;
  formKey: string;
  busy: boolean;
  mayDecide: boolean;
}) {
  const variants = variantsOf(row);
  const reading = resultOf(row);
  const moves = nextExperimentStates(row.state);

  return (
    <Card title={l("exp.detail")} description={row.hypothesis}>
      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 font-ui text-13">
        <div>
          <dt className="text-muted">{l("exp.metric")}</dt>
          <dd className="text-text">{metricLabel(row.metric, l)}</dd>
        </div>
        <div>
          <dt className="text-muted">{l("campaign")}</dt>
          <dd className="text-text">{campaignName ?? l("exp.unattached")}</dd>
        </div>
        <div>
          <dt className="text-muted">{l("exp.state")}</dt>
          <dd className="text-text">{l(`exp.state.${row.state}`)}</dd>
        </div>
        {row.concludedAt === null ? null : (
          <div>
            <dt className="text-muted">{l("exp.concluded")}</dt>
            <dd className="text-text">
              <DateTime value={row.concludedAt} locale={locale} precision="minute" />
            </dd>
          </div>
        )}
      </dl>

      <h3 className="mt-6 font-serif text-16 text-text">{l("exp.variants")}</h3>
      <Table
        className="mt-2"
        caption={l("exp.variants")}
        captionHidden
        rowKey={(variant) => variant.key}
        rows={variants}
        columns={variantColumns(l, locale, reading)}
      />

      <h3 className="mt-6 font-serif text-16 text-text">{l("exp.chart")}</h3>
      {reading?.verdict === "abandoned" ? (
        <dl className="mt-2 flex flex-col gap-2 font-ui text-13">
          <div>
            <dt className="text-muted">{l("exp.reason")}</dt>
            <dd className="max-w-prose text-text">{reading.reason ?? l("none")}</dd>
          </div>
          {reading.reachableShareBps === undefined ? null : (
            <div>
              <dt className="text-muted">{l("exp.reach")}</dt>
              <dd className="text-text tabular-nums">{(reading.reachableShareBps / 100).toFixed(1)}%</dd>
            </div>
          )}
        </dl>
      ) : reading?.probabilityToBeatControlBps === undefined ? (
        <p className="mt-2 max-w-prose font-ui text-13 text-muted">{l("exp.noReading")}</p>
      ) : (
        <SequentialRead reading={reading} l={l} />
      )}

      {reading?.note ? (
        <p className="mt-4 max-w-prose font-ui text-13 text-text">
          <span className="text-muted">{l("exp.note")}: </span>
          {reading.note}
        </p>
      ) : null}

      {mayDecide && moves.length > 0 ? (
        <Form method="post" className="mt-6 flex flex-col gap-4 border-t border-border pt-4">
          <input type="hidden" name="intent" value="decide" />
          <input type="hidden" name="key" value={formKey} />
          <input type="hidden" name="experimentId" value={row.id} />
          <input type="hidden" name="from" value={row.state} />
          <input type="hidden" name="result" value={JSON.stringify(reading ?? {})} />
          <p className="max-w-prose font-ui text-13 text-muted">{l("exp.decideHint")}</p>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={l("exp.newState")} required>
              <Select
                name="state"
                defaultValue={moves[0] ?? ""}
                options={moves.map((state) => ({ value: state, label: l(`exp.state.${state}`) }))}
              />
            </Field>
            <Field label={l("exp.verdictField")}>
              <Select
                name="verdict"
                defaultValue="inconclusive"
                options={VERDICTS.map((verdict) => ({ value: verdict, label: l(`exp.verdict.${verdict}`) }))}
              />
            </Field>
            <Field label={l("exp.winnerField")}>
              <Select
                name="winner"
                defaultValue=""
                options={[
                  { value: "", label: l("exp.noWinner") },
                  ...variants.map((variant) => ({ value: variant.key, label: variant.label ?? variant.key }))
                ]}
              />
            </Field>
          </div>
          <Field label={l("exp.noteField")}>
            <Textarea name="note" rows={2} maxLength={600} />
          </Field>
          <div>
            <Button type="submit" disabled={busy}>
              {l("exp.decide")}
            </Button>
          </div>
        </Form>
      ) : null}
    </Card>
  );
}

function variantColumns(l: Label, locale: string, reading: ExperimentResult | null): Array<Column<Variant>> {
  return [
    {
      key: "arm",
      header: l("exp.variant"),
      render: (variant) => (
        <span className="text-text">
          {variant.label ?? variant.key}
          {variant.key === "control" ? <span className="ms-2 text-subtle">{l("exp.control")}</span> : null}
          {reading?.winner === variant.key ? (
            <Badge tone="success" size="sm" className="ms-2">
              {l("exp.winner")}
            </Badge>
          ) : null}
        </span>
      )
    },
    {
      key: "split",
      header: l("exp.split"),
      numeric: true,
      render: (variant) => (variant.splitBps === undefined ? l("none") : `${(variant.splitBps / 100).toFixed(0)}%`)
    },
    {
      key: "samples",
      header: l("exp.samples"),
      numeric: true,
      render: (variant) => {
        const seen = reading?.samples?.[variant.key];
        return seen === undefined ? <span className="text-subtle">{l("none")}</span> : seen.toLocaleString(locale);
      }
    },
    {
      key: "rate",
      header: l("exp.rate"),
      numeric: true,
      render: (variant) => {
        const rate = reading?.rateBps?.[variant.key];
        return rate === undefined ? <span className="text-subtle">{l("none")}</span> : `${(rate / 100).toFixed(2)}%`;
      }
    }
  ];
}

/**
 * The reading at the stop. There is no interim series to draw — nothing writes
 * snapshots while a test runs — so the honest chart is the probability against
 * the boundary it had to cross, with the uplift beside it.
 *
 * ponytail: a bar with the 95% line marked, not a boundary curve over time.
 * When experiments start writing interim snapshots, this becomes a LineChart of
 * probability per day with the same line drawn across it.
 */
function SequentialRead({ reading, l }: { reading: ExperimentResult; l: Label }) {
  const bps = reading.probabilityToBeatControlBps ?? 0;
  const pct = Math.max(0, Math.min(100, bps / 100));
  const crossed = crossedBoundary(reading);

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-ui text-13">
        <span className="text-muted">{l("exp.probability")}</span>
        <span className="text-18 tabular-nums text-text">{pct.toFixed(1)}%</span>
        {reading.upliftBps === undefined ? null : (
          <span className={reading.upliftBps < 0 ? "text-danger" : "text-success"}>
            {l("exp.uplift")}: {reading.upliftBps > 0 ? "+" : ""}
            {(reading.upliftBps / 100).toFixed(2)}%
          </span>
        )}
        {reading.stoppedBy ? (
          <span className="text-muted">
            {l("exp.stoppedBy")}: {reading.stoppedBy.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>

      <div className="relative">
        <ProgressBar value={pct} label={l("exp.probability")} tone={crossed ? "success" : "warning"} />
        {/* The boundary itself, drawn where 95% falls across the same track. */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-text/60"
          style={{ insetInlineStart: `${DECISION_BOUNDARY_BPS / 100}%` }}
        />
      </div>

      <p className="max-w-prose font-ui text-12 text-muted">
        {l("exp.boundary")} — {crossed ? l("exp.crossed") : l("exp.notCrossed")} {l("exp.chartHint")}
      </p>

      {reading.samples === undefined ? null : (
        <p className="font-ui text-12 text-muted">
          {l("exp.samples")}: <span className="tabular-nums">{samplesSeen(reading).toLocaleString()}</span>
        </p>
      )}
    </div>
  );
}
