import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, Card, EmptyState, Field, Input, Money, Stat, Table, KPIWall } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { ConfirmButton } from "../components/confirm";
// F64: YEAR-END-CLOSE is dual-control always on, so the first submit is an
// approval request — Gate renders that as a calm "queued" notice instead of
// the raw policy key in a danger alert.
import { Gate } from "./module";
import { useShellData } from "./workspace";
import { PERM, labelIn, yearEndHeadline } from "./ledger.shared";

// docs/27 F3. The closing lines are read out of the journal on both the preview
// and the post, so what a controller signs off is what posts. Nothing on this
// screen is typed except the year.

interface ClosingLine {
  accountCode: string;
  name: string;
  side: "debit" | "credit";
  amountMinor: number;
}

interface Preview {
  fiscalYear: number;
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  retainedEarningsAccount: string;
  closingLines: ClosingLine[];
}

const YEAR = /^\d{4}$/;

function thisYear(): string {
  return String(new Date().getUTCFullYear());
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);

  if (!held.has(PERM.journalsRead)) {
    return { denied: true as const, permission: PERM.journalsRead };
  }

  const asked = new URL(request.url).searchParams.get("year") ?? "";
  const year = YEAR.test(asked) ? asked : thisYear();

  return {
    denied: false as const,
    year,
    preview: await api<Preview>(`/v1/ledger/year-end/${year}`, { env, request }),
    canPost: held.has(PERM.periodsYearEnd)
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const year = String(form.get("year") ?? "");

  try {
    const result = await api<{ preview: Preview }>(`/v1/ledger/year-end/${encodeURIComponent(year)}`, {
      env,
      request,
      method: "POST",
      body: {}
    });
    return { problem: null, posted: { year, account: result.preview.retainedEarningsAccount } };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, posted: null };
    throw error;
  }
}

export default function LedgerYearEnd() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (loaded.denied) {
    return <EmptyState title={l("denied")} body={l("deniedBody", { permission: loaded.permission })} />;
  }

  const { preview } = loaded;
  const currency = preview.currency;
  const lines = preview.closingLines;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {yearEndHeadline(loaded.year, preview, l, locale)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("ye.intro")}</p>
        </div>
      </header>

      <Form method="get" aria-label={l("ye.year")} className="flex flex-wrap items-end gap-3">
        <Field label={l("ye.year")} hint="2026" className="w-40">
          <Input name="year" defaultValue={loaded.year} pattern="\d{4}" inputMode="numeric" />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
        {searchParams.get("year") ? (
          <Button asChild variant="ghost">
            <Link to="/ledger/year-end">{t("common.clear")}</Link>
          </Button>
        ) : null}
      </Form>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.posted
          ? l("ye.posted", { year: result.posted.year, account: result.posted.account })
          : ""}
      </p>

      {result?.problem ? (
        <div className="flex flex-col gap-2">
          <Gate problem={result.problem} l={l} />
          {/* The refusal names the months; this says what to do about them. */}
          {String(result.problem.detail ?? "").includes("open periods") ? (
            <p className="max-w-prose font-ui text-13 text-subtle">
              <strong className="text-text">{l("ye.prereq")}</strong> {l("ye.prereqBody")}
            </p>
          ) : null}
        </div>
      ) : null}

      <KPIWall>
        <Stat
          label={l("ye.income")}
          value={<Money amountMinor={preview.incomeMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("ye.expense")}
          value={<Money amountMinor={preview.expenseMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("ye.net")}
          value={<Money amountMinor={preview.netMinor} currency={currency} locale={locale} />}
          hint={l("ye.retained", { account: preview.retainedEarningsAccount })}
        />
      </KPIWall>

      <Card title={l("ye.preview")} elevation="flat">
        <div className="flex flex-col gap-4">
          <Table<ClosingLine>
            caption={l("ye.previewCaption")}
            captionHidden
            density="compact"
            rows={lines}
            rowKey={(row) => `${row.accountCode}:${row.side}`}
            empty={<EmptyState title={l("ye.nothing")} body={l("ye.nothingBody")} />}
            columns={[
              { key: "account", header: l("ye.account"), render: (row) => `${row.accountCode} · ${row.name}` },
              { key: "side", header: l("ye.side"), render: (row) => l(`ye.side.${row.side}`) },
              {
                key: "amount",
                header: l("ye.amount"),
                numeric: true,
                render: (row) => (
                  <Money amountMinor={row.amountMinor} currency={currency} locale={locale} />
                )
              }
            ]}
          />

          {lines.length > 0 && loaded.canPost ? (
            <Form method="post" className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="year" value={loaded.year} />
              {/* Dual control: the API answers 403 with an approval id, and the
                  second seat decides it from their approvals queue. */}
              <ConfirmButton message={l("ye.postConfirm")} loading={busy}>
                {l("ye.post")}
              </ConfirmButton>
              <Button asChild variant="ghost">
                <Link to="/ledger/period-close">{l("ye.toPeriods")}</Link>
              </Button>
            </Form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
