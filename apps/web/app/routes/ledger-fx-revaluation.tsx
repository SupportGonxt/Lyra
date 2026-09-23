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
import { Button, Card, EmptyState, Field, Input, KPIWall, Money, Stat, Table } from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { ConfirmButton } from "../components/confirm";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { Gate } from "./module";
import { PERM, fxHeadline, labelIn } from "./ledger.shared";
import { useShellData } from "./workspace";

// docs/19 §5.3, docs/27 F18. The plan is read on both routes, so what a
// controller signs off is what posts; nothing here is typed except the day.

interface Adjustment {
  accountCode: string;
  currency: string;
  balanceMinor: number;
  carriedBaseMinor: number;
  revaluedBaseMinor: number;
  deltaMinor: number;
  ratePpm: number;
}

interface Plan {
  asOf: number;
  baseCurrency: string;
  adjustments: Adjustment[];
  netMinor: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The end of a calendar day, UTC — the instant the API's `asOf` takes. */
function endOf(day: string | null): number | null {
  if (!day || !DAY.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(start) ? start + 86_400_000 - 1 : null;
}

const query = (at: number | null) => (at === null ? "" : `?asOf=${at}`);

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  if (!held.has(PERM.journalsRead)) return { denied: true as const, permission: PERM.journalsRead };

  const day = new URL(request.url).searchParams.get("asOf");
  const plan = await api<Plan>(`/v1/ledger/fx-revaluation${query(endOf(day))}`, { env, request });
  return { denied: false as const, day: day ?? "", plan, canPost: held.has(PERM.journalsPost) };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<{ problem: Problem | null; posted: string | null }> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  try {
    const result = await api<{ txn: { id: string } }>(
      `/v1/ledger/fx-revaluation${query(endOf(String(form.get("asOf") ?? "")))}`,
      { env, request, method: "POST", body: {} }
    );
    return { problem: null, posted: result.txn.id };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, posted: null };
    throw error;
  }
}

export default function LedgerFxRevaluation() {
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

  const { plan } = loaded;
  const base = plan.baseCurrency;
  const money = (minor: number, currency = base) => <Money amountMinor={minor} currency={currency} locale={locale} />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="eyebrow">{l("fx.title")}</p>
        <h1 className="page-title">{fxHeadline(plan, l, locale)}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("fx.intro")}</p>
      </header>

      <Form method="get" className="flex flex-wrap items-end gap-3">
        <Field label={l("fx.asOf")} className="w-48">
          <Input name="asOf" type="date" defaultValue={loaded.day} />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
        {searchParams.get("asOf") ? (
          <Button asChild variant="ghost">
            <Link to="/ledger/fx-revaluation">{t("common.clear")}</Link>
          </Button>
        ) : null}
      </Form>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.posted ? l("fx.posted", { txn: result.posted }) : ""}
      </p>
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <KPIWall>
        <Stat label={l("fx.net")} value={money(plan.netMinor)} />
      </KPIWall>

      <Card title={l("fx.preview")} elevation="flat">
        <div className="flex flex-col gap-4">
          <Table<Adjustment>
            caption={l("fx.previewCaption")}
            captionHidden
            density="compact"
            rows={plan.adjustments}
            rowKey={(row) => `${row.accountCode}:${row.currency}`}
            empty={<EmptyState title={l("fx.nothing")} body={l("fx.nothingBody")} />}
            columns={[
              { key: "account", header: l("fx.account"), render: (row) => <bdi className="font-mono">{row.accountCode}</bdi> },
              { key: "currency", header: l("fx.currency"), render: (row) => <bdi className="font-mono">{row.currency}</bdi> },
              { key: "balance", header: l("fx.balance"), numeric: true, render: (row) => money(row.balanceMinor, row.currency) },
              { key: "carried", header: l("fx.carried"), numeric: true, render: (row) => money(row.carriedBaseMinor) },
              { key: "revalued", header: l("fx.revalued"), numeric: true, render: (row) => money(row.revaluedBaseMinor) },
              { key: "delta", header: l("fx.delta"), numeric: true, render: (row) => money(row.deltaMinor) },
              {
                key: "rate",
                header: l("fx.rate"),
                numeric: true,
                render: (row) => (
                  <span className="font-mono text-12">
                    {new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(row.ratePpm / 1_000_000)}
                  </span>
                )
              }
            ]}
          />
          {plan.adjustments.length > 0 && loaded.canPost ? (
            <Form method="post" className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="asOf" value={loaded.day} />
              <ConfirmButton message={l("fx.postConfirm")} loading={busy}>
                {l("fx.post")}
              </ConfirmButton>
            </Form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
