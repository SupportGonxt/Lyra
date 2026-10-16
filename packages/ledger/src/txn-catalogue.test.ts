import {
  
} from "node:path"
import { describe, expect, it } from "vitest";
import { RECIPES } from "./recipes.js";
import { TXN_TYPES, autoApprovable } from "./types.js";

// docs/19 §4 is a **prose** catalogue of 91 codes; the platform has two
// machine-readable registries that must agree: `TXN_TYPES` (`types.ts`, which its
// own comment calls "docs/19 §4, complete") and `RECIPES` (`recipes.ts`).
//
// This file exists because a mechanical audit of the *prose* catalogue is not
// possible, and three attempts to write one produced three different wrong
// answers — each time because the extraction was wrong, never the ledger. The doc
// marks a transaction ⊘ or ✓ in a column that moves between its twelve tables.
// The registry states the same thing as a boolean, in code.
//
// What must hold, and what this holds:
//
//   financial: true  ⟺  a recipe exists
//
// A `financial` type with no recipe is a transaction that **throws** the moment
// anything tries to post it (`buildRecipe`: "no posting recipe for transaction
// type …"), and a recipe on a ⊘ type is a journal nobody declared. Measured
// 2026-10-01: 103 codes, 56 financial, 56 recipes, and the two sets are equal.

const recipes = new Set(Object.keys(RECIPES));
const types = Object.values(TXN_TYPES);
const financial = new Set(types.filter((t) => t.financial).map((t) => t.code));

describe("the transaction catalogue and its recipes", () => {
  it("has a recipe for every type that posts a journal", () => {
    // The direction that matters: a financial type with no recipe is a money
    // movement that cannot be posted at all.
    expect([...financial].filter((code) => !recipes.has(code)).sort()).toEqual([]);
  });

  it("has no recipe for a type that posts nothing", () => {
    // The other direction, so a ⊘ type cannot quietly acquire a journal nobody
    // declared — that would move money the catalogue says it does not.
    const nonFinancial = types.filter((t) => !t.financial).map((t) => t.code);
    expect(nonFinancial.filter((code) => recipes.has(code)).sort()).toEqual([]);
  });

  it("selects a population on both sides, so the two assertions above mean something", () => {
    // A guard that selects its own subjects must say it selected them: an
    // extraction that silently returned nothing would pass both tests.
    expect(types.length).toBeGreaterThan(90);
    expect(financial.size).toBeGreaterThan(40);
    expect(recipes.size).toBe(financial.size);
  });

  it("carries a code on every definition, so the map cannot disagree with its rows", () => {
    for (const type of types) expect(type.code).toBeTruthy();
  });

  it("never lets a client-money or payout type be auto-approvable", () => {
    // docs/19 §7. The rule is `autoApprovable` (`types.ts:248`), not "has an
    // approval key" — and the difference is real rather than pedantic:
    // `CLAIM-FUND` carries `clientMoney: true` with **no approval policy**, which
    // is correct. Money arriving from the insurer is not a payout and needs no
    // policy approval, but it may still never be auto-approved. Asserting the
    // wrong half of that distinction is how this test was first written.
    for (const type of types) {
      if (type.clientMoney || type.payout) {
        expect(autoApprovable(type.code), type.code).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------- a question with no scan-shaped answer */

// "Which transaction types does nothing produce?" was asked here and **has no
// answer this file can compute**, so no such test is written. Recording why, so
// the next reader does not spend the round I did:
//
// `POST /v1/txn/:type` (`apps/api/src/routes/ledger.ts:96`) validates the type
// against `TXN_TYPES` and accepts **any** registered code:
//
//     if (!TXN_TYPES[type]) throw badRequest(`unknown transaction type ${type}`);
//
// So a code's producer can be a **caller**, not our source. `MANUAL-JRNL`,
// `CREDIT-NOTE`, `PAYOUT-INSTRUCT` and the rest are written by whoever posts to
// the generic endpoint, and a scan for the literal in this tree reports them as
// orphans. Scanning for a *writer* is the wrong shape of question for a
// code-parameterised surface — four different extractions of it gave four
// different wrong answers in two rounds, and every one of them would have put a
// false finding in the register.
//
// The shape that *does* hold is above: the registry is the API surface, and every
// financial code in it must have a recipe. That is checkable, and it is checked.
