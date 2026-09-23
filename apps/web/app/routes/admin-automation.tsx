import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Badge, Button, Card, Checkbox, EmptyState, PageHeader } from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem as ProblemBody } from "../api.server";
import { usePending } from "../components/pending";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { policyTitle } from "../policy";
import { labelsFrom } from "./detail-kit";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// The tenant's auto-approve allowlist (CLAUDE.md §4, docs/19 §7): which approval
// policies this organisation lets through without a person. The API had the
// read and the write; nothing offered them, so the seed was the only writer.
// Policies the floor forbids (payouts, client money, regulatory crossings) are
// listed as such and cannot be ticked — the API refuses them either way.

export const PERM = { read: "core:settings:read", update: "core:settings:update" } as const;

interface PolicyRow {
  key: string;
  module: string;
  automatable: boolean;
}

interface Allowlist {
  autoApprove: string[];
  policies: PolicyRow[];
}

/** The area a policy belongs to, read off its key: `dist.*` policies are gated
 *  in core but a reader looks for them under Distribution. */
const areaOf = (p: Pick<PolicyRow, "key">) => p.key.split(".")[0] ?? p.key;

/** What a save sends: the ticked boxes against the stored list, floor applied. */
export function allowlistChange(
  current: readonly string[],
  ticked: readonly string[],
  automatable: ReadonlySet<string>
): { add: string[]; remove: string[] } {
  const want = new Set(ticked.filter((key) => automatable.has(key)));
  const have = new Set(current);
  return {
    add: [...want].filter((key) => !have.has(key)).sort(),
    remove: [...have].filter((key) => !want.has(key) && automatable.has(key)).sort()
  };
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Automatic approvals",
    intro:
      "Actions your organisation lets through without a second person. Everything not ticked stops for an approval.",
    deniedTitle: "You cannot read approval settings",
    lede: "{n} of {total} automatable approvals run without a person.",
    ledeNone: "Every approval waits for a person.",
    automatable: "May be automated",
    floorTitle: "Always needs a person",
    floorIntro:
      "Payouts, client money, reported results and regulatory steps stop for a person whatever this list says.",
    save: "Save",
    saved: "Saved. The new list applies to the next request.",
    readOnly: "You can read this list. Changing it needs the settings permission.",
    "module.ai": "AI",
    "module.axis": "Operations",
    "module.compliance": "Compliance",
    "module.core": "Organisation",
    "module.dist": "Distribution",
    "module.ledger": "Ledger",
    "module.orbit": "Conversations",
    "module.scout": "Market",
    "module.signal": "Marketing"
  },
  ar: {
    title: "الموافقات التلقائية",
    intro: "الإجراءات التي تسمح بها مؤسستك دون شخص ثانٍ. كل ما لم يُحدَّد يتوقف لطلب موافقة.",
    deniedTitle: "لا يمكنك قراءة إعدادات الموافقات",
    lede: "{n} من {total} موافقة قابلة للأتمتة تمرّ دون شخص.",
    ledeNone: "كل موافقة تنتظر شخصًا.",
    automatable: "يمكن أتمتتها",
    floorTitle: "تحتاج دائمًا إلى شخص",
    floorIntro: "المدفوعات وأموال العملاء والنتائج المُعلنة والخطوات التنظيمية تتوقف لشخص أيًّا كان ما في هذه القائمة.",
    save: "حفظ",
    saved: "تم الحفظ. تسري القائمة الجديدة على الطلب التالي.",
    readOnly: "يمكنك قراءة هذه القائمة. تغييرها يتطلب صلاحية الإعدادات.",
    "module.ai": "الذكاء الاصطناعي",
    "module.axis": "العمليات",
    "module.compliance": "الامتثال",
    "module.core": "المؤسسة",
    "module.dist": "التوزيع",
    "module.ledger": "الدفتر",
    "module.orbit": "المحادثات",
    "module.scout": "السوق",
    "module.signal": "التسويق"
  }
};

export const labelsIn = labelsFrom(LABELS);

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = { read: held.has(PERM.read), update: held.has(PERM.update) };
  const list = may.read ? await api<Allowlist>("/v1/core/settings/auto-approve", { env, request }) : null;
  return { may, list };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<{ problem: ProblemBody | null; saved: boolean }> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  try {
    const list = await api<Allowlist>("/v1/core/settings/auto-approve", { env, request });
    const automatable = new Set(list.policies.filter((p) => p.automatable).map((p) => p.key));
    const change = allowlistChange(list.autoApprove, form.getAll("policy").map(String), automatable);
    await api("/v1/core/settings/auto-approve", { env, request, method: "PATCH", body: change });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, saved: false };
    throw error;
  }
  return { problem: null, saved: true };
}

export default function AdminAutomation() {
  const { may, list } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const pending = usePending();

  if (!list) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const on = new Set(list.autoApprove);
  const open = list.policies.filter((p) => p.automatable);
  const floor = list.policies.filter((p) => !p.automatable);
  const byModule = (rows: PolicyRow[]) =>
    [...new Set(rows.map(areaOf))].map((module) => ({
      module,
      rows: rows.filter((p) => areaOf(p) === module)
    }));
  const count = open.filter((p) => on.has(p.key)).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={l("title")}
        title={count ? l("lede", { n: String(count), total: String(open.length) }) : l("ledeNone")}
        description={l("intro")}
      />

      <Card title={l("automatable")}>
        <Form method="post" className="flex flex-col gap-5">
          {byModule(open).map((group) => (
            <fieldset key={group.module} className="flex flex-col gap-2">
              <legend className="eyebrow mb-2">{l(`module.${group.module}`)}</legend>
              {group.rows.map((p) => (
                <Checkbox
                  key={p.key}
                  name="policy"
                  value={p.key}
                  defaultChecked={on.has(p.key)}
                  disabled={!may.update}
                  label={policyTitle(p.key, p.module, locale)}
                />
              ))}
            </fieldset>
          ))}
          {result?.problem ? <Problem problem={result.problem} /> : null}
          {result?.saved ? (
            <p role="status" className="font-ui text-13 text-success">
              {l("saved")}
            </p>
          ) : null}
          {may.update ? (
            <div>
              <Button type="submit" name="intent" value="save" loading={pending("save")}>
                {l("save")}
              </Button>
            </div>
          ) : (
            <p className="font-ui text-13 text-muted">{l("readOnly")}</p>
          )}
        </Form>
      </Card>

      <Card title={l("floorTitle")} description={l("floorIntro")}>
        <div className="flex flex-col gap-4">
          {byModule(floor).map((group) => (
            <div key={group.module} className="flex flex-col gap-2">
              <h3 className="eyebrow">{l(`module.${group.module}`)}</h3>
              <ul className="flex flex-wrap gap-2">
                {group.rows.map((p) => (
                  <li key={p.key}>
                    <Badge tone="neutral" size="sm">
                      {policyTitle(p.key, p.module, locale)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
