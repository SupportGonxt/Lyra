# ADR-0114 — The PDF writer embeds an Arabic font and shapes Arabic itself

Date: 2026-10-03 · Status: accepted

Context: docs/27 F27 / docs/specs/gap-axis-design.md §D.11 (a policy document
for every policy); CLAUDE.md §7 (RTL + i18n from day one), §14 (domain-pack
vocabulary); Guardrails (no third-party service beyond docs/02 §9 without an
ADR, prefer boring technology); docs/02 §9 (approved services).

## Context

`apps/api/src/engines/export/pdf.ts` is a hand-written PDF writer: base-14
Helvetica, WinAnsi encoding. Its `pdfSafe` refused any string outside Latin-1.
`apps/api/src/engines/axis-policy-document.ts` worked around that by falling
back to the customer's English name. A customer who gave only an Arabic name
has no English name, so the document ended in
`conflict("this document contains text the renderer cannot draw")`
(`axis-policy-document.ts:313` today). In a simulated month 90 of 510 policies
(about 18%) got no schedule. The same refusal sent every Arabic ledger and
analytics PDF export without a browser binding to a 400
(`engines/export/render.ts`).

The fix has to run on Cloudflare Workers and on on-prem Node with no network
at render time.

## Decision

1. **Embed an OFL Arabic font: Noto Naskh Arabic Regular.** The source is
   `@fontsource/noto-naskh-arabic@5.3.0` (licence `OFL-1.1`, checked in the
   package metadata and its `LICENSE`, with no Reserved Font Name). No TTF was
   available locally: `/usr/share/fonts` holds no Arabic face except DejaVu,
   and DejaVu uses the Bitstream Vera licence, not the OFL. The package ships
   WOFF 1.0, which is zlib per table.
   - `scripts/build-pdf-font.ts` unpacks it by hand. The script keeps the 409
     code points the shaper can emit: U+0600–06FF, the presentation forms in
     `arabic.ts`, and space. It drops GSUB, GPOS, GDEF, STAT, post and gasp.
     It writes `engines/export/fonts/noto-naskh-arabic.ts`: 48,096 bytes of
     TrueType as base64.
   - The module carries the full OFL text in a `/*!` legal comment, which
     esbuild keeps in the bundle. The same text is in `fonts/OFL.txt`.
   - The script is run by hand, never at build time. It is deterministic: a
     re-run reproduces the module byte for byte.
2. **Type0 / CIDFontType2, Identity-H, ToUnicode.** `pdf-font.ts:45`
   (`fontObjects`) writes six objects:
   - a Type0 font;
   - a CIDFontType2 whose `/W` widths come from hmtx;
   - a FontDescriptor;
   - a FontFile2;
   - a ToUnicode CMap, which maps each glyph back to the logical text it
     stands for (a lam-alef ligature maps to both letters);
   - a `/CIDToGIDMap` stream.

   The content stream draws the face's own glyph ids as CIDs. The cmap gives
   the ids.
3. **Subset per document.** `truetype.ts:207` (`compactTrueType`) embeds only
   the glyphs a document drew, plus their composite closure. It renumbers them
   densely, and the CIDToGIDMap says where each one went. Without the
   renumbering, one drawn name cost about 18.6 KB, because a slot-preserving
   subset still ships a full hmtx and loca. With it, a one-name schedule is
   about 8.3 KB. A Latin one is 1.4 KB.
4. **Shaping by Unicode Presentation Forms, not GSUB** (`arabic.ts:148`,
   `shape`). Each letter's joining type picks its isolated, initial, medial or
   final form:
   - Arabic letters use Forms-B.
   - Alef maksura's initial and medial forms, and پ چ ژ ک گ ی, use Forms-A.
   - Lam followed by alef (four variants) becomes one ligature.
   - Marks are transparent to joining and ride with their base.
   - ZWNJ and ZWJ steer the joining and are not drawn.

   Parsing GSUB lookups would be much more code. The presentation forms cover
   every letter a Gulf name or address uses.
5. **Bidi: a subset of UAX #9 for single-line cells** (`arabic.ts:248`,
   `reorder`). It implements:
   - P2/P3, with a fallback direction for strings that have no strong letter;
   - W1–W7;
   - N0 for bracket pairs, then N1–N2;
   - I1–I2;
   - L1–L2;
   - L4 mirroring.

   It drops explicit embeddings and isolates. It makes **one deliberate
   deviation**, at W4: `-`/`+` between Arabic-context numbers (AN) joins
   them. Strict UAX #9 prints "تاريخ 2026-06-15" as "15-06-2026", and a
   document full of ISO dates and policy numbers cannot afford that.

   The renderer draws in visual order. Latin runs stay Helvetica in the same
   text object. Each Arabic-bearing string is wrapped in a
   `/Span << /ActualText … >> BDC … EMC` that carries the logical string, so
   copy, search and screen readers get the text as typed.
6. **`pdfSafe` keeps its meaning: "text this renderer genuinely cannot draw".**
   That now means a character outside Latin-1 that is not an Arabic code point
   the face covers *and* the shaper can join (`pdf.ts:423`). CJK and Hebrew
   are refused. So are a Latin letter outside Latin-1 (still never
   approximated) and an Arabic-script letter with no presentation form (ڤ,
   for example), which would print unjoined.
7. **Latin output is byte-identical.** Only a string that matches
   `HAS_ARABIC` takes the new path. The font objects are written only when a
   glyph of the face was drawn, and they come after every page object, so no
   object number moves. `pdf-arabic.test.ts` pins the SHA-256 of a Latin
   document captured from the writer before this change.
8. **Documents are written in the customer's language.**
   - `axis-policy-document.ts:299` picks the locale from
     `core_customers.locale`. It falls back to the requester's `ctx.locale`
     only when there is no customer row. The schedule issued automatically at
     bind has no reader of its own, and the document is the customer's.
   - Arabic nouns sit beside the English ones per domain pack (CLAUDE.md
     §14).
   - `PdfOptions.direction: "rtl"` mirrors the page: title and meta flush
     right, columns in reverse order.
   - `PdfOptions.labels` translates the writer's own words: Generated,
     continued, Total, No data, and the page number.
   - The name is the customer's name in the document's language, else
     English, else whatever they gave.
9. **A bound browser still takes Arabic reports** (`render.ts`). It has full
   shaping, mark positioning and an RTL table layout. The in-process writer is
   now the fallback instead of a 400.

### Alternatives rejected

- **pdf-lib + @pdf-lib/fontkit.** They run on Workers, but they add two
  dependencies, each larger than this whole change (about 100 KiB raw).
  fontkit's shaping is also incomplete for Arabic without a separate shaper.
  It would also replace a writer whose Latin output other tests pin, all for
  a problem about 900 lines of code solve here (`arabic.ts`, `truetype.ts`,
  `pdf-font.ts`).
- **HarfBuzz (harfbuzzjs, WASM).** It shapes correctly, marks included. It
  adds a WASM module of about 600 KB and an async instantiate to a synchronous
  writer. That would be the right upgrade if GPOS-quality marks become a
  requirement.
- **Browser Rendering only.** On-prem has no `render` service by default
  (`render.ts` comment), and a schedule must exist at bind time whatever is
  bound.

## Consequences

- Bundle (`wrangler deploy --dry-run`, apps/api): 4233.39 KiB / gzip
  862.51 KiB before, and **4333.28 KiB / gzip 905.95 KiB** after. That is
  +99.9 KiB raw and +43.4 KiB gzipped, far inside the Workers limit. The font
  is parsed once per isolate, on the first Arabic document.
- Every Arabic-name customer gets a schedule. `pdfSafe` refusals now come only
  from scripts no embedded font covers. The English-name fallback in
  `axis-policy-document.ts` stays for exactly those.
- **Known limits.** Each of these would need GSUB/GPOS parsing or HarfBuzz to
  remove:
  - Harakat are drawn at the font's default offset, with no GPOS mark
    positioning, so a vowelled name prints its marks slightly displaced.
  - There is no kashida, no optional or discretionary ligature (لله is
    drawn letter by letter), and no Arabic Supplement letters (U+0750–077F).
  - The face is Regular only, so Arabic in a bold Helvetica context (title,
    header band, totals) draws in regular weight.
  - Bidi has no explicit embeddings or isolates, and it lays out one line per
    string, which is all the writer has.
  - Text extraction depends on the viewer. Visual-order glyphs plus ToUnicode
    reverse correctly in bidi-aware extractors (pdf.js). ActualText covers
    Acrobat and assistive technology. MuPDF's plain extraction shows visual
    order.
- `pdfSafe` tests that asserted "Arabic is refused" (`export.test.ts`,
  `api.test.ts`) now assert the refusal on CJK and Hebrew. The spec (a
  document for every policy) won over the old test, per CLAUDE.md.
- docs/ui/north.md and docs/ui/ledger.md are updated: Arabic exports, and
  other scripts are still refused after the click.
