import type { WorkspaceSpec } from "./spec";

// ORBIT — the customer side (docs/03 §ORBIT). The conversation is the unit:
// renewals, journeys and handover notes are what a relationship needs between
// conversations, and partners are the conversations somebody else is having on
// our behalf. Messages and journey runs are written by the runtime, never here.

export const orbit: WorkspaceSpec = {
  path: "/orbit",
  labels: {
    en: {
      conversations: "Conversations",
      "link.onboarding": "Onboarding checklist",
      thread: "Open thread",
      builder: "Open builder",
      "link.console": "Live console",
      "link.supervisor": "Supervisor wall",
      "link.save": "Save desk",
      "link.pipeline": "Renewal pipeline",
      "link.quality": "Conversation quality",
      "link.analytics": "Customer analytics",
      "link.admin": "ORBIT admin",
      "link.dev": "Developer tools",
      messages: "Messages",
      renewals: "Renewals",
      journeys: "Journeys",
      "journey-runs": "Journey runs",
      partners: "Partners",
      "partner-txns": "Partner transactions",
      "handover-notes": "Handover notes",
      "qa-scores": "Quality scores",
      "channel-connectors": "Channels",
      teams: "Teams",
      "team-members": "Team members",
      "routing-rules": "Routing rules",
      "sla-policies": "SLA policies",
      "agent-presence": "Agent presence",
      "kb-articles": "Knowledge base",
      macros: "Canned replies",
      deflections: "Self-service answers",

      title: "Title",
      body: "Answer",
      "body.hint": "This is sent to the customer word for word, so write it as the answer and not as a note to a colleague.",
      locale: "Language",
      tagsJson: "Tags",
      vectorId: "Search index id",
      updatedBy: "Updated by",
      bodyJson: "Wording",
      "bodyJson.hint": "One wording per language, keyed en and ar. A conversation in a language with no wording falls back to English.",
      category: "Category",
      articleId: "Article",
      usageCount: "Times used",
      question: "Question asked",
      outcome: "Outcome",
      via: "Found by",
      published: "Published",
      deflected: "Answered",
      escalated: "Passed to a person",
      vector: "Meaning match",
      lexical: "Word match",

      externalRef: "External reference",
      customerId: "Customer",
      channel: "Channel",
      state: "State",
      assigneeRef: "Assignee",
      teamId: "Team",
      csat: "Satisfaction",
      summary: "Summary",
      lang: "Language",
      intent: "Intent",
      sentiment: "Sentiment",
      firstResponseMs: "First response",
      closedAt: "Closed",
      lastMessageAt: "Last message",
      conversationId: "Conversation",
      content: "Message",
      role: "Sender",
      modality: "Modality",
      attachmentsJson: "Attachments",
      deliveryStatus: "Delivery",
      ts: "When",
      policyRef: "Policy reference",
      expiryAt: "Expires",
      churnScore: "Churn risk",
      strategy: "Strategy",
      requotesJson: "Re-quotes",
      offeredAt: "Offered",
      decidedAt: "Decided",
      outcomeReason: "Outcome reason",
      ownerRef: "Owner",
      key: "Key",
      version: "Version",
      status: "Status",
      createdBy: "Created by",
      nameJson: "Name",
      graphJson: "Graph",
      journeyId: "Journey",
      node: "Node",
      nextAt: "Next step",
      name: "Name",
      kind: "Kind",
      sandboxFlag: "Sandbox",
      revshareJson: "Revenue share",
      contactJson: "Contact",
      txnRef: "Transaction reference",
      partnerId: "Partner",
      amountMinor: "Amount",
      currency: "Currency",
      revshareCalcMinor: "Partner share",
      settlementBatch: "Settlement batch",
      fromRef: "From",
      toRef: "To",
      generatedBy: "Written by",
      acceptedBy: "Accepted by",
      factsJson: "Facts",
      rubricKey: "Rubric",
      score: "Score",
      scoredBy: "Scored by",
      disputedBy: "Disputed by",
      breakdownJson: "Breakdown",
      flagsJson: "Flags",
      stage: "Onboarding stage",
      country: "Country",
      riskRating: "Risk rating",
      legalName: "Legal name",
      goLiveAt: "Went live",
      suspendedAt: "Suspended",

      whatsapp: "WhatsApp",
      web: "Web",
      voice: "Voice",
      email: "Email",
      agent: "Agent",
      bot: "Bot",
      human: "Human",
      closed: "Closed",
      customer: "Customer",
      agent_ai: "AI agent",
      agent_human: "Human agent",
      system: "System",
      queued: "Queued",
      sent: "Sent",
      delivered: "Delivered",
      read: "Read",
      failed: "Failed",
      scheduled: "Scheduled",
      offered: "Offered",
      accepted: "Accepted",
      lost: "Lost",
      auto_requote: "Auto re-quote",
      do_not_contact: "Do not contact",
      draft: "Draft",
      active: "Active",
      paused: "Paused",
      retired: "Retired",
      running: "Running",
      waiting: "Waiting",
      done: "Done",
      halted: "Halted",
      telco: "Telco",
      auto: "Motor",
      superapp: "Super app",
      bank: "Bank",
      quote: "Quote",
      bind: "Bind",
      refund: "Refund",
      ai: "AI",
      // The partner ladder, as STAGES spells it in apps/api/src/engines/onboarding.ts.
      prospect: "Prospect",
      applied: "Applied",
      screening: "Screening",
      diligence: "Diligence",
      agreement: "Agreement",
      integration: "Integration",
      sandbox: "Sandbox",
      live: "Live",
      suspended: "Suspended",
      terminated: "Terminated",
      // The onboarding checklist's one-line summary under the title.
      onboardingNoSteps: "This checklist has no required steps.",
      onboardingProgress: "{done} of {total} required steps cleared.",
      onboardingProgressStage: "{done} of {total} required steps cleared toward {stage}.",
      "riskRating.low": "Low",
      "riskRating.medium": "Medium",
      "riskRating.high": "High",

      createdAt: "Created",
      updatedAt: "Updated",
      provider: "Provider",
      transport: "Carries",
      label: "Name",
      configJson: "Settings",
      secretsJson: "Credentials",
      "secretsJson.hint": "One JSON object of provider secrets. Stored sealed and never shown again.",
      "provider.whatsapp-cloud-api": "WhatsApp Cloud API",
      "provider.mailgun-email": "Mailgun",
      isDefault: "Default team",
      "isDefault.hint": "Where a conversation lands when no routing rule matches.",
      userId: "Person",
      skillsJson: "Skills",
      "skillsJson.hint": "A JSON list of skill tags, e.g. [\"arabic\", \"claims\"].",
      maxConcurrent: "Concurrent limit",
      "maxConcurrent.hint": "How many conversations this person may hold at once.",
      activeCount: "Open now",
      seq: "Order",
      "seq.hint": "Rules are read in this order and the first match wins.",
      enabled: "Enabled",
      conditionsJson: "Conditions",
      "conditionsJson.hint": "A JSON object of channel, intent and sentimentBelow. Empty matches everything.",
      frtMinutes: "First reply target",
      "frtMinutes.hint": "Minutes allowed before the first human or AI reply.",
      resolutionMinutes: "Resolution target",
      disabled: "Disabled",
      available: "Available",
      away: "Away",
      offline: "Offline"
    },
    ar: {
      conversations: "المحادثات",
      "link.onboarding": "قائمة مهام التهيئة",
      thread: "فتح المحادثة",
      builder: "فتح المحرّر",
      "link.console": "لوحة المحادثات الحية",
      "link.supervisor": "لوحة المشرف",
      "link.save": "مكتب الاستبقاء",
      "link.pipeline": "خط التجديدات",
      "link.quality": "جودة المحادثات",
      "link.analytics": "تحليلات العملاء",
      "link.admin": "إدارة ORBIT",
      "link.dev": "أدوات المطوّرين",
      messages: "الرسائل",
      renewals: "التجديدات",
      journeys: "الرحلات",
      "journey-runs": "مسارات الرحلة",
      partners: "الشركاء",
      "partner-txns": "معاملات الشركاء",
      "handover-notes": "ملاحظات التسليم",
      "qa-scores": "درجات الجودة",
      "channel-connectors": "القنوات",
      teams: "الفرق",
      "team-members": "أعضاء الفريق",
      "routing-rules": "قواعد التوجيه",
      "sla-policies": "سياسات مستوى الخدمة",
      "agent-presence": "حضور الوكلاء",
      "kb-articles": "قاعدة المعرفة",
      macros: "الردود الجاهزة",
      deflections: "الإجابات الذاتية",

      title: "العنوان",
      body: "الإجابة",
      "body.hint": "تُرسل هذه الإجابة إلى العميل كما هي، فاكتبها كإجابة لا كملاحظة لزميل.",
      locale: "اللغة",
      tagsJson: "الوسوم",
      vectorId: "معرّف فهرس البحث",
      updatedBy: "حدّثها",
      bodyJson: "الصياغة",
      "bodyJson.hint": "صياغة واحدة لكل لغة بمفتاحي en و ar. المحادثة بلغة لا صياغة لها تعود إلى الإنجليزية.",
      category: "الفئة",
      articleId: "المقالة",
      usageCount: "مرات الاستخدام",
      question: "السؤال المطروح",
      outcome: "النتيجة",
      via: "طريقة الإيجاد",
      published: "منشورة",
      deflected: "أُجيب عنه",
      escalated: "أُحيل إلى موظف",
      vector: "تطابق المعنى",
      lexical: "تطابق الكلمات",

      externalRef: "المرجع الخارجي",
      customerId: "العميل",
      channel: "القناة",
      state: "الوضع",
      assigneeRef: "المكلف",
      teamId: "الفريق",
      csat: "رضا العميل",
      summary: "الملخص",
      lang: "اللغة",
      intent: "القصد",
      sentiment: "المشاعر",
      firstResponseMs: "زمن أول رد",
      closedAt: "تاريخ الإغلاق",
      lastMessageAt: "آخر رسالة",
      conversationId: "المحادثة",
      content: "الرسالة",
      role: "المرسل",
      modality: "الوسيط",
      attachmentsJson: "المرفقات",
      deliveryStatus: "التسليم",
      ts: "الوقت",
      policyRef: "مرجع الوثيقة",
      expiryAt: "تاريخ الانتهاء",
      churnScore: "احتمال الفقد",
      strategy: "الاستراتيجية",
      requotesJson: "عروض إعادة التسعير",
      offeredAt: "تاريخ العرض",
      decidedAt: "تاريخ القرار",
      outcomeReason: "سبب النتيجة",
      ownerRef: "المسؤول",
      key: "المفتاح",
      version: "الإصدار",
      status: "الحالة",
      createdBy: "أنشأه",
      nameJson: "الاسم",
      graphJson: "المخطط",
      journeyId: "الرحلة",
      node: "العقدة",
      nextAt: "الخطوة التالية",
      name: "الاسم",
      kind: "النوع",
      sandboxFlag: "بيئة اختبار",
      revshareJson: "تقاسم الإيرادات",
      contactJson: "جهة الاتصال",
      txnRef: "مرجع المعاملة",
      partnerId: "الشريك",
      amountMinor: "المبلغ",
      currency: "العملة",
      revshareCalcMinor: "حصة الشريك",
      settlementBatch: "دفعة التسوية",
      fromRef: "من",
      toRef: "إلى",
      generatedBy: "مصدر الكتابة",
      acceptedBy: "قبِلها",
      factsJson: "الحقائق",
      rubricKey: "معيار التقييم",
      score: "الدرجة",
      scoredBy: "قام بالتقييم",
      disputedBy: "اعترض عليها",
      breakdownJson: "تفصيل الدرجة",
      flagsJson: "التنبيهات",
      stage: "مرحلة التهيئة",
      country: "الدولة",
      riskRating: "تصنيف المخاطر",
      legalName: "الاسم القانوني",
      goLiveAt: "تاريخ التشغيل",
      suspendedAt: "تاريخ الإيقاف",

      whatsapp: "واتساب",
      web: "الويب",
      voice: "صوت",
      email: "البريد الإلكتروني",
      agent: "وكيل",
      bot: "آلي",
      human: "بشري",
      closed: "مغلقة",
      customer: "عميل",
      agent_ai: "وكيل ذكاء اصطناعي",
      agent_human: "وكيل بشري",
      system: "النظام",
      queued: "في قائمة الانتظار",
      sent: "أُرسلت",
      delivered: "وصلت",
      read: "مقروءة",
      failed: "فشلت",
      scheduled: "مجدول",
      offered: "معروض",
      accepted: "مقبول",
      lost: "خسارة",
      auto_requote: "تسعير تلقائي",
      do_not_contact: "عدم التواصل",
      draft: "مسودة",
      active: "نشطة",
      paused: "متوقفة مؤقتًا",
      retired: "مسحوبة",
      running: "قيد التنفيذ",
      waiting: "بالانتظار",
      done: "مكتمل",
      halted: "متوقف",
      telco: "اتصالات",
      auto: "سيارات",
      superapp: "تطبيق شامل",
      bank: "بنك",
      quote: "عرض سعر",
      bind: "إصدار",
      refund: "استرداد",
      ai: "ذكاء اصطناعي",
      prospect: "مرشح",
      applied: "تقدّم بطلب",
      screening: "الفحص",
      diligence: "التحقق النافي للجهالة",
      agreement: "الاتفاقية",
      integration: "التكامل",
      sandbox: "بيئة الاختبار",
      live: "تشغيل فعلي",
      suspended: "موقوف",
      terminated: "منتهٍ",
      onboardingNoSteps: "لا خطوات مطلوبة في هذه القائمة.",
      onboardingProgress: "اكتملت {done} من {total} خطوة مطلوبة.",
      onboardingProgressStage: "اكتملت {done} من {total} خطوة مطلوبة نحو {stage}.",
      "riskRating.low": "منخفض",
      "riskRating.medium": "متوسط",
      "riskRating.high": "مرتفع",

      createdAt: "أُنشئ",
      updatedAt: "حُدّث",
      provider: "المزود",
      transport: "يحمل",
      label: "الاسم",
      configJson: "الإعدادات",
      secretsJson: "بيانات الاعتماد",
      "secretsJson.hint": "كائن JSON واحد يضم أسرار المزود. يُخزَّن مشفّرًا ولا يُعرض مرة أخرى.",
      "provider.whatsapp-cloud-api": "واتساب كلاود API",
      "provider.mailgun-email": "ميلغن",
      isDefault: "الفريق الافتراضي",
      "isDefault.hint": "الوجهة التي تصل إليها المحادثة عند عدم تطابق أي قاعدة توجيه.",
      userId: "الشخص",
      skillsJson: "المهارات",
      "skillsJson.hint": "قائمة JSON بوسوم المهارات، مثل [\"arabic\", \"claims\"].",
      maxConcurrent: "الحد المتزامن",
      "maxConcurrent.hint": "عدد المحادثات التي يمكن لهذا الشخص التعامل معها في وقت واحد.",
      activeCount: "مفتوحة الآن",
      seq: "الترتيب",
      "seq.hint": "تُقرأ القواعد بهذا الترتيب ويفوز أول تطابق.",
      enabled: "مفعّل",
      conditionsJson: "الشروط",
      "conditionsJson.hint": "كائن JSON يضم channel وintent وsentimentBelow. الكائن الفارغ يطابق كل شيء.",
      frtMinutes: "هدف أول رد",
      "frtMinutes.hint": "عدد الدقائق المسموح بها قبل أول رد بشري أو آلي.",
      resolutionMinutes: "هدف الإغلاق",
      disabled: "معطّل",
      available: "متاح",
      away: "بعيد",
      offline: "غير متصل"
    }
  },
  tabs: [
    {
      key: "conversations",
      api: "/v1/orbit/conversations",
      read: "orbit:conversations:read",
      recordLink: { href: "/orbit/conversations/{id}/thread", labelKey: "thread" },
      create: "orbit:conversations:reply",
      update: "orbit:conversations:assign",
      // The queue is read newest-first; the index is (tenant, state, lastMessageAt).
      sort: "lastMessageAt",
      filters: [
        { name: "state", options: ["bot", "human", "closed"] },
        { name: "channel", options: ["whatsapp", "web", "voice", "email", "agent"] }
      ],
      columns: [
        { name: "externalRef", type: "text" },
        { name: "customerId", type: "text" },
        { name: "channel", type: "text", badge: true },
        { name: "state", type: "text", badge: true },
        { name: "assigneeRef", type: "text" },
        { name: "intent", type: "text" },
        { name: "sentiment", type: "number" },
        { name: "csat", type: "number" },
        { name: "firstResponseMs", type: "number" },
        { name: "closedAt", type: "datetime" },
        { name: "lastMessageAt", type: "datetime", sortable: true }
      ],
      fields: [
        {
          name: "channel",
          type: "select",
          required: true,
          options: ["whatsapp", "web", "voice", "email", "agent"]
        },
        { name: "customerId", type: "text" },
        { name: "externalRef", type: "text" },
        { name: "lang", type: "text" }
      ],
      // The write permission is `assign`: routing and closing, not rewriting history.
      editable: [
        { name: "state", type: "select", options: ["bot", "human", "closed"] },
        { name: "assigneeRef", type: "text" },
        { name: "teamId", type: "text" },
        { name: "summary", type: "textarea" }
      ]
    },
    {
      key: "messages",
      api: "/v1/orbit/messages",
      read: "orbit:messages:read",
      create: "orbit:messages:send",
      // Immutable in the API: a turn that was sent cannot be edited or withdrawn.
      sort: "ts",
      filters: [
        { name: "role", options: ["customer", "agent_ai", "agent_human", "system"] },
        { name: "deliveryStatus", options: ["queued", "sent", "delivered", "read", "failed"] }
      ],
      columns: [
        { name: "content", type: "text" },
        { name: "conversationId", type: "text" },
        { name: "role", type: "text", badge: true },
        { name: "modality", type: "text" },
        { name: "deliveryStatus", type: "text", badge: true },
        { name: "externalRef", type: "text" },
        { name: "ts", type: "datetime", sortable: true },
        // What was sent alongside the words. Last: a turn with five files
        // should not push the turn itself off the side of the table.
        { name: "attachmentsJson", type: "json" }
      ],
      fields: [
        { name: "conversationId", type: "text", required: true },
        {
          name: "role",
          type: "select",
          required: true,
          options: ["customer", "agent_ai", "agent_human", "system"]
        },
        { name: "content", type: "textarea", required: true }
      ]
    },
    {
      key: "renewals",
      api: "/v1/orbit/renewals",
      read: "orbit:renewals:read",
      update: "orbit:renewals:update",
      // A renewal is created by the expiry sweep, never by hand — so no `fields`.
      sort: "expiryAt",
      order: "asc",
      filters: [
        { name: "state", options: ["scheduled", "offered", "accepted", "lost"] },
        { name: "strategy", options: ["auto_requote", "human", "do_not_contact"] }
      ],
      columns: [
        { name: "policyRef", type: "text" },
        { name: "customerId", type: "text" },
        { name: "expiryAt", type: "date", sortable: true },
        { name: "churnScore", type: "number" },
        { name: "strategy", type: "text", badge: true },
        { name: "state", type: "text", badge: true },
        { name: "offeredAt", type: "datetime" },
        { name: "decidedAt", type: "datetime" },
        { name: "ownerRef", type: "text" },
        // Every re-quote the sweep gathered for this expiry. Wide, so last.
        { name: "requotesJson", type: "json" }
      ],
      editable: [
        {
          name: "strategy",
          type: "select",
          options: ["auto_requote", "human", "do_not_contact"]
        },
        { name: "state", type: "select", options: ["scheduled", "offered", "accepted", "lost"] },
        { name: "ownerRef", type: "text" },
        { name: "outcomeReason", type: "text" }
      ]
    },
    {
      key: "journeys",
      api: "/v1/orbit/journeys",
      read: "orbit:journeys:read",
      // The graph is a form-per-step editor, not a JSON textarea.
      recordLink: { href: "/orbit/journeys/{id}/builder", labelKey: "builder" },
      create: "orbit:journeys:write",
      update: "orbit:journeys:write",
      remove: "orbit:journeys:write",
      filters: [{ name: "status", options: ["draft", "active", "paused", "retired"] }],
      columns: [
        { name: "key", type: "text" },
        { name: "version", type: "number" },
        { name: "status", type: "text", badge: true },
        { name: "createdBy", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "version", type: "number", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "graphJson", type: "json", required: true }
      ],
      editable: [
        { name: "status", type: "select", options: ["draft", "active", "paused", "retired"] },
        { name: "graphJson", type: "json" }
      ]
    },
    {
      key: "journey-runs",
      api: "/v1/orbit/journey-runs",
      read: "orbit:journeys:read",
      // Where each customer stands in a graph. The scheduler owns every column.
      sort: "nextAt",
      order: "asc",
      filters: [{ name: "state", options: ["running", "waiting", "done", "halted"] }],
      columns: [
        { name: "journeyId", type: "text" },
        { name: "customerId", type: "text" },
        { name: "node", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "nextAt", type: "datetime", sortable: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "partners",
      api: "/v1/orbit/partners",
      read: "orbit:partners:read",
      create: "orbit:partners:create",
      // The onboarding checklist routing.ts has always said is "opened from that
      // partner … record". It never was — the screen shipped with no path
      // builder anywhere — and routing.reachable.test.ts is what now says so.
      recordLink: { href: "/onboarding/partners/{id}", labelKey: "link.onboarding" },
      // No `update`/`editable`: the API registers no generic PATCH here, because
      // stage/status/sandboxFlag/goLiveAt belong to advancePartner() and its
      // `dist.partner_activate` approval (resources.ts §partners). An edit form
      // would only ever come back 405.
      search: true,
      filters: [
        { name: "kind", options: ["telco", "auto", "superapp", "bank"] },
        {
          name: "stage",
          options: [
            "prospect",
            "applied",
            "screening",
            "diligence",
            "agreement",
            "integration",
            "sandbox",
            "live"
          ]
        },
        { name: "riskRating", options: ["low", "medium", "high"] }
      ],
      columns: [
        { name: "name", type: "text" },
        { name: "kind", type: "text" },
        { name: "stage", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "riskRating", type: "text", badge: true },
        { name: "ownerRef", type: "text" },
        { name: "country", type: "text" },
        { name: "sandboxFlag", type: "boolean" },
        { name: "goLiveAt", type: "datetime" },
        { name: "suspendedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Creating a partner goes through the `dist.partner_activate` approval.
      fields: [
        { name: "name", type: "text", required: true },
        {
          name: "kind",
          type: "select",
          required: true,
          options: ["telco", "auto", "superapp", "bank"]
        },
        { name: "sandboxFlag", type: "boolean" },
        { name: "revshareJson", type: "json" },
        { name: "contactJson", type: "json" }
      ]
    },
    {
      key: "partner-txns",
      api: "/v1/orbit/partner-txns",
      read: "orbit:partners:read",
      sort: "ts",
      filters: [{ name: "kind", options: ["quote", "bind", "refund"] }],
      columns: [
        { name: "txnRef", type: "text" },
        { name: "partnerId", type: "text" },
        { name: "kind", type: "text" },
        { name: "amountMinor", type: "money", currencyFrom: "currency" },
        { name: "revshareCalcMinor", type: "money", currencyFrom: "currency" },
        { name: "settlementBatch", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "handover-notes",
      api: "/v1/orbit/handover-notes",
      read: "orbit:handover:read",
      create: "orbit:handover:write",
      update: "orbit:handover:write",
      remove: "orbit:handover:write",
      sort: "ts",
      filters: [{ name: "generatedBy", options: ["ai", "human"] }],
      columns: [
        { name: "summary", type: "text" },
        { name: "conversationId", type: "text" },
        { name: "fromRef", type: "text" },
        { name: "toRef", type: "text" },
        { name: "generatedBy", type: "text", badge: true },
        { name: "acceptedBy", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "conversationId", type: "text", required: true },
        { name: "fromRef", type: "text", required: true },
        { name: "toRef", type: "text" },
        { name: "summary", type: "textarea", required: true },
        { name: "factsJson", type: "json" }
      ],
      editable: [
        { name: "toRef", type: "text" },
        { name: "summary", type: "textarea" },
        { name: "acceptedBy", type: "text" },
        { name: "factsJson", type: "json" }
      ]
    },
    {
      key: "qa-scores",
      api: "/v1/orbit/qa-scores",
      read: "orbit:qa:read",
      // `orbit:qa:score` is a reviewer scoring a conversation against a rubric;
      // the AI scorer writes the same shape. Neither may amend a score after.
      create: "orbit:qa:score",
      sort: "ts",
      columns: [
        { name: "rubricKey", type: "text" },
        { name: "conversationId", type: "text" },
        { name: "score", type: "number" },
        { name: "scoredBy", type: "text" },
        { name: "disputedBy", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "conversationId", type: "text", required: true },
        { name: "rubricKey", type: "text", required: true },
        { name: "score", type: "number", required: true },
        { name: "breakdownJson", type: "json" },
        { name: "flagsJson", type: "json" }
      ]
    },
    // The five tables engines/orbit-routing.ts reads and nothing rendered: a
    // tenant could not see, let alone edit, the roster and rules that decide
    // where a conversation lands. Plain CRUD, so plain tabs — /orbit/admin is
    // the read on whether they hang together, not a second editor.
    {
      key: "channel-connectors",
      api: "/v1/orbit/channel-connectors",
      read: "orbit:channels:read",
      create: "orbit:channels:write",
      update: "orbit:channels:write",
      remove: "orbit:channels:write",
      filters: [
        { name: "transport", options: ["whatsapp", "email", "web", "voice", "agent"] },
        { name: "status", options: ["active", "disabled"] }
      ],
      columns: [
        { name: "label", type: "text" },
        { name: "provider", type: "text" },
        { name: "transport", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "label", type: "text", required: true },
        { name: "provider", type: "select", options: ["whatsapp-cloud-api", "mailgun-email"], required: true },
        { name: "transport", type: "select", options: ["whatsapp", "email", "web", "voice", "agent"], required: true },
        // Sealed by resources.ts's beforeWrite before it reaches SQLite, and
        // never read back — the list has no `secretsJson` column for that reason.
        { name: "secretsJson", type: "json", required: true, hintKey: "secretsJson.hint" },
        { name: "configJson", type: "json" }
      ],
      editable: [
        { name: "label", type: "text" },
        { name: "status", type: "select", options: ["active", "disabled"] },
        { name: "secretsJson", type: "json", hintKey: "secretsJson.hint" },
        { name: "configJson", type: "json" }
      ]
    },
    {
      key: "teams",
      api: "/v1/orbit/teams",
      read: "orbit:teams:read",
      create: "orbit:teams:write",
      update: "orbit:teams:write",
      remove: "orbit:teams:write",
      filters: [{ name: "status", options: ["active", "disabled"] }],
      columns: [
        { name: "key", type: "text" },
        { name: "nameJson", type: "json" },
        { name: "isDefault", type: "boolean" },
        { name: "status", type: "text", badge: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "isDefault", type: "boolean", hintKey: "isDefault.hint" }
      ],
      editable: [
        { name: "nameJson", type: "json" },
        { name: "isDefault", type: "boolean", hintKey: "isDefault.hint" },
        { name: "status", type: "select", options: ["active", "disabled"] }
      ]
    },
    {
      key: "team-members",
      api: "/v1/orbit/team-members",
      read: "orbit:teams:read",
      create: "orbit:teams:write",
      update: "orbit:teams:write",
      remove: "orbit:teams:write",
      columns: [
        { name: "teamId", type: "text" },
        { name: "userId", type: "text" },
        { name: "skillsJson", type: "json" },
        { name: "maxConcurrent", type: "number" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "teamId", type: "text", required: true },
        { name: "userId", type: "text", required: true },
        { name: "skillsJson", type: "json", hintKey: "skillsJson.hint" },
        { name: "maxConcurrent", type: "number", hintKey: "maxConcurrent.hint" }
      ],
      editable: [
        { name: "skillsJson", type: "json", hintKey: "skillsJson.hint" },
        { name: "maxConcurrent", type: "number", hintKey: "maxConcurrent.hint" }
      ]
    },
    {
      key: "routing-rules",
      api: "/v1/orbit/routing-rules",
      read: "orbit:teams:read",
      create: "orbit:teams:write",
      update: "orbit:teams:write",
      remove: "orbit:teams:write",
      sort: "seq",
      columns: [
        { name: "seq", type: "number", sortable: true },
        { name: "teamId", type: "text" },
        { name: "conditionsJson", type: "json" },
        { name: "enabled", type: "boolean" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "seq", type: "number", required: true, hintKey: "seq.hint" },
        { name: "teamId", type: "text", required: true },
        { name: "conditionsJson", type: "json", hintKey: "conditionsJson.hint" },
        { name: "enabled", type: "boolean" }
      ],
      editable: [
        { name: "seq", type: "number", hintKey: "seq.hint" },
        { name: "teamId", type: "text" },
        { name: "conditionsJson", type: "json", hintKey: "conditionsJson.hint" },
        { name: "enabled", type: "boolean" }
      ]
    },
    {
      key: "sla-policies",
      api: "/v1/orbit/sla-policies",
      read: "orbit:teams:read",
      create: "orbit:teams:write",
      update: "orbit:teams:write",
      remove: "orbit:teams:write",
      columns: [
        { name: "key", type: "text" },
        { name: "frtMinutes", type: "number" },
        { name: "resolutionMinutes", type: "number" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "frtMinutes", type: "number", required: true, hintKey: "frtMinutes.hint" },
        { name: "resolutionMinutes", type: "number", required: true }
      ],
      editable: [
        { name: "frtMinutes", type: "number", hintKey: "frtMinutes.hint" },
        { name: "resolutionMinutes", type: "number" }
      ]
    },
    // docs/27 F32. The article manager, the canned replies built from it, and
    // the log of whether either answered the customer. `status` is not editable
    // here by design: publishing is what embeds an article, and it happens at
    // POST /v1/orbit/kb/articles/:id/publish, not through a PATCH that would
    // publish something no search index has heard of.
    {
      key: "kb-articles",
      api: "/v1/orbit/kb-articles",
      read: "orbit:kb:read",
      create: "orbit:kb:write",
      update: "orbit:kb:write",
      remove: "orbit:kb:write",
      filters: [
        { name: "status", options: ["draft", "published", "retired"] },
        { name: "locale", options: ["en", "ar"] }
      ],
      columns: [
        { name: "key", type: "text" },
        { name: "title", type: "text" },
        { name: "locale", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "locale", type: "select", options: ["en", "ar"], required: true },
        { name: "title", type: "text", required: true },
        { name: "body", type: "textarea", required: true, hintKey: "body.hint" },
        { name: "tagsJson", type: "json" }
      ],
      editable: [
        { name: "title", type: "text" },
        { name: "body", type: "textarea", hintKey: "body.hint" },
        { name: "tagsJson", type: "json" }
      ]
    },
    {
      key: "macros",
      api: "/v1/orbit/macros",
      read: "orbit:macros:read",
      create: "orbit:macros:write",
      update: "orbit:macros:write",
      remove: "orbit:macros:write",
      filters: [{ name: "status", options: ["active", "disabled"] }],
      columns: [
        { name: "key", type: "text" },
        { name: "nameJson", type: "json" },
        { name: "category", type: "text" },
        { name: "usageCount", type: "number", sortable: true },
        { name: "status", type: "text", badge: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "bodyJson", type: "json", required: true, hintKey: "bodyJson.hint" },
        { name: "category", type: "text" }
      ],
      editable: [
        { name: "nameJson", type: "json" },
        { name: "bodyJson", type: "json", hintKey: "bodyJson.hint" },
        { name: "category", type: "text" },
        { name: "status", type: "select", options: ["active", "disabled"] }
      ]
    },
    {
      key: "deflections",
      api: "/v1/orbit/deflections",
      read: "orbit:conversations:read",
      sort: "-ts",
      filters: [{ name: "outcome", options: ["deflected", "escalated"] }],
      columns: [
        { name: "question", type: "text" },
        { name: "outcome", type: "text", badge: true },
        { name: "score", type: "number", sortable: true },
        { name: "via", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "agent-presence",
      api: "/v1/orbit/agent-presence",
      read: "orbit:presence:read",
      create: "orbit:presence:write",
      update: "orbit:presence:write",
      filters: [{ name: "status", options: ["available", "away", "offline"] }],
      columns: [
        { name: "userId", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "activeCount", type: "number" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "userId", type: "text", required: true },
        { name: "status", type: "select", options: ["available", "away", "offline"], required: true }
      ],
      editable: [{ name: "status", type: "select", options: ["available", "away", "offline"] }]
    }
  ],
  // The bespoke ORBIT screens. Each names the permission its own loader gates on,
  // so an actor who would only be told no is not offered the door.
  links: [
    { href: "/orbit/console", labelKey: "link.console", permission: "orbit:conversations:read" },
    { href: "/orbit/supervisor", labelKey: "link.supervisor", permission: "orbit:presence:read" },
    { href: "/orbit/save", labelKey: "link.save", permission: "orbit:renewals:read" },
    { href: "/orbit/pipeline", labelKey: "link.pipeline", permission: "orbit:renewals:read" },
    { href: "/orbit/quality", labelKey: "link.quality", permission: "orbit:qa:read" },
    { href: "/orbit/analytics", labelKey: "link.analytics", permission: "orbit:conversations:read" },
    { href: "/orbit/admin", labelKey: "link.admin", permission: "orbit:teams:write" },
    { href: "/orbit/dev", labelKey: "link.dev", permission: "orbit:messages:send" }
  ]
};
