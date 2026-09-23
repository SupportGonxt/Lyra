import type { WorkspaceSpec } from "./spec";

// ADMIN — the tenant's own configuration. Who exists (users, roles, teams), what
// the platform is allowed to talk to (providers, webhooks, identity providers,
// API keys) and what it did about it (approvals, audit, DLQ). AI administration
// lives here rather than in a module because an agent is a member of staff with
// an autonomy envelope and a budget: the same people govern both (docs/07 §AI).

export const admin: WorkspaceSpec = {
  path: "/admin",
  labels: {
    en: {
      tenants: "Organisations",
      users: "People",
      roles: "Roles",
      "user-roles": "Role assignments",
      teams: "Teams",
      customers: "Customers",
      consents: "Consents",
      products: "Products",
      providers: "Providers",
      files: "Files",
      approvals: "Approvals",
      mandates: "Mandates",
      "identity-verifications": "Identity checks",
      memories: "Memory",
      lenses: "Lenses",
      rulepacks: "Rule packs",
      "api-keys": "API keys",
      "identity-providers": "Sign-in providers",
      webhooks: "Webhooks",
      "webhook-deliveries": "Webhook deliveries",
      notifications: "Notifications",
      "audit-log": "Audit log",
      "event-dlq": "Dead letters",
      agents: "Agents",
      prompts: "Prompts",
      runs: "Agent runs",
      "tool-calls": "Tool calls",
      suggestions: "Suggestions",
      budgets: "AI budgets",
      evals: "Evals",
      "knowledge-sources": "Knowledge",
      "guardrail-events": "Guardrails",
      "ai-audit-log": "AI audit log",
      aiConsole: "AI console",
      aiBudget: "Spending ceilings",
      costExplorer: "Cost explorer",
      notesVault: "Download notes vault",
      staff: "Staff",
      runDetail: "Open this run",
      "message-templates": "Message templates",
      "locale-overrides": "Localisation",

      name: "Name",
      slug: "Slug",
      plan: "Plan",
      region: "Region",
      status: "Status",
      brandJson: "Brand",
      policyJson: "Policy",
      entitlementsJson: "Entitlements",
      email: "Email",
      phone: "Phone",
      locale: "Language",
      authProvider: "Sign-in method",
      mfaEnrolled: "Two-factor",
      lastSeenAt: "Last seen",
      externalId: "External identifier",
      key: "Key",
      permissionsJson: "Permissions",
      system: "Built in",
      userId: "Person",
      roleId: "Role",
      scopeJson: "Scope",
      moduleScope: "Module scope",
      nameJson: "Name",
      type: "Type",
      kycStatus: "Verification",
      customerId: "Customer",
      source: "Source",
      purposesJson: "Purposes",
      ts: "When",
      expiry: "Expires",
      version: "Version",
      line: "Product line",
      providerId: "Provider",
      structure: "Structure",
      termsRef: "Terms reference",
      pricingInputsJson: "Pricing inputs",
      kind: "Kind",
      isInternal: "In-house",
      currency: "Currency",
      panelStatus: "Panel status",
      linesJson: "Lines",
      commissionJson: "Commission",
      settlementTermsJson: "Settlement terms",
      r2Key: "Storage key",
      subjectRef: "Subject",
      contentType: "Content type",
      sizeBytes: "Size",
      piiLevel: "Personal data",
      policyKey: "Policy",
      module: "Module",
      decision: "Decision",
      requestedBy: "Requested by",
      requestedAt: "Requested",
      decidedAt: "Decided",
      principalRef: "Principal",
      agentIdentity: "Agent identity",
      spendCapMinor: "Spend cap",
      method: "Method",
      evidenceLevel: "Evidence level",
      providerRef: "Provider reference",
      provenance: "Provenance",
      sensitivity: "Sensitivity",
      lensJson: "Lens",
      market: "Market",
      effectiveAt: "Effective",
      rulesJson: "Rules",
      prefix: "Prefix",
      mode: "Mode",
      scopesJson: "Scopes",
      expiresAt: "Expires",
      revokedAt: "Revoked",
      lastUsedAt: "Last used",
      emailDomain: "Email domain",
      issuer: "Issuer",
      enabled: "Enabled",
      mfaAsserted: "Asserts two-factor",
      clientId: "Client identifier",
      discoveryUrl: "Discovery URL",
      defaultRoleKey: "Default role",
      url: "Endpoint",
      eventTypesJson: "Event types",
      webhookId: "Webhook",
      eventId: "Event",
      responseCode: "Response",
      attempts: "Attempts",
      nextAttemptAt: "Next attempt",
      titleKey: "Title",
      readAt: "Read",
      action: "Action",
      actorRef: "Actor",
      ip: "IP address",
      consumer: "Consumer",
      error: "Error",
      replayedAt: "Replayed",
      autonomyLevel: "Autonomy",
      tier: "Tier",
      promptRef: "Prompt",
      descriptionJson: "Description",
      toolsJson: "Tools",
      guardrailsJson: "Guardrails",
      pausedReason: "Pause reason",
      body: "Body",
      variablesJson: "Variables",
      createdBy: "Author",
      agentKey: "Agent",
      purpose: "Purpose",
      state: "State",
      trigger: "Trigger",
      confidence: "Confidence",
      costMicro: "Cost",
      startedAt: "Started",
      tool: "Tool",
      runId: "Run",
      seq: "Sequence",
      consequential: "Consequential",
      outcome: "Outcome",
      durationMs: "Duration",
      surface: "Surface",
      editDistance: "Edit distance",
      shownAt: "Shown",
      resolvedAt: "Resolved",
      day: "Day",
      tokensUsed: "Tokens used",
      tokensLimit: "Token limit",
      costMicroUsed: "Cost used",
      costMicroLimit: "Cost limit",
      stoppedAt: "Stopped",
      suite: "Suite",
      caseKey: "Case",
      model: "Model",
      provider: "Provider",
      score: "Score",
      passed: "Passed",
      uri: "Location",
      fileId: "File",
      chunkCount: "Chunks",
      lastIndexedAt: "Last indexed",
      rule: "Rule",
      severity: "Severity",
      detail: "Detail",

      active: "Active",
      suspended: "Suspended",
      closed: "Closed",
      invited: "Invited",
      password: "Password",
      oidc: "OpenID Connect",
      saml: "SAML",
      person: "Individual",
      business: "Business",
      none: "None",
      pending: "Pending",
      verified: "Verified",
      failed: "Failed",
      web: "Web",
      whatsapp: "WhatsApp",
      import: "Import",
      agent: "Agent",
      portal: "Portal",
      motor: "Motor",
      health: "Health",
      travel: "Travel",
      home: "Home",
      life: "Life",
      sme: "Small business",
      card: "Card",
      loan: "Loan",
      account: "Account",
      conventional: "Conventional",
      takaful: "Takaful",
      parametric: "Parametric",
      insurer: "Insurer",
      bank: "Bank",
      financier: "Financier",
      low: "Low",
      high: "High",
      approved: "Approved",
      rejected: "Rejected",
      test: "Test",
      live: "Live",
      delivered: "Delivered",
      dead: "Given up",
      paused: "Paused",
      retired: "Retired",
      fast: "Fast",
      standard: "Standard",
      reasoning: "Reasoning",
      draft: "Draft",
      running: "Running",
      awaiting_approval: "Awaiting approval",
      succeeded: "Succeeded",
      refused: "Refused",
      cancelled: "Cancelled",
      budget_stopped: "Stopped by budget",
      user: "Person",
      event: "Event",
      schedule: "Schedule",
      api: "API",
      ok: "Ok",
      blocked: "Blocked",
      ghost_text: "Ghost text",
      chip: "Chip",
      forecast: "Forecast",
      filter: "Filter",
      shown: "Shown",
      accepted: "Accepted",
      edited: "Edited",
      dismissed: "Dismissed",
      expired: "Expired",
      policy_wording: "Policy wording",
      sop: "Procedure",
      faq: "FAQ",
      product: "Product",
      regulatory: "Regulatory",
      indexing: "Indexing",
      ready: "Ready",
      stale: "Stale",
      info: "Information",
      warn: "Warning",
      block: "Block",
      budget_exceeded: "Budget exceeded",
      killed: "AI paused",
      suggest: "Suggest",
      act: "Act",
      act_with_approval: "Act with approval",
      act_and_report: "Act and report",
      act_within_limits: "Act within limits",
      autonomous: "Act on its own",

      emailsJson: "Email addresses",
      phonesJson: "Phone numbers",
      tagsJson: "Tags",
      riskFlagsJson: "Risk flags",
      consentId: "Consent",
      ltvCached: "Lifetime value",
      channelOptinsJson: "Channel opt-ins",
      evidenceRef: "Evidence reference",
      verificationRef: "Verification reference",
      contentJson: "Content",
      reason: "Reason",
      decidedBy: "Decided by",
      contextJson: "Context",
      envelopeJson: "Event envelope",
      tokensIn: "Tokens in",
      tokensOut: "Tokens out",
      latencyMs: "Latency",
      errorCode: "Error code",
      endedAt: "Ended",
      approvalId: "Approval",
      evidenceJson: "Evidence",
      toolCallsJson: "Tool calls",
      guardrailFlagsJson: "Guardrail flags",
      thresholdScore: "Threshold",
      detailJson: "Detail",
      gitSha: "Commit",
      subjectJson: "Subject",
      bodyJson: "Body",
      channel: "Channel",
      value: "Value",
      updatedBy: "Updated by",
      sms: "SMS",
      push: "Push",
      permissionMatrix: "Roles and permissions",
      developer: "Developer portal",
      security: "Security & access",
      brandTheme: "Brand and theme",
      billingPlan: "Plan and invoices",
      dataRequests: "Data subject requests"
    },
    ar: {
      tenants: "المنشآت",
      users: "الأشخاص",
      roles: "الأدوار",
      "user-roles": "إسناد الأدوار",
      teams: "الفرق",
      customers: "العملاء",
      consents: "موافقات العملاء",
      products: "المنتجات",
      providers: "المزودون",
      files: "الملفات",
      approvals: "الموافقات",
      mandates: "التفويضات",
      "identity-verifications": "التحقق من الهوية",
      memories: "الذاكرة",
      lenses: "العدسات",
      rulepacks: "حزم القواعد",
      "api-keys": "مفاتيح الواجهة البرمجية",
      "identity-providers": "موفرو تسجيل الدخول",
      webhooks: "خطافات الويب",
      "webhook-deliveries": "عمليات تسليم الخطافات",
      notifications: "الإشعارات",
      "audit-log": "سجل التدقيق",
      "event-dlq": "الأحداث المتعذرة",
      agents: "الوكلاء",
      prompts: "الموجّهات",
      runs: "عمليات تشغيل الوكلاء",
      "tool-calls": "استدعاءات الأدوات",
      suggestions: "الاقتراحات",
      budgets: "ميزانيات الذكاء الاصطناعي",
      evals: "التقييمات",
      "knowledge-sources": "مصادر المعرفة",
      "guardrail-events": "الحواجز الوقائية",
      "ai-audit-log": "سجل تدقيق الذكاء الاصطناعي",
      aiConsole: "وحدة تحكم الذكاء الاصطناعي",
      aiBudget: "حدود الإنفاق",
      costExplorer: "مستكشف التكلفة",
      notesVault: "تنزيل خزنة الملاحظات",
      staff: "الموظفون",
      runDetail: "فتح هذا التشغيل",
      "message-templates": "قوالب الرسائل",
      "locale-overrides": "التعريب",

      name: "الاسم",
      slug: "المعرف المختصر",
      plan: "الخطة",
      region: "المنطقة",
      status: "الحالة",
      brandJson: "الهوية البصرية",
      policyJson: "السياسة",
      entitlementsJson: "الاستحقاقات",
      email: "البريد الإلكتروني",
      phone: "الهاتف",
      locale: "اللغة",
      authProvider: "طريقة تسجيل الدخول",
      mfaEnrolled: "المصادقة الثنائية",
      lastSeenAt: "آخر ظهور",
      externalId: "المعرف الخارجي",
      key: "المفتاح",
      permissionsJson: "الصلاحيات",
      system: "مدمج",
      userId: "الشخص",
      roleId: "الدور",
      scopeJson: "النطاق",
      moduleScope: "نطاق الوحدة",
      nameJson: "الاسم",
      type: "النوع",
      kycStatus: "حالة التحقق",
      customerId: "العميل",
      source: "المصدر",
      purposesJson: "الأغراض",
      ts: "الوقت",
      expiry: "تاريخ الانتهاء",
      version: "الإصدار",
      line: "خط المنتج",
      providerId: "المزود",
      structure: "البنية",
      termsRef: "مرجع الشروط",
      pricingInputsJson: "مدخلات التسعير",
      kind: "النوع",
      isInternal: "داخلي",
      currency: "العملة",
      panelStatus: "حالة الإدراج بالقائمة",
      linesJson: "الخطوط",
      commissionJson: "العمولة",
      settlementTermsJson: "شروط التسوية",
      r2Key: "مفتاح التخزين",
      subjectRef: "الموضوع",
      contentType: "نوع المحتوى",
      sizeBytes: "الحجم",
      piiLevel: "البيانات الشخصية",
      policyKey: "السياسة",
      module: "الوحدة",
      decision: "القرار",
      requestedBy: "طلب بواسطة",
      requestedAt: "تاريخ الطلب",
      decidedAt: "تاريخ القرار",
      principalRef: "الأصيل",
      agentIdentity: "هوية الوكيل",
      spendCapMinor: "حد الإنفاق",
      method: "الطريقة",
      evidenceLevel: "مستوى الإثبات",
      providerRef: "مرجع المزود",
      provenance: "المنشأ",
      sensitivity: "الحساسية",
      lensJson: "العدسة",
      market: "السوق",
      effectiveAt: "يسري من",
      rulesJson: "القواعد",
      prefix: "البادئة",
      mode: "الوضع",
      scopesJson: "النطاقات",
      expiresAt: "تاريخ الانتهاء",
      revokedAt: "تاريخ الإلغاء",
      lastUsedAt: "آخر استخدام",
      emailDomain: "نطاق البريد",
      issuer: "الجهة المصدرة",
      enabled: "مفعّل",
      mfaAsserted: "يؤكد المصادقة الثنائية",
      clientId: "معرف العميل",
      discoveryUrl: "رابط الاكتشاف",
      defaultRoleKey: "الدور الافتراضي",
      url: "نقطة النهاية",
      eventTypesJson: "أنواع الأحداث",
      webhookId: "الخطاف",
      eventId: "الحدث",
      responseCode: "رمز الاستجابة",
      attempts: "المحاولات",
      nextAttemptAt: "المحاولة التالية",
      titleKey: "العنوان",
      readAt: "تاريخ القراءة",
      action: "الإجراء",
      actorRef: "الفاعل",
      ip: "عنوان الشبكة",
      consumer: "المستهلك",
      error: "الخطأ",
      replayedAt: "تاريخ إعادة التشغيل",
      autonomyLevel: "مستوى الاستقلالية",
      tier: "الفئة",
      promptRef: "المطالبة",
      descriptionJson: "الوصف",
      toolsJson: "الأدوات",
      guardrailsJson: "الحواجز",
      pausedReason: "سبب الإيقاف",
      body: "النص",
      variablesJson: "المتغيرات",
      createdBy: "المؤلف",
      agentKey: "الوكيل",
      purpose: "الغرض",
      state: "الوضع",
      trigger: "المُشغّل",
      confidence: "الثقة",
      costMicro: "التكلفة",
      startedAt: "البداية",
      tool: "الأداة",
      runId: "التشغيل",
      seq: "التسلسل",
      consequential: "ذو أثر",
      outcome: "النتيجة",
      durationMs: "المدة",
      surface: "السطح",
      editDistance: "مقدار التعديل",
      shownAt: "تاريخ العرض",
      resolvedAt: "تاريخ الحسم",
      day: "اليوم",
      tokensUsed: "الرموز المستخدمة",
      tokensLimit: "حد الرموز",
      costMicroUsed: "التكلفة المستخدمة",
      costMicroLimit: "حد التكلفة",
      stoppedAt: "تاريخ الإيقاف",
      suite: "المجموعة",
      caseKey: "الحالة",
      model: "النموذج",
      provider: "المزود",
      score: "الدرجة",
      passed: "ناجح",
      uri: "الموقع",
      fileId: "الملف",
      chunkCount: "عدد المقاطع",
      lastIndexedAt: "آخر فهرسة",
      rule: "القاعدة",
      severity: "الخطورة",
      detail: "التفاصيل",

      active: "نشط",
      suspended: "موقوف",
      closed: "مغلق",
      invited: "مدعو",
      password: "كلمة المرور",
      oidc: "OpenID Connect",
      saml: "SAML",
      person: "فرد",
      business: "منشأة",
      none: "لا شيء",
      pending: "قيد الانتظار",
      verified: "موثّق",
      failed: "فشل",
      web: "الويب",
      whatsapp: "واتساب",
      import: "استيراد",
      agent: "وكيل",
      portal: "بوابة",
      motor: "مركبات",
      health: "صحي",
      travel: "سفر",
      home: "منازل",
      life: "حياة",
      sme: "منشآت صغيرة",
      card: "بطاقات",
      loan: "قروض",
      account: "حسابات",
      conventional: "تقليدي",
      takaful: "تكافل",
      parametric: "بارامتري",
      insurer: "شركة تأمين",
      bank: "بنك",
      financier: "جهة تمويل",
      low: "منخفض",
      high: "مرتفع",
      approved: "معتمد",
      rejected: "مرفوض",
      test: "اختبار",
      live: "مباشر",
      delivered: "تم التسليم",
      dead: "توقف نهائيًا",
      paused: "متوقف مؤقتًا",
      retired: "مسحوب",
      fast: "سريع",
      standard: "قياسي",
      reasoning: "استدلالي",
      draft: "مسودة",
      running: "قيد التشغيل",
      awaiting_approval: "بانتظار الموافقة",
      succeeded: "نجح",
      refused: "امتناع",
      cancelled: "ملغى",
      budget_stopped: "أوقفته الميزانية",
      user: "شخص",
      event: "حدث",
      schedule: "جدولة",
      api: "واجهة برمجية",
      ok: "تم",
      blocked: "محظور",
      ghost_text: "نص تمهيدي خافت",
      chip: "شريحة",
      forecast: "توقع",
      filter: "مرشّح",
      shown: "معروض",
      accepted: "مقبول",
      edited: "معدّل",
      dismissed: "مستبعد",
      expired: "منتهٍ",
      policy_wording: "نص الوثيقة",
      sop: "إجراء تشغيلي",
      faq: "أسئلة شائعة",
      product: "منتج",
      regulatory: "تنظيمي",
      indexing: "قيد الفهرسة",
      ready: "جاهز",
      stale: "قديم",
      info: "معلومة",
      warn: "تحذير",
      block: "حظر",
      budget_exceeded: "تجاوز الميزانية",
      killed: "الذكاء الاصطناعي موقوف",
      suggest: "اقتراح",
      act: "تنفيذ",
      act_with_approval: "تنفيذ بموافقة",
      act_and_report: "تنفيذ وإبلاغ",
      act_within_limits: "تنفيذ ضمن حدود",
      autonomous: "تنفيذ ذاتي",

      emailsJson: "عناوين البريد الإلكتروني",
      phonesJson: "أرقام الهاتف",
      tagsJson: "الوسوم",
      riskFlagsJson: "مؤشرات المخاطر",
      consentId: "الموافقة",
      ltvCached: "القيمة الإجمالية",
      channelOptinsJson: "الاشتراك في القنوات",
      evidenceRef: "مرجع الإثبات",
      verificationRef: "مرجع التحقق",
      contentJson: "المحتوى",
      reason: "السبب",
      decidedBy: "صاحب القرار",
      contextJson: "السياق",
      envelopeJson: "غلاف الحدث",
      tokensIn: "الرموز الواردة",
      tokensOut: "الرموز الصادرة",
      latencyMs: "زمن الاستجابة",
      errorCode: "رمز الخطأ",
      endedAt: "انتهى في",
      approvalId: "معرّف الموافقة",
      evidenceJson: "الأدلة",
      toolCallsJson: "استدعاءات الأدوات",
      guardrailFlagsJson: "مؤشرات الحواجز",
      thresholdScore: "درجة العتبة",
      detailJson: "التفاصيل",
      gitSha: "بصمة الإصدار",
      subjectJson: "الموضوع",
      bodyJson: "النص",
      channel: "القناة",
      value: "القيمة",
      updatedBy: "حدّثه",
      sms: "رسالة نصية",
      push: "إشعار فوري",
      permissionMatrix: "الأدوار والصلاحيات",
      developer: "بوابة المطوّرين",
      security: "الأمان والوصول",
      brandTheme: "الهوية والمظهر",
      billingPlan: "الخطة والفواتير",
      dataRequests: "طلبات أصحاب البيانات"
    }
  },
  tabs: [
    /* ------------------------------------------------------------ core: who */
    {
      key: "tenants",
      api: "/v1/core/tenants",
      read: "core:tenants:read",
      update: "core:tenants:update",
      filters: [{ name: "status", options: ["active", "suspended", "closed"] }],
      columns: [
        { name: "name", type: "text" },
        { name: "slug", type: "text" },
        { name: "plan", type: "text" },
        { name: "region", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Creating a tenant is a platform act, not a tenant act: this tab edits
      // the one you are signed in to.
      editable: [
        { name: "name", type: "text" },
        { name: "plan", type: "text" },
        { name: "region", type: "text" },
        { name: "status", type: "select", options: ["active", "suspended", "closed"] },
        { name: "brandJson", type: "json" },
        { name: "policyJson", type: "json" },
        { name: "entitlementsJson", type: "json" }
      ]
    },
    {
      key: "users",
      api: "/v1/core/users",
      read: "core:users:read",
      create: "core:users:create",
      update: "core:users:update",
      remove: "core:users:delete",
      search: true,
      filters: [
        { name: "status", options: ["invited", "active", "suspended"] },
        { name: "authProvider", options: ["password", "oidc", "saml"] }
      ],
      columns: [
        { name: "name", type: "text" },
        { name: "email", type: "text", sortable: true },
        { name: "status", type: "text", badge: true },
        { name: "authProvider", type: "text" },
        { name: "mfaEnrolled", type: "boolean" },
        { name: "lastSeenAt", type: "datetime", sortable: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Credentials never travel through a CRUD body (resources.ts strips them),
      // so no password, secret or recovery column appears on either form.
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: true },
        { name: "phone", type: "text" },
        { name: "locale", type: "text" },
        { name: "authProvider", type: "select", options: ["password", "oidc", "saml"] },
        { name: "externalId", type: "text" }
      ],
      editable: [
        { name: "name", type: "text" },
        { name: "phone", type: "text" },
        { name: "locale", type: "text" },
        { name: "status", type: "select", options: ["invited", "active", "suspended"] }
      ]
    },
    {
      key: "roles",
      api: "/v1/core/roles",
      read: "core:roles:read",
      create: "core:roles:update",
      update: "core:roles:update",
      remove: "core:roles:update",
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "name", type: "text" },
        { name: "permissionsJson", type: "json" },
        { name: "system", type: "boolean" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "name", type: "text", required: true },
        { name: "permissionsJson", type: "json", required: true }
      ],
      editable: [
        { name: "name", type: "text" },
        { name: "permissionsJson", type: "json" }
      ]
    },
    {
      key: "user-roles",
      api: "/v1/core/user-roles",
      read: "core:roles:read",
      create: "core:roles:assign",
      remove: "core:roles:assign",
      columns: [
        { name: "userId", type: "text" },
        { name: "roleId", type: "text" },
        { name: "scopeJson", type: "json" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // An assignment is granted or revoked, never amended — the API registers
      // no update permission for it.
      fields: [
        { name: "userId", type: "text", required: true },
        { name: "roleId", type: "text", required: true },
        { name: "scopeJson", type: "json" }
      ]
    },
    {
      key: "teams",
      api: "/v1/core/teams",
      read: "core:teams:read",
      create: "core:teams:write",
      update: "core:teams:write",
      remove: "core:teams:write",
      search: true,
      columns: [
        { name: "name", type: "text", sortable: true },
        { name: "moduleScope", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "name", type: "text", required: true },
        { name: "moduleScope", type: "text" }
      ]
    },

    /* --------------------------------------------------------- core: record */
    {
      key: "customers",
      api: "/v1/core/customers",
      read: "core:customers:read",
      create: "core:customers:create",
      update: "core:customers:update",
      remove: "core:customers:delete",
      search: true,
      sort: "updatedAt",
      filters: [
        { name: "type", options: ["person", "business"] },
        { name: "kycStatus", options: ["none", "pending", "verified", "failed"] }
      ],
      // Administration needs to find a customer and see its state, not read its
      // personal detail off a list (docs/12) — emails and phones are on the form,
      // where one record is open and the actor is accountable, never in columns.
      columns: [
        { name: "nameJson", type: "json" },
        { name: "type", type: "text" },
        { name: "kycStatus", type: "text", badge: true },
        { name: "tagsJson", type: "json" },
        { name: "riskFlagsJson", type: "json" },
        { name: "consentId", type: "text" },
        { name: "ltvCached", type: "number" },
        { name: "locale", type: "text" },
        { name: "updatedAt", type: "datetime", sortable: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "nameJson", type: "json", required: true },
        { name: "type", type: "select", options: ["person", "business"] },
        { name: "emailsJson", type: "json" },
        { name: "phonesJson", type: "json" },
        { name: "locale", type: "text" },
        { name: "tagsJson", type: "json" }
      ],
      // kycStatus is a state a customer moves through, not one they are created
      // in; it is editable and absent from create on purpose.
      editable: [
        { name: "nameJson", type: "json" },
        { name: "emailsJson", type: "json" },
        { name: "phonesJson", type: "json" },
        { name: "locale", type: "text" },
        { name: "kycStatus", type: "select", options: ["none", "pending", "verified", "failed"] },
        { name: "tagsJson", type: "json" }
      ]
    },
    {
      key: "consents",
      api: "/v1/core/consents",
      read: "core:consents:read",
      create: "core:consents:create",
      sort: "ts",
      filters: [{ name: "source", options: ["web", "whatsapp", "import", "agent", "portal"] }],
      // Evidence: granted at the point of capture and superseded by a later row,
      // never edited. The API refuses PATCH and DELETE (immutable), so there is
      // no update permission here — recording a migrated consent is a new row.
      columns: [
        { name: "customerId", type: "text" },
        { name: "source", type: "text", badge: true },
        { name: "purposesJson", type: "json" },
        { name: "channelOptinsJson", type: "json" },
        { name: "evidenceRef", type: "text" },
        { name: "version", type: "number" },
        { name: "expiry", type: "datetime" },
        { name: "ts", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "customerId", type: "text", required: true },
        {
          name: "source",
          type: "select",
          required: true,
          options: ["web", "whatsapp", "import", "agent", "portal"]
        },
        { name: "purposesJson", type: "json", required: true },
        { name: "channelOptinsJson", type: "json", required: true },
        { name: "ts", type: "datetime", required: true },
        { name: "evidenceRef", type: "text" },
        { name: "expiry", type: "datetime" }
      ]
    },
    {
      key: "products",
      api: "/v1/core/products",
      read: "core:products:read",
      create: "core:products:write",
      update: "core:products:write",
      remove: "core:products:write",
      search: true,
      filters: [
        {
          name: "line",
          options: [
            "motor",
            "health",
            "travel",
            "home",
            "life",
            "sme",
            "card",
            "loan",
            "account"
          ]
        },
        { name: "structure", options: ["conventional", "takaful", "parametric"] }
      ],
      columns: [
        { name: "nameJson", type: "json" },
        { name: "line", type: "text", sortable: true },
        { name: "providerId", type: "text" },
        { name: "structure", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "nameJson", type: "json", required: true },
        {
          name: "line",
          type: "select",
          required: true,
          options: ["motor", "health", "travel", "home", "life", "sme", "card", "loan", "account"]
        },
        { name: "providerId", type: "text" },
        { name: "termsRef", type: "text" },
        {
          name: "structure",
          type: "select",
          options: ["conventional", "takaful", "parametric"]
        },
        { name: "pricingInputsJson", type: "json" }
      ],
      editable: [
        { name: "nameJson", type: "json" },
        { name: "status", type: "text" },
        { name: "providerId", type: "text" },
        { name: "termsRef", type: "text" },
        { name: "pricingInputsJson", type: "json" }
      ]
    },
    {
      key: "providers",
      api: "/v1/core/providers",
      read: "core:providers:read",
      create: "core:providers:write",
      update: "core:providers:write",
      remove: "core:providers:write",
      search: true,
      filters: [{ name: "kind", options: ["insurer", "bank", "financier"] }],
      columns: [
        { name: "name", type: "text" },
        { name: "kind", type: "text" },
        { name: "isInternal", type: "boolean" },
        { name: "linesJson", type: "json" },
        { name: "currency", type: "text" },
        { name: "panelStatus", type: "text", badge: true, sortable: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Quote endpoints carry credentials by reference only (schema comment), so
      // that column stays off both forms.
      fields: [
        { name: "name", type: "text", required: true },
        { name: "kind", type: "select", required: true, options: ["insurer", "bank", "financier"] },
        { name: "isInternal", type: "boolean" },
        { name: "linesJson", type: "json" },
        { name: "currency", type: "text" },
        { name: "commissionJson", type: "json" },
        { name: "settlementTermsJson", type: "json" }
      ],
      editable: [
        { name: "name", type: "text" },
        { name: "panelStatus", type: "text" },
        { name: "linesJson", type: "json" },
        { name: "currency", type: "text" },
        { name: "commissionJson", type: "json" },
        { name: "settlementTermsJson", type: "json" }
      ]
    },
    {
      key: "files",
      api: "/v1/core/files",
      read: "core:files:read",
      remove: "core:files:delete",
      search: true,
      filters: [{ name: "piiLevel", options: ["none", "low", "high"] }],
      // Upload is a signed-URL flow, not a form: this tab is the register and
      // the delete affordance.
      columns: [
        { name: "r2Key", type: "text" },
        { name: "kind", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "contentType", type: "text" },
        { name: "sizeBytes", type: "number" },
        { name: "piiLevel", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },

    /* ------------------------------------------------------ core: governance */
    {
      key: "approvals",
      api: "/v1/core/approvals",
      read: "core:approvals:read",
      sort: "requestedAt",
      filters: [{ name: "decision", options: ["pending", "approved", "rejected"] }],
      // The queue is read here; deciding happens on the record that raised it,
      // which is where the context lives (CLAUDE.md rule 4).
      columns: [
        { name: "policyKey", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "module", type: "text" },
        { name: "decision", type: "text", badge: true },
        { name: "reason", type: "text" },
        { name: "contextJson", type: "json" },
        { name: "requestedBy", type: "text" },
        { name: "requestedAt", type: "datetime", sortable: true },
        { name: "decidedBy", type: "text" },
        { name: "decidedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "mandates",
      api: "/v1/core/mandates",
      read: "core:settings:read",
      create: "core:settings:update",
      update: "core:settings:update",
      remove: "core:settings:update",
      columns: [
        { name: "principalRef", type: "text" },
        { name: "agentIdentity", type: "text" },
        { name: "spendCapMinor", type: "money", currencyFrom: "currency" },
        { name: "status", type: "text", badge: true },
        { name: "verificationRef", type: "text" },
        { name: "expiry", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // H1 seam (docs/16): the delegated authority an agent acts under. The
      // principal names it here; the cap, scope and expiry are what bound it.
      fields: [
        { name: "principalRef", type: "text", required: true },
        { name: "agentIdentity", type: "text", required: true },
        { name: "scopeJson", type: "json", required: true },
        { name: "spendCapMinor", type: "money" },
        { name: "currency", type: "text" },
        { name: "verificationRef", type: "text" },
        { name: "expiry", type: "datetime" }
      ],
      editable: [
        { name: "status", type: "text" },
        { name: "spendCapMinor", type: "money" },
        { name: "expiry", type: "datetime" },
        { name: "scopeJson", type: "json" }
      ]
    },
    {
      key: "identity-verifications",
      api: "/v1/core/identity-verifications",
      read: "core:customers:read",
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "method", type: "text" },
        { name: "evidenceLevel", type: "text", badge: true },
        { name: "providerRef", type: "text" },
        { name: "expiry", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "memories",
      api: "/v1/core/memories",
      read: "core:settings:read",
      create: "core:settings:update",
      update: "core:settings:update",
      remove: "core:settings:update",
      columns: [
        { name: "subjectRef", type: "text" },
        { name: "kind", type: "text" },
        { name: "provenance", type: "text" },
        { name: "sensitivity", type: "text", badge: true },
        { name: "expiry", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Erasure reaches in here: a memory is deletable and purpose-bound, never
      // an unbounded profile — so provenance and purpose are named at write time.
      fields: [
        { name: "subjectRef", type: "text", required: true },
        { name: "kind", type: "text", required: true },
        { name: "contentJson", type: "json", required: true },
        { name: "provenance", type: "text", required: true },
        { name: "sensitivity", type: "text" },
        { name: "purposesJson", type: "json" },
        { name: "expiry", type: "datetime" }
      ],
      editable: [
        { name: "sensitivity", type: "text" },
        { name: "purposesJson", type: "json" },
        { name: "expiry", type: "datetime" }
      ]
    },
    {
      key: "lenses",
      api: "/v1/core/lenses",
      read: "core:settings:read",
      create: "core:settings:update",
      update: "core:settings:update",
      remove: "core:settings:update",
      columns: [
        { name: "userId", type: "text" },
        { name: "lensJson", type: "json" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "userId", type: "text", required: true },
        { name: "lensJson", type: "json", required: true }
      ],
      editable: [{ name: "lensJson", type: "json" }]
    },
    {
      key: "rulepacks",
      api: "/v1/core/rulepacks",
      read: "compliance:rulepacks:read",
      create: "compliance:rulepacks:apply",
      update: "compliance:rulepacks:apply",
      sort: "effectiveAt",
      columns: [
        { name: "market", type: "text" },
        { name: "version", type: "text" },
        { name: "effectiveAt", type: "datetime", sortable: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // Regulation as data (H12): a pack is pasted in whole and dated, never
      // authored rule by rule in a browser. There is no delete — a pack that
      // stopped applying is superseded by a later effectiveAt.
      fields: [
        { name: "market", type: "text", required: true },
        { name: "version", type: "text", required: true },
        { name: "effectiveAt", type: "datetime", required: true },
        { name: "rulesJson", type: "json", required: true }
      ],
      editable: [
        { name: "effectiveAt", type: "datetime" },
        { name: "rulesJson", type: "json" }
      ]
    },

    /* ----------------------------------------------------- core: connections */
    {
      key: "api-keys",
      api: "/v1/core/api-keys",
      read: "core:api_keys:read",
      remove: "core:api_keys:revoke",
      filters: [{ name: "mode", options: ["test", "live"] }],
      // The key itself is shown once, at issue, and stored only as a hash. What
      // remains here is the prefix — enough to recognise it, useless to replay.
      columns: [
        { name: "name", type: "text" },
        { name: "prefix", type: "text" },
        { name: "mode", type: "text", badge: true },
        { name: "scopesJson", type: "json" },
        { name: "lastUsedAt", type: "datetime", sortable: true },
        { name: "expiresAt", type: "datetime" },
        { name: "revokedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "identity-providers",
      api: "/v1/core/identity-providers",
      read: "core:identity_providers:read",
      create: "core:identity_providers:write",
      update: "core:identity_providers:write",
      remove: "core:identity_providers:write",
      search: true,
      filters: [{ name: "kind", options: ["oidc", "saml"] }],
      columns: [
        { name: "name", type: "text" },
        { name: "kind", type: "text" },
        { name: "emailDomain", type: "text" },
        { name: "issuer", type: "text" },
        { name: "enabled", type: "boolean" },
        { name: "mfaAsserted", type: "boolean" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // The client secret is a wrangler secret named by the row, never a value
      // in it — so it is not on this form, and routes/sso.ts owns binding it.
      fields: [
        { name: "name", type: "text", required: true },
        { name: "kind", type: "select", required: true, options: ["oidc", "saml"] },
        { name: "emailDomain", type: "text", required: true },
        { name: "issuer", type: "text", required: true },
        { name: "clientId", type: "text" },
        { name: "discoveryUrl", type: "text" },
        { name: "defaultRoleKey", type: "text" }
      ],
      editable: [
        { name: "name", type: "text" },
        { name: "emailDomain", type: "text" },
        { name: "issuer", type: "text" },
        { name: "clientId", type: "text" },
        { name: "discoveryUrl", type: "text" },
        { name: "defaultRoleKey", type: "text" },
        { name: "enabled", type: "boolean" },
        { name: "mfaAsserted", type: "boolean" }
      ]
    },
    {
      key: "webhooks",
      api: "/v1/core/webhooks",
      read: "core:webhooks:read",
      create: "core:webhooks:write",
      update: "core:webhooks:write",
      remove: "core:webhooks:write",
      columns: [
        { name: "url", type: "text" },
        { name: "eventTypesJson", type: "json" },
        { name: "status", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // The signing secret is generated server-side and shown once; it is never
      // a column and never a field. The create response is the only place it
      // ever appears, so the create flow reveals it there and nowhere else.
      revealOnCreate: "secret",
      fields: [
        { name: "url", type: "text", required: true },
        { name: "eventTypesJson", type: "json", required: true }
      ],
      editable: [
        { name: "url", type: "text" },
        { name: "eventTypesJson", type: "json" },
        { name: "status", type: "text" }
      ]
    },
    {
      key: "webhook-deliveries",
      api: "/v1/core/webhook-deliveries",
      read: "core:webhooks:read",
      filters: [{ name: "status", options: ["pending", "delivered", "failed", "dead"] }],
      columns: [
        { name: "webhookId", type: "text" },
        { name: "eventId", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "responseCode", type: "number" },
        { name: "error", type: "text" },
        { name: "attempts", type: "number" },
        { name: "nextAttemptAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "notifications",
      api: "/v1/core/notifications",
      read: "core:notifications:read",
      columns: [
        { name: "titleKey", type: "text" },
        { name: "kind", type: "text" },
        { name: "userId", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "readAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "audit-log",
      api: "/v1/core/audit-log",
      read: "core:audit:read",
      sort: "ts",
      // Hash-chained and append-only: readable, exportable, never writable — an
      // edit affordance here would be a defect, not a feature.
      columns: [
        { name: "action", type: "text" },
        { name: "actorRef", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "ip", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "event-dlq",
      api: "/v1/core/event-dlq",
      read: "admin:dlq:read",
      columns: [
        { name: "type", type: "text" },
        { name: "consumer", type: "text" },
        { name: "error", type: "text" },
        { name: "envelopeJson", type: "json" },
        { name: "attempts", type: "number" },
        { name: "replayedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "message-templates",
      api: "/v1/core/message-templates",
      read: "core:templates:read",
      create: "core:templates:write",
      update: "core:templates:write",
      remove: "core:templates:write",
      search: true,
      filters: [{ name: "channel", options: ["email", "sms", "whatsapp", "push"] }],
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "channel", type: "text", badge: true },
        { name: "bodyJson", type: "json" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "channel", type: "select", required: true, options: ["email", "sms", "whatsapp", "push"] },
        { name: "subjectJson", type: "json" },
        { name: "bodyJson", type: "json", required: true },
        { name: "variablesJson", type: "json" }
      ],
      editable: [
        { name: "subjectJson", type: "json" },
        { name: "bodyJson", type: "json" },
        { name: "variablesJson", type: "json" }
      ]
    },
    {
      key: "locale-overrides",
      api: "/v1/core/locale-overrides",
      read: "core:locale_overrides:read",
      create: "core:locale_overrides:write",
      update: "core:locale_overrides:write",
      remove: "core:locale_overrides:write",
      search: true,
      sort: "updatedAt",
      filters: [{ name: "locale", options: ["en", "ar"] }],
      // i18n.ts's translator() merges these over the static catalogue at
      // request time (apps/web/app/routes/workspace.tsx) — a relabel here
      // takes effect on the caller's next request, no deploy required.
      columns: [
        { name: "locale", type: "text" },
        { name: "key", type: "text", sortable: true },
        { name: "value", type: "text" },
        { name: "updatedBy", type: "text" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "locale", type: "select", required: true, options: ["en", "ar"] },
        { name: "key", type: "text", required: true },
        { name: "value", type: "text", required: true },
        { name: "updatedBy", type: "text", required: true }
      ],
      editable: [
        { name: "value", type: "text" },
        { name: "updatedBy", type: "text" }
      ]
    },

    /* ------------------------------------------------------------------- ai */
    {
      key: "agents",
      api: "/v1/ai/agents",
      read: "ai:agents:read",
      create: "ai:agents:write",
      update: "ai:agents:write",
      remove: "ai:agents:write",
      sort: "updatedAt",
      filters: [
        { name: "status", options: ["active", "paused", "retired"] },
        { name: "tier", options: ["fast", "standard", "reasoning"] }
      ],
      // Registering an agent is hiring one: a name, the module it works in, the
      // tools it may reach for and the autonomy it acts under (docs/16 seam).
      columns: [
        { name: "key", type: "text" },
        { name: "module", type: "text" },
        { name: "autonomyLevel", type: "text", badge: true },
        { name: "tier", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "promptRef", type: "text" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "module", type: "text", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "descriptionJson", type: "json" },
        {
          name: "autonomyLevel",
          type: "select",
          // `ai_agents.autonomy_level`, whose ladder is AGENT_AUTONOMY — not the
          // campaign ladder next to it (packages/db/src/json.ts, ADR-0049). The
          // rungs offered here used to be the campaign's, so picking one wrote a
          // word the API rejects (docs/ui.md §7 item 9).
          options: ["suggest", "act_with_approval", "act_within_limits", "autonomous"]
        },
        { name: "tier", type: "select", options: ["fast", "standard", "reasoning"] },
        { name: "toolsJson", type: "json" },
        { name: "guardrailsJson", type: "json" },
        { name: "promptRef", type: "text" }
      ],
      editable: [
        { name: "status", type: "select", options: ["active", "paused", "retired"] },
        {
          name: "autonomyLevel",
          type: "select",
          // `ai_agents.autonomy_level`, whose ladder is AGENT_AUTONOMY — not the
          // campaign ladder next to it (packages/db/src/json.ts, ADR-0049). The
          // rungs offered here used to be the campaign's, so picking one wrote a
          // word the API rejects (docs/ui.md §7 item 9).
          options: ["suggest", "act_with_approval", "act_within_limits", "autonomous"]
        },
        { name: "tier", type: "select", options: ["fast", "standard", "reasoning"] },
        { name: "toolsJson", type: "json" },
        { name: "guardrailsJson", type: "json" },
        { name: "promptRef", type: "text" },
        { name: "pausedReason", type: "text" }
      ]
    },
    {
      key: "prompts",
      api: "/v1/ai/prompts",
      read: "ai:prompts:read",
      create: "ai:prompts:write",
      update: "ai:prompts:write",
      remove: "ai:prompts:write",
      filters: [{ name: "status", options: ["draft", "active", "retired"] }],
      // Versioned, per locale, and published through an approval — never inlined
      // in code (schema comment; resources.ts ai.prompt_publish).
      columns: [
        { name: "key", type: "text" },
        { name: "version", type: "number" },
        { name: "locale", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "createdBy", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "version", type: "number", required: true },
        { name: "locale", type: "text", required: true },
        { name: "body", type: "textarea", required: true },
        { name: "variablesJson", type: "json" }
      ],
      editable: [
        { name: "body", type: "textarea" },
        { name: "variablesJson", type: "json" },
        { name: "status", type: "select", options: ["draft", "active", "retired"] }
      ]
    },
    {
      key: "runs",
      api: "/v1/ai/runs",
      read: "ai:runs:read",
      sort: "startedAt",
      recordLink: { href: "/admin/ai/runs/{id}", labelKey: "runDetail" },
      filters: [
        {
          name: "state",
          options: [
            "running",
            "awaiting_approval",
            "succeeded",
            "refused",
            "failed",
            "cancelled",
            "budget_stopped"
          ]
        },
        { name: "trigger", options: ["user", "event", "schedule", "api"] }
      ],
      // Written by the runtime, read by everyone: what an agent was asked, what
      // it decided, how sure it was and what it cost.
      columns: [
        { name: "agentKey", type: "text" },
        { name: "module", type: "text" },
        { name: "purpose", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "trigger", type: "text" },
        { name: "autonomyLevel", type: "text", badge: true },
        { name: "actorRef", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "confidence", type: "number" },
        { name: "evidenceJson", type: "json" },
        { name: "approvalId", type: "text" },
        { name: "tokensIn", type: "number" },
        { name: "tokensOut", type: "number" },
        { name: "costMicro", type: "number" },
        { name: "latencyMs", type: "number" },
        { name: "errorCode", type: "text" },
        { name: "startedAt", type: "datetime", sortable: true },
        { name: "endedAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "tool-calls",
      api: "/v1/ai/tool-calls",
      read: "ai:runs:read",
      sort: "ts",
      filters: [{ name: "outcome", options: ["ok", "error", "blocked", "awaiting_approval"] }],
      columns: [
        { name: "tool", type: "text" },
        { name: "runId", type: "text" },
        { name: "seq", type: "number" },
        { name: "consequential", type: "boolean" },
        { name: "outcome", type: "text", badge: true },
        { name: "durationMs", type: "number" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "suggestions",
      api: "/v1/ai/suggestions",
      read: "ai:suggestions:read",
      update: "ai:suggestions:read",
      sort: "shownAt",
      filters: [
        { name: "surface", options: ["ghost_text", "chip", "draft", "forecast", "filter"] },
        { name: "outcome", options: ["shown", "accepted", "edited", "dismissed", "expired"] }
      ],
      // The receipt for the ambient grammar (docs/15 §4): a surface that is
      // dismissed more than it is accepted has not earned its place.
      columns: [
        { name: "surface", type: "text", badge: true },
        { name: "module", type: "text" },
        { name: "userId", type: "text" },
        { name: "outcome", type: "text", badge: true },
        { name: "editDistance", type: "number" },
        { name: "shownAt", type: "datetime", sortable: true },
        { name: "resolvedAt", type: "datetime" }
      ],
      // The surface itself resolves a suggestion through POST /suggestions/:id/
      // outcome. Correcting a stuck row by hand is the only reason to edit here,
      // so nothing but the outcome and its distance is writable.
      editable: [
        {
          name: "outcome",
          type: "select",
          options: ["shown", "accepted", "edited", "dismissed", "expired"]
        },
        { name: "editDistance", type: "number" }
      ]
    },
    {
      key: "budgets",
      api: "/v1/ai/budgets",
      read: "ai:budgets:read",
      update: "ai:budgets:write",
      sort: "day",
      columns: [
        { name: "day", type: "text", sortable: true },
        { name: "module", type: "text" },
        { name: "tokensUsed", type: "number" },
        { name: "tokensLimit", type: "number" },
        { name: "costMicroUsed", type: "number" },
        { name: "costMicroLimit", type: "number" },
        { name: "stoppedAt", type: "datetime" },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      // Rows are opened by the runtime; the only human act is moving a ceiling,
      // and raising one goes through ai.budget_raise. Create and delete stay off
      // deliberately: only update is approval-gated, so a delete-and-recreate
      // pair would be an ungated ceiling raise that also erases the day's spend.
      editable: [
        { name: "tokensLimit", type: "number" },
        { name: "costMicroLimit", type: "number" }
      ]
    },
    {
      key: "evals",
      api: "/v1/ai/evals",
      read: "ai:evals:read",
      create: "ai:evals:run",
      sort: "ts",
      // Eval-first is the law (CLAUDE.md §4); this is the scoreboard, and the
      // golden set that produced it lives in packages/model-gateway/evals. Rows
      // are posted by the runner — the form is the manual path for a suite run
      // outside CI, and a result is never edited once recorded.
      columns: [
        { name: "suite", type: "text" },
        { name: "caseKey", type: "text" },
        { name: "agentKey", type: "text" },
        { name: "model", type: "text" },
        { name: "score", type: "number" },
        { name: "thresholdScore", type: "number" },
        { name: "passed", type: "boolean" },
        { name: "detailJson", type: "json" },
        { name: "gitSha", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "suite", type: "text", required: true },
        { name: "caseKey", type: "text", required: true },
        { name: "agentKey", type: "text", required: true },
        { name: "model", type: "text", required: true },
        { name: "score", type: "number", required: true },
        { name: "thresholdScore", type: "number", required: true },
        { name: "passed", type: "boolean", required: true },
        { name: "ts", type: "datetime", required: true },
        { name: "detailJson", type: "json" },
        { name: "gitSha", type: "text" }
      ]
    },
    {
      key: "knowledge-sources",
      api: "/v1/ai/knowledge-sources",
      read: "ai:prompts:read",
      create: "ai:prompts:write",
      update: "ai:prompts:write",
      remove: "ai:prompts:write",
      filters: [
        {
          name: "kind",
          options: ["policy_wording", "sop", "faq", "product", "regulatory", "web"]
        },
        { name: "status", options: ["pending", "indexing", "ready", "failed", "stale"] }
      ],
      columns: [
        { name: "name", type: "text" },
        { name: "kind", type: "text", badge: true },
        { name: "locale", type: "text" },
        { name: "piiLevel", type: "text", badge: true },
        { name: "chunkCount", type: "number" },
        { name: "status", type: "text", badge: true },
        { name: "lastIndexedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "name", type: "text", required: true },
        {
          name: "kind",
          type: "select",
          required: true,
          options: ["policy_wording", "sop", "faq", "product", "regulatory", "web"]
        },
        { name: "uri", type: "text" },
        { name: "fileId", type: "text" },
        { name: "locale", type: "text" },
        { name: "piiLevel", type: "select", options: ["none", "low", "high"] }
      ],
      editable: [
        { name: "name", type: "text" },
        { name: "uri", type: "text" },
        { name: "locale", type: "text" },
        { name: "piiLevel", type: "select", options: ["none", "low", "high"] },
        { name: "status", type: "select", options: ["pending", "indexing", "ready", "failed", "stale"] }
      ]
    },
    {
      key: "guardrail-events",
      api: "/v1/ai/guardrail-events",
      read: "ai:audit:read",
      sort: "ts",
      filters: [{ name: "severity", options: ["info", "warn", "block"] }],
      columns: [
        { name: "rule", type: "text" },
        { name: "severity", type: "text", badge: true },
        { name: "detail", type: "text" },
        { name: "runId", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "ai-audit-log",
      api: "/v1/ai/ai-audit-log",
      read: "ai:audit:read",
      sort: "ts",
      filters: [
        { name: "tier", options: ["fast", "standard", "reasoning"] },
        { name: "outcome", options: ["ok", "refused", "error", "budget_exceeded", "killed"] }
      ],
      // Every model call the gateway made, hashes only — which is what makes it
      // safe to hand an auditor whole (CLAUDE.md rule 3).
      columns: [
        { name: "module", type: "text" },
        { name: "purpose", type: "text" },
        { name: "model", type: "text" },
        { name: "provider", type: "text" },
        { name: "tier", type: "text", badge: true },
        { name: "outcome", type: "text", badge: true },
        { name: "actorRef", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "toolCallsJson", type: "json" },
        { name: "guardrailFlagsJson", type: "json" },
        { name: "tokensIn", type: "number" },
        { name: "tokensOut", type: "number" },
        { name: "costMicro", type: "number" },
        { name: "latencyMs", type: "number" },
        { name: "ts", type: "datetime", sortable: true }
      ]
    }
  ],
  links: [
    { href: "/admin/ai/console", labelKey: "aiConsole", permission: "ai:runs:read" },
    { href: "/admin/ai/budget", labelKey: "aiBudget", permission: "ai:budgets:read" },
    { href: "/admin/cost-explorer", labelKey: "costExplorer", permission: "analytics:reports:read" },
    // ADR-0085: every record note the reader may open, as an Obsidian vault.
    // A file, not a screen — so the strip opens it as a document download.
    { href: "/memory/export", labelKey: "notesVault", permission: "core:notes:read", download: true },
    { href: "/admin/staff", labelKey: "staff", permission: "core:users:read" },
    { href: "/admin/permissions", labelKey: "permissionMatrix", permission: "core:roles:read" },
    { href: "/admin/developer", labelKey: "developer", permission: "core:api_keys:read" },
    { href: "/admin/security", labelKey: "security", permission: "core:settings:read" },
    // Brand, billing and DSARs live in surfaces another workspace already owns
    // (settings owns the one validated brand editor; the ledger owns money).
    // Linking beats a second implementation of either.
    { href: "/settings", labelKey: "brandTheme", permission: "core:tenants:update" },
    { href: "/ledger/invoices", labelKey: "billingPlan", permission: "ledger:invoices:read" },
    { href: "/compliance/dsar-requests", labelKey: "dataRequests", permission: "compliance:dsar:read" }
  ]
};
