import { useState } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AGENT_MARK,
  AgentBadge,
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  GuardrailNotice,
  Checkbox,
  Input,
  Money,
  MoneyField,
  Select,
  Stat,
  Table,
  Textarea,
  POST_RATIOS,
  postCardSvg,
  type BadgeTone,
  type Column,
  type PostRatio
} from "@lyra/ui";
import { ApiError, api, directory } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useSignalSessionData } from "./signal-shell";
import {
  PERM,
  briefFromOpportunity,
  budgetOf,
  canLaunch,
  SIGNAL_CHANNELS,
  channelLabel,
  channelsOf,
  explain,
  labelsIn,
  mintKey,
  nextStates,
  planOf,
  poolOf,
  probabilityTone,
  rollByChannel,
  safe,
  splitCopy,
  studioHeadline,
  totalSpendMinor,
  type AudienceRow,
  type CampaignRow,
  type ChannelRoll,
  type CreativeRow,
  type OpportunityRow,
  type Page,
  type Problemish,
  type SpendRow,
  type TouchRow
} from "./signal.shared";

// The campaign studio: goal → drafted content → review → launch → watch it run,
// on one screen. The generic campaigns tab can create a row, but it cannot write
// the words, and the creatives tab can hold the words but not connect them to a
// launch — so the thing a marketer actually does had no home.
//
// Every model call here is `POST /v1/signal/creatives/generate`
// (apps/api/src/routes/signal.ts), which runs through packages/model-gateway and
// returns the `ai_audit_log` id of each variant. Nothing on this screen sends
// anything: generation writes drafts, clearing a draft is a compliance verdict,
// and going live is a state change the API routes through the
// `signal.campaign_launch` approval.
//
// Progress lives in the URL (`?campaignId=…`), not in component state: a
// generate is a POST that redirects, so a refresh re-reads the drafts instead of
// asking the model for a second set.

/* ------------------------------------------------------------------ constants */

export const OBJECTIVES = ["acq", "renewal", "xsell"] as const;
/** `GenerateBody.kind`, apps/api/src/routes/signal.ts. No other value is accepted. */
export const KINDS = ["ad", "lp", "email", "social", "video_script"] as const;
export const CONTENT_LOCALES = ["en", "ar"] as const;
/** The generate handler caps `count` at 100; a review screen caps itself lower. */
export const MAX_VARIANTS = 8;

const DRAFT_STATES = ["draft", "review", "scheduled"];
const LIVE_STATES = ["live", "paused"];

/* -------------------------------------------------------------------- loader */

const empty = <T,>(): Page<T> => ({ data: [] });

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaignId") ?? "";
  const generated = Number(url.searchParams.get("generated") ?? "");
  const generatedImage = url.searchParams.get("generatedImage") === "1";
  // Arrived from SCOUT's whitespace screen: the brief opens with the finding
  // rather than blank. A dead id is not an error — the screen still works.
  const opportunityId = url.searchParams.get("opportunityId") ?? "";

  const [recent, audiences] = await Promise.all([
    safe(
      () =>
        api<Page<CampaignRow>>("/v1/signal/campaigns?limit=25&sort=createdAt&order=desc", {
          env,
          request
        }),
      empty<CampaignRow>()
    ),
    safe(() => api<Page<AudienceRow>>("/v1/signal/audiences?limit=50", { env, request }), empty<AudienceRow>())
  ]);

  const [campaign, opportunity] = await Promise.all([
    campaignId
      ? safe(() => api<CampaignRow>(`/v1/signal/campaigns/${campaignId}`, { env, request }), null)
      : Promise.resolve(null),
    opportunityId
      ? safe(() => api<OpportunityRow>(`/v1/scout/whitespaces/${opportunityId}`, { env, request }), null)
      : Promise.resolve(null)
  ]);

  const scope = campaign ? `?campaignId=${encodeURIComponent(campaign.id)}&limit=100` : "";
  const [creatives, spend, touches] = await Promise.all([
    campaign
      ? safe(() => api<Page<CreativeRow>>(`/v1/signal/creatives${scope}`, { env, request }), empty<CreativeRow>())
      : Promise.resolve(empty<CreativeRow>()),
    campaign
      ? safe(() => api<Page<SpendRow>>(`/v1/signal/spend${scope}`, { env, request }), empty<SpendRow>())
      : Promise.resolve(empty<SpendRow>()),
    campaign
      ? safe(
          () => api<Page<TouchRow>>(`/v1/signal/attribution-events${scope}`, { env, request }),
          empty<TouchRow>()
        )
      : Promise.resolve(empty<TouchRow>())
  ]);

  // The owner field defaulted to the signed-in person's *display name*, so a
  // campaign was owned by the string "Noor Haddad" and by nothing resolvable.
  // The picker submits a real ref (ADR-0047).
  const assignees = await directory({ env, request });

  return {
    campaign,
    opportunity,
    assignees,
    generated: Number.isFinite(generated) && generated > 0 ? generated : 0,
    generatedImage,
    audiences: audiences.data,
    drafts: recent.data.filter((row) => DRAFT_STATES.includes(row.state)),
    creatives: creatives.data,
    spend: spend.data,
    touches: touches.data,
    // One key per load: a double-submitted launch is one launch (docs/19 §4).
    key: mintKey("signal-studio")
  };
}

/* -------------------------------------------------------------------- action */

export interface ActionResult {
  problem: Problemish | null;
  /** The intent that succeeded, so the screen can say which one. */
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
  const key = text(form, "key") || mintKey("signal-studio");
  const headers = { "idempotency-key": key };

  try {
    switch (intent) {
      case "create-campaign": {
        const name = text(form, "name");
        if (!name) return refuse("name_required");
        const objective = text(form, "objective");
        if (!OBJECTIVES.some((allowed) => allowed === objective)) return refuse("objective_required");
        const owner = text(form, "ownerRef");
        if (!owner) return refuse("owner_required");
        // One entry per ticked box; comma-splitting survives for anything
        // posting the old free-text field.
        const channels = form
          .getAll("channels")
          .flatMap((entry) => String(entry).split(","))
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (channels.length === 0) return refuse("channels_required");
        const dailyMinor = positive(form, "dailyMinor");
        if (dailyMinor === null) return refuse("budget_required");
        const bound = positive(form, "boundMinor");

        const created = await api<CampaignRow>("/v1/signal/campaigns", {
          env,
          request,
          method: "POST",
          headers,
          body: {
            name,
            objective,
            ownerRef: owner,
            ...(text(form, "audienceId") ? { audienceId: text(form, "audienceId") } : {}),
            channelsJson: channels,
            budgetJson: {
              dailyMinor,
              currency: text(form, "currency") || "ZAR",
              // The autopilot's per-decision ceiling. Named here rather than
              // left to the engine default so the bound is the operator's.
              ...(bound === null ? {} : { autopilotBoundMinor: bound })
            }
          }
        });
        // A redirect, not a result: the next read is a GET, so a refresh cannot
        // create a second campaign. The opportunity rides along so a marketer who
        // came from SCOUT still gets the finding in the brief on the next screen.
        const from = text(form, "opportunityId");
        throw redirect(
          `/signal/studio?campaignId=${encodeURIComponent(created.id)}` +
            (from ? `&opportunityId=${encodeURIComponent(from)}` : "")
        );
      }

      case "generate": {
        const campaignId = text(form, "campaignId");
        if (!campaignId) return refuse("campaign_required");
        const brief = text(form, "brief");
        if (brief.length < 10) return refuse("brief_required");
        const kind = text(form, "kind");
        if (!KINDS.some((allowed) => allowed === kind)) return refuse("kind_required");
        const count = positive(form, "count") ?? 3;
        const locales = form
          .getAll("locales")
          .map((entry) => String(entry))
          .filter((entry) => CONTENT_LOCALES.some((allowed) => allowed === entry));

        const result = await api<{ variants: unknown[] }>("/v1/signal/creatives/generate", {
          env,
          request,
          method: "POST",
          headers,
          body: {
            campaignId,
            kind,
            brief,
            count: Math.min(count, MAX_VARIANTS),
            ...(locales.length > 0 ? { locales } : {})
          }
        });
        throw redirect(
          `/signal/studio?campaignId=${encodeURIComponent(campaignId)}&generated=${result.variants.length}`
        );
      }

      case "plan": {
        const campaignId = text(form, "campaignId");
        if (!campaignId) return refuse("campaign_required");
        const subject = text(form, "subject");
        if (subject.length < 3) return refuse("subject_required");

        await api<{ plan: unknown }>(`/v1/signal/campaigns/${encodeURIComponent(campaignId)}/plan`, {
          env,
          request,
          method: "POST",
          headers,
          body: { subject }
        });
        // A redirect, so a refresh re-reads the plan rather than arguing a
        // second one at the same campaign.
        throw redirect(`/signal/studio?campaignId=${encodeURIComponent(campaignId)}&planned=1`);
      }

      case "generate-image": {
        const campaignId = text(form, "campaignId");
        if (!campaignId) return refuse("campaign_required");
        const prompt = text(form, "prompt");
        if (prompt.length < 10) return refuse("brief_required");

        await api<{ id: string }>("/v1/signal/creatives/image", {
          env,
          request,
          method: "POST",
          headers,
          body: { campaignId, prompt }
        });
        throw redirect(`/signal/studio?campaignId=${encodeURIComponent(campaignId)}&generatedImage=1`);
      }

      case "edit-variant": {
        const id = text(form, "creativeId");
        if (!id) return refuse("creative_required");
        const contentRef = text(form, "contentRef");
        if (!contentRef) return refuse("content_required");
        await api(`/v1/signal/creatives/${id}`, {
          env,
          request,
          method: "PATCH",
          headers,
          body: { contentRef }
        });
        return { problem: null, done: intent };
      }

      // Clearing and discarding are the same write with opposite verdicts, and
      // both carry `signal.creative_publish` on the API side.
      case "clear-variant":
      case "discard-variant": {
        const id = text(form, "creativeId");
        if (!id) return refuse("creative_required");
        await api(`/v1/signal/creatives/${id}`, {
          env,
          request,
          method: "PATCH",
          headers,
          body: { complianceStatus: intent === "clear-variant" ? "passed" : "blocked" }
        });
        return { problem: null, done: intent };
      }

      // Consequential (CLAUDE.md §4): the API gates this on
      // `signal.campaign_launch`, and a 403 `approval_required` is the honest
      // answer, not a failure to hide.
      case "launch":
      case "pause": {
        const id = text(form, "campaignId");
        if (!id) return refuse("campaign_required");
        const state = intent === "launch" ? "live" : "paused";
        await api(`/v1/signal/campaigns/${id}`, {
          env,
          request,
          method: "PATCH",
          headers,
          body: { state }
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

/* ---------------------------------------------------------------- rendering */

function toneOf(status: string): BadgeTone {
  if (status === "passed") return "success";
  if (status === "blocked") return "danger";
  if (status === "flagged") return "warning";
  return "neutral";
}

/**
 * The variant as the thing a marketer actually posts.
 *
 * The studio wrote the words and stopped there, so "social" copy lived as a
 * paragraph in a form field and someone rebuilt the post by hand in another
 * tool. The preview and the download are the same SVG bytes
 * (packages/ui/src/post-card.ts), so what is on screen is what lands on disk.
 * ponytail: SVG, not PNG — the browser rasterises it and nothing new ships.
 */
function PostArt({
  copy,
  kicker,
  contentLocale,
  brand,
  l
}: {
  copy: string;
  kicker: string;
  contentLocale: string;
  brand?: { name?: string; palette?: { accent?: string; accentContrast?: string } } | null | undefined;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const [ratio, setRatio] = useState<PostRatio>("square");
  const { headline, body } = splitCopy(copy);
  const svg = postCardSvg({
    headline,
    body,
    kicker,
    brandName: brand?.name ?? "",
    accent: brand?.palette?.accent,
    accentContrast: brand?.palette?.accentContrast,
    locale: contentLocale,
    ratio
  });
  const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const box = POST_RATIOS[ratio];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="eyebrow">
        {l("studio.art")}
      </figcaption>
      <img
        src={href}
        width={box.w}
        height={box.h}
        alt={l("studio.artHint")}
        className="w-full max-w-[260px] rounded-lg border border-border"
      />
      <div className="flex items-center gap-2">
        <Select
          value={ratio}
          onValueChange={(next) => setRatio(next as PostRatio)}
          size="sm"
          aria-label={l("studio.art")}
          options={[
            { value: "square", label: l("studio.square") },
            { value: "portrait", label: l("studio.portrait") },
            { value: "story", label: l("studio.story") }
          ]}
        />
        <a
          href={href}
          download={`${(brand?.name ?? "post").toLowerCase().replace(/\W+/g, "-")}-${ratio}.svg`}
          className="font-ui text-12 text-accent underline-offset-2 hover:underline"
        >
          {l("studio.download")}
        </a>
      </div>
    </figure>
  );
}

export default function CampaignStudio() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useSignalSessionData();
  const navigation = useNavigation();
  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const may = new Set(shell?.permissions ?? []);
  const locale = shell?.locale ?? "en";
  const busy = navigation.state !== "idle";

  const campaign = loaded.campaign;
  const budget = campaign ? budgetOf(campaign) : {};
  const plan = campaign ? planOf(campaign) : null;
  // The pool the plan was argued at, if the model proposed it. A hand-picked
  // audience has no reasons and renders nothing.
  const audience = campaign?.audienceId
    ? loaded.audiences.find((row) => row.id === campaign.audienceId)
    : undefined;
  const pool = audience ? poolOf(audience) : null;
  const currency = budget.currency ?? "ZAR";
  const mine = loaded.creatives;
  const cleared = mine.filter((creative) => creative.complianceStatus === "passed");
  const live = campaign ? LIVE_STATES.includes(campaign.state) : false;
  const rolls = rollByChannel(loaded.spend, loaded.touches);

  const step = !campaign ? 1 : mine.length === 0 ? 2 : live ? 5 : cleared.length === 0 ? 3 : 4;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{studioHeadline(l, campaign, step)}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("studio.lede")}</p>
      </header>

      <ol className="flex flex-wrap items-center gap-2 font-ui text-12">
        {[
          ["studio.step1", 1],
          ["studio.step2", 2],
          ["studio.step3", 3],
          ["studio.step4", 4],
          ["studio.step5", 5]
        ].map(([labelKey, at]) => (
          <li key={String(labelKey)}>
            <Badge tone={step === at ? "accent" : step > Number(at) ? "success" : "neutral"}>
              {l(String(labelKey))}
            </Badge>
          </li>
        ))}
      </ol>

      {result?.problem ? <Gate problem={explain(result.problem, l)} l={l} /> : null}
      {loaded.generated > 0 ? (
        <p className="font-ui text-13 text-success">
          {AGENT_MARK} {l("studio.generated", { n: String(loaded.generated) })}
        </p>
      ) : null}
      {loaded.generatedImage ? (
        <p className="font-ui text-13 text-success">
          {AGENT_MARK} {l("studio.imageGenerated")}
        </p>
      ) : null}
      {result?.done === "launch" ? (
        <p className="font-ui text-13 text-success">{l("studio.launched")}</p>
      ) : null}

      {campaign ? null : (
        <Card title={l("studio.step1")} description={l("studio.created")}>
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="create-campaign" />
            <input type="hidden" name="key" value={loaded.key} />
            {loaded.opportunity ? (
              <input type="hidden" name="opportunityId" value={loaded.opportunity.id} />
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={l("studio.name")} required>
                <Input name="name" required maxLength={120} />
              </Field>
              <Field label={l("studio.objective")} required>
                <Select
                  name="objective"
                  defaultValue="acq"
                  options={OBJECTIVES.map((value) => ({ value, label: l(value) }))}
                />
              </Field>
              <Field label={l("audience")} hint={l("studio.audienceHint")}>
                <Select
                  name="audienceId"
                  placeholder={l("studio.audienceAll")}
                  options={loaded.audiences.map((audience) => ({
                    value: audience.id,
                    label: audience.name
                  }))}
                />
              </Field>
              <Field label={l("studio.channels")} required hint={l("studio.channelsHint")}>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {SIGNAL_CHANNELS.map((channel) => (
                    <Checkbox
                      key={channel.slug}
                      name="channels"
                      value={channel.slug}
                      label={channelLabel(channel.slug, locale)}
                      defaultChecked={channel.slug === "google_search" || channel.slug === "meta"}
                    />
                  ))}
                </div>
              </Field>
              <Field label={l("studio.daily")} required>
                <MoneyField name="dailyMinor" currency={currency} locale={locale} required defaultMinor={50000} />
              </Field>
              <Field label={l("bound")} hint={l("studio.boundHint")}>
                <MoneyField name="boundMinor" currency={currency} locale={locale} defaultMinor={10000} />
              </Field>
              <Field label={l("studio.owner")} required>
                <Select
                  name="ownerRef"
                  placeholder={l("studio.ownerPick")}
                  options={loaded.assignees.map((one) => ({ value: one.ref, label: one.name }))}
                />
              </Field>
            </div>
            <input type="hidden" name="currency" value={currency} />
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={busy || !may.has(PERM.campaignsCreate)}>
                {l("studio.create")}
              </Button>
              {may.has(PERM.campaignsCreate) ? null : (
                <span className="font-ui text-12 text-subtle">{l("noPermission")}</span>
              )}
            </div>
          </Form>

          {loaded.drafts.length > 0 ? (
            <div className="mt-6 border-t border-border pt-4">
              <h2 className="eyebrow mb-2">
                {l("studio.pickCampaign")}
              </h2>
              <ul className="flex flex-col divide-y divide-border border-y border-border">
                {loaded.drafts.map((draft) => (
                  <li key={draft.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-ui text-13 text-text">{draft.name}</span>
                    <span className="flex items-center gap-3">
                      <Badge tone="neutral">{l(draft.state)}</Badge>
                      <Link
                        to={`/signal/studio?campaignId=${encodeURIComponent(draft.id)}`}
                        aria-label={`${l("studio.open")}: ${draft.name}`}
                        className="font-ui text-12 text-accent underline-offset-2 hover:underline"
                      >
                        {l("studio.open")}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      )}

      {campaign ? (
        <>
          <Card
            title={campaign.name}
            description={`${l(campaign.objective)} · ${l(campaign.state)}`}
            actions={
              <Link
                to="/signal/studio"
                className="font-ui text-12 text-accent underline-offset-2 hover:underline"
              >
                {l("studio.newCampaign")}
              </Link>
            }
          >
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label={l("budget.daily")}
                value={<Money amountMinor={budget.dailyMinor ?? 0} currency={currency} locale={locale} />}
              />
              <Stat
                label={l("bound")}
                value={
                  <Money amountMinor={budget.autopilotBoundMinor ?? 0} currency={currency} locale={locale} />
                }
              />
              <Stat label={l("autonomy")} value={l(`autonomy.${campaign.autonomyLevel}`)} />
              <Stat label={l("studio.channels")} value={channelsOf(campaign).map((slug) => channelLabel(slug, locale)).join(" · ") || "—"} />
            </dl>
          </Card>

          {pool ? (
            <Card
              title={l("studio.pool")}
              description={l("studio.poolReach", { n: pool.estimatedReach.toLocaleString(locale) })}
              actions={<AgentBadge why={pool.summary} />}
            >
              <p className="font-ui text-13 leading-relaxed text-muted">{pool.summary}</p>
              <ul className="mt-4 flex flex-col gap-2">
                {pool.reasons.map((band) => (
                  <li
                    key={`${band.axis}:${band.value}`}
                    className="flex flex-col gap-1 rounded-lg border border-border p-3 sm:flex-row sm:items-baseline sm:gap-3"
                  >
                    {/* ponytail: axis slug rendered raw. A label table here would
                        re-hard-code the very vocabulary the targeting axes are
                        meant to read from the tenant's own book. */}
                    <Badge tone="neutral">
                      {band.axis} {band.value}
                    </Badge>
                    <span className="font-ui text-13 text-muted">{band.reason}</span>
                    {band.count > 0 ? (
                      <span className="font-ui text-12 text-subtle sm:ms-auto">
                        {band.count.toLocaleString(locale)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 font-ui text-12 text-subtle">{l("studio.poolWhy")}</p>
            </Card>
          ) : null}

          {plan ? null : (
            <Card title={l("studio.planNone")} description={l("studio.planNoneHint")}>
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="plan" />
                <input type="hidden" name="key" value={loaded.key} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <Field label={l("studio.planSubject")} hint={l("studio.planSubjectHint")} required>
                  <Input name="subject" required minLength={3} maxLength={200} defaultValue={campaign.name} />
                </Field>
                <div className="flex items-center gap-3">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? l("studio.planning") : `${AGENT_MARK} ${l("studio.planAction")}`}
                  </Button>
                  <EvidenceLink source="/docs/15-ai-ux-patterns.md" sourceLabel={l("why")}>
                    {l("studio.planHint")}
                  </EvidenceLink>
                </div>
              </Form>
            </Card>
          )}

          {plan ? (
            <Card
              title={l("studio.plan")}
              description={l("studio.planHint")}
              actions={<AgentBadge why={plan.notes} />}
            >
              <p className="font-ui text-13 leading-relaxed text-muted">{plan.notes}</p>
              <ul className="mt-4 flex flex-col gap-3">
                {plan.options.map((option) => (
                  <li
                    key={option.name}
                    className={`flex flex-col gap-2 rounded-lg border p-4 ${
                      option.name === plan.recommended ? "border-accent bg-accent/5" : "border-border"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-ui text-14 font-medium text-text">{option.name}</h3>
                      {option.name === plan.recommended ? (
                        <Badge tone="accent">{l("studio.planRecommended")}</Badge>
                      ) : null}
                      <Badge tone={probabilityTone(option.probability)} dot>
                        {`${option.probability.toLocaleString(locale)}%`}
                      </Badge>
                      <span className="ms-auto font-ui text-12 text-subtle">
                        {option.channels.map((slug) => channelLabel(slug, locale)).join(" · ")}
                      </span>
                    </div>
                    <p className="font-ui text-13 text-muted">{option.angle}</p>
                    {option.offer ? (
                      <p className="font-ui text-13 text-text">
                        <span className="text-subtle">{l("studio.planOffer")}: </span>
                        {option.offer}
                      </p>
                    ) : null}
                    {option.why.length ? (
                      <ul className="flex list-disc flex-col gap-1 ps-5 font-ui text-12 text-muted">
                        {option.why.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                    {option.risk ? (
                      <p className="font-ui text-12 text-subtle">
                        {l("studio.planRisk")}: {option.risk}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 font-ui text-12 text-subtle">
                {plan.confidence > 0
                  ? l("studio.planConfidence", { n: String(plan.confidence) })
                  : l("studio.planFallback")}
              </p>
            </Card>
          ) : null}

          {may.has(PERM.creativesGenerate) ? (
            <Card
              title={l("studio.brief")}
              description={
                loaded.opportunity ? l("studio.fromOpportunity") : l("studio.briefHint")
              }
            >
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="generate" />
                <input type="hidden" name="key" value={loaded.key} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <Field label={l("studio.brief")} labelHidden required>
                  <Textarea
                    name="brief"
                    rows={loaded.opportunity ? 6 : 4}
                    required
                    minLength={10}
                    maxLength={4000}
                    defaultValue={
                      loaded.opportunity ? briefFromOpportunity(loaded.opportunity, l) : undefined
                    }
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={l("studio.kind")} required>
                    <Select
                      name="kind"
                      defaultValue="ad"
                      options={KINDS.map((value) => ({ value, label: l(value) }))}
                    />
                  </Field>
                  <Field label={l("studio.count")}>
                    <Input name="count" type="number" min={1} max={MAX_VARIANTS} defaultValue={3} />
                  </Field>
                  <Field label={l("studio.locales")}>
                    <span className="flex items-center gap-3 pt-2">
                      {CONTENT_LOCALES.map((value) => (
                        <label key={value} className="flex items-center gap-2 font-ui text-13 text-muted">
                          <input
                            type="checkbox"
                            name="locales"
                            value={value}
                            defaultChecked={value === "en"}
                            className="size-4 accent-accent"
                          />
                          {l(`locale.${value}`)}
                        </label>
                      ))}
                    </span>
                  </Field>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? l("studio.generating") : `${AGENT_MARK} ${l("studio.generate")}`}
                  </Button>
                  <EvidenceLink source="/docs/15-ai-ux-patterns.md" sourceLabel={l("why")}>
                    {l("studio.whyDraft")}
                  </EvidenceLink>
                </div>
              </Form>
            </Card>
          ) : null}

          {may.has(PERM.creativesGenerate) ? (
            <Card title={l("studio.image")} description={l("studio.imageHint")}>
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="generate-image" />
                <input type="hidden" name="key" value={loaded.key} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <Field label={l("studio.imagePrompt")} labelHidden required>
                  <Textarea name="prompt" rows={3} required minLength={10} maxLength={2000} />
                </Field>
                <div className="flex items-center gap-3">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? l("studio.imageGenerating") : `${AGENT_MARK} ${l("studio.imageGenerate")}`}
                  </Button>
                  <EvidenceLink source="/docs/15-ai-ux-patterns.md" sourceLabel={l("why")}>
                    {l("studio.whyDraft")}
                  </EvidenceLink>
                </div>
              </Form>
            </Card>
          ) : null}

          <Card title={l("studio.variants")} description={l("studio.whyDraft")}>
            {mine.length === 0 ? (
              <EmptyState title={l("studio.noVariants")} body={l("studio.noVariants.body")} />
            ) : (
              <ul className="flex flex-col divide-y divide-border border-y border-border">
                {mine.map((creative) => (
                  <li key={creative.id} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={toneOf(creative.complianceStatus)} dot>
                        {l(creative.complianceStatus)}
                      </Badge>
                      <Badge tone="neutral">{l(creative.kind)}</Badge>
                      <Badge tone="neutral">{l(`locale.${creative.locale}`)}</Badge>
                      {creative.generatedBy === "ai" ? (
                        <AgentBadge why={l("studio.whyDraft")} />
                      ) : null}
                      <span className="ms-auto font-mono text-12 text-subtle">
                        <DateTime value={creative.createdAt} locale={locale} />
                      </span>
                    </div>

                    {creative.complianceStatus === "blocked" ? (
                      <GuardrailNotice
                        title={l("blocked")}
                        reason={l("studio.blockedNote")}
                        tone="warning"
                      />
                    ) : null}

                    {creative.kind === "image" ? (
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                        <img
                          src={`/signal/creatives/${creative.id}/image`}
                          alt={l("studio.imageAlt")}
                          className="w-full max-w-[260px] rounded-lg border border-border"
                        />
                        {may.has(PERM.creativesApprove) ? (
                          <Form method="post" className="flex items-start gap-2">
                            <input type="hidden" name="key" value={loaded.key} />
                            <input type="hidden" name="creativeId" value={creative.id} />
                            <Button
                              type="submit"
                              name="intent"
                              value="discard-variant"
                              variant="ghost"
                              disabled={busy}
                            >
                              {l("studio.discard")}
                            </Button>
                          </Form>
                        ) : null}
                      </div>
                    ) : (
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                        <Form method="post" className="flex flex-col gap-2">
                          <input type="hidden" name="key" value={loaded.key} />
                          <input type="hidden" name="creativeId" value={creative.id} />
                          <Field label={l("studio.editVariant")} labelHidden>
                            <Textarea
                              name="contentRef"
                              rows={3}
                              defaultValue={creative.contentRef}
                              readOnly={!may.has(PERM.creativesApprove)}
                              aria-label={l("studio.editVariant")}
                            />
                          </Field>
                          {may.has(PERM.creativesApprove) ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button type="submit" name="intent" value="edit-variant" disabled={busy}>
                                {l("save")}
                              </Button>
                              <Button
                                type="submit"
                                name="intent"
                                value="clear-variant"
                                variant="primary"
                                disabled={busy || creative.complianceStatus === "passed"}
                              >
                                {creative.complianceStatus === "passed" ? l("studio.approved") : l("studio.approve")}
                              </Button>
                              <Button
                                type="submit"
                                name="intent"
                                value="discard-variant"
                                variant="ghost"
                                disabled={busy}
                              >
                                {l("studio.discard")}
                              </Button>
                            </div>
                          ) : null}
                        </Form>
                        <PostArt
                          copy={creative.contentRef}
                          kicker={campaign.name}
                          contentLocale={creative.locale}
                          brand={shell?.brand}
                          l={l}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={l("studio.step4")} description={l("studio.launchHint")}>
            {live ? (
              <Form method="post" className="flex items-center gap-3">
                <input type="hidden" name="intent" value="pause" />
                <input type="hidden" name="key" value={loaded.key} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <Badge tone="success" dot>
                  {l(campaign.state)}
                </Badge>
                <Button type="submit" disabled={busy || !nextStates(campaign.state).includes("paused")}>
                  {l("studio.pause")}
                </Button>
              </Form>
            ) : (
              <Form method="post" className="flex flex-col gap-2">
                <input type="hidden" name="intent" value="launch" />
                <input type="hidden" name="key" value={loaded.key} />
                <input type="hidden" name="campaignId" value={campaign.id} />
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={busy || !may.has(PERM.campaignsUpdate) || !canLaunch(campaign, mine)}
                  >
                    {l("studio.launch")}
                  </Button>
                  {canLaunch(campaign, mine) ? null : (
                    <span className="font-ui text-12 text-warning">{l("studio.launchBlocked")}</span>
                  )}
                </div>
              </Form>
            )}
          </Card>

          <Card title={l("studio.performance")}>
            {loaded.spend.length > 0 ? (
              <>
                <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Stat
                    label={l("spend")}
                    value={
                      <Money amountMinor={totalSpendMinor(loaded.spend)} currency={currency} locale={locale} />
                    }
                  />
                  <Stat
                    label={l("binds")}
                    value={loaded.touches.filter((touch) => touch.touchType === "bind").length}
                  />
                  <Stat label={l("clicks")} value={rolls.reduce((sum, roll) => sum + roll.clicks, 0)} />
                </dl>
                <Table<ChannelRoll>
                  caption={l("studio.performanceCaption")}
                  captionHidden
                  rowKey={(roll) => roll.channel}
                  rows={rolls}
                  columns={channelColumns(l, locale, currency)}
                />
              </>
            ) : (
              <EmptyState title={l("studio.noSpend")} body={l("studio.noSpend.body")} />
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** Shared with the cockpit's pipeline table — the same six numbers per channel. */
export function channelColumns(
  l: (key: string) => string,
  locale: string,
  currency: string
): Array<Column<ChannelRoll>> {
  return [
    { key: "channel", header: l("channel"), render: (roll) => channelLabel(roll.channel, locale) },
    {
      key: "spend",
      header: l("spend"),
      numeric: true,
      render: (roll) => <Money amountMinor={roll.spendMinor} currency={currency} locale={locale} />
    },
    { key: "impressions", header: l("impressions"), numeric: true, render: (roll) => roll.impressions },
    { key: "clicks", header: l("clicks"), numeric: true, render: (roll) => roll.clicks },
    { key: "conversions", header: l("conversions"), numeric: true, render: (roll) => roll.conversions },
    { key: "binds", header: l("binds"), numeric: true, render: (roll) => roll.binds }
  ];
}
