// What a workspace *is*, declared rather than hand-built. Every module screen
// is the same three things — a set of resource tabs, the columns each one shows,
// and the fields you may write — so those three things are data and one pair of
// route files renders them (routes/module.tsx, routes/record.tsx).
//
// A module needing more than this does not fight it: it adds a bespoke route
// alongside (the quote comparison, the conversation thread, the trial balance)
// and keeps the generic tabs for everything that really is a list.
//
// Labels live with the spec, not in the shell catalogue: a workspace owns its
// own vocabulary, and the domain pack may rename every noun in it (CLAUDE.md
// §14), so nothing here is ever an English literal in a component.

import { instantOf } from "@lyra/ui";
import type { Screen } from "@lyra/ui";
import { pseudoText, translator } from "../i18n";
import { vocabulary } from "./vocabulary";
import { humanise } from "@lyra/core/words";

// Screens import it from here because that is where they already look for the
// words a module puts on a table; the rule itself is shared with mobile.
export { humanise };

export type Row = Record<string, unknown>;

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  /** A share stored in parts per million, read and written as a percentage.
   * The channels list headed a column DEFAULT COMMISSION and printed `400000`
   * beside money columns, which reads as four hundred thousand rand. */
  | "rate"
  /** A multiplier stored in parts per million: an FX rate of 18.5 is 18500000
   * on the wire and must never read as 1850%. */
  | "ratio"
  /** A number whose meaning is a sibling column: NORTH snapshots store money,
   * basis points, milliseconds and plain counts in one `value`. */
  | "measure"
  | "money"
  | "select"
  | "date"
  | "datetime"
  | "boolean"
  | "json";

export interface FieldSpec {
  /** Column name as the API spells it (camelCase — apps/api/src/crud.ts). */
  name: string;
  type: FieldType;
  /** Options for `select`, as raw values; labelled via `optionLabel` — key
   * `<name>.<value>` preferred, bare `<value>` accepted. */
  options?: readonly string[];
  required?: boolean;
  /** Sits beside the input as help text, via its own label key. */
  hintKey?: string;
}

export interface ColumnSpec {
  name: string;
  type: FieldType;
  /** Column the API can sort on. Anything indexed is a safe yes. */
  sortable?: boolean;
  /** Renders as a status chip rather than plain text. */
  badge?: boolean;
  /** Currency comes from a sibling column, the platform stores minor units. */
  currencyFrom?: string;
  /** For `measure`: the column holding this row's unit (money|percent|ratio|duration_ms|count). */
  unitFrom?: string;
}

export interface FilterSpec {
  name: string;
  options: readonly string[];
}

/**
 * A state change the API owns and a PATCH may not impersonate. `/schedules/:id/pause`
 * recomputes `nextRunAt`; `/commission-entries/:id/clawback` writes journal lines.
 * Setting the column directly would leave the rest of that work undone, which is
 * why those columns stay out of `editable` and arrive here instead.
 *
 * Declared on the resource, rendered on the record screen (routes/record.tsx):
 *
 *   actions: [
 *     { intent: "pause", method: "POST", path: "/{id}/pause",
 *       labelKey: "schedules.pause", permission: "analytics:write" },
 *     { intent: "clawback", method: "POST", path: "/{id}/clawback",
 *       labelKey: "entries.clawback", permission: "dist:write", confirm: true,
 *       fields: [{ name: "reason", type: "textarea", required: true }] }
 *   ]
 */
export interface ActionSpec {
  /** Unique within the resource; submitted as the form's `intent`. */
  intent: string;
  /** POST is the only verb an action uses — a GET is a link, a PATCH is a field. */
  method: "POST";
  /** Appended to the resource's `api`, with `{id}` replaced: `/{id}/pause`. */
  path: string;
  /** Key in the workspace's own label table (`labels`), never an English literal. */
  labelKey: string;
  /** Withheld actions do not render at all. The API is still the authority. */
  permission: string;
  /** Input the endpoint requires — a reason on a reject, a note on a handover. */
  fields?: readonly FieldSpec[];
  /**
   * Consequential (CLAUDE.md §4): ask before posting. The prompt is
   * `<labelKey>.confirm` in the workspace's label table.
   */
  confirm?: boolean;
}

export interface ResourceSpec {
  /** URL segment inside the workspace: `/axis/cases`. */
  key: string;
  /** API path, without the origin: `/v1/axis/cases`. */
  api: string;
  /** Permission that decides whether the tab is offered at all. */
  read: string;
  /** Permissions for the write affordances. Absent means the button never renders. */
  create?: string;
  update?: string;
  remove?: string;
  columns: readonly ColumnSpec[];
  /** Passed as `?q=`; only resources registered `searchable` in the API honour it. */
  search?: boolean;
  filters?: readonly FilterSpec[];
  /** Fields the create form offers. Absent means create is not offered here. */
  fields?: readonly FieldSpec[];
  /** Fields the edit form offers; defaults to `fields` when omitted. */
  editable?: readonly FieldSpec[];
  /**
   * A field the create response carries once and no read ever returns — a
   * signing secret, a minted key. Named here so the create flow shows it
   * instead of discarding the response body; it is never a column.
   */
  revealOnCreate?: string;
  /** Default sort column, defaulting to the API's own (createdAt desc). */
  sort?: string;
  order?: "asc" | "desc";
  /**
   * A screen that goes deeper than one record's fields — the comparison behind a
   * quote request, the thread behind a conversation. `{id}` is the record's id.
   * Rendered as an action on the record, which is the only place it makes sense.
   */
  recordLink?: { href: string; labelKey: string };
  /** State changes the API owns, offered on the record. See ActionSpec. */
  actions?: readonly ActionSpec[];
}

export interface WorkspaceSpec {
  /** Nav href this workspace answers to: `/axis`. */
  path: string;
  /** Every label key this workspace uses, per locale. Keys are bare (`cases`, */
  /** `status.intake`) and resolved through `labeller()`. */
  labels: Record<string, Record<string, string>>;
  tabs: readonly ResourceSpec[];
  /** Bespoke routes that belong to this workspace, shown as a link strip. */
  links?: readonly LinkSpec[];
  /**
   * Screens from the Constellation design pull (packages/ui/src/sections),
   * keyed by their own `id`. Optional and additive — most lookups go through
   * `surfaceFor` in ./surfaces.ts instead, since some screen modules (the
   * public portals, the phone gallery) have no `WorkspaceSpec` to hang off.
   */
  surfaces?: Record<string, Screen>;
}

/**
 * A bespoke screen this workspace links out to — a report, a run, a wizard.
 * `permission` is the one the target route itself gates on; state it and the
 * link stops being offered to an actor who would only be told no.
 */
export interface LinkSpec {
  href: string;
  labelKey: string;
  /**
   * Withheld links do not render at all — the same rule tabs and actions
   * follow. Omitted means the link is open to anyone who reached the
   * workspace; the route is still the authority either way.
   */
  permission?: string;
}

/** Reads a workspace's own catalogue, falling back to English, then the key. */
export function labeller(spec: WorkspaceSpec, locale: string) {
  const table = spec.labels[locale] ?? spec.labels.en ?? {};
  const fallback = spec.labels.en ?? {};
  return (key: string): string => table[key] ?? fallback[key] ?? key;
}

/**
 * The label function a screen actually uses: the tenant's domain pack first
 * (CLAUDE.md §14 — the pack may rename any noun), then the workspace's own
 * vocabulary, then the shared `common.*` catalogue, then the raw key. A module
 * never has to restate "Yes", "Created" or "Status" to get them translated.
 */
export function labelsFor(spec: WorkspaceSpec, locale: string, pack?: string) {
  const packed = vocabulary(pack, locale);
  const own = labeller(spec, locale);
  const t = translator(locale);
  return (key: string): string => {
    // `t()` pseudoizes on its own; the pack and the workspace's own tables are
    // catalogues the translator never sees, so they need the wrap here or the
    // pseudo-locale detector cannot tell them from a hardcoded literal.
    const renamed = packed(key);
    if (renamed !== undefined) return pseudoText(locale, renamed);
    const local = own(key);
    if (local !== key) return pseudoText(locale, local);
    const shared = t(`common.${key}`);
    return shared === `common.${key}` ? key : shared;
  };
}

/**
 * The label for one enum *value* — a badge's status, a filter's choice, a
 * select's option. Modules spell these two ways in the wild: qualified by the
 * column they belong to (`state.open`, as this file documents) and bare
 * (`open`). The renderer adapts rather than the specs, so both resolve:
 *
 *   1. `<owner>.<value>` — the documented convention (distribution, ledger)
 *   2. `<value>` — the bare convention (orbit, signal, scout, north, …)
 *   3. `humanise(value)` — a workspace that never wrote the label at all
 *
 * Step 3 is what stops a screen showing `pending_settlement` or a naked i18n
 * key to a person. `owner` is the column/field/filter name the value sits under.
 */
export function optionLabel(
  label: (key: string) => string,
  owner: string,
  value: string
): string {
  return optionWords(label, owner, value) ?? humanise(value);
}

/**
 * The pack's words for an enum value, or null when it has none. Plain text
 * cells need the difference: a channel key (`direct-web`) and a policy number
 * are not enums and must survive untouched, where `humanise` would mangle both.
 */
export function optionWords(
  label: (key: string) => string,
  owner: string,
  value: string
): string | null {
  const qualified = `${owner}.${value}`;
  const found = label(qualified);
  if (found !== qualified) return found;
  const bare = label(value);
  if (bare !== value) return bare;
  return null;
}


/**
 * A notification title. `titleKey` is open-ended — engines, seeds and future
 * modules mint their own — so a key the catalogue has never heard of rendered
 * as itself: the inbox said `ai.guardrail.blocked` where a sentence belongs.
 * Pass what the lookup returned and the key it was asked for; an unresolved
 * lookup returns the key (route tables prefix theirs, hence `endsWith`).
 */
export function titleText(said: string, key: string): string {
  return said.endsWith(key) ? humanise(key) : said;
}

/** `cases` → the tab, or undefined. */
export function tabOf(spec: WorkspaceSpec, key: string | undefined): ResourceSpec | undefined {
  return key ? spec.tabs.find((tab) => tab.key === key) : spec.tabs[0];
}

/* ---------------------------------------------------------------- saved views */
// docs/27 "saved views are written, listed, and never applied", closed. Full
// contract in ui.md §7.0 — `route` is the resource-tab path (`${spec.path}/
// ${tab.key}`), never the bespoke screen a segment away, and only `queryJson`
// is ever applied; `columnsJson` implies per-user column selection module.tsx
// does not have and stays untouched.

/**
 * The query keys `module.tsx`'s loader recognises for this tab: the reserved
 * ones every list understands (`q`, `sort`, `order`) plus every `FilterSpec`
 * name this tab itself declares. Nothing wider — a filter the tab never wired
 * up is not a key a saved view may reach through, whatever column it names on
 * the API side.
 */
export function recognizedQueryKeys(tab: ResourceSpec): Set<string> {
  const keys = new Set<string>(["q", "sort", "order"]);
  for (const filter of tab.filters ?? []) keys.add(filter.name);
  return keys;
}

/**
 * A saved view's stored `queryJson`, narrowed to what this tab still
 * recognises and turned into the string values the loader's own query state
 * holds. A view is written once and a tab's filters can change under it —
 * `crud.ts`'s generic list throws `badRequest("unknown filter column …")` on
 * any key it does not find as a column, so forwarding a stale key straight
 * through would turn "apply a saved view" into a crash. Dropping what this tab
 * no longer recognises is the honest degradation: a narrower view, not a 400.
 */
export function queryFromSavedView(
  tab: ResourceSpec,
  queryJson: Record<string, unknown>
): Record<string, string> {
  const recognized = recognizedQueryKeys(tab);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryJson)) {
    if (!recognized.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/** Tabs this actor may read. The API would 403 the rest; better to not offer them. */
export function visibleTabs(spec: WorkspaceSpec, permissions: readonly string[]): ResourceSpec[] {
  const held = new Set(permissions);
  return spec.tabs.filter((tab) => held.has(tab.read));
}

/**
 * Actions this actor may take. Withholding is absence, not a disabled button —
 * the same rule the tabs and the create panel follow. The API re-checks.
 */
export function visibleActions(
  tab: ResourceSpec,
  permissions: readonly string[]
): readonly ActionSpec[] {
  const held = new Set(permissions);
  return (tab.actions ?? []).filter((action) => held.has(action.permission));
}

/**
 * Links this actor may follow. A screen they cannot use degrades to a denied
 * notice rather than a blank, but the notice is a dead end: withholding is
 * absence here too. A link that names no permission is offered to everyone who
 * got as far as the workspace.
 */
export function visibleLinks(
  spec: WorkspaceSpec,
  permissions: readonly string[]
): readonly LinkSpec[] {
  const held = new Set(permissions);
  return (spec.links ?? []).filter((link) => !link.permission || held.has(link.permission));
}

/** `/v1/analytics/schedules` + `/{id}/pause` → `/v1/analytics/schedules/<id>/pause`. */
export function actionUrl(tab: ResourceSpec, action: ActionSpec, id: string): string {
  return `${tab.api}${action.path.replace("{id}", encodeURIComponent(id))}`;
}

/**
 * Turn a submitted form into a JSON body the API will accept: numbers as
 * numbers, booleans as booleans, JSON columns as objects. An empty string means
 * "not supplied" rather than "set to empty" — clearing a value is `null`, which
 * only the JSON editor can express.
 */
export function bodyFrom(fields: readonly FieldSpec[], form: FormData): Row {
  const out: Row = {};
  for (const field of fields) {
    const raw = form.get(field.name);
    if (raw === null) {
      // An unchecked checkbox submits nothing at all, and false is a value.
      if (field.type === "boolean") out[field.name] = false;
      continue;
    }
    const value = String(raw).trim();
    if (value === "") continue;

    switch (field.type) {
      case "number":
      case "money":
        out[field.name] = Number(value);
        break;
      case "rate": {
        const percent = Number(value);
        if (Number.isFinite(percent)) out[field.name] = Math.round(percent * 10_000);
        break;
      }
      case "ratio": {
        const factor = Number(value);
        if (Number.isFinite(factor)) out[field.name] = Math.round(factor * 1_000_000);
        break;
      }
      case "boolean":
        out[field.name] = value === "on" || value === "true";
        break;
      case "date":
      case "datetime": {
        // <input type="date"> is a local calendar date; the platform stores
        // epoch milliseconds (packages/db uses integer timestamps throughout).
        const ms = Date.parse(field.type === "date" ? `${value}T00:00:00Z` : value);
        if (!Number.isNaN(ms)) out[field.name] = ms;
        break;
      }
      case "json":
        out[field.name] = JSON.parse(value) as unknown;
        break;
      default:
        out[field.name] = value;
    }
  }
  return out;
}

/** The value an edit form should show for a field, in input-native format. */
export function inputValue(field: FieldSpec, row: Row | undefined): string {
  const value = row?.[field.name];
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "rate": {
      const ppm = Number(value);
      return Number.isFinite(ppm) ? String(ppm / 10_000) : "";
    }
    case "ratio": {
      const ppm = Number(value);
      return Number.isFinite(ppm) ? String(ppm / 1_000_000) : "";
    }
    case "date":
    case "datetime": {
      // `instantOf` rather than `Number.isFinite`: it also rejects the band no
      // `Date` can hold (beyond ±8.64e15 ms), where `toISOString` throws
      // `RangeError` — and this runs while the edit form renders, so the throw
      // costs the whole record screen. Blank, not the app's dash: an
      // `<input type="date">` can hold an empty value or a date, nothing else.
      const at = instantOf(Number(value));
      if (at === null) return "";
      const iso = at.toISOString();
      return field.type === "date" ? (iso.slice(0, 10) as string) : iso.slice(0, 16);
    }
    default:
      return String(value);
  }
}
