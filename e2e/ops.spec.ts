import { expect, test } from "@playwright/test";
import { chooseOption, confirmAction, content, goto, loginAsAxisAgent, loginAsAxisLead, loginAsFinanceController, loginAsTenantAdmin } from "./fixtures.js";
import { API_ORIGIN, PERSONAS } from "./env.js";

// J-O1 "Exception clearing" (docs/06-roles-and-journeys.md §Ops (AXIS)): an
// axis.agent opens the exceptions queue — AXIS cases filtered to
// status=failed — and clears one by moving it off "failed". The queue drops
// it immediately, no separate refresh step.
test("J-O1 axis agent filters the exceptions queue and clears a failed case @journey:J-O1 @accept:M2", async ({ page }) => {
  // Clicking into a record is a client-side navigation, and React Router does
  // not commit the URL until the route module has loaded — under `vite dev`
  // that means waiting out the first compile of case-detail.tsx and its whole
  // graph. On a two-core runner this journey lost its entire 120s budget
  // inside the `waitForURL` below (runs 31662772921, 31681…), never at an
  // assertion. Triple the budget for the two journeys that enter a cold record
  // screen rather than raise it for the suite, which does not need it.
  test.slow();
  await loginAsAxisAgent(page);

  await goto(page, "/axis/cases");
  const ref = `J-O1-${Date.now()}`;
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Reference*", { exact: true }).fill(ref);
  await chooseOption(page, "Kind*", "Quote");
  // The click resolves as soon as the event fires, not once the submission
  // completes; navigating away immediately (below) cancels the in-flight
  // request. `waitForLoadState("networkidle")` cannot cover this — a hydrated
  // <Form> posts via fetch, no navigation happens, and the load state was
  // already reached, so it returns instantly. Wait for the POST itself
  // (React Router posts to "<path>.data").
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/axis/cases.data") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Create", exact: true }).click()
  ]);

  // Scope by search rather than trusting the fresh row to land on the
  // unfiltered list's first (unpaginated) page — the case list sorts oldest
  // first with no filter applied here, so accumulated data can push a brand
  // new row past the page size.
  await goto(page, `/axis/cases?q=${encodeURIComponent(ref)}`);
  const row = page.getByRole("row", { name: new RegExp(ref) });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: ref }).click();
  await page.waitForURL(/\/axis\/cases\//);

  // The URL changes before React Router commits the detail DOM (a view
  // transition plus the detail loader), and the *list* screen behind it has
  // its own "Status" control — the queue filter. An unscoped chooseOption
  // therefore set the filter and left the edit form on "intake", which then
  // saved unchanged: J-O1's real failure in runs 31423750071/31426014087.
  // Scoping to the edit form both picks the right control and waits for the
  // navigation to actually land.
  const editForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save changes" }) });
  await expect(editForm).toBeVisible();

  // Push the fresh case into the exception state.
  await chooseOption(editForm, "Status", "Failed");
  await editForm.getByRole("button", { name: "Save changes" }).click();
  // The record view has no separate "saved" toast for a plain field edit
  // (record.tsx's `done` banner only fires for declared actions) — the
  // read-only definition list re-rendering with the new value is the
  // confirmation. Scoped to <dl>: "Failed" also matches the edit-form
  // Select's own trigger text and its hidden native <option>.
  await expect(page.locator("dl").getByText("Failed", { exact: true })).toBeVisible();

  // The exceptions queue: only failed items.
  await goto(page, `/axis/cases?status=failed&q=${encodeURIComponent(ref)}`);
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toBeVisible();

  // Clear it — move the status off "failed" — and the queue drops it.
  await page.getByRole("row", { name: new RegExp(ref) }).getByRole("link", { name: ref }).click();
  await page.waitForURL(/\/axis\/cases\//);
  await expect(editForm).toBeVisible();
  await chooseOption(editForm, "Status", "Quoting");
  await editForm.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("dl").getByText("Quoting", { exact: true })).toBeVisible();

  await goto(page, `/axis/cases?status=failed&q=${encodeURIComponent(ref)}`);
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toHaveCount(0);
});

// J-O3 "Month-end recon" (docs/06-roles-and-journeys.md §Ops (AXIS)): a
// finance.controller imports counterparty statement lines, the engine
// auto-matches them against settled transactions, and what is left is an
// exception a person decides — with a reason recorded against the decision.
test("J-O3 finance controller runs a reconciliation and decides an exception with a reason @journey:J-O3 @accept:M2", async ({
  page
}) => {
  await loginAsFinanceController(page);

  // Settle one transaction so the recon engine has something to match against.
  const naturalKey = `j-o3-${Date.now()}`;
  await goto(page, "/ledger/transactions");
  await chooseOption(page, "Transaction type*", "CM-RECEIPT");
  await page.getByLabel("Transaction key*", { exact: true }).fill(naturalKey);
  await page.getByLabel("Currency", { exact: true }).fill("AED");
  // The field takes money the way a person writes it — 5000.00 AED — and posts
  // the minor units itself (packages/ui MoneyField's hidden `grossMinor`).
  await page.getByLabel("Gross amount", { exact: true }).fill("5000");
  // The generic `grossMinor`/`currency` fields above are the ledger envelope;
  // CM-RECEIPT's own recipe (packages/ledger/src/recipes.ts ClientMoneyArgs)
  // separately requires `amountMinor`, which the form now asks for as its own
  // money field rather than as JSON (docs/ui.md §7 P3-16).
  await page.getByLabel("Amount*", { exact: true }).fill("5000");
  await page.getByRole("button", { name: "Open transaction" }).click();
  await confirmAction(page);
  await expect(page.getByText(/Opened as/)).toBeVisible();

  // Import a statement line that references it, off by an amount the
  // insurer-process tolerance absorbs — an auto-match, not an exact one.
  await goto(page, "/ledger/recon");
  const statementRef = `STMT-${Date.now()}`;
  // The statement is pasted as the counterparty exported it — reference,
  // amount, our reference — and the amount is read in the currency's own
  // precision (docs/ui.md §7 P3-16), so 5000.50 AED is 500050 minor units.
  // docs/27 F16 gave this screen a real file-upload alternative to the paste
  // (CAMT/MT940/OFX), so paste and file are now alternatives rather than the
  // one required input — neither carries a `required` asterisk of its own,
  // and the label reads "Statement lines" without one.
  await page.getByLabel("Statement lines", { exact: true }).fill(`${statementRef},5000.50,${naturalKey}`);
  await page.getByRole("button", { name: "Start run" }).click();
  await confirmAction(page);
  // The run itself matches every statement line against the ledger inside the
  // POST, so on a two-core CI runner this one form round trip can outlast the
  // 15s assertion budget — it did, twice, in run 31419046722. Wait on the
  // outcome, not on the budget: a genuinely broken run still fails here.
  const runLink = content(page).getByRole("link", { name: "Run", exact: true });
  await expect(runLink).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/started/)).toBeVisible();

  await runLink.click();

  // A tolerance match is auto-proposed, never auto-confirmed — it is the
  // exception a person still has to decide, with a reason recorded.
  const matchRow = page.getByRole("row", { name: new RegExp(statementRef) });
  await expect(matchRow).toBeVisible();
  await expect(matchRow.getByText("Within tolerance")).toBeVisible();
  await expect(matchRow.getByText("Proposed")).toBeVisible();

  await matchRow.getByLabel("Why", { exact: true }).fill("Matches bank feed for this period");
  await matchRow.getByRole("button", { name: "Confirm", exact: true }).click();
  await confirmAction(page);

  await expect(page.getByText(/Match recorded as Confirmed/)).toBeVisible();
  await expect(matchRow.getByText("Confirmed")).toBeVisible();
});

// J-O2 "Group medical bid" (docs/06-roles-and-journeys.md §Ops (AXIS)): an
// axis.lead shops a fresh risk to the panel and the comparison answers with
// referrals, never silence (apps/api/src/journeys.test.ts covers the API
// side; this proves the same path through the actual UI).
test("J-O2 axis lead shops a new risk and the panel answers @journey:J-O2 @accept:M2", async ({ page }) => {
  // Two cold record screens (product detail, channel detail) plus a re-login
  // and the quote comparison — same cold-compile cost as J-O1 above, twice
  // over.
  test.slow();
  // Seed IDs are ULIDs assigned at run time (packages/db/src/ids.ts), so the
  // real productId/channelId can't be computed — look them up once. axis.lead
  // has no core:products:read, so tenant.admin (core:*:* + dist:*:read) does
  // the one-time lookup instead.
  await loginAsTenantAdmin(page);

  await goto(page, "/admin/products?line=health");
  await page.locator("tbody tr").first().getByRole("link").first().click();
  await page.waitForURL(/\/admin\/products\/.+/);
  const productId = page.url().split("/").pop()!;

  await goto(page, "/distribution/channels?q=alpha-brokers");
  const channelRow = page.getByRole("row", { name: /alpha-brokers/ });
  await expect(channelRow).toBeVisible();
  await channelRow.getByRole("link", { name: "alpha-brokers" }).click();
  await page.waitForURL(/\/distribution\/channels\/.+/);
  const channelId = page.url().split("/").pop()!;

  // A shop names its customer (docs/27, 2026-09-23): an anonymous risk can no
  // longer be shopped. The seed's one answered request carries a customer and
  // the data-sharing consent the reshop's docs/12 §3 gate reads, so reuse both.
  // The persona sign-in the login picker itself uses (demo deployments only).
  const login = await page.request.post(`${API_ORIGIN}/v1/auth/demo/login`, { data: { email: PERSONAS.axisLead.email } });
  const { token } = (await login.json()) as { token: string };
  const seeded = await page.request.get(`${API_ORIGIN}/v1/dist/quote-requests?state=complete&limit=1`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(seeded.ok()).toBe(true);
  const { customerId, consentId } = ((await seeded.json()) as { data: { customerId: string; consentId: string }[] }).data[0]!;

  await loginAsAxisLead(page);

  await goto(page, "/distribution/quote-requests");
  await page.locator("summary", { hasText: "New" }).click();
  await page.getByLabel("Channel*", { exact: true }).fill(channelId);
  await page.getByLabel("Product*", { exact: true }).fill(productId);
  await page.getByLabel("Customer*", { exact: true }).fill(customerId);
  await page.getByLabel("Consent", { exact: true }).fill(consentId);
  await page
    .getByLabel("Risk details*", { exact: true })
    .fill(JSON.stringify({ age: 41, sumInsuredMinor: 10_000_000, priorClaims: false, lives: 120 }));
  await page.getByLabel("Currency*", { exact: true }).fill("AED");
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/distribution/quote-requests.data") && res.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Create", exact: true }).click()
  ]);

  // quote-requests has no `q` search. The seed's one quote-request is already
  // fully answered (packages/core/src/seed.ts), so `state=open` is exactly
  // the freshly-created row.
  await goto(page, "/distribution/quote-requests?state=open");
  const row = page.getByRole("row").filter({ hasText: "Open" }).first();
  await expect(row).toBeVisible();
  await row.getByRole("link").first().click();
  await page.waitForURL(/\/distribution\/quote-requests\/.+/);
  const quoteRequestId = page.url().split("/").pop();
  await goto(page, `/distribution/quote-requests/${quoteRequestId}/compare`);

  // Freshly opened: nothing has answered yet.
  await expect(page.getByText("The panel was never asked")).toBeVisible();
  await expect(
    page.getByText("This request has no responses at all, not even a decline. Re-shop it to send the requirement out.")
  ).toBeVisible();

  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/compare.data") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Re-shop the panel" }).click()
  ]);

  // A referral panel answers with referrals, not silence. This seed panel's
  // one provider declines with a reason rather than a price (apps/api/src
  // /routes/dist.ts only puts state==="quoted" responses in `quotes`, which
  // is where the Commission column lives — a referral never carries one).
  await expect(page.getByText(/Referred|Quoted/).first()).toBeVisible();
  await expect(page.getByText("Did not quote", { exact: true })).toBeVisible();

  // The comparison is transposed — providers are columns — so it scrolls
  // sideways on a laptop as soon as the panel is more than two or three deep.
  // The row-label column has to stay put through that scroll, or the user is
  // reading numbers with nothing saying what they measure (docs/ui.md §7.11).
  // The freshly shopped request answers with referrals and therefore renders no
  // grid at all, so the assertion goes to the request the seed already answered
  // four providers deep (packages/core/src/seed.ts) — the case the column was
  // pinned for.
  await goto(page, "/distribution/quote-requests?state=complete");
  const answered = page.getByRole("row").filter({ hasText: "Complete" }).first();
  await expect(answered).toBeVisible();
  await answered.getByRole("link").first().click();
  await page.waitForURL(/\/distribution\/quote-requests\/.+/);
  await goto(page, `${page.url().replace(/\/$/, "")}/compare`);

  // Assert the mechanism rather than the scroll: a computed `position: sticky`
  // on the row labels is what survives a narrow viewport.
  const labelCell = page.getByRole("rowheader").first();
  await expect(labelCell).toBeVisible();
  await expect
    .poll(() => labelCell.evaluate((el) => getComputedStyle(el).position))
    .toBe("sticky");
});
