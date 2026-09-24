import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MoneyField,
  Select,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { WorkLayout } from "../components/work-layout";
import { labelsFrom } from "./detail-kit";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { PERM, argsFromForm, labelIn, mintKey, openHeadline, type ArgField } from "./ledger.shared";

// Opening a transaction is the only way money starts moving, so it is a form
// with a catalogue rather than a row in a table: the type decides the recipe,
// the recipe decides the journal, and the ledger validates both.
//
// The recipe's schema stays private to @lyra/ledger, but `GET /txn-types` now
// publishes each recipe's arguments as a flat field list, so the form asks for
// money in a money field instead of asking a controller to type JSON
// (docs/ui.md §7 P3-16). The API's field-error map still renders back beside it:
// the ledger owns the validation and names the field it refused.

/** How many catalogue rows show before the reader asks for the rest. */
export const CATALOGUE_PAGE = 25;

// The catalogue's own words: the filter and the "show all" toggle. Everything
// else on this screen speaks through the ledger's shared table.
const LABELS: Record<string, Record<string, string>> = {
  en: {
    "catalogue.filter": "Filter by code or detail",
    "catalogue.showAll": "Show all {count}",
    "catalogue.showFewer": "Show the first {count}",
    "catalogue.shown": "{shown} of {count} types",
    "catalogue.noMatch": "No type matches this filter",
    "catalogue.noMatchBody": "Clear the filter to see the whole catalogue."
  },
  ar: {
    "catalogue.filter": "تصفية حسب الرمز أو التفاصيل",
    "catalogue.showAll": "عرض الكل ({count})",
    "catalogue.showFewer": "عرض أول {count}",
    "catalogue.shown": "{shown} من {count} نوعًا",
    "catalogue.noMatch": "لا يطابق أي نوع هذه التصفية",
    "catalogue.noMatchBody": "امسح التصفية لرؤية الكتالوج كاملًا."
  }
};

const catalogueLabels = labelsFrom(LABELS);

interface TxnType {
  code: string;
  financial: boolean;
  approval: string | null;
  payout?: true;
  clientMoney?: true;
  args?: ArgField[];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);

  // Reading the catalogue is gated on ledger:txns:read; opening one on
  // ledger:txns:create. Without create there is nothing to do here.
  if (!held.has(PERM.txnsCreate)) {
    return { denied: true as const, permission: PERM.txnsCreate };
  }

  const types = await api<{ data: TxnType[] }>("/v1/ledger/txn-types", { env, request });
  const currency = typeof me.policy.currency === "string" ? me.policy.currency : "";

  return {
    denied: false as const,
    types: types.data,
    currency,
    /**
     * Two keys, both minted server side, once per render of this form.
     *
     * `headerKey` is the HTTP `idempotency-key` the API replays on
     * (packages/core withIdempotency); `naturalKey` is the transaction's own
     * key on the unique index (tenant, type, idempotencyKey), which the
     * operator may replace with something meaningful — `bind:{caseId}`.
     * Either one alone stops a double press posting twice.
     */
    headerKey: mintKey("web.open"),
    naturalKey: mintKey("web")
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const type = String(form.get("type") ?? "");
  const gross = String(form.get("grossMinor") ?? "").trim();
  const currency = String(form.get("currency") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();

  // The field list the form was rendered from comes back with it, so the action
  // reads exactly the arguments this type declared and nothing else.
  const fields = JSON.parse(String(form.get("argFields") ?? "[]")) as ArgField[];
  const args = argsFromForm(fields, form);

  try {
    const result = await api<{ txn: { id: string; state: string } }>(
      `/v1/ledger/txn/${encodeURIComponent(type)}`,
      {
        env,
        request,
        method: "POST",
        // The one endpoint in this module that replays on the HTTP header.
        headers: { "idempotency-key": String(form.get("headerKey") ?? "") },
        body: {
          idempotencyKey: String(form.get("naturalKey") ?? ""),
          ...(currency ? { currency } : {}),
          ...(gross ? { grossMinor: Number(gross) } : {}),
          ...(reason ? { reason } : {}),
          args
        }
      }
    );
    return { problem: null, opened: result.txn, approval: null };
  } catch (error) {
    if (error instanceof ApiError) {
      const p = error.problem as { code?: string; policy_key?: string };
      if (p.code === "approval_required") {
        return { problem: null, opened: null, approval: p.policy_key ?? "" };
      }
      return { problem: error.problem, opened: null, approval: null };
    }
    throw error;
  }
}

export default function LedgerOpenTxn() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  // The money field's precision follows the currency beside it: 500 in JPY is
  // 500 minor units, in ZAR it is 50000.
  const [currency, setCurrency] = useState(loaded.currency);
  // The type decides the recipe, and the recipe decides which fields this form
  // asks for — so the picker drives the rest of the form, not just the URL.
  const [code, setCode] = useState(loaded.denied ? "" : (loaded.types[0]?.code ?? ""));
  // The catalogue runs to a hundred-odd types: a filter and a first page keep
  // it readable, and the whole list is one click away.
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const c = catalogueLabels(locale, shell?.domainPack);

  if (loaded.denied) {
    return (
      <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />
    );
  }

  const columns: Array<Column<TxnType>> = [
    {
      key: "code",
      header: l("open.code"),
      render: (row) => <span className="font-mono text-12">{row.code}</span>
    },
    {
      key: "kind",
      header: t("common.details"),
      render: (row) => (
        <span className="flex flex-wrap gap-2">
          <Badge size="sm" tone={row.financial ? "accent" : "neutral"}>
            {row.financial ? l("open.financial") : l("open.nonFinancial")}
          </Badge>
          {row.approval ? (
            <Badge size="sm" tone="warning">
              {l("open.approval")}
            </Badge>
          ) : null}
          {row.payout ? (
            <Badge size="sm" tone="warning">
              {l("open.payout")}
            </Badge>
          ) : null}
          {row.clientMoney ? (
            <Badge size="sm" tone="info">
              {l("open.clientMoney")}
            </Badge>
          ) : null}
        </span>
      )
    },
    {
      key: "policy",
      header: l("txn.approvals"),
      render: (row) =>
        row.approval ? <span className="font-mono text-12">{row.approval}</span> : l("none")
    }
  ];

  // What this type needs, straight from its recipe. An older API that does not
  // publish the list yet simply renders no argument inputs rather than breaking.
  const argFields = loaded.types.find((type) => type.code === code)?.args ?? [];

  // Matched against what the row says, not only its code: "money out" finds
  // every payout type.
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? loaded.types.filter((row) =>
        [
          row.code,
          row.approval ?? "",
          row.financial ? l("open.financial") : l("open.nonFinancial"),
          row.approval ? l("open.approval") : "",
          row.payout ? l("open.payout") : "",
          row.clientMoney ? l("open.clientMoney") : ""
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : loaded.types;
  const shown = showAll ? matching : matching.slice(0, CATALOGUE_PAGE);

  // The API names the argument fields it wanted when the recipe refuses.
  const fieldErrors = Object.entries(result?.problem?.errors ?? {});

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{openHeadline(loaded.types, l)}</h1>
          <p className="font-ui text-13 text-muted">{l("open.intro")}</p>
        </div>
      </header>

      {result?.approval !== null && result?.approval !== undefined ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-5"
        >
          <p className="section-title">{l("txn.approvalRaised")}</p>
          <p className="max-w-prose font-ui text-13 text-muted">{l("txn.approvalRaisedBody")}</p>
          <div>
            <Button asChild variant="secondary">
              <Link to="/approvals">{l("txn.approvalsInbox")}</Link>
            </Button>
          </div>
        </div>
      ) : (
        <p role="status" aria-live="polite" className="font-ui text-13 text-success">
          {result?.opened ? l("open.openedAs", { id: result.opened.id }) : ""}
        </p>
      )}

      {result?.opened ? (
        <div>
          <Button asChild variant="secondary">
            <Link to={`/ledger/transactions/${encodeURIComponent(result.opened.id)}`}>
              {l("open.openRecord")}
            </Link>
          </Button>
        </div>
      ) : null}

      {result?.problem ? <Problem problem={result.problem} /> : null}

      <WorkLayout
        aside={
          <>
            {fieldErrors.length > 0 ? (
              <ul role="alert" className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/10 p-3">
                {fieldErrors.map(([path, message]) => (
                  <li key={path} className="font-ui text-13 text-text">
                    <span className="font-mono text-12 text-muted">{path}</span> — {message}
                  </li>
                ))}
              </ul>
            ) : null}

            <Card title={l("open.title")} elevation="flat">
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="headerKey" value={loaded.headerKey} />
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={l("open.type")} required className="w-64">
                    <Select
                      name="type"
                      value={code}
                      onValueChange={setCode}
                      options={loaded.types.map((type) => ({ value: type.code, label: type.code }))}
                    />
                  </Field>
                  <Field label={l("currency")} className="w-28">
                    <Input
                      name="currency"
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                      maxLength={3}
                    />
                  </Field>
                  <Field label={l("open.gross")} className="w-44">
                    <MoneyField name="grossMinor" currency={currency || "ZAR"} locale={locale} />
                  </Field>
                </div>

                <Field label={l("open.key")} hint={l("open.keyHint")} required>
                  <Input name="naturalKey" defaultValue={loaded.naturalKey} maxLength={200} required />
                </Field>

                <fieldset className="flex flex-col gap-3 border-0 p-0">
                  <legend className="eyebrow">
                    {l("open.args")}
                  </legend>
                  <p className="max-w-prose font-ui text-12 text-subtle">{l("open.argsHint")}</p>
                  {/* Posted back so the action reads exactly the fields it rendered. */}
                  <input type="hidden" name="argFields" value={JSON.stringify(argFields)} />
                  {argFields.length ? (
                    <div className="flex flex-wrap gap-3">
                      {argFields.map((field) => (
                        <ArgInput
                          key={`${code}.${field.name}`}
                          field={field}
                          label={l(`arg.${field.name}`)}
                          accountHint={l("open.argAccountHint")}
                          currency={currency || "ZAR"}
                          locale={locale}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="font-ui text-13 text-muted">{l("open.argsNone")}</p>
                  )}
                </fieldset>

                <Field label={l("reason")}>
                  <Input name="reason" maxLength={500} />
                </Field>

                <p className="font-ui text-12 text-subtle">{l("idempotencyNote")}</p>
                <div>
                  <ConfirmButton type="submit" loading={busy} message={l("open.confirm")}>
                    {l("open.submit")}
                  </ConfirmButton>
                </div>
              </Form>
            </Card>
          </>
        }
      >
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="eyebrow">{l("open.catalogue")}</h2>
            <Field label={c("catalogue.filter")} labelHidden className="w-72">
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={c("catalogue.filter")}
              />
            </Field>
          </div>
          <Table<TxnType>
            caption={l("open.catalogueCaption")}
            captionHidden
            density="compact"
            columns={columns}
            rows={shown}
            rowKey={(row) => row.code}
            empty={
              needle ? (
                <EmptyState title={c("catalogue.noMatch")} body={c("catalogue.noMatchBody")} />
              ) : (
                <EmptyState title={l("open.catalogueEmpty")} body={l("open.catalogueEmptyBody")} />
              )
            }
          />
          {matching.length > CATALOGUE_PAGE ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-ui text-12 text-subtle">
                {c("catalogue.shown", { shown: String(shown.length), count: String(matching.length) })}
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((all) => !all)}>
                {showAll
                  ? c("catalogue.showFewer", { count: String(CATALOGUE_PAGE) })
                  : c("catalogue.showAll", { count: String(matching.length) })}
              </Button>
            </div>
          ) : null}
        </section>
      </WorkLayout>
    </div>
  );
}

/**
 * One recipe argument. Minor-unit amounts get the money field so the operator
 * types 1 500,00 and the form posts 150000; rates and account codes are what
 * they say they are. A field left blank is not sent, so the recipe's own default
 * — shown as the placeholder — is what posts.
 */
function ArgInput({
  field,
  label,
  accountHint,
  currency,
  locale
}: {
  field: ArgField;
  label: string;
  accountHint: string;
  currency: string;
  locale: string;
}) {
  const name = `arg.${field.name}`;
  const money = field.kind === "integer" && field.name.endsWith("Minor");
  const account = field.kind === "text" && field.name.endsWith("Account");

  return (
    <Field
      label={label}
      required={field.required}
      className={money ? "w-52" : "w-44"}
      {...(account ? { hint: accountHint } : {})}
    >
      {money ? (
        <MoneyField name={name} currency={currency} locale={locale} required={field.required} />
      ) : field.options?.length ? (
        // A closed set the recipe declared: offering it as free text is how a
        // required enum becomes a 400 the operator cannot read.
        <Select
          name={name}
          defaultValue={typeof field.default === "string" ? field.default : (field.options[0] ?? "")}
          options={field.options.map((value) => ({ value, label: value }))}
        />
      ) : (
        <Input
          name={name}
          {...(field.kind === "integer" ? { type: "number", step: 1, inputMode: "numeric" } : {})}
          required={field.required}
          {...(field.default !== undefined ? { placeholder: String(field.default) } : {})}
        />
      )}
    </Field>
  );
}
