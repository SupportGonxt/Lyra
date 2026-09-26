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
  DateTime,
  EmptyState,
  EvidenceLink,
  KPIWall,
  Money,
  ProgressBar,
  Sparkline,
  Stat,
  Table,
  shortRef,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { arrowFor } from "../i18n";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { channelColumns } from "./signal-studio";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  WINDOWS,
  budgetOf,
  cacMinor,
  cockpitHeadline,
  dailySpend,
  explain,
  labelsIn,
  mainCurrency,
  mintKey,
  moveEndpoint,
  plannedMinor,
  rollByChannel,
  safe,
  totalSpendMinor,
  windowDays,
  channelLabel,
  scaleRows,
  type CampaignRow,
  type MoveRow,
  type OutreachRow,
  type Page,
  type Problemish,
  type ResponseRollup,
  type ScaleRow,
  type SpendRow,
  type TouchRow
} from "./signal.shared";

// The marketing operator's landing view. The campaigns tab answers "what exists"
// and the spend tab answers "what it cost", but nobody starts their day with a
// list: they want the window's money against its plan, the channels that turned
// it into customers, and — because the budget autopilot moves money while nobody
// is watching — what the agents changed and why (docs/15 §4 background work is
// reported, never hidden).

const empty = <T,>(): Page<T> => ({ data: [] });

const RUNNING_STATES = ["live", "paused"];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const days = windowDays(new URL(request.url).searchParams.get("days"));
  const from = Date.now() - days * 86_400_000;
  const window = `sort=ts&from=${from}&limit=200`;

  const rollup = (level: string) =>
    safe(() => api<{ data: ResponseRollup }>(`/v1/signal/responses/rollup?level=${level}&since=${from}`, { env, request }), { data: [] });
  const [me, campaigns, spend, touches, moves, outreach, byCampaign, byAudience, byCustomer, audiences] = await Promise.all([
    safe(() => fetchMe(env, request), null),
    safe(() => api<Page<CampaignRow>>("/v1/signal/campaigns?limit=200", { env, request }), empty<CampaignRow>()),
    safe(() => api<Page<SpendRow>>(`/v1/signal/spend?${window}`, { env, request }), empty<SpendRow>()),
    safe(
      () => api<Page<TouchRow>>(`/v1/signal/attribution-events?${window}`, { env, request }),
      empty<TouchRow>()
    ),
    safe(() => api<Page<MoveRow>>(`/v1/signal/budget-moves?${window}`, { env, request }), empty<MoveRow>()),
    // The acquisition outreach ledger (engines/signal-outreach.ts): what was
    // sent, to whom, and which rows closed into a policy. This is the loop's
    // proof side — spend is the left edge, these are the middle and the close.
    safe(() => api<Page<OutreachRow>>(`/v1/signal/outreach?${window}`, { env, request }), empty<OutreachRow>()),
    // ADR-0091: what came back, at the three scales marketing works at.
    rollup("campaign"),
    rollup("audience"),
    rollup("customer"),
    safe(() => api<Page<{ id: string; name: string }>>("/v1/signal/audiences?limit=200", { env, request }), empty<{ id: string; name: string }>())
  ]);

  const running = campaigns.data.filter((campaign) => RUNNING_STATES.includes(campaign.state));
  // One currency per headline — see mainCurrency in signal.shared.
  const currency = mainCurrency(running.length ? running : campaigns.data);
  return {
    days,
    // The kill switch lives on the tenant policy, and /v1/me is the only read
    // that returns it (apps/api/src/routes/signal.ts setAutopilotPaused).
    autopilotPaused: Boolean(me?.policy?.signalAutopilotPaused),
    spend: spend.data,
    touches: touches.data,
    moves: moves.data,
    outreach: outreach.data,
    scales: {
      campaign: byCampaign.data,
      audience: byAudience.data,
      customer: byCustomer.data
    },
    audienceNames: Object.fromEntries(audiences.data.map((one) => [one.id, one.name])) as Record<string, string>,
    // A move names its campaign by ref; the changes table printed the ref.
    campaignNames: Object.fromEntries(campaigns.data.map((one) => [one.id, one.name])) as Record<string, string>,
    running,
    plannedMinor: running
      .filter((campaign) => (budgetOf(campaign).currency ?? currency) === currency)
      .reduce((sum, campaign) => sum + plannedMinor(budgetOf(campaign), days), 0),
    currency,
    key: mintKey("signal-cockpit")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: string | null;
  /** How many moves the manual autopilot pass made, when that was the intent. */
  adjusted: number | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null,
  adjusted: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const headers = { "idempotency-key": String(form.get("key") ?? "") || mintKey("signal-cockpit") };

  try {
    switch (intent) {
      // Pausing and resuming the autopilot is not itself a spend, but it changes
      // who may spend, so both are audited on the API side.
      case "pause":
      case "resume": {
        await api(`/v1/signal/autopilot/${intent}`, { env, request, method: "POST", headers });
        return { problem: null, done: intent, adjusted: null };
      }
      case "run": {
        const result = await api<{ adjusted: unknown }>("/v1/signal/autopilot/run", {
          env,
          request,
          method: "POST",
          headers
        });
        const moves = Array.isArray(result.adjusted) ? result.adjusted.length : Number(result.adjusted) || 0;
        return { problem: null, done: intent, adjusted: moves };
      }
      // The acquisition outreach sweep. The API returns outcome counts; the
      // screen reports them the same way it reports autopilot moves — what
      // happened, in numbers, with the loop panel right below showing rows.
      case "outreach": {
        const result = await api<{ sent: number; pendingApproval: number }>("/v1/signal/outreach/run", {
          env,
          request,
          method: "POST",
          headers
        });
        const touched = result.sent + result.pendingApproval;
        return { problem: null, done: intent, adjusted: touched };
      }
      default:
        return refuse("bad_intent");
    }
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null, adjusted: null };
    throw error;
  }
}

export default function GrowthCockpit() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const locale = shell?.locale ?? "en";
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";

  const spent = totalSpendMinor(loaded.spend, loaded.currency);
  const rolls = rollByChannel(loaded.spend, loaded.touches);
  const binds = rolls.reduce((sum, roll) => sum + roll.binds, 0);
  const cac = cacMinor(spent, binds);
  // The loop, folded per campaign: what went out and how much came back.
  const loop = loopSummary(loaded.outreach, loaded.touches);
  const converted = loaded.outreach.filter((one) => one.state === "converted");
  const trend = dailySpend(loaded.spend);
  const planPct = loaded.plannedMinor > 0 ? Math.round((spent / loaded.plannedMinor) * 100) : 0;
  const currency = loaded.currency;

  const headline = cockpitHeadline(l, {
    movesCount: loaded.moves.length,
    planPct,
    runningCount: loaded.running.length
  });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{l("cockpit.title")}</span>
          <h1 className="page-title">{headline}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("cockpit.lede")}</p>
        </div>
        <nav aria-label={l("growth.window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link
              key={days}
              to={`/signal/cockpit?days=${days}`}
              className="font-ui text-12 text-accent underline-offset-2 hover:underline"
              aria-current={loaded.days === days ? "page" : undefined}
            >
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>{l("days", { n: String(days) })}</Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.adjusted !== null && result?.adjusted !== undefined ? (
        <p className="font-ui text-13 text-success">
          {AGENT_MARK} {l("cockpit.adjusted", { n: String(result.adjusted) })}
        </p>
      ) : null}

      <KPIWall>
        <Stat
          label={l("cockpit.spendToDate")}
          value={<Money amountMinor={spent} currency={currency} locale={locale} />}
          hint={l("days", { n: String(loaded.days) })}
        />
        <Stat
          label={l("plan")}
          value={<Money amountMinor={loaded.plannedMinor} currency={currency} locale={locale} />}
        />
        <Stat label={l("binds")} value={binds} />
        <Stat
          label={l("cac")}
          value={cac === null ? l("none") : <Money amountMinor={cac} currency={currency} locale={locale} />}
        />
      </KPIWall>

      <div className="flex flex-col gap-1">
        <span className="eyebrow">{l("cockpit.againstPlan")}</span>
        <ProgressBar
          value={Math.min(planPct, 100)}
          tone={planPct > 100 ? "danger" : planPct > 80 ? "warning" : "accent"}
          label={l("cockpit.againstPlan")}
        />
      </div>

      <Card title={l("cockpit.autopilot")}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={loaded.autopilotPaused ? "warning" : "success"} dot>
            {loaded.autopilotPaused ? l("cockpit.paused") : l("cockpit.running")}
          </Badge>
          <Form method="post" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="key" value={loaded.key} />
            {may.has(PERM.autopilotPause) ? (
              <Button
                type="submit"
                name="intent"
                value={loaded.autopilotPaused ? "resume" : "pause"}
                variant={loaded.autopilotPaused ? "primary" : "secondary"}
                disabled={busy}
              >
                {loaded.autopilotPaused ? l("cockpit.resume") : l("cockpit.pause")}
              </Button>
            ) : null}
            {may.has(PERM.autopilotRun) ? (
              <Button type="submit" name="intent" value="run" variant="ghost" disabled={busy}>
                {l("cockpit.runNow")}
              </Button>
            ) : null}
          </Form>
          <EvidenceLink source="/docs/modules/signal.md" sourceLabel={l("why")}>
            {l("cockpit.autopilotWhy")}
          </EvidenceLink>
        </div>
      </Card>

      {trend.length > 1 ? (
        <Card title={l("cockpit.trend")}>
          <Sparkline
            values={trend.map((point) => point.amountMinor)}
            label={l("cockpit.trend")}
            tone="accent"
          />
        </Card>
      ) : null}

      <Card title={l("cockpit.pipeline")}>
        {rolls.length === 0 ? (
          <EmptyState title={l("growth.noSpend")} body={l("growth.noSpend.body")} />
        ) : (
          <Table
            caption={l("cockpit.pipelineCaption")}
            captionHidden
            rowKey={(roll) => roll.channel}
            rows={rolls}
            columns={channelColumns(l, locale, currency)}
          />
        )}
      </Card>

      {/* The acquisition loop (engines/signal-outreach.ts): spend → message →
          lead → bind, with the closed loops named. A converted row IS the
          proof — "SIGNAL bought this customer" with a policy ref to click,
          not a dashboard's word for it. Absent without signal:outreach:read,
          the same withheld-not-disabled rule every panel follows. */}
      {may.has(PERM.outreachRead) ? (
        <Card
          title={l("cockpit.loop")}
          description={l("cockpit.loopCaption")}
          actions={
            may.has(PERM.outreachSend) ? (
              <Form method="post">
                <input type="hidden" name="key" value={loaded.key} />
                <Button type="submit" name="intent" value="outreach" variant="secondary" size="sm" disabled={busy}>
                  {l("cockpit.runOutreach")}
                </Button>
              </Form>
            ) : null
          }
        >
          {loop.length === 0 ? (
            <EmptyState title={l("cockpit.noLoop")} body={l("cockpit.noLoop.body")} />
          ) : (
            <Table
              caption={l("cockpit.loopCaption")}
              captionHidden
              rowKey={(row) => row.campaignId}
              rows={loop}
              columns={loopColumns(l, loaded.campaignNames)}
            />
          )}
          {converted.length ? (
            <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
              {converted.slice(0, 5).map((one) => (
                <p key={one.id} className="flex flex-wrap items-center gap-2 font-ui text-12 text-muted">
                  <span aria-hidden="true" className="text-accent">&#10022;</span>
                  <span>
                    {l("cockpit.closedLoop", {
                      channel: channelLabel(one.channel, locale),
                      campaign: loaded.campaignNames[one.campaignId] ?? one.campaignId
                    })}
                  </span>
                  {one.convertedRef ? (
                    <Link
                      to={`/axis/policies/${one.convertedRef}/detail`}
                      className="font-mono text-accent underline-offset-2 hover:underline"
                    >
                      {shortRef(one.convertedRef)}
                    </Link>
                  ) : null}
                </p>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ADR-0091: the same responses rolled up broad (campaign), niche
          (audience) and individual (person). Withheld without campaign read,
          which is what the rollup endpoint checks. */}
      {may.has(PERM.campaignsRead) ? (
        <Card title={l("cockpit.scales")} description={l("cockpit.scalesCaption")}>
          {loaded.scales.campaign.length === 0 ? (
            <EmptyState title={l("cockpit.noResponses")} body={l("cockpit.noResponses.body")} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {(
                [
                  ["campaign", loaded.campaignNames],
                  ["audience", loaded.audienceNames],
                  ["customer", {}]
                ] as const
              ).map(([level, names]) => (
                <section key={level}>
                  <Table
                    caption={l(`cockpit.scale.${level}`)}
                    rowKey={(row) => row.key}
                    rows={scaleRows(loaded.scales[level], names, 5)}
                    columns={scaleColumns(l, l(`cockpit.scale.${level}`))}
                  />
                </section>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      <Card
        title={l("cockpit.liveCampaigns")}
        actions={
          <Link to="/signal/studio" className="font-ui text-12 text-accent underline-offset-2 hover:underline">
            {l("cockpit.startOne")}
          </Link>
        }
      >
        {loaded.running.length === 0 ? (
          <EmptyState title={l("cockpit.noCampaigns")} body={l("cockpit.noCampaigns.body")} />
        ) : (
          <Table
            caption={l("cockpit.liveCaption")}
            captionHidden
            rowKey={(campaign) => campaign.id}
            rows={loaded.running}
            columns={campaignColumns(l, locale)}
          />
        )}
      </Card>

      <Card title={l("cockpit.changesToday")} description={l("cockpit.changesCaption")}>
        {loaded.moves.length === 0 ? (
          <EmptyState title={l("cockpit.noChanges")} body={l("cockpit.noChanges.body")} />
        ) : (
          <Table
            caption={l("cockpit.changesCaption")}
            captionHidden
            rowKey={(move) => move.id}
            rows={loaded.moves}
            columns={moveColumns(l, locale, loaded.campaignNames)}
          />
        )}
      </Card>

      <nav aria-label={l("cockpit.title")} className="flex flex-wrap items-center gap-4">
        <Link to="/signal/budget" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("cockpit.openBudget")}
        </Link>
        <Link to="/signal/analytics" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("cockpit.openAnalytics")}
        </Link>
      </nav>
    </div>
  );
}

function campaignColumns(l: (key: string) => string, locale: string): Array<Column<CampaignRow>> {
  return [
    {
      key: "name",
      header: l("campaign"),
      render: (campaign) => (
        <Link
          to={`/signal/studio?campaignId=${encodeURIComponent(campaign.id)}`}
          className="text-accent underline-offset-2 hover:underline"
        >
          {campaign.name}
        </Link>
      )
    },
    { key: "state", header: l("state"), render: (campaign) => <Badge tone="neutral">{l(campaign.state)}</Badge> },
    { key: "objective", header: l("studio.objective"), render: (campaign) => l(campaign.objective) },
    { key: "autonomy", header: l("autonomy"), render: (campaign) => l(`autonomy.${campaign.autonomyLevel}`) },
    {
      key: "daily",
      header: l("budget.daily"),
      numeric: true,
      render: (campaign) => {
        const budget = budgetOf(campaign);
        return (
          <Money
            amountMinor={budget.dailyMinor ?? 0}
            currency={budget.currency ?? "ZAR"}
            locale={locale}
          />
        );
      }
    }
  ];
}

/** The agents' own audit trail, in the operator's language. Shared with the
 *  budget screen, which adds the undo column. */
export function moveColumns(
  l: (key: string) => string,
  locale: string,
  /** Campaign id → name, so a move reads as a campaign and a channel. */
  names: Record<string, string> = {}
): Array<Column<MoveRow>> {
  return [
    { key: "when", header: l("when"), render: (move) => <DateTime value={move.ts} locale={locale} /> },
    {
      key: "from",
      header: l("budget.moves"),
      render: (move) =>
        `${moveEndpoint(move.fromRef, names, locale)} ${arrowFor(locale)} ${moveEndpoint(move.toRef, names, locale)}`
    },
    {
      key: "amount",
      header: l("amount"),
      numeric: true,
      render: (move) => <Money amountMinor={move.amountMinor} currency={move.currency} locale={locale} />
    },
    { key: "reason", header: l("reason"), render: (move) => move.reason },
    {
      key: "by",
      header: l("cockpit.movedBy"),
      render: (move) => (
        <Badge tone={move.approvedBy ? "info" : "accent"}>
          {move.approvedBy ? l("budget.needsApproval") : l("budget.autoApproved")}
        </Badge>
      )
    }
  ];
}

/** One row per campaign: what went out, what came back, and how far the loop
 *  closed. Leads and binds come from the attribution touches (the same rows
 *  onBindIssued writes), sends from the outreach ledger. */
export function loopSummary(
  outreach: OutreachRow[],
  touches: TouchRow[]
): Array<{ campaignId: string; channel: string; sends: number; leads: number; binds: number }> {
  const byCampaign = new Map<string, { campaignId: string; channel: string; sends: number; leads: number; binds: number }>();
  const at = (campaignId: string, channel: string) => {
    const key = `${campaignId}:${channel}`;
    let row = byCampaign.get(key);
    if (!row) {
      row = { campaignId, channel, sends: 0, leads: 0, binds: 0 };
      byCampaign.set(key, row);
    }
    return row;
  };
  for (const one of outreach) {
    if (one.state === "sent" || one.state === "converted") {
      at(one.campaignId, one.channel).sends++;
    }
  }
  for (const touch of touches) {
    if (!touch.campaignId) continue;
    if (touch.touchType === "lead") at(touch.campaignId, touch.channel).leads++;
    else if (touch.touchType === "bind") at(touch.campaignId, touch.channel).binds++;
  }
  return [...byCampaign.values()];
}

/** The loop table's columns. Counts first, conversion last — reading down the
 *  row is reading the funnel. */
export function loopColumns(
  l: (key: string) => string,
  names: Record<string, string>
): Array<Column<{ campaignId: string; channel: string; sends: number; leads: number; binds: number }>> {
  return [
    {
      key: "campaign",
      header: l("campaign"),
      render: (row) => names[row.campaignId] ?? shortRef(row.campaignId)
    },
    { key: "channel", header: l("channel"), render: (row) => channelLabel(row.channel) },
    { key: "sends", header: l("cockpit.loopSends"), numeric: true, render: (row) => row.sends },
    { key: "leads", header: l("cockpit.loopLeads"), numeric: true, render: (row) => row.leads },
    { key: "binds", header: l("binds"), numeric: true, render: (row) => row.binds }
  ];
}

/** One scale's columns: who, how many were sent, and what came back. */
export function scaleColumns(l: (key: string) => string, who: string): Array<Column<ScaleRow>> {
  return [
    { key: "name", header: who, render: (row) => row.name ?? shortRef(row.key) },
    { key: "sent", header: l("cockpit.loopSends"), numeric: true, render: (row) => row.sent },
    { key: "replied", header: l("cockpit.replied"), numeric: true, render: (row) => row.replied },
    { key: "rate", header: l("cockpit.replyRate"), numeric: true, render: (row) => (row.replyPct === null ? "—" : `${row.replyPct}%`) },
    { key: "binds", header: l("cockpit.signed"), numeric: true, render: (row) => row.binds }
  ];
}
