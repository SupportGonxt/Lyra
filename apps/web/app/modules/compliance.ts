import type { WorkspaceSpec } from "./spec";

// COMPLIANCE — the regulated processes that must be provable (docs/12): subject
// requests, disclosures, screening, retention, legal hold, evidence, incidents.
// Half of these tabs are records of something that already happened, so they are
// read-only here: an audit trail you can edit is not an audit trail.

export const compliance: WorkspaceSpec = {
  path: "/compliance",
  // Three rows here are produced by a run, not typed into a form: a screening is
  // a provider's answer, an evidence bundle is an archive and its hashes, a
  // retention run is a deletion. Each has a screen that asks the question and
  // shows what the API computed (ADR-0002).
  links: [
    { href: "/compliance/run/screening", labelKey: "run.screening", permission: "compliance:screenings:run" },
    { href: "/compliance/run/evidence", labelKey: "run.evidence", permission: "compliance:evidence:export" },
    { href: "/compliance/run/retention", labelKey: "run.retention", permission: "compliance:retention:run" }
  ],
  labels: {
    en: {
      "run.screening": "Run a screening",
      "run.evidence": "Export evidence",
      "run.retention": "Run retention",

      "dsar-requests": "Subject requests",
      "erasure-log": "Erasure log",
      disclosures: "Disclosures",
      screenings: "Screenings",
      "retention-runs": "Retention runs",
      "legal-holds": "Legal holds",
      "evidence-bundles": "Evidence bundles",
      incidents: "Incidents",
      "rulepack-applications": "Rulepack applications",
      "policy-thresholds": "Thresholds",

      subjectIdentifier: "Subject",
      type: "Type",
      channel: "Channel",
      state: "State",
      dueAt: "Due",
      fulfilledAt: "Fulfilled",
      handledBy: "Handled by",
      customerId: "Customer",
      verificationRef: "Verification",
      refusalReason: "Refusal reason",
      bundleFileId: "Bundle file",
      wordingRef: "Wording reference",
      criteriaJson: "Criteria",
      dsarId: "Request",
      tableName: "Table",
      rowsErased: "Rows erased",
      rowsTombstoned: "Rows tombstoned",
      retainedReason: "Retained reason",
      ts: "When",
      key: "Key",
      locale: "Locale",
      subjectRef: "Subject",
      acknowledgedAt: "Acknowledged",
      kind: "Kind",
      provider: "Provider",
      result: "Result",
      hitsJson: "Hits",
      disposition: "Disposition",
      dispositionedBy: "Dispositioned by",
      caseRef: "Case reference",
      blocked: "Blocked",
      policyKey: "Policy",
      cutoffAt: "Cutoff",
      rowsAffected: "Rows affected",
      rowsHeld: "Rows held",
      startedAt: "Started",
      reason: "Reason",
      authority: "Authority",
      placedBy: "Placed by",
      releasedBy: "Released by",
      releasedAt: "Released",
      purpose: "Purpose",
      scopeJson: "Scope",
      manifestJson: "Manifest",
      fileId: "File",
      requestedBy: "Requested by",
      approvedBy: "Approved by",
      deliveredTo: "Delivered to",
      bundleHash: "Bundle hash",
      severity: "Severity",
      title: "Title",
      summary: "Summary",
      affectedJson: "Affected",
      agentsPaused: "Agents paused",
      notifiableAt: "Notifiable",
      notifiedAt: "Notified",
      openedBy: "Opened by",
      resolvedAt: "Resolved",
      postmortemRef: "Review reference",
      rulepackId: "Rulepack",
      ruleKey: "Rule",
      outcome: "Outcome",
      version: "Version",
      valueJson: "Value",
      dualControl: "Dual control",
      effectiveFrom: "Effective from",
      effectiveTo: "Effective to",
      setBy: "Set by",

      access: "Access",
      erasure: "Erasure",
      rectification: "Rectification",
      portability: "Portability",
      objection: "Objection",
      restriction: "Restriction",
      portal: "Portal",
      email: "Email",
      whatsapp: "WhatsApp",
      regulator: "Regulator",
      received: "Received",
      verifying: "Verifying",
      in_progress: "In progress",
      awaiting_legal: "Awaiting legal",
      fulfilled: "Fulfilled",
      refused: "Refused",
      expired: "Expired",
      sanctions: "Sanctions",
      pep: "Politically exposed",
      adverse_media: "Adverse media",
      fraud: "Fraud",
      clear: "Clear",
      hit: "Hit",
      inconclusive: "Inconclusive",
      running: "Running",
      done: "Done",
      failed: "Failed",
      building: "Building",
      ready: "Ready",
      delivered: "Delivered",
      audit: "Audit",
      dispute: "Dispute",
      internal: "Internal",
      outage: "Outage",
      data: "Data",
      model: "Model",
      security: "Security",
      regulatory: "Regulatory",
      sev1: "Level 1",
      sev2: "Level 2",
      sev3: "Level 3",
      sev4: "Level 4",
      open: "Open",
      mitigated: "Mitigated",
      resolved: "Resolved",
      postmortem: "Review",
      pass: "Pass",
      fail: "Fail",
      not_applicable: "Not applicable"
    },
    ar: {
      "run.screening": "تشغيل فحص",
      "run.evidence": "تصدير الأدلة",
      "run.retention": "تشغيل الاحتفاظ",

      "dsar-requests": "طلبات أصحاب البيانات",
      "erasure-log": "سجل المحو",
      disclosures: "الإفصاحات",
      screenings: "عمليات الفحص",
      "retention-runs": "عمليات الاحتفاظ",
      "legal-holds": "التجميد القانوني",
      "evidence-bundles": "حزم الأدلة",
      incidents: "الحوادث",
      "rulepack-applications": "تطبيقات حزم القواعد",
      "policy-thresholds": "الحدود",

      subjectIdentifier: "معرّف صاحب البيانات",
      type: "النوع",
      channel: "القناة",
      state: "الحالة",
      dueAt: "موعد الاستحقاق",
      fulfilledAt: "تاريخ التنفيذ",
      handledBy: "المسؤول",
      customerId: "العميل",
      verificationRef: "مرجع التحقق",
      refusalReason: "سبب الرفض",
      bundleFileId: "ملف الحزمة",
      wordingRef: "مرجع الصيغة",
      criteriaJson: "المعايير",
      dsarId: "الطلب",
      tableName: "الجدول",
      rowsErased: "الصفوف الممحوّة",
      rowsTombstoned: "الصفوف المُعلَّمة",
      retainedReason: "سبب الاحتفاظ",
      ts: "الوقت",
      key: "المفتاح",
      locale: "اللغة",
      subjectRef: "الموضوع",
      acknowledgedAt: "تاريخ الإقرار",
      kind: "الصنف",
      provider: "المزود",
      result: "نتيجة الفحص",
      hitsJson: "التطابقات",
      disposition: "التصرف",
      dispositionedBy: "تم التصرف بواسطة",
      caseRef: "مرجع الحالة",
      blocked: "محظور",
      policyKey: "مفتاح السياسة",
      cutoffAt: "تاريخ القطع",
      rowsAffected: "الصفوف المتأثرة",
      rowsHeld: "الصفوف المحتجزة",
      startedAt: "البدء",
      reason: "السبب",
      authority: "الجهة",
      placedBy: "وُضع بواسطة",
      releasedBy: "رُفع بواسطة",
      releasedAt: "تاريخ الرفع",
      purpose: "الغرض",
      scopeJson: "النطاق",
      manifestJson: "قائمة المحتويات",
      fileId: "الملف",
      requestedBy: "طُلب بواسطة",
      approvedBy: "اعتُمد بواسطة",
      deliveredTo: "سُلِّم إلى",
      bundleHash: "بصمة الحزمة",
      severity: "الخطورة",
      title: "العنوان",
      summary: "الملخص",
      affectedJson: "المتأثرون",
      agentsPaused: "إيقاف الوكلاء",
      notifiableAt: "موعد الإبلاغ",
      notifiedAt: "تاريخ الإبلاغ",
      openedBy: "فُتح بواسطة",
      resolvedAt: "تاريخ الحل",
      postmortemRef: "مرجع المراجعة",
      rulepackId: "حزمة القواعد",
      ruleKey: "القاعدة",
      outcome: "النتيجة",
      version: "الإصدار",
      valueJson: "القيمة",
      dualControl: "رقابة مزدوجة",
      effectiveFrom: "ساري من",
      effectiveTo: "ساري حتى",
      setBy: "حُدّد بواسطة",

      access: "الاطلاع",
      erasure: "المحو",
      rectification: "التصحيح",
      portability: "النقل",
      objection: "الاعتراض",
      restriction: "التقييد",
      portal: "البوابة",
      email: "البريد الإلكتروني",
      whatsapp: "واتساب",
      regulator: "الجهة التنظيمية",
      received: "مستلم",
      verifying: "قيد التحقق",
      in_progress: "قيد التنفيذ",
      awaiting_legal: "بانتظار الشؤون القانونية",
      fulfilled: "مُنفَّذ",
      refused: "مرفوض",
      expired: "منتهٍ",
      sanctions: "العقوبات",
      pep: "شخصية سياسية بارزة",
      adverse_media: "تغطية إعلامية سلبية",
      fraud: "الاحتيال",
      clear: "خالٍ",
      hit: "تطابق",
      inconclusive: "غير حاسم",
      running: "قيد التشغيل",
      done: "تم",
      failed: "فشل",
      building: "قيد الإنشاء",
      ready: "جاهز",
      delivered: "سُلِّم",
      audit: "تدقيق",
      dispute: "نزاع",
      internal: "داخلي",
      outage: "انقطاع",
      data: "بيانات",
      model: "نموذج",
      security: "أمن",
      regulatory: "تنظيمي",
      sev1: "المستوى 1",
      sev2: "المستوى 2",
      sev3: "المستوى 3",
      sev4: "المستوى 4",
      open: "مفتوح",
      mitigated: "مُخفَّف",
      resolved: "محلول",
      postmortem: "مراجعة لاحقة",
      pass: "مطابق",
      fail: "غير مطابق",
      not_applicable: "لا ينطبق"
    }
  },
  tabs: [
    {
      key: "dsar-requests",
      api: "/v1/compliance/dsar-requests",
      read: "compliance:dsar:read",
      create: "compliance:dsar:create",
      update: "compliance:dsar:fulfil",
      sort: "dueAt",
      order: "asc",
      filters: [
        {
          name: "state",
          options: [
            "received",
            "verifying",
            "in_progress",
            "awaiting_legal",
            "fulfilled",
            "refused",
            "expired"
          ]
        },
        {
          name: "type",
          options: ["access", "erasure", "rectification", "portability", "objection", "restriction"]
        }
      ],
      columns: [
        { name: "subjectIdentifier", type: "text" },
        { name: "type", type: "text" },
        { name: "channel", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "dueAt", type: "datetime", sortable: true },
        { name: "fulfilledAt", type: "datetime" },
        { name: "handledBy", type: "text" }
      ],
      fields: [
        { name: "subjectIdentifier", type: "text", required: true },
        {
          name: "type",
          type: "select",
          required: true,
          options: ["access", "erasure", "rectification", "portability", "objection", "restriction"]
        },
        {
          name: "channel",
          type: "select",
          required: true,
          options: ["portal", "email", "whatsapp", "regulator"]
        },
        { name: "customerId", type: "text" },
        { name: "dueAt", type: "datetime", required: true },
        { name: "verificationRef", type: "text" }
      ],
      // Fulfilment moves the state and records what was produced; the completeness
      // proof is written by the erasure run, not typed here.
      editable: [
        {
          name: "state",
          type: "select",
          options: [
            "received",
            "verifying",
            "in_progress",
            "awaiting_legal",
            "fulfilled",
            "refused",
            "expired"
          ]
        },
        { name: "handledBy", type: "text" },
        { name: "fulfilledAt", type: "datetime" },
        { name: "refusalReason", type: "text" },
        { name: "bundleFileId", type: "text" }
      ]
    },
    {
      // What an erasure actually did, per table. Immutable in the API.
      key: "erasure-log",
      api: "/v1/compliance/erasure-log",
      read: "compliance:dsar:read",
      sort: "ts",
      columns: [
        { name: "dsarId", type: "text" },
        { name: "tableName", type: "text" },
        { name: "rowsErased", type: "number" },
        { name: "rowsTombstoned", type: "number" },
        { name: "retainedReason", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      // The wording that was shown, when, to whom. Immutable in the API.
      key: "disclosures",
      api: "/v1/compliance/disclosures",
      read: "compliance:disclosures:read",
      sort: "ts",
      columns: [
        { name: "key", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "customerId", type: "text" },
        { name: "locale", type: "text" },
        { name: "channel", type: "text" },
        { name: "wordingRef", type: "text" },
        { name: "acknowledgedAt", type: "datetime" },
        { name: "ts", type: "datetime", sortable: true },
        // The ranking/eligibility criteria that were shown alongside the
        // wording. Wide, so it trails the row rather than crowding it.
        { name: "criteriaJson", type: "json" }
      ]
    },
    {
      key: "screenings",
      api: "/v1/compliance/screenings",
      read: "compliance:screenings:read",
      // No `create`: a screening row is the provider's answer, and `queryHash`
      // is computed from the question that was asked, never typed. The run lives
      // at `POST /v1/compliance/screenings/run` behind
      // `compliance:screenings:run`, and its screen is /compliance/run/screening.
      sort: "ts",
      filters: [
        { name: "result", options: ["clear", "hit", "inconclusive"] },
        { name: "kind", options: ["sanctions", "pep", "adverse_media", "fraud"] }
      ],
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "kind", type: "text" },
        { name: "provider", type: "text" },
        { name: "result", type: "text", badge: true },
        { name: "disposition", type: "text" },
        { name: "dispositionedBy", type: "text" },
        { name: "caseRef", type: "text" },
        { name: "blocked", type: "boolean" },
        { name: "ts", type: "datetime", sortable: true },
        // What the provider actually matched on. Last, because it is the one
        // column wide enough to make the rest of the row unreadable — but a
        // screening that never shows its hits cannot be reviewed at all.
        { name: "hitsJson", type: "json" }
      ]
    },
    {
      key: "retention-runs",
      api: "/v1/compliance/retention-runs",
      read: "compliance:retention:read",
      // No `create`: a run row is what a purge did — cutoff, rows deleted, rows
      // a legal hold kept. The cutoff comes from the tenant's retention policy
      // and the floor under it, so it is the server's number, not a form's.
      // `POST /v1/compliance/retention/run` (screen: /compliance/run/retention).
      sort: "startedAt",
      filters: [{ name: "state", options: ["running", "done", "failed"] }],
      columns: [
        { name: "policyKey", type: "text" },
        { name: "tableName", type: "text" },
        { name: "cutoffAt", type: "datetime" },
        { name: "rowsAffected", type: "number" },
        { name: "rowsHeld", type: "number" },
        { name: "state", type: "text", badge: true },
        { name: "startedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "legal-holds",
      api: "/v1/compliance/legal-holds",
      read: "compliance:legal_holds:read",
      create: "compliance:legal_holds:write",
      update: "compliance:legal_holds:write",
      // Releasing a hold goes through the compliance.legal_hold_release approval
      // (resources.ts), not straight to a delete.
      remove: "compliance:legal_holds:write",
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "reason", type: "text" },
        { name: "authority", type: "text" },
        { name: "placedBy", type: "text" },
        { name: "releasedBy", type: "text" },
        { name: "releasedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // `placedBy` is an actor column (resources.ts): the API fills it from the
      // session and rejects a body that carries it, so it is not a field.
      fields: [
        { name: "subjectRef", type: "text", required: true },
        { name: "reason", type: "textarea", required: true },
        { name: "authority", type: "text" }
      ]
    },
    {
      // A signed bundle with its hash manifest. Immutable in the API: re-export
      // rather than amend, so the hash still describes what was handed over.
      key: "evidence-bundles",
      api: "/v1/compliance/evidence-bundles",
      read: "compliance:evidence:read",
      // No `create`: `bundleHash` and the per-file sha256 `manifestJson` are
      // computed over the archive that was assembled, so a typed hash would
      // describe nothing. The export runs at
      // `POST /v1/compliance/evidence-bundles/export` behind
      // `compliance:evidence:export` (screen: /compliance/run/evidence).
      filters: [
        { name: "state", options: ["building", "ready", "delivered", "failed"] },
        { name: "purpose", options: ["regulator", "audit", "dispute", "internal"] }
      ],
      columns: [
        { name: "purpose", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "requestedBy", type: "text" },
        { name: "approvedBy", type: "text" },
        { name: "deliveredTo", type: "text" },
        { name: "bundleHash", type: "text" },
        { name: "fileId", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true },
        // What was gathered and what each file hashes to — the two things an
        // auditor checks the bundle against. Wide, so they trail the row.
        { name: "scopeJson", type: "json" },
        { name: "manifestJson", type: "json" }
      ]
    },
    {
      key: "incidents",
      api: "/v1/compliance/incidents",
      read: "compliance:incidents:read",
      create: "compliance:incidents:write",
      update: "compliance:incidents:write",
      remove: "compliance:incidents:write",
      filters: [
        { name: "state", options: ["open", "mitigated", "resolved", "postmortem"] },
        { name: "severity", options: ["sev1", "sev2", "sev3", "sev4"] },
        { name: "kind", options: ["outage", "data", "model", "security", "regulatory"] }
      ],
      columns: [
        { name: "title", type: "text" },
        { name: "kind", type: "text" },
        { name: "severity", type: "text", badge: true },
        { name: "state", type: "text", badge: true },
        { name: "agentsPaused", type: "boolean" },
        { name: "notifiedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "title", type: "text", required: true },
        {
          name: "kind",
          type: "select",
          required: true,
          options: ["outage", "data", "model", "security", "regulatory"]
        },
        // `openedBy` is an actor column (resources.ts): stamped from the
        // session, refused in the body. Whoever files the incident is the
        // person logged in, and that is not a thing you get to type.
        { name: "severity", type: "select", options: ["sev1", "sev2", "sev3", "sev4"] },
        { name: "summary", type: "textarea" },
        { name: "affectedJson", type: "json" },
        { name: "notifiableAt", type: "datetime" }
      ],
      editable: [
        { name: "state", type: "select", options: ["open", "mitigated", "resolved", "postmortem"] },
        { name: "severity", type: "select", options: ["sev1", "sev2", "sev3", "sev4"] },
        { name: "summary", type: "textarea" },
        { name: "agentsPaused", type: "boolean" },
        { name: "notifiedAt", type: "datetime" },
        { name: "resolvedAt", type: "datetime" },
        { name: "postmortemRef", type: "text" }
      ]
    },
    {
      // Which rulepack version was in force for a decision. Machine-written:
      // the engine writes a row as it applies a rule, and `apply` is that
      // engine's permission. No `create` here — a hand-typed record of what a
      // rule decided is not a record of what the rule decided.
      key: "rulepack-applications",
      api: "/v1/compliance/rulepack-applications",
      read: "compliance:rulepacks:read",
      sort: "ts",
      filters: [{ name: "outcome", options: ["pass", "fail", "not_applicable"] }],
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "rulepackId", type: "text" },
        { name: "ruleKey", type: "text" },
        { name: "outcome", type: "text", badge: true },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      // Versioned, because "what was the limit in March" is an audit question:
      // a new threshold is a new version, not an edit to the old one.
      key: "policy-thresholds",
      api: "/v1/compliance/policy-thresholds",
      read: "compliance:thresholds:read",
      create: "compliance:thresholds:write",
      update: "compliance:thresholds:write",
      remove: "compliance:thresholds:write",
      sort: "effectiveFrom",
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "version", type: "number" },
        { name: "valueJson", type: "json" },
        { name: "dualControl", type: "boolean" },
        { name: "effectiveFrom", type: "date", sortable: true },
        { name: "effectiveTo", type: "date" },
        { name: "setBy", type: "text" }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "version", type: "number", required: true },
        { name: "valueJson", type: "json", required: true },
        // `setBy` is an actor column (resources.ts): who moved the limit is
        // the session, not a name the mover chooses for themselves.
        { name: "effectiveFrom", type: "date", required: true },
        { name: "effectiveTo", type: "date" },
        { name: "dualControl", type: "boolean" }
      ],
      editable: [
        { name: "effectiveTo", type: "date" },
        { name: "dualControl", type: "boolean" }
      ]
    }
  ]
};
