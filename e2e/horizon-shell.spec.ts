import { expect, test } from "@playwright/test";
import { expectNoA11yViolations } from "./a11y.js";
import { goto, loginAsTenantAdmin } from "./fixtures.js";

// The Horizon shell's two structural promises (ADR-0031), neither of which a
// source-text unit test can see:
//
//   1. Every screen is reachable two ways — the persistent nav landmark and
//      ⌘K — which is what holds WCAG 2.2 SC 2.4.5 up without a sitemap page.
//   2. Every workspace signs itself with its module hue, drawn once at the top
//      of <main>, so the rail's marker and the screen's agree.

test("⌘K offers the same destinations as the rail, and opens one", async ({ page }) => {
  await loginAsTenantAdmin(page);

  await page.getByRole("banner").getByRole("button", { name: /Search/ }).click();
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();

  // The "Where" half: destinations before anything is typed, under their own
  // announced heading rather than mixed in with records.
  const destinations = palette.getByRole("group", { name: "Go to" });
  await expect(destinations).toBeVisible();
  await expect(destinations.getByRole("option", { name: "Operations", exact: true })).toBeVisible();

  // Typing filters them; the workspace the query names survives, the others go.
  await palette.getByRole("combobox").fill("ledger");
  await expect(destinations.getByRole("option", { name: "Ledger", exact: true })).toBeVisible();
  await expect(destinations.getByRole("option", { name: "Operations", exact: true })).toHaveCount(0);

  await expectNoA11yViolations(page);

  await destinations.getByRole("option", { name: "Ledger", exact: true }).click();
  await page.waitForURL(/\/ledger/);
  await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();
});

test("every screen carries the hue of the workspace it belongs to", async ({ page }) => {
  await loginAsTenantAdmin(page);

  const hue = async () =>
    page.evaluate(() => {
      const rule = document.querySelector("#workspace > span[aria-hidden='true']");
      return rule ? getComputedStyle(rule).backgroundColor : null;
    });

  await goto(page, "/axis");
  const axis = await hue();
  await goto(page, "/orbit");
  const orbit = await hue();
  await goto(page, "/admin");
  const shared = await hue();

  // Not a hex assertion: the values live in tokens.css and a tenant may swap
  // the accent. What must hold is that two modules never sign themselves the
  // same way, and that a shared surface signs itself with neither module's.
  for (const value of [axis, orbit, shared]) expect(value).toMatch(/^rgba?\(/);
  expect(axis).not.toBe(orbit);
  expect(shared).not.toBe(axis);
  expect(shared).not.toBe(orbit);
});
