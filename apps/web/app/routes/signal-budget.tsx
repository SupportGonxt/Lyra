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
  BudgetMeter,
  Button,
  Card,
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  GuardrailNotice,
  KPIWall,
  Money,
  MoneyField,
  Select,
  Stat,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { moveColumns } from "./signal-cockpit";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  WINDOWS,
  budgetHeadline,
  budgetOf,
  explain,
  isReversible,
  labelsIn,
  mintKey,
  mainCurrency,
  plannedMinor,
  safe,
  totalSpendMinor,
  windowDays,
  type Budget,
  type CampaignRow,
  type MoveRow,
  type Page,
  type Problemish,
  type SpendRow
} from "./signal.shared";

// The spend ceiling and the bounds the agents move money inside. The
// `budget-moves` tab lists what moved and the `spend` tab lists what was spent;
// neither says what the limit was, and a bound nobody can see is not a bound.
//
// Every write here is consequential (CLAUDE.md §4, docs/19): raising a ceiling
// changes what the autopilot may spend, and reversing a move moves money back.
// Both go through the API's approval — `signal.campaign_launch` on the campaign
// update, `signal.budget_move` on the reversal — and a 403 `approval_required`
// is rendered as a queued decision, not as a failure.

/** packages/db/src/json.ts AutonomyLevel. The autopilot only acts on the last
 *  two; the rest stop at a suggestion. */
export const AUTONOMY = ["suggest", "draft", "act_with_approval", "act", "act_and_report"] as const;

const empty = <T,>(): Page<T> => ({ data: [] });

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const days = windowDays(url.searchParams.get("days"));
  const from = Date.now() - days * 86_400_000;

  const [campaigns, spend, moves] = await Promise.all([
    safe(() => api<Page<CampaignRow>>("/v1/signal/campaigns?limit=200", { env, request }), empty<CampaignRow>()),
    safe(
      () => api<Page<SpendRow>>(`/v1/signal/spend?sort=ts&from=${from}&limit=200`, { env, request }),
      empty<SpendRow>()
    ),
    safe(
      () => api<Page<MoveRow>>(`/v1/signal/budget-moves?sort=ts&limit=200`, { env, request }),
      empty<MoveRow>()
    )
  ]);

  const live = campaigns.data.filter((campaign) => campaign.state !== "ended");
  // Every headline here is one currency's: adding AED minor units to ZAR ones
  // produces a total that is true in neither (signal.shared mainCurrency).
  const currency = mainCurrency(live);
  const inCurrency = live.filter((campaign) => (budgetOf(campaign).currency ?? currency) === currency);
  return {
    days,
    campaigns: live,
    spendByCampaign: Object.fromEntries(
      live.map((campaign) => [
        campaign.id,
        totalSpendMinor(spend.data.filter((row) => row.campaignId === campaign.id))
      ])
    ) as Record<string, number>,
    spentMinor: totalSpendMinor(spend.data, currency),
    ceilingMinor: inCurrency.reduce((sum, campaign) => sum + plannedMinor(budgetOf(campaign), days), 0),
    currency,
    moves: moves.data,
    campaignNames: Object.fromEntries(campaigns.data.map((one) => [one.id, one.name])) as Record<string, string>,
    now: Date.now(),
    key: mintKey("signal-budget")
  };
}

export interface ActionResult {
  problem: Problemish | null;
  done: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null
});

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();

const positive = (form: FormData, name: string): number | null => {
  const raw = Number(form.get(name) ?? "");
  return Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : null;
};

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = text(form, "intent");
  const headers = { "idempotency-key": text(form, "key") || mintKey("signal-budget") };

  try {
    switch (intent) {
      case "set-bounds": {
        const id = text(form, "campaignId");
        if (!id) return refuse("campaign_required");
        const dailyMinor = positive(form, "dailyMinor");
        if (dailyMinor === null) return refuse("budget_required");
        const bound = positive(form, "boundMinor");
        if (bound === null) return refuse("bound_required");
        if (bound > dailyMinor) return refuse("bound_over_daily");
        const autonomyLevel = text(form, "autonomyLevel");
        if (!AUTONOMY.some((allowed) => allowed === autonomyLevel)) return refuse("autonomy_required");
        // The operator agreed in writing that this widens what the agents may do.
        if (text(form, "confirm") !== "on") return refuse("confirm_required");

        // Read before write: `budgetJson` holds more than these two numbers
        // (currency, a period cap), and a blind PATCH would drop the rest.
        const current = await api<CampaignRow>(`/v1/signal/campaigns/${id}`, { env, request });
        const budget: Budget = { ...budgetOf(current), dailyMinor, autopilotBoundMinor: bound };
        await api(`/v1/signal/campaigns/${id}`, {
          env,
          request,
          method: "PATCH",
          headers,
          body: { budgetJson: budget, autonomyLevel }
        });
        return { problem: null, done: intent };
      }

      // docs/19: the reversal names the person who pulled it back, and the API
      // routes it through `signal.budget_move` before the money moves.
      case "reverse-move": {
        const id = text(form, "moveId");
        if (!id) return refuse("move_required");
        const by = text(form, "actor");
        if (!by) return refuse("actor_required");
        await api(`/v1/signal/budget-moves/${id}`, {
          env,
          request,
          method: "PATCH",
          headers,
          body: { reversedBy: by, reversedAt: Date.now() }
        });
        return { problem: null, done: intent };
      }

      default:
        return refuse("bad_intent");
    }
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
}

export default function BudgetAndBounds() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const locale = shell?.locale ?? "en";
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const currency = loaded.currency;
  const headroom = loaded.ceilingMinor - loaded.spentMinor;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {budgetHeadline(l, locale, { headroomMinor: headroom, currency })}
          </h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("budget.lede")}</p>
        </div>
        <nav aria-label={l("growth.window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link key={days} to={`/signal/budget?days=${days}`} aria-current={loaded.days === days ? "page" : undefined}>
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>{l("days", { n: String(days) })}</Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {result?.done === "set-bounds" ? (
        <p className="font-ui text-13 text-success">{l("budget.boundsSaved")}</p>
      ) : null}

      <KPIWall>
        <Stat
          label={l("budget.ceiling")}
          value={<Money amountMinor={loaded.ceilingMinor} currency={currency} locale={locale} />}
          hint={l("days", { n: String(loaded.days) })}
        />
        <Stat
          label={l("budget.used")}
          value={<Money amountMinor={loaded.spentMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={headroom < 0 ? l("budget.overspend") : l("budget.headroom")}
          value={<Money amountMinor={Math.abs(headroom)} currency={currency} locale={locale} />}
        />
      </KPIWall>

      <BudgetMeter
        used={loaded.spentMinor}
        limit={loaded.ceilingMinor}
        label={l("budget.ceiling")}
        currency={currency}
        locale={locale}
      />

      <Card title={l("budget.perCampaign")}>
        {loaded.campaigns.length === 0 ? (
          <EmptyState title={l("cockpit.noCampaigns")} body={l("cockpit.noCampaigns.body")} />
        ) : (
          <Table
            caption={l("budget.caption")}
            captionHidden
            rowKey={(campaign) => campaign.id}
            rows={loaded.campaigns}
            columns={boundsColumns(l, locale, loaded.spendByCampaign, loaded.days)}
          />
        )}
      </Card>

      {may.has(PERM.campaignsUpdate) && loaded.campaigns.length > 0 ? (
        <Card title={l("budget.setBounds")} description={l("budget.autonomyHint")}>
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="set-bounds" />
            <input type="hidden" name="key" value={loaded.key} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={l("budget.pickCampaign")} required>
                <Select
                  name="campaignId"
                  defaultValue={loaded.campaigns[0]?.id ?? ""}
                  options={loaded.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))}
                />
              </Field>
              <Field label={l("autonomy")} required>
                <Select
                  name="autonomyLevel"
                  defaultValue="act_with_approval"
                  options={AUTONOMY.map((value) => ({ value, label: l(`autonomy.${value}`) }))}
                />
              </Field>
              <Field label={l("budget.daily")} required>
                <MoneyField name="dailyMinor" currency={currency} locale={locale} required defaultMinor={50000} />
              </Field>
              <Field label={l("bound")} hint={l("studio.boundHint")} required>
                <MoneyField name="boundMinor" currency={currency} locale={locale} required defaultMinor={10000} />
              </Field>
            </div>
            <Checkbox name="confirm" label={l("confirm")} required />
            <div>
              <Button type="submit" variant="primary" disabled={busy}>
                {l("save")}
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}

      <Card title={l("budget.moves")} description={l("budget.movesCaption")}>
        <GuardrailNotice title={l("budget.reverse")} reason={l("budget.reverseHint")} tone="info" />
        {loaded.moves.length === 0 ? (
          <EmptyState title={l("budget.noMoves")} body={l("budget.noMoves.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("budget.movesCaption")}
            captionHidden
            rowKey={(move) => move.id}
            rows={loaded.moves}
            columns={[
              ...moveColumns(l, locale, loaded.campaignNames),
              {
                key: "undo",
                header: l("budget.reverse"),
                render: (move: MoveRow) => (
                  <Undo
                    move={move}
                    l={l}
                    locale={locale}
                    now={loaded.now}
                    formKey={loaded.key}
                    actor={shell?.actorName ?? ""}
                    allowed={may.has(PERM.movesApprove)}
                    busy={busy}
                  />
                )
              }
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function boundsColumns(
  l: (key: string, vars?: Record<string, string>) => string,
  locale: string,
  spentBy: Record<string, number>,
  days: number
): Array<Column<CampaignRow>> {
  const money = (amountMinor: number, currency: string) => (
    <Money amountMinor={amountMinor} currency={currency} locale={locale} />
  );
  return [
    { key: "name", header: l("campaign"), render: (campaign) => campaign.name },
    { key: "state", header: l("state"), render: (campaign) => <Badge tone="neutral">{l(campaign.state)}</Badge> },
    {
      key: "daily",
      header: l("budget.daily"),
      numeric: true,
      render: (campaign) => {
        const budget = budgetOf(campaign);
        return money(budget.dailyMinor ?? 0, budget.currency ?? "ZAR");
      }
    },
    {
      key: "bound",
      header: l("bound"),
      numeric: true,
      render: (campaign) => {
        const budget = budgetOf(campaign);
        return budget.autopilotBoundMinor === undefined
          ? l("none")
          : money(budget.autopilotBoundMinor, budget.currency ?? "ZAR");
      }
    },
    {
      key: "autonomy",
      header: l("autonomy"),
      render: (campaign) => l(`autonomy.${campaign.autonomyLevel}`)
    },
    {
      key: "spent",
      header: l("budget.used"),
      numeric: true,
      render: (campaign) => money(spentBy[campaign.id] ?? 0, budgetOf(campaign).currency ?? "ZAR")
    },
    {
      key: "headroom",
      header: l("budget.headroom"),
      numeric: true,
      render: (campaign) => {
        const budget = budgetOf(campaign);
        const left = plannedMinor(budget, days) - (spentBy[campaign.id] ?? 0);
        return (
          <span className={left < 0 ? "text-danger" : undefined}>
            {money(Math.abs(left), budget.currency ?? "ZAR")}
          </span>
        );
      }
    }
  ];
}

/** One move's undo, or the reason there is none. */
function Undo({
  move,
  l,
  locale,
  now,
  formKey,
  actor,
  allowed,
  busy
}: {
  move: MoveRow;
  l: (key: string, vars?: Record<string, string>) => string;
  locale: string;
  now: number;
  formKey: string;
  actor: string;
  allowed: boolean;
  busy: boolean;
}) {
  if (move.reversedAt) {
    return (
      <span className="font-ui text-12 text-subtle">
        {l("budget.reversed")} <DateTime value={move.reversedAt} locale={locale} precision="day" />
      </span>
    );
  }
  if (!isReversible(move, now)) return <span className="font-ui text-12 text-subtle">{l("budget.expired")}</span>;
  if (!allowed) return <span className="font-ui text-12 text-subtle">{l("noPermission")}</span>;
  return (
    <Form method="post" className="flex flex-col items-start gap-1">
      <input type="hidden" name="intent" value="reverse-move" />
      <input type="hidden" name="key" value={formKey} />
      <input type="hidden" name="moveId" value={move.id} />
      <input type="hidden" name="actor" value={actor} />
      <Button type="submit" size="sm" variant="secondary" disabled={busy}>
        {l("budget.reverse")}
      </Button>
      {move.reversibleUntil ? (
        <span className="font-ui text-12 text-subtle">
          {l("budget.reverseWindow")} <DateTime value={move.reversibleUntil} locale={locale} precision="day" />
        </span>
      ) : null}
    </Form>
  );
}
