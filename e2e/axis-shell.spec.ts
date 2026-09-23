import { expect, test } from "@playwright/test";
import { goto, loginAsAxisAgent, loginAsNorthExec, expectModuleRail } from "./fixtures.js";
import { AXIS_SCREENS } from "../apps/web/app/modules/screens.js";

// @journey:J-O1 — the "login" step of J-O1 exception clearing
// (docs/06-roles-and-journeys.md:47, docs/superpowers/specs/2026-08-16-axis-shell-fork-design.md):
// AxisShell is its own scoped shell — an actor with an axis.*-resolving role
// lands in it and sees only AXIS's own rail (never another module's,
// ModuleSwitcher only appears once an actor's roles resolve to more than one
// shell, which axis.agent's single role never does), and an actor without one
// gets 403 (not 401 — bootstrapSession already proved who they are, they are
// just not entitled to this shell: axis-shell.tsx's loader). No Meridian —
// ADR-0061 is explicit that Meridian is NORTH-only.

test("axis.agent lands in the one frame, led by AXIS's own screens (ADR-0085)", async ({ page }) => {
  await loginAsAxisAgent(page);
  await goto(page, "/axis/board");
  // Every AXIS screen this role may use, none it may not, and no other
  // module's screens: those are reached through the workspace list below.
  await expectModuleRail(page, "axis.agent", AXIS_SCREENS, ["/north/brief", "/orbit/console"]);
});


test("an actor with no axis.*-resolving role gets 403, not 401, on /axis/*", async ({ page }) => {
  await loginAsNorthExec(page);
  const response = await page.goto("/axis/board");
  expect(response?.status()).toBe(403);
});
