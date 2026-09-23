import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorPanel, isPermanent, messageKeyFor, titleKeyFor } from "./error-panel.js";
import { translator } from "../i18n.js";

// /north for an axis.agent rendered a bare, shell-less page: "This did not
// load / Your roles do not include access to this area. / Try again". Three
// things wrong with it — the shell vanished (the app's only boundary was on
// the root route), the one thing offered was a retry that reproduces the same
// 403, and doctrine rule 01 says a surface you have no claim on is absent, not
// broken. The panel below is what both boundaries render; the shell is the
// workspace boundary's job.

const t = translator("en");

/** What react-router hands a boundary: a duck-typed ErrorResponse. */
const routeError = (status: number, data: unknown = "") => ({
  status,
  statusText: "",
  internal: false,
  data
});

describe("error panel", () => {
  it("names the sentence that explains each status", () => {
    expect(messageKeyFor(routeError(404))).toBe("error.notFound");
    expect(messageKeyFor(routeError(403))).toBe("error.forbidden");
    expect(messageKeyFor(routeError(401))).toBe("error.unauthorized");
    expect(messageKeyFor(routeError(500))).toBe("error.generic");
    // A thrown Error is not a route error response — it says nothing about
    // what a person should do, so it gets the generic sentence.
    expect(messageKeyFor(new Error("boom"))).toBe("error.generic");
  });

  it("does not call a refusal or an empty address a failure to load", () => {
    expect(titleKeyFor(routeError(403))).toBe("error.forbiddenTitle");
    expect(titleKeyFor(routeError(404))).toBe("error.notFoundTitle");
    // Something genuinely broke, and a session that ended is nobody's fault
    // but still stopped the page from being built.
    expect(titleKeyFor(routeError(500))).toBe("error.title");
    expect(titleKeyFor(routeError(401))).toBe("error.title");
    expect(titleKeyFor(new Error("boom"))).toBe("error.title");

    expect(t("error.forbiddenTitle")).not.toBe("error.forbiddenTitle");
    const forbidden = renderToStaticMarkup(<ErrorPanel error={routeError(403)} t={t} />);
    expect(forbidden).toContain(t("error.forbiddenTitle"));
    expect(forbidden).not.toContain(t("error.title"));
  });

  it("offers work, not a retry, when retrying cannot change the answer", () => {
    // Roles do not change on reload, and there is still nothing at the
    // address: "Try again" is a button that reproduces the page.
    expect(isPermanent(routeError(403))).toBe(true);
    expect(isPermanent(routeError(404))).toBe(true);
    expect(isPermanent(routeError(500))).toBe(false);
    expect(isPermanent(new Error("boom"))).toBe(false);

    // A missing key renders as the key: the offer has to be a sentence.
    expect(t("error.home")).not.toBe("error.home");
    const forbidden = renderToStaticMarkup(<ErrorPanel error={routeError(403)} t={t} />);
    expect(forbidden).toContain(t("error.forbidden"));
    expect(forbidden).toContain(t("error.home"));
    expect(forbidden).toContain('href="/"');
    expect(forbidden).not.toContain(t("error.retry"));

    const broken = renderToStaticMarkup(<ErrorPanel error={routeError(500)} t={t} />);
    expect(broken).toContain(t("error.retry"));
  });

  it("shows the reference support can trace, and nothing when there is none", () => {
    const withId = renderToStaticMarkup(<ErrorPanel error={routeError(500, "req_01KE")} t={t} />);
    expect(withId).toContain("req_01KE");
    // An LTR id inside an RTL paragraph reverses without this.
    expect(withId).toContain('dir="ltr"');

    const without = renderToStaticMarkup(<ErrorPanel error={routeError(500)} t={t} />);
    expect(without).not.toContain(t("error.requestId", { id: "" }).trim());
  });

  // Loaders throw `data("workspace", { status: 404 })` — a noun, not an id.
  // The 404 page printed "Reference workspace" for support to trace.
  it("never offers a word as the reference", () => {
    const noun = renderToStaticMarkup(<ErrorPanel error={routeError(404, "workspace")} t={t} />);
    expect(noun).not.toContain(t("error.requestId", { id: "workspace" }));
  });

  it("sets the reference in a colour that passes AA as text", () => {
    const withId = renderToStaticMarkup(<ErrorPanel error={routeError(500, "req_01KE")} t={t} />);
    expect(withId).not.toMatch(/text-tx[56]/);
  });
});
