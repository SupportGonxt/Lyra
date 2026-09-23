import { expect, test } from "@playwright/test";
import { goto, loginAsAxisLead, loginAsFinanceController } from "./fixtures.js";

// @journey:J-CENTER — the command center (ADR-0073, docs/superpowers/specs/
// 2026-08-22-command-center-design.md §A4):
// the surface renders the hero wall and constellation, AI artifacts carry the
// ✦ mark, and the feed degrades honestly for an actor who holds no
// ai:command:read — a closed door, not a crash.

test("axis.lead sees the command center with hero, constellation and ask box", async ({
  page
}) => {
  await loginAsAxisLead(page);
  await goto(page, "/center");

  // The Horizon header signs the surface.
  await expect(page.getByRole("heading", { level: 1, name: /command center/i })).toBeVisible();

  // The ask box is the loop's front door.
  await expect(page.getByRole("textbox", { name: /put the loop to work/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^run$/i })).toBeVisible();

  // The constellation names the five shells. Scoped to main: the rail's own
  // nav.axis label is also "Operations" and sits truncated in the sidebar.
  const main = page.getByRole("main");
  for (const shell of ["Operations", "Conversations", "Marketing", "Market", "Insight"]) {
    await expect(main.getByText(shell, { exact: true })).toBeVisible();
  }

  // The feed states its empty-or-listed state honestly either way.
  const feed = page.getByRole("heading", { name: /waiting for a decision/i });
  await expect(feed).toBeVisible();
});

test("an actor without ai:command:read gets a closed door, not a crash", async ({
  page
}) => {
  await loginAsFinanceController(page);
  // finance.controller holds no ai:command:read (money roles stay out of the
  // loop's governance), so the loader's proposals call 403s and readable()
  // degrades to empty — the page still renders its shell.
  await goto(page, "/center");
  await expect(page.getByRole("heading", { level: 1, name: /command center/i })).toBeVisible();
});
