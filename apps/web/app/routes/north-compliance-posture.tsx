import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, EmptyState } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { labelsFrom, readable, type Labels } from "./north-shared";
import { useNorthSessionData } from "./north-shell";

// docs/12-security-compliance.md §5 ends with a claim that was not true until
// this screen existed: *"NORTH surfaces a live 'Compliance posture' tile for
// `tenant.compliance` from these signals."*
//
// Two things stopped it being true, and both are worth knowing before changing
// anything here:
//
//   1. No tile was ever built.
//   2. **`tenant.compliance` holds no `north:*` permission at all.** Every other
//      NORTH screen gates on one (`north-board.tsx` on `north:boardpacks:read`),
//      so the role §5 names could not open any of them. This screen is therefore
//      gated on `core:audit:read` — the permission the role *does* hold, and the
//      right one for an evidence map: whoever reads the posture is whoever can
//      already read the trail behind it.
//
// The route reads every figure at request time, so the posture is a query rather
// than a stored score and cannot drift from the data it describes.

export const PERM = { read: "core:audit:read" } as const;

interface Control {
  key: string;
  evidence: "live" | "on_file" | "unattested";
  value: string;
  source: string;
}

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Compliance posture",
    kicker: "Every control docs/12 maps to evidence, and what kind of evidence it is",
    intro:
      "Read live each time this page loads. A figure is counted from this tenant's own data; a document on file is real evidence that no query can verify, and the two are never shown as the same thing.",
    "evidence.live": "Counted now",
    "evidence.on_file": "On file",
    "evidence.unattested": "Nothing attests to this",
    "col.control": "Control",
    "col.evidence": "Evidence",
    "col.value": "Posture",
    "col.source": "Where it comes from",
    "control.tenancy_isolation": "Tenancy isolation",
    "control.consent_enforcement": "Consent enforcement",
    "control.disclosure": "Disclosure",
    "control.ai_logging": "AI logging",
    "control.verification": "Verification",
    "control.breach": "Breach readiness",
    "control.retention": "Retention",
    "none.title": "No posture to show",
    "none.body":
      "Reading the posture needs the audit trail permission — it is an evidence map, and reading the trail behind it is the same disclosure."
  },
  ar: {
    title: "وضع الامتثال",
    kicker: "كل ضابط يربطه docs/12 بدليل، ونوع ذلك الدليل",
    intro:
      "يُقرأ مباشرة عند تحميل الصفحة. الرقم يُحصى من بيانات هذا المستأجر، والمستند المحفوظ دليل حقيقي لا تستطيع أي استعلامات التحقق منه، ولا يُعرضان أبدًا كشيء واحد.",
    "evidence.live": "محسوب الآن",
    "evidence.on_file": "محفوظ",
    "evidence.unattested": "لا شيء يشهد لهذا",
    "col.control": "الضابط",
    "col.evidence": "الدليل",
    "col.value": "الوضع",
    "col.source": "مصدره",
    "control.tenancy_isolation": "عزل المستأجرين",
    "control.consent_enforcement": "إنفاذ الموافقة",
    "control.disclosure": "الإفصاح",
    "control.ai_logging": "تسجيل الذكاء الاصطناعي",
    "control.verification": "التحقق",
    "control.breach": "الجاهزية للاختراق",
    "control.retention": "الاحتفاظ",
    "none.title": "لا يوجد وضع للعرض",
    "none.body":
      "قراءة الوضع تتطلب صلاحية سجل التدقيق — فهي خريطة أدلة، وقراءة السجل خلفها هي الإفصاح نفسه."
  }
};

/** The reader for a locale — a seam for the label tests, and what the screen uses. */
export const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  // `readable` returns null on 403/404 rather than throwing, so a reader without
  // the permission gets the empty state instead of a crash — the same taper the
  // forecast card uses.
  const page = await readable(api<{ controls: Control[] }>("/v1/north/compliance-posture", opts));
  return { controls: page?.controls ?? [] };
}

/* --------------------------------------------------------------- the screen */

export default function NorthCompliancePosture() {
  const { controls } = useLoaderData<typeof loader>();
  // The reader's own locale, not a hard-coded one: this screen exists for a
  // compliance officer in a market where Arabic is the working language.
  const shell = useNorthSessionData();
  // `north-shared`'s `labelsFrom` is (labels, locale) and returns the reader
  // directly — a different shape from the curried helper in `@lyra/ui`.
  const l = labelsFrom(LABELS, shell?.locale ?? "en");

  if (!controls.length) {
    return <EmptyState title={l("none.title")} body={l("none.body")} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title={l("title")} description={l("intro")}>
        <p className="eyebrow">{l("kicker")}</p>
        <ul className="mt-4 flex flex-col divide-y divide-border">
          {controls.map((control) => (
            <li key={control.key} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-ui text-14 font-medium">{l(`control.${control.key}`)}</span>
                {/* The badge is the whole design: a counted figure and a document
                    on file are not the same kind of evidence, and a reader must
                    be able to tell which they are looking at without reading the
                    source column. */}
                <Badge tone={control.evidence === "live" ? "success" : "neutral"}>
                  {l(`evidence.${control.evidence}`)}
                </Badge>
              </div>
              <span className="font-ui text-13 text-text">{control.value}</span>
              <span className="font-ui text-12 text-muted">{l("col.source")}: {control.source}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
