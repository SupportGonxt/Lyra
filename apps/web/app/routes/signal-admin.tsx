import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, DateTime, EmptyState, KPIWall, Money, Stat, Table, type BadgeTone, type Column } from "@lyra/ui";
import { api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  REACHING_STATES,
  adminFaults,
  adminHeadline,
  budgetOf,
  excludedAudienceId,
  guardrailsOf,
  labelsIn,
  mainCurrency,
  safe,
  suppressionIds,
  type AudienceRow,
  type CampaignRow,
  type Label,
  type Page
} from "./signal.shared";

// docs/modules/signal.md §4 screen 6. Everything sent from SIGNAL is checked
// against four things that live in four different tables — the brand kit, the
// guardrail record on each campaign, the spend ceilings beside its autonomy
// level, and the suppression lists its audiences subtract. Each table alone
// looks fine; only read together do they say whether a campaign that is
// reaching people was ever actually checked.
//
// ponytail: read-only, like ORBIT admin. Every fix is one click away in the
// screen that owns it, so a second editor here would be a second place to keep
// correct.

/* --------------------------------------------------------------- contract */

const DISCLOSURES_READ = "compliance:disclosures:read";

/** compliance_disclosures — what wording was shown, when (packages/db/src/schema/compliance.ts). */
export interface DisclosureRow {
  key: string;
  locale: string;
  channel: string;
  ts: number;
}

export interface DisclosureUse {
  key: string;
  locale: string;
  channel: string;
  count: number;
}

/** Mirrors packages/core/src/approvals.ts. The web app cannot import @lyra/core. */
export const SIGNAL_POLICIES: ReadonlyArray<{
  key: string;
  decide: string;
  dualControl: "never" | "above_threshold" | "always";
  defaultThresholdMinor?: number;
}> = [
  { key: "signal.budget_move", decide: "signal:budget_moves:approve", dualControl: "never" },
  { key: "signal.campaign_launch", decide: "signal:campaigns:launch", dualControl: "never" },
  { key: "signal.creative_publish", decide: "signal:creatives:approve", dualControl: "never" },
  {
    key: "signal.budget_commit",
    decide: "signal:campaigns:launch",
    dualControl: "above_threshold",
    defaultThresholdMinor: 50_000_00
  },
  { key: "signal.boost", decide: "signal:campaigns:update", dualControl: "never" },
  { key: "signal.creator_brief", decide: "signal:creatives:approve", dualControl: "never" }
];

/* ---------------------------------------------------------------- reading */

/**
 * The log records one row per presentation, so the same wording appears once
 * per customer. What an admin needs is the distinct set actually in use —
 * wording, language and channel — and how often each was shown.
 */
export function disclosureRoll(rows: readonly DisclosureRow[]): DisclosureUse[] {
  const seen = new Map<string, DisclosureUse>();
  for (const row of rows) {
    const id = `${row.key}\u0000${row.locale}\u0000${row.channel}`;
    const use = seen.get(id);
    if (use) use.count += 1;
    else seen.set(id, { key: row.key, locale: row.locale, channel: row.channel, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** A tenant's `policy.autoApprove` allowlist (CLAUDE.md §4), whatever else the bag holds. */
export function autoApprovedIn(policy: Record<string, unknown>): string[] {
  const list = policy.autoApprove;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

const empty = <T,>(): Page<T> => ({ data: [] });

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    campaigns: held.has(PERM.campaignsRead),
    audiences: held.has(PERM.audiencesRead),
    disclosures: held.has(DISCLOSURES_READ)
  };
  const read = async <T,>(path: string, allowed: boolean): Promise<Page<T>> =>
    allowed ? safe(() => api<Page<T>>(path, { env, request }), empty<T>()) : empty<T>();

  const [campaigns, audiences, disclosures] = await Promise.all([
    read<CampaignRow>("/v1/signal/campaigns?limit=200", may.campaigns),
    read<AudienceRow>("/v1/signal/audiences?limit=200", may.audiences),
    read<DisclosureRow>("/v1/compliance/disclosures?sort=ts&limit=200", may.disclosures)
  ]);

  return {
    may,
    brand: me.tenant.brand,
    autopilotPaused: me.policy.signalAutopilotPaused === true,
    autoApprove: autoApprovedIn(me.policy),
    campaigns: campaigns.data,
    audiences: audiences.data,
    suppression: [...suppressionIds(audiences.data)],
    disclosures: disclosureRoll(disclosures.data),
    currency: mainCurrency(campaigns.data),
    // ponytail: derived server-side so the whole read stays one pass, and pure
    // over what is already returned so the tests call adminFaults directly.
    faults: adminFaults({ campaigns: campaigns.data, audiences: audiences.data })
  };
}

/* --------------------------------------------------------------- component */

function check(value: string | undefined, l: Label): { tone: BadgeTone; text: string } {
  if (!value) return { tone: "neutral", text: l("admin.guardNone") };
  return value === "pass" ? { tone: "success", text: l("admin.pass") } : { tone: "danger", text: l("admin.fail") };
}

export default function SignalAdmin() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useSignalSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);

  if (!loaded.may.campaigns && !loaded.may.audiences) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="page-title">{l("admin.title")}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("admin.lede")}</p>
        </header>
        <EmptyState title={l("admin.denied")} body={t("error.forbidden")} />
      </div>
    );
  }

  const suppression = new Set(loaded.suppression);
  const named = new Map(loaded.audiences.map((row) => [row.id, row.name]));
  const reaching = loaded.campaigns.filter((row) => REACHING_STATES.includes(row.state));
  const unchecked = reaching.filter((row) => guardrailsOf(row) === null).length;
  const unbounded = loaded.campaigns.filter(
    (row) => (row.autonomyLevel === "act" || row.autonomyLevel === "act_and_report") && !budgetOf(row).autopilotBoundMinor
  ).length;

  const logos = loaded.brand?.logo ?? {};
  const supplied = (["light", "dark", "mark"] as const).filter((slot) => Boolean(logos[slot]));

  const guardColumns: Array<Column<CampaignRow>> = [
    { key: "name", header: l("campaign"), render: (row) => row.name },
    {
      key: "claims",
      header: l("admin.claims"),
      render: (row) => {
        const shown = check(guardrailsOf(row)?.bannedClaims, l);
        return (
          <Badge tone={shown.tone} size="sm" dot>
            {shown.text}
          </Badge>
        );
      }
    },
    {
      key: "brand",
      header: l("admin.brandCheck"),
      render: (row) => {
        const shown = check(guardrailsOf(row)?.brandKit, l);
        return (
          <Badge tone={shown.tone} size="sm" dot>
            {shown.text}
          </Badge>
        );
      }
    },
    {
      key: "suppressionApplied",
      header: l("admin.suppressionApplied"),
      render: (row) => {
        const applied = guardrailsOf(row)?.suppressionAudienceApplied;
        if (applied === undefined) return l("admin.guardNone");
        return (
          <Badge tone={applied ? "success" : "danger"} size="sm" dot>
            {l(applied ? "admin.applied" : "admin.notApplied")}
          </Badge>
        );
      }
    },
    {
      key: "cap",
      header: l("admin.cap"),
      render: (row) => {
        const cap = guardrailsOf(row)?.frequencyCapPerWeek;
        return cap ? l("admin.capValue", { n: String(cap) }) : "—";
      }
    },
    {
      key: "quiet",
      header: l("admin.quiet"),
      render: (row) => {
        const quiet = guardrailsOf(row)?.quietHours;
        return quiet?.from && quiet.to ? `${quiet.from}–${quiet.to}${quiet.tz ? ` ${quiet.tz}` : ""}` : "—";
      }
    },
    {
      key: "checkedAt",
      header: l("admin.checkedAt"),
      render: (row) => {
        const at = guardrailsOf(row)?.checkedAt;
        return at ? <DateTime value={at} locale={locale} /> : "—";
      }
    }
  ];

  const boundsColumns: Array<Column<CampaignRow>> = [
    { key: "name", header: l("campaign"), render: (row) => row.name },
    { key: "state", header: l("state"), render: (row) => row.state },
    { key: "autonomy", header: l("autonomy"), render: (row) => l(`autonomy.${row.autonomyLevel}`) },
    {
      key: "daily",
      header: l("budget.daily"),
      numeric: true,
      render: (row) => {
        const daily = budgetOf(row).dailyMinor;
        return daily ? <Money amountMinor={daily} currency={budgetOf(row).currency ?? loaded.currency} locale={locale} /> : "—";
      }
    },
    {
      key: "bound",
      header: l("bound"),
      numeric: true,
      render: (row) => {
        const bound = budgetOf(row).autopilotBoundMinor;
        return bound ? (
          <Money amountMinor={bound} currency={budgetOf(row).currency ?? loaded.currency} locale={locale} />
        ) : (
          <Badge tone="warning" size="sm" dot>
            {l("admin.noBound")}
          </Badge>
        );
      }
    }
  ];

  const policyColumns: Array<Column<(typeof SIGNAL_POLICIES)[number]>> = [
    { key: "key", header: l("admin.policyKey"), render: (row) => l(`admin.policy.${row.key}`) },
    {
      key: "decide",
      header: l("admin.policyDecide"),
      render: (row) => <span className="font-mono text-12">{row.decide}</span>
    },
    { key: "dualControl", header: l("admin.policyDual"), render: (row) => l(`admin.dual.${row.dualControl}`) },
    {
      key: "threshold",
      header: l("admin.policyThreshold"),
      numeric: true,
      render: (row) =>
        row.defaultThresholdMinor ? (
          <Money amountMinor={row.defaultThresholdMinor} currency={loaded.currency} locale={locale} />
        ) : (
          "—"
        )
    },
    {
      key: "auto",
      header: l("admin.policyAuto"),
      render: (row) => t(loaded.autoApprove.includes(row.key) ? "common.yes" : "common.no")
    }
  ];

  const audienceColumns: Array<Column<AudienceRow>> = [
    { key: "name", header: l("admin.audienceName"), render: (row) => row.name },
    { key: "consent", header: l("admin.consent"), render: (row) => row.consentPurposes ?? "—" },
    {
      key: "excludes",
      header: l("admin.excludes"),
      render: (row) => {
        const excluded = excludedAudienceId(row);
        return excluded ? (named.get(excluded) ?? excluded) : "—";
      }
    },
    {
      key: "isSuppression",
      header: l("admin.isSuppression"),
      render: (row) =>
        suppression.has(row.id) ? (
          <Badge tone="info" size="sm" dot>
            {l("admin.isSuppression")}
          </Badge>
        ) : (
          "—"
        )
    },
    { key: "size", header: l("admin.size"), numeric: true, render: (row) => row.sizeCached ?? "—" },
    {
      key: "refresh",
      header: l("admin.refresh"),
      render: (row) => (row.lastRefreshedAt ? <DateTime value={row.lastRefreshedAt} locale={locale} /> : "—")
    }
  ];

  const disclosureColumns: Array<Column<DisclosureUse>> = [
    { key: "key", header: l("admin.discKey"), render: (row) => <span className="font-mono text-12">{row.key}</span> },
    { key: "locale", header: l("admin.discLocale"), render: (row) => row.locale },
    { key: "channel", header: l("admin.discChannel"), render: (row) => row.channel },
    { key: "count", header: l("admin.discCount"), numeric: true, render: (row) => row.count }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{adminHeadline(l, loaded.faults.length)}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("admin.lede")}</p>
        </div>
        <Badge tone={loaded.autopilotPaused ? "warning" : "success"} dot>
          {l(loaded.autopilotPaused ? "admin.paused" : "admin.running")}
        </Badge>
      </header>

      <KPIWall>
        <Stat label={l("admin.guardNone")} value={String(unchecked)} hint={l("admin.guardLede")} />
        <Stat label={l("admin.noBound")} value={String(unbounded)} hint={l("admin.boundsLede")} />
        <Stat label={l("admin.isSuppression")} value={String(suppression.size)} hint={l("admin.suppressionLede")} />
      </KPIWall>

      {loaded.faults.length === 0 ? (
        <EmptyState title={l("admin.readyTitle")} body={l("admin.readyBody")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {loaded.faults.map((fault, index) => (
            <li key={`${fault.key}-${fault.ref}-${index}`} className="flex items-start gap-2 font-ui text-13">
              <Badge tone="warning" size="sm" dot>
                {fault.ref || "!"}
              </Badge>
              <span>{l(fault.key)}</span>
            </li>
          ))}
        </ul>
      )}

      <Card title={l("admin.brandTitle")} description={l("admin.brandLede")}>
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={l("admin.brandName")} value={loaded.brand?.name ?? l("admin.brandDefault")} />
            <Stat
              label={l("admin.brandAccent")}
              value={
                loaded.brand?.palette?.accent ? (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block size-3 rounded-full border border-line"
                      style={{ background: loaded.brand.palette.accent }}
                    />
                    <span className="font-mono text-12">{loaded.brand.palette.accent}</span>
                  </span>
                ) : (
                  l("admin.brandDefault")
                )
              }
            />
            <Stat
              label={l("admin.brandLogos")}
              value={supplied.length > 0 ? supplied.join(" · ") : l("admin.brandDefault")}
            />
          </div>
          <p className="font-ui text-13 text-subtle">{l("admin.brandHint")}</p>
          <Link to="/settings" className="font-ui text-13 text-accent underline underline-offset-2">
            {l("admin.brandEdit")}
          </Link>
        </div>
      </Card>

      {loaded.may.campaigns ? (
        <Card title={l("admin.guardTitle")} description={l("admin.guardLede")}>
          <Table
            caption={l("admin.guardCaption")}
            columns={guardColumns}
            rows={loaded.campaigns}
            rowKey={(row) => row.id}
            rowState={(row) => (REACHING_STATES.includes(row.state) ? undefined : "sealed")}
            empty={<EmptyState title={l("admin.guardEmpty")} body={l("admin.guardEmpty.body")} />}
          />
        </Card>
      ) : null}

      {loaded.may.campaigns ? (
        <Card title={l("admin.boundsTitle")} description={l("admin.boundsLede")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("admin.boundsCaption")}
              columns={boundsColumns}
              rows={loaded.campaigns}
              rowKey={(row) => row.id}
              empty={<EmptyState title={l("admin.boundsEmpty")} body={l("admin.boundsEmpty.body")} />}
            />
            <Link to="/signal/budget" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("admin.boundsEdit")}
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title={l("admin.policyTitle")} description={l("admin.policyLede")}>
        <div className="flex flex-col gap-3">
          <Table
            caption={l("admin.policyCaption")}
            columns={policyColumns}
            rows={[...SIGNAL_POLICIES]}
            rowKey={(row) => row.key}
          />
          <Link to="/approvals" className="font-ui text-13 text-accent underline underline-offset-2">
            {l("admin.policyEdit")}
          </Link>
        </div>
      </Card>

      {loaded.may.audiences ? (
        <Card title={l("admin.suppressionTitle")} description={l("admin.suppressionLede")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("admin.suppressionCaption")}
              columns={audienceColumns}
              rows={loaded.audiences}
              rowKey={(row) => row.id}
              empty={<EmptyState title={l("admin.suppressionEmpty")} body={l("admin.suppressionEmpty.body")} />}
            />
            <Link to="/signal/audiences" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("admin.suppressionEdit")}
            </Link>
          </div>
        </Card>
      ) : null}

      {loaded.may.disclosures ? (
        <Card title={l("admin.discTitle")} description={l("admin.discLede")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("admin.discCaption")}
              columns={disclosureColumns}
              rows={loaded.disclosures}
              rowKey={(row) => `${row.key}-${row.locale}-${row.channel}`}
              empty={<EmptyState title={l("admin.discEmpty")} body={l("admin.discEmpty.body")} />}
            />
            <Link to="/compliance/disclosures" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("admin.discEdit")}
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title={l("admin.gapTitle")} description={l("admin.gapLede")}>
        <ul className="flex list-disc flex-col gap-2 ps-5 font-ui text-13 text-muted">
          <li>{l("admin.gapChannels")}</li>
          <li>{l("admin.gapUtm")}</li>
        </ul>
      </Card>
    </div>
  );
}
