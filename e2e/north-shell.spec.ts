import { expect, test } from "@playwright/test";
import { goto, loginAsAxisAgent, loginAsNorthExec, expectModuleRail } from "./fixtures.js";
import { NORTH_SCREENS } from "../apps/web/app/modules/screens.js";

// @journey:J-E1 — where J-E1's 7am read is opened, Meridian included
// (docs/06-roles-and-journeys.md:79, docs/superpowers/specs/2026-08-15-north-shell-fork-design.md):
// NorthShell is its own scoped shell — an actor with a north.*-resolving role
// lands in it and sees only NORTH's own rail (never another module's,
// ModuleSwitcher only appears once an actor's roles resolve to more than one
// shell, which north.exec's single role never does), an actor without one
// gets 403 (not 401 — bootstrapSession already proved who they are, they are
// just not entitled to this shell: north-shell.tsx's loader), and Meridian's
// ?asOf= deep link actually moves the scrubber, not just the URL.

test("north.exec lands in the one frame, led by NORTH's own screens (ADR-0085)", async ({ page }) => {
  await loginAsNorthExec(page);
  await goto(page, "/north/brief");
  // Every NORTH screen this role may use, none it may not, and no other
  // module's screens: those are reached through the workspace list below.
  await expectModuleRail(page, "north.exec", NORTH_SCREENS, ["/axis/board", "/orbit/console"]);
});


test("an actor with no north.*-resolving role gets 403, not 401, on /north/*", async ({ page }) => {
  await loginAsAxisAgent(page);
  const response = await page.goto("/north/brief");
  expect(response?.status()).toBe(403);
});

// Task 8 fixed a Critical bug here: `initialAsOf` (?asOf=<epoch-ms>) was being
// fed straight into the cursor state, which expects a [0,1] day-fraction, not
// an epoch. A URL-only assertion ("the param round-tripped") can't see that
// class of bug — the query string is right and the scrubber is still wrong.
// This asserts the rendered slider itself.
test("?asOf= replays north/brief's Meridian scrubber to that moment, not just the URL", async ({ page }) => {
  await loginAsNorthExec(page);

  const asOf = Date.parse("2026-08-10T00:00:00Z"); // midnight UTC
  await goto(page, `/north/brief?asOf=${asOf}`);
  await expect(page).toHaveURL(new RegExp(`asOf=${asOf}`));

  // meridian.tsx's cursor-seed effect runs `dayFraction(initialAsOf)` once,
  // post-mount, and shift.ts's `dayFraction` is
  //   (new Date(at).getHours() * 60 + new Date(at).getMinutes()) / 1440
  // — local-time components of the fixed `asOf` instant, not UTC. Playwright
  // gives the browser context no `timezoneId` override here (none is set in
  // playwright.config.ts), so Chromium inherits this process's OS timezone —
  // the same one `new Date(asOf)` resolves against right here in the test.
  // Mirroring the exact formula (instead of assuming UTC, which only holds
  // if the runner's TZ happens to be UTC) keeps this correct on any host.
  // The math is exact, not approximate: dayFraction's result multiplied back
  // by 1440 returns the integer minute-of-day with no remainder for
  // Math.round to round away, so aria-valuenow should land on this precise
  // value once the effect commits — not "close to" it.
  const when = new Date(asOf);
  const expectedMinuteOfDay = when.getHours() * 60 + when.getMinutes();

  const slider = page.getByRole("slider");
  await expect(slider).toHaveAttribute("aria-valuemax", "1440");
  // Poll rather than a single read: the slider first renders at `played`
  // (today's live minute) before the post-mount seed effect commits the
  // replay cursor, and that commit is what this test is actually checking for.
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")), {
      message: `aria-valuenow should settle on asOf's local minute-of-day (${expectedMinuteOfDay})`
    })
    .toBe(expectedMinuteOfDay);
});
