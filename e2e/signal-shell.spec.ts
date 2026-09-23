import { expect, test } from "@playwright/test";
import { goto, loginAsSignalLead, loginAsNorthExec, expectModuleRail } from "./fixtures.js";
import { SIGNAL_SCREENS } from "../apps/web/app/modules/screens.js";

// @journey:J-M1 — where J-M1 campaign in a day is worked
// (docs/06-roles-and-journeys.md:66, docs/superpowers/specs/2026-08-16-signal-shell-fork-design.md):
// SignalShell is its own scoped shell — an actor with a signal.*-resolving
// role lands in it and sees only SIGNAL's own rail (never another module's,
// ModuleSwitcher only appears once an actor's roles resolve to more than one
// shell, which signal.lead's single role never does), and an actor without one
// gets 403 (not 401 — bootstrapSession already proved who they are, they are
// just not entitled to this shell: signal-shell.tsx's loader). No Meridian —
// ADR-0061 is explicit that Meridian is NORTH-only.

test("signal.lead lands in the one frame, led by SIGNAL's own screens (ADR-0085)", async ({ page }) => {
  await loginAsSignalLead(page);
  await goto(page, "/signal/cockpit");
  // Every SIGNAL screen this role may use, none it may not, and no other
  // module's screens: those are reached through the workspace list below.
  await expectModuleRail(page, "signal.lead", SIGNAL_SCREENS, ["/north/brief", "/orbit/console"]);
});


test("an actor with no signal.*-resolving role gets 403, not 401, on /signal/*", async ({ page }) => {
  await loginAsNorthExec(page);
  const response = await page.goto("/signal/cockpit");
  expect(response?.status()).toBe(403);
});
