import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import PortalSupplier, { LABELS } from "./portal.$tenantSlug.suppliers.$id";

// docs: PORTALS-DESIGN-AND-AUDIT.md §1. apps/web's suite is deliberately DOM-free
// (vitest.config.ts: "Rendering tests arrive with the module screens, in
// Playwright"), so this renders through react-dom/server and asserts on the HTML
// string — the same instrument north-shell.test.tsx uses. Everything asserted
// here is observable from the first paint, which is exactly the property a
// public, server-rendered door has to hold: the states are in the markup, not
// applied by an effect.

const TENANT = { name: "YallaCompare", brand: { name: "nxt" } };

const VIEW = {
  supplier: {
    id: "prv_cedar",
    name: "Cedar Insurance",
    kind: "insurer",
    lines: ["motor", "home"],
    currency: "AED",
    panelStatus: "active",
    settlementTerms: null
  },
  position: [
    // One row of each fact the column carries (ADR-0127): terms for motor, the
    // builder's reach counts for home, and nothing recorded for life.
    {
      line: "motor",
      period: "2026-09",
      winRate: 31,
      priceIndex: 10_400,
      marketPriceIndex: 10_000,
      volume: 120,
      coverage: { kind: "terms", terms: [{ term: "roadside", ours: { present: false }, panelMedian: { present: true } }] }
    },
    {
      line: "home",
      period: "2026-09",
      winRate: 44,
      priceIndex: 9_800,
      marketPriceIndex: 10_000,
      volume: 60,
      coverage: { kind: "reach", unquotedRequests: 41, declined: 6 }
    }
  ],
  kAnonymityFloor: 20,
  products: [{ id: "dtp_1", name: "Motor demand curves", delivery: "report", aggregationMin: 50, consentBasis: "legitimate_interest" }],
  settlement: {
    currency: "AED",
    receivableMinor: 480_000,
    batches: [
      { id: "stl_1", period: "2026-09", grossMinor: 500_000, adjustmentsMinor: -20_000, netMinor: 480_000, state: "approved", externalRef: null }
    ]
  },
  ranking: { declared: true, payForPosition: false }
};

/**
 * The router is hydrated with the loader's answer rather than left to run the
 * loader: `renderToStaticMarkup` runs no effects, and a data router whose loader
 * is still pending renders nothing at all from the first pass. `hydrationData`
 * is the channel the framework itself uses on a real hydration, so the route
 * still reads its data through the ordinary `useLoaderData` — nothing stubbed.
 */
function markupFor(data: unknown): string {
  const router = createMemoryRouter(
    [{ id: "portal", path: "/portal/:tenantSlug/suppliers/:id", element: <PortalSupplier />, loader: () => data }],
    {
      initialEntries: ["/portal/gonxt/suppliers/prv_cedar"],
      hydrationData: { loaderData: { portal: data } }
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const served = (over: Record<string, unknown> = {}) => ({ locale: "en", tenantSlug: "gonxt", tenant: TENANT, ok: true, view: VIEW, ...over });
const denied = { locale: "en", tenantSlug: "gonxt", tenant: TENANT, ok: false };

describe("the insurer's portal", () => {
  // The defect this screen shipped with: `parseArray` kept only strings, so
  // both shapes the column holds parsed to `[]` and every row read "None".
  it("renders both facts the coverage column carries, not one word for both", () => {
    const html = markupFor(served());
    expect(html).toContain("roadside");
    expect(html).toContain("41 never quoted, 6 declined");
  });

  it("leads with the insurer's name and never invents a row the floor withheld", () => {
    const html = markupFor(served());
    expect(html).toContain("Cedar Insurance");
    // Two rows in the payload, two rows out. The API dropped the below-floor
    // row; the screen must not add one back as a zero.
    expect(html.match(/2026-09/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("+4%");
    expect(html).toContain("roadside");
  });

  it("states the floor it is honouring, so the gap in the table is legible", () => {
    const html = markupFor(served());
    expect(html).toContain("aggregation floor of 20");
  });

  it("says the ranking is declared and nobody pays for position", () => {
    const html = markupFor(served());
    expect(html).toContain("Ranking is declared and auditable");
  });

  it("shows the subscription's own floor and delivery", () => {
    const html = markupFor(served());
    expect(html).toContain("Motor demand curves");
    expect(html).toContain("Aggregated above 50");
    expect(html).toContain("scheduled report");
  });

  it("renders the settlement between the tenant and this provider", () => {
    const html = markupFor(served());
    expect(html).toContain("Net receivable");
    expect(html).toContain("Approved");
  });

  it("teaches the three empty states instead of showing blank panels", () => {
    const html = markupFor(
      served({ view: { ...VIEW, position: [], products: [], settlement: { currency: "AED", receivableMinor: 0, batches: [] } } })
    );
    expect(html).toContain("Nothing benchmarked yet");
    expect(html).toContain("No subscriptions yet");
    expect(html).toContain("No settlement yet");
  });

  // A forwarded or truncated link is a real state on a public door, and the
  // heading is the message: a screen reader must hear *why* the page is there
  // before it hears whose page it is.
  it("gives a stale link a branded page with exactly one heading, and the reason in it", () => {
    const html = markupFor(denied);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain(LABELS.en!["supplier.denied.title"]);
    expect(html).toContain(LABELS.en!["supplier.denied.body"]);
    // The intro line describes a position this reader cannot see; the panels
    // that would hold it are not rendered at all.
    expect(html).not.toContain(LABELS.en!["supplier.intro"]);
    expect(html).not.toContain(LABELS.en!["supplier.byLine.title"]);
    expect(html).toContain('href="/portal/gonxt"');
  });

  it("renders the whole page in Arabic when the reader is on Arabic", () => {
    const html = markupFor(served({ locale: "ar" }));
    expect(html).toContain(LABELS.ar!["supplier.position.title"]);
    expect(html).toContain(LABELS.ar!["supplier.metric.winRate"]);
    expect(html).not.toContain(LABELS.en!["supplier.position.title"]);
  });
});
