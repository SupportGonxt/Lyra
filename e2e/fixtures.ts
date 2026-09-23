import { expect, type Locator, type Page } from "@playwright/test";
import { PERSONAS } from "./env.js";
import { expand, permissionsForRole } from "@lyra/core";

/**
 * `page.goto` that comes back once React has hydrated, not merely once the
 * document loaded. Anything typed before hydration is thrown away — React
 * resets an uncontrolled input to its server-rendered `defaultValue` as it
 * hydrates — and under `vite dev`'s module waterfall hydration lands well
 * after "load". The symptom is a silent one: the field is empty, so a
 * `required` control blocks its own form and no request is ever made.
 *
 * `__reactRouterDataRouter` is set on `window` by react-router's
 * HydratedRouter, which is the last thing hydration does, so its presence is
 * the signal. Client-side navigation (a <Link> click) needs none of this —
 * the page is hydrated by definition.
 */
export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => "__reactRouterDataRouter" in window);
}

/**
 * Click a demo persona. The wall sits in a closed <details> below the sign-in
 * form (login.tsx) — open it before clicking, or the button is not visible.
 */
export async function pickPersona(page: Page, name: string): Promise<void> {
  const door = page.getByRole("group").filter({ hasText: "Demo sign-in" });
  if (!(await door.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByText("Demo sign-in", { exact: true }).click();
  }
  await page.getByRole("button", { name: new RegExp(name) }).click();
}

/**
 * The demo one-click door (apps/web/app/routes/login.tsx), amina.saleh@gonxt.ae
 * — tenant.admin. The demo action always redirects to "next" (home.tsx), which
 * defaults to "/" — there is no role-based landing redirect wired into any
 * route (routing.ts's `landingFor` is exercised only by shell.test.ts, not by
 * an actual loader), so this follows the same "Administration" nav link a real
 * tenant.admin clicks from the home dashboard to reach /admin.
 */
export async function loginAsTenantAdmin(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.tenantAdmin.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
  // "Administration" also appears in the home page's "Workspaces" quick-links
  // list — the primary nav rail is the one always-present copy.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Administration", exact: true }).click();
  await page.waitForURL(/\/admin/);
}

/** layla.hassan@gonxt.ae — axis.agent, owns AXIS cases. */
export async function loginAsAxisAgent(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.axisAgent.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** nadia.rahman@gonxt.ae — finance.controller, holds ledger:*:* (recon read/run/confirm). */
export async function loginAsFinanceController(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.financeController.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** hala.zayed@gonxt.ae — north.exec, reads briefings/anomalies/scenarios, no locale override (en). */
export async function loginAsNorthExec(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.northExec.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** khalid.rashed@gonxt.ae — tenant.compliance, locale "ar": the UI renders in Arabic for this persona. */
export async function loginAsComplianceOfficer(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.complianceOfficer.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** omar.farouk@gonxt.ae — axis.lead, holds axis:policies:create (axis.agent does not). */
export async function loginAsAxisLead(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.axisLead.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** faisal.omar@gonxt.ae — a second, independent finance.controller (distinct from Nadia Rahman). */
export async function loginAsFinanceController2(page: Page): Promise<void> {
  await goto(page, "/login");
  await page.getByRole("button", { name: new RegExp(PERSONAS.financeController2.name) }).click();
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** noor.jamal@gonxt.ae — signal.lead, owns SIGNAL budget moves/campaigns/AEO pages. */
export async function loginAsSignalLead(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.signalLead.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** tariq.mansour@gonxt.ae — scout.lead, owns SCOUT whitespaces/signals. */
export async function loginAsScoutLead(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.scoutLead.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** sara.nasser@gonxt.ae — orbit.agent, owns ORBIT conversations/handover notes; no orbit:qa:score. */
export async function loginAsOrbitAgent(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.orbitAgent.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/** yusuf.karim@gonxt.ae — orbit.retention, holds orbit:renewals:update; owns the retention desk's renewal queue. */
export async function loginAsOrbitRetention(page: Page): Promise<void> {
  await goto(page, "/login");
  await pickPersona(page, PERSONAS.orbitRetention.name);
  await page.waitForURL(/^https?:\/\/[^/]+\/$/);
}

/**
 * Say yes to the ask in front of a consequential action
 * (apps/web/app/components/confirm.tsx). It replaced `window.confirm()`, so
 * these clicks are ordinary DOM clicks, not `page.on("dialog")` acceptances.
 */
export async function confirmAction(page: Page): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
}

/**
 * Pick a value in a `Select` (packages/ui/src/primitives.tsx) by its field
 * label. Radix renders the menu in a portal that its popper keeps
 * re-positioning while the page settles, and on a loaded CI runner Playwright
 * can spend a whole test budget waiting for an option to be "stable" — J-E1
 * died that way (`element is not stable` / `element was detached`). Radix's own
 * typeahead selects from the keyboard, which has no actionability check to
 * lose, and exercises the same code path a keyboard user takes (docs/13 §8).
 */
/**
 * The screen itself, without the shell around it. The rail's shift block
 * (the Inbox row and the home queue) repeats the titles of whatever is waiting on this
 * actor, so an unscoped by-name lookup can resolve to chrome instead of the
 * screen — "Endorse" matched both the endorsement link and a queued endorsement
 * approval. Scope any by-name lookup whose name is an ordinary verb through
 * this.
 */
export function content(page: Page): Locator {
  return page.getByRole("main");
}

/**
 * How a table cell prints an opaque id: head and tail only (packages/ui
 * format.tsx `shortRef`). A spec that made a row and knows its id has to look
 * for it the way the screen shows it — matching the full id finds nothing.
 */
export function shortRef(value: string): string {
  const match = /^(?:([a-z][a-z0-9_]*):)?([a-z][a-z0-9]*_)([0-9a-hjkmnp-tv-z]{16,})$/i.exec(value.trim());
  if (!match) return value;
  const [, scope, prefix, body] = match;
  return `${scope ? `${scope}:` : ""}${prefix}${body!.slice(0, 4)}\u2026${body!.slice(-4)}`;
}

export async function chooseOption(scope: Page | Locator, label: string, optionText: string): Promise<void> {
  // A Locator scope narrows the *trigger* lookup only — Radix renders the open
  // menu in a portal at <body>, outside any form, so options always resolve
  // from the page. Pass a form/section locator whenever the same field label
  // exists twice on a screen (a list's filter and the record's edit form both
  // label a control "Status").
  const page = "page" in scope ? scope.page() : scope;
  const trigger = scope.getByLabel(label, { exact: true });
  const option = page.getByRole("option", { name: optionText, exact: true });
  // Re-opening a Select shortly after a form submit can race a stray event
  // that closes the popup again — mid-typeahead the Enter then lands on the
  // trigger instead of an option, which submits the surrounding form with the
  // old value and no error anywhere. J-O1 failed exactly that way in run
  // 31423750071 (saved, still "Failed"). Retry the whole open-type-commit
  // sequence against the only signal that means it worked: the trigger's text.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (((await trigger.textContent()) ?? "").includes(optionText)) return;
    await trigger.click({ timeout: 10_000 }).catch(() => {});
    if (!(await option.isVisible({ timeout: 5_000 }).catch(() => false))) continue;
    // Radix's typeahead reads one keydown at a time; typed with no delay the
    // whole string lands in a single tick and nothing gets highlighted, so
    // Enter would close the menu on the already-selected row.
    await page.keyboard.type(optionText, { delay: 30 });
    await page.keyboard.press("Enter");
  }
  await expect(trigger).toContainText(optionText);
}

/**
 * The rail inside a module (ADR-0085): the module's own screens this role may
 * use are there, the ones it may not are absent, and the named foreign paths
 * (another module's screens) never appear. Checked by href, because a label
 * like "Analytics" is both a module screen and a workspace.
 */
export async function expectModuleRail(
  page: Page,
  role: string,
  screens: readonly { href: string; permission?: string }[],
  foreign: readonly string[]
): Promise<void> {
  const held = new Set(expand(permissionsForRole(role)));
  const rail = page.getByRole("navigation", { name: /primary/i }).first();
  for (const screen of screens) {
    const link = rail.locator(`a[href="${screen.href}"]`);
    if (!screen.permission || held.has(screen.permission)) await expect(link).toBeVisible();
    else await expect(link).toHaveCount(0);
  }
  for (const href of foreign) await expect(rail.locator(`a[href="${href}"]`)).toHaveCount(0);
}
