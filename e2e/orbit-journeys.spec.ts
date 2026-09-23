import { expect, test } from "@playwright/test";
import { and, asc, eq } from "drizzle-orm";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { makeLibsqlDb } from "@lyra/db/libsql";
import type { Ctx } from "@lyra/core";
import { sweepRenewals } from "../apps/api/src/engines/renewals.js";
import { LIBSQL_URL, TENANT_SLUG } from "./env.js";
import {
  chooseOption,
  goto,
  loginAsAxisLead,
  loginAsOrbitAgent,
  loginAsOrbitRetention,
  shortRef
} from "./fixtures.js";

// J-C2 "help on WhatsApp" (docs/06-roles-and-journeys.md): a customer message
// lands, the AI drafts a reply as ghost text, the agent approves it in one
// click and it queues as an AI turn — it does not leave on its own
// (CLAUDE.md §11, ambient AI grammar). Matches journeys.test.ts:279-321's
// shape (POST conversation, POST customer message, an AI turn), but drives it
// through apps/web/app/routes/conversation.tsx instead of the raw AI-run
// endpoint, since that page is where the draft/approve UI actually lives.
//
// Conversation and both messages are seeded through the real "New"
// panels (same idiom as handover.spec.ts) — a raw page.request call shares no
// cookies with the API origin (apps/web/app/api.server.ts's apiFetch forwards
// the browser's cookie header itself; a direct API-origin request bypasses
// that and 401s).
test("J-C2 an agent approves the AI's suggested reply and it queues, not sends @journey:J-C2 @accept:M3", async ({ page }) => {
  await loginAsOrbitAgent(page);

  const customerId = `cus-e2e-jc2-${Date.now()}`;
  await goto(page, "/orbit/conversations");
  await page.locator("summary", { hasText: "New" }).click();
  // Radix combobox, not a native <select> — chooseOption picks it from the
  // keyboard rather than racing the popper (e2e/fixtures.ts).
  await chooseOption(page, "Channel*", "WhatsApp");
  await page.getByLabel("Customer", { exact: true }).fill(customerId);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const convRow = page.getByRole("row", { name: new RegExp(customerId) });
  await expect(convRow).toBeVisible();
  await convRow.getByRole("link").first().click();
  await page.waitForURL(/\/orbit\/conversations\/[^/]+$/);
  const conversationId = page.url().split("/").pop()!;

  await goto(page, "/orbit/messages");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Conversation*", { exact: true }).fill(conversationId);
  await chooseOption(page, "Sender*", "Customer");
  await page.getByLabel("Message*", { exact: true }).fill("Is my windscreen covered?");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Message content is PII-masked in this list view ("[redacted]"), so match
  // on the conversation id column instead of the text just typed in.
  await expect(page.getByRole("row", { name: new RegExp(shortRef(conversationId)) }).first()).toBeVisible();

  // A successful create clears and closes the panel (module.tsx's
  // CreatePanel) so the same row cannot be sent twice; open it again for the
  // AI draft.
  await page.locator("summary", { hasText: "New" }).click();
  const draftContent =
    "Yes — windscreen is covered under your comprehensive add-on, subject to the excess.";
  // No deliveryStatus field on this panel: conversation.tsx's loader only
  // renders the last agent_ai message as a draft when it has none yet
  // (apps/web/app/routes/conversation.tsx:175-207).
  const conversationInput = page.getByLabel("Conversation*", { exact: true });
  await conversationInput.fill(conversationId);
  await chooseOption(page, "Sender*", "AI agent");
  await page.getByLabel("Message*", { exact: true }).fill(draftContent);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Unlike the first create, nothing here waits on the result before this test
  // navigates away — without a wait, the client-side POST races page.goto and
  // can get cancelled mid-flight, silently dropping the draft message.
  await expect(page.getByRole("row", { name: new RegExp(shortRef(conversationId)) })).toHaveCount(2);

  await goto(page, `/orbit/conversations/${conversationId}/thread`);

  const draftSection = page.getByRole("region", { name: "Suggested reply" });
  await expect(draftSection).toBeVisible();
  await expect(draftSection.getByText(draftContent)).toBeVisible();

  await draftSection.getByRole("button", { name: "Approve and queue" }).click();

  await expect(
    page.getByRole("status").getByText("Draft approved and queued as an AI turn. It has not left yet.")
  ).toBeVisible();
});

/**
 * orbit_renewals has no `create` permission and there's no UI trigger for the
 * nightly sweep — a renewal is raised by `sweepRenewals` on a schedule, never
 * by hand (apps/api/src/routes/orbit.ts). Playwright's page.request can't
 * authenticate against the API origin either (see J-C2's comment above), so
 * this calls the real engine function directly against the e2e DB, the same
 * "reach past the UI/API via direct DB access" idiom global-setup.ts already
 * uses for its own fixture resets. Only db/tenantId/now are actually read by
 * sweepRenewals; the rest of Ctx is unused stub filler.
 */
async function runRenewalsSweep(): Promise<string> {
  const db = makeLibsqlDb(LIBSQL_URL);
  const [tenant] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, TENANT_SLUG));
  if (!tenant) throw new Error(`no tenant with slug ${TENANT_SLUG}`);

  // Every fixture date hangs off the clock the database was seeded on, which
  // is the moment `pnpm e2e` ran — not necessarily this moment. Read the
  // soonest-expiring active policy's own endAt and sweep as of that instant
  // rather than Date.now(), so the window check (endAt in [now, now+45d])
  // holds however long the seeded database has been sitting around.
  const [soonest] = await db
    .select({ endAt: schema.axisPolicies.endAt })
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, tenant.id), eq(schema.axisPolicies.status, "active")))
    .orderBy(asc(schema.axisPolicies.endAt))
    .limit(1);
  if (!soonest) throw new Error("no active policy to raise a renewal from");

  await sweepRenewals({
    db: db as unknown as Ctx["db"],
    tenantId: tenant.id,
    actor: { kind: "system", id: "e2e-sweep", tenantId: tenant.id, grants: [] },
    requestId: "e2e-sweep",
    now: soonest.endAt,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  });

  // The renewals table shows the customer by name now (apps/api/src/routes
  // /names.ts resolves refs for every list), so the id the NBO page needs
  // cannot be read off the row — take it from the renewal the sweep just made.
  const [renewal] = await db
    .select({ customerId: schema.orbitRenewals.customerId })
    .from(schema.orbitRenewals)
    .where(eq(schema.orbitRenewals.tenantId, tenant.id))
    .orderBy(asc(schema.orbitRenewals.expiryAt))
    .limit(1);
  if (!renewal?.customerId) throw new Error("sweep raised no renewal to work from");
  return renewal.customerId;
}

// J-C3 "one-tap renewal": the nightly sweep raises a renewal, the retention
// desk scores next-best-offers for that customer, surfacing the offer is an
// override retention does not hold (axis.lead does it), then the renewal
// closes in one update. Mirrors journeys.test.ts:325-375's actor split
// exactly, through the retention queue (apps/web/app/modules/orbit.ts) and
// the NBO UI (apps/web/app/routes/dist-offers.tsx).
test("J-C3 retention proposes and closes a renewal; surfacing needs axis.lead @journey:J-C3 @accept:M3", async ({ page }) => {
  // The seeded demo customer already carries a policy inside the renewal
  // window (packages/core/src/seed/context.ts's `renewalPolicyId`), so this is
  // idempotent and safe to call from a clean seed.
  const customerId = await runRenewalsSweep();

  await loginAsOrbitRetention(page);
  await goto(page, "/orbit/renewals");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  const row = rows.first();

  await row.getByRole("link").first().click();
  await page.waitForURL(/\/orbit\/renewals\/[^/?]+$/);
  const renewalId = page.url().split("/").pop()!;

  // Propose next-best-offers for that customer. dist.ts's /propose route
  // gates on dist:offers:read (apps/web/app/routes/dist-offers.tsx's PERM.propose),
  // which orbit.retention holds, so this section renders for this actor.
  // The loader reads customerId off the query string and FieldInput takes it
  // as the field's row value (dist-offers.tsx:348-350) — already filled in.
  await goto(page, `/distribution/next-best-offers/suggest?customerId=${customerId}`);
  await expect(page.getByLabel("Customer*", { exact: true })).toHaveValue(customerId);
  await page.getByRole("button", { name: "Propose offers", exact: true }).click();
  await page.waitForURL(new RegExp(`customerId=${customerId}`));

  // Surfacing is dist:offers:surface — an override retention does not hold,
  // so the UI never renders the button for this actor (apps/web/app/routes
  // /dist-offers.tsx's canSurface gate), matching journeys.test.ts:363-367's
  // runtime 403 one step earlier.
  await expect(page.getByRole("button", { name: /Surface .*to the customer/ })).toHaveCount(0);

  await loginAsAxisLead(page);
  await goto(page, `/distribution/next-best-offers/suggest?customerId=${customerId}`);
  await page.getByRole("button", { name: /Surface .*to the customer/ }).first().click();
  await expect(page.getByText("Surfaced.")).toBeVisible();

  // Close the renewal. The vitest acceptance test (journeys.test.ts:370-375)
  // asserts state "renewed" via a direct PATCH, but that value is not one of
  // the module spec's real, UI-selectable options (apps/web/app/modules
  // /orbit.ts:351: scheduled|offered|accepted|lost) — a doc/test literal that
  // only passes because the column is untyped text with no runtime
  // validation. "Accepted" is the real one-tap close this UI offers.
  await loginAsOrbitRetention(page);
  await goto(page, `/orbit/renewals/${renewalId}`);
  await chooseOption(page, "State", "Accepted");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();

  await expect(page.getByText("Accepted", { exact: true }).first()).toBeVisible();
});
