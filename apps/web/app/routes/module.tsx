import { useEffect, useRef, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, EmptyState, Input, Panel, Select, Table, type Column, isOpaqueRef } from "@lyra/ui";
import { ApiError, api, asRouteError, fetchMe, names } from "../api.server";
// rejectedBy runs in the component, not the loader: importing it from the
// .server module pulls that module into the client bundle (api-error.ts exists
// for exactly this, see its header).
import { rejectedBy } from "../api-error";
import { Cell, FieldInput } from "../components/fields";
import { usePending } from "../components/pending";
import { cloudflare } from "../context";
import { localeFrom, translator } from "../i18n";
import { refOptions } from "../record.server";
import type { RefOption } from "../components/ref-picker";
import { workspaceFor } from "../modules";
import {
  bodyFrom,
  labelsFor,
  optionLabel,
  queryFromSavedView,
  recognizedQueryKeys,
  tabOf,
  visibleTabs,
  type ResourceSpec,
  type Row,
  type WorkspaceSpec
} from "../modules/spec";
import { labelKeyFor } from "../routing";
import { useShellData } from "./workspace";

// The list screen for every declared resource in every workspace. One file,
// because a list is a list: tabs the actor may read, a filter bar, a table, a
// keyset pager and — where the actor holds the permission — a create form.
// Anything that needs more than that gets its own route and links in from here.

interface Page {
  data: Row[];
  cursor?: string;
  total?: number;
}

/**
 * Mirrors `GET /v1/analytics/saved-views`'s row (apps/api/src/routes/analytics.ts)
 * — id, name and isDefault are all the picker needs; `queryJson` is parsed
 * once here and never leaves the loader (see `queryFromSavedView`, spec.ts).
 */
interface SavedViewRow {
  id: string;
  name: string;
  isDefault: boolean;
  queryJson: string;
}

/** The picker's own shape, sent to the client — no `queryJson`, it never renders it. */
interface SavedViewOption {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * `queryJson` as stored is always this loader's own `JSON.stringify` output
 * (the API never writes anything else), so a parse failure means a row this
 * loader did not write — degrade to "no filters" rather than crash the list
 * underneath it.
 */
function parseQueryJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The URL carries no explicit filter, search or sort choice for this tab —
 * the state a first visit is in, and the only state in which a saved view's
 * `isDefault` row may pre-apply itself without overriding something the
 * reader already typed.
 */
function isPristine(tab: ResourceSpec, params: URLSearchParams): boolean {
  for (const key of recognizedQueryKeys(tab)) if (params.get(key)) return false;
  return true;
}

/** Query keys the API reserves; everything else is an exact-match column filter. */
const RESERVED = ["q", "cursor", "sort", "order"] as const;

/**
 * How many rows a page holds. The API's own default is 50 (ListQuery,
 * apps/api/src/http.ts) and that stays the unsaid choice — these are the sizes
 * the footer offers when 50 is the wrong one, a triage queue read a screenful
 * at a time or a reconciliation read in one sitting.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

/** What the API pages by when nobody says otherwise (ListQuery's `default(50)`). */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The chosen size, or null for "whatever the API defaults to". Only a size the
 * picker offers counts: `?limit=10000` is not a page size, it is a way to ask
 * for the whole tenant in one response, and while the API caps it (MAX_PAGE)
 * the screen has no reason to forward it.
 */
export function pageSizeIn(params: URLSearchParams): number | null {
  const raw = Number(params.get("limit"));
  return (PAGE_SIZES as readonly number[]).includes(raw) ? raw : null;
}

function resolve(params: { module?: string; resource?: string }): {
  spec: WorkspaceSpec;
  tab: ResourceSpec;
} {
  const spec = workspaceFor(`/${params.module ?? ""}`);
  if (!spec) throw data("workspace", { status: 404 });
  const tab = tabOf(spec, params.resource);
  if (!tab) throw data("resource", { status: 404 });
  return { spec, tab };
}

/** Every ref-shaped string in the page, whichever column it happens to sit in. */
function refsIn(rows: readonly Row[]): string[] {
  return rows.flatMap((row) =>
    Object.values(row).filter((value): value is string => typeof value === "string" && isOpaqueRef(value))
  );
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const { spec, tab } = resolve(params);
  const env = context.get(cloudflare).env;
  const incoming = new URL(request.url).searchParams;

  const query = new URLSearchParams();
  for (const key of RESERVED) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }
  if (!query.has("sort") && tab.sort) {
    query.set("sort", tab.sort);
    query.set("order", tab.order ?? "desc");
  }
  for (const filter of tab.filters ?? []) {
    const value = incoming.get(filter.name);
    if (value) query.set(filter.name, value);
  }

  // Saved views (docs/27 "saved views are written, listed, and never
  // applied", closed; full contract in ui.md §7.0). `route` is this resource
  // tab's own path — `${spec.path}/${tab.key}` — never the bespoke screen a
  // segment away. Best-effort: an actor without analytics:saved_views:read
  // still gets the ordinary list, just no picker.
  const savedViewRoute = `${spec.path}/${tab.key}`;
  const savedViewsPage = await api<{ data: SavedViewRow[] }>(
    `/v1/analytics/saved-views?route=${encodeURIComponent(savedViewRoute)}`,
    { env, request }
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
      return { data: [] };
    }
    return asRouteError(error);
  });
  const savedViews = (savedViewsPage.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    query: parseQueryJson(row.queryJson)
  }));

  // `?view=` present but empty is an explicit "no view": without it the
  // default could never be left, since dropping `view` is pristine again.
  const requestedView = incoming.get("view");
  const chosen = requestedView
    ? savedViews.find((view) => view.id === requestedView)
    : requestedView === null && isPristine(tab, incoming)
      ? savedViews.find((view) => view.isDefault)
      : undefined;

  if (chosen) {
    // A picked view replaces this tab's filter/sort state; it does not merge
    // with whatever partial state the URL already carried.
    for (const key of recognizedQueryKeys(tab)) query.delete(key);
    for (const [key, value] of Object.entries(queryFromSavedView(tab, chosen.query))) query.set(key, value);
  }

  // `deleted` deliberately sits outside RESERVED's pass-through. The API parses
  // it with `z.coerce.boolean()` (ListQuery, apps/api/src/http.ts), which is
  // `Boolean(value)` — so "false" and "0" would both switch the deleted view ON.
  // Only an explicit "1" opts in, and the parameter is otherwise never sent.
  const deleted = incoming.get("deleted") === "1";
  if (deleted) query.set("deleted", "1");

  const pageSize = pageSizeIn(incoming);
  if (pageSize) query.set("limit", String(pageSize));

  // Choices for the create form's id fields load beside the list, not after it.
  const choices = refOptions(tab.fields ?? [], localeFrom(request), { env, request });
  const page = await api<Page>(`${tab.api}?${query.toString()}`, { env, request }).catch(
    async (error: unknown) => {
      // `/admin` with no resource lands on the first declared tab, which is not
      // always a tab this actor may read — a compliance officer's first
      // readable admin tab may be the fifth. Rather than tell them the whole
      // workspace is closed, send them to the first one they do hold.
      if (error instanceof ApiError && error.status === 403 && !params.resource) {
        const me = await fetchMe(env, request).catch(asRouteError);
        const readable = visibleTabs(spec, me.permissions).find((other) => other.key !== tab.key);
        if (readable) throw redirect(`${spec.path}/${readable.key}`);
      }
      return asRouteError(error);
    }
  );

  // Every list carries refs its rows have no names for — the cases list headed
  // a column OWNER and printed `user:us_01KE…`. One batch per page names them
  // all; anything unresolved falls back to the short ref (Cell).
  const rows = page.data ?? [];
  const resolved = await names(refsIn(rows), { env, request });

  return {
    modulePath: spec.path,
    resource: tab.key,
    rows,
    resolved,
    cursor: page.cursor ?? null,
    deleted,
    query: Object.fromEntries(query),
    savedViews: savedViews.map((view): SavedViewOption => ({ id: view.id, name: view.name, isDefault: view.isDefault })),
    activeView: chosen?.id ?? null,
    refOptions: await choices
  };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { tab } = resolve(params);
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  try {
    if (intent === "create") {
      const created = await api<Record<string, unknown>>(tab.api, {
        env,
        request,
        method: "POST",
        body: bodyFrom(tab.fields ?? [], form)
      });
      // Straight back to this render, never a redirect: the create response is
      // the only place a minted secret ever appears (apps/api/src/resources.ts
      // strips it from every read).
      const revealed = tab.revealOnCreate ? created[tab.revealOnCreate] : undefined;
      // The new row's id comes back so the screen can say "created", link it,
      // and clear the form — a silent success invited a duplicate second press.
      const createdId = typeof created.id === "string" ? created.id : "";
      return {
        problem: null,
        revealed: typeof revealed === "string" && revealed ? revealed : null,
        created: createdId
      };
    } else if (intent === "delete" && id) {
      await api(`${tab.api}/${id}`, { env, request, method: "DELETE" });
    } else if (intent === "restore" && id) {
      // The API gates restore on the resource's `remove` permission — the same
      // one delete uses (apps/api/src/crud.ts, the `perm` closed over by both
      // `DELETE /:id` and `POST /:id/restore`).
      await api(`${tab.api}/${id}/restore`, { env, request, method: "POST" });
    } else {
      return { problem: { title: "unknown intent", status: 400 }, revealed: null, created: null };
    }
  } catch (error) {
    // A rejected write is information, not a crash: keep the actor on the page
    // with their input intact and show what the API objected to.
    if (error instanceof ApiError) return { problem: error.problem, revealed: null, created: null };
    throw error;
  }
  return { problem: null, revealed: null, created: null };
}

export default function ModuleList() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const problem = result?.problem ?? null;
  // Lives for exactly one render — a reload or a second create clears it.
  const revealed = result?.revealed ?? null;
  const shell = useShellData();
  const pending = usePending();
  const [searchParams, setSearchParams] = useSearchParams();

  const locale = shell?.locale ?? "en";
  const permissions = shell?.permissions ?? [];
  const t = translator(locale, shell?.overrides);
  const spec = workspaceFor(loaded.modulePath);
  if (!spec) return null;
  const tab = tabOf(spec, loaded.resource);
  if (!tab) return null;
  const label = labelsFor(spec, locale, shell?.domainPack);
  // Marks the inputs a rejected create named, so the reader is pointed at the
  // field to fix rather than told only that something was wrong. Every declared
  // resource in every workspace creates through this one form.
  const rejected = rejectedBy(problem, () => t("error.field"));
  const held = new Set(permissions);

  const tabs = visibleTabs(spec, permissions);
  const rows = loaded.rows;

  // Nothing in the spec says whether a resource has a `deletedAt` column, so
  // the actor's `remove` permission stands in for soft-deletability: the API
  // only registers restore for soft-deleting resources and gates both the
  // `?deleted` list and the restore route on exactly this permission
  // (apps/api/src/crud.ts). A hard-deleting resource answers 400, so the toggle
  // is offered only to the actor who could have caused a deletion in the first
  // place. Add a `softDelete` flag to ResourceSpec if that ever proves too wide.
  const canRestore = Boolean(tab.remove && held.has(tab.remove));
  const deletedView = loaded.deleted;
  // Whether this actor can create here at all. The empty state and the panel
  // itself must agree: telling a reader without `tab.create` to "create the
  // first one" names a control that is not on their page.
  const canCreate = Boolean(tab.fields && tab.create && held.has(tab.create) && !deletedView);

  const columns: Array<Column<Row>> = tab.columns.map((column, index) => ({
    key: column.name,
    header: label(column.name),
    sortable: column.sortable ?? false,
    numeric: column.type === "money" || column.type === "number",
    render: (row: Row) =>
      // The first column is the way into the record — one predictable target
      // per row beats a whole-row click nobody can reach from a keyboard. A
      // deleted row has no record page to open (the record loader reads the
      // live scope and would 404), so it stays plain text until restored.
      index === 0 && !deletedView ? (
        <Link
          to={`${spec.path}/${tab.key}/${String(row.id)}`}
          className="font-medium text-text underline-offset-2 hover:underline"
        >
          <Cell column={column} row={row} locale={locale} label={label} resolved={loaded.resolved} />
        </Link>
      ) : (
        <Cell column={column} row={row} locale={locale} label={label} resolved={loaded.resolved} />
      )
  }));

  if (deletedView && canRestore) {
    columns.push({
      key: "restore",
      header: t("common.actions"),
      render: (row: Row) => (
        <Form method="post">
          <input type="hidden" name="intent" value="restore" />
          <input type="hidden" name="id" value={String(row.id)} />
          <Button type="submit" variant="secondary" size="sm">
            {t("common.restore")}
          </Button>
        </Form>
      )
    });
  }

  const sortKey = loaded.query.sort;
  // What the rows were actually asked for — the URL, or a saved view the
  // loader applied on its behalf. Reading only the URL showed "All" in every
  // filter and "No records yet" under a default view that had narrowed them.
  const current = (name: string) => searchParams.get(name) ?? loaded.query[name] ?? "";
  const filtered =
    (tab.filters ?? []).some((filter) => current(filter.name)) || Boolean(current("q")) || Boolean(loaded.activeView);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        {/* The heading names what is on screen — the tab — with the workspace
            above it; "Operations" over every one of its 16 lists said nothing
            about which list this was. */}
        {tabs.length > 1 ? (
          <div className="flex flex-col gap-1">
            <p className="eyebrow">{t(labelKeyFor(spec.path))}</p>
            <h1 className="page-title">{label(tab.key)}</h1>
          </div>
        ) : (
          <h1 className="page-title">{t(labelKeyFor(spec.path))}</h1>
        )}

        {tabs.length > 1 ? (
          // One row that scrolls sideways, the current tab kept in view: admin's
          // 35 tabs used to wrap into three rows above the table.
          // Phones only: on a wider screen the rail's workspace menu lists
          // these same records beside the page (components/menu.ts).
          <nav aria-label={t("common.tabs")} className="-mx-1 overflow-x-auto px-1 pb-1 md:hidden">
            <ul className="flex w-max gap-1">
              {tabs.map((entry) => {
                const current = entry.key === tab.key;
                return (
                  <li key={entry.key}>
                    <Link
                      to={`${spec.path}/${entry.key}`}
                      aria-current={current ? "page" : undefined}
                      ref={current ? (link) => link?.scrollIntoView?.({ block: "nearest", inline: "nearest" }) : undefined}
                      className={[
                        "inline-flex h-8 items-center whitespace-nowrap rounded-md px-3 font-ui text-13 transition-colors duration-150",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                        current
                          ? "bg-surface-2 font-medium text-text"
                          : "text-subtle hover:bg-surface-2 hover:text-text"
                      ].join(" ")}
                    >
                      {label(entry.key)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}

        {/* The workspace's own screens (reports, tools, desks) are in the
            rail's workspace menu on every screen of it (components/menu.ts),
            so they are not repeated here as a row of small links. */}
      </header>

      {/* Which saved filter/sort state this tab is showing (docs/27 "saved
          views are written, listed, and never applied", closed; ui.md §7.0).
          Only rendered when at least one view exists for this route — most
          tabs have none. Picking one replaces the filter bar's state below;
          it never merges with whatever the reader already typed there. */}
      {loaded.savedViews.length ? (
        <label className="flex items-center gap-2 font-ui text-12 text-subtle">
          <span>{t("common.savedView")}</span>
          <Select
            size="sm"
            className="w-56"
            aria-label={t("common.savedView")}
            value={loaded.activeView ?? ""}
            options={[
              { value: "", label: t("common.savedView.none") },
              ...loaded.savedViews.map((view) => ({ value: view.id, label: view.name }))
            ]}
            onValueChange={(next) => {
              const params = new URLSearchParams();
              params.set("view", next);
              const size = pageSizeIn(searchParams);
              if (size) params.set("limit", String(size));
              setSearchParams(params);
            }}
          />
        </label>
      ) : null}

      {/* Deleted rows look nothing like live ones: the list is banded, says so
          in words, and offers the way back. */}
      {deletedView ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <p className="font-ui text-13 text-text">{t("common.deleted.notice")}</p>
          <Link
            to={`${spec.path}/${tab.key}`}
            className="font-ui text-13 text-text underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t("common.deleted.back")}
          </Link>
        </div>
      ) : null}

      {tab.search || tab.filters?.length || canRestore ? (
        <Form
          // Remount on a new query so the uncontrolled defaults follow a view
          // picked from the saved-view menu.
          key={JSON.stringify(loaded.query)}
          method="get"
          {...(tab.search ? { role: "search" } : {})}
          className="flex flex-wrap items-end gap-3"
        >
          {tab.search ? (
            <Input
              type="search"
              name="q"
              defaultValue={current("q")}
              aria-label={t("common.search")}
              placeholder={t("common.search")}
              className="w-64"
            />
          ) : null}
          {(tab.filters ?? []).map((filter) => (
            <Select
              key={filter.name}
              name={filter.name}
              aria-label={label(filter.name)}
              defaultValue={current(filter.name)}
              placeholder={label(filter.name)}
              // Narrow on purpose: a filter strip is one line of questions above
              // the rows, not a column of full-width controls that pushes the
              // table under the fold.
              className="w-44"
              options={[
                { value: "", label: t("common.all") },
                ...filter.options.map((option) => ({
                  value: option,
                  label: optionLabel(label, filter.name, option)
                }))
              ]}
            />
          ))}
          {canRestore ? (
            <Select
              name="deleted"
              aria-label={t("common.deleted.state")}
              defaultValue={deletedView ? "1" : ""}
              placeholder={t("common.deleted.live")}
              className="w-44"
              options={[
                { value: "", label: t("common.deleted.live") },
                { value: "1", label: t("common.deleted.only") }
              ]}
            />
          ) : null}
          {/* Filtering is a new question about the same rows, not a decision to
              go back to reading 50 at a time — this GET replaces the query
              string wholesale, so the chosen page size rides along. */}
          {pageSizeIn(searchParams) ? (
            <input type="hidden" name="limit" value={String(pageSizeIn(searchParams))} />
          ) : null}
          <Button type="submit" variant="secondary" loading={pending.get}>
            {t("common.apply")}
          </Button>
          {filtered ? (
            <Button asChild variant="ghost">
              <Link to={`${spec.path}/${tab.key}?view=`}>{t("common.clear")}</Link>
            </Button>
          ) : null}
        </Form>
      ) : null}

      {/* A rejected write and the form that caused it stay together, above the
          table: the actor reads the objection where they typed, not after a
          screen of rows. */}
      {problem ? <Problem problem={problem} /> : null}

      {revealed ? (
        <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-surface-2 p-3">
          <h3 className="font-display text-14 text-text">{t("common.reveal.title")}</h3>
          <p className="max-w-prose font-ui text-12 text-subtle">{t("common.reveal.body")}</p>
          {/* Selectable text, not an input: nothing here should look editable,
              and a screen reader should read it as the value it is. */}
          <code role="status" className="break-all font-mono text-13 text-text">
            {revealed}
          </code>
        </div>
      ) : null}

      {canCreate ? (
        <CreatePanel
          tab={tab}
          label={label}
          t={t}
          busy={pending("create")}
          defaultOpen={Boolean(problem)}
          rejected={rejected}
          outcome={result}
          options={loaded.refOptions}
          recordHref={(id) => `${spec.path}/${tab.key}/${encodeURIComponent(id)}`}
        />
      ) : null}

      {/* The table is the screen, so it gets the screen's container: a Horizon
          panel, unpadded because the table draws its own gutters. Every module
          list without a bespoke route renders through here, so this one line
          decides how the default list screen looks. No hue — the shell already
          signs the module once, above the workspace. */}
      <Panel padded={false}>
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.id)}
          caption={
            deletedView
              ? `${t(labelKeyFor(spec.path))} — ${label(tab.key)} — ${t("common.deleted.only")}`
              : `${t(labelKeyFor(spec.path))} — ${label(tab.key)}`
          }
          density="compact"
          stickyHeader
          {...(sortKey
            ? { sort: { key: sortKey, direction: (loaded.query.order ?? "desc") as "asc" | "desc" } }
            : {})}
          onSortChange={(next) => {
            const params = new URLSearchParams(searchParams);
            params.set("sort", next.key);
            params.set("order", next.direction);
            params.delete("cursor");
            setSearchParams(params);
          }}
          empty={
            <EmptyState
              title={deletedView ? t("common.deleted.only") : t("common.empty.title")}
              body={
                deletedView
                  ? t("common.empty.deleted")
                  : filtered
                    ? t("common.empty.filtered")
                    : canCreate
                      ? t("common.empty.body")
                      : t("common.empty.none")
              }
              {...(deletedView
                ? {}
                : filtered
                  ? {
                      action: (
                        <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams({ view: "" }))}>
                          {t("common.empty.clear")}
                        </Button>
                      )
                    }
                  : canCreate
                    ? {
                        action: (
                          <Button variant="secondary" onClick={openCreatePanel}>
                            {t("common.new")}
                          </Button>
                        )
                      }
                    : {})}
            />
          }
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
              <div className="flex items-center gap-3">
                <span className="font-ui text-12 tabular-nums text-subtle">
                  {t("common.rows", { count: String(rows.length) })}
                </span>
                {/* How much of the queue you read at a time. Keyset paging has
                    no total to count against, so this is the only lever between
                    "a screenful" and "the whole morning's work" — and it was
                    the API's default with no way to say otherwise. Changing it
                    starts the list again: a cursor is a position in a page of
                    50 and means nothing in a page of 200. */}
                <label className="flex items-center gap-2 font-ui text-12 text-subtle">
                  <span>{t("common.rowsPerPage")}</span>
                  <Select
                    size="sm"
                    // It holds a two-digit number. Left to fill, it took the
                    // rest of the footer and folded "Rows per page" onto three
                    // lines beside it.
                    className="w-20"
                    aria-label={t("common.rowsPerPage")}
                    value={String(pageSizeIn(searchParams) ?? DEFAULT_PAGE_SIZE)}
                    options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                    onValueChange={(next) => {
                      const params = new URLSearchParams(searchParams);
                      params.delete("cursor");
                      if (Number(next) === DEFAULT_PAGE_SIZE) params.delete("limit");
                      else params.set("limit", next);
                      setSearchParams(params);
                    }}
                  />
                </label>
              </div>
              <div className="flex gap-2">
                {searchParams.get("cursor") ? (
                  <Button asChild variant="secondary" size="sm">
                    {/* Back to the top of *this* view: dropping the cursor alone
                        keeps the filters and the deleted/live switch. */}
                    <Link to={`?${firstPage(searchParams)}`}>{t("common.previous")}</Link>
                  </Button>
                ) : null}
                {loaded.cursor ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link to={`?${nextPage(searchParams, loaded.cursor)}`}>{t("common.next")}</Link>
                  </Button>
                ) : null}
              </div>
            </div>
          }
        />
      </Panel>
    </div>
  );
}

/**
 * Keyset paging is forward-only here: the cursor the API returns opens the next
 * page, and "Previous" goes back to the top of the list.
 * ponytail: a cursor stack would give true back-paging — add it when a screen
 * proves it needs to walk backwards rather than re-filter.
 */
function nextPage(current: URLSearchParams, cursor: string): string {
  const params = new URLSearchParams(current);
  params.set("cursor", cursor);
  return params.toString();
}

/** The same view, back at the first page. */
function firstPage(current: URLSearchParams): string {
  const params = new URLSearchParams(current);
  params.delete("cursor");
  return params.toString();
}

/**
 * The create panel's element id. The empty state says "create the first one",
 * and until it could open the panel that sentence named a control the reader
 * could not see: `<details>` ships closed, so the instruction pointed at a
 * collapsed disclosure three feet up the page. Opening it is what makes the
 * copy true.
 */
const CREATE_PANEL_ID = "module-create";

/** Open the create panel and put the cursor in it, from anywhere on the page. */
function openCreatePanel() {
  const panel = document.getElementById(CREATE_PANEL_ID);
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = true;
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  panel.querySelector<HTMLElement>("input, select, textarea")?.focus();
}

/**
 * Creation lives above the table, closed by default and re-opened when the API
 * rejected the last attempt — `<details>` does the disclosure, so there is no
 * open/closed state to keep in sync and no modal between the actor and the list.
 */
function CreatePanel({
  tab,
  label,
  t,
  busy,
  defaultOpen,
  rejected,
  outcome,
  options,
  recordHref
}: {
  tab: ResourceSpec;
  label: (key: string) => string;
  t: (key: string, vars?: Record<string, string>) => string;
  busy: boolean;
  defaultOpen: boolean;
  /** Which inputs the last rejected create named — the panel already reopens
   *  itself on a problem, and this is what it reopens *pointing at*. */
  rejected: (name: string) => string | undefined;
  /** The last action result; a new object per submission. */
  outcome: { created?: string | null } | undefined;
  options: Readonly<Record<string, readonly RefOption[]>>;
  recordHref: (id: string) => string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [made, setMade] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  // A create that went through clears the form and closes the panel, so a
  // second press cannot send the same row again, and says so where the
  // reader's focus lands.
  useEffect(() => {
    if (typeof outcome?.created !== "string") return;
    form.current?.reset();
    setOpen(false);
    setMade(outcome.created);
    summary.current?.focus();
  }, [outcome]);

  return (
    <div className="flex flex-col gap-2">
      <details
        id={CREATE_PANEL_ID}
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group rounded-lg border border-border bg-surface-1"
      >
        <summary ref={summary} className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 font-ui text-13 text-text marker:content-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <span
            aria-hidden="true"
            className="text-subtle transition-transform duration-150 group-open:rotate-45"
          >
            +
          </span>
          {/* Just "New". The panel sits under the table it adds a row to, and the
              screen is already titled — "New — Cases" was two labels joined by a
              dash because neither one could be dropped, which is a machine's
              sentence, not a person's. A singular noun per resource in every
              locale would buy "New case"; the context already says it. */}
          {t("common.new")}
        </summary>
        <Form ref={form} method="post" className="flex flex-col gap-4 border-t border-border p-4">
          <input type="hidden" name="intent" value="create" />
          <div className="grid gap-4 sm:grid-cols-2">
            {(tab.fields ?? []).map((field) => (
              <FieldInput key={field.name} field={field} label={label} invalid={rejected} options={options} />
            ))}
          </div>
          <div>
            <Button type="submit" loading={busy}>
              {t("common.create")}
            </Button>
          </div>
        </Form>
      </details>
      <p role="status" className="font-ui text-13 text-muted empty:hidden">
        {made !== null ? (
          <>
            <span aria-hidden="true" className="text-success">&#10003;</span> {t("common.created.notice")}{" "}
            {made ? (
              <Link to={recordHref(made)} className="text-accent underline underline-offset-4">
                {t("common.open")}
              </Link>
            ) : null}
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Titles the routes themselves raise, rather than the API. These are the one
 * class of problem whose wording we own, so they are translated here — at the
 * single place every route renders a refusal — instead of in each of the
 * twenty-odd `action`s that can produce one.
 */
const LOCAL_PROBLEM_TITLES: Record<string, "error.unknownIntent"> = {
  "unknown intent": "error.unknownIntent",
  unknown_intent: "error.unknownIntent"
};

/**
 * The one thing support can look up (docs/15 checklist item 10). Its own
 * component because three screens render a failure card whose *copy* differs —
 * <Problem> below, the compliance run's "the run did not happen", the SIGNAL
 * journey's inline draft error — and the reference line is the part that must
 * not differ between them. Renders nothing when the failure never reached the
 * API, which is when there is no id to quote.
 */
export function RequestId({ id }: { id?: string | undefined }) {
  const shell = useShellData();
  const t = translator(shell?.locale ?? "en");
  if (!id) return null;
  return <p className="font-mono text-12 text-muted">{t("error.requestId", { id })}</p>;
}

/** What the API objected to, in the actor's path rather than a toast. */
export function Problem({ problem }: { problem: { title: string; detail?: string; requestId?: string } }) {
  const shell = useShellData();
  const t = translator(shell?.locale ?? "en");
  const local = LOCAL_PROBLEM_TITLES[problem.title];
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
      <p className="font-ui text-13 text-text">
        {local ? t(local) : (problem.detail ?? problem.title)}
      </p>
      <RequestId id={problem.requestId} />
    </div>
  );
}

/**
 * A refusal, told apart: an action gated for approval (CLAUDE.md §4) is not a
 * failure — the work is queued, waiting on a second pair of eyes — so it reads
 * as a notice with the way onward, not as a red box with a policy key in it.
 * Anything else stays a <Problem>.
 */
export function Gate({
  problem,
  l
}: {
  problem: { title: string; status: number; detail?: string; requestId?: string };
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const extras = problem as { code?: string; policy_key?: string };
  if (problem.status === 403 && extras.code === "approval_required") {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/8 p-4">
        <span className="font-ui text-14 font-medium text-warning">{l("approvalTitle")}</span>
        <span className="font-ui text-13 text-muted">
          {l("approvalBody", { policy: extras.policy_key ?? problem.detail ?? problem.title })}
        </span>
        <Link to="/approvals" className="font-ui text-13 text-accent underline underline-offset-2">
          {l("approvalLink")}
        </Link>
      </div>
    );
  }
  return <Problem problem={problem} />;
}
