import type { WorkspaceSpec } from "./spec";

// SCOUT — product intelligence. The signal is the raw observation (docs/03
// §SCOUT); everything else on this workspace is either what clustering made of
// signals (clusters, whitespace, panel benchmarks) or what the business did
// about them (experiments, data products).

export const scout: WorkspaceSpec = {
  path: "/scout",
  labels: {
    en: {
      import: "Import",
      signals: "Signals",
      clusters: "Clusters",
      whitespaces: "Whitespace",
      "panel-bench": "Panel benchmarks",
      "scout-experiments": "Experiments",
      "data-products": "Data products",

      source: "Source",
      sourceRef: "Source reference",
      clusterId: "Cluster",
      weight: "Weight",
      observedAt: "Observed",
      payloadJson: "Payload",
      theme: "Theme",
      summary: "Summary",
      momentumScore: "Momentum",
      size: "Signals",
      lastSeen: "Last seen",
      description: "Opportunity",
      evidenceRefsJson: "Evidence",
      demandEstimate: "Estimated demand",
      competitionScore: "Competition",
      status: "Status",
      promotedAt: "Promoted",
      owner: "Owner",
      providerId: "Provider",
      line: "Line",
      period: "Period",
      ourPriceIdx: "Our price index",
      marketPriceIdx: "Market price index",
      winRate: "Win rate",
      volume: "Volume",
      whitespaceId: "Whitespace",
      landingRef: "Landing page",
      trafficPlanJson: "Traffic plan",
      resultsJson: "Results",
      state: "State",
      startedAt: "Started",
      concludedAt: "Concluded",
      name: "Name",
      definitionJson: "Definition",
      consentBasis: "Consent basis",
      aggregationMin: "Aggregation floor",
      subscribersJson: "Subscribers",
      delivery: "Delivery",

      search: "Search demand",
      quotes: "Quote flow",
      abandonment: "Abandonment",
      reviews: "Reviews",
      news: "News",
      regulatory: "Regulatory",
      candidate: "Candidate",
      validating: "Validating",
      validated: "Validated",
      parked: "Parked",
      draft: "Draft",
      running: "Running",
      concluded: "Concluded",
      abandoned: "Abandoned",
      api: "API",
      report: "Report",
      "link.radar": "Opportunity radar",
      "link.panel": "Panel benchmarks",
      "link.pricing": "Price benchmarks",
      "link.experiments": "Experiments",
      "link.analytics": "Pricing analytics",
      "link.dataProducts": "Data products",
      "link.admin": "Settings",
      "link.dev": "For integrators"
    },
    ar: {
      import: "استيراد",
      signals: "الإشارات",
      clusters: "المجموعات",
      whitespaces: "الفجوات السوقية",
      "panel-bench": "مقارنة المزودين",
      "scout-experiments": "التجارب",
      "data-products": "منتجات البيانات",

      source: "المصدر",
      sourceRef: "مرجع المصدر",
      clusterId: "المجموعة",
      weight: "الوزن",
      observedAt: "تاريخ الرصد",
      payloadJson: "المحتوى",
      theme: "الموضوع",
      summary: "الملخص",
      momentumScore: "مؤشر الزخم",
      size: "عدد الإشارات",
      lastSeen: "آخر ظهور",
      description: "الفرصة",
      evidenceRefsJson: "الأدلة",
      demandEstimate: "الطلب المقدّر",
      competitionScore: "مؤشر المنافسة",
      status: "الحالة",
      promotedAt: "تاريخ الترقية",
      owner: "المسؤول",
      providerId: "المزود",
      line: "خط المنتج",
      period: "الفترة",
      ourPriceIdx: "مؤشر سعرنا",
      marketPriceIdx: "مؤشر سعر السوق",
      winRate: "نسبة الفوز",
      volume: "الكمية",
      whitespaceId: "الفجوة",
      landingRef: "صفحة الهبوط",
      trafficPlanJson: "خطة الزيارات",
      resultsJson: "النتائج",
      state: "الوضع",
      startedAt: "تاريخ البدء",
      concludedAt: "تاريخ الانتهاء",
      name: "الاسم",
      definitionJson: "التعريف",
      consentBasis: "أساس الموافقة",
      aggregationMin: "الحد الأدنى للتجميع",
      subscribersJson: "المشتركون",
      delivery: "طريقة التسليم",

      search: "الطلب عبر البحث",
      quotes: "مسار عروض الأسعار",
      abandonment: "التخلي عن الطلب",
      reviews: "المراجعات",
      news: "الأخبار",
      regulatory: "تنظيمي",
      candidate: "مرشّح",
      validating: "قيد التحقق",
      validated: "تم التحقق",
      parked: "مؤجّل",
      draft: "مسودة",
      running: "قيد التشغيل",
      concluded: "منتهية",
      abandoned: "متروكة",
      api: "واجهة برمجية",
      report: "تقرير",
      "link.radar": "رادار الفرص",
      "link.panel": "مقارنة المزودين",
      "link.pricing": "مقارنة الأسعار",
      "link.experiments": "التجارب",
      "link.analytics": "تحليلات التسعير",
      "link.dataProducts": "المنتجات المعرفية",
      "link.admin": "الإعدادات",
      "link.dev": "للمطوِّرين"
    }
  },
  links: [
    { href: "/scout/radar", labelKey: "link.radar", permission: "scout:clusters:read" },
    { href: "/scout/panel", labelKey: "link.panel", permission: "scout:panel_bench:read" },
    { href: "/scout/pricing", labelKey: "link.pricing", permission: "scout:panel_bench:read" },
    { href: "/scout/experiments", labelKey: "link.experiments", permission: "scout:experiments:read" },
    { href: "/scout/analytics", labelKey: "link.analytics", permission: "scout:panel_bench:read" },
    { href: "/scout/data-products", labelKey: "link.dataProducts", permission: "scout:data_products:read" },
    // F58: was scout:whitespaces:write — a permission that does not exist in
    // the RBAC vocabulary (only :read and :promote), so the link was dead for
    // every role. The screen's primary data is signal-source health.
    { href: "/scout/admin", labelKey: "link.admin", permission: "scout:signals:read" },
    { href: "/scout/dev", labelKey: "link.dev", permission: "scout:signals:read" }
  ],
  tabs: [
    {
      key: "signals",
      api: "/v1/scout/signals",
      read: "scout:signals:read",
      // Signals are appended, never edited — a corrected observation is a new
      // one, so `ingest` buys create and nothing else.
      create: "scout:signals:ingest",
      // @accept:SA: a tenant with SCOUT alone brings its market by file.
      import: { api: "/v1/scout/signals/import", permission: "scout:signals:ingest", required: ["source", "sourceRef", "observedAt"] },
      sort: "observedAt",
      filters: [
        {
          name: "source",
          options: ["search", "quotes", "abandonment", "reviews", "news", "regulatory"]
        }
      ],
      columns: [
        { name: "source", type: "text" },
        { name: "sourceRef", type: "text" },
        { name: "clusterId", type: "text" },
        { name: "weight", type: "number" },
        { name: "observedAt", type: "datetime", sortable: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        {
          name: "source",
          type: "select",
          required: true,
          options: ["search", "quotes", "abandonment", "reviews", "news", "regulatory"]
        },
        { name: "sourceRef", type: "text" },
        { name: "payloadJson", type: "json", required: true },
        { name: "weight", type: "number" },
        { name: "observedAt", type: "datetime", required: true }
      ]
    },
    {
      key: "clusters",
      api: "/v1/scout/clusters",
      read: "scout:clusters:read",
      // Clustering writes these rows; there is no createdAt to fall back on,
      // and momentum is what the radar quadrant is ordered by anyway.
      sort: "momentumScore",
      order: "desc",
      columns: [
        { name: "theme", type: "text" },
        { name: "summary", type: "text" },
        { name: "momentumScore", type: "number", sortable: true },
        { name: "size", type: "number" },
        { name: "lastSeen", type: "datetime", sortable: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "whitespaces",
      api: "/v1/scout/whitespaces",
      read: "scout:whitespaces:read",
      // No create: whitespace is derived from clusters. A human promotes it,
      // which is the only write the API offers.
      update: "scout:whitespaces:promote",
      sort: "demandEstimate",
      order: "desc",
      filters: [
        { name: "status", options: ["candidate", "validating", "validated", "parked"] }
      ],
      columns: [
        { name: "description", type: "text" },
        { name: "clusterId", type: "text" },
        // The clusters and signals the estimate rests on: a promotion decision
        // without them is a number nobody can argue with.
        { name: "evidenceRefsJson", type: "json" },
        { name: "demandEstimate", type: "number", sortable: true },
        { name: "competitionScore", type: "number" },
        { name: "status", type: "text", badge: true },
        { name: "owner", type: "text" },
        { name: "promotedAt", type: "datetime" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      // `promote` is a generic PATCH here (no bespoke route in the API), so the
      // stamp has to be settable or the promotion has no date.
      editable: [
        {
          name: "status",
          type: "select",
          options: ["candidate", "validating", "validated", "parked"]
        },
        { name: "owner", type: "text" },
        { name: "promotedAt", type: "datetime" }
      ]
    },
    {
      key: "panel-bench",
      api: "/v1/scout/panel-bench",
      read: "scout:panel_bench:read",
      sort: "period",
      order: "desc",
      columns: [
        { name: "providerId", type: "text" },
        { name: "line", type: "text" },
        { name: "period", type: "text", sortable: true },
        { name: "ourPriceIdx", type: "number" },
        { name: "marketPriceIdx", type: "number" },
        { name: "winRate", type: "number" },
        { name: "volume", type: "number" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "scout-experiments",
      api: "/v1/scout/scout-experiments",
      read: "scout:experiments:read",
      create: "scout:experiments:create",
      // Concluding an experiment is a decision, not an edit: `decide` is the
      // permission behind every field on this form.
      update: "scout:experiments:decide",
      filters: [{ name: "state", options: ["draft", "running", "concluded", "abandoned"] }],
      columns: [
        { name: "whitespaceId", type: "text" },
        { name: "landingRef", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "startedAt", type: "datetime", sortable: true },
        { name: "concludedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "whitespaceId", type: "text", required: true },
        { name: "landingRef", type: "text" },
        { name: "trafficPlanJson", type: "json" }
      ],
      editable: [
        {
          name: "state",
          type: "select",
          options: ["draft", "running", "concluded", "abandoned"]
        },
        { name: "startedAt", type: "datetime" },
        { name: "concludedAt", type: "datetime" },
        { name: "resultsJson", type: "json" }
      ]
    },
    {
      key: "data-products",
      api: "/v1/scout/data-products",
      read: "scout:data_products:read",
      create: "scout:data_products:create",
      update: "scout:data_products:publish",
      filters: [{ name: "delivery", options: ["api", "report"] }],
      columns: [
        { name: "name", type: "text" },
        { name: "consentBasis", type: "text" },
        { name: "aggregationMin", type: "number" },
        { name: "delivery", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "name", type: "text", required: true },
        { name: "definitionJson", type: "json", required: true },
        // Selling aggregate insight without a recorded basis is the one thing
        // this table exists to prevent (docs/modules/scout §consent).
        { name: "consentBasis", type: "text", required: true },
        { name: "aggregationMin", type: "number", required: true },
        { name: "delivery", type: "select", options: ["api", "report"] }
      ],
      editable: [
        { name: "status", type: "text" },
        { name: "aggregationMin", type: "number" },
        { name: "delivery", type: "select", options: ["api", "report"] },
        { name: "subscribersJson", type: "json" }
      ]
    }
  ]
};
