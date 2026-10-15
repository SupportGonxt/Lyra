import type {
  WorkflowEntrypoint as WorkflowEntrypointType,
  WorkflowEvent,
  WorkflowStep
} from "cloudflare:workers";
import { EntitlementsJson, PolicyJson } from "@lyra/db";
import { ctxFor } from "../auth.js";
import type { Env } from "../env.js";
import {
  renewalDay0,
  renewalDay21Escalate,
  renewalDay7Followup,
  renewalExpireIfUndecided,
  type RenewalWorkflowParams
} from "./renewal-campaign.js";

const { WorkflowEntrypoint } = (await import("cloudflare:workers").catch(
  () => import("./cloudflare-workers.stub.js")
)) as { WorkflowEntrypoint: typeof WorkflowEntrypointType };

// docs/10 §2 `WF` binding. day-0/7/21/30 cadence for a raised orbit_renewals
// row (sweepRenewals, renewals.ts, creates one instance per row). A Workflow
// instance can hibernate for days between `step.sleep` calls, so each step
// builds its own Ctx off `Date.now()` rather than closing over one built at
// `run()` entry.
export class RenewalWorkflow extends WorkflowEntrypoint<Env, RenewalWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<RenewalWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const { tenantId, renewalId } = event.payload;
    const freshCtx = () =>
      ctxFor(
        this.env,
        {
          tenantId,
          locale: "en",
          actor: { kind: "system", id: "renewal-workflow", tenantId, grants: [] },
          policy: PolicyJson.parse({}),
          entitlements: EntitlementsJson.parse({})
        },
        Date.now()
      );

    // `this.env` is what makes the day-0 step **price** the renewal rather than only
    // open it: without it the re-quote engine is reachable but never reached, which is
    // the dead-seam shape this wiring exists to avoid.
    const day0 = await step.do("day-0-offer", async () => renewalDay0(await freshCtx(), renewalId, this.env));
    if (day0.done) return;

    await step.sleep("wait-7-days", "7 days");
    const day7 = await step.do("day-7-followup", async () => renewalDay7Followup(await freshCtx(), renewalId));
    if (day7.done) return;

    await step.sleep("wait-14-more-days", "14 days");
    const day21 = await step.do("day-21-escalate", async () => renewalDay21Escalate(await freshCtx(), renewalId));
    if (day21.done) return;

    await step.sleep("wait-9-more-days", "9 days");
    await step.do("day-30-expire", async () => renewalExpireIfUndecided(await freshCtx(), renewalId));
  }
}
