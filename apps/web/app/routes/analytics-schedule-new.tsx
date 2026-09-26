import { Form, Link, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Button, Card, EmptyState, Field, Input, Select } from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { labelsFrom } from "./detail-kit";
import { CADENCES, FORMATS, scheduleBody } from "./analytics-builder";
import type { ReportRow } from "./analytics-report";
import { Gate } from "./module";
import { useShellData } from "./workspace";

// docs/30 Analytics 2. A report could be scheduled only while saving it in the
// builder; one saved earlier had no way in. This asks for the same four things
// the builder does — which report, how often, what file, who — and posts the
// same body (scheduleBody), so cron and recipients are never typed free-hand.

export const PERM = { write: "analytics:schedules:write", read: "analytics:reports:read" } as const;

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Schedule a report",
    intro: "Deliver a saved report on a fixed rhythm. The file goes to the people you name; each delivery runs with the report's own permissions.",
    report: "Report",
    cadence: "Deliver it",
    daily: "Every day at 06:00",
    weekly: "Every Monday at 06:00",
    monthly: "On the 1st at 06:00",
    format: "File",
    recipients: "Recipients (emails, comma separated)",
    submit: "Schedule it",
    done: "Scheduled. It appears on the schedules tab.",
    toSchedules: "Open the schedules",
    noReports: "No saved report to schedule yet.",
    noReportsBody: "Save one from the report builder first.",
    denied: "You cannot schedule reports",
    deniedBody: "Scheduling needs {permission}.",
    errReport: "Pick a report.",
    errCadence: "Pick how often.",
    errRecipients: "Name at least one recipient."
  },
  ar: {
    title: "جدولة تقرير",
    intro: "سلّم تقريرًا محفوظًا وفق إيقاع ثابت. يصل الملف إلى من تحددهم، ويعمل كل تسليم بصلاحيات التقرير نفسه.",
    report: "التقرير",
    cadence: "التسليم",
    daily: "كل يوم الساعة 06:00",
    weekly: "كل اثنين الساعة 06:00",
    monthly: "في اليوم الأول الساعة 06:00",
    format: "الملف",
    recipients: "المستلمون (عناوين بريد مفصولة بفواصل)",
    submit: "جدولته",
    done: "تمت الجدولة. يظهر في تبويب الجداول.",
    toSchedules: "فتح الجداول",
    noReports: "لا يوجد تقرير محفوظ لجدولته بعد.",
    noReportsBody: "احفظ واحدًا من منشئ التقارير أولًا.",
    denied: "لا يمكنك جدولة التقارير",
    deniedBody: "تحتاج الجدولة إلى {permission}.",
    errReport: "اختر تقريرًا.",
    errCadence: "اختر عدد مرات التسليم.",
    errRecipients: "حدّد مستلمًا واحدًا على الأقل."
  }
};
export const labelsIn = labelsFrom(LABELS);

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  if (!held.has(PERM.write)) return { denied: true as const, reports: [] as ReportRow[], chosen: "" };
  const reports = held.has(PERM.read) ? (await api<{ data: ReportRow[] }>("/v1/analytics/reports?limit=200", { env, request })).data : [];
  return { denied: false as const, reports, chosen: new URL(request.url).searchParams.get("reportId") ?? "" };
}

type Result = { problem: Problem | null; error: string | null; done: boolean };

export async function action({ request, context }: ActionFunctionArgs): Promise<Result> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const nothing: Result = { problem: null, error: null, done: false };
  const reportId = String(form.get("reportId") ?? "");
  if (!reportId) return { ...nothing, error: "errReport" };
  const locale = String(form.get("locale") ?? "en");
  try {
    // The schedule carries the report's own name, in every language it has.
    const report = await api<ReportRow>(`/v1/analytics/reports/${encodeURIComponent(reportId)}`, { env, request });
    const body = scheduleBody(form, reportId, report.name, locale);
    if (!body) return { ...nothing, error: "errCadence" };
    if (!body.recipients.length) return { ...nothing, error: "errRecipients" };
    await api("/v1/analytics/schedules", { env, request, method: "POST", body });
    return { ...nothing, done: true };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

export default function AnalyticsScheduleNew() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const busy = useNavigation().state !== "idle";
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);

  if (loaded.denied) return <EmptyState title={l("denied")} body={l("deniedBody", { permission: PERM.write })} />;
  const nameOf = (row: ReportRow) => row.name[locale] ?? row.name.en ?? row.key;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
      </header>
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l("done")}{" "}
          <Link to="/analytics/schedules" className="text-accent underline-offset-2 hover:underline">
            {l("toSchedules")}
          </Link>
        </p>
      ) : null}
      {result?.error ? <p role="alert" className="font-ui text-13 text-danger">{l(result.error)}</p> : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      {loaded.reports.length === 0 ? (
        <EmptyState title={l("noReports")} body={l("noReportsBody")} />
      ) : (
        <Card>
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="locale" value={locale} />
            <Field label={l("report")} required>
              <Select
                name="reportId"
                {...(loaded.chosen ? { defaultValue: loaded.chosen } : {})}
                options={loaded.reports.map((row) => ({ value: row.id, label: nameOf(row) }))}
              />
            </Field>
            <Field label={l("cadence")} required>
              <Select name="cadence" defaultValue="weekly" options={Object.keys(CADENCES).map((key) => ({ value: key, label: l(key) }))} />
            </Field>
            <Field label={l("format")}>
              <Select name="format" defaultValue="pdf" options={FORMATS.map((format) => ({ value: format, label: format.toUpperCase() }))} />
            </Field>
            <Field label={l("recipients")} required>
              <Input name="recipients" type="text" inputMode="email" required />
            </Field>
            <div>
              <Button type="submit" loading={busy}>
                {l("submit")}
              </Button>
            </div>
          </Form>
        </Card>
      )}
    </div>
  );
}
