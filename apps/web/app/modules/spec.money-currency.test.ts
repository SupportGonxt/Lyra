import { describe, expect, it } from "vitest";
import { WORKSPACES } from "./index";

// A money **column** that draws its currency from a sibling column is saying
// something about the row: *this row's currency can differ from the tenant's*
// (a policy priced in SAR by an AED-functional broker). The **field** beside it,
// which edits the same row, has to know the same thing — and did not.
//
// That is the 2026-10-01 sweep's WEB finding. `FieldSpec` had no `currencyFrom` at
// all, so the write path had no currency provenance: every spec money input posted
// **raw minor units** under a label that named no unit, and a field labelled
// "Subtotal" accepted `1575` and stored 1575 fils — rendered as AED 15.75.
//
// The read side was never wrong. `ColumnSpec.currencyFrom` has existed since the
// columns were written, which is what makes this guard possible: **the population is
// derived from the columns, not hand-listed**, because a hand-listed guard cannot
// notice a member of the real list that nobody typed in.
//
// This is the same pairing `spec.json-columns.test.ts` enforces for JSON, for the
// same reason: two declarations of one fact drift when nothing compares them.

const paired = WORKSPACES.flatMap((workspace) =>
  workspace.tabs.flatMap((tab) =>
    tab.columns
      .filter((column) => column.type === "money" && column.currencyFrom)
      .flatMap((column) =>
        (tab.fields ?? [])
          .filter((field) => field.name === column.name && field.type === "money")
          // `editFields` defaults to `fields` when omitted, so the two lists overlap
          // by construction and the same name may be declared once.
          .map((field) => ({
            where: `${workspace.path} ${tab.key} ${field.name}`,
            columnFrom: column.currencyFrom,
            fieldFrom: field.currencyFrom
          }))
      )
  )
);

describe("a money field knows the currency its row is stated in", () => {
  it("finds the pairs it is meant to be guarding", () => {
    // Nothing to assert if the convention ever moves; an empty sweep would
    // otherwise pass in perpetuity.
    expect(paired.length).toBeGreaterThan(0);
  });

  it("declares on the field every currency the column already declares", () => {
    const missing = paired.filter((pair) => pair.fieldFrom !== pair.columnFrom);
    expect(missing.map((pair) => `${pair.where}: column says ${pair.columnFrom}, field says ${pair.fieldFrom ?? "nothing"}`)).toEqual([]);
  });
});
