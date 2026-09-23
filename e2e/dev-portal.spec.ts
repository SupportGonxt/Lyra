import { expect, test } from "@playwright/test";
import { API_ORIGIN } from "./env.js";
import { confirmAction, goto, loginAsTenantAdmin } from "./fixtures.js";

// J-D1 "the first API call" (docs/06-roles-and-journeys.md:94-95): "dev portal
// -> test key -> SDK snippet -> webhook tester green -> promote to live
// (dev.admin approval)". The acceptance test this journey actually has
// (apps/api/src/journeys.test.ts:1254-1275) is three `it`s, none of which
// touch an SDK snippet or a webhook tester at all:
//   1. GET /openapi.json is public and describes real routes.
//   2. /health needs no credential; /v1/me does.
//   3. a garbage bearer token is refused (401), not silently treated as absent.
//
// The dev portal and the webhook tester now exist — apps/web/app/routes
// /admin-developer.tsx, registered at /admin/developer, whose per-endpoint
// "Send test event" really posts a signed delivery (POST /v1/core/webhooks
// /:id/test -> apps/api/src/dispatch.ts's deliver()) and reports the verdict.
// The third test below covers it. Still absent: an SDK snippet anywhere in
// apps/web, and any "dev.admin" role in packages/core/src/rbac.ts.
// The other real developer-facing surface is the API keys panel on Settings
// (apps/web/app/routes/settings.tsx:951-982, reached from the account menu,
// not the module rail — apps/web/app/routing.ts:30):
// mint a test or live key, see the plaintext once, list it, revoke it.
// "Promote to live" is dev.admin's call: routes/core.ts's POST
// /v1/core/api-keys requires dev:keys_live:issue for a live key (a tenant
// admin's core:*:* does not reach it), while a test key takes either
// core:api_keys:create or the developer's dev:keys_test:issue. (packages/core/src/approvals.ts's "core.mandate_register" policy
// reuses the same permission string for an unrelated agent-mandate feature;
// it does not gate this route.) Per CLAUDE.md's TDD rule, this spec matches
// the real scope: the public contract at the API layer, and the full,
// ungated mint -> authenticate -> revoke -> refused loop through the one UI
// surface that actually exists.
//
// DELETE /v1/core/api-keys/:id is a bespoke route (routes/core.ts), not
// generic CRUD: api-keys has `revokedAt`, not `deletedAt`, so the generic
// delete would hard-delete the row (crud.ts's hasSoftDelete only recognizes
// `deletedAt`). It sets `revokedAt` instead, mirroring sessions' revoke in
// routes/me.ts — the row survives, matching settings.tsx's own "Revoked"
// badge/hidden-button rendering off `row.revokedAt`.
test("J-D1 the OpenAPI document is public and the API refuses everything else without a credential @journey:J-D1 @accept:M1", async ({
  request
}) => {
  const spec = await request.get(`${API_ORIGIN}/openapi.json`);
  expect(spec.status()).toBe(200);
  const body = await spec.json();
  expect(body.paths["/v1/dist/quote-requests/shop"]).toBeTruthy();
  expect(body.paths["/v1/me/approvals/{id}/decide"]).toBeTruthy();

  expect((await request.get(`${API_ORIGIN}/health`)).status()).toBe(200);
  expect((await request.get(`${API_ORIGIN}/v1/me`)).status()).toBe(401);

  const badToken = await request.get(`${API_ORIGIN}/v1/me`, {
    headers: { authorization: "Bearer not-a-token" }
  });
  expect(badToken.status()).toBe(401);
});

test("J-D1 a tenant admin issues a test key from Settings, calls the API with it, then revokes it @journey:J-D1 @accept:M1", async ({
  page,
  request
}) => {
  await loginAsTenantAdmin(page);

  // The keys panel lives on the sign-in & access tab (docs/ui.md §7 P3-10).
  await goto(page, "/settings/security");
  const keyName = `J-D1 e2e ${Date.now()}`;
  // Zero scopes ticked: "a key with no permissions can sign in and nothing
  // else" (settings.tsx "keys.scopesHint") — the point here is authentication,
  // not authorization, so nothing under the scopes fieldset is touched.
  await page.getByLabel("What is it for", { exact: true }).fill(keyName);
  // Mode defaults to "test" (settings.tsx NewKeyForm defaultValue="test");
  // left as-is — this is the "test key" half of the journey.
  await page.getByRole("button", { name: "Issue key", exact: true }).click();

  // The plaintext is shown exactly once, inline, never as a redirect target
  // (settings.tsx: "no redirect, because a redirect would drop the one copy
  // of the plaintext that will ever exist").
  const secret = await page.getByRole("status").filter({ hasText: /^qvk_test_/ }).textContent();
  expect(secret).toMatch(/^qvk_test_[A-Z2-7]{40,}$/);

  const row = page.getByRole("row", { name: new RegExp(keyName) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Test", { exact: true })).toBeVisible();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();

  // The "first API call": the freshly minted key really authenticates against
  // the running API, as apikey.test (auth.ts's fromApiKey), not merely a
  // string the UI displays.
  const me = await request.get(`${API_ORIGIN}/v1/me`, {
    headers: { authorization: `Bearer ${secret}` }
  });
  expect(me.status()).toBe(200);
  const meBody = await me.json();
  expect(meBody.actor.kind).toBe("partner");
  expect(meBody.roles).toContain("apikey.test");

  // Revoke it — a confirm dialog guards the click (settings.tsx keys.confirm),
  // same idiom as ops.spec.ts's recon/transaction asks. The submit only
  // happens on "Continue", and that click only waits for the click event, not
  // the <Form>'s async action/revalidation — reading the row back immediately
  // races the in-flight fetch. Wait for the POST response itself (RR7's client
  // fetcher posts to "<path>.data", not the bare path — signal-budget.spec.ts).
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/settings/security.data") && res.request().method() === "POST"),
    confirmAction(page)
  ]);
  await expect(page.getByRole("status").getByText("That key has been revoked.")).toBeVisible();

  // Soft revoke: the row survives with `revokedAt` set, same shape as the
  // seed-data "Revoked" rows already on this page (packages/core/src/seed
  // /admin.ts). keyColumns renders that state as a badge and hides the button.
  await expect(row).toBeVisible();
  await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);

  // Refused, not ignored — the same shape journeys.test.ts:1267-1274 asserts
  // for a garbage token, now demonstrated for a key that was real a moment ago.
  const after = await request.get(`${API_ORIGIN}/v1/me`, {
    headers: { authorization: `Bearer ${secret}` }
  });
  expect(after.status()).toBe(401);
});

// "webhook tester green" (docs/06-roles-and-journeys.md:94-95). The verdict is
// asserted as either verdict on purpose: the seeded endpoints point at
// https://ops.gonxt.ae (packages/core/src/seed/admin.ts:443-500) and nothing
// in this stack can answer as that host, so a green here would only mean the
// runner had internet. What is under test is that the button performs a real
// delivery attempt and reports its outcome — a status code or an error — and
// not that the outside world is reachable.
test("J-D1 the developer portal's webhook tester sends a test delivery and reports the verdict @journey:J-D1 @accept:M1", async ({
  page
}) => {
  await loginAsTenantAdmin(page);

  await goto(page, "/admin/developer");
  const hooks = page.getByRole("table", { name: "Webhook endpoints and their signing state", exact: true });
  const row = hooks.locator("tbody tr").first();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Send test event", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Test delivery", exact: true })).toBeVisible();
  await expect(page.getByText(/^(Delivered|Failed)$/)).toBeVisible();
});
