import type { WorkspaceSpec } from "./spec";

// ANALYTICS — reporting (docs/09). A report is a saved definition, a run is one
// materialisation of it and an export is the file that left the building; these
// tabs are the register of all three.
//
// Authoring is split on purpose. Where the API takes plain columns (a dashboard
// layout, an export request, a saved view) the generic form is the whole screen.
// Where it takes a shaped body the form cannot honestly express — a report
// `definition`, a schedule's cron and recipient list — nothing is declared here
// and the work belongs to a builder screen: a JSON box pretending to be an
// editor is worse than no button at all.

export const analytics: WorkspaceSpec = {
  path: "/analytics",
  labels: {
    en: {
      dashboards: "Dashboards",
      reports: "Reports",
      "report-runs": "Runs",
      exports: "Exports",
      schedules: "Schedules",
      "saved-views": "Saved views",
      "unit-economics": "Unit economics",
      "journey-events": "Journey events",
      reportBuilder: "Report builder",
      buildReport: "Build a report",
      openDashboard: "Open dashboard",

      // Record actions the API owns (apps/api/src/routes/analytics.ts).
      "schedules.pause": "Pause this schedule",
      "schedules.resume": "Resume this schedule",

      key: "Key",
      module: "Module",
      scope: "Scope",
      ownerRef: "Owner",
      isDefault: "Default",
      nameJson: "Name",
      descriptionJson: "Description",
      requiredPermission: "Required permission",
      rolesJson: "Roles",
      layoutJson: "Layout",
      piiLevel: "PII level",
      system: "System",
      reportId: "Report",
      dashboardId: "Dashboard",
      trigger: "Trigger",
      state: "State",
      status: "Status",
      lastState: "Last result",
      rowCount: "Rows",
      durationMs: "Duration",
      truncated: "Truncated",
      startedAt: "Started",
      endedAt: "Ended",
      expiresAt: "Expires",
      error: "Reason",
      requestedBy: "Requested by",
      approvedBy: "Approved by",
      paramsJson: "Parameters",
      format: "Format",
      sizeBytes: "Size",
      fileId: "File",
      downloadCount: "Downloads",
      piiMasked: "Masked",
      piiJustification: "Reason for unmasked data",
      cron: "Schedule",
      timezone: "Time zone",
      recipientsJson: "Recipients",
      nextRunAt: "Next run",
      lastRunAt: "Last run",
      route: "Screen",
      name: "Name",
      queryJson: "Query",
      columnsJson: "Columns",
      day: "Day",
      unit: "Unit",
      volume: "Volume",
      revenueMinor: "Revenue",
      humanMinutes: "Human minutes",
      journeyId: "Journey",
      step: "Step",
      actorRef: "Actor",
      subjectRef: "Subject",
      outcome: "Outcome",
      ts: "When",

      layout: "Layout",
      roles: "Roles",
      description: "Description",
      from: "From",
      to: "To",
      limit: "Row limit",
      totals: "Include totals",
      unmasked: "Unmasked",
      orientation: "Orientation",
      query: "Query",
      columns: "Columns",
      shared: "Share with the team",

      tenant: "Tenant",
      team: "Team",
      personal: "Personal",
      none: "None",
      low: "Low",
      high: "High",
      queued: "Queued",
      running: "Running",
      done: "Done",
      failed: "Failed",
      expired: "Expired",
      rendering: "Rendering",
      ready: "Ready",
      active: "Active",
      paused: "Paused",
      partial: "Partial",
      undelivered: "Undelivered",
      user: "Person",
      schedule: "Schedule",
      api: "API",
      progressed: "Progressed",
      completed: "Completed",
      abandoned: "Abandoned",
      xlsx: "Excel (.xlsx)",
      pdf: "PDF",
      csv: "CSV",
      json: "JSON",
      portrait: "Portrait",
      landscape: "Landscape"
    },
    ar: {
      dashboards: "لوحات المعلومات",
      reports: "التقارير",
      "report-runs": "عمليات التشغيل",
      exports: "التصديرات",
      schedules: "الجداول الزمنية",
      "saved-views": "العروض المحفوظة",
      "unit-economics": "اقتصاديات الوحدة",
      "journey-events": "أحداث الرحلة",
      reportBuilder: "منشئ التقارير",
      buildReport: "إنشاء تقرير",
      openDashboard: "فتح اللوحة",

      "schedules.pause": "إيقاف هذا الجدول مؤقتًا",
      "schedules.resume": "استئناف هذا الجدول",

      key: "المفتاح",
      module: "الوحدة",
      scope: "النطاق",
      ownerRef: "المالك",
      isDefault: "افتراضي",
      nameJson: "الاسم",
      descriptionJson: "الوصف",
      requiredPermission: "الإذن المطلوب",
      rolesJson: "الأدوار",
      layoutJson: "التخطيط",
      piiLevel: "مستوى البيانات الشخصية",
      system: "النظام",
      reportId: "التقرير",
      dashboardId: "لوحة المعلومات",
      trigger: "المُشغِّل",
      state: "الحالة",
      status: "الحالة",
      lastState: "آخر نتيجة",
      rowCount: "عدد الصفوف",
      durationMs: "المدة",
      truncated: "مقتطع",
      startedAt: "البدء",
      endedAt: "الانتهاء",
      expiresAt: "ينتهي في",
      error: "السبب",
      requestedBy: "طلبه",
      approvedBy: "اعتمده",
      paramsJson: "المعايير",
      format: "الصيغة",
      sizeBytes: "حجم الملف",
      fileId: "الملف",
      downloadCount: "مرات التنزيل",
      piiMasked: "إخفاء البيانات الشخصية",
      piiJustification: "سبب طلب البيانات غير المقنَّعة",
      cron: "التكرار",
      timezone: "المنطقة الزمنية",
      recipientsJson: "المستلمون",
      nextRunAt: "التشغيل التالي",
      lastRunAt: "آخر تشغيل",
      route: "الشاشة",
      name: "الاسم",
      queryJson: "الاستعلام",
      columnsJson: "الأعمدة",
      day: "اليوم",
      unit: "وحدة القياس",
      volume: "العدد",
      revenueMinor: "الإيراد",
      humanMinutes: "الدقائق البشرية",
      journeyId: "الرحلة",
      step: "الخطوة",
      actorRef: "الفاعل",
      subjectRef: "الموضوع",
      outcome: "النتيجة",
      ts: "الوقت",

      layout: "التخطيط",
      roles: "الأدوار",
      description: "الوصف",
      from: "من",
      to: "إلى",
      limit: "حد الصفوف",
      totals: "تضمين الإجماليات",
      unmasked: "غير مقنَّع",
      orientation: "اتجاه الصفحة",
      query: "الاستعلام",
      columns: "الأعمدة",
      shared: "المشاركة مع الفريق",

      tenant: "المؤسسة",
      team: "الفريق",
      personal: "شخصي",
      none: "لا شيء",
      low: "منخفض",
      high: "مرتفع",
      queued: "في الانتظار",
      running: "قيد التشغيل",
      done: "تم",
      failed: "فشل",
      expired: "منتهٍ",
      rendering: "قيد الإنشاء",
      ready: "جاهز",
      active: "نشط",
      paused: "متوقف مؤقتًا",
      partial: "جزئي",
      undelivered: "لم يُسلَّم",
      user: "شخص",
      schedule: "جدولة",
      api: "واجهة برمجية",
      progressed: "تقدّم",
      completed: "أُنجزت",
      abandoned: "متروك",
      xlsx: "إكسل (.xlsx)",
      pdf: "PDF",
      csv: "CSV",
      json: "JSON",
      portrait: "طولي",
      landscape: "عرضي"
    }
  },
  tabs: [
    // The module router answers GET for dashboards, reports, exports, schedules
    // and unit economics, and it applies scope and permission rules the generic
    // list cannot — so those tabs carry no `search`, `filters` or `sort`, which
    // it would ignore. Narrowing belongs on the builder screen.
    {
      key: "dashboards",
      api: "/v1/analytics/dashboards",
      read: "analytics:dashboards:read",
      // The list is a register; the dashboard itself is the screen that paints
      // its tiles (routes/analytics-dashboard.tsx).
      recordLink: { href: "/analytics/dashboard/{id}", labelKey: "openDashboard" },
      create: "analytics:dashboards:write",
      update: "analytics:dashboards:write",
      remove: "analytics:dashboards:write",
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "nameJson", type: "json" },
        { name: "module", type: "text" },
        { name: "scope", type: "text", badge: true },
        { name: "ownerRef", type: "text" },
        { name: "rolesJson", type: "json" },
        { name: "isDefault", type: "boolean" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      // POST is the module router's own (name/layout/roles as objects); PATCH
      // falls through to generic CRUD, which speaks column names.
      fields: [
        { name: "key", type: "text", required: true },
        { name: "module", type: "text", required: true },
        { name: "name", type: "json", required: true },
        { name: "layout", type: "json", required: true },
        { name: "scope", type: "select", options: ["tenant", "team", "personal"] },
        { name: "roles", type: "json" },
        { name: "isDefault", type: "boolean" }
      ],
      editable: [
        { name: "nameJson", type: "json" },
        { name: "layoutJson", type: "json" },
        { name: "rolesJson", type: "json" },
        { name: "scope", type: "select", options: ["tenant", "team", "personal"] },
        { name: "isDefault", type: "boolean" }
      ]
    },
    {
      key: "reports",
      api: "/v1/analytics/reports",
      read: "analytics:reports:read",
      recordLink: { href: "/analytics/report/{id}", labelKey: "reportBuilder" },
      // A system report cannot be edited or deleted; the API refuses, and the
      // clone lives on the builder.
      update: "analytics:reports:write",
      remove: "analytics:reports:write",
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "nameJson", type: "json" },
        { name: "descriptionJson", type: "json" },
        { name: "module", type: "text" },
        { name: "piiLevel", type: "text", badge: true },
        { name: "scope", type: "text", badge: true },
        { name: "requiredPermission", type: "text" },
        { name: "ownerRef", type: "text" },
        { name: "system", type: "boolean" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      // No `fields`: POST /reports requires a `definition`, which is a query,
      // not a column. Creating a report is the builder's job.
      // ponytail: PATCH takes `name`/`description` as objects while the row
      // carries `nameJson`, so those two inputs start empty and an untouched one
      // is left alone (an empty field is "not supplied", modules/spec.ts).
      editable: [
        { name: "key", type: "text" },
        { name: "module", type: "text" },
        { name: "name", type: "json" },
        { name: "description", type: "json" },
        { name: "piiLevel", type: "select", options: ["none", "low", "high"] },
        { name: "scope", type: "select", options: ["tenant", "team", "personal"] }
      ]
    },
    {
      key: "report-runs",
      api: "/v1/analytics/report-runs",
      read: "analytics:reports:read",
      // Runs are written by POST /v1/analytics/reports/:id/run, never by hand:
      // a generic create would insert history for a report that never ran.
      sort: "startedAt",
      filters: [
        { name: "state", options: ["queued", "running", "done", "failed", "expired"] },
        { name: "trigger", options: ["user", "schedule", "api"] }
      ],
      columns: [
        { name: "reportId", type: "text" },
        { name: "trigger", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "requestedBy", type: "text" },
        { name: "rowCount", type: "number" },
        { name: "truncated", type: "boolean" },
        { name: "durationMs", type: "number" },
        { name: "paramsJson", type: "json" },
        { name: "error", type: "text" },
        { name: "startedAt", type: "datetime", sortable: true },
        { name: "endedAt", type: "datetime" },
        { name: "expiresAt", type: "datetime" }
      ]
    },
    {
      key: "exports",
      api: "/v1/analytics/exports",
      // The list shows only your own rows unless you can read the audit log,
      // so reading the register needs `:download`, not `:create` — asking for a
      // file and seeing the ones you asked for are different rights.
      read: "analytics:exports:download",
      create: "analytics:exports:create",
      columns: [
        { name: "reportId", type: "text" },
        { name: "format", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "requestedBy", type: "text" },
        { name: "approvedBy", type: "text" },
        { name: "rowCount", type: "number" },
        { name: "sizeBytes", type: "number" },
        { name: "piiMasked", type: "boolean" },
        { name: "piiJustification", type: "text" },
        { name: "fileId", type: "text" },
        { name: "downloadCount", type: "number" },
        { name: "error", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true },
        { name: "expiresAt", type: "datetime" }
      ],
      // An export of a saved report: format plus a window. An ad-hoc
      // `definition` export is the report builder's export button, not this.
      fields: [
        { name: "format", type: "select", options: ["xlsx", "pdf", "csv", "json"], required: true },
        { name: "reportId", type: "text", required: true },
        { name: "from", type: "date" },
        { name: "to", type: "date" },
        { name: "limit", type: "number" },
        { name: "totals", type: "boolean" },
        { name: "orientation", type: "select", options: ["portrait", "landscape"] },
        { name: "unmasked", type: "boolean" },
        { name: "piiJustification", type: "text" }
      ]
    },
    {
      key: "schedules",
      api: "/v1/analytics/schedules",
      read: "analytics:schedules:read",
      update: "analytics:schedules:write",
      remove: "analytics:schedules:write",
      columns: [
        { name: "nameJson", type: "json" },
        { name: "reportId", type: "text" },
        { name: "dashboardId", type: "text" },
        { name: "cron", type: "text" },
        { name: "timezone", type: "text" },
        { name: "format", type: "text" },
        { name: "recipientsJson", type: "json" },
        { name: "status", type: "text", badge: true },
        { name: "lastState", type: "text", badge: true },
        { name: "nextRunAt", type: "datetime", sortable: true },
        { name: "lastRunAt", type: "datetime" }
      ],
      // No `fields`: POST /schedules wants a cron expression and a recipient
      // list, and typing either into a text box is how a report gets mailed to
      // the wrong people at the wrong hour. That needs its own screen.
      // `cron` and `status` are missing from `editable` on purpose: the API
      // recomputes `nextRunAt` only in POST /schedules/:id/pause and /resume, so
      // changing either through generic PATCH would leave the next run wrong.
      editable: [
        { name: "nameJson", type: "json" },
        { name: "timezone", type: "text" },
        { name: "format", type: "select", options: ["xlsx", "pdf", "csv", "json"] },
        { name: "recipientsJson", type: "json" },
        { name: "paramsJson", type: "json" }
      ],
      // Which is what these two are for: the API recomputes `nextRunAt` on the
      // way through, so pausing is a verb the record offers, not a column.
      actions: [
        {
          intent: "pause",
          method: "POST",
          path: "/{id}/pause",
          labelKey: "schedules.pause",
          permission: "analytics:schedules:write"
        },
        {
          intent: "resume",
          method: "POST",
          path: "/{id}/resume",
          labelKey: "schedules.resume",
          permission: "analytics:schedules:write"
        }
      ]
    },
    {
      key: "saved-views",
      api: "/v1/analytics/saved-views",
      read: "analytics:saved_views:read",
      create: "analytics:saved_views:write",
      remove: "analytics:saved_views:write",
      columns: [
        { name: "name", type: "text", sortable: true },
        { name: "route", type: "text" },
        { name: "queryJson", type: "json" },
        { name: "columnsJson", type: "json" },
        { name: "isDefault", type: "boolean" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      // `shared` is not a column: it decides whether the row is owned by you or
      // by the tenant (userId null), which is why it only appears on create.
      fields: [
        { name: "route", type: "text", required: true },
        { name: "name", type: "text", required: true },
        { name: "query", type: "json", required: true },
        { name: "columns", type: "json" },
        { name: "isDefault", type: "boolean" },
        { name: "shared", type: "boolean" }
      ]
    },
    {
      key: "unit-economics",
      api: "/v1/analytics/unit-economics",
      read: "analytics:reports:read",
      columns: [
        { name: "day", type: "text", sortable: true },
        { name: "module", type: "text" },
        { name: "unit", type: "text" },
        { name: "volume", type: "number" },
        { name: "revenueMinor", type: "money", currencyFrom: "currency" },
        { name: "humanMinutes", type: "number" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "journey-events",
      api: "/v1/analytics/journey-events",
      read: "analytics:reports:read",
      sort: "ts",
      filters: [
        { name: "outcome", options: ["progressed", "completed", "abandoned", "failed"] }
      ],
      columns: [
        { name: "journeyId", type: "text", sortable: true },
        { name: "step", type: "text" },
        { name: "actorRef", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "outcome", type: "text", badge: true },
        { name: "durationMs", type: "number" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    }
  ],
  // Authoring a definition is the builder's job (see the header above); the
  // tools list is where the workspace hands the reader to it.
  links: [{ href: "/analytics/builder", labelKey: "buildReport", permission: "analytics:reports:run" }]
};
