import * as React from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, Card, EmptyState, Field, Input, Money, MoneyField, Select } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { ConfirmButton } from "../components/confirm";
// F64: MANUAL-JRNL is dual-control always on, so the first submit is an
// approval request — Gate renders that as a calm "queued" notice instead of
// the raw policy key in a danger alert.
import { Gate } from "./module";
import { useShellData } from "./workspace";
import { FALLBACK_CURRENCY } from "../calendar";
import { PERM, labelIn } from "./ledger.shared";

// docs/27 F2. The one instrument that can express any entry, so the screen's
// whole job is to make the two things it cannot express visible before someone
// types them: client money and equity. The API refuses either; this says why.
//
// The entry is drafted here and posts elsewhere — dual control is always on for
// this policy, so a send is a request, never a posting.

const MIN_LINES = 2;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const allowed = held.has(PERM.journalsDraft) || held.has(PERM.txnsCreate);
  return allowed ? { denied: false as const } : { denied: true as const, permission: PERM.journalsDraft };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();

  // Sides and amounts arrive as parallel lists in document order, which is what
  // the grid renders — pairing them by index is pairing them by row.
  const accounts = form.getAll("accountCode").map(String);
  const sides = form.getAll("side").map(String);
  const amounts = form.getAll("amountMinor").map((v) => Number(v));
  const memos = form.getAll("memo").map(String);

  const lines = accounts
    .map((accountCode, i) => ({
      accountCode: accountCode.trim(),
      side: sides[i] ?? "debit",
      amountMinor: amounts[i] ?? 0,
      ...(memos[i]?.trim() ? { memo: memos[i]!.trim() } : {})
    }))
    .filter((line) => line.accountCode && line.amountMinor > 0);

  try {
    const result = await api<{ txn: { id: string; state: string } }>("/v1/ledger/txn/MANUAL-JRNL", {
      env,
      request,
      method: "POST",
      body: {
        // A fresh key per send: two different entries are two transactions, and
        // the browser has nothing else that tells them apart.
        idempotencyKey: `mj:${crypto.randomUUID()}`,
        args: { lines, reason: String(form.get("reason") ?? "") }
      }
    });
    return { problem: null, txn: result.txn };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, txn: null };
    throw error;
  }
}

interface Row {
  key: string;
  side: "debit" | "credit";
}

let seq = 0;
const newRow = (side: "debit" | "credit"): Row => ({ key: `row-${seq++}`, side });

export default function LedgerJournal() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const locale = shell?.locale ?? "en";
  const l = labelIn(locale, shell?.domainPack);
  const currency = shell?.currency ?? FALLBACK_CURRENCY;
  const busy = navigation.state !== "idle";

  const [rows, setRows] = React.useState<Row[]>(() => [newRow("debit"), newRow("credit")]);
  const [amounts, setAmounts] = React.useState<number[]>([]);

  /**
   * The amounts are read back off the form rather than mirrored as we type:
   * MoneyField already owns the parse from "1 200,50" into minor units, and a
   * second copy of that arithmetic here is a second answer.
   */
  function recount(form: HTMLFormElement) {
    setAmounts(new FormData(form).getAll("amountMinor").map((v) => Number(v) || 0));
  }

  const drop = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
    setAmounts((current) => current.filter((_, i) => i !== index));
  };

  if (loaded.denied) {
    return <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />;
  }

  const totals = rows.reduce(
    (acc, row, i) => {
      const amount = amounts[i] ?? 0;
      if (row.side === "credit") acc.credit += amount;
      else acc.debit += amount;
      return acc;
    },
    { debit: 0, credit: 0 }
  );
  const difference = totals.debit - totals.credit;
  const balanced = difference === 0 && totals.debit > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{l("mj.title")}</h1>
          <p className="font-ui text-13 text-muted">{l("mj.intro")}</p>
        </div>
      </header>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.txn
          ? result.txn.state === "settled"
            ? l("mj.settled", { id: result.txn.id })
            : l("mj.sent")
          : ""}
      </p>

      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <Form
        method="post"
        onChange={(event) => recount(event.currentTarget)}
        className="flex flex-col gap-6"
      >
        <Card title={l("mj.lines")} description={l("mj.forbidden")} elevation="flat">
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-3">
              {rows.map((row, index) => (
                <li
                  key={row.key}
                  className="grid grid-cols-1 gap-3 border-b border-border/40 pb-3 last:border-b-0 last:pb-0 md:grid-cols-[8rem_9rem_1fr_10rem_auto] md:items-end"
                >
                  <Field label={l("mj.account")} hint={index === 0 ? l("mj.accountHint") : undefined} required>
                    <Input name="accountCode" pattern="\d{4}" inputMode="numeric" required />
                  </Field>
                  <Field label={l("mj.side")}>
                    <Select
                      name="side"
                      value={row.side}
                      options={[
                        { value: "debit", label: l("mj.debit") },
                        { value: "credit", label: l("mj.credit") }
                      ]}
                      onValueChange={(next) =>
                        setRows((current) =>
                          current.map((r, i) =>
                            i === index ? { ...r, side: next === "credit" ? "credit" : "debit" } : r
                          )
                        )
                      }
                    />
                  </Field>
                  <Field label={l("mj.memo")}>
                    <Input name="memo" maxLength={200} />
                  </Field>
                  <Field label={l("mj.amount")} required>
                    <MoneyField name="amountMinor" currency={currency} locale={locale} required />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={rows.length <= MIN_LINES}
                    onClick={() => drop(index)}
                  >
                    {l("mj.removeLine")}
                  </Button>
                </li>
              ))}
            </ul>

            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRows((current) => [...current, newRow("debit")])}
              >
                {l("mj.addLine")}
              </Button>
            </div>

            <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 font-ui text-13">
              <div className="flex gap-2">
                <dt className="text-subtle">{l("mj.totalDebit")}</dt>
                <dd className="text-text">
                  <Money amountMinor={totals.debit} currency={currency} locale={locale} />
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-subtle">{l("mj.totalCredit")}</dt>
                <dd className="text-text">
                  <Money amountMinor={totals.credit} currency={currency} locale={locale} />
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-subtle">{l("mj.difference")}</dt>
                <dd className={balanced ? "text-success" : "text-warning"}>
                  <Money amountMinor={difference} currency={currency} locale={locale} signed />
                </dd>
              </div>
            </dl>

            <p role="status" aria-live="polite" className="font-ui text-13 text-subtle">
              {balanced ? l("mj.balanced") : l("mj.unbalanced")}
            </p>
          </div>
        </Card>

        <Card title={l("mj.reason")} description={l("mj.reasonHint")} elevation="flat">
          <Field label={l("mj.reason")} labelHidden required>
            <Input name="reason" minLength={10} maxLength={500} required />
          </Field>
        </Card>

        <div>
          {/* Balance is checked here only to keep the ask honest — the ledger
              refuses an unbalanced entry regardless of what a browser sends. */}
          <ConfirmButton message={l("mj.submitConfirm")} loading={busy} disabled={!balanced}>
            {l("mj.submit")}
          </ConfirmButton>
        </div>
      </Form>
    </div>
  );
}
