import { describe, expect, it } from "vitest";
import { WORKSPACES } from ".";
import { REF_SOURCES, bodyFrom, formKind, inputValue, localizedValue, type FieldSpec } from "./spec";

// The generic create form made people type storage formats: `{"en":…,"ar":…}`
// to name a team, `["a","b"]` for a list of tags, a `cu_01KE…` pasted from
// another screen for a customer. The kind of input is decided here, once, for
// every declared resource in every workspace.

const nameJson: FieldSpec = { name: "nameJson", type: "json", required: true };
const tagsJson: FieldSpec = { name: "tagsJson", type: "json" };
const customerId: FieldSpec = { name: "customerId", type: "text" };

describe("formKind", () => {
  it("reads a localised name as one input per language", () => {
    expect(formKind(nameJson)).toBe("localized");
  });
  it("reads a list of strings as a list", () => {
    expect(formKind(tagsJson)).toBe("list");
  });
  it("reads a known id as a reference to pick", () => {
    expect(formKind(customerId)).toBe("ref");
  });
  it("leaves every other field as declared", () => {
    expect(formKind({ name: "configJson", type: "json" })).toBe("json");
    expect(formKind({ name: "key", type: "text" })).toBe("text");
  });
});

describe("bodyFrom with the new kinds", () => {
  it("assembles a localised name from its per-language inputs", () => {
    const form = new FormData();
    form.set("nameJson.en", "Motor desk");
    form.set("nameJson.ar", "مكتب المركبات");
    expect(bodyFrom([nameJson], form)).toEqual({ nameJson: { en: "Motor desk", ar: "مكتب المركبات" } });
  });
  it("drops an empty language rather than sending a blank", () => {
    const form = new FormData();
    form.set("nameJson.en", "Motor desk");
    form.set("nameJson.ar", "");
    expect(bodyFrom([nameJson], form)).toEqual({ nameJson: { en: "Motor desk" } });
  });
  it("splits a list on commas and new lines", () => {
    const form = new FormData();
    form.set("tagsJson", "vip, motor\nrenewal");
    expect(bodyFrom([tagsJson], form)).toEqual({ tagsJson: ["vip", "motor", "renewal"] });
  });
});

describe("prefilling an edit", () => {
  it("reads each language back out of a stored name", () => {
    expect(localizedValue({ nameJson: { en: "Desk", ar: "مكتب" } }, "nameJson", "ar")).toBe("مكتب");
  });
  it("joins a stored list for editing", () => {
    expect(inputValue(tagsJson, { tagsJson: ["a", "b"] })).toBe("a, b");
  });
});

// The same partition sighting 16 asks for: every id-shaped text field in every
// spec is either picked from a list or excluded here with its reason. Nothing
// is left over.
const TYPED_ON_PURPOSE: Record<string, string> = {
  subjectRef: "polymorphic: a ref to any kind of record, no single list to pick from",
  contentRef: "a CMS content key, not a platform record",
  externalRef: "the counterparty's own reference, typed as they gave it",
  externalId: "the counterparty's own id",
  regulatorRef: "the regulator's reference number",
  toRef: "a message address in the channel's own format",
  fromRef: "a message address in the channel's own format",
  definitionSqlRef: "a semantic-layer key",
  notifyChannelRef: "a notification address",
  verificationRef: "the identity provider's reference",
  termsRef: "a document key",
  promptRef: "a prompt registry key",
  assessorRef: "an external assessor's reference",
  customerRef: "a portal customer handle, not a core customer id",
  sourceRef: "polymorphic source",
  landingRef: "a landing page key",
  linkedActionRef: "polymorphic",
  contextRef: "polymorphic",
  counterpartyRef: "polymorphic: channel or provider",
  postmortemRef: "a document key",
  evidenceRef: "polymorphic evidence",
  principalRef: "polymorphic: user or API key",
  clientId: "an OAuth client id the tenant registers",
  teamId: "two team tables (core and orbit) share the name; which one depends on the resource",
  consentId: "opened from the customer record, never picked alone",
  whitespaceId: "promoted from SCOUT's radar, which carries it",
  subscriptionId: "system-assigned",
  reportId: "chosen on the report screen",
  fileId: "an upload, not a pick",
  evidenceFileId: "an upload, not a pick",
  closePackFileId: "an upload, not a pick",
  statementFileId: "an upload, not a pick",
  pdfFileId: "an upload, not a pick",
  bundleFileId: "an upload, not a pick"
};

describe("every id field is picked or excused", () => {
  it("leaves no id-shaped text input unaccounted for", () => {
    const leftover = new Set<string>();
    for (const workspace of WORKSPACES) {
      for (const tab of workspace.tabs) {
        for (const field of [...(tab.fields ?? []), ...(tab.editable ?? [])]) {
          if (field.type !== "text" || !/(Id|Ref)$/.test(field.name)) continue;
          if (field.name in REF_SOURCES || field.name in TYPED_ON_PURPOSE) continue;
          leftover.add(field.name);
        }
      }
    }
    expect([...leftover]).toEqual([]);
  });
});
