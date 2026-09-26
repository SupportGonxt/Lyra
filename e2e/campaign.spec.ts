import { expect, test } from "@playwright/test";
import {
  chooseOption,
  goto,
  loginAsComplianceOfficer,
  loginAsScoutLead,
  loginAsSignalLead,
  shortRef
} from "./fixtures.js";

// J-M1 "campaign in a day" (docs/06-roles-and-journeys.md:66-67): "brief -> 20
// ar/en variants -> compliance lane -> publish -> cockpit shows CAC by
// evening." The acceptance test this journey actually has
// (apps/api/src/journeys.test.ts:808-851) is three `it`s, none of which touch
// creatives at all:
//
//   1. a growth lead authors an audience and a draft campaign.
//   2. going live is auto-approved by *this* tenant's policy
//      (packages/core/src/seed.ts:154, `autoApprove: ["signal.campaign_launch"]`)
//      but still writes to the audit log.
//   3. a marketer without the launch permission is refused.
//
// The docs' "20 ar/en variants" and "compliance lane" are outside this
// acceptance test's scope, but both do have a UI now: the studio
// (apps/web/app/routes/signal-studio.tsx) generates `count` variants across
// the ticked `locales` in one submit, and clears or blocks each one
// ("clear-variant" -> passed, "discard-variant" -> blocked) — that lane is
// still gated on a different permission (signal:creatives:approve) than the
// launch this test exercises. Per CLAUDE.md's TDD rule, the test matches the
// journeys.test.ts scope, not the docs' prose; creatives are not touched here,
// and the cockpit half of the journey is the last test in this file.
//
// Two further, real gaps in what the UI can reach:
//   - The campaign create form's `objective` select only offers
//     ["acq", "renewal", "xsell"] (signal.ts:274-279) — the acceptance test's
//     own objective, "retention", is not one of them (the API's column has no
//     enum constraint, so the test can type anything; the UI cannot). "renewal"
//     is used here as the nearest of the three real options.
//   - `it 3`'s actor is `scout.lead`, who holds zero `signal:*` permissions at
//     all (packages/core/src/rbac.ts) — not just the launch permission. A UI
//     visit to any `/signal/campaigns` URL is refused by the *read* permission
//     before a launch is ever attempted, which is a superset of the API test's
//     specific PATCH-is-403 assertion, not a narrower one.
test("J-M1 a growth lead authors an audience and campaign, then launches it (auto-approved, audited) @journey:J-M1 @accept:M4", async ({
  page
}) => {
  await loginAsSignalLead(page);

  const suffix = Date.now();
  const audienceName = `Motor renewals, 30 days ${suffix}`;

  // audiences has no `searchable` columns (apps/api/src/resources.ts) — `?q=`
  // is rejected with 400 — so the fresh row is located by its unique name in
  // the unfiltered (well under page-size) list, same as save-desk/scout-
  // whitespace/signal-budget do for their own non-searchable resources.
  await goto(page, "/signal/audiences");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Name*", { exact: true }).fill(audienceName);
  await page
    .getByLabel("Definition*", { exact: true })
    .fill(JSON.stringify({ all: [{ field: "tagsJson", op: "contains", value: "renewals" }] }));
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const audienceRow = page.getByRole("row", { name: new RegExp(audienceName) });
  await expect(audienceRow).toBeVisible();
  await audienceRow.getByRole("link").first().click();
  // Client-side <Link> navigation (pushState, no full load) — wait for the URL
  // to actually change before reading it, or this races the router.
  await page.waitForURL(/\/signal\/audiences\/.+/);
  const audienceId = page.url().split("/").pop()!;

  const campaignName = `Renewal save ${suffix}`;

  // campaigns *is* searchable (resources.ts: searchable: ["name"]), so the
  // fresh row is located with `?q=` instead of scanning an unfiltered list.
  await goto(page, "/signal/campaigns");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Name*", { exact: true }).fill(campaignName);
  // A Radix combobox (packages/ui/src/primitives.tsx Select), not a native
  // <select> — selectOption doesn't apply; chooseOption picks it the keyboard
  // way, which does not race the popper (e2e/fixtures.ts).
  await chooseOption(page, "Objective*", "Renewal");
  await page.getByLabel("Audience", { exact: true }).fill(audienceId);
  await page.getByLabel("Channels*", { exact: true }).fill(JSON.stringify(["email", "whatsapp"]));
  await page.getByLabel("Budget*", { exact: true }).fill(JSON.stringify({ dailyMinor: 50_000 }));
  await page.getByLabel("Owner*", { exact: true }).fill("noor.jamal@gonxt.ae");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const campaignRow = page.getByRole("row", { name: new RegExp(campaignName) });
  await expect(campaignRow).toBeVisible();
  await campaignRow.getByRole("link").first().click();
  await page.waitForURL(/\/signal\/campaigns\/.+/);
  const recordUrl = page.url();
  const campaignId = recordUrl.split("/").pop()!;

  // Defaulted server-side (schema.campaigns.state.default("draft")), never
  // typed into the create form (state is editable-only, signal.ts:284-292).
  await expect(page.locator("dl").getByText("Draft", { exact: true })).toBeVisible();

  // Going live: signal.campaign_launch sits on this tenant's auto_approve
  // allowlist, so gate() clears the write immediately — no trip through
  // /approvals — but crud.ts's update handler audits every write regardless.
  await chooseOption(page, "State", "Live");
  // record.tsx's edit <Form> submit only waits for the click event, not the
  // async action/revalidation — React Router v7's client fetcher posts to
  // "<path>.data" (not the bare path); wait for that response before reading
  // persisted state back, exactly as signal-budget.spec.ts does.
  await Promise.all([
    page.waitForResponse((res) => res.url() === `${recordUrl}.data` && res.request().method() === "POST"),
    page.getByRole("button", { name: "Save changes" }).click()
  ]);

  await goto(page, recordUrl);
  await expect(page.locator("dl").getByText("Live", { exact: true })).toBeVisible();

  // Still audited: only tenant.compliance holds `core:audit:read` (signal.lead
  // does not — packages/core/src/rbac.ts), so the same journeys.test.ts:843
  // check is made through that persona's own reachable screen. The audit row's
  // `action` and `subjectRef` columns are raw stored strings (plain `text`
  // columns, never translated), so they read the same in this persona's
  // Arabic locale as they would in English.
  await loginAsComplianceOfficer(page);
  await goto(page, "/admin/audit-log");
  await expect(
    page.getByRole("row", { name: new RegExp(`signal\\.campaigns\\.update.*${shortRef(campaignId)}`) })
  ).toBeVisible();
});

test("J-M1 a marketer without the launch permission is refused the whole campaigns screen @journey:J-M1 @accept:M4", async ({ page }) => {
  await loginAsScoutLead(page);

  await goto(page, "/signal/campaigns");
  // scout.lead holds no `signal:*` permission at all, so the read itself is
  // refused (root.tsx's ErrorBoundary renders the RFC 9457 status as prose,
  // apps/web/app/i18n/en.ts "error.forbidden") before a launch is ever tried.
  await expect(page.getByText("Your roles do not include access to this area.")).toBeVisible();
});

// The cockpit close of J-M1: "publish -> cockpit shows CAC by evening"
// (docs/06-roles-and-journeys.md:66-67), on /signal/cockpit. CAC is derived,
// not stored — signal.shared.ts's cacMinor(spend, binds) is null when nothing
// bound — so what the figure has to be is checked against the binds figure
// beside it rather than against a number baked into this spec.
test("J-M1 the growth cockpit shows CAC for the window @journey:J-M1 @accept:M4", async ({ page }) => {
  await loginAsSignalLead(page);

  // The widest window the cockpit offers, so the seeded year of spend and
  // binds is inside it (signal.shared.ts WINDOWS).
  await goto(page, "/signal/cockpit?days=90");

  // KPIWall is a plain grid div (packages/ui/src/data.tsx) with no accessible
  // name, so its inline template is what pins the reads to the wall rather than
  // to a table cell that happens to say the same word. Stat draws the label
  // span and then the value span, so the value is the label's next sibling.
  const wall = page.locator("div[style*='auto-fill']");
  const stat = (label: string) => wall.getByText(label, { exact: true }).locator("xpath=following-sibling::span[1]");
  await expect(stat("Spent this window")).toBeVisible();
  const binds = Number((await stat("Signed").innerText()).replace(/[^0-9]/g, ""));
  const cac = stat("Cost per acquisition");
  if (binds > 0) {
    // Money, so it carries digits — "Not enough data yet" would not.
    await expect(cac).toHaveText(/[0-9]/);
  } else {
    await expect(cac).toHaveText("Not enough data yet");
  }
});
