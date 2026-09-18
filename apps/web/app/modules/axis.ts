import type { WorkspaceSpec } from "./spec";

// AXIS — operations. The case is the unit of work (docs/03 §AXIS): everything
// else on this workspace either feeds a case (documents, tasks, quotes) or is
// what a case produced (policies, claims, escrow).
//
// The tabs are the lists. The screens that are not lists — the exception queue,
// the production board, the quote desk, document intelligence, the operations
// dashboard — are bespoke routes reached through `links`, and reconciliation and
// the rulepacks are cross-links to the workspaces that already own them.

export const axis: WorkspaceSpec = {
  path: "/axis",
  labels: {
    en: {
      cases: "Cases",
      quotes: "Quotes",
      documents: "Documents",
      tasks: "Tasks",
      policies: "Policies",
      claims: "Claims",
      "escrow-batches": "Escrow",
      sops: "Procedures",
      "process-events": "Process events",
      "case-approvals": "Case approvals",
      "ops-policies": "Operating policies",
      complaints: "Complaints",
      "siu-referrals": "Fraud investigations",

      ref: "Reference",
      kind: "Kind",
      status: "Status",
      priority: "Priority",
      source: "Source",
      slaDueAt: "SLA due",
      ownerRef: "Owner",
      customerId: "Customer",
      productLine: "Product line",
      channelId: "Channel",
      quoteRequestId: "Quote request",
      closedAt: "Closed",
      evidenceFileId: "Evidence file",
      riskScore: "Risk",
      valueMinor: "Value",
      currency: "Currency",
      caseId: "Case",
      providerId: "Provider",
      offeringId: "Offering",
      premiumMinor: "Premium",
      validUntil: "Valid until",
      winFlag: "Won",
      declineReason: "Decline reason",
      docType: "Document type",
      fileId: "File",
      extractionJson: "Extraction",
      extractionConfidence: "Extraction confidence",
      extractionModel: "Extraction model",
      verifiedAt: "Verified",
      verifiedBy: "Verified by",
      type: "Type",
      titleKey: "Title",
      assigneeRef: "Assignee",
      state: "State",
      dueAt: "Due",
      completedAt: "Completed",
      policyNo: "Policy number",
      startAt: "Starts",
      endAt: "Ends",
      commissionMinor: "Commission",
      docsJson: "Documents",
      escrowBatchId: "Escrow batch",
      paymentPlanJson: "Payment plan",
      productId: "Product",
      claimNo: "Claim number",
      policyId: "Policy",
      incidentAt: "Incident",
      reportedAt: "Reported",
      amountMinor: "Claimed",
      settledMinor: "Settled",
      assessorRef: "Assessor",
      period: "Period",
      expectedMinor: "Expected",
      receivedMinor: "Received",
      varianceReason: "Variance reason",
      key: "Key",
      version: "Version",
      appliesTo: "Applies to",
      step: "Step",
      actorRef: "Actor",
      durationMs: "Duration",
      outcome: "Outcome",
      ts: "When",
      createdAt: "Created",
      updatedAt: "Updated",
      policyKey: "Policy",
      decision: "Decision",
      subjectRef: "Subject",
      metaJson: "Details",
      coverageJson: "Coverage",
      fnolJson: "First notice",
      checklistJson: "Checklist",
      stepsJson: "Steps",
      nameJson: "Name",
      teamId: "Team",
      rawText: "Document text",
      locale: "Language",

      // Enum values. Without these every badge and every option on this
      // workspace rendered a humanised English string in both locales.
      "status.intake": "Intake",
      "status.quoting": "Quoting",
      "status.awaiting_docs": "Awaiting documents",
      "status.review": "In review",
      "status.approval": "Awaiting approval",
      "status.issued": "Issued",
      "status.failed": "Failed",
      "status.cancelled": "Cancelled",
      "status.received": "Received",
      "status.extracting": "Extracting",
      "status.extracted": "Extracted",
      "status.verified": "Verified",
      "status.rejected": "Rejected",
      "status.active": "Active",
      "status.lapsed": "Lapsed",
      "status.renewed": "Renewed",
      "status.reported": "Reported",
      "status.triage": "Triage",
      "status.assessing": "Assessing",
      "status.settling": "Settling",
      "status.recovering": "Recovering",
      "status.reopened": "Reopened",
      "status.bound": "Bound",
      "status.expired": "Expired",
      "status.ntu": "Not taken up",
      "status.approved": "Approved",
      "status.settled": "Settled",
      "status.withdrawn": "Withdrawn",
      "status.open": "Open",
      "status.reconciling": "Reconciling",
      "status.matched": "Matched",
      "status.variance": "Variance",
      "status.closed": "Closed",
      "status.draft": "Draft",
      "status.retired": "Retired",
      "priority.low": "Low",
      "priority.normal": "Normal",
      "priority.high": "High",
      "priority.urgent": "Urgent",
      "kind.quote": "Quote",
      "kind.bind": "Bind",
      "kind.endorse": "Endorsement",
      "kind.renewal_ops": "Renewal",
      "kind.group_medical": "Group scheme",
      "kind.kyc": "Identity check",
      "kind.claim": "Claim",
      "source.web": "Web",
      "source.orbit": "Conversation",
      "source.partner": "Partner",
      "source.import": "Import",
      "source.api": "API",
      "source.agent": "Agent",
      "source.manual": "Entered by hand",
      "source.portal": "Provider portal",
      "source.ai_extract": "Extracted by model",
      "state.open": "Open",
      "state.in_progress": "In progress",
      "state.blocked": "Blocked",
      "state.done": "Done",
      "state.cancelled": "Cancelled",
      "docType.eid": "Identity card",
      "docType.mulkiya": "Vehicle registration",
      "docType.census": "Member schedule",
      "docType.medical": "Medical report",
      "docType.tradelicense": "Trade licence",
      "docType.other": "Other",
      "decision.pending": "Pending",
      "decision.approved": "Approved",
      "decision.rejected": "Rejected",
      "outcome.ok": "Completed",
      "outcome.timeout": "Timed out",
      "outcome.error": "Errored",
      "outcome.skipped": "Skipped",
      "locale.en": "English",
      "locale.ar": "Arabic",

      // Conduct registers (docs/27 §D.8).
      channel: "Channel",
      categoryCode: "Category",
      summarySealed: "What happened",
      receivedAt: "Received",
      acknowledgedAt: "Acknowledged",
      resolvedAt: "Resolved",
      rootCauseCode: "Root cause",
      redressMinor: "Redress",
      regulatorRef: "Regulator reference",
      score: "Score",
      reasonsJson: "Indicators",
      assignedTo: "Investigator",
      savedMinor: "Leakage prevented",
      openedAt: "Opened",
      "claims.statusHint": "Settling and settled follow a payment, so they are not offered here.",
      "complaints.summaryHint": "Sealed at rest: only staff with the complaint permission can read it back.",
      "complaints.redressHint": "Anything above zero needs a second approver before it saves.",
      "siu.savedHint": "What the investigation stopped going out the door.",
      "channel.web": "Web",
      "channel.phone": "Phone",
      "channel.email": "Email",
      "channel.whatsapp": "WhatsApp",
      "channel.regulator": "Regulator",
      "channel.social": "Social",
      "state.received": "Received",
      "state.investigating": "Investigating",
      "state.awaiting_customer": "Awaiting customer",
      "state.resolved": "Resolved",
      "state.escalated": "Escalated",
      "state.closed": "Closed",
      "state.substantiated": "Substantiated",
      "state.unsubstantiated": "Cleared",
      "outcome.upheld": "Upheld",
      "outcome.partly_upheld": "Partly upheld",
      "outcome.not_upheld": "Not upheld",
      "outcome.withdrawn": "Withdrawn",
      "source.model": "Model",
      "source.handler": "Handler",
      "source.insurer": "Insurer",
      "source.tip": "Tip-off",

      // Record actions the API owns (apps/api/src/routes/axis.ts).
      "documents.verify": "Verify",
      "documents.verify.confirm":
        "Verification is stamped with your name and cannot be undone. Verify this document?",
      "documents.extract": "Read with the model",
      "policies.ntu": "Not taken up",
      "policies.ntu.confirm":
        "The contract never went on risk: the whole premium goes back and the whole commission is clawed back. Record it as not taken up?",
      "policies.ntu.collected": "Premium already banked, if any. It comes straight back.",
      "policies.lapse": "Lapse for non-payment",
      "policies.lapse.confirm":
        "Cover stops and the commission stops accruing from this instalment. Lapse this contract?",
      "policies.lapse.missedSeq": "Which instalment went unpaid — the first one is 0.",
      "policies.reinstate": "Reinstate",
      "policies.reinstate.confirm":
        "Cover resumes and commission re-earns against the arrears paid. Reinstate this contract?",
      "policies.reinstate.arrears": "Amount collected to clear the arrears.",
      reasonCode: "Reason code",
      reason: "Reason",
      note: "Note",
      missedSeq: "Missed instalment",
      collectedMinor: "Collected",
      arrearsMinor: "Arrears paid",

      // Bespoke screens this workspace links out to.
      "link.exceptions": "Exception queue",
      "link.board": "Production board",
      "link.quoteDesk": "Quote desk",
      "link.groupBids": "Group bids",
      "link.docIntel": "Document intelligence",
      "link.analytics": "Operations analytics",
      "link.recon": "Reconciliation",
      "link.rulepacks": "Automation rules",
      "link.ruleApplications": "Rule applications",
      "link.admin": "AXIS admin",
      "link.processMap": "Process map",
      "link.claimsDesk": "Claims desk",
      "link.renewals": "Renewal desk",
      "link.referrals": "Referral desk"
    },
    ar: {
      cases: "الحالات",
      quotes: "عروض الأسعار",
      documents: "المستندات",
      tasks: "المهام",
      policies: "الوثائق",
      claims: "المطالبات",
      "escrow-batches": "الضمان",
      sops: "الإجراءات",
      "process-events": "أحداث العملية",
      "case-approvals": "موافقات الحالة",
      "ops-policies": "سياسات التشغيل",
      complaints: "الشكاوى",
      "siu-referrals": "تحقيقات الاحتيال",

      ref: "المرجع",
      kind: "النوع",
      status: "الحالة",
      priority: "الأولوية",
      source: "المصدر",
      slaDueAt: "موعد الاستحقاق",
      ownerRef: "المسؤول",
      customerId: "العميل",
      productLine: "خط المنتج",
      channelId: "القناة",
      quoteRequestId: "طلب عرض السعر",
      closedAt: "تاريخ الإغلاق",
      evidenceFileId: "ملف الإثبات",
      riskScore: "المخاطر",
      valueMinor: "القيمة",
      currency: "العملة",
      caseId: "الحالة",
      providerId: "المزود",
      offeringId: "العرض",
      premiumMinor: "القسط",
      validUntil: "صالح حتى",
      winFlag: "فائز",
      declineReason: "سبب الرفض",
      docType: "نوع المستند",
      fileId: "الملف",
      extractionJson: "بيانات الاستخراج",
      extractionConfidence: "ثقة الاستخراج",
      extractionModel: "نموذج الاستخراج",
      verifiedAt: "تم التحقق",
      verifiedBy: "تحقق بواسطة",
      type: "النوع",
      titleKey: "العنوان",
      assigneeRef: "المكلف",
      state: "الوضع",
      dueAt: "الاستحقاق",
      completedAt: "الإنجاز",
      policyNo: "رقم الوثيقة",
      startAt: "يبدأ",
      endAt: "ينتهي",
      commissionMinor: "العمولة",
      docsJson: "المستندات",
      escrowBatchId: "دفعة الضمان",
      paymentPlanJson: "خطة السداد",
      productId: "المنتج",
      claimNo: "رقم المطالبة",
      policyId: "الوثيقة",
      incidentAt: "الحادث",
      reportedAt: "تاريخ الإبلاغ",
      amountMinor: "المطالب به",
      settledMinor: "المسدد",
      assessorRef: "المقيّم",
      period: "الفترة",
      expectedMinor: "المتوقع",
      receivedMinor: "المستلم",
      varianceReason: "سبب الفرق",
      key: "المفتاح",
      version: "الإصدار",
      appliesTo: "ينطبق على",
      step: "الخطوة",
      actorRef: "الفاعل",
      durationMs: "المدة",
      outcome: "النتيجة",
      ts: "الوقت",
      createdAt: "أُنشئ",
      updatedAt: "حُدّث",
      policyKey: "السياسة",
      decision: "القرار",
      subjectRef: "الموضوع",
      metaJson: "التفاصيل",
      coverageJson: "التغطية",
      fnolJson: "الإخطار الأول",
      checklistJson: "قائمة التحقق",
      stepsJson: "الخطوات",
      nameJson: "الاسم",
      teamId: "الفريق",
      rawText: "نص المستند",
      locale: "اللغة",

      "status.intake": "استلام",
      "status.quoting": "تسعير",
      "status.awaiting_docs": "بانتظار المستندات",
      "status.review": "قيد المراجعة",
      "status.approval": "بانتظار الموافقة",
      "status.issued": "صادرة",
      "status.failed": "فاشلة",
      "status.cancelled": "ملغاة",
      "status.received": "مستلم",
      "status.extracting": "جارٍ الاستخراج",
      "status.extracted": "مستخرج",
      "status.verified": "مُتحقق منه",
      "status.rejected": "مرفوض",
      "status.active": "سارية",
      "status.lapsed": "منتهية",
      "status.renewed": "مُجددة",
      "status.reported": "مُبلّغ عنها",
      "status.triage": "فرز أولي",
      "status.assessing": "قيد التقييم",
      "status.settling": "قيد السداد",
      "status.recovering": "قيد الاسترداد",
      "status.reopened": "أُعيد فتحها",
      "status.bound": "مُبرمة",
      "status.expired": "منتهية",
      "status.ntu": "لم تُفعّل",
      "status.approved": "معتمدة",
      "status.settled": "مسددة",
      "status.withdrawn": "مسحوبة",
      "status.open": "مفتوحة",
      "status.reconciling": "قيد التسوية",
      "status.matched": "مطابقة",
      "status.variance": "فرق",
      "status.closed": "مغلقة",
      "status.draft": "مسودة",
      "status.retired": "مسحوبة",
      "priority.low": "منخفضة",
      "priority.normal": "عادية",
      "priority.high": "عالية",
      "priority.urgent": "عاجلة",
      "kind.quote": "عرض سعر",
      "kind.bind": "إصدار",
      "kind.endorse": "تعديل",
      "kind.renewal_ops": "تجديد",
      "kind.group_medical": "برنامج جماعي",
      "kind.kyc": "التحقق من الهوية",
      "kind.claim": "مطالبة",
      "source.web": "الويب",
      "source.orbit": "محادثة",
      "source.partner": "شريك",
      "source.import": "استيراد",
      "source.api": "واجهة برمجية",
      "source.agent": "وكيل",
      "source.manual": "إدخال يدوي",
      "source.portal": "بوابة المزود",
      "source.ai_extract": "استخراج بالنموذج",
      "state.open": "مفتوحة",
      "state.in_progress": "قيد التنفيذ",
      "state.blocked": "متعطلة",
      "state.done": "منجزة",
      "state.cancelled": "ملغاة",
      "docType.eid": "بطاقة الهوية",
      "docType.mulkiya": "ملكية المركبة",
      "docType.census": "كشف الأعضاء",
      "docType.medical": "تقرير طبي",
      "docType.tradelicense": "الرخصة التجارية",
      "docType.other": "أخرى",
      "decision.pending": "معلّق",
      "decision.approved": "معتمد",
      "decision.rejected": "مرفوض",
      "outcome.ok": "مكتملة",
      "outcome.timeout": "انتهت المهلة",
      "outcome.error": "خطأ",
      "outcome.skipped": "متجاوزة",
      "locale.en": "الإنجليزية",
      "locale.ar": "العربية",

      channel: "القناة",
      categoryCode: "التصنيف",
      summarySealed: "ماذا حدث",
      receivedAt: "تاريخ الاستلام",
      acknowledgedAt: "تاريخ الإقرار",
      resolvedAt: "تاريخ الحل",
      rootCauseCode: "السبب الجذري",
      redressMinor: "التعويض",
      regulatorRef: "مرجع الجهة الرقابية",
      score: "الدرجة",
      reasonsJson: "المؤشرات",
      assignedTo: "المحقق",
      savedMinor: "الخسائر المُتفاداة",
      openedAt: "تاريخ الفتح",
      "claims.statusHint": "حالتا قيد السداد والمسددة تتبعان عملية دفع، لذلك لا تظهران هنا.",
      "complaints.summaryHint": "مُشفَّرة عند التخزين: لا يقرؤها إلا من يملك صلاحية الشكاوى.",
      "complaints.redressHint": "أي مبلغ فوق الصفر يحتاج موافقة ثانية قبل الحفظ.",
      "siu.savedHint": "ما منع التحقيق خروجه من الشركة.",
      "channel.web": "الويب",
      "channel.phone": "الهاتف",
      "channel.email": "البريد الإلكتروني",
      "channel.whatsapp": "واتساب",
      "channel.regulator": "الجهة الرقابية",
      "channel.social": "التواصل الاجتماعي",
      "state.received": "مستلمة",
      "state.investigating": "قيد التحقيق",
      "state.awaiting_customer": "بانتظار العميل",
      "state.resolved": "محلولة",
      "state.escalated": "مُصعَّدة",
      "state.closed": "مغلقة",
      "state.substantiated": "مثبتة",
      "state.unsubstantiated": "غير مثبتة",
      "outcome.upheld": "مقبولة",
      "outcome.partly_upheld": "مقبولة جزئيًا",
      "outcome.not_upheld": "غير مقبولة",
      "outcome.withdrawn": "مسحوبة",
      "source.model": "النموذج",
      "source.handler": "الموظف المسؤول",
      "source.insurer": "شركة التأمين",
      "source.tip": "بلاغ",

      "documents.verify": "التحقق",
      "documents.verify.confirm":
        "يُسجَّل التحقق باسمك ولا يمكن الرجوع عنه. هل تريد التحقق من هذا المستند؟",
      "documents.extract": "القراءة بالنموذج",
      "policies.ntu": "لم يُفعَّل",
      "policies.ntu.confirm":
        "لم يبدأ الغطاء إطلاقًا: يُعاد القسط بالكامل وتُسترد العمولة بالكامل. هل تسجّله كعقد لم يُفعَّل؟",
      "policies.ntu.collected": "القسط المحصَّل إن وُجد. يُعاد كاملًا.",
      "policies.lapse": "الإسقاط لعدم السداد",
      "policies.lapse.confirm": "يتوقف الغطاء وتتوقف العمولة من هذا القسط. هل تسقط هذا العقد؟",
      "policies.lapse.missedSeq": "القسط غير المسدَّد — الأول هو 0.",
      "policies.reinstate": "إعادة السريان",
      "policies.reinstate.confirm": "يعود الغطاء وتُحتسب العمولة مقابل المتأخرات المسدَّدة. هل تعيد سريان العقد؟",
      "policies.reinstate.arrears": "المبلغ المحصَّل لسداد المتأخرات.",
      reasonCode: "رمز السبب",
      reason: "السبب",
      note: "ملاحظة",
      missedSeq: "القسط غير المسدَّد",
      collectedMinor: "المحصَّل",
      arrearsMinor: "المتأخرات المسدَّدة",

      "link.exceptions": "قائمة انتظار الاستثناءات",
      "link.board": "لوحة الإنتاج",
      "link.quoteDesk": "مكتب عروض الأسعار",
      "link.groupBids": "العطاءات الجماعية",
      "link.docIntel": "ذكاء المستندات",
      "link.analytics": "تحليلات التشغيل",
      "link.recon": "التسوية",
      "link.rulepacks": "قواعد الأتمتة",
      "link.ruleApplications": "تطبيقات القواعد",
      "link.admin": "إدارة AXIS",
      "link.processMap": "خريطة العملية",
      "link.claimsDesk": "مكتب المطالبات",
      "link.renewals": "مكتب التجديدات",
      "link.referrals": "مكتب الإحالات"
    }
  },
  // Nothing here is a duplicate of a tab: reconciliation lives in the ledger and
  // the rulepacks in administration/compliance, so AXIS links to them rather
  // than growing a second copy of either.
  links: [
    { href: "/axis/exceptions", labelKey: "link.exceptions", permission: "axis:cases:read" },
    { href: "/axis/board", labelKey: "link.board", permission: "axis:cases:read" },
    { href: "/axis/quote-desk", labelKey: "link.quoteDesk", permission: "axis:quotes:read" },
    // The same desk, scoped to the group/scheme cases — a "bid" in this platform
    // is the set of provider quotes against one group_medical case.
    {
      href: "/axis/quote-desk?kind=group_medical",
      labelKey: "link.groupBids",
      permission: "axis:quotes:read"
    },
    // Not /axis/documents — that path is the documents tab, and a static route
    // would outrank and hide it.
    {
      href: "/axis/doc-intelligence",
      labelKey: "link.docIntel",
      permission: "axis:documents:read"
    },
    // routing.ts described these three as "linked from the AXIS workspace tools
    // list" long before any of them was in this array — the desks were reachable
    // only from a policy detail page, or not at all.
    { href: "/axis/claims/desk", labelKey: "link.claimsDesk", permission: "axis:claims:read" },
    { href: "/axis/renewals", labelKey: "link.renewals", permission: "axis:policies:read" },
    { href: "/axis/referrals", labelKey: "link.referrals", permission: "axis:policies:decide_referral" },
    { href: "/axis/analytics", labelKey: "link.analytics", permission: "axis:metrics:read" },
    { href: "/axis/process-map", labelKey: "link.processMap", permission: "axis:metrics:read" },
    { href: "/ledger/recon", labelKey: "link.recon", permission: "ledger:recon:read" },
    { href: "/admin/rulepacks", labelKey: "link.rulepacks", permission: "compliance:rulepacks:read" },
    {
      href: "/compliance/rulepack-applications",
      labelKey: "link.ruleApplications",
      permission: "compliance:rulepacks:read"
    },
    { href: "/axis/admin", labelKey: "link.admin", permission: "axis:sops:read" }
  ],
  tabs: [
    {
      key: "cases",
      api: "/v1/axis/cases",
      read: "axis:cases:read",
      create: "axis:cases:create",
      update: "axis:cases:update",
      remove: "axis:cases:delete",
      search: true,
      sort: "slaDueAt",
      order: "asc",
      filters: [
        {
          name: "status",
          options: [
            "intake",
            "quoting",
            "awaiting_docs",
            "review",
            "approval",
            "issued",
            "failed",
            "cancelled"
          ]
        },
        { name: "priority", options: ["low", "normal", "high", "urgent"] },
        // A group scheme is worked nothing like a renewal; without this the only
        // way to see one kind of work was to read every row.
        {
          name: "kind",
          options: ["quote", "bind", "endorse", "renewal_ops", "group_medical", "kyc", "claim"]
        }
      ],
      columns: [
        { name: "ref", type: "text", sortable: true },
        // Badge, because only a badge column resolves its value label
        // (components/fields.tsx) — plain text would show the raw enum.
        { name: "kind", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "priority", type: "text", badge: true },
        { name: "ownerRef", type: "text" },
        { name: "quoteRequestId", type: "text" },
        { name: "valueMinor", type: "money", currencyFrom: "currency" },
        { name: "slaDueAt", type: "datetime", sortable: true },
        { name: "closedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "ref", type: "text", required: true },
        {
          name: "kind",
          type: "select",
          required: true,
          options: ["quote", "bind", "endorse", "renewal_ops", "group_medical", "kyc", "claim"]
        },
        { name: "customerId", type: "text" },
        { name: "productLine", type: "text" },
        { name: "channelId", type: "text" },
        { name: "priority", type: "select", options: ["low", "normal", "high", "urgent"] },
        {
          name: "source",
          type: "select",
          options: ["web", "orbit", "partner", "import", "api", "agent"]
        },
        { name: "valueMinor", type: "money" },
        { name: "currency", type: "text" },
        { name: "slaDueAt", type: "datetime" },
        { name: "ownerRef", type: "text" },
        { name: "teamId", type: "text" },
        { name: "metaJson", type: "json" }
      ],
      editable: [
        {
          name: "status",
          type: "select",
          options: [
            "intake",
            "quoting",
            "awaiting_docs",
            "review",
            "approval",
            "issued",
            "failed",
            "cancelled"
          ]
        },
        { name: "priority", type: "select", options: ["low", "normal", "high", "urgent"] },
        { name: "ownerRef", type: "text" },
        { name: "teamId", type: "text" },
        { name: "slaDueAt", type: "datetime" },
        { name: "valueMinor", type: "money" },
        { name: "riskScore", type: "number" },
        { name: "metaJson", type: "json" }
      ]
    },
    {
      // docs/27 F13: history. Quotes are written to `dist_quote_responses` now —
      // this surface reads the cases quoted before the change and nothing else.
      key: "quotes",
      api: "/v1/axis/quotes",
      read: "axis:quotes:read",
      columns: [
        { name: "caseId", type: "text" },
        { name: "providerId", type: "text" },
        { name: "premiumMinor", type: "money", currencyFrom: "currency" },
        { name: "winFlag", type: "boolean" },
        { name: "validUntil", type: "date" },
        { name: "source", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "caseId", type: "text", required: true },
        { name: "providerId", type: "text", required: true },
        { name: "offeringId", type: "text" },
        { name: "premiumMinor", type: "money", required: true },
        { name: "currency", type: "text", required: true },
        { name: "validUntil", type: "date" },
        { name: "coverageJson", type: "json" },
        { name: "declineReason", type: "text" }
      ],
      editable: [
        { name: "premiumMinor", type: "money" },
        { name: "validUntil", type: "date" },
        { name: "winFlag", type: "boolean" },
        { name: "declineReason", type: "text" },
        { name: "coverageJson", type: "json" }
      ]
    },
    {
      key: "documents",
      api: "/v1/axis/documents",
      read: "axis:documents:read",
      create: "axis:documents:upload",
      update: "axis:documents:verify",
      filters: [
        { name: "status", options: ["received", "extracting", "extracted", "verified", "rejected"] }
      ],
      columns: [
        { name: "caseId", type: "text" },
        { name: "docType", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "extractionConfidence", type: "number" },
        { name: "extractionModel", type: "text" },
        { name: "verifiedBy", type: "text" },
        { name: "verifiedAt", type: "datetime" },
        { name: "createdAt", type: "datetime", sortable: true },
        // What the model read off the document. A whole extracted form's worth
        // of keys, so it goes last rather than through the middle of the list.
        { name: "extractionJson", type: "json" }
      ],
      fields: [
        { name: "caseId", type: "text", required: true },
        { name: "fileId", type: "text", required: true },
        {
          name: "docType",
          type: "select",
          required: true,
          options: ["eid", "mulkiya", "census", "medical", "tradelicense", "other"]
        }
      ],
      editable: [
        {
          // `verified` is deliberately absent: POST /documents/:id/verify stamps
          // verifiedBy/verifiedAt from the session, and a PATCH would let the
          // caller name its own verifier (apps/api/src/routes/axis.ts).
          name: "status",
          type: "select",
          options: ["received", "extracting", "extracted", "rejected"]
        }
      ],
      actions: [
        {
          intent: "verify",
          method: "POST",
          path: "/{id}/verify",
          labelKey: "documents.verify",
          permission: "axis:documents:verify",
          confirm: true
        },
        {
          // The extractor needs the page text; it does not do OCR itself.
          intent: "extract",
          method: "POST",
          path: "/{id}/extract",
          labelKey: "documents.extract",
          permission: "axis:documents:extract",
          fields: [
            { name: "rawText", type: "textarea", required: true },
            { name: "locale", type: "select", options: ["en", "ar"] }
          ]
        }
      ]
    },
    {
      key: "tasks",
      api: "/v1/axis/tasks",
      read: "axis:tasks:read",
      create: "axis:tasks:write",
      update: "axis:tasks:write",
      remove: "axis:tasks:write",
      filters: [{ name: "state", options: ["open", "in_progress", "blocked", "done", "cancelled"] }],
      columns: [
        { name: "titleKey", type: "text" },
        { name: "type", type: "text" },
        { name: "caseId", type: "text" },
        { name: "assigneeRef", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "dueAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "titleKey", type: "text", required: true },
        { name: "type", type: "text", required: true },
        { name: "caseId", type: "text" },
        { name: "assigneeRef", type: "text" },
        { name: "dueAt", type: "datetime" },
        { name: "checklistJson", type: "json" }
      ],
      editable: [
        { name: "state", type: "select", options: ["open", "in_progress", "blocked", "done", "cancelled"] },
        { name: "assigneeRef", type: "text" },
        { name: "dueAt", type: "datetime" },
        { name: "checklistJson", type: "json" }
      ]
    },
    {
      key: "policies",
      api: "/v1/axis/policies",
      read: "axis:policies:read",
      create: "axis:policies:create",
      update: "axis:policies:update",
      filters: [{ name: "status", options: ["active", "lapsed", "cancelled", "renewed"] }],
      sort: "endAt",
      order: "asc",
      columns: [
        { name: "policyNo", type: "text" },
        { name: "customerId", type: "text" },
        { name: "providerId", type: "text" },
        { name: "premiumMinor", type: "money", currencyFrom: "currency" },
        { name: "commissionMinor", type: "money", currencyFrom: "currency" },
        { name: "status", type: "text", badge: true },
        { name: "endAt", type: "date", sortable: true },
        { name: "escrowBatchId", type: "text" },
        { name: "docsJson", type: "json" },
        { name: "paymentPlanJson", type: "json" }
      ],
      fields: [
        { name: "policyNo", type: "text", required: true },
        { name: "customerId", type: "text", required: true },
        { name: "providerId", type: "text", required: true },
        { name: "caseId", type: "text" },
        { name: "productId", type: "text" },
        { name: "offeringId", type: "text" },
        { name: "channelId", type: "text" },
        { name: "startAt", type: "date", required: true },
        { name: "endAt", type: "date", required: true },
        { name: "premiumMinor", type: "money", required: true },
        { name: "currency", type: "text", required: true },
        { name: "commissionMinor", type: "money" }
      ],
      editable: [
        // `status` is deliberately absent: every hop out of `active` moves money
        // — NTU refunds the premium, LAPSE stops the accrual, REINSTATE re-earns
        // it against the arrears — and a PATCH would write the word without any
        // of the journal lines (docs/19). The hops are the actions below.
        { name: "endAt", type: "date" },
        { name: "commissionMinor", type: "money" }
      ],
      actions: [
        {
          intent: "ntu",
          method: "POST",
          path: "/{id}/ntu",
          labelKey: "policies.ntu",
          permission: "axis:policies:ntu",
          confirm: true,
          fields: [
            { name: "reasonCode", type: "text", required: true },
            { name: "collectedMinor", type: "money", hintKey: "policies.ntu.collected" },
            { name: "note", type: "textarea" }
          ]
        },
        {
          intent: "lapse",
          method: "POST",
          path: "/{id}/lapse",
          labelKey: "policies.lapse",
          permission: "axis:policies:lapse",
          confirm: true,
          fields: [
            { name: "missedSeq", type: "number", hintKey: "policies.lapse.missedSeq" },
            { name: "reason", type: "text" }
          ]
        },
        {
          intent: "reinstate",
          method: "POST",
          path: "/{id}/reinstate",
          labelKey: "policies.reinstate",
          permission: "axis:policies:reinstate",
          confirm: true,
          fields: [
            { name: "arrearsMinor", type: "money", hintKey: "policies.reinstate.arrears" },
            { name: "note", type: "textarea" }
          ]
        }
      ]
    },
    {
      key: "claims",
      api: "/v1/axis/claims",
      read: "axis:claims:read",
      create: "axis:claims:create",
      update: "axis:claims:update",
      filters: [
        {
          // Every state a claim can actually be in (CLAIM_STATES, @lyra/core
          // lifecycle.ts). `settling`, `settled` and the rest were missing while
          // no claim could reach them; a payment now can (docs/27 F23).
          name: "status",
          options: [
            "reported",
            "triage",
            "assessing",
            "awaiting_docs",
            "approved",
            "rejected",
            "settling",
            "settled",
            "recovering",
            "closed",
            "reopened",
            "withdrawn"
          ]
        }
      ],
      sort: "reportedAt",
      columns: [
        { name: "claimNo", type: "text" },
        { name: "policyId", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "amountMinor", type: "money", currencyFrom: "currency" },
        { name: "settledMinor", type: "money", currencyFrom: "currency" },
        { name: "reportedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "claimNo", type: "text", required: true },
        { name: "policyId", type: "text", required: true },
        { name: "customerId", type: "text", required: true },
        { name: "caseId", type: "text" },
        { name: "incidentAt", type: "datetime" },
        { name: "reportedAt", type: "datetime", required: true },
        { name: "amountMinor", type: "money" },
        { name: "currency", type: "text", required: true },
        { name: "fnolJson", type: "json" }
      ],
      editable: [
        {
          // The hops a person may take by hand. `settling` and `settled` are
          // absent for the reason `hopsFor` (claims-desk.tsx) drops them: the
          // API refuses both here, so offering either would be a dead end the
          // desk only discovers after submitting (docs/27 F23/F27).
          name: "status",
          type: "select",
          options: [
            "reported",
            "triage",
            "assessing",
            "awaiting_docs",
            "approved",
            "rejected",
            "recovering",
            "closed",
            "reopened",
            "withdrawn"
          ],
          hintKey: "claims.statusHint"
        },
        { name: "assessorRef", type: "text" },
        // Settling is consequential: the API routes this through an approval
        // (resources.ts, axis.claim_settlement) rather than writing it directly.
        { name: "settledMinor", type: "money" }
      ]
    },
    // docs/27 §D.8. Both registers already had tables, permissions, transition
    // guards and a generic resource — only the screen was missing.
    {
      key: "complaints",
      api: "/v1/axis/complaints",
      read: "axis:complaints:read",
      create: "axis:complaints:write",
      update: "axis:complaints:write",
      // Soonest deadline first: a complaint's clock is regulatory, not a queue
      // preference.
      sort: "dueAt",
      order: "asc",
      filters: [
        {
          name: "state",
          options: ["received", "investigating", "awaiting_customer", "resolved", "escalated", "closed"]
        },
        { name: "channel", options: ["web", "phone", "email", "whatsapp", "regulator", "social"] },
        { name: "outcome", options: ["upheld", "partly_upheld", "not_upheld", "withdrawn"] }
      ],
      columns: [
        { name: "ref", type: "text", sortable: true },
        { name: "channel", type: "text", badge: true },
        { name: "categoryCode", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "dueAt", type: "datetime", sortable: true },
        { name: "outcome", type: "text", badge: true },
        { name: "redressMinor", type: "money", currencyFrom: "currency" },
        { name: "ownerRef", type: "text" }
      ],
      fields: [
        { name: "ref", type: "text", required: true },
        {
          name: "channel",
          type: "select",
          required: true,
          options: ["web", "phone", "email", "whatsapp", "regulator", "social"]
        },
        { name: "categoryCode", type: "text", required: true },
        { name: "customerId", type: "text" },
        { name: "policyId", type: "text" },
        { name: "claimId", type: "text" },
        { name: "caseId", type: "text" },
        { name: "summarySealed", type: "textarea", hintKey: "complaints.summaryHint" },
        { name: "receivedAt", type: "datetime", required: true },
        { name: "dueAt", type: "datetime", required: true },
        { name: "ownerRef", type: "text" },
        { name: "regulatorRef", type: "text" },
        { name: "currency", type: "text" }
      ],
      editable: [
        // Only the moves COMPLAINT_TRANSITIONS allows exist as options; the API
        // is still the authority on which are legal from the current state.
        {
          name: "state",
          type: "select",
          options: ["received", "investigating", "awaiting_customer", "resolved", "escalated", "closed"]
        },
        {
          name: "outcome",
          type: "select",
          options: ["upheld", "partly_upheld", "not_upheld", "withdrawn"]
        },
        { name: "rootCauseCode", type: "text" },
        // Above zero this trips dual control (axis.claim_exgratia): the save
        // comes back as an approval refusal, not a write.
        { name: "redressMinor", type: "money", hintKey: "complaints.redressHint" },
        { name: "ownerRef", type: "text" },
        { name: "acknowledgedAt", type: "datetime" },
        { name: "resolvedAt", type: "datetime" },
        { name: "regulatorRef", type: "text" }
      ]
    },
    {
      key: "siu-referrals",
      api: "/v1/axis/siu-referrals",
      read: "axis:siu:read",
      update: "axis:siu:write",
      // Highest score first — the queue is a triage order, not a diary.
      sort: "score",
      order: "desc",
      filters: [
        { name: "state", options: ["open", "investigating", "substantiated", "unsubstantiated", "closed"] },
        { name: "source", options: ["model", "handler", "insurer", "tip"] }
      ],
      columns: [
        { name: "claimId", type: "text" },
        { name: "score", type: "number", sortable: true },
        { name: "state", type: "text", badge: true },
        { name: "source", type: "text", badge: true },
        { name: "assignedTo", type: "text" },
        { name: "savedMinor", type: "money", currencyFrom: "currency" },
        { name: "openedAt", type: "datetime", sortable: true }
      ],
      editable: [
        {
          name: "state",
          type: "select",
          options: ["open", "investigating", "substantiated", "unsubstantiated", "closed"]
        },
        { name: "assignedTo", type: "text" },
        { name: "outcome", type: "text" },
        { name: "savedMinor", type: "money", hintKey: "siu.savedHint" },
        { name: "closedAt", type: "datetime" }
      ]
    },
    {
      key: "escrow-batches",
      api: "/v1/axis/escrow-batches",
      read: "axis:escrow:read",
      update: "axis:escrow:reconcile",
      filters: [
        { name: "status", options: ["open", "reconciling", "matched", "variance", "closed"] }
      ],
      columns: [
        { name: "period", type: "text", sortable: true },
        { name: "providerId", type: "text" },
        { name: "expectedMinor", type: "money", currencyFrom: "currency" },
        { name: "receivedMinor", type: "money", currencyFrom: "currency" },
        { name: "status", type: "text", badge: true },
        { name: "closedAt", type: "datetime" }
      ],
      editable: [
        { name: "status", type: "select", options: ["open", "reconciling", "matched", "variance", "closed"] },
        { name: "receivedMinor", type: "money" },
        { name: "varianceReason", type: "text" },
        { name: "evidenceFileId", type: "text" }
      ]
    },
    {
      key: "sops",
      api: "/v1/axis/sops",
      read: "axis:sops:read",
      create: "axis:sops:write",
      update: "axis:sops:write",
      remove: "axis:sops:write",
      filters: [{ name: "status", options: ["draft", "active", "retired"] }],
      columns: [
        { name: "key", type: "text" },
        { name: "version", type: "number" },
        { name: "appliesTo", type: "text" },
        { name: "status", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "version", type: "number", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "stepsJson", type: "json", required: true },
        { name: "appliesTo", type: "text" }
      ],
      editable: [
        { name: "status", type: "select", options: ["draft", "active", "retired"] },
        { name: "stepsJson", type: "json" }
      ]
    },
    {
      key: "case-approvals",
      api: "/v1/axis/case-approvals",
      read: "axis:cases:approve",
      columns: [
        { name: "caseId", type: "text" },
        { name: "policyKey", type: "text" },
        { name: "subjectRef", type: "text" },
        { name: "decision", type: "text", badge: true },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "process-events",
      api: "/v1/axis/process-events",
      read: "axis:metrics:read",
      sort: "ts",
      columns: [
        { name: "caseId", type: "text" },
        { name: "step", type: "text" },
        { name: "actorRef", type: "text" },
        { name: "durationMs", type: "number" },
        { name: "outcome", type: "text", badge: true },
        { name: "ts", type: "datetime", sortable: true }
      ]
    },
    {
      key: "ops-policies",
      api: "/v1/axis/ops-policies",
      read: "axis:ops_policies:read",
      create: "axis:ops_policies:write",
      update: "axis:ops_policies:write",
      remove: "axis:ops_policies:write",
      filters: [{ name: "status", options: ["active", "disabled"] }],
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "kind", type: "text", badge: true },
        { name: "status", type: "text", badge: true },
        { name: "updatedAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "kind", type: "select", options: ["sla", "routing", "queue"], required: true },
        { name: "valueJson", type: "json", required: true }
      ],
      editable: [
        { name: "status", type: "select", options: ["active", "disabled"] },
        { name: "valueJson", type: "json" }
      ]
    }
  ]
};
