import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Badge, Button, Card, DateTime, EmptyState, Field, Input, Money, Table } from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { labelsFrom } from "./detail-kit";
import { Gate } from "./module";
import { useShellData } from "./workspace";

// docs/30 Distribution 4: the referral qualify and settle routes existed with
// no screen (apps/api/src/routes/dist.ts). A referral is not a table — it is a
// pair of ledger transactions keyed by its reference — so the desk lists those
// and offers the two verbs; settling refuses a referral not yet qualified.

export const PERM = {
  qualify: "dist:commissions:adjust",
  settle: "dist:commissions:settle",
  read: "ledger:txns:read"
} as const;

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Referrals",
    intro: "Qualify a referral when the introduced business is confirmed, then settle the fee it earned. Each step posts to the ledger once, whatever is retried.",
    qualify: "Qualify",
    settle: "Settle",
    referralRef: "Referral reference",
    channelId: "Channel",
    currency: "Currency",
    grossMinor: "Fee",
    channelMinor: "Channel share",
    qualified: "Referral {ref} is qualified.",
    settled: "Referral {ref} is settled.",
    ledger: "Referral ledger",
    colRef: "Referral",
    colStep: "Step",
    colState: "State",
    "step.REFERRAL-QUAL": "Qualified",
    "step.REFERRAL-SETL": "Settled",
    none: "No referral has been qualified yet.",
    noneBody: "Qualifying one above writes its first ledger entry here.",
    denied: "You cannot work referrals",
    deniedBody: "The desk needs {permission}.",
    errRef: "Name the referral.",
    errAmount: "The fee must be a whole number of minor units above zero."
  },
  ar: {
    title: "الإحالات",
    intro: "اعتمد الإحالة عند تأكيد العمل المُحال، ثم سوِّ الرسوم المستحقة عنها. كل خطوة تُقيَّد في الدفتر مرة واحدة مهما أُعيدت المحاولة.",
    qualify: "اعتماد",
    settle: "تسوية",
    referralRef: "مرجع الإحالة",
    channelId: "القناة",
    currency: "العملة",
    grossMinor: "الرسوم",
    channelMinor: "حصة القناة",
    qualified: "تم اعتماد الإحالة {ref}.",
    settled: "تمت تسوية الإحالة {ref}.",
    ledger: "دفتر الإحالات",
    colRef: "الإحالة",
    colStep: "الخطوة",
    colState: "الحالة",
    "step.REFERRAL-QUAL": "معتمدة",
    "step.REFERRAL-SETL": "مسوّاة",
    none: "لم تُعتمد أي إحالة بعد.",
    noneBody: "اعتماد إحالة أعلاه يكتب أول قيد لها هنا.",
    denied: "لا يمكنك العمل على الإحالات",
    deniedBody: "يحتاج المكتب إلى {permission}.",
    errRef: "اذكر الإحالة.",
    errAmount: "يجب أن تكون الرسوم عددًا صحيحًا من الوحدات الصغرى أكبر من صفر."
  }
};
export const labelsIn = labelsFrom(LABELS);

interface ReferralTxn {
  id: string;
  type: string;
  state: string;
  idempotencyKey: string;
  grossMinor: number;
  currency: string;
  createdAt: number;
}

/** The referral a ledger txn belongs to: its key is `dist.referral.<step>:<ref>` (engines/referral-settlement.ts). */
export function referralOf(txn: Pick<ReferralTxn, "idempotencyKey">): string {
  const at = txn.idempotencyKey.indexOf(":");
  return at < 0 ? txn.idempotencyKey : txn.idempotencyKey.slice(at + 1);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = { qualify: held.has(PERM.qualify), settle: held.has(PERM.settle), read: held.has(PERM.read) };
  if (!may.qualify && !may.settle) return { denied: true as const, may, rows: [] as ReferralTxn[], key: "" };
  const rows = may.read
    ? (
        await api<{ data: ReferralTxn[] }>("/v1/ledger/txns?type=REFERRAL-QUAL,REFERRAL-SETL&sort=createdAt&order=desc&limit=50", {
          env,
          request
        })
      ).data
    : [];
  return { denied: false as const, may, rows, key: crypto.randomUUID() };
}

type Result = { problem: Problem | null; error: string | null; done: { step: string; ref: string } | null };

export async function action({ request, context }: ActionFunctionArgs): Promise<Result> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ref = String(form.get("referralRef") ?? "").trim();
  const nothing: Result = { problem: null, error: null, done: null };
  if (!ref) return { ...nothing, error: "errRef" };
  const headers = { "idempotency-key": `${String(form.get("key") ?? "")}:${intent}:${ref}` };
  let body: Record<string, unknown>;
  if (intent === "qualify") {
    const channelId = String(form.get("channelId") ?? "").trim();
    body = { referralRef: ref, ...(channelId ? { channelId } : {}) };
  } else if (intent === "settle") {
    const gross = Number(form.get("grossMinor"));
    const share = String(form.get("channelMinor") ?? "").trim();
    if (!Number.isInteger(gross) || gross <= 0) return { ...nothing, error: "errAmount" };
    body = {
      referralRef: ref,
      currency: String(form.get("currency") ?? "").trim().toUpperCase(),
      grossMinor: gross,
      ...(share ? { channelMinor: Number(share) } : {})
    };
  } else {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }
  try {
    await api(`/v1/dist/referrals/${intent}`, { env, request, method: "POST", headers, body });
    return { ...nothing, done: { step: intent, ref } };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

export default function DistReferrals() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const busy = useNavigation().state !== "idle";
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);

  if (loaded.denied) {
    return <EmptyState title={l("denied")} body={l("deniedBody", { permission: PERM.qualify })} />;
  }

  const verb = (intent: "qualify" | "settle", fields: React.ReactNode) => (
    <Form method="post" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="key" value={loaded.key} />
      <Field label={l("referralRef")} required className="sm:w-56">
        <Input name="referralRef" required maxLength={200} />
      </Field>
      {fields}
      <Button type="submit" loading={busy}>
        {l(intent)}
      </Button>
    </Form>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
      </header>

      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.done ? l(result.done.step === "qualify" ? "qualified" : "settled", { ref: result.done.ref }) : ""}
      </p>
      {result?.error ? <p role="alert" className="font-ui text-13 text-danger">{l(result.error)}</p> : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      {loaded.may.qualify ? (
        <Card title={l("qualify")}>
          {verb(
            "qualify",
            <Field label={l("channelId")} className="sm:w-48">
              <Input name="channelId" maxLength={64} />
            </Field>
          )}
        </Card>
      ) : null}
      {loaded.may.settle ? (
        <Card title={l("settle")}>
          {verb(
            "settle",
            <>
              <Field label={l("currency")} required className="sm:w-28">
                <Input name="currency" required minLength={3} maxLength={3} />
              </Field>
              <Field label={l("grossMinor")} required className="sm:w-40">
                <Input name="grossMinor" type="number" min={1} step={1} required />
              </Field>
              <Field label={l("channelMinor")} className="sm:w-40">
                <Input name="channelMinor" type="number" min={0} step={1} />
              </Field>
            </>
          )}
        </Card>
      ) : null}

      {loaded.may.read ? (
        <Card title={l("ledger")} elevation="flat">
          <Table<ReferralTxn>
            caption={l("ledger")}
            captionHidden
            density="compact"
            rows={loaded.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={l("none")} body={l("noneBody")} />}
            columns={[
              { key: "ref", header: l("colRef"), render: (row) => <bdi className="font-mono">{referralOf(row)}</bdi> },
              { key: "step", header: l("colStep"), render: (row) => l(`step.${row.type}`) },
              { key: "state", header: l("colState"), render: (row) => <Badge tone={toneFor(row.state)}>{row.state}</Badge> },
              {
                key: "amount",
                header: l("colAmount"),
                numeric: true,
                render: (row) => (row.grossMinor ? <Money amountMinor={row.grossMinor} currency={row.currency} locale={locale} /> : "—")
              },
              { key: "when", header: l("colWhen"), render: (row) => <DateTime value={row.createdAt} locale={locale} /> }
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}
