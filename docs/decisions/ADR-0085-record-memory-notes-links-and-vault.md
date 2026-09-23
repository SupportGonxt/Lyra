# ADR-0085 — Record memory: one markdown note per record, derived links, an Obsidian vault out

**Date:** 2026-09-23
**Status:** Accepted
**Builds on:** docs/16 H11 (memory: viewable, erasable, purpose-bound), docs/12 §3
(erasure), docs/15 §4 (✦ + why), CLAUDE.md §1, §2, §7, §13, §15
**Closes:** docs/27 F34's standing caveat — "`forgetMemories` … no DSAR runner calls it yet"

## Context

People asked for memory "in Obsidian type" per object: every record — customer,
policy, case, claim, conversation, campaign, partner, product, whitespace,
decision — carrying a markdown note with `[[links]]` to other records, a list of
what links back, a small graph of what it is connected to, what the AI itself
remembers about it, and an export a person can open in Obsidian.

What existed: `core_memories` (the AI's durable, purpose-bound claims, written and
read only by the ORBIT run), its CRUD resource behind `core:settings:*`, and
`forgetMemories` with no caller. No human-written note, no link table, and no
erasure job reached any of it.

CLAUDE.md §13 rules out the easy answer: no Obsidian Sync, no third-party notes
service. The capability lives in Lyra, and the export is a file, not a sync.

## Decision

**Two tables, not one.** `core_notes` (one per tenant + subject, `version` for
optimistic concurrency, unique on `(tenant_id, subject_ref)`) and `core_links`
(derived; `from_ref`, `to_ref`, `note_id`, unique per note + target, indexed both
ways). A note is what a person wrote; a memory is what the platform concluded.
They share a subject ref and an erasure path and nothing else, so a reader can
always tell which is which — the panel shows them in separate tabs, and only the
memory carries ✦.

**Refs.** A subject is stored canonically as `<kind>:<id>` where `kind` is the
singular of the registered resource's path (`customers` → `customer:cu_…`), the
spelling the seed and audit log already use. The API derives it from the id's
prefix through the same `REGISTRY` lookup `/v1/names` uses (`resourceOf`, with
its legacy aliases), so `cu_1`, `customer:cu_1` and `customers:cu_1` reach one
note. Link targets are canonicalised the same way on save; a `[[…]]` that names
no registered resource is not stored as a link (it still renders as text).

**Wikilink grammar** is `[[ref]]` / `[[ref|label]]`, parsed outside code spans and
fences by one pure function in `packages/core/src/wikilinks.ts`, property-tested
(fast-check, already approved in `packages/ledger`). The web imports it through a
dedicated export path (`@lyra/core/wikilinks`, like `@lyra/core/words`), so the
editor's picker and the server's link derivation cannot disagree.

**Two gates on every read.** `core:notes:read` / `core:notes:write` are new, held
by the operational roles and `tenant.admin` (`core:*:*`), read-only for
`tenant.compliance` and `finance.director`; `resync-roles` carries them to
tenants seeded earlier. On top of that, every request checks the subject
record's own read permission and that the row exists and is visible in the
tenant (404, never 403, for another tenant's row), and every *other* record a
response names — a backlink, a graph node, a vault file — is filtered by its own
read permission. A note is knowledge about its record; a backlink from a policy
you cannot open is a read of that policy. Names go through `resolveNames`, so a
reader without `core:pii:view` sees the masked customer name in the export too.

**Writes** are audited as `core.note.updated` with the version, length and link
count — never the text, the same rule `remember()` follows (docs/12 §4). A save
names the version it loaded; the check is in the UPDATE's own WHERE, so two
editors cannot both win (409). Links are rebuilt after the note lands through
`atomically` (the batch seam both homes share); a crash between the two leaves
links stale until the next save — they are derived, never authoritative.

**Erasure.** `onDsarUpdated` (`apps/api/src/engines/compliance-erasure.ts`)
consumes `compliance.dsar-requests.updated`. For a *fulfilled erasure* with a
customer it calls `forgetMemories` under every spelling the customer's memories
are held under (`customer:<id>`, bare id, each of their conversations) and
`forgetNotes`, which deletes the subject's note and every link to or from it and
rewrites that subject's wikilinks in *other* records' notes to `[…]` — the label
of a link is often the person's name. One `compliance_erasure_log` row per table,
once per DSAR. Fulfilment remains the compliance officer's decision; this makes
the memory half of it true rather than making it for them.

**Export** (`GET /v1/core/notes/export`): one `<Kind>/<name>.md` per non-empty
note the caller may read, YAML front matter (`ref`, `type`, `updated`), and every
wikilink the vault can name rewritten to Obsidian's path form
`[[<Kind>/<name>|label]]`. Duplicate names are disambiguated with the id; a
record with a file keeps the plain name. The zip reuses the STORED writer
already in `apps/api/src/engines/export/zip.ts` (XLSX, evidence bundles) rather
than adding a second one to `packages/core` — one CRC32, one byte layout, already
read back by `axis-audit-bundle.test.ts`'s reader. Audited as `core.note.exported`.

**AI memories** are exposed read-only through the existing memories resource
(`?subjectRef=<canonical>,<bare id>`), so the tab appears only for readers the
resource already admits (`core:settings:read`) and *Forget* is its generated
DELETE (`core:settings:update`). Each row carries ✦ with a why naming provenance,
purposes and sensitivity (docs/15 §4 pattern 5).

**Web.** `MemoryPanel` loads through a resource route (`/memory`) after the record
renders, sits below the record's own fields and forms, and withholds each tab the
reader may not use. Markdown renders through a ~150-line renderer that builds
React elements — no HTML string exists to inject into.

## Consequences

- Any record any resource registers can carry a note with no per-resource work,
  and a resource registered tomorrow is covered.
- Folder names in the vault are the technical kind (`Customer`, `Policy`), not
  the domain pack's noun. The export is a file for a person's own tool; the pack
  renames UI copy (CLAUDE.md §14), and a vault whose folders changed with the
  pack would break every link a person had added outside Lyra.
- Graph and backlink filtering is by resource permission, not per-row
  `rowVisible` (it would cost a row read per node); the names resolver does apply
  `rowVisible`, so an invisible row shows as "a record you cannot open", and the
  export drops notes on rows the resolver hid.
- Not built: full-text search over notes, note history (the audit log records
  that a save happened, not its diff), and embedding notes into agent recall —
  a note is not purpose-bound the way a memory is, so feeding it to a model needs
  its own purpose decision first.
