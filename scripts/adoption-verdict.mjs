// What role-adoption.mjs calls "the screen shows this seat data", kept out of
// the browser probe so it can be tested (adoption-verdict.test.mjs).
//
// The probe counts, inside <main>:
//   rows   — table body rows
//   stats  — figures (`[data-stat]`, `dd`)
//   items  — list items outside nav, and cards (`article`): a desk of claim
//            cards is a list, not a table, and is data all the same
//   guided — empty states (dashed, with a heading) that offer an action
//   bare   — empty states that offer none
//
// A screen shows data when it shows rows, figures or items, or — having none —
// offers the action that makes some. A bare empty state with nothing beside it
// is empty; one beside real data does not cancel it.

/** @param {{ rows: number, stats: number, items: number, guided: number, bare: number } | null} m */
export function hasData(m) {
  if (!m) return false;
  const shown = m.rows + m.stats + m.items;
  if (shown > 0) return true;
  return m.guided > 0 && m.bare === 0;
}
