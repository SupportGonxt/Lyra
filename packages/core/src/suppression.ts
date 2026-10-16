// docs/modules/signal.md §2.2: "suppression lists always applied (recent
// purchasers, do-not-contact, complainers)". Three causes, enforced in two
// different places, and this module exists so the difference is written down
// once rather than discovered from a support ticket.
//
//   - **do-not-contact** (withdrawn consent) is *membership*: it is a real
//     audience, because an operator needs to see who is on it and why.
//   - **recent purchasers** and **complainers** are *floors*: they apply at send
//     time regardless of which audience a campaign targets, the same way quiet
//     hours and the frequency cap do. A tenant may build any audience it likes;
//     none of them may reach someone the floor suppresses.
//
// The name lives here, not in the engine, because the seed writes the same row:
// two literals for one audience would silently create a second one the first
// time they drifted (the engine looks the audience up by name).

/**
 * The suppression audience's name. It says what the row *is* — withdrawn
 * consent — rather than enumerating the two further causes, which are not
 * membership and would be a lie in a list an operator reads.
 */
export const SUPPRESSION_AUDIENCE_NAME = "Do not contact — withdrawn consent";
