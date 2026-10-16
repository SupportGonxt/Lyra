# ADR-0123 — A policy wording is transcribed, not parsed

**Status:** accepted (2026-10-01)
**Supersedes:** nothing. **Amends:** nothing. **Depends on:** ADR-0016 (dependency policy), ADR-0074 (the
AI audit trail), ADR-0078 (the signal-source seam).
**Will touch** (nothing below exists yet — this ADR decides *what* to build, and the purpose is deliberately
not declared until its caller does, because a declared purpose with no caller is itself a recorded finding in
this repo): `packages/model-gateway/src/purposes.ts` (`wording.transcribe`), a new
`apps/api/src/engines/scout-wording.ts`, `apps/api/src/routes/scout.ts`, and a
`packages/model-gateway/evals/wording-transcribe/` golden set.

## Context

`docs/modules/scout.md` §8 clause 2 asks that the wording differ *"catch a seeded coverage-term change
between two policy PDFs"*. The differ is built, tested and reachable; what does not exist is the route
from **two policy PDFs to text**. `docs/30` §2 recorded the gap as open on 2026-09-27 with the note that it
*"needs a decision first"*, and named the two candidates:

1. a **PDF-text dependency** (docs/02 §9 / ADR-0016 territory), or
2. a **multi-page vision transcription purpose** (eval-first).

Read at source, the constraint is sharper than the note suggests. `POST /v1/axis/documents/:id/extract`
returns `EXTRACTION_FIELDS[docType]` — the **named fields** of an `eid` or a `mulkiya` — and stores only
those (`routes/axis.ts:309`). It never yields the document's words, and the caller-supplied `rawText` it can
also take is never stored. So a policy *wording* has no text anywhere in the platform, and
`WordingDiffBody` takes `textA`/`textB` (`routes/scout.ts:261`) that only a human could supply.

## Decision

**A wording is transcribed by the model, through `packages/model-gateway`, under a purpose declared for it
(`wording.transcribe`), and the transcription is stored on the document and marked as model-derived.** No
PDF-parsing dependency is added.

### Why not the library

Three reasons, in order of weight:

1. **A text library fails silently on exactly the documents this compares.** In this market a wording is
   routinely a scan with no text layer. `pdf-parse`-class tools return the empty string, and the differ then
   reports **no coverage-term change** between two documents it could not read. In a comparison whose output
   is taken to a provider, a confident false negative is the worst available failure — worse than an error,
   because nothing surfaces it. A vision transcription of a scan returns words; a parser returns nothing and
   looks like agreement.
2. **It keeps the dependency surface where it already is.** `packages/model-gateway` is the sole provider
   route, so a transcription inherits the budget, the guardrails, the AI audit trail and the eval harness
   rather than arriving beside them. A PDF library would arrive with its own transitive tree in a Workers
   bundle.
3. **The platform is not the right place to be clever about PDF.** The vision path already exists for EID and
   mulkiya extraction, with an eval that measures it (`evals/axis-vision/`, 95% threshold). This extends a
   measured path instead of opening a second, unmeasured one.

### The cost, stated rather than hidden

A transcription is a **model's reading of a document**, and this is a legal comparison. So the design
constrains it in three ways, and all three are required, not optional:

- **The transcription is stored and pinned to the document**, with the model, the model version, the tier and
  the timestamp. Two runs may disagree; the diff says which reading it used, and when.
- **The diff labels each side as transcribed.** A comparison of two model readings is a *different claim*
  from a comparison of two text layers, and the surface must not present them as the same thing. This is the
  same rule as the compliance posture tile's `live` vs `on_file`: two kinds of evidence are not one kind.
- **An eval gates it before it is default-on.** `wording.transcribe` ships with an eval over known wordings
  with a measured term-level accuracy floor. Until it passes, the path is available and labelled, not
  trusted.

### The optimisation this leaves open

Where a document **does** carry a text layer, a deterministic extraction is cheaper and exact. That is a
later, additive step — *try the text layer, fall back to transcription, and label which happened* — and it
is deliberately not in this change: it needs its own measurement to say when the text layer is good enough,
and doing both at once would leave neither measured.

## Consequences

- `wording.transcribe` becomes the platform's **ninth** declared AI purpose, and the only one whose output is
  a document rather than an answer. It is routed through the gateway, so it is budgeted and audited like
  every other call.
- SCOUT §8 clause 2 moves from **◐** to met once the engine, the route and the eval land: the route takes two
  documents, transcribes what it must, diffs the text, and returns the spans **with the provenance of each
  side**.
- `docs/30` §2's SCOUT item 4 closes with this ADR rather than with a dependency approval, so the open
  decision is discharged: the answer is *neither a library nor an undecided vision path, but a declared,
  measured, labelled one*.
- A future reader who wants the library is not overruled — they are asked for the thing this ADR could not
  produce: **a measurement of what a text-layer parse does on a scanned wording**, which is the only evidence
  that would change the answer.
