import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import PortalChannel, { LABELS } from "./portal.$tenantSlug.channels.$id";

// docs: PORTALS-DESIGN-AND-AUDIT.md §2. Rendered through react-dom/server, the
// same DOM-free instrument north-shell.test.tsx uses. Every assertion here is
// observable from the first paint — the property a public, server-rendered door
// has to hold.

const TENANT = { name: "YallaCompare", brand: { name: "nxt" } };

const VIEW = {
  channel: {
    id: "chn_alpha",
    key: "alpha-brokers",
    kind: "b2b",
    name: { en: "Alpha Brokers", ar: "ألفا بروكرز" },
    medium: "portal",
    collectsPayment: "us",
    currency: "AED",
    status: "active",
    defaultCommissionPpm: 250_000,
    settlementTerms: null
  },
  totals: { entries: 2, grossMinor: 150_000, yourShareMinor: 18_000, currency: "AED" },
  money: { accrued: 12_000, invoiced: 0, received: 0, payable: 2_000, paid: 6_000, clawed_back: 0 },
  book: [
    {
      id: "ce_2",
      subjectRef: "pol_2",
      offeringId: "off_1",
      kind: "renewal",
      premiumMinor: 50_000,
      yourShareMinor: 6_000,
      currency: "AED",
      state: "paid",
      earnedAt: 1_760_000_000_000
    },
    {
      id: "ce_1",
      subjectRef: "pol_1",
      offeringId: "off_1",
      kind: "new_business",
      premiumMinor: 100_000,
      yourShareMinor: 12_000,
      currency: "AED",
      state: "accrued",
      earnedAt: 1_760_000_000_000
    }
  ],
  settlements: [
    { id: "stl_c1", period: "2026-09", netMinor: 18_000, currency: "AED", state: "approved", externalRef: null }
  ],
  agreement: { kind: "distribution", version: 2, state: "active", effectiveFrom: 1_759_000_000_000, effectiveTo: null }
};

/** Hydrated rather than loaded: `renderToStaticMarkup` runs no effects, so a
 *  data router with a pending loader would render nothing. `hydrationData` is
 *  the framework's own channel, so `useLoaderData` is not stubbed. */
function markupFor(data: unknown): string {
  const router = createMemoryRouter(
    [{ id: "portal", path: "/portal/:tenantSlug/channels/:id", element: <PortalChannel />, loader: () => data }],
    {
      initialEntries: ["/portal/gonxt/channels/chn_alpha"],
      hydrationData: { loaderData: { portal: data } }
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const served = (over: Record<string, unknown> = {}) => ({ locale: "en", tenantSlug: "gonxt", tenant: TENANT, ok: true, view: VIEW, ...over });
const denied = { locale: "en", tenantSlug: "gonxt", tenant: TENANT, ok: false };

describe("the channel partner's portal", () => {
  it("names the channel and totals the book the reader wrote", () => {
    const html = markupFor(served());
    expect(html).toContain("Alpha Brokers");
    expect(html).toContain("Your commission");
    expect(html).toContain("Settled to date");
  });

  // The one question the ladder answers is "how much of my money is sitting
  // where", and a visible proportion answers it better than a second number.
  it("draws the money ladder as a proportion of the stages it accounts for", () => {
    const html = markupFor(served());
    expect(html).toContain("width:60%"); // 12 000 of 20 000 accrued
    expect(html).toContain("width:30%"); // 6 000 paid
    expect(html).toContain("width:10%"); // 2 000 payable
    expect(html).toContain("Where your money is");
  });

  it("says so plainly when there is no money on the ladder at all", () => {
    const html = markupFor(served({ view: { ...VIEW, money: {} } }));
    expect(html).toContain(LABELS.en!["channel.money.none"]);
    expect(html).not.toContain("width:0%");
  });

  it("shows the channel's own share on every line of its book", () => {
    const html = markupFor(served());
    expect(html).toContain("New business");
    expect(html).toContain("Renewal");
    expect(html).toContain("pol_1");
    // The tenant's margin is not in the payload and never reaches the page.
    expect(html).not.toContain("netCommissionMinor");
    expect(html).not.toContain("grossCommissionMinor");
  });

  it("shows the settlements and the agreement behind the channel", () => {
    const html = markupFor(served());
    expect(html).toContain("2026-09");
    expect(html).toContain("distribution");
    expect(html).toContain("v2");
    expect(html).toContain(LABELS.en!["channel.agreement.open"]);
  });

  it("teaches its empty states rather than showing blank panels", () => {
    const html = markupFor(served({ view: { ...VIEW, book: [], settlements: [], agreement: null, money: {} } }));
    expect(html).toContain("Nothing yet");
    expect(html).toContain("No settlement yet");
    expect(html).toContain("No agreement on file");
  });

  it("gives a stale link a branded page with exactly one heading, and the reason in it", () => {
    const html = markupFor(denied);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain(LABELS.en!["channel.denied.title"]);
    expect(html).toContain(LABELS.en!["channel.denied.body"]);
    // The intro describes a book this reader cannot see; the panels are not
    // rendered at all in this state.
    expect(html).not.toContain(LABELS.en!["channel.intro"]);
    expect(html).not.toContain(LABELS.en!["channel.book.title"]);
    expect(html).toContain('href="/portal/gonxt"');
  });

  it("renders the whole page in Arabic, naming the channel in Arabic", () => {
    const html = markupFor(served({ locale: "ar" }));
    expect(html).toContain("ألفا بروكرز");
    expect(html).toContain(LABELS.ar!["channel.book.title"]);
    expect(html).toContain(LABELS.ar!["channel.money.payable"]);
    // Not the tenant's fallback name, and not the English copy.
    expect(html).not.toContain("Alpha Brokers");
    expect(html).not.toContain(LABELS.en!["channel.book.title"]);
  });
});
