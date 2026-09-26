import type { WorkspaceSpec } from "./spec";

// SIGNAL — demand (docs/03 §SIGNAL). The campaign is the unit of spend: an
// audience is who it reaches, creatives are what it says, experiments are what
// it is still deciding. Budget moves, attribution and spend are the ledger of
// what the autopilot and the ad platforms actually did, so they are read-only.

export const signal: WorkspaceSpec = {
  path: "/signal",
  // The bespoke screens: a read across the ledgers (cockpit, growth, audience
  // value, answer engines) or a write the tabs cannot express (the studio makes
  // a campaign and its content, budget sets the bounds the autopilot works in).
  // Permissions are the ones each screen's own loader checks first, so a link
  // that renders is a screen that opens.
  links: [
    { href: "/signal/cockpit", labelKey: "link.cockpit", permission: "signal:spend:read" },
    { href: "/signal/studio", labelKey: "link.studio", permission: "signal:campaigns:read" },
    { href: "/signal/audience-value", labelKey: "link.audience-value", permission: "signal:audiences:read" },
    { href: "/signal/answer-engines", labelKey: "link.answer-engines", permission: "signal:aeo:read" },
    { href: "/signal/experiments", labelKey: "link.experiments", permission: "signal:experiments:read" },
    { href: "/signal/budget", labelKey: "link.budget", permission: "signal:budget_moves:read" },
    { href: "/signal/analytics", labelKey: "link.analytics", permission: "signal:spend:read" },
    { href: "/signal/admin", labelKey: "link.admin", permission: "signal:campaigns:read" },
    { href: "/signal/dev", labelKey: "link.dev", permission: "signal:spend:read" }
  ],
  labels: {
    en: {
      audiences: "Audiences",
      campaigns: "Campaigns",
      creatives: "Creatives",
      "signal-experiments": "Experiments",
      "budget-moves": "Budget moves",
      "aeo-pages": "Answer pages",
      "attribution-events": "Attribution",
      spend: "Spend",
      prospects: "Prospects",
      responses: "Responses",
      score: "Score",
      evidenceJson: "Why",
      sourceRef: "From",
      outreachId: "Send",
      quote_expired: "Quote expired",
      churn_risk: "Churn risk",
      no_policy: "No cover yet",
      open: "Open",
      contacted: "Contacted",
      responded: "Responded",
      converted: "Converted",
      suppressed: "Suppressed",
      delivered: "Delivered",
      read: "Read",
      replied: "Replied",
      opted_out: "Opted out",

      name: "Name",
      sizeCached: "Size",
      refreshPolicy: "Refresh",
      consentPurposes: "Consent purposes",
      lastRefreshedAt: "Last refreshed",
      definitionJson: "Definition",
      objective: "Objective",
      "objective.acq": "Acquisition",
      "objective.renewal": "Renewal",
      "objective.xsell": "Cross-sell",
      state: "State",
      autonomyLevel: "Autonomy",
      ownerRef: "Owner",
      startAt: "Starts",
      endAt: "Ends",
      audienceId: "Audience",
      channelsJson: "Channels",
      budgetJson: "Budget",
      contentRef: "Content",
      campaignId: "Campaign",
      kind: "Kind",
      locale: "Language",
      variantGroup: "Variant group",
      complianceStatus: "Compliance",
      complianceNotesJson: "Compliance notes",
      performanceJson: "Performance",
      generatedBy: "Made by",
      hypothesis: "Hypothesis",
      metric: "Metric",
      minSample: "Minimum sample",
      concludedAt: "Concluded",
      variantsJson: "Variants",
      resultJson: "Result",
      reason: "Reason",
      fromRef: "From",
      toRef: "To",
      amountMinor: "Amount",
      currency: "Currency",
      approvedBy: "Approved by",
      reversibleUntil: "Reversible until",
      reversedBy: "Reversed by",
      reversedAt: "Reversed",
      ts: "When",
      queryCluster: "Query cluster",
      status: "Status",
      freshness: "Last verified",
      citationsCheckJson: "Citation check",
      subjectRef: "Subject",
      customerId: "Customer",
      touchType: "Touch",
      channel: "Channel",
      valueMinor: "Value",
      day: "Day",
      impressions: "Impressions",
      clicks: "Clicks",
      conversions: "Conversions",
      source: "Source",

      manual: "Manual",
      hourly: "Hourly",
      daily: "Daily",
      acq: "Acquisition",
      renewal: "Renewal",
      xsell: "Cross-sell",
      draft: "Draft",
      review: "In review",
      scheduled: "Scheduled",
      live: "Live",
      paused: "Paused",
      ended: "Ended",
      ad: "Ad",
      lp: "Landing page",
      email: "Email",
      social: "Social",
      video_script: "Video script",
      pending: "Pending",
      passed: "Passed",
      flagged: "Flagged",
      blocked: "Blocked",
      human: "Human",
      ai: "AI",
      running: "Running",
      concluded: "Concluded",
      abandoned: "Abandoned",
      published: "Published",
      stale: "Stale",
      retired: "Retired",
      impression: "Impression",
      click: "Click",
      visit: "Visit",
      lead: "Lead",
      bind: "Bind",
      api: "API",
      import: "Import",

      "link.cockpit": "Growth cockpit",
      "link.studio": "Campaign studio",
      "link.audience-value": "Audiences and value",
      "link.answer-engines": "Answer engines",
      "link.experiments": "Experiments",
      "link.budget": "Budget and bounds",
      "link.analytics": "Growth analytics",
      "link.admin": "Marketing admin",
      "link.dev": "Developer bench"
    },
    ar: {
      audiences: "الجماهير",
      campaigns: "الحملات",
      creatives: "المواد الإبداعية",
      "signal-experiments": "التجارب",
      "budget-moves": "تحويلات الميزانية",
      "aeo-pages": "صفحات الإجابات",
      "attribution-events": "الإسناد",
      spend: "الإنفاق",
      prospects: "العملاء المرتقبون",
      responses: "الاستجابات",
      score: "الدرجة",
      evidenceJson: "السبب",
      sourceRef: "المصدر",
      outreachId: "الرسالة",
      quote_expired: "انتهى عرض السعر",
      churn_risk: "خطر عدم التجديد",
      no_policy: "لا تغطية بعد",
      open: "مفتوح",
      contacted: "تم التواصل",
      responded: "استجاب",
      converted: "تحوّل",
      suppressed: "محجوب",
      delivered: "وصلت",
      read: "قُرئت",
      replied: "رد",
      opted_out: "ألغى الاشتراك",

      name: "الاسم",
      sizeCached: "الحجم",
      refreshPolicy: "التحديث",
      consentPurposes: "أغراض الموافقة",
      lastRefreshedAt: "آخر تحديث",
      definitionJson: "التعريف",
      objective: "الهدف",
      "objective.acq": "اكتساب",
      "objective.renewal": "تجديد",
      "objective.xsell": "بيع تكميلي",
      state: "الوضع",
      autonomyLevel: "الاستقلالية",
      ownerRef: "المسؤول",
      startAt: "يبدأ",
      endAt: "ينتهي",
      audienceId: "الجمهور",
      channelsJson: "القنوات",
      budgetJson: "الميزانية",
      contentRef: "المحتوى",
      campaignId: "الحملة",
      kind: "النوع",
      locale: "اللغة",
      variantGroup: "مجموعة النسخ",
      complianceStatus: "الامتثال",
      complianceNotesJson: "ملاحظات الامتثال",
      performanceJson: "الأداء",
      generatedBy: "مصدر الإنشاء",
      hypothesis: "الفرضية",
      metric: "المقياس",
      minSample: "أقل عينة",
      concludedAt: "تاريخ الاختتام",
      variantsJson: "النسخ",
      resultJson: "النتيجة",
      reason: "السبب",
      fromRef: "من",
      toRef: "إلى",
      amountMinor: "المبلغ",
      currency: "العملة",
      approvedBy: "اعتمده",
      reversibleUntil: "قابل للعكس حتى",
      reversedBy: "عكسه",
      reversedAt: "تاريخ العكس",
      ts: "الوقت",
      queryCluster: "مجموعة الاستعلامات",
      status: "الحالة",
      freshness: "آخر تحقق",
      citationsCheckJson: "فحص المصادر",
      subjectRef: "الموضوع",
      customerId: "العميل",
      touchType: "نوع التفاعل",
      channel: "القناة",
      valueMinor: "القيمة",
      day: "اليوم",
      impressions: "مرات الظهور",
      clicks: "النقرات",
      conversions: "التحويلات",
      source: "المصدر",

      manual: "يدوي",
      hourly: "كل ساعة",
      daily: "يومي",
      acq: "اكتساب",
      renewal: "تجديد",
      xsell: "بيع تكميلي",
      draft: "مسودة",
      review: "قيد المراجعة",
      scheduled: "مجدولة",
      live: "مباشرة",
      paused: "متوقفة مؤقتًا",
      ended: "منتهية",
      ad: "إعلان",
      lp: "صفحة هبوط",
      email: "بريد إلكتروني",
      social: "تواصل اجتماعي",
      video_script: "نص فيديو",
      pending: "قيد الفحص",
      passed: "مطابقة",
      flagged: "مُعلَّمة",
      blocked: "محظورة",
      human: "بشري",
      ai: "ذكاء اصطناعي",
      running: "قيد التنفيذ",
      concluded: "مُختتمة",
      abandoned: "متروكة",
      published: "منشورة",
      stale: "قديمة",
      retired: "مسحوبة",
      impression: "ظهور",
      click: "نقرة",
      visit: "زيارة",
      lead: "عميل محتمل",
      bind: "إصدار",
      api: "واجهة برمجية",
      import: "استيراد",

      "link.cockpit": "مركز قيادة النمو",
      "link.studio": "استوديو الحملات",
      "link.audience-value": "الجماهير والقيمة",
      "link.answer-engines": "محرّكات الإجابات",
      "link.experiments": "التجارب",
      "link.budget": "الميزانية والحدود",
      "link.analytics": "تحليلات النمو",
      "link.admin": "إدارة Marketing",
      "link.dev": "منصّة المطوّرين"
    }
  },
  tabs: [
    {
      key: "audiences",
      api: "/v1/signal/audiences",
      read: "signal:audiences:read",
      // One permission covers both writes: an audience is defined, then redefined.
      create: "signal:audiences:create",
      update: "signal:audiences:create",
      filters: [{ name: "refreshPolicy", options: ["manual", "hourly", "daily"] }],
      columns: [
        { name: "name", type: "text", sortable: true },
        { name: "sizeCached", type: "number" },
        { name: "refreshPolicy", type: "text", badge: true },
        { name: "consentPurposes", type: "text" },
        { name: "lastRefreshedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "name", type: "text", required: true },
        { name: "definitionJson", type: "json", required: true, editor: "audienceRule" },
        { name: "refreshPolicy", type: "select", options: ["manual", "hourly", "daily"] },
        { name: "consentPurposes", type: "text" }
      ],
      editable: [
        { name: "definitionJson", type: "json", editor: "audienceRule" },
        { name: "refreshPolicy", type: "select", options: ["manual", "hourly", "daily"] },
        { name: "consentPurposes", type: "text" }
      ]
    },
    {
      key: "campaigns",
      api: "/v1/signal/campaigns",
      read: "signal:campaigns:read",
      create: "signal:campaigns:create",
      update: "signal:campaigns:update",
      search: true,
      sort: "startAt",
      filters: [
        {
          name: "state",
          options: ["draft", "review", "scheduled", "live", "paused", "ended"]
        },
        { name: "objective", options: ["acq", "renewal", "xsell"] }
      ],
      columns: [
        { name: "name", type: "text" },
        { name: "objective", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "autonomyLevel", type: "text", badge: true },
        { name: "ownerRef", type: "text" },
        { name: "startAt", type: "datetime", sortable: true },
        { name: "endAt", type: "datetime" }
      ],
      fields: [
        { name: "name", type: "text", required: true },
        {
          name: "objective",
          type: "select",
          required: true,
          options: ["acq", "renewal", "xsell"]
        },
        { name: "audienceId", type: "text" },
        { name: "channelsJson", type: "json", required: true },
        { name: "budgetJson", type: "json", required: true },
        { name: "ownerRef", type: "text", required: true },
        { name: "startAt", type: "datetime" },
        { name: "endAt", type: "datetime" }
      ],
      // Going live is consequential: the API routes the state change through the
      // `signal.campaign_launch` approval against the budget.
      editable: [
        {
          name: "state",
          type: "select",
          options: ["draft", "review", "scheduled", "live", "paused", "ended"]
        },
        { name: "budgetJson", type: "json" },
        { name: "startAt", type: "datetime" },
        { name: "endAt", type: "datetime" },
        { name: "ownerRef", type: "text" }
      ]
    },
    {
      key: "creatives",
      api: "/v1/signal/creatives",
      read: "signal:creatives:read",
      create: "signal:creatives:generate",
      update: "signal:creatives:approve",
      filters: [
        { name: "kind", options: ["ad", "lp", "email", "social", "video_script"] },
        { name: "complianceStatus", options: ["pending", "passed", "flagged", "blocked"] }
      ],
      columns: [
        { name: "contentRef", type: "text" },
        { name: "campaignId", type: "text" },
        { name: "kind", type: "text" },
        { name: "locale", type: "text" },
        // Which A/B arm this is, why compliance ruled the way it did, and how it
        // performed — a flagged creative with no note is an unappealable verdict.
        { name: "variantGroup", type: "text" },
        { name: "complianceStatus", type: "text", badge: true },
        { name: "complianceNotesJson", type: "json" },
        { name: "performanceJson", type: "json" },
        { name: "generatedBy", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        {
          name: "kind",
          type: "select",
          required: true,
          options: ["ad", "lp", "email", "social", "video_script"]
        },
        { name: "contentRef", type: "text", required: true },
        { name: "campaignId", type: "text" },
        { name: "locale", type: "text" }
      ],
      // The write permission is `approve`: compliance clears a creative, it does
      // not rewrite one (publishing carries `signal.creative_publish`). The note
      // is the verdict's reasoning, so it is written by the same hand and in the
      // same submit as the status. `performanceJson` stays read-only — the ad
      // platforms write it.
      editable: [
        {
          name: "complianceStatus",
          type: "select",
          options: ["pending", "passed", "flagged", "blocked"]
        },
        { name: "complianceNotesJson", type: "json" },
        { name: "contentRef", type: "text" }
      ]
    },
    {
      key: "signal-experiments",
      api: "/v1/signal/signal-experiments",
      read: "signal:experiments:read",
      create: "signal:experiments:create",
      update: "signal:experiments:decide",
      filters: [
        { name: "state", options: ["draft", "running", "concluded", "abandoned"] }
      ],
      columns: [
        { name: "hypothesis", type: "text" },
        { name: "campaignId", type: "text" },
        { name: "metric", type: "text" },
        { name: "minSample", type: "number" },
        { name: "state", type: "text", badge: true },
        { name: "concludedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "hypothesis", type: "textarea", required: true },
        { name: "campaignId", type: "text" },
        { name: "variantsJson", type: "json", required: true },
        { name: "metric", type: "text", required: true },
        { name: "minSample", type: "number" }
      ],
      editable: [
        { name: "state", type: "select", options: ["draft", "running", "concluded", "abandoned"] },
        { name: "resultJson", type: "json" },
        { name: "concludedAt", type: "datetime" }
      ]
    },
    {
      key: "budget-moves",
      api: "/v1/signal/budget-moves",
      read: "signal:budget_moves:read",
      // The autopilot ledger: every move is written by the runtime, and the only
      // thing a human does to one is reverse it inside `reversibleUntil`.
      update: "signal:budget_moves:approve",
      sort: "ts",
      columns: [
        { name: "reason", type: "text" },
        { name: "fromRef", type: "text" },
        { name: "toRef", type: "text" },
        { name: "amountMinor", type: "money", currencyFrom: "currency" },
        { name: "approvedBy", type: "text" },
        { name: "reversibleUntil", type: "datetime" },
        { name: "ts", type: "datetime", sortable: true }
      ],
      editable: [
        { name: "reversedBy", type: "text" },
        { name: "reversedAt", type: "datetime" }
      ]
    },
    {
      key: "aeo-pages",
      api: "/v1/signal/aeo-pages",
      read: "signal:aeo:read",
      create: "signal:aeo:write",
      update: "signal:aeo:write",
      remove: "signal:aeo:write",
      filters: [{ name: "status", options: ["draft", "published", "stale", "retired"] }],
      columns: [
        { name: "queryCluster", type: "text" },
        { name: "locale", type: "text" },
        { name: "contentRef", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "freshness", type: "datetime" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "queryCluster", type: "text", required: true },
        { name: "contentRef", type: "text", required: true },
        { name: "locale", type: "text" }
      ],
      editable: [
        { name: "status", type: "select", options: ["draft", "published", "stale", "retired"] },
        { name: "contentRef", type: "text" },
        { name: "citationsCheckJson", type: "json" }
      ]
    },
    {
      key: "attribution-events",
      api: "/v1/signal/attribution-events",
      read: "signal:attribution:read",
      // Touches, as they landed. Immutable in the API — the model reads them,
      // nobody edits them.
      sort: "ts",
      filters: [
        { name: "touchType", options: ["impression", "click", "visit", "lead", "bind"] }
      ],
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "customerId", type: "text" },
        { name: "touchType", type: "text", badge: true },
        { name: "channel", type: "text" },
        { name: "campaignId", type: "text" },
        { name: "valueMinor", type: "money", currencyFrom: "currency" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      // ADR-0091: identified people other modules told SIGNAL about. Written by
      // events only; a prospect is a reason to talk, never permission to.
      key: "prospects",
      api: "/v1/signal/prospects",
      read: "signal:audiences:read",
      sort: "updatedAt",
      filters: [
        { name: "reason", options: ["quote_expired", "no_policy", "churn_risk"] },
        { name: "state", options: ["open", "contacted", "responded", "converted", "suppressed"] }
      ],
      columns: [
        { name: "customerId", type: "text" },
        { name: "reason", type: "text", badge: true },
        { name: "score", type: "number", sortable: true },
        { name: "state", type: "text", badge: true },
        { name: "evidenceJson", type: "json" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ]
    },
    {
      // What came back from sends; each row carries campaign, audience and
      // person, so the cockpit rolls it up at all three scales.
      key: "responses",
      api: "/v1/signal/responses",
      read: "signal:campaigns:read",
      sort: "ts",
      filters: [{ name: "kind", options: ["lead", "delivered", "read", "replied", "bind", "opted_out"] }],
      columns: [
        { name: "campaignId", type: "text" },
        { name: "audienceId", type: "text" },
        { name: "customerId", type: "text" },
        { name: "kind", type: "text", badge: true },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "spend",
      api: "/v1/signal/spend",
      read: "signal:spend:read",
      // Actuals per channel per day, imported from the ad platforms. There is no
      // createdAt on this table: `day` is the identity and the sort, and `ts` is
      // when the import landed — which is how you tell yesterday's restated row
      // from the one nobody has refreshed since.
      sort: "day",
      filters: [{ name: "source", options: ["manual", "api", "import"] }],
      columns: [
        { name: "day", type: "text", sortable: true },
        { name: "channel", type: "text" },
        { name: "campaignId", type: "text" },
        { name: "amountMinor", type: "money", currencyFrom: "currency" },
        { name: "impressions", type: "number" },
        { name: "clicks", type: "number" },
        { name: "conversions", type: "number" },
        { name: "source", type: "text", badge: true },
        { name: "ts", type: "datetime", sortable: true }
      ],
      create: "signal:spend:write",
      update: "signal:spend:write",
      fields: [
        { name: "day", type: "text", required: true },
        { name: "channel", type: "text", required: true },
        { name: "campaignId", type: "text" },
        { name: "amountMinor", type: "money", required: true },
        { name: "currency", type: "text", required: true },
        { name: "impressions", type: "number" },
        { name: "clicks", type: "number" },
        { name: "conversions", type: "number" }
      ],
      editable: [
        { name: "amountMinor", type: "money" },
        { name: "impressions", type: "number" },
        { name: "clicks", type: "number" },
        { name: "conversions", type: "number" }
      ],
      // docs/30 SIGNAL gap 1: an ad-platform export, per-line honest.
      import: { api: "/v1/signal/spend/import", permission: "signal:spend:write", required: ["day", "channel", "amountMinor", "currency"] }
    }
  ]
};
