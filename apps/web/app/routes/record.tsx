import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, DateTime, isOpaqueRef, shortRef } from "@lyra/ui";
import { ApiError, api, asRouteError, names } from "../api.server";
// rejectedBy runs in the component, not the loader: importing it from the
// .server module pulls that module into the client bundle (api-error.ts exists
// for exactly this, see its header).
import { rejectedBy } from "../api-error";
import { Cell, FieldInput } from "../components/fields";
import { usePending } from "../components/pending";
import { cloudflare } from "../context";
import { localeFrom, translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { workspaceFor } from "../modules";
import {
  bodyFrom,
  labelsFor,
  optionWords,
  tabOf,
  visibleActions,
  type ActionSpec,
  type ResourceSpec,
  type Row,
  type WorkspaceSpec
} from "../modules/spec";
import { refOptions, runAction } from "../record.server";
import { Gate } from "./module";
import { useShellData } from "./workspace";

// One record, read and edited in the same place. The form is the record: no
// separate edit mode, because a screen that shows values and a screen that
// changes them drift apart the moment a column is added to the spec.

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

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const { spec, tab } = resolve(params);
  const env = context.get(cloudflare).env;
  const choices = refOptions(tab.editable ?? tab.fields ?? [], localeFrom(request), { env, request });
  const row = await api<Row>(`${tab.api}/${params.id}`, { env, request }).catch(asRouteError);
  // Same reason as the list (module.tsx): a record's fields hold refs and no
  // names for them.
  const resolved = await names(
    Object.values(row).filter((value): value is string => typeof value === "string" && isOpaqueRef(value)),
    { env, request }
  );
  return { modulePath: spec.path, resource: tab.key, row, resolved, refOptions: await choices };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { spec, tab } = resolve(params);
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(params.id ?? "");

  // A declared action is its own endpoint, not a PATCH wearing a different hat:
  // the API does work either side of the column it sets, so the generic update
  // path must never claim one. Permission is re-checked there, not here.
  const declared = (tab.actions ?? []).find((entry) => entry.intent === intent);
  if (declared) return runAction(tab, declared, id, form, { env, request });

  try {
    if (intent === "delete") {
      await api(`${tab.api}/${id}`, { env, request, method: "DELETE" });
      return redirect(`${spec.path}/${tab.key}`);
    }
    const fields = tab.editable ?? tab.fields ?? [];
    await api(`${tab.api}/${id}`, {
      env,
      request,
      method: "PATCH",
      body: bodyFrom(fields, form)
    });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }
  return { problem: null, done: "update" };
}

export default function Record() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const problem = result?.problem ?? null;
  const done = result?.done ?? null;
  const shell = useShellData();
  const pending = usePending();

  const locale = shell?.locale ?? "en";
  const held = new Set(shell?.permissions ?? []);
  const t = translator(locale);
  const spec = workspaceFor(loaded.modulePath);
  if (!spec) return null;
  const tab = tabOf(spec, loaded.resource);
  if (!tab) return null;

  const label = labelsFor(spec, locale, shell?.domainPack);
  // Marks the inputs a rejected edit or create named (see module.tsx).
  const rejected = rejectedBy(problem, () => t("error.field"));
  const row = loaded.row;
  const editable = tab.editable ?? tab.fields ?? [];
  const canEdit = Boolean(tab.update && held.has(tab.update)) && editable.length > 0;
  const canDelete = Boolean(tab.remove && held.has(tab.remove));
  const actions = visibleActions(tab, shell?.permissions ?? []);
  const completed = actions.find((entry) => entry.intent === done) ?? null;
  const saved = done === "update";
  // The heading is whatever this resource calls itself first — a case reference,
  // a policy number — falling back to the identifier. It goes through the same
  // two steps a cell does: an enum reads as its words ("Premium remitted", not
  // `PREM-REMIT`), and a key that escaped into the interface is shortened
  // rather than printed at 26 characters across the top of the screen.
  const headingColumn = tab.columns[0]?.name ?? "id";
  const headingRaw = String(row[headingColumn] ?? row.id ?? "");
  // A ref the loader already resolved reads as its name — the heading of a
  // quote was `cu_01KE…9FMN` while the name sat in `resolved`.
  const heading = optionWords(label, headingColumn, headingRaw) ?? loaded.resolved[headingRaw] ?? shortRef(headingRaw);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          to={`${spec.path}/${tab.key}`}
          className="font-ui text-12 text-subtle underline-offset-2 hover:underline"
        >
          {t("common.back")}
        </Link>
        <h1 className="page-title">{heading}</h1>
        <p className="font-ui text-12 text-subtle">
          {label(tab.key)} · <span className="font-mono">{String(row.id ?? "")}</span>
        </p>
        {tab.recordLink ? (
          <div>
            <Button asChild variant="secondary" size="sm">
              <Link to={tab.recordLink.href.replace("{id}", String(row.id ?? ""))}>
                {label(tab.recordLink.labelKey)}
              </Link>
            </Button>
          </div>
        ) : null}
      </header>

      {/* A gated action is a queued one, not a failure: <Gate> says so and
          points at the queue. The keys live under common.* here because this
          screen serves every module (detail-kit.tsx has its own copies). */}
      {problem ? <Gate problem={problem} l={(key, vars) => t(`common.${key}`, vars)} /> : null}

      {/* What the action actually did, said once, where the button was. */}
      {completed ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 font-ui text-13 text-text"
        >
          {orElse(label, `${completed.labelKey}.done`, t("common.saved"))}
        </p>
      ) : saved ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 font-ui text-13 text-text"
        >
          {t("common.saved")}
        </p>
      ) : null}

      {/* Field name in plain sentence case above its value: an uppercase tracked
          micro-label is decoration that costs legibility, and these labels are
          read far more often than the heading. */}
      <dl className="grid gap-x-8 gap-y-4 rounded-lg border border-border bg-surface-1 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {tab.columns.map((column) => (
            <div key={column.name} className="flex min-w-0 flex-col gap-1">
              <dt className="font-ui text-12 text-subtle">{label(column.name)}</dt>
              <dd className="font-ui text-13 text-text">
                <Cell column={column} row={row} locale={locale} label={label} resolved={loaded.resolved} />
              </dd>
            </div>
          ))}
          {["createdAt", "updatedAt"].map((key) =>
            row[key] ? (
              <div key={key} className="flex min-w-0 flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{t(`common.${key}`)}</dt>
                <dd className="font-ui text-13 text-text">
                  <DateTime value={Number(row[key])} locale={locale} precision="minute" />
                </dd>
              </div>
            ) : null
          )}
      </dl>

      {/* State the API owns, not columns this screen may set. Withheld actions
          are absent rather than disabled — the same rule the tabs follow. */}
      {actions.length ? (
        <section
          aria-labelledby="record-actions"
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-4"
        >
          <h2 id="record-actions" className="eyebrow">
            {t("common.actions")}
          </h2>
          <div className="flex flex-wrap items-end gap-4">
            {actions.map((entry) => (
              <ActionForm key={entry.intent} action={entry} label={label} busy={pending(entry.intent)} rejected={rejected} />
            ))}
          </div>
        </section>
      ) : null}

      {canEdit ? (
        <Form method="post" className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="eyebrow">{t("common.edit")}</h2>
          <input type="hidden" name="intent" value="update" />
          <div className="grid gap-4 sm:grid-cols-2">
            {editable.map((field) => (
              <FieldInput
                key={field.name}
                field={field}
                row={row}
                label={label}
                invalid={rejected}
                options={loaded.refOptions}
              />
            ))}
          </div>
          <div>
            <Button type="submit" loading={pending("update")}>
              {t("common.save")}
            </Button>
          </div>
        </Form>
      ) : null}

      {canDelete ? (
        <Form className="border-t border-border pt-4" method="post">
          <input type="hidden" name="intent" value="delete" />
          {/* Soft delete, but it still leaves the actor's view — ask once. */}
          <ConfirmButton
            type="submit"
            variant="danger"
            size="sm"
            message={t("common.deleteConfirm")}
          >
            {t("common.delete")}
          </ConfirmButton>
        </Form>
      ) : null}
    </div>
  );
}

/**
 * One declared action. Its own form, so the fields it collects submit with it
 * and nothing else on the screen goes along for the ride.
 */
function ActionForm({
  action: spec,
  label,
  busy,
  rejected
}: {
  action: ActionSpec;
  label: (key: string) => string;
  busy: boolean;
  /** Which inputs the last rejected run of this action named. */
  rejected: (name: string) => string | undefined;
}) {
  // Action fields are fresh input the endpoint asks for — a reason, a note —
  // not the record's own columns, so nothing is pre-filled from the row.
  const fields = spec.fields ?? [];
  return (
    <Form
      method="post"
      // An action that collects input takes its own line; a bare button does not
      // need one. `basis-full` rather than a second container to nest it in.
      className={`flex min-w-0 flex-col gap-3${fields.length ? " basis-full" : ""}`}
    >
      <input type="hidden" name="intent" value={spec.intent} />
      {fields.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((field) => (
            <FieldInput key={field.name} field={field} label={label} invalid={rejected} />
          ))}
        </div>
      ) : null}
      <div>
        {spec.confirm ? (
          // Consequential (CLAUDE.md §4): the same single ask delete uses.
          <ConfirmButton
            type="submit"
            variant="secondary"
            loading={busy}
            message={orElse(label, `${spec.labelKey}.confirm`, label(spec.labelKey))}
          >
            {label(spec.labelKey)}
          </ConfirmButton>
        ) : (
          <Button type="submit" variant="secondary" loading={busy}>
            {label(spec.labelKey)}
          </Button>
        )}
      </div>
    </Form>
  );
}

/**
 * The workspace's own wording where it wrote one, the shared string otherwise.
 * A module that has not written `<labelKey>.done` must not show the raw key.
 */
function orElse(label: (key: string) => string, key: string, fallback: string): string {
  const found = label(key);
  return found === key ? fallback : found;
}
