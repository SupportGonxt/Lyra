import { Form, Link, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Badge, Button, Card, EmptyState, Field, Input, KPIWall, Money, NoData, Stat, Table, hueVar, renderSection, type Column, type Section } from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  WINDOWS,
  audValueHeadline,
  audienceValue,
  explain,
  labelsIn,
  ltvToCac,
  mintKey,
  multipleText,
  safe,
  windowDays,
  type AudienceRow,
  type AudienceValue,
  type CampaignRow,
  type Label,
  type Page,
  type Problemish,
  type SpendRow,
  type TouchRow
} from "./signal.shared";

// What each audience is worth against what it costs to reach. The `audiences`
// tab lists definitions and cached sizes; it cannot say which of them makes
// money, because value lives in the attribution ledger and cost lives in the
// spend ledger and neither carries an audience.
//
// The join is the campaign: an audience is worth what the campaigns aimed at it
// bound, and costs what those campaigns spent (audienceValue in signal.shared).
// The table stays read-only — an audience definition is edited on its own tab
// — but the screen also carries the one write SCOUT hands this journey off
// for: propose a new pool from a subject, via POST /v1/signal/audiences/suggest.

/** Below this many signings the multiple is noise, not a number. */
const THIN = 5;

const empty = <T,>(): Page<T> => ({ data: [] });

/** Mirrors apps/api/src/engines/signal-audience.ts SuggestedAudience. */
interface Attribute {
  axis: string;
  value: string;
}

/** Mirrors apps/api/src/engines/signal-audience.ts DemographicReason. */
interface DemographicReason extends Attribute {
  reason: string;
  count: number;
}

/** Mirrors apps/api/src/engines/signal-audience.ts AttributeCount (@lyra/core). */
interface AttributeCount extends Attribute {
  count: number;
}

/** Mirrors packages/model-gateway/src/audience-brief.ts AudienceRule. Not
 *  rendered — kept for shape parity since the API returns it on the same
 *  object this screen reads the rest of. */
interface AudienceRule {
  all: Array<{ field: string; op: string; value: unknown }>;
}

/** Mirrors packages/model-gateway/src/audience-brief.ts TargetingProposal. */
interface TargetingProposal {
  name: string;
  summary: string;
  demographics: Attribute[];
  reasons: DemographicReason[];
  lsm: number[];
  rule: AudienceRule;
  estimatedReach: number;
  confidence: number;
}

/** Mirrors apps/api/src/engines/signal-audience.ts SuggestedAudience. */
interface SuggestedAudience {
  audienceId: string;
  proposal: TargetingProposal;
  source: "ai" | "fallback";
  auditId: string | null;
  shownCounts: AttributeCount[];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const days = windowDays(url.searchParams.get("days"));
  const from = Date.now() - days * 86_400_000;

  const [audiences, campaigns, spend, touches] = await Promise.all([
    safe(() => api<Page<AudienceRow>>("/v1/signal/audiences?limit=200", { env, request }), empty<AudienceRow>()),
    safe(() => api<Page<CampaignRow>>("/v1/signal/campaigns?limit=200", { env, request }), empty<CampaignRow>()),
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

  const rows = audienceValue(audiences.data, campaigns.data, spend.data, touches.data);
  const measured = rows.filter((row) => row.binds >= THIN && row.multiple !== null);
  return {
    days,
    rows,
    currency: spend.data[0]?.currency ?? touches.data.find((touch) => touch.currency)?.currency ?? "ZAR",
    totalValueMinor: rows.reduce((sum, row) => sum + row.valueMinor, 0),
    best: measured.reduce<AudienceValue | null>(
      (top, row) => (top === null || (row.multiple ?? 0) > (top.multiple ?? 0) ? row : top),
      null
    ),
    losing: measured.filter((row) => (row.multiple ?? 0) < 1).length,
    // The AXIS/NORTH/SCOUT/SIGNAL demo journey: SCOUT hands off a whitespace
    // grouping as `subject`/`whitespaceId` (journey-signal.tsx reads the same
    // pair). Carried here too so this screen's own suggest form starts from it.
    subject: url.searchParams.get("subject") ?? "",
    whitespaceId: url.searchParams.get("whitespaceId") ?? "",
    key: mintKey("signal-aud")
  };
}

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();

export interface ActionResult {
  problem: Problemish | null;
  suggestion: SuggestedAudience | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = text(form, "intent");
  if (intent !== "suggest_audience")
    return { problem: { title: "bad_intent", status: 400, code: "bad_intent" }, suggestion: null };

  const subject = text(form, "subject");
  if (subject.length === 0 || subject.length > 200)
    return { problem: { title: "subject_required", status: 400, code: "subject_required" }, suggestion: null };

  const headers = { "idempotency-key": text(form, "key") || mintKey("signal-aud") };
  try {
    const suggestion = await api<SuggestedAudience>("/v1/signal/audiences/suggest", {
      env,
      request,
      method: "POST",
      headers,
      body: { subject }
    });
    return { problem: null, suggestion };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, suggestion: null };
    throw error;
  }
}

export default function AudienceValueScreen() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const locale = shell?.locale ?? "en";
  const may = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const suggestion = result?.suggestion ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {audValueHeadline(l, locale, { best: loaded.best, losing: loaded.losing })}
          </h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("aud.lede")}</p>
        </div>
        <nav aria-label={l("growth.window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link
              key={days}
              to={`/signal/audience-value?days=${days}`}
              aria-current={loaded.days === days ? "page" : undefined}
            >
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>{l("days", { n: String(days) })}</Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}

      {may.has(PERM.audiencesEstimate) ? (
        <Card title={l("aud.suggestTitle")} description={l("aud.suggestLede")}>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="suggest_audience" />
            <input type="hidden" name="key" value={loaded.key} />
            <input type="hidden" name="whitespaceId" value={loaded.whitespaceId} />
            <Field label={l("aud.suggestSubject")} required>
              <Input name="subject" defaultValue={loaded.subject} required maxLength={200} />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy}>
              {l("aud.suggestAction")}
            </Button>
          </Form>

          {suggestion ? (
            <div className="mt-4 flex flex-col gap-4">
              {renderSection(poolRadar(suggestion, l), "signal")}
              {renderSection(suggestionKv(suggestion, l, locale), "signal")}
              {suggestion.proposal.reasons.length > 0 ? renderSection(suggestionWhy(suggestion, l), "signal") : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <KPIWall>
        <Stat
          label={l("aud.totalValue")}
          value={<Money amountMinor={loaded.totalValueMinor} currency={loaded.currency} locale={locale} />}
          hint={l("days", { n: String(loaded.days) })}
        />
        <Stat
          label={l("aud.best")}
          value={loaded.best ? loaded.best.audience.name : l("none")}
          hint={loaded.best?.multiple ? multipleText(locale, loaded.best.multiple) : undefined}
        />
        <Stat label={l("aud.worst")} value={String(loaded.losing)} />
      </KPIWall>

      <Card title={l("aud.title")} description={l("aud.caption")}>
        {loaded.rows.length === 0 ? (
          <EmptyState
            title={l("aud.unmeasured")}
            body={l("aud.unmeasured.body")}
            className="mt-4"
            action={
              <Link to="/signal/audiences" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
                {l("aud.openAudiences")}
              </Link>
            }
          />
        ) : (
          <Table
            className="mt-4"
            caption={l("aud.caption")}
            captionHidden
            rowKey={(row) => row.audience.id}
            rows={loaded.rows}
            columns={valueColumns(l, locale, loaded.currency)}
          />
        )}
      </Card>

      <footer className="flex flex-wrap gap-4">
        <Link to="/signal/audiences" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("aud.openAudiences")}
        </Link>
        <Link to="/signal/analytics" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("growth.title")}
        </Link>
      </footer>
    </div>
  );
}

/** Every cell the model was shown, plotted by pool share (x) and whether it
 *  survived into the proposal (y) — a rejected cell and an accepted one look
 *  identical in a table; here the accepted ones visibly separate. */
function poolRadar(suggestion: SuggestedAudience, l: Label): Section {
  const maxCount = Math.max(1, ...suggestion.shownCounts.map((c) => c.count));
  const accepted = new Set(suggestion.proposal.demographics.map((d) => `${d.axis}:${d.value}`));
  return {
    kind: "radar",
    title: l("aud.suggestedPool"),
    xlab: l("aud.suggestedPoolX"),
    ylab: l("aud.suggestedPoolY"),
    items: suggestion.shownCounts.map((c) => {
      const inPool = accepted.has(`${c.axis}:${c.value}`);
      const share = Math.round((c.count / maxCount) * 100);
      return {
        label: `${c.axis}: ${c.value} (${c.count})`,
        x: `${Math.min(92, Math.max(4, share))}%`,
        y: `${inPool ? 80 : 20}%`,
        size: `${Math.max(14, Math.round(share * 0.4))}px`,
        trail: inPool ? hueVar("signal") : "var(--text)",
        hue: inPool ? hueVar("signal") : "var(--text)"
      };
    })
  };
}

function suggestionKv(suggestion: SuggestedAudience, l: Label, locale: string): Section {
  return {
    kind: "kv",
    title: suggestion.proposal.name,
    items: [
      {
        label: l("aud.suggestedReach"),
        value: suggestion.proposal.estimatedReach.toLocaleString(locale),
        hue: hueVar("signal"),
        font: ""
      },
      {
        label: l("aud.suggestedConfidence"),
        value: `${suggestion.proposal.confidence}%`,
        hue: hueVar("signal"),
        font: ""
      },
      {
        label: l("aud.suggestedSource"),
        value: suggestion.source === "ai" ? l("aud.sourceAi") : l("aud.sourceFallback"),
        hue: "var(--text)",
        font: ""
      }
    ]
  };
}

function suggestionWhy(suggestion: SuggestedAudience, l: Label): Section {
  return {
    kind: "callout",
    title: l("aud.why"),
    items: suggestion.proposal.reasons.map((r, i) => ({
      code: String(i + 1).padStart(2, "0"),
      hue: hueVar("signal"),
      body: `${r.axis}: ${r.value} — ${r.reason}`
    }))
  };
}

function valueColumns(l: Label, locale: string, currency: string): Array<Column<AudienceValue>> {
  const money = (amountMinor: number) => <Money amountMinor={amountMinor} currency={currency} locale={locale} />;
  return [
    { key: "name", header: l("audience"), render: (row) => row.audience.name },
    {
      key: "size",
      header: l("aud.size"),
      numeric: true,
      render: (row) =>
        row.audience.sizeCached === null ? <NoData reason={l("none")} /> : row.audience.sizeCached.toLocaleString(locale)
    },
    { key: "reach", header: l("aud.reach"), numeric: true, render: (row) => String(row.campaigns) },
    { key: "spend", header: l("spend"), numeric: true, render: (row) => money(row.spendMinor) },
    { key: "binds", header: l("binds"), numeric: true, render: (row) => String(row.binds) },
    { key: "value", header: l("value"), numeric: true, render: (row) => money(row.valueMinor) },
    {
      key: "cac",
      header: l("cac"),
      numeric: true,
      render: (row) => (row.cacMinor === null ? <NoData reason={l("none")} /> : money(row.cacMinor))
    },
    {
      key: "ltv",
      header: l("ltv"),
      numeric: true,
      render: (row) => (row.ltvMinor === null ? <NoData reason={l("none")} /> : money(row.ltvMinor))
    },
    {
      key: "multiple",
      header: l("multiple"),
      numeric: true,
      render: (row) => {
        if (row.campaigns === 0) return <NoData reason={l("aud.unmeasured")} />;
        // A multiple built on two signings would be read as a finding; say so
        // rather than printing it (docs/22: a number without its confidence lies).
        if (row.binds < THIN) return <NoData reason={l("aud.thin")} />;
        const ratio = ltvToCac(row.ltvMinor, row.cacMinor);
        return ratio === null ? (
          <NoData reason={l("none")} />
        ) : (
          <span className={ratio < 1 ? "text-danger" : undefined}>{multipleText(locale, ratio)}</span>
        );
      }
    },
    {
      key: "conversion",
      header: l("aud.conversion"),
      numeric: true,
      render: (row) => (row.conversionPct > 0 ? `${row.conversionPct}%` : <NoData reason={l("none")} />)
    }
  ];
}
