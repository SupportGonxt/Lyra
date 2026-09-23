import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { NorthShell } from "./north-shell";
import type { SessionBootstrap } from "../session.server";

// apps/web's vitest suite is deliberately DOM-free (vitest.config.ts:
// "Rendering tests arrive with the module screens, in Playwright") — no
// jsdom, no @testing-library/react (reverted at Task 8, see
// .superpowers/sdd/task-8-report.md's "Follow-up 2"). None of these three
// assertions depend on a post-mount effect (unlike Meridian's replay
// cursor), so they are fully observable from the static markup: render with
// react-dom/server and assert on the HTML string instead of DOM queries.

function sessionWith(overrides: Partial<SessionBootstrap> = {}): SessionBootstrap {
  return {
    locale: "en",
    inbox: null,
    names: {},
    // NorthShell's rail is compile-time known (NORTH_NAV_PATHS), not derived
    // from session.nav — session.nav is WORKSPACE_PATHS-shaped and can only
    // ever carry top-level roots. It is still supplied because crumbsFor and
    // profilesFor read it; /axis stands in for "some other module's
    // destination", which must not reach this rail.
    nav: [
      { labelKey: "nav.north", href: "/north", icon: "compass" },
      { labelKey: "nav.axis", href: "/axis", icon: "gear" }
    ],
    roles: ["north.exec"],
    permissions: [],
    brand: null,
    tenantName: "Sahab Cover",
    actorName: "Amina Al Farsi",
    domainPack: "insurance",
    calendar: "gregorian",
    timezone: undefined,
    currency: "AED",
    overrides: {},
    availableShells: ["north"],
    ...overrides
  };
}

function markupFor(session: SessionBootstrap): string {
  const router = createMemoryRouter(
    [{ path: "/north/brief", element: <NorthShell session={session}>{42}</NorthShell> }],
    { initialEntries: ["/north/brief"] }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("NorthShell", () => {
  const every = [
    "north:briefings:read",
    "north:metrics:read",
    "north:anomalies:read",
    "north:alerts:read",
    "north:scenarios:read",
    "north:boardpacks:read",
    "north:decisions:read"
  ];

  it("leads the rail with NORTH's own screens, labelled", () => {
    const html = markupFor(sessionWith({ permissions: every }));
    for (const [href, label] of [
      ["/north/brief", "Brief"],
      ["/north/explorer", "Explorer"],
      ["/north/anomalies", "Anomalies"],
      ["/north/alerts", "Alerts"],
      ["/north/whatif", "Scenarios"],
      ["/north/board", "Board"],
      ["/north/admin", "Admin"],
      ["/north/decisions", "Decisions"],
      ["/north/dev", "Dev"]
    ] as const) {
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(`>${label}<`);
    }
    // The board pack's file stream is a detail route, not a rail destination.
    expect(html).not.toContain("/north/board/");
  });

  // ADR-0085: one frame. Inside a module the reader still has every
  // workspace their nav offers, instead of a rail fenced to one module.
  it("keeps every workspace the reader's nav offers", () => {
    const html = markupFor(sessionWith({ permissions: every }));
    expect(html).toContain('href="/axis"');
  });

  it("offers only the screens this reader can use", () => {
    const html = markupFor(sessionWith({ permissions: ["north:briefings:read"] }));
    expect(html).toContain('href="/north/brief"');
    expect(html).not.toContain('href="/north/whatif"');
  });

  it("draws the Meridian, which is NORTH's", () => {
    const html = markupFor(sessionWith({ permissions: every }));
    expect(html).toMatch(/meridian/i);
  });
});
