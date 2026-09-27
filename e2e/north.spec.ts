import { expect, test } from "@playwright/test";
import { dayKey } from "@lyra/core";
import { expectNoA11yViolations } from "./a11y.js";
import { goto, loginAsNorthExec } from "./fixtures.js";

// J-E1 "The 7am read (mobile)" (docs/06-roles-and-journeys.md §Executive): a
// north.exec opens the already-published briefing on a phone, reads it in
// under two minutes, then taps the anomaly it calls out and assigns an action
// against it — done before the rest of the day starts.
//
// north.exec holds north:briefings:read (not generate/approve) and
// north:anomalies:assign — so the read half of this journey is the seeded
// jan05En briefing (packages/core/src/seed.ts) and the "tap anomaly, assign
// action" half is the seeded cac_per_policy anomaly, still in state "new".
test("J-E1 exec reads the morning briefing on a phone and assigns an action on the anomaly it flags @journey:J-E1 @accept:M6", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsNorthExec(page);

  await goto(page, "/north/briefings");
  // Both the "exec en" and "exec ar" variants of the same day's briefing are
  // seeded (packages/core/src/seed.ts), so the row match has to pin down the
  // English one specifically or Playwright's strict mode rejects the
  // ambiguity.
  // The kind column reads as words now (core `humanise`), so the row says
  // "Executive", not the stored `exec`.
  // The seed clock is the clock the database was seeded on, so the briefing
  // date moves with it: yesterday, whenever `pnpm e2e` runs.
  const yesterday = dayKey(Date.now(), -1);
  const briefingRow = page.getByRole("row", { name: new RegExp(`${yesterday} Executive en`) });
  await expect(briefingRow).toBeVisible();
  await expect(briefingRow.getByText("Published")).toBeVisible();
  await briefingRow.getByRole("link", { name: yesterday }).click();
  await expect(page.getByRole("heading", { name: yesterday, level: 1 })).toBeVisible();
  await expectNoA11yViolations(page);

  // Anomalies is a card queue now (docs/modules/north.md §4 screen 3), not a
  // record list: no row to open, the decision is on the card itself. The card
  // is titled by the metric's display name, so it says "Acquisition cost per
  // policy" rather than the stored `cac_per_policy` key.
  await goto(page, "/north/anomalies");
  const card = page.locator("section").filter({ hasText: "Acquisition cost per policy" });
  await expect(card).toBeVisible();

  // "Take it on" is the assign close: it writes state=action_created with the
  // reader's name against it, and the linked reference is the action itself.
  await card.getByLabel("Your name", { exact: true }).fill("Hala Zayed");
  await card.getByLabel("Linked work", { exact: true }).fill("J-E1-follow-up");
  await card.getByRole("button", { name: "Take it on" }).click();
  await expect(page.getByRole("status")).toHaveText("Recorded as yours.");
  // The reload behind the banner is the proof it persisted: the card's badge
  // has moved off "Unowned".
  await expect(card.getByText("Being worked")).toBeVisible();
});

// J-E3 "What-if" (docs/06-roles-and-journeys.md §Executive): a north.exec asks
// a scenario question, gets ranges and assumptions back, saves it, and later
// revisits it at the review date with actuals overlaid on the same record.
//
// north.exec holds north:scenarios:run for both create and update, so
// "revisit ... with actuals overlay" is modelled here as editing the saved
// scenario's assumptions once results are in — the only write this journey's
// persona can make against a scenario record.
test("J-E3 exec saves a what-if scenario and revisits it with updated assumptions @journey:J-E3 @accept:M6", async ({ page }) => {
  await loginAsNorthExec(page);

  const question = `J-E3-${Date.now()} What if renewal retention drops 5pt next quarter?`;
  await goto(page, "/north/scenarios");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Question*", { exact: true }).fill(question);
  await page
    .getByLabel("Assumptions*", { exact: true })
    .fill(JSON.stringify({ retentionDeltaPts: -5, horizon: "Q3" }));
  await page.getByLabel("Author*", { exact: true }).fill("Hala Zayed");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const row = page.getByRole("row", { name: new RegExp(question.slice(0, 30)) });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: question }).click();

  // Revisit at the review date: the assumptions are updated with what actually
  // happened, on the same saved scenario rather than a new one.
  await page
    .getByLabel("Assumptions", { exact: true })
    .fill(JSON.stringify({ retentionDeltaPts: -5, horizon: "Q3", actualDeltaPts: -3.2 }));
  const saveButton = page.getByRole("button", { name: "Save changes" });
  await saveButton.click();
  // Button.loading sets aria-busy/disabled for the life of the submission
  // (packages/ui/src/primitives.tsx) — wait for that round-trip to actually
  // finish before reloading, or the reload races the in-flight PATCH and
  // cancels it before the server ever sees the new assumptions.
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toBeEnabled();
  // Scenarios have no declared action (no "Saved" toast) and "assumptionsJson"
  // is not one of the dl's own columns, so the edit form's own uncontrolled
  // textarea can't prove persistence either — it would still show what we
  // just typed even if the POST failed. Reload to force a fresh loader read
  // and confirm the actuals overlay actually reached the server.
  await page.reload();
  await expect(page.getByLabel("Assumptions", { exact: true })).toHaveValue(/actualDeltaPts/);
});

// J-E2 "Board Thursday" (docs/06-roles-and-journeys.md §Executive): assemble
// the board pack, approve it, distribute it, and see read receipts before the
// meeting.
//
// Only "assemble" is wired up anywhere in apps/web: boardpacks.ts declares
// create ("north:boardpacks:generate") and no update and no actions array.
// (The ActionSpec mechanism itself does have real users now — modules
// /analytics.ts:422, modules/axis.ts:707 and :804 — boardpacks is simply not
// one of them.) So there is still no approve button and no distribute button;
// north-board.tsx does render the distribution log ("Who it went to"), but
// only recipient, medium and send time — `Delivery.openedAt` is declared and
// never drawn, so there is no read receipt to test either. This spec covers
// what exists, and the report notes the rest as a gap, not a fake pass.
test("J-E2 exec assembles a board pack for Thursday @journey:J-E2 @accept:M6", async ({ page }) => {
  await loginAsNorthExec(page);

  const title = `J-E2 Board pack ${Date.now()}`;
  await goto(page, "/north/boardpacks");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Title*", { exact: true }).fill(title);
  await page.getByLabel("Period*", { exact: true }).fill("2026-Q1");
  await page
    .getByLabel("Sections*", { exact: true })
    .fill(JSON.stringify([{ heading: "Highlights", body: "GWP up, CAC down." }]));
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible();
});

// The other half of J-E3, on the screen the journey actually describes: the
// what-if ask bar at /north/whatif (apps/web/app/routes/north-whatif.tsx),
// where assumptions are written as prose lines rather than as the raw JSON
// the generic /north/scenarios form takes. These assumptions name no driver the
// scenario engine reads (docs/30 NORTH 4, ADR-0103), so saving stores the
// question unanswered and the screen says so instead of drawing a band.
test("J-E3 exec asks a what-if in prose and the assumptions come back on the saved scenario @journey:J-E3 @accept:M6", async ({
  page
}) => {
  await loginAsNorthExec(page);
  await goto(page, "/north/whatif");

  // A line with no name is refused, not silently dropped — the assumptions are
  // the half of the scenario that can be argued with later.
  await page.getByLabel("The question", { exact: true }).fill("J-E3 what if the panel took a fifth of motor?");
  await page.getByLabel("Assumptions", { exact: true }).fill("no name on this line");
  await page.getByLabel("Asked by", { exact: true }).fill("Hala Zayed");
  await page.getByRole("button", { name: "Save the question", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("One of these lines carried no name.");

  const horizon = `Q3-${Date.now()}`;
  await page.getByLabel("Assumptions", { exact: true }).fill(`horizon: ${horizon}\nretentionDeltaPts: -5`);
  await page.getByRole("button", { name: "Save the question", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Scenario saved.");

  // The newest scenario is the open one, so the assumptions read back named and
  // humanised ("retentionDeltaPts" -> "Retention delta pts").
  await expect(page.getByRole("heading", { name: "What it assumes" })).toBeVisible();
  await expect(page.getByText(horizon, { exact: true })).toBeVisible();
  await expect(page.getByText("Retention delta pts", { exact: true })).toBeVisible();
  // The engine could not read these assumptions, so the answer says so rather
  // than showing a zero.
  await expect(page.getByText("Nothing has answered this yet.")).toBeVisible();
});
