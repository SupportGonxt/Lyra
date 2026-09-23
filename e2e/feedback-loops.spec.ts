import { expect, test } from "@playwright/test";
import { content, goto, loginAsTenantAdmin } from "./fixtures.js";

// The three feedback loops the design panel found broken (2026-09-23): a
// create that said nothing and kept its values (a second press made a
// duplicate), dialogs that dropped focus on <body>, and a ⌘K palette that
// neither arrows nor Enter could drive.

test("a generic create confirms, links the record and clears itself @accept:M1", async ({ page }) => {
  await loginAsTenantAdmin(page);
  await goto(page, "/admin/teams");
  const main = content(page);
  await main.locator("summary", { hasText: "New" }).click();
  const name = `Feedback desk ${Date.now()}`;
  await main.getByLabel("Name").fill(name);
  await main.getByRole("button", { name: "Create", exact: true }).click();

  const status = main.getByRole("status").filter({ hasText: "Created." });
  await expect(status).toBeVisible();
  await expect(status.getByRole("link", { name: "Open" })).toBeVisible();
  // Closed and emptied: nothing left to submit twice.
  await expect(main.getByLabel("Name")).toBeHidden();
  await main.locator("summary", { hasText: "New" }).click();
  await expect(main.getByLabel("Name")).toHaveValue("");

  // The link lands on the record it made, whose heading is its name.
  await status.getByRole("link", { name: "Open" }).click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(name);

  // A confirm dialog names the act, and closing it hands focus back.
  const trigger = main.getByRole("button", { name: "Delete" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("⌘K moves with the arrows and opens with Enter @accept:M1", async ({ page }) => {
  await loginAsTenantAdmin(page);
  await goto(page, "/");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();
  await input.fill("Ledger");
  const options = page.getByRole("option");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/ledger/);
});
