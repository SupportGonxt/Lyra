import { expect, test } from "@playwright/test";
import { goto, loginAsOrbitAgent, loginAsNorthExec, expectModuleRail } from "./fixtures.js";
import { ORBIT_SCREENS } from "../apps/web/app/modules/screens.js";

// @journey:J-X1 — the "human console opens" step of J-X1 handover catch
// (docs/06-roles-and-journeys.md:57, docs/superpowers/specs/2026-08-16-orbit-shell-fork-design.md):
// OrbitShell is its own scoped shell — an actor with an orbit.*-resolving role
// lands in it and sees only ORBIT's own rail (never another module's,
// ModuleSwitcher only appears once an actor's roles resolve to more than one
// shell, which orbit.agent's single role never does), and an actor without one
// gets 403 (not 401 — bootstrapSession already proved who they are, they are
// just not entitled to this shell: orbit-shell.tsx's loader). No Meridian —
// ADR-0061 is explicit that Meridian is NORTH-only.

test("orbit.agent lands in the one frame, led by ORBIT's own screens (ADR-0085)", async ({ page }) => {
  await loginAsOrbitAgent(page);
  await goto(page, "/orbit/console");
  // Every ORBIT screen this role may use, none it may not, and no other
  // module's screens: those are reached through the workspace list below.
  await expectModuleRail(page, "orbit.agent", ORBIT_SCREENS, ["/north/brief", "/axis/exceptions"]);
});


test("an actor with no orbit.*-resolving role gets 403, not 401, on /orbit/*", async ({ page }) => {
  await loginAsNorthExec(page);
  const response = await page.goto("/orbit/console");
  expect(response?.status()).toBe(403);
});
