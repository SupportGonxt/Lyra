import { expect, test } from "@playwright/test";
import { goto, loginAsScoutLead, loginAsNorthExec, expectModuleRail } from "./fixtures.js";
import { SCOUT_SCREENS } from "../apps/web/app/modules/screens.js";

// @journey:J-P1 — where J-P1 radar quarterly is worked
// (docs/06-roles-and-journeys.md:73, docs/superpowers/specs/2026-08-16-scout-shell-fork-design.md):
// ScoutShell is its own scoped shell — an actor with a scout.*-resolving role
// lands in it and sees only SCOUT's own rail (never another module's,
// ModuleSwitcher only appears once an actor's roles resolve to more than one
// shell, which scout.lead's single role never does), and an actor without one
// gets 403 (not 401 — bootstrapSession already proved who they are, they are
// just not entitled to this shell: scout-shell.tsx's loader). No Meridian —
// ADR-0061 is explicit that Meridian is NORTH-only.

test("scout.lead lands in the one frame, led by SCOUT's own screens (ADR-0085)", async ({ page }) => {
  await loginAsScoutLead(page);
  await goto(page, "/scout/radar");
  // Every SCOUT screen this role may use, none it may not, and no other
  // module's screens: those are reached through the workspace list below.
  await expectModuleRail(page, "scout.lead", SCOUT_SCREENS, ["/north/brief", "/orbit/console"]);
});


test("an actor with no scout.*-resolving role gets 403, not 401, on /scout/*", async ({ page }) => {
  await loginAsNorthExec(page);
  const response = await page.goto("/scout/radar");
  expect(response?.status()).toBe(403);
});
