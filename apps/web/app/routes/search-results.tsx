import { Form, Link, useLoaderData, useNavigation, type LoaderFunctionArgs } from "react-router";
import { Button, Card, EmptyState, Input, Ref } from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { WORKSPACES } from "../modules";
import { labelsFor } from "../modules/spec";
import { hitToItem, type SearchHit, type SearchItem } from "./search";
import { useShellData } from "./workspace";
import { labelsFrom } from "./detail-kit";

// The full page behind the command palette. `routes/search.ts` answers the
// palette with JSON and stays exactly that; this is the screen you land on when
// ten rows in a dropdown are not enough, and it renders the same hits grouped by
// the resource they came from.
//
// /v1/search already refuses per resource: the base gate is core:search:read and
// each resource is then filtered by the caller's own read permission on it
// (apps/api/src/routes/search.ts). So a group appearing here IS permission to
// see it — nothing on this screen has to gate anything itself.

/** One resource's hits, in the order /v1/search walked its registry. */
export interface SearchGroup {
  resource: string;
  module: string;
  items: SearchItem[];
}

export function groupHits(hits: readonly SearchHit[]): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const hit of hits) {
    // No string id means no record route to open, so the row is not a result.
    const item = hitToItem(hit);
    if (!item) continue;
    const existing = groups.find((g) => g.resource === hit.resource && g.module === hit.module);
    if (existing) existing.items.push(item);
    else groups.push({ resource: hit.resource, module: hit.module, items: [item] });
  }
  return groups;
}

/**
 * The tab that owns a resource, so its heading can be the workspace's own word
 * for it — which the domain pack may rename (CLAUDE.md §14). Same resolution
 * rule as approvals.tsx: a resource is the last segment of a spec's `api`.
 */
export function specFor(resource: string): { workspace: (typeof WORKSPACES)[number]; tabKey: string } | null {
  for (const workspace of WORKSPACES) {
    for (const tab of workspace.tabs) {
      if (tab.api.endsWith(`/${resource}`)) return { workspace, tabKey: tab.key };
    }
  }
  return null;
}

/** The palette's own floor: one letter matches half the tenant. */
const MIN_QUERY = 2;

/** The one line under the title: the refusal, the prompt, or the count actually found. */
export function resultsLede(
  q: string,
  groups: readonly SearchGroup[],
  denied: boolean,
  l: (key: string, vars?: Record<string, string>) => string
): string {
  if (denied) return l("denied");
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (q.length < MIN_QUERY || total === 0) return l("intro");
  return l("count", { count: String(total), areas: String(groups.length) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY) return { q, groups: [] as SearchGroup[], denied: false };

  try {
    const found = await api<{ results: SearchHit[] }>(`/v1/search?q=${encodeURIComponent(q)}`, {
      env,
      request
    });
    return { q, groups: groupHits(found.results), denied: false };
  } catch (error) {
    // Without core:search:read there is nothing to render and nothing to fix by
    // retyping, so the page says so instead of looking like an empty tenant.
    if (error instanceof ApiError && error.status === 403) return { q, groups: [], denied: true };
    throw error;
  }
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Search results",
    intro: "Records you are allowed to read, grouped by where they live.",
    count: "{count} found across {areas} areas",
    denied: "Searching across the tenant is not something your permissions allow.",
    group: "{area} · {count}"
  },
  ar: {
    title: "نتائج البحث",
    intro: "السجلات المسموح لك بقراءتها، مجمّعة حسب موضعها.",
    count: "{count} نتيجة في {areas} مجالات",
    denied: "البحث في كل بيانات المؤسسة غير مسموح بصلاحياتك.",
    group: "{area} · {count}"
  }
};

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

export default function SearchResults() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale);
  const total = loaded.groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{resultsLede(loaded.q, loaded.groups, loaded.denied, l)}</p>
      </header>

      {/* A GET form: the query belongs in the URL, so a result set can be sent
          to a colleague and the back button means what it says. */}
      <Form method="get" className="flex flex-wrap items-end gap-3">
        <Input
          name="q"
          type="search"
          defaultValue={loaded.q}
          minLength={MIN_QUERY}
          maxLength={120}
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className="max-w-md flex-1"
        />
        <Button type="submit" variant="primary" loading={navigation.state !== "idle"}>
          {t("common.search")}
        </Button>
      </Form>

      {loaded.denied ? (
        <p className="font-ui text-13 text-subtle">{l("denied")}</p>
      ) : loaded.q.length < MIN_QUERY ? (
        <p className="font-ui text-13 text-subtle">{t("search.prompt")}</p>
      ) : total === 0 ? (
        <EmptyState title={t("common.empty.title")} body={t("search.none")} />
      ) : (
        loaded.groups.map((group) => (
          <Group key={`${group.module}:${group.resource}`} group={group} locale={locale} l={l} t={t} />
        ))
      )}
    </div>
  );
}

function Group({
  group,
  locale,
  l,
  t
}: {
  group: SearchGroup;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const shell = useShellData();
  const owner = specFor(group.resource);
  // The workspace's own noun for the resource, renamed by the domain pack when
  // the tenant has one. An engine-only resource with no tab keeps its API path
  // segment, which is at least the truth.
  const area = owner
    ? labelsFor(owner.workspace, locale, shell?.domainPack)(owner.tabKey)
    : group.resource;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="eyebrow">
        {l("group", { area, count: String(group.items.length) })}
      </h2>
      <Card elevation="flat" padded={false}>
        <ul className="divide-y divide-border">
          {group.items.map((item) => (
            <li key={item.id}>
              <Link
                to={item.href}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block font-ui text-13 break-words text-text">{item.label}</span>
                  <Ref value={item.id} className="block text-12 text-subtle" />
                </span>
                <span className="font-ui text-12 text-accent">{t("common.open")}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
