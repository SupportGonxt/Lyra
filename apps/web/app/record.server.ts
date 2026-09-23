import { ApiError, api, type ApiOptions, type Problem as ProblemShape } from "./api.server";
import type { RefOption } from "./components/ref-picker";
import {
  REF_SOURCES,
  actionUrl,
  bodyFrom,
  formKind,
  type ActionSpec,
  type FieldSpec,
  type ResourceSpec,
  type Row
} from "./modules/spec";

/**
 * One declared action, posted. Lives outside `routes/record.tsx` because a route
 * module may only export the names React Router knows: anything else is bundled
 * for the browser, and this reaches `api.server`. The handler finds its spec
 * through the module registry and so cannot be exercised through `action()`;
 * this is the part worth a test.
 */
export async function runAction(
  tab: ResourceSpec,
  spec: ActionSpec,
  id: string,
  form: FormData,
  options: ApiOptions
): Promise<{ problem: ProblemShape | null; done: string | null }> {
  try {
    await api(actionUrl(tab, spec, id), {
      ...options,
      method: spec.method,
      body: bodyFrom(spec.fields ?? [], form)
    });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
  return { problem: null, done: spec.intent };
}

/**
 * The choices behind every id-shaped field a form will render (REF_SOURCES),
 * one list call per distinct source, all at once. Best effort by design: an
 * actor whose role cannot read a list gets no options and the picker still
 * takes a pasted id — exactly what the text box did before.
 */
export async function refOptions(
  fields: readonly FieldSpec[],
  locale: string,
  options: ApiOptions
): Promise<Record<string, RefOption[]>> {
  const wanted = [...new Set(fields.filter((field) => formKind(field) === "ref").map((field) => field.name))];
  const bySource = new Map<string, Promise<Row[]>>();
  for (const name of wanted) {
    const api_ = REF_SOURCES[name]!.api;
    if (!bySource.has(api_)) {
      bySource.set(
        api_,
        api<{ data?: Row[] }>(`${api_}?limit=200`, options)
          .then((page) => page.data ?? [])
          .catch(() => [])
      );
    }
  }
  const out: Record<string, RefOption[]> = {};
  for (const name of wanted) {
    const source = REF_SOURCES[name]!;
    const rows = await bySource.get(source.api)!;
    out[name] = rows
      .map((row) => ({ id: `${source.prefix ?? ""}${String(row.id ?? "")}`, label: labelIn(row[source.label], locale) }))
      .filter((option) => option.label && option.id !== (source.prefix ?? ""));
  }
  return out;
}

/** A column's value as the words a person reads: a string, or one language of `{ en, ar }`. */
function labelIn(value: unknown, locale: string): string {
  if (typeof value === "string") {
    if (!value.startsWith("{")) return value;
    try {
      return labelIn(JSON.parse(value) as unknown, locale);
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object") {
    const byLocale = value as Record<string, unknown>;
    const text = byLocale[locale] ?? byLocale.en ?? Object.values(byLocale)[0];
    return typeof text === "string" ? text : "";
  }
  return "";
}
