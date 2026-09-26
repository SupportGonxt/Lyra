import { Hono } from "hono";
import { PolicyJson, EntitlementsJson } from "@lyra/db";
import { moduleEnabled, notFound, pruneIdempotency, type Envelope } from "@lyra/core";
import { drainOutbox, deliverQueued } from "./dispatch.js";
import { sweepPolicyLifecycle } from "./engines/axis-lifecycle.js";
import { sweepPremiumFinancing } from "./engines/premium-financing.js";
import { sweepRenewals } from "./engines/renewals.js";
import { sweepRouting } from "./engines/orbit-routing.js";
import { advanceJourneyRuns } from "./engines/orbit-journeys.js";
import { harvestSignals } from "./engines/scout-ingest.js";
import { sweepSignalClusters } from "./engines/scout-cluster.js";
import { sweepPanelBench } from "./engines/scout-bench.js";
import { sweepBilling } from "./engines/billing.js";
import { sweepConversationDrafts } from "./engines/orbit-draft.js";
import { runSnapshotter } from "./engines/north-snapshotter.js";
import { backupTenant } from "./engines/backup.js";
import { anchorAudit } from "./engines/anchor.js";
import { nudgeApiKeyRotation } from "./engines/api-key-rotation.js";
import { runBudgetAutopilot } from "./engines/signal-autopilot.js";
import { runAcquisitionSweep } from "./engines/signal-outreach.js";
import { sweepQaScores } from "./engines/orbit-qa.js";
import { sweepAiDrift } from "./engines/ai-drift.js";
import { expireDelegations } from "./engines/staff.js";
import { notifyUrgentWatch, runWatch } from "./engines/scout-watch.js";
import { nightlyBriefing } from "./engines/narrator.js";
import { expireQuoteRequests } from "./engines/dist-quote-expiry.js";
import { COOKIE, allTenants, authRoutes, ctxFor, db, pruneSessions, scheduledConfig } from "./auth.js";
import { mountAll } from "./crud.js";
import { BY_MODULE } from "./resources.js";
import { gatewayFor, onError, rememberStopped, withContext, withCors, withHeaders } from "./mw.js";
import { markCompleted, resumeFor } from "@lyra/core";
import { openapi } from "./openapi.js";
import { meRoutes } from "./routes/me.js";
import { coreRoutes } from "./routes/core.js";
import { axisRoutes } from "./routes/axis.js";
import { distRoutes } from "./routes/dist.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { aiRoutes } from "./routes/ai.js";
import { orbitRoutes } from "./routes/orbit.js";
import { signalRoutes } from "./routes/signal.js";
import { scoutRoutes } from "./routes/scout.js";
import { northRoutes } from "./routes/north.js";
import { ssoRoutes } from "./routes/sso.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { analyticsRoutes, runDueSchedules } from "./routes/analytics.js";
import { complianceRoutes } from "./routes/compliance.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { portalRoutes } from "./routes/portal.js";
import { carrierSandboxRoutes } from "./routes/carrier-sandbox.js";
import { channelsRoutes } from "./routes/channels.js";
import { platformRoutes } from "./routes/platform.js";
import { settlementRoutes } from "./routes/settlement.js";
import { staffRoutes } from "./routes/staff.js";
import { searchRoutes } from "./routes/search.js";
import { directoryRoutes } from "./routes/directory.js";
import { nameRoutes } from "./routes/names.js";
import { noteRoutes } from "./routes/notes.js";
import type { App, Env } from "./env.js";

// docs/04. One worker, one router. `/v1/<module>/<resource>` is generated CRUD;
// anything with real behaviour behind it is a hand-written route in routes/*.

const app = new Hono<App>();

/** Deliveries per message before the consumer stops retrying and drops it. */
const MAX_QUEUE_ATTEMPTS = 3;

app.onError(onError);
app.use("*", withHeaders);
app.use("*", withCors);
app.use("*", withContext);
app.use("/v1/*", rememberStopped);

app.get("/health", (c) =>
  c.json({ ok: true, environment: c.env.ENVIRONMENT ?? "production", ts: Date.now() })
);
// The spec describes this deployment, so it names the cookie this
// deployment reads (auth.ts does the same `?? COOKIE`).
app.get("/openapi.json", (c) => c.json(openapi(c.env.SESSION_COOKIE ?? COOKIE)));

app.route("/v1/auth/sso", ssoRoutes);
app.route("/v1/auth", authRoutes);
app.route("/v1/me", meRoutes);

/**
 * Finish an approved request (docs/06 J-M1, J-X2, J-P1, J-P2, J-E2). The gate
 * kept what it stopped; this replays it through this same app in the
 * requester's own session, so permissions, validation and the gate run again
 * exactly as they would on a retry — and the gate spends the approval. Only
 * the requester may finish it, and only once. Mounted here rather than in
 * routes/me.ts because it needs `app` itself.
 */
app.post("/v1/me/approvals/:id/finish", async (c) => {
  const ctx = c.get("ctx");
  const id = c.req.param("id");
  const stopped = await resumeFor(ctx, id);
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cookie", "accept-language"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const replay = new Request(new URL(stopped.path, c.req.url), {
    method: stopped.method,
    headers,
    ...(stopped.body ? { body: stopped.body } : {})
  });
  const res = await app.fetch(replay, c.env, c.executionCtx);
  if (res.ok) await markCompleted(ctx, id);
  return res;
});
app.route("/v1/realtime", realtimeRoutes);

// Hand-written routes mount BEFORE generated CRUD. Hono returns handlers in
// registration order, so whatever registers first wins a path both can serve —
// and where both can serve one, the hand-written engine is the one that must
// run. Generated CRUD would otherwise swallow `POST /v1/ai/runs` (the agent
// invocation), `POST /v1/analytics/reports` (which derives the required
// permission from the dataset instead of trusting the body),
// `GET /v1/dist/commission-entries/statement` (read as an id) and
// `POST /v1/north/boardpacks` (which would otherwise accept a client-supplied
// sectionsJson/pdfFileId with no assembly or render behind it).
app.route("/v1/core", coreRoutes);
// ADR-0089: record notes, backlinks, graph and vault export. No generated
// resource shares these paths, but they mount here with the other hand-written
// core routes so that stays true if one is ever registered.
app.route("/v1/core", noteRoutes);
app.route("/v1/axis", axisRoutes);
app.route("/v1/dist", distRoutes);
app.route("/v1/ledger", ledgerRoutes);
app.route("/v1/ai", aiRoutes);
app.route("/v1/orbit", orbitRoutes);
app.route("/v1/signal", signalRoutes);
app.route("/v1/scout", scoutRoutes);
app.route("/v1/north", northRoutes);
app.route("/v1/analytics", analyticsRoutes);
app.route("/v1/compliance", complianceRoutes);
// Three cross-module processes, mounted outside `/v1/<module>` because none of
// them belongs to one module: onboarding walks a partner through core steps and
// dist agreements, settlement turns dist commissions into ledger postings, and
// staff moves core users, roles and delegations at once.
app.route("/v1/onboarding", onboardingRoutes);
app.route("/v1/portal", portalRoutes);
app.route("/v1/channels", channelsRoutes);
app.route("/v1/settlement", settlementRoutes);
app.route("/v1/staff", staffRoutes);
app.route("/v1/platform", platformRoutes);
app.route("/v1/search", searchRoutes);
app.route("/v1/names", nameRoutes);
app.route("/v1/directory", directoryRoutes);

// Not a LYRA API and deliberately outside /v1: the reference underwriter
// (ADR-0072) is a foreign carrier as far as the quote adapter is concerned,
// has no tenant and no session, and belongs in no integrator's SDK.
app.route("/carrier-sandbox", carrierSandboxRoutes);

for (const [module, resources] of Object.entries(BY_MODULE)) {
  mountAll(app.basePath(`/v1/${module}`) as unknown as Hono<App>, resources);
}

// A route that does not exist is a 404, not a 500. This is the answer a client
// gets when it POSTs to a read-only resource, so it has to be the honest one.
app.notFound((c) => onError(notFound(c.req.path), c));

export default {
  fetch: app.fetch,

  /**
   * Consumer side of the `lyra-events` Queue (docs/10 §2). Each message is one
   * outbox event, published by `drainOutbox`; delivery here is the same
   * `deliverQueued` the inline (no-queue) path uses, just off the cron tick so a
   * slow webhook endpoint no longer holds up the next tenant's drain.
   */
  async queue(batch: { messages: { body: Envelope; attempts: number; ack(): void; retry(): void }[] }, env: Env) {
    for (const message of batch.messages) {
      try {
        const event = message.body;
        const ctx = await ctxFor(
          env,
          {
            tenantId: event.tenant_id,
            locale: "en",
            actor: { kind: "system", id: "queue", tenantId: event.tenant_id, grants: [] },
            policy: PolicyJson.parse({}),
            entitlements: EntitlementsJson.parse({})
          },
          Date.now()
        );
        await deliverQueued(ctx, event);
        message.ack();
      } catch (err) {
        // A message that fails every delivery is poison: past the cap it is
        // acked and logged, or it blocks its batch slot forever. Wrangler's
        // max_retries (default 3) also caps it in production, but silently.
        if (message.attempts >= MAX_QUEUE_ATTEMPTS) {
          console.error("lyra-events: dropping poison message", {
            attempts: message.attempts,
            eventId: (message.body as { id?: string } | null)?.id,
            error: err instanceof Error ? err.message : String(err)
          });
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },

  /**
   * Outbox drain and session sweep. Both are idempotent, so a missed tick costs
   * latency and nothing else.
   */
  async scheduled(_event: unknown, env: Env, ctxExec: { waitUntil(p: Promise<unknown>): void }) {
    const now = Date.now();
    // Cron fires every 5-15min (wrangler.jsonc); the nightly jobs below only need
    // one of those ticks a day, so they gate on a fixed UTC hour instead of their
    // own scheduler.
    const nowDate = new Date(now);
    const isBackupWindow = nowDate.getUTCHours() === 2 && nowDate.getUTCMinutes() < 15;
    ctxExec.waitUntil(
      (async () => {
        await pruneSessions(env, now);
        await pruneIdempotency(db(env) as never, now);
        for (const tenantId of await allTenants(env)) {
          // One tenant's bad tick must not starve every tenant after it — a
          // persistent failure here would otherwise stop the whole fleet's
          // outbox, renewals and schedules indefinitely.
          try {
            const ctx = await ctxFor(
              env,
              {
                tenantId,
                locale: "en",
                actor: { kind: "system", id: "scheduler", tenantId, grants: [] },
                // The tenant's own policy — its pause switches, timezone,
                // currency, auto-approvals — with every module it did not buy
                // or switched off forced off (ADR-0087): their sweeps and
                // consumers stand down with their routes. The outbox, billing
                // and platform jobs are the platform, not a module.
                ...(await scheduledConfig(env, tenantId))
              },
              now
            );
            await drainOutbox(ctx, env.EVENTS);
            const on = (module: string) => moduleEnabled(ctx.policy, module);
            // Cover starts, lapses and ends on the clock, not on a request. Runs
            // before the renewal sweep so a policy that expired this tick is in
            // the right state when renewals look at it.
            if (on("axis")) await sweepPolicyLifecycle(ctx);
            // Collect due instalments and detect dunning cascades before renewals
            // look at this tenant's policies this tick.
            await sweepPremiumFinancing(ctx);
            if (on("orbit")) await sweepRenewals(ctx, env.WF);
            // Conversations that missed their SLA clock get escalated and, if their
            // agent went quiet, requeued — before anything else touches assignment
            // state this tick.
            if (on("orbit")) await sweepRouting(ctx);
            // docs/27 F30. Walks every journey run whose wait has elapsed, whose
            // task has closed or whose quiet-hours deferral has lifted. After
            // sweepRouting, because a `task` node raises a conversation this
            // tick that the next tick's routing sweep should see.
            if (on("orbit")) await advanceJourneyRuns(ctx, 200, { env, gateway: gatewayFor(env) });
            await sweepBilling(ctx);
            if (on("signal")) await runBudgetAutopilot(ctx);
            // Acquisition outreach (engines/signal-outreach.ts): draft →
            // consent gate → approval gate → send → lead touch. Quiet hours
            // and the weekly frequency cap are enforced inside the sweep; the
            // tick is just the clock that runs it.
            if (on("signal")) await runAcquisitionSweep(ctx, gatewayFor(env));
            // A comparison past its validity lapses and says so; SIGNAL hears it
            // as a prospect (ADR-0091) on the next drain.
            if (on("dist")) await expireQuoteRequests(ctx);
            await runDueSchedules(ctx, env.FILES, env.BROWSER);
            // A delegation that has run out must stop showing as active, or every
            // admin screen lies about who currently holds the authority to approve.
            await expireDelegations(ctx);
            // docs/27 F7. Drafts the next reply for every conversation waiting
            // on us, so the inbox opens with something to approve instead of a
            // blank box. Draft only — nothing is sent without a human.
            if (on("orbit")) await sweepConversationDrafts(ctx, gatewayFor(env));
            // QA agent (engines/orbit-qa.ts): score closed conversations that
            // have no QA score yet — docs/modules/orbit.md §2.1's "scores 100%
            // of conversations", fed by the cx-judge rubric.
            if (on("orbit")) await sweepQaScores(ctx, gatewayFor(env));
            // docs/10 §6: nightly D1 -> R2 backup, one write per tenant per day.
            if (isBackupWindow) await backupTenant(ctx, env.EXPORTS);
            // docs/12 §1: tamper evidence for the audit chain, pinned outside D1.
            if (isBackupWindow) {
              const anchored = await anchorAudit(ctx, env.EXPORTS);
              // A break means a row changed after it was written. Nothing here
              // can repair it; what it must not do is pass unnoticed.
              if (anchored?.breaks.length) {
                console.error("audit chain broken", { tenantId, breaks: anchored.breaks });
              }
            }
            if (isBackupWindow) await nudgeApiKeyRotation(ctx);
            // docs/modules/north.md §3 Snapshotter: nightly, 02:00Z per seed.ts's timing model (ADR-0024).
            if (isBackupWindow && on("north")) await runSnapshotter(ctx);
            // docs/30 NORTH gap 1: yesterday's brief, drafted from the snapshot
            // just taken. Once per date; published only by a person.
            // A model refusal or kill switch costs tonight's draft, not the rest of the tick.
            if (isBackupWindow && on("north")) {
              await nightlyBriefing(ctx, gatewayFor(env)).catch((err: unknown) =>
                console.error("nightly briefing failed", { tenantId, err: String(err) })
              );
            }
            // docs/modules/scout.md §3. Harvester "schedules per source" and
            // Bench Builder "nightly" run in the same window; the Clusterer is
            // weekly, so it gates on the day as well as the hour. All three are
            // idempotent, so a tick that runs twice writes the same rows — and
            // the harvest takes a week's lookback rather than the route's six
            // months, because only the first run would ever need the rest.
            if (isBackupWindow && on("scout")) {
              await harvestSignals(ctx, gatewayFor(env), env, { lookbackMs: 7 * 86_400_000 });
              // docs/30 SCOUT gap 3: urgent watch findings, over what was just
              // harvested, reach the SCOUT leads.
              await notifyUrgentWatch(ctx, (await runWatch(ctx)).findings);
              await sweepPanelBench(ctx);
              if (nowDate.getUTCDay() === 1) await sweepSignalClusters(ctx, gatewayFor(env), env);
            }
            // docs/12 §4 / docs/13 §3.5, docs/27 F47: re-score a sample of this
            // week's real traffic against the deterministic gates, per locale,
            // so a model or prompt that drifted is visible beside the eval suite
            // it drifted from. Offered a tick a night; the sweep's own week
            // guard is what makes it weekly, so the cadence lives with the job
            // rather than in the shape of this condition.
            if (isBackupWindow) await sweepAiDrift(ctx);
          } catch (err) {
            console.error("scheduled tick failed for tenant", {
              tenantId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      })()
    );
  }
};

export { app };
// wrangler resolves a `durable_objects` binding's `class_name` against an
// export of this Worker's main module — docs/16 H3 / docs/10 §2.
export { AgentRoom } from "./engines/agent-room.js";
export { RateCounter } from "./engines/rate-counter.js";
export { UserChannel } from "./engines/user-channel.js";
export { RenewalWorkflow } from "./engines/renewal-workflow.js";
