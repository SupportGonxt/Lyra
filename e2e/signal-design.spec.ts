import { expect, test } from "@playwright/test";
import { goto, loginAsSignalLead } from "./fixtures";

// ST2 (@accept:ST): a cleared variant is laid out at every size, and a
// designer adjusts one on the canvas by keyboard alone and saves it — the
// accessible path, which is also the one a test can drive without guessing
// pixel positions.

test("a growth lead edits a creative's design on the canvas and saves it @accept:ST", async ({ page }) => {
  await loginAsSignalLead(page);
  // The seeded always-on search campaign carries cleared variants
  // (packages/core/src/seed/signal.ts); the campaigns list links its studio.
  await goto(page, "/signal/campaigns");
  await page.getByRole("link", { name: "Motor — always-on search" }).first().click();
  await page.waitForURL(/\/signal\/campaigns\/[^/?]+$/);
  const campaignId = new URL(page.url()).pathname.split("/").at(-1)!;
  await goto(page, `/signal/studio?campaignId=${campaignId}`);

  const art = page.locator("figure").filter({ hasText: "How it will look" }).first();
  await expect(art).toBeVisible();
  await expect(art.getByText("Email header")).toBeVisible();

  await art.getByRole("button", { name: "Edit" }).first().click();
  await art.getByRole("button", { name: "headline", exact: true }).click();
  const canvas = art.getByRole("application");
  await canvas.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("+");
  await art.getByRole("button", { name: "Save design" }).click();
  await expect(art.getByRole("status")).toHaveText("Design saved.");
});
