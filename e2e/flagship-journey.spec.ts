import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { content, goto, loginAsSignalLead, loginAsTenantAdmin } from "./fixtures.js";

// The flagship demo (docs/28-demo-run-sheet.md §2): Operations -> Insight ->
// Market -> Marketing (the AXIS/NORTH/SCOUT/SIGNAL modules), four API-backed
// routes, each carrying what it learned to the next in the URL.
//
// What a design audit found and this spec holds:
//  - the step list was four badges, not links, named with module codenames a
//    reader never sees anywhere else; now an ordered list of links, the
//    current one `aria-current="step"`, each carrying the journey's context;
//  - no step had an <h1> (axe `page-has-heading-one` on every /journey/*) and
//    the Market step's table scrolled with nothing focusable in it
//    (`scrollable-region-focusable`);
//  - the Market step always took the top whitespace, so the reader never chose
//    what the campaign would be drafted against;
//  - the Marketing step ended on generated copy with no next step, and printed
//    raw API titles (`subject_required`) as its errors.

const CODENAMES = /\b(AXIS|NORTH|SCOUT|SIGNAL)\b/;

/** One <h1>, and the two axe rules the journey used to fail. */
async function expectPageShape(page: Page): Promise<void> {
  await expect(content(page).locator("h1")).toHaveCount(1);
  const results = await new AxeBuilder({ page })
    .withRules(["page-has-heading-one", "scrollable-region-focusable"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

function journeyNav(page: Page) {
  return page.getByRole("navigation", { name: "Demo journey" });
}

test("the flagship journey walks Operations to Marketing, carrying its context @journey:FLAGSHIP", async ({ page }) => {
  await loginAsTenantAdmin(page);

  // Step 1 — Operations: the open case book by product line.
  await goto(page, "/journey/axis");
  await expectPageShape(page);
  const nav = journeyNav(page);
  await expect(nav.getByRole("listitem")).toHaveCount(4);
  await expect(nav.getByRole("link", { name: /Operations/ })).toHaveAttribute("aria-current", "step");
  await expect(nav).not.toContainText(CODENAMES);

  await content(page).getByRole("link", { name: /See the insight on/ }).click();
  await page.waitForURL(/\/journey\/north\?productLine=/);
  const productLine = new URL(page.url()).searchParams.get("productLine");
  expect(productLine).toBeTruthy();

  // Step 2 — Insight. There is no product-line filter on briefings, and the
  // screen says so rather than claiming the previous step "told it".
  await expectPageShape(page);
  await expect(journeyNav(page).getByRole("link", { name: /Insight/ })).toHaveAttribute("aria-current", "step");
  await expect(content(page)).toContainText(/not split by product line/);
  // Going back keeps what was learned.
  await expect(journeyNav(page).getByRole("link", { name: /Operations/ })).toHaveAttribute(
    "href",
    new RegExp(`productLine=${encodeURIComponent(productLine!)}`)
  );

  await content(page).getByRole("link", { name: /See where the market has gaps/ }).click();
  await page.waitForURL(/\/journey\/scout\?.*briefingId=/);
  expect(new URL(page.url()).searchParams.get("productLine")).toBe(productLine);

  // Step 3 — Market: the reader chooses the gap.
  await expectPageShape(page);
  await expect(journeyNav(page).getByRole("link", { name: /Market\b/ })).toHaveAttribute("aria-current", "step");
  const choices = content(page).getByRole("region", { name: "Choose a gap to act on" }).getByRole("link");
  await expect(choices.first()).toHaveAttribute("aria-current", "true");
  const pick = (await choices.count()) > 1 ? choices.nth(1) : choices.first();
  const pickedHref = await pick.getAttribute("href");
  const whitespaceId = new URL(pickedHref!, page.url()).searchParams.get("whitespaceId");
  expect(whitespaceId).toBeTruthy();
  await pick.click();
  await page.waitForURL(new RegExp(`whitespaceId=${whitespaceId}`));
  await expect(pick).toHaveAttribute("aria-current", "true");

  await content(page).getByRole("link", { name: /Draft a campaign for/ }).click();
  await page.waitForURL(/\/journey\/signal\?/);
  const signalUrl = new URL(page.url());
  expect(signalUrl.searchParams.get("whitespaceId")).toBe(whitespaceId);
  expect(signalUrl.searchParams.get("subject")).toBeTruthy();
  expect(signalUrl.searchParams.get("productLine")).toBe(productLine);

  // Step 4 — Marketing. The subject arrives filled in, and stepping back to
  // Market lands on the whitespace that was chosen, not the default.
  await expectPageShape(page);
  await expect(journeyNav(page).getByRole("link", { name: /Marketing/ })).toHaveAttribute("aria-current", "step");
  await expect(content(page).getByLabel("What the campaign is about")).toHaveValue(signalUrl.searchParams.get("subject")!);
  await expect(journeyNav(page).getByRole("link", { name: /Market\b/ })).toHaveAttribute(
    "href",
    new RegExp(`whitespaceId=${whitespaceId}`)
  );

  // The tenant administrator reads marketing but does not run it
  // (packages/core/src/rbac.ts: signal:*:read). Saving the draft is refused,
  // and the refusal is a sentence, not an API title.
  await content(page).getByRole("button", { name: "Save as draft campaign" }).click();
  const alert = content(page).getByRole("alert");
  await expect(alert).toContainText("Your roles do not let you do this step");
  await expect(alert).not.toContainText(/forbidden|_required/i);
});

test("the Marketing step ends in a draft campaign, never a launch @journey:FLAGSHIP", async ({ page }) => {
  await loginAsSignalLead(page);
  await goto(page, `/journey/signal?subject=${encodeURIComponent(`Flagship draft ${Date.now()}`)}`);
  await expectPageShape(page);

  // A draft carries no channel and no budget; the screen says nothing goes
  // live before the button is pressed, and after.
  const save = content(page).getByRole("button", { name: "Save as draft campaign" });
  await expect(content(page)).toContainText("Nothing goes live and nothing is sent.");
  await save.click();

  const saved = content(page).getByRole("status").filter({ hasText: "Saved as a draft" });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("Nothing is live and nothing was sent.");
  // Launching is the next step and it is approval-gated; this screen names the
  // gate and links to the campaign, where the launch lives.
  await expect(saved).toContainText("signal.campaign_launch");
  await expect(saved.getByRole("link", { name: "Open the campaign" })).toHaveAttribute(
    "href",
    /^\/signal\/campaigns\/cmp_/
  );
  await expect(saved.getByRole("link", { name: "Write more copy in the studio" })).toHaveAttribute(
    "href",
    /^\/signal\/studio\?campaignId=cmp_/
  );
});
