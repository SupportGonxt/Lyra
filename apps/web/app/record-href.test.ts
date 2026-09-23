import { describe, expect, it } from "vitest";
import { recordHref } from "./record-href";
import { WORKSPACES } from "./modules";

// ADR-0089. The notes API names a record by the API's own module and resource
// (`dist`, `channels`); the web opens it under a workspace path that is often
// not the module's name (`/distribution`). Walking the real specs is the only
// way the two cannot drift — a hand-kept map would be sighting 2 again.

describe("recordHref", () => {
  it("opens a record on the generic record screen of the tab that serves its API", () => {
    expect(recordHref("core", "customers", "cu_1")).toBe("/admin/customers/cu_1");
    expect(recordHref("axis", "policies", "pol_1")).toBe("/axis/policies/pol_1");
    expect(recordHref("dist", "channels", "chn_1")).toBe("/distribution/channels/chn_1");
  });

  it("answers null for a resource no workspace lists", () => {
    expect(recordHref("core", "no-such-thing", "x_1")).toBeNull();
  });

  it("escapes the id into one path segment", () => {
    expect(recordHref("core", "customers", "a/b")).toBe("/admin/customers/a%2Fb");
  });

  it("resolves every tab any workspace declares, so no record kind is unopenable", () => {
    const unresolved = WORKSPACES.flatMap((spec) =>
      spec.tabs.flatMap((tab) => {
        const m = /^\/v1\/([^/]+)\/(.+)$/.exec(tab.api);
        return m && recordHref(m[1]!, m[2]!, "x_1") ? [] : [`${spec.path}/${tab.key} ${tab.api}`];
      })
    );
    expect(unresolved).toEqual([]);
  });
});
