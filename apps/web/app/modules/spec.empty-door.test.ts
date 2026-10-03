import { describe, expect, it } from "vitest";
import { WORKSPACES, workspaceFor } from "./index";
import { emptyDoor, tabOf, type ResourceSpec } from "./spec";

// An empty list teaches one action (docs/15 §6 item 9). For a reader who may
// create, that action is "New". For a reader who may not, the generic list
// said only that records "will appear once someone with permission creates
// one" — true, and a dead end. Role adoption found the support agent's
// knowledge base exactly so: empty after 3,000 chats, nothing to do about it.
// `emptyDoor` is the seam a tab uses to name the reader's next move instead.

const tab: ResourceSpec = {
  key: "kb-articles",
  api: "/v1/orbit/kb-articles",
  read: "orbit:kb:read",
  columns: [],
  emptyDoor: { href: "/orbit/deflections", labelKey: "d", bodyKey: "b", permission: "orbit:conversations:read" }
};

describe("emptyDoor", () => {
  it("opens for a reader who holds the door's permission", () => {
    expect(emptyDoor(tab, ["orbit:conversations:read"])).toEqual(tab.emptyDoor);
  });

  it("stays shut for a reader who does not, and for a tab that declares none", () => {
    expect(emptyDoor(tab, [])).toBeNull();
    const { emptyDoor: _none, ...bare } = tab;
    expect(emptyDoor(bare, ["orbit:conversations:read"])).toBeNull();
  });
});

describe("every declared empty door", () => {
  const doors = WORKSPACES.flatMap((spec) =>
    spec.tabs.flatMap((one) => (one.emptyDoor ? [{ spec, tab: one, door: one.emptyDoor }] : []))
  );

  it("exists where role adoption found the dead end", () => {
    expect(doors.map(({ spec, tab: one }) => `${spec.path}/${one.key}`)).toContain("/orbit/kb-articles");
  });

  for (const { spec, tab: one, door } of doors) {
    it(`${spec.path}/${one.key} opens a tab the door's permission reads, worded in en and ar`, () => {
      const [path] = door.href.split("?");
      const [module, resource] = path!.split("/").filter(Boolean);
      const target = tabOf(workspaceFor(`/${module}`)!, resource);
      expect(target, `${door.href} is no tab`).toBeDefined();
      expect(target?.read).toBe(door.permission);
      for (const locale of ["en", "ar"]) {
        expect(spec.labels[locale]?.[door.labelKey], `${locale} ${door.labelKey}`).toBeTruthy();
        expect(spec.labels[locale]?.[door.bodyKey], `${locale} ${door.bodyKey}`).toBeTruthy();
      }
    });
  }
});
