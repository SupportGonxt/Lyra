import { expect, test } from "@playwright/test";
import { API_ORIGIN, PERSONAS } from "./env.js";
import { goto } from "./fixtures.js";

// J-C2's closing step — orbit.md §5's "CSAT/NPS collection", the CSAT half: the
// customer rates a closed conversation from a public page, and the number lands
// on the same `csat` column /orbit/analytics averages (orbit.md §7, "CSAT ≥
// 4.5"). NPS is deliberately absent: there is one rating column, and one
// question is all it can honestly hold.
//
// The page shows nothing about the conversation itself — no transcript, no AI
// summary, no agent name — because whoever holds the link is authenticated as
// nobody.

async function staffToken(email: string): Promise<string> {
  const res = await fetch(`${API_ORIGIN}/v1/auth/demo/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email })
  });
  if (!res.ok) throw new Error(`demo login failed for ${email}: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

interface Conversation {
  id: string;
  state: string;
  csat: number | null;
}

async function conversations(token: string): Promise<Conversation[]> {
  const res = await fetch(`${API_ORIGIN}/v1/orbit/conversations?limit=100`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: Conversation[] };
  return data;
}

async function ratableConversation(token: string): Promise<Conversation> {
  const closed = (await conversations(token)).find((row) => row.state === "closed" && row.csat === null);
  // seed/orbit.ts leaves exactly one closed thread unrated for this journey.
  if (!closed) throw new Error("no unrated closed conversation in the seed to rate");
  return closed;
}

// The wall test only needs an id that exists — rating it is the other test's
// job, and the unrated thread is gone once that test has run.
async function anyConversation(token: string): Promise<Conversation> {
  const row = (await conversations(token))[0];
  if (!row) throw new Error("no conversation in the seed");
  return row;
}

async function linkFor(token: string, kind: string, id: string): Promise<string> {
  const res = await fetch(`${API_ORIGIN}/v1/orbit/portal-links/${kind}/${id}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const link = new URL(url);
  return `${link.pathname}${link.search}`;
}

test("J-C2 a customer rates a closed conversation in one tap @journey:J-C2 @accept:M3", async ({ page }) => {
  const token = await staffToken(PERSONAS.orbitAgent.email);
  const conversation = await ratableConversation(token);

  await goto(page, await linkFor(token, "feedback", conversation.id));

  // Tenant's brand, tenant's page (CLAUDE.md §5), and not a word about what was
  // said in the conversation.
  await expect(page.locator("main")).not.toContainText(/\bLYRA\b/);
  await expect(page.locator("main")).not.toContainText(new RegExp(conversation.id));

  const five = page.getByRole("button", { name: /5 out of 5/i });
  await expect(five).toBeVisible();
  await five.click();

  // Wait for the settled answer, not any status: while the rating posts, the
  // pending "sending…" line is a role=status too, and reloading on it raced
  // the write — the reload read the conversation before the rating landed.
  await expect(page.getByRole("button", { name: /out of 5/i })).toHaveCount(0);
  await expect(page.getByRole("status")).toBeVisible();

  // One rating per conversation: the buttons are gone, and the answer is the
  // thank-you, not a second scale.
  await page.reload();
  await expect(page.getByRole("button", { name: /out of 5/i })).toHaveCount(0);
});

test("J-C2 the rating page opens for nobody without the token in the link @journey:J-C2 @accept:M3", async ({
  page
}) => {
  const token = await staffToken(PERSONAS.orbitAgent.email);
  const conversation = await anyConversation(token);
  const path = (await linkFor(token, "feedback", conversation.id)).split("?")[0]!;

  const headings: string[] = [];
  for (const url of [path, `${path}?token=deadbeef`, "/portal/gonxt/feedback/cnv_nope?token=deadbeef"]) {
    await page.goto(url);
    await expect(page.getByRole("button", { name: /out of 5/i })).toHaveCount(0);
    headings.push((await page.getByRole("heading").first().textContent()) ?? "");
  }
  // A missing conversation, someone else's conversation and a forged token are
  // one answer, so the page cannot be used to find out which ids exist.
  expect(headings[1]).toBe(headings[0]);
  expect(headings[2]).toBe(headings[0]);
});
