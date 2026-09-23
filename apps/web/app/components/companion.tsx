import { useEffect } from "react";
import { NavLink, useFetcher } from "react-router";
import { Badge, type BadgeTone } from "@lyra/ui";
import type { Translate } from "../i18n";
import type { CompanionAgent, CompanionRun } from "../routes/companion";

// The right rail of the Horizon shell (spec §4 item 7): what the agents have
// been doing, footed by the envelope that says how far they may go on their own.
// Read-only by construction — the console at /admin/ai/console is where an agent
// is paused or its autonomy changed, and this rail links to it rather than
// growing a second set of controls beside the work.
//
// Divergences from the comp, recorded in ADR-0059: it opens closed and loads on
// first open (a rail nobody asked for should cost nothing), and it is absent
// rather than disabled for an actor without `ai:runs:read` — the same rule the
// posture chips already follow.

/** The ladder `ai_agents.autonomy_level` stores, lowest first (packages/db json.ts). */
const AUTONOMY_LEVELS = ["suggest", "act_with_approval", "act_within_limits", "autonomous"] as const;
type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface Envelope {
  active: number;
  paused: number;
  /** The freest rung any active agent sits on. */
  ceiling: AutonomyLevel;
}

/**
 * What the roster is allowed to do without asking. A level nobody recognises
 * ranks lowest — the same reading ai-console.tsx gives an off-ladder value, so
 * a stored `suggest_only` never reads as a wider envelope than it is.
 */
export function envelopeOf(agents: readonly CompanionAgent[]): Envelope {
  const active = agents.filter((agent) => agent.status === "active");
  const ceiling = active.reduce<AutonomyLevel>((widest, agent) => {
    const rung = AUTONOMY_LEVELS.indexOf(agent.autonomyLevel as AutonomyLevel);
    return rung > AUTONOMY_LEVELS.indexOf(widest) ? AUTONOMY_LEVELS[rung]! : widest;
  }, "suggest");
  return {
    active: active.length,
    paused: agents.filter((agent) => agent.status === "paused").length,
    ceiling
  };
}

const STATE_TONES: Record<string, BadgeTone> = {
  succeeded: "success",
  running: "info",
  awaiting_approval: "warning",
  refused: "warning",
  failed: "danger",
  cancelled: "neutral",
  budget_stopped: "danger"
};

/** Every state the API can store has a key; anything else prints as stored,
 *  which beats printing the key name of a string nobody wrote. */
const stateLabel = (t: Translate, state: string): string =>
  state in STATE_TONES ? t(`companion.state.${state}`) : state;

export function Companion({ t }: { t: Translate }) {
  const fetcher = useFetcher<{ runs: CompanionRun[]; agents: CompanionAgent[] }>();

  // Mounted only while open, so this is the first open. Reopening reloads,
  // which is what a live activity list should do anyway.
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) void fetcher.load("/companion");
  }, [fetcher]);

  const runs = fetcher.data?.runs ?? [];
  const envelope = fetcher.data ? envelopeOf(fetcher.data.agents) : null;

  return (
    <aside
      aria-label={t("companion.title")}
      className="hidden lg:flex lg:w-[var(--companion-width)] lg:shrink-0 lg:flex-col lg:border-s lg:border-border lg:bg-surface-1"
    >
      <h2 className="border-b border-border px-3 py-2 font-ui text-12 font-medium uppercase tracking-[0.14em] text-subtle">
        {t("companion.title")}
      </h2>

      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
        {runs.map((run) => (
          <li key={run.id}>
            <NavLink
              to={`/admin/ai/runs/${run.id}`}
              className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="flex items-center gap-2">
                {/* docs/15: one ✦ on anything a model produced. */}
                <span aria-hidden="true" className="text-12 text-accent">
                  &#10022;
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-12 text-text">{run.agentKey}</span>
                <Badge tone={STATE_TONES[run.state] ?? "neutral"} size="sm">
                  {stateLabel(t, run.state)}
                </Badge>
              </span>
              <span className="truncate font-ui text-12 text-muted">{run.purpose}</span>
            </NavLink>
          </li>
        ))}
        {fetcher.data && !runs.length ? (
          <li className="px-2 py-3 font-ui text-12 text-muted">{t("companion.empty")}</li>
        ) : null}
      </ul>

      {/* The envelope, under the activity it explains: how many agents are on,
          how far the freest of them may go, and how many are held. */}
      <div className="border-t border-border px-3 py-2 font-ui text-12 text-muted">
        {envelope ? (
          <>
            <p>{t("companion.agents", { count: envelope.active })}</p>
            <p className="text-subtle">
              {t("companion.ceiling")}: {t(`autonomy.${envelope.ceiling}`)}
            </p>
            {envelope.paused ? (
              <p className="text-subtle">{t("companion.paused", { count: envelope.paused })}</p>
            ) : null}
          </>
        ) : null}
        <NavLink
          to="/admin/ai/console"
          className="mt-1 inline-block text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t("companion.console")}
        </NavLink>
      </div>
    </aside>
  );
}
