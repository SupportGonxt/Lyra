import {
  Form,
  Link,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  GuardrailNotice,
  Input,
  PageHeader,
  Select,
  Textarea,
  shortRef,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, fetchMe, directory, type DirectoryEntry, type Problem as ApiProblem } from "../api.server";
import { whoIs } from "../people";
import { cloudflare } from "../context";
import { orbit } from "../modules/orbit";
import { labelsFor, optionLabel } from "../modules/spec";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// docs/05 §7 + docs/19 §7. Getting a counterparty or a colleague live is a
// checklist, a ladder and a contract, and the three only make sense side by
// side: a stage that will not advance is explained by the step that is blocking
// it, and the step that is blocking it is cleared with the agreement id as its
// evidence. The generic list can show all three tables and still leave the
// operator to work out which row is the reason nothing is moving.
//
// Nothing here writes state directly. Every button is one of the twelve handlers
// in apps/api/src/routes/onboarding.ts, and the two that bind the tenant —
// waiving a required check, signing an agreement — come back as
// `approval_required`. That is the system working, so the screen says so.

/* --------------------------------------------------------------- contract */

/** Exactly as apps/api/src/routes/onboarding.ts spells them on these handlers. */
const PERM = {
  read: "core:onboarding:read",
  write: "core:onboarding:write",
  waive: "core:onboarding:waive",
  partnersRead: "orbit:partners:read",
  lifecycle: "orbit:partners:update",
  agreementsRead: "dist:agreements:read",
  // Signing is guarded on `write`: the drafter asks and the
  // `dist.agreement_sign` approval is what actually binds the tenant.
  agreementsWrite: "dist:agreements:write"
} as const;

/** The route's `:kind` segment, and the `subjectKind` the API spells. */
const KINDS = { partners: "partner", channels: "channel", staff: "staff" } as const;
type RouteKind = keyof typeof KINDS;
export type SubjectKind = (typeof KINDS)[RouteKind];

/** Templates the API will accept for each subject (packages/core templates). */
const TEMPLATES: Record<SubjectKind, readonly string[]> = {
  partner: ["partner.distribution"],
  channel: ["channel.b2b"],
  staff: ["staff.onboard", "staff.offboard"]
};

/** The partner ladder, in order. Mirrors STAGES in the engine. */
export const STAGES = [
  "prospect",
  "applied",
  "screening",
  "diligence",
  "agreement",
  "integration",
  "sandbox",
  "live"
] as const;

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s, i]));

/** `failed` deliberately does not clear a step — the engine agrees. */
const CLEARED = new Set(["done", "waived"]);

const AGREEMENT_KINDS = ["distribution", "referral", "introducer", "underwriting", "data"] as const;

const REASON_MIN = 3;
const REASON_MAX = 2000;

/** A checklist row, as `GET /v1/onboarding/steps` returns it. */
export interface Step {
  id: string;
  subjectKind: string;
  subjectRef: string;
  template: string;
  key: string;
  /** `{en, ar}` or `{key}` — and a JSON *string*, because this route is not CRUD. */
  labelJson: unknown;
  seq: number;
  required: boolean;
  gatesStage: string;
  state: string;
  evidenceKind: string | null;
  evidenceRef: string | null;
  ownerRef: string | null;
  dueAt: number | null;
  notesJson: unknown;
  waivedApprovalId: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
}

/** The partner columns this screen reads (packages/db schema/orbit). */
export interface Partner {
  id: string;
  name: string;
  kind: string;
  status: string;
  stage: string;
  ownerRef: string | null;
  legalName: string | null;
  country: string | null;
  riskRating: string | null;
  sandboxFlag: boolean;
  agreementId: string | null;
  goLiveAt: number | null;
  suspendedAt: number | null;
  suspendedReason: string | null;
  terminatedAt: number | null;
}

/** One agreement version (packages/db schema/dist). */
export interface Agreement {
  id: string;
  partnerId: string;
  version: number;
  kind: string;
  state: string;
  documentFileId: string | null;
  signedByPartnerName: string | null;
  signedAt: number | null;
  effectiveFrom: number | null;
  effectiveTo: number | null;
  createdAt: number;
}

/** Intents whose consequence needs a second, deliberate act in the page. */
const CONFIRMED = new Set(["waive", "suspend", "terminate", "sign"]);

/** Intents where the API demands `reason` (ReasonBody: 3..2000 characters). */
const REASONED = new Set(["fail", "waive", "suspend", "terminate"]);

/* ------------------------------------------------------------------ labels */

/** The module's own catalogue, then `common.*`, then the key — plus `{vars}`. */
export function labelsIn(locale: string, pack?: string): (key: string, vars?: Record<string, string>) => string {
  const base = labelsFor(orbit, locale, pack);
  return (key, vars) => {
    const raw = base(key);
    return vars ? raw.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match) : raw;
  };
}

/* ------------------------------------------------------------------- rules */

/** The stage after this one, or null at the top of the ladder. */
export function nextStage(stage: string): string | null {
  const index = STAGE_INDEX[stage];
  if (index === undefined) return null;
  return STAGES[index + 1] ?? null;
}

/**
 * The required steps standing between the subject and `stage`. Mirrors
 * `blockingSteps` in apps/api/src/engines/onboarding.ts: the API re-runs it on
 * advance, so this is what the screen shows, never what it decides.
 */
export function blockingFor(steps: readonly Step[], stage: string): Step[] {
  const target = STAGE_INDEX[stage] ?? 0;
  return steps.filter(
    (s) => s.required && (STAGE_INDEX[s.gatesStage] ?? 0) <= target && !CLEARED.has(s.state)
  );
}

/**
 * Why the ladder will not move, as a label key — or null when it will. The API
 * refuses all three cases; saying so up front beats a 409 after a click.
 */
export function advanceBlock(
  partner: Pick<Partner, "stage" | "status">,
  blocking: readonly Step[]
): string | null {
  if (partner.status === "terminated") return "onb.block.terminated";
  if (partner.status === "suspended") return "onb.block.suspended";
  if (nextStage(partner.stage) === null) return "onb.block.top";
  if (blocking.length > 0) return "onb.block.steps";
  return null;
}

/**
 * A 403 that is a queue position rather than a refusal. `waive`, `advance` to
 * live and `sign` all land here by design (CLAUDE.md §4).
 */
export function approvalOf(
  problem: ApiProblem | null | undefined
): { policyKey: string; approvalId?: string } | null {
  if (!problem || problem.status !== 403) return null;
  const extras = problem as ApiProblem & {
    code?: string;
    policy_key?: string;
    approval_id?: string;
  };
  if (extras.code !== "approval_required") return null;
  return {
    policyKey: extras.policy_key ?? problem.detail ?? problem.title,
    ...(extras.approval_id ? { approvalId: extras.approval_id } : {})
  };
}

/** The step's own label: counterparty copy in both languages, or an i18n key. */
export function stepLabel(
  step: Pick<Step, "key" | "labelJson">,
  label: (key: string) => string,
  locale: string
): string {
  const raw = typeof step.labelJson === "string" ? parseJson(step.labelJson) : step.labelJson;
  if (raw && typeof raw === "object") {
    const table = raw as Record<string, unknown>;
    if (typeof table.key === "string") return label(table.key);
    const hit = table[locale] ?? table.en;
    if (typeof hit === "string" && hit.length > 0) return hit;
  }
  return optionLabel(label, "step", step.key);
}

/** What the operator last wrote on the step, if anything. */
export function stepNote(step: Pick<Step, "notesJson">): string | null {
  const raw = typeof step.notesJson === "string" ? parseJson(step.notesJson) : step.notesJson;
  if (!raw || typeof raw !== "object") return null;
  const table = raw as Record<string, unknown>;
  const text = table.reason ?? table.note;
  return typeof text === "string" && text.length > 0 ? text : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- tones */

// A status that renders grey says nothing. The step states get five distinct
// tones; the ten partner stages share six, so they are grouped by what the
// operator does next — nothing yet, diligence, paperwork, testing, trading.
const STEP_TONES: Record<string, BadgeTone> = {
  pending: "neutral",
  in_progress: "info",
  done: "success",
  waived: "warning",
  failed: "danger"
};

const STAGE_TONES: Record<string, BadgeTone> = {
  prospect: "neutral",
  applied: "neutral",
  screening: "info",
  diligence: "info",
  agreement: "accent",
  integration: "accent",
  sandbox: "warning",
  live: "success",
  hired: "accent",
  active: "success",
  offboarded: "neutral",
  suspended: "warning",
  terminated: "danger"
};

const STATUS_TONES: Record<string, BadgeTone> = {
  active: "success",
  pending: "neutral",
  suspended: "warning",
  terminated: "danger"
};

const AGREEMENT_TONES: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_signature: "warning",
  active: "success",
  superseded: "info",
  terminated: "danger"
};

export const stepTone = (state: string): BadgeTone => STEP_TONES[state] ?? "neutral";
export const stageTone = (stage: string): BadgeTone => STAGE_TONES[stage] ?? "neutral";
export const statusTone = (status: string): BadgeTone => STATUS_TONES[status] ?? "neutral";
export const agreementTone = (state: string): BadgeTone => AGREEMENT_TONES[state] ?? "neutral";

/* ------------------------------------------------------------------ loader */

/** A read the actor may not hold is an empty section, not a broken screen. */
async function soft<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const kind = (params.kind ?? "") as RouteKind;
  const subjectKind = KINDS[kind];
  // An invented subject is a 404, not a guess at what was meant.
  if (!subjectKind) throw data("unknown onboarding subject", { status: 404 });
  const ref = params.ref ?? "";

  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const isPartner = subjectKind === "partner";
  const may = {
    read: held.has(PERM.read),
    write: held.has(PERM.write),
    waive: held.has(PERM.waive),
    lifecycle: isPartner && held.has(PERM.lifecycle),
    agreements: isPartner && held.has(PERM.agreementsRead),
    agreementsWrite: isPartner && held.has(PERM.agreementsWrite)
  };

  const empty = {
    kind,
    subjectKind,
    ref,
    may,
    steps: [] as Step[],
    blocking: [] as string[],
    partner: null as Partner | null,
    agreements: [] as Agreement[],
    people: [] as DirectoryEntry[],
    // Minted per render, not per click: a double submit is then one advance the
    // API deduplicates rather than two (CLAUDE.md §12).
    idempotencyKey: crypto.randomUUID()
  };
  if (!may.read) return { ...empty, denied: true as const };

  const query = new URLSearchParams({ subjectKind, subjectRef: ref });
  const [checklist, partner, agreements, people] = await Promise.all([
    soft(api<{ data: Step[]; blocking: string[] }>(`/v1/onboarding/steps?${query}`, { env, request })),
    isPartner && held.has(PERM.partnersRead)
      ? soft(api<Partner>(`/v1/orbit/partners/${encodeURIComponent(ref)}`, { env, request }))
      : Promise.resolve(null),
    may.agreements
      ? soft(
          api<{ data: Agreement[] }>(
            `/v1/dist/partner-agreements?partnerId=${encodeURIComponent(ref)}&sort=version&order=desc`,
            { env, request }
          )
        )
      : Promise.resolve(null),
    // Who owns a step is a colleague, and the checklist showed them as `us_…`.
    directory({ env, request })
  ]);

  return {
    ...empty,
    denied: false as const,
    people,
    steps: checklist?.data ?? [],
    blocking: checklist?.blocking ?? [],
    partner: partner ?? null,
    agreements: agreements?.data ?? []
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ApiProblem | null;
  /** Label key for what happened, so the page never echoes a server string. */
  ok: string | null;
  /** Label key for what the page itself refused to send. */
  invalid: string | null;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const subjectKind = KINDS[(params.kind ?? "") as RouteKind];
  if (!subjectKind) throw data("unknown onboarding subject", { status: 404 });
  const ref = params.ref ?? "";

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const stepId = String(form.get("stepId") ?? "");
  const agreementId = String(form.get("agreementId") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  const key = String(form.get("idempotencyKey") ?? "");
  const idem = key ? { headers: { "idempotency-key": key } } : {};
  const empty: ActionResult = { problem: null, ok: null, invalid: null };

  // The checkbox is `required` in the markup; this is the second look, so a
  // submit that arrived without it does not walk past the confirmation.
  if (CONFIRMED.has(intent) && form.get("confirm") !== "on") {
    return { ...empty, invalid: "onb.invalid.confirm" };
  }
  if (REASONED.has(intent) && reason.length < REASON_MIN) {
    return { ...empty, invalid: "onb.invalid.reason" };
  }
  // Terminating is typed out in full: a partner is stopped by name, not by
  // whichever button the pointer happened to be over.
  if (intent === "terminate" && String(form.get("typed") ?? "").trim() !== String(form.get("expect") ?? "")) {
    return { ...empty, invalid: "onb.invalid.typed" };
  }

  const post = async (path: string, body?: Record<string, unknown>) =>
    api<unknown>(path, { env, request, method: "POST", ...(body ? { body } : {}), ...idem });

  try {
    switch (intent) {
      case "start": {
        const template = String(form.get("template") ?? "");
        await post("/v1/onboarding/steps", { subjectKind, subjectRef: ref, template });
        return { ...empty, ok: "onb.ok.start" };
      }
      case "complete": {
        const evidenceRef = String(form.get("evidenceRef") ?? "").trim();
        const note = String(form.get("note") ?? "").trim();
        await post(`/v1/onboarding/steps/${encodeURIComponent(stepId)}/complete`, {
          ...(evidenceRef ? { evidenceRef } : {}),
          ...(note ? { note } : {})
        });
        return { ...empty, ok: "onb.ok.complete" };
      }
      case "fail":
        await post(`/v1/onboarding/steps/${encodeURIComponent(stepId)}/fail`, { reason });
        return { ...empty, ok: "onb.ok.fail" };
      case "waive":
        await post(`/v1/onboarding/steps/${encodeURIComponent(stepId)}/waive`, { reason });
        return { ...empty, ok: "onb.ok.waive" };
      case "advance":
        await post(`/v1/onboarding/partners/${encodeURIComponent(ref)}/advance`);
        return { ...empty, ok: "onb.ok.advance" };
      case "suspend":
        await post(`/v1/onboarding/partners/${encodeURIComponent(ref)}/suspend`, { reason });
        return { ...empty, ok: "onb.ok.suspend" };
      case "resume":
        await post(`/v1/onboarding/partners/${encodeURIComponent(ref)}/resume`);
        return { ...empty, ok: "onb.ok.resume" };
      case "terminate":
        await post(`/v1/onboarding/partners/${encodeURIComponent(ref)}/terminate`, { reason });
        return { ...empty, ok: "onb.ok.terminate" };
      case "draft": {
        const terms = termsFrom(form.get("terms"));
        if (!terms) return { ...empty, invalid: "onb.invalid.terms" };
        const from = epochFrom(String(form.get("effectiveFrom") ?? ""));
        await post("/v1/onboarding/agreements", {
          partnerId: ref,
          kind: String(form.get("kind") ?? "distribution"),
          terms,
          ...(from === null ? {} : { effectiveFrom: from })
        });
        return { ...empty, ok: "onb.ok.draft" };
      }
      case "send":
        await post(`/v1/onboarding/agreements/${encodeURIComponent(agreementId)}/send`);
        return { ...empty, ok: "onb.ok.send" };
      case "sign": {
        const from = epochFrom(String(form.get("effectiveFrom") ?? ""));
        await post(`/v1/onboarding/agreements/${encodeURIComponent(agreementId)}/sign`, {
          signedByPartnerName: String(form.get("signedByPartnerName") ?? "").trim(),
          ...(from === null ? {} : { effectiveFrom: from })
        });
        return { ...empty, ok: "onb.ok.sign" };
      }
      default:
        return { ...empty, problem: { title: "unknown intent", status: 400 } };
    }
  } catch (error) {
    // "not done", "already waived", a refused permission and an approval that
    // now has to be decided are all answers. They belong beside the button.
    if (error instanceof ApiError) return { ...empty, problem: error.problem };
    throw error;
  }
}

/** The terms object, or null when what was typed is not one. */
function termsFrom(raw: FormDataEntryValue | null): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** A `<input type="date">` value as the epoch the API stores. */
function epochFrom(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* --------------------------------------------------------------- component */

type Label = (key: string, vars?: Record<string, string>) => string;

export default function Onboarding() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  const { partner, steps, may } = loaded;
  const target = partner ? (nextStage(partner.stage) ?? partner.stage) : null;
  // For a partner the question is "what is stopping the next stage"; for a
  // channel or a colleague there is no ladder here, so the API's own answer
  // (every uncleared required step) stands.
  const blocking = new Set(
    target ? blockingFor(steps, target).map((s) => s.key) : loaded.blocking
  );
  const approval = approvalOf(result?.problem);

  if (loaded.denied) {
    return (
      <div className="flex flex-col gap-6">
        <Header l={l} loaded={loaded} />
        <EmptyState title={l("onb.deniedTitle")} body={l("onb.deniedBody")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Header l={l} loaded={loaded} lede={onboardingLede(steps, target, l)} />

      {approval ? (
        <GuardrailNotice
          title={l("onb.approvalTitle")}
          reason={l("onb.approvalBody", { policy: l(`policy.${approval.policyKey}`) })}
          action={
            <Link to="/approvals" className="underline underline-offset-2">
              {l("onb.approvalLink")}
            </Link>
          }
        />
      ) : result?.problem ? (
        <Problem problem={result.problem} />
      ) : null}
      {result?.invalid ? <Problem problem={{ title: l(result.invalid) }} /> : null}
      {result?.ok ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-surface-2 p-3 font-ui text-13 text-text"
        >
          {l(result.ok)}
        </p>
      ) : null}

      {partner ? <Subject l={l} locale={locale} people={loaded.people} partner={partner} /> : null}

      <section aria-labelledby="checklist-heading" className="flex flex-col gap-3">
        <h2 id="checklist-heading" className="eyebrow">
          {l("onb.checklist")}
        </h2>
        {target ? (
          <p className="max-w-prose font-ui text-13 text-muted">
            {blocking.size === 0
              ? l("onb.clear", { stage: l(`stage.${target}`) })
              : l("onb.blockingBody", {
                  stage: l(`stage.${target}`),
                  count: String(blocking.size)
                })}
          </p>
        ) : null}

        {steps.length === 0 ? (
          <EmptyState title={l("onb.noSteps")} body={l("onb.noStepsBody")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {[...steps]
              .sort((a, b) => a.seq - b.seq)
              .map((step) => (
                <StepCard
                  key={step.id}
                  l={l}
                  locale={locale}
                  people={loaded.people}
                  step={step}
                  blocking={blocking.has(step.key)}
                  may={may}
                  busy={busy}
                />
              ))}
          </ul>
        )}

        {may.write ? <StartForm l={l} loaded={loaded} busy={busy} /> : null}
      </section>

      {partner && may.lifecycle ? (
        <Lifecycle l={l} partner={partner} loaded={loaded} blocking={[...blocking]} busy={busy} />
      ) : null}

      {may.agreements ? (
        <Agreements l={l} locale={locale} loaded={loaded} busy={busy} />
      ) : null}
    </div>
  );
}

/** The one line under the title: how much of the required checklist is actually cleared. */
export function onboardingLede(steps: readonly Step[], target: string | null, l: Label): string {
  const required = steps.filter((step) => step.required);
  const done = required.filter((step) => CLEARED.has(step.state)).length;
  const total = required.length;
  if (total === 0) return l("onboardingNoSteps");
  if (target) return l("onboardingProgressStage", { done: String(done), total: String(total), stage: optionLabel(l, "stage", target) });
  return l("onboardingProgress", { done: String(done), total: String(total) });
}

function Header({
  l,
  loaded,
  lede
}: {
  l: Label;
  loaded: Awaited<ReturnType<typeof loader>>;
  lede?: string;
}) {
  const back = (
    <Link to="/orbit/partners" className="font-ui text-12 text-subtle underline-offset-2 hover:underline">
      {l("onb.back")}
    </Link>
  );
  const meta = <p className="font-mono text-12 text-subtle">{loaded.ref}</p>;
  const subjectLabel = loaded.partner?.name ?? l(`onb.subject.${loaded.subjectKind}`);
  return lede ? (
    <PageHeader eyebrow={subjectLabel} title={lede} description={l("onb.intro")} back={back} meta={meta} />
  ) : (
    <PageHeader title={subjectLabel} description={l("onb.intro")} back={back} meta={meta} />
  );
}

/** Where the subject stands, before anything about what is left to do. */
function Subject({
  l,
  locale,
  people,
  partner
}: {
  l: Label;
  locale: string;
  people: readonly DirectoryEntry[];
  partner: Partner;
}) {
  const facts: Array<[string, React.ReactNode]> = [
    ["onb.stage", <Badge tone={stageTone(partner.stage)} dot>{l(`stage.${partner.stage}`)}</Badge>],
    [
      "onb.status",
      <Badge tone={statusTone(partner.status)} dot>
        {optionLabel(l, "status", partner.status)}
      </Badge>
    ],
    ["kind", <span>{optionLabel(l, "kind", partner.kind)}</span>]
  ];
  if (partner.ownerRef) facts.push(["ownerRef", <span>{whoIs(people, partner.ownerRef) ?? shortRef(partner.ownerRef)}</span>]);
  if (partner.riskRating)
    facts.push(["onb.riskRating", <span>{optionLabel(l, "riskRating", partner.riskRating)}</span>]);
  if (partner.country) facts.push(["onb.country", <span>{partner.country}</span>]);
  if (partner.goLiveAt)
    facts.push(["onb.goLive", <DateTime value={partner.goLiveAt} locale={locale} precision="day" />]);
  if (partner.terminatedAt)
    facts.push([
      "onb.terminatedAt",
      <DateTime value={partner.terminatedAt} locale={locale} precision="day" />
    ]);
  else if (partner.suspendedAt)
    facts.push([
      "onb.suspendedAt",
      <DateTime value={partner.suspendedAt} locale={locale} precision="day" />
    ]);

  return (
    <section
      aria-labelledby="subject-heading"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="subject-heading" className="sr-only">
        {l("onb.subjectHeading")}
      </h2>
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        {facts.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-1">
            <dt className="font-ui text-12 text-subtle">{l(key)}</dt>
            <dd className="font-ui text-13 text-text">{value}</dd>
          </div>
        ))}
      </dl>
      {partner.suspendedReason ? (
        <p className="font-ui text-13 text-muted">
          <span className="text-subtle">{l("onb.reason")}</span>{" "}
          <span>{partner.suspendedReason}</span>
        </p>
      ) : null}
    </section>
  );
}

function StepCard({
  l,
  locale,
  people,
  step,
  blocking,
  may,
  busy
}: {
  l: Label;
  locale: string;
  people: readonly DirectoryEntry[];
  step: Step;
  blocking: boolean;
  may: { write: boolean; waive: boolean };
  busy: boolean;
}) {
  const cleared = CLEARED.has(step.state);
  const note = stepNote(step);
  // Waiving stays offered on a failed step — that is the case it exists for.
  const actionable = (may.write && !cleared) || (may.waive && !cleared);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-12 text-subtle tabular-nums">{step.seq}</span>
        <span className="font-ui text-14 text-text">{stepLabel(step, l, locale)}</span>
        <Badge tone={stepTone(step.state)} size="sm" dot>
          {optionLabel(l, "state", step.state)}
        </Badge>
        {blocking ? (
          <Badge tone="warning" size="sm">
            {l("onb.blocks", { stage: l(`stage.${step.gatesStage}`) })}
          </Badge>
        ) : null}
        {step.required ? null : (
          <Badge tone="neutral" size="sm">
            {l("onb.optional")}
          </Badge>
        )}
      </div>

      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-ui text-12">
        <div className="flex gap-1.5">
          <dt className="text-subtle">{l("onb.gates")}</dt>
          <dd className="text-text">{l(`stage.${step.gatesStage}`)}</dd>
        </div>
        {step.evidenceKind ? (
          <div className="flex gap-1.5">
            <dt className="text-subtle">{l("onb.evidence")}</dt>
            <dd className="text-text">
              {optionLabel(l, "evidenceKind", step.evidenceKind)}
              {step.evidenceRef ? (
                <span className="ms-1.5 font-mono text-12 text-subtle">{shortRef(step.evidenceRef)}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {step.ownerRef ? (
          <div className="flex gap-1.5">
            <dt className="text-subtle">{l("ownerRef")}</dt>
            <dd className="font-ui text-12 text-text">{whoIs(people, step.ownerRef) ?? shortRef(step.ownerRef)}</dd>
          </div>
        ) : null}
        {step.dueAt ? (
          <div className="flex gap-1.5">
            <dt className="text-subtle">{l("onb.due")}</dt>
            <dd className="text-text">
              <DateTime value={step.dueAt} locale={locale} precision="day" />
            </dd>
          </div>
        ) : null}
        {step.decidedAt ? (
          <div className="flex gap-1.5">
            <dt className="text-subtle">{l("onb.decided")}</dt>
            <dd className="text-text">
              <DateTime value={step.decidedAt} locale={locale} precision="minute" />
              {step.decidedBy ? (
                <span className="ms-1.5 font-ui text-12 text-subtle">{whoIs(people, step.decidedBy) ?? shortRef(step.decidedBy)}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {step.waivedApprovalId ? (
          <div className="flex gap-1.5">
            <dt className="text-subtle">{l("onb.waivedBy")}</dt>
            <dd className="font-mono text-12 text-text">{shortRef(step.waivedApprovalId)}</dd>
          </div>
        ) : null}
      </dl>

      {note ? (
        <p className="max-w-prose font-ui text-12 text-muted">
          <span className="text-subtle">{l("onb.note")}</span> <span>{note}</span>
        </p>
      ) : null}

      {actionable ? (
        <details className="mt-1">
          <summary className="cursor-pointer font-ui text-12 text-accent underline-offset-2 hover:underline">
            {l("onb.act")}
          </summary>
          <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
            {may.write ? (
              <>
                <Form method="post" className="flex max-w-xl flex-col gap-3">
                  <input type="hidden" name="intent" value="complete" />
                  <input type="hidden" name="stepId" value={step.id} />
                  <Field
                    label={l("onb.evidenceRef")}
                    hint={l(
                      step.evidenceKind && step.evidenceKind !== "attestation"
                        ? "onb.evidenceRefRequired"
                        : "onb.evidenceRefHint"
                    )}
                  >
                    <Input name="evidenceRef" />
                  </Field>
                  <Field label={l("onb.note")}>
                    <Textarea name="note" rows={2} maxLength={REASON_MAX} />
                  </Field>
                  <div>
                    <Button type="submit" size="sm" loading={busy}>
                      {l("onb.complete")}
                    </Button>
                  </div>
                </Form>

                <Form method="post" className="flex max-w-xl flex-col gap-3">
                  <input type="hidden" name="intent" value="fail" />
                  <input type="hidden" name="stepId" value={step.id} />
                  <Field label={l("onb.reason")} required hint={l("onb.failHint")}>
                    <Textarea name="reason" rows={2} required minLength={REASON_MIN} maxLength={REASON_MAX} />
                  </Field>
                  <div>
                    <Button type="submit" size="sm" variant="secondary" loading={busy}>
                      {l("onb.fail")}
                    </Button>
                  </div>
                </Form>
              </>
            ) : null}

            {may.waive ? (
              <Form method="post" className="flex max-w-xl flex-col gap-3">
                <input type="hidden" name="intent" value="waive" />
                <input type="hidden" name="stepId" value={step.id} />
                <p className="max-w-prose font-ui text-12 text-muted">{l("onb.waiveDual")}</p>
                <Field label={l("onb.reason")} required hint={l("onb.waiveHint")}>
                  <Textarea name="reason" rows={2} required minLength={REASON_MIN} maxLength={REASON_MAX} />
                </Field>
                <Checkbox name="confirm" required label={l("onb.waiveConfirm")} />
                <div>
                  <Button type="submit" size="sm" variant="danger" loading={busy}>
                    {l("onb.waive")}
                  </Button>
                </div>
              </Form>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** Generating the checklist. Absent once the subject already has one. */
function StartForm({
  l,
  loaded,
  busy
}: {
  l: Label;
  loaded: Awaited<ReturnType<typeof loader>>;
  busy: boolean;
}) {
  const templates = TEMPLATES[loaded.subjectKind];
  return (
    <Form method="post" className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4">
      <input type="hidden" name="intent" value="start" />
      <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
      <Field label={l("onb.template")} hint={l("onb.startIntro")} className="w-72">
        <Select
          name="template"
          defaultValue={templates[0] ?? ""}
          aria-label={l("onb.template")}
          options={templates.map((template) => ({
            value: template,
            label: l(`template.${template}`)
          }))}
        />
      </Field>
      <Button type="submit" variant="secondary" size="sm" loading={busy}>
        {l("onb.start")}
      </Button>
    </Form>
  );
}

/** The partner's lifecycle. Every button here is a state machine transition. */
function Lifecycle({
  l,
  partner,
  loaded,
  blocking,
  busy
}: {
  l: Label;
  partner: Partner;
  loaded: Awaited<ReturnType<typeof loader>>;
  blocking: readonly string[];
  busy: boolean;
}) {
  const blocked = advanceBlock(partner, blocking.map((key) => ({ key }) as unknown as Step));
  const live = partner.status !== "terminated" && partner.status !== "suspended";
  const next = nextStage(partner.stage);

  return (
    <section aria-labelledby="lifecycle-heading" className="flex flex-col gap-4">
      <h2 id="lifecycle-heading" className="eyebrow">
        {l("onb.lifecycle")}
      </h2>

      {blocked ? (
        <p className="max-w-prose font-ui text-13 text-muted">
          {l(blocked, { count: String(blocking.length) })}
        </p>
      ) : (
        <Form method="post" className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="intent" value="advance" />
          <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
          <Button type="submit" loading={busy}>
            {l("onb.advance", { stage: l(`stage.${next ?? partner.stage}`) })}
          </Button>
          {next === "live" ? (
            <span className="font-ui text-12 text-subtle">{l("onb.advanceApproval")}</span>
          ) : null}
        </Form>
      )}

      {partner.status === "suspended" ? (
        <Form method="post" className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="intent" value="resume" />
          <Button type="submit" variant="secondary" loading={busy}>
            {l("onb.resume")}
          </Button>
          <span className="font-ui text-12 text-subtle">{l("onb.resumeHint")}</span>
        </Form>
      ) : null}

      {live ? (
        <Form method="post" className="flex max-w-xl flex-col gap-3 rounded-lg border border-border p-4">
          <input type="hidden" name="intent" value="suspend" />
          <p className="max-w-prose font-ui text-12 text-muted">{l("onb.suspendIntro")}</p>
          <Field label={l("onb.reason")} required hint={l("onb.suspendHint")}>
            <Textarea name="reason" rows={2} required minLength={REASON_MIN} maxLength={REASON_MAX} />
          </Field>
          <Checkbox name="confirm" required label={l("onb.suspendConfirm")} />
          <div>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("onb.suspend")}
            </Button>
          </div>
        </Form>
      ) : null}

      {partner.status === "terminated" ? null : (
        <Form method="post" className="flex max-w-xl flex-col gap-3 rounded-lg border border-danger/40 p-4">
          <input type="hidden" name="intent" value="terminate" />
          <input type="hidden" name="expect" value={partner.name} />
          <p className="max-w-prose font-ui text-12 text-muted">{l("onb.terminateIntro")}</p>
          <Field label={l("onb.reason")} required hint={l("onb.terminateHint")}>
            <Textarea name="reason" rows={2} required minLength={REASON_MIN} maxLength={REASON_MAX} />
          </Field>
          <Field label={l("onb.typeName", { name: partner.name })} required>
            <Input name="typed" required autoComplete="off" />
          </Field>
          <Checkbox name="confirm" required label={l("onb.terminateConfirm")} />
          <div>
            <Button type="submit" variant="danger" loading={busy}>
              {l("onb.terminate")}
            </Button>
          </div>
        </Form>
      )}
    </section>
  );
}

/** The paper. Versions descend, so the one in force reads first. */
function Agreements({
  l,
  locale,
  loaded,
  busy
}: {
  l: Label;
  locale: string;
  loaded: Awaited<ReturnType<typeof loader>>;
  busy: boolean;
}) {
  const mayWrite = loaded.may.agreementsWrite;
  return (
    <section aria-labelledby="agreements-heading" className="flex flex-col gap-3">
      <h2 id="agreements-heading" className="eyebrow">
        {l("onb.agreements")}
      </h2>

      {loaded.agreements.length === 0 ? (
        <EmptyState title={l("onb.agreementsNone")} body={l("onb.agreementsNoneBody")} />
      ) : (
        <ul className="flex flex-col gap-3">
          {loaded.agreements.map((agreement) => (
            <li key={agreement.id} className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-ui text-14 text-text tabular-nums">
                  {l("onb.version", { version: String(agreement.version) })}
                </span>
                <Badge tone="neutral" size="sm">
                  {optionLabel(l, "agreementKind", agreement.kind)}
                </Badge>
                <Badge tone={agreementTone(agreement.state)} size="sm" dot>
                  {optionLabel(l, "agreementState", agreement.state)}
                </Badge>
                {agreement.id === loaded.partner?.agreementId ? (
                  <Badge tone="info" size="sm">
                    {l("onb.inForce")}
                  </Badge>
                ) : null}
              </div>

              <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-ui text-12">
                {agreement.effectiveFrom ? (
                  <div className="flex gap-1.5">
                    <dt className="text-subtle">{l("onb.effectiveFrom")}</dt>
                    <dd className="text-text">
                      <DateTime value={agreement.effectiveFrom} locale={locale} precision="day" />
                    </dd>
                  </div>
                ) : null}
                {agreement.signedAt ? (
                  <div className="flex gap-1.5">
                    <dt className="text-subtle">{l("onb.signedAt")}</dt>
                    <dd className="text-text">
                      <DateTime value={agreement.signedAt} locale={locale} precision="minute" />
                    </dd>
                  </div>
                ) : null}
                {agreement.signedByPartnerName ? (
                  <div className="flex gap-1.5">
                    <dt className="text-subtle">{l("onb.signedBy")}</dt>
                    <dd className="text-text">{agreement.signedByPartnerName}</dd>
                  </div>
                ) : null}
                <div className="flex gap-1.5">
                  <dt className="text-subtle">{l("onb.agreementId")}</dt>
                  <dd className="font-mono text-12 text-text">{agreement.id}</dd>
                </div>
              </dl>

              {mayWrite && agreement.state === "draft" ? (
                <Form method="post" className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="intent" value="send" />
                  <input type="hidden" name="agreementId" value={agreement.id} />
                  <Button type="submit" size="sm" variant="secondary" loading={busy}>
                    {l("onb.send")}
                  </Button>
                  <span className="font-ui text-12 text-subtle">{l("onb.sendHint")}</span>
                </Form>
              ) : null}

              {mayWrite && !agreement.signedAt && agreement.state !== "superseded" ? (
                <details>
                  <summary className="cursor-pointer font-ui text-12 text-accent underline-offset-2 hover:underline">
                    {l("onb.sign")}
                  </summary>
                  <Form method="post" className="mt-3 flex max-w-xl flex-col gap-3 border-t border-border pt-3">
                    <input type="hidden" name="intent" value="sign" />
                    <input type="hidden" name="agreementId" value={agreement.id} />
                    <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                    <p className="max-w-prose font-ui text-12 text-muted">{l("onb.signIntro")}</p>
                    <Field label={l("onb.signedBy")} required hint={l("onb.signedByHint")}>
                      <Input name="signedByPartnerName" required minLength={2} maxLength={200} />
                    </Field>
                    <Field label={l("onb.effectiveFrom")} hint={l("onb.effectiveFromHint")}>
                      <Input type="date" name="effectiveFrom" />
                    </Field>
                    <Checkbox name="confirm" required label={l("onb.signConfirm")} />
                    <div>
                      <Button type="submit" size="sm" loading={busy}>
                        {l("onb.sign")}
                      </Button>
                    </div>
                  </Form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {mayWrite ? (
        <Form method="post" className="flex max-w-xl flex-col gap-3 rounded-lg border border-border p-4">
          <input type="hidden" name="intent" value="draft" />
          <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
          <h3 className="font-ui text-14 text-text">{l("onb.draft")}</h3>
          <p className="max-w-prose font-ui text-12 text-muted">{l("onb.draftIntro")}</p>
          <Field label={l("kind")}>
            <Select
              name="kind"
              defaultValue="distribution"
              aria-label={l("kind")}
              options={AGREEMENT_KINDS.map((kind) => ({
                value: kind,
                label: optionLabel(l, "agreementKind", kind)
              }))}
            />
          </Field>
          <Field label={l("onb.terms")} hint={l("onb.termsHint")}>
            <Textarea name="terms" rows={4} className="font-mono" />
          </Field>
          <Field label={l("onb.effectiveFrom")} hint={l("onb.effectiveFromHint")}>
            <Input type="date" name="effectiveFrom" />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("onb.draft")}
            </Button>
          </div>
        </Form>
      ) : null}
    </section>
  );
}
