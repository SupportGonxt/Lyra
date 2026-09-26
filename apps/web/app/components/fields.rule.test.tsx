import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldInput } from "./fields";
import { labelsFrom } from "../routes/detail-kit";
import { signal } from "../modules/signal";

// The audience rule builder speaks words, not keys: its labels resolve through
// the shared catalogue the way the field hints do (spec.ts label fall-through).
describe("the audience rule builder", () => {
  const field = signal.tabs.find((t) => t.key === "audiences")!.fields!.find((f) => f.name === "definitionJson")!;
  const html = (row?: Record<string, unknown>) => renderToStaticMarkup(<FieldInput field={field} row={row} label={labelsFrom(signal.labels)("en")} />);

  it("renders rows with words, and no raw key", () => {
    const out = html({ definitionJson: { all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }] } });
    expect(out).toContain("Condition 1");
    expect(out).not.toMatch(/rule\\.(join|what|value)/);
    expect(out).toContain('value="quote_expired"');
  });

  it("requires no row: blank rows must not block the submit", () => {
    expect(html()).not.toContain("required");
  });

  it("keeps a rule it cannot show in its JSON box", () => {
    const out = html({ definitionJson: { all: [{ field: "policy.status", op: "eq", value: "active" }] } });
    expect(out).toContain("<textarea");
    expect(out).toContain("policy.status");
  });
});
