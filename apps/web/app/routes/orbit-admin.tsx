import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, EmptyState, PageHeader, Stat, Table, type BadgeTone, type Column } from "@lyra/ui";
import { api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { orbit } from "../modules/orbit";
import { labelsFor, optionLabel } from "../modules/spec";
import { labelsFrom, nameOf, rowsOf, safe, tag, type Label, type Page } from "./detail-kit";
import { useOrbitSessionData } from "./orbit-shell";

// docs/modules/orbit.md §4 screen 6. The five config tables ORBIT routes on
// (channels, teams, members, routing rules, SLA) are plain CRUD and live as
// generated module tabs — this screen is the one thing those lists cannot give
// an admin: whether the configuration, read together, actually routes a
// conversation to a person. A rule pointing at an empty team, a transport with
// no active connector and a tenant with no default team are each invisible in
// a per-table list and each silently strand inbound traffic.
//
// ponytail: read-only. Every fix is one click away in the tab this screen links
// to, so a second editor here would be a second place to keep correct.

/* --------------------------------------------------------------- contract */

export const PERM = {
  teams: "orbit:teams:read",
  channels: "orbit:channels:read",
  presence: "orbit:presence:read"
} as const;

/** The transports orbit_channel_connectors may carry (packages/db/src/schema/orbit.ts). */
export const TRANSPORTS = ["whatsapp", "email", "web", "voice", "agent"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface ConnectorRow {
  id: string;
  provider: string;
  transport: string;
  label: string;
  status: string;
}

export interface TeamRow {
  id: string;
  key: string;
  nameJson: unknown;
  isDefault: boolean | number;
  status: string;
}

export interface MemberRow {
  id: string;
  teamId: string;
  userId: string;
  maxConcurrent: number | null;
}

export interface PresenceRow {
  userId: string;
  status: string;
  activeCount: number | null;
}

export interface RuleRow {
  id: string;
  seq: number;
  teamId: string;
  enabled: boolean | number;
  conditionsJson: unknown;
}

export interface SlaRow {
  id: string;
  key: string;
  frtMinutes: number;
  resolutionMinutes: number;
}

export interface Coverage {
  teamId: string;
  key: string;
  isDefault: boolean;
  members: number;
  available: number;
  headroom: number;
}

/* ---------------------------------------------------------------- reading */

/** SQLite hands booleans back as 0/1 through the generic CRUD layer. */
const truthy = (value: boolean | number | null | undefined): boolean => value === true || value === 1;

/** A `*Json` column arrives parsed from generic CRUD and as text from elsewhere. */
function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const bag: unknown = JSON.parse(value);
      return bag && typeof bag === "object" && !Array.isArray(bag) ? (bag as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Per team: who is on it, how many of them are available right now, and how
 * many more conversations they could take. Headroom counts only available
 * people — an away agent's spare slots are not capacity.
 */
export function coverageOf(teams: TeamRow[], members: MemberRow[], presence: PresenceRow[]): Coverage[] {
  const seen = new Map(presence.map((row) => [row.userId, row]));
  return teams.map((team) => {
    const own = members.filter((member) => member.teamId === team.id);
    const free = own.filter((member) => seen.get(member.userId)?.status === "available");
    return {
      teamId: team.id,
      key: team.key,
      isDefault: truthy(team.isDefault),
      members: own.length,
      available: free.length,
      headroom: free.reduce(
        (total, member) => total + Math.max(0, (member.maxConcurrent ?? 0) - (seen.get(member.userId)?.activeCount ?? 0)),
        0
      )
    };
  });
}

/** Transports with no active connector: inbound on one of these reaches nobody. */
export function transportGaps(connectors: ConnectorRow[]): Transport[] {
  const live = new Set(connectors.filter((row) => row.status === "active").map((row) => row.transport));
  return TRANSPORTS.filter((transport) => !live.has(transport));
}

/**
 * The faults that only show up when the five tables are read together. Each is
 * a real stranding: an unroutable rule, an uncovered transport, or a missing
 * fallback for everything no rule matched.
 */
export function faultsOf(input: {
  connectors: ConnectorRow[];
  teams: TeamRow[];
  rules: RuleRow[];
  coverage: Coverage[];
}): Array<{ key: string; ref: string }> {
  const faults: Array<{ key: string; ref: string }> = [];
  const byId = new Map(input.coverage.map((row) => [row.teamId, row]));

  const defaults = input.teams.filter((team) => truthy(team.isDefault) && team.status === "active");
  if (defaults.length === 0) faults.push({ key: "fault.noDefault", ref: "" });
  if (defaults.length > 1) faults.push({ key: "fault.manyDefaults", ref: defaults.map((team) => team.key).join(", ") });

  for (const rule of input.rules) {
    if (!truthy(rule.enabled)) continue;
    const team = byId.get(rule.teamId);
    if (!team) faults.push({ key: "fault.ruleUnknownTeam", ref: String(rule.seq) });
    else if (team.members === 0) faults.push({ key: "fault.ruleEmptyTeam", ref: `${rule.seq} · ${team.key}` });
  }

  for (const transport of transportGaps(input.connectors)) faults.push({ key: "fault.noConnector", ref: transport });
  return faults;
}

/** What the admin should read first: stranded routing, else the live reach. */
export function adminHeadline(faultCount: number, liveChannels: number, activeTeams: number, l: Label): string {
  if (faultCount > 0) return l("headlineFaults", { n: String(faultCount) });
  return l("headlineOk", { channels: String(liveChannels), teams: String(activeTeams) });
}

/* ----------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Conversations admin",
    intro: "Read the channels, teams and routing rules together, then fix what is stranded.",
    headlineFaults: "{n} things are stranded",
    headlineOk: "{channels} live channels, {teams} active teams, nothing stranded",
    fixStranded: "Fix routing rules",
    deniedTitle: "You cannot read Conversations admin settings",
    reachTitle: "Reach",
    reachIntro: "Whether an arriving conversation has a live channel to arrive on and a person to reach.",
    statChannels: "Live channels",
    statTeams: "Active teams",
    statAvailable: "Agents available",
    statHeadroom: "Free capacity",
    faultsTitle: "Nothing is stranded.",
    faultsBody: "Every enabled rule points at a staffed team and every transport has a live connector.",
    "fault.noDefault": "No default team, so anything no rule matches has nowhere to land.",
    "fault.manyDefaults": "More than one team is marked default; routing picks one arbitrarily.",
    "fault.ruleUnknownTeam": "A routing rule points at a team that no longer exists.",
    "fault.ruleEmptyTeam": "A routing rule points at a team with no members.",
    "fault.noConnector": "No active connector carries this transport.",
    routingTitle: "Routing order",
    routingIntro: "Read top to bottom; the first rule whose conditions match wins.",
    routingCaption: "Routing rules in order",
    routingEmpty: "No routing rule yet, so everything falls to the default team.",
    "routingEmpty.body": "Add a rule to send a conversation to the team that should own it.",
    routingManage: "Edit routing rules",
    colSeq: "Order",
    colTeam: "Team",
    colConditions: "Matches",
    colEnabled: "Enabled",
    condAny: "Anything",
    sentimentBelow: "Sentiment below",
    rosterTitle: "Roster",
    rosterIntro: "Who is on each team and how much more they can take right now.",
    rosterCaption: "Teams and their coverage",
    rosterEmpty: "No team yet.",
    "rosterEmpty.body": "Create a team, then add the people who answer for it.",
    rosterManage: "Edit teams",
    membersManage: "Edit team members",
    presenceManage: "Edit agent presence",
    colMembers: "Members",
    colAvailable: "Available",
    colHeadroom: "Free capacity",
    channelsTitle: "Channels",
    channelsIntro: "The connectors that carry conversations in and out.",
    channelsCaption: "Channel connectors",
    channelsEmpty: "No channel connector is configured.",
    "channelsEmpty.body": "Connect a channel — email, WhatsApp, web — so customers have somewhere to reach you.",
    channelsManage: "Edit channels",
    slaTitle: "Service targets",
    slaIntro: "The reply and resolution clocks conversations are measured against.",
    slaCaption: "SLA policies",
    slaEmpty: "No SLA policy yet.",
    "slaEmpty.body": "Set a policy to hold replies to a response time and see breaches before they happen.",
    slaManage: "Edit SLA policies",
    colFrt: "First reply",
    colResolution: "Resolution",
    minutes: "{count} min"
  },
  ar: {
    title: "إدارة Conversations",
    intro: "اقرأ القنوات والفرق وقواعد التوجيه معًا، ثم عالِج ما هو معطّل.",
    headlineFaults: "{n} أمور معطّلة",
    headlineOk: "{channels} قناة حيّة، {teams} فريق نشط، لا شيء معطّل",
    fixStranded: "أصلح قواعد التوجيه",
    deniedTitle: "لا يمكنك قراءة إعدادات إدارة Conversations",
    reachTitle: "الوصول",
    reachIntro: "هل تجد المحادثة الواردة قناة حيّة تصل عبرها وشخصًا تصل إليه.",
    statChannels: "قنوات حيّة",
    statTeams: "فرق مفعّلة",
    statAvailable: "وكلاء متاحون",
    statHeadroom: "طاقة متاحة",
    faultsTitle: "لا شيء معطّل.",
    faultsBody: "كل قاعدة مفعّلة تشير إلى فريق مزوّد بأعضاء، ولكل ناقل موصل حيّ.",
    "fault.noDefault": "لا يوجد فريق افتراضي، فما لا تطابقه أي قاعدة لا يجد وجهة.",
    "fault.manyDefaults": "أكثر من فريق مُعلَّم كافتراضي، والتوجيه يختار أحدها اعتباطًا.",
    "fault.ruleUnknownTeam": "قاعدة توجيه تشير إلى فريق لم يعد موجودًا.",
    "fault.ruleEmptyTeam": "قاعدة توجيه تشير إلى فريق بلا أعضاء.",
    "fault.noConnector": "لا يوجد موصل مفعّل يحمل هذا الناقل.",
    routingTitle: "ترتيب التوجيه",
    routingIntro: "اقرأ من الأعلى إلى الأسفل؛ تفوز أول قاعدة تتطابق شروطها.",
    routingCaption: "قواعد التوجيه بالترتيب",
    routingEmpty: "لا توجد قاعدة توجيه بعد، فكل شيء يؤول إلى الفريق الافتراضي.",
    "routingEmpty.body": "أضف قاعدة لتوجيه المحادثة إلى الفريق الذي يجب أن يتولاها.",
    routingManage: "تحرير قواعد التوجيه",
    colSeq: "الترتيب",
    colTeam: "الفريق",
    colConditions: "يطابق",
    colEnabled: "مفعّل",
    condAny: "أي شيء",
    sentimentBelow: "المشاعر دون",
    rosterTitle: "الملاك",
    rosterIntro: "من في كل فريق، وكم يمكنهم استيعابه الآن.",
    rosterCaption: "الفرق وتغطيتها",
    rosterEmpty: "لا يوجد فريق بعد.",
    "rosterEmpty.body": "أنشئ فريقاً، ثم أضف من يجيب باسمه.",
    rosterManage: "تحرير الفرق",
    membersManage: "تحرير أعضاء الفريق",
    presenceManage: "تحرير حضور الوكلاء",
    colMembers: "الأعضاء",
    colAvailable: "المتاحون",
    colHeadroom: "الطاقة المتاحة",
    channelsTitle: "القنوات",
    channelsIntro: "الموصلات التي تحمل المحادثات دخولًا وخروجًا.",
    channelsCaption: "موصلات القنوات",
    channelsEmpty: "لا يوجد موصل قناة مهيّأ.",
    "channelsEmpty.body": "اربط قناة — بريد أو واتساب أو الويب — ليجد العملاء وسيلة للوصول إليك.",
    channelsManage: "تحرير القنوات",
    slaTitle: "أهداف الخدمة",
    slaIntro: "ساعات الرد والإغلاق التي تُقاس بها المحادثات.",
    slaCaption: "سياسات مستوى الخدمة",
    slaEmpty: "لا توجد سياسة مستوى خدمة بعد.",
    "slaEmpty.body": "حدّد سياسة لضبط زمن الرد وترى التجاوزات قبل وقوعها.",
    slaManage: "تحرير سياسات مستوى الخدمة",
    colFrt: "أول رد",
    colResolution: "الإغلاق",
    minutes: "{count} دقيقة"
  }
};

export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    teams: held.has(PERM.teams),
    channels: held.has(PERM.channels),
    presence: held.has(PERM.presence)
  };
  const none = { data: [] };
  const read = async <T,>(path: string, allowed: boolean): Promise<Page<T>> =>
    allowed ? safe(() => api<Page<T>>(path, { env, request }), none as Page<T>) : (none as Page<T>);

  const [connectors, teams, members, presence, rules, slas] = await Promise.all([
    read<ConnectorRow>("/v1/orbit/channel-connectors?limit=100", may.channels),
    read<TeamRow>("/v1/orbit/teams?limit=100", may.teams),
    read<MemberRow>("/v1/orbit/team-members?limit=200", may.teams),
    read<PresenceRow>("/v1/orbit/agent-presence?limit=200", may.presence),
    read<RuleRow>("/v1/orbit/routing-rules?limit=100&sort=seq&order=asc", may.teams),
    read<SlaRow>("/v1/orbit/sla-policies?limit=100", may.teams)
  ]);

  const teamRows = rowsOf(teams);
  const connectorRows = rowsOf(connectors);
  const ruleRows = rowsOf(rules);
  const coverage = coverageOf(teamRows, rowsOf(members), rowsOf(presence));

  return {
    may,
    connectors: connectorRows,
    teams: teamRows,
    rules: ruleRows,
    slas: rowsOf(slas),
    coverage,
    // ponytail: the faults are derived server-side so the whole read stays one
    // pass. They are pure over what is already returned, so the tests can call
    // faultsOf directly rather than through the loader.
    faults: faultsOf({ connectors: connectorRows, teams: teamRows, rules: ruleRows, coverage })
  };
}

/* --------------------------------------------------------------- component */

function toneFor(row: Coverage): BadgeTone {
  if (row.members === 0) return "danger";
  if (row.available === 0) return "warning";
  return "success";
}

export default function OrbitAdmin() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useOrbitSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  // The nouns ORBIT already spells (channel, intent, transport, status) come
  // from the module catalogue, so a domain pack renames them here too.
  const words = labelsFor(orbit, locale, shell?.domainPack);

  if (!loaded.may.teams && !loaded.may.channels) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const named = new Map(loaded.teams.map((team) => [team.id, nameOf(team.nameJson, locale, team.key)]));
  const covered = new Map(loaded.coverage.map((row) => [row.teamId, row]));
  const minutes = (count: number) => l("minutes", { count: String(count) });

  /** `{channel, intent, sentimentBelow}` as words; an empty object matches everything. */
  const conditions = (value: unknown): string => {
    const bag = parsed(value);
    if (!bag) return l("condAny");
    const entries = Object.entries(bag).filter(([, v]) => v !== null && v !== "" && v !== undefined);
    if (entries.length === 0) return l("condAny");
    return entries
      .map(([key, v]) =>
        key === "sentimentBelow"
          ? `${l("sentimentBelow")} ${String(v)}`
          : `${words(key)}: ${optionLabel(words, key, String(v))}`
      )
      .join(" · ");
  };

  const ruleColumns: Array<Column<RuleRow>> = [
    { key: "seq", header: l("colSeq"), numeric: true, render: (row) => row.seq },
    {
      key: "teamId",
      header: l("colTeam"),
      render: (row) => {
        const team = covered.get(row.teamId);
        return (
          <span className="flex items-center gap-2">
            {named.get(row.teamId) ?? row.teamId}
            {team ? (
              <Badge tone={toneFor(team)} size="sm" dot>
                {String(team.available)}
              </Badge>
            ) : null}
          </span>
        );
      }
    },
    { key: "conditionsJson", header: l("colConditions"), render: (row) => conditions(row.conditionsJson) },
    {
      key: "enabled",
      header: l("colEnabled"),
      render: (row) => t(truthy(row.enabled) ? "common.yes" : "common.no")
    }
  ];

  const coverageColumns: Array<Column<Coverage>> = [
    {
      key: "key",
      header: l("colTeam"),
      render: (row) => (
        <span className="flex items-center gap-2">
          {named.get(row.teamId) ?? row.key}
          {row.isDefault ? (
            <Badge tone="info" size="sm">
              {words("isDefault")}
            </Badge>
          ) : null}
        </span>
      )
    },
    { key: "members", header: l("colMembers"), numeric: true, render: (row) => row.members },
    {
      key: "available",
      header: l("colAvailable"),
      numeric: true,
      render: (row) => (
        <Badge tone={toneFor(row)} size="sm">
          {row.available}
        </Badge>
      )
    },
    { key: "headroom", header: l("colHeadroom"), numeric: true, render: (row) => row.headroom }
  ];

  const connectorColumns: Array<Column<ConnectorRow>> = [
    { key: "label", header: words("label"), render: (row) => row.label },
    { key: "provider", header: words("provider"), render: (row) => optionLabel(words, "provider", row.provider) },
    { key: "transport", header: words("transport"), render: (row) => optionLabel(words, "transport", row.transport) },
    {
      key: "status",
      header: words("status"),
      render: (row) => (
        <Badge tone={row.status === "active" ? "success" : "neutral"} size="sm" dot>
          {tag(words, "status", row.status)}
        </Badge>
      )
    }
  ];

  const slaColumns: Array<Column<SlaRow>> = [
    { key: "key", header: words("key"), render: (row) => <span className="font-mono text-12">{row.key}</span> },
    { key: "frtMinutes", header: l("colFrt"), numeric: true, render: (row) => minutes(row.frtMinutes) },
    { key: "resolutionMinutes", header: l("colResolution"), numeric: true, render: (row) => minutes(row.resolutionMinutes) }
  ];

  const liveChannels = loaded.connectors.filter((row) => row.status === "active").length;
  const activeTeams = loaded.teams.filter((row) => row.status === "active").length;
  const available = loaded.coverage.reduce((total, row) => total + row.available, 0);
  const headroom = loaded.coverage.reduce((total, row) => total + row.headroom, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={l("title")}
        title={adminHeadline(loaded.faults.length, liveChannels, activeTeams, l)}
        description={l("intro")}
        meta={
          loaded.faults.length > 0 && loaded.may.teams ? (
            <Link to="/orbit/routing-rules" className="w-fit font-ui text-13 text-accent underline underline-offset-2">
              {l("fixStranded")}
            </Link>
          ) : null
        }
      />

      <Card title={l("reachTitle")} description={l("reachIntro")}>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label={l("statChannels")} value={String(liveChannels)} />
            <Stat label={l("statTeams")} value={String(activeTeams)} />
            <Stat label={l("statAvailable")} value={String(available)} />
            <Stat label={l("statHeadroom")} value={String(headroom)} />
          </div>
          {loaded.faults.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("faultsBody")}</p>
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
        </div>
      </Card>

      {loaded.may.teams ? (
        <Card title={l("routingTitle")} description={l("routingIntro")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("routingCaption")}
              columns={ruleColumns}
              rows={loaded.rules}
              rowKey={(row) => row.id}
              rowState={(row) => (truthy(row.enabled) ? undefined : "sealed")}
              empty={<EmptyState title={l("routingEmpty")} body={l("routingEmpty.body")} />}
            />
            <Link to="/orbit/routing-rules" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("routingManage")}
            </Link>
          </div>
        </Card>
      ) : null}

      {loaded.may.teams ? (
        <Card title={l("rosterTitle")} description={l("rosterIntro")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("rosterCaption")}
              columns={coverageColumns}
              rows={loaded.coverage}
              rowKey={(row) => row.teamId}
              empty={<EmptyState title={l("rosterEmpty")} body={l("rosterEmpty.body")} />}
            />
            <div className="flex flex-wrap gap-4">
              <Link to="/orbit/teams" className="font-ui text-13 text-accent underline underline-offset-2">
                {l("rosterManage")}
              </Link>
              <Link to="/orbit/team-members" className="font-ui text-13 text-accent underline underline-offset-2">
                {l("membersManage")}
              </Link>
              {loaded.may.presence ? (
                <Link to="/orbit/agent-presence" className="font-ui text-13 text-accent underline underline-offset-2">
                  {l("presenceManage")}
                </Link>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {loaded.may.channels ? (
        <Card title={l("channelsTitle")} description={l("channelsIntro")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("channelsCaption")}
              columns={connectorColumns}
              rows={loaded.connectors}
              rowKey={(row) => row.id}
              rowState={(row) => (row.status === "active" ? undefined : "sealed")}
              empty={<EmptyState title={l("channelsEmpty")} body={l("channelsEmpty.body")} />}
            />
            <Link to="/orbit/channel-connectors" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("channelsManage")}
            </Link>
          </div>
        </Card>
      ) : null}

      {loaded.may.teams ? (
        <Card title={l("slaTitle")} description={l("slaIntro")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("slaCaption")}
              columns={slaColumns}
              rows={loaded.slas}
              rowKey={(row) => row.id}
              empty={<EmptyState title={l("slaEmpty")} body={l("slaEmpty.body")} />}
            />
            <Link to="/orbit/sla-policies" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("slaManage")}
            </Link>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
