import type { WorkspaceSpec } from "./spec";

// DISTRIBUTION — the aggregator spine (docs/03 §DIST). Everything here is either
// the panel we can sell through (channels, offerings, the rates that price them)
// or one shop across it: a quote request fanned out to providers, the responses
// that came back, and the commission the winning sale earned.

export const distribution: WorkspaceSpec = {
  path: "/distribution",
  // The shop itself is not a table: a comparison is a screen (routes/dist.ts
  // `GET /quote-requests/:id/comparison`) and it belongs to one quote request,
  // so it hangs off that record rather than the workspace.
  labels: {
    en: {
      channels: "Channels",
      "link.onboarding": "Onboarding checklist",
      offerings: "Offerings",
      "commission-rates": "Commission rates",
      "quote-requests": "Quote requests",
      "quote-responses": "Quote responses",
      "commission-entries": "Commission entries",
      "next-best-offers": "Next best offers",
      compare: "Comparison",
      statement: "Commission statement",
      suggest: "Propose offers",
      referrals: "Referrals",
      clawback: "Claw back",

      key: "Key",
      kind: "Kind",
      medium: "Medium",
      collectsPayment: "Collects payment",
      partnerId: "Partner",
      defaultCommissionPpm: "Default commission",
      status: "Status",
      nameJson: "Name",
      currency: "Currency",
      settlementTermsJson: "Settlement terms",
      code: "Code",
      productId: "Product",
      providerId: "Provider",
      pricingMode: "Pricing mode",
      minPremiumMinor: "Minimum premium",
      baseCommissionPpm: "Base commission",
      maxDiscountPpm: "Maximum discount",
      slaSeconds: "Quote SLA",
      effectiveFrom: "Effective from",
      effectiveTo: "Effective to",
      coverageJson: "Coverage",
      eligibilityJson: "Eligibility",
      ratingTableJson: "Rate table",
      channelId: "Channel",
      offeringId: "Offering",
      line: "Product line",
      channelSharePpm: "Channel share",
      flatFeeMinor: "Flat fee",
      earnedOn: "Earned on",
      clawbackDays: "Clawback window",
      structureJson: "Tiers and bonuses",
      "structureJson.hint": "Optional. Tiers ascend and the last has no upper limit, e.g. {\"tiers\":[{\"uptoMinor\":1000000,\"ratePpm\":100000},{\"ratePpm\":150000}]}.",
      customerId: "Customer",
      caseId: "Case",
      state: "State",
      fanoutCount: "Fanned out",
      respondedCount: "Responded",
      bestPremiumMinor: "Best premium",
      inputsJson: "Risk details",
      consentId: "Consent",
      expiresAt: "Expires",
      requestId: "Request",
      premiumMinor: "Premium",
      taxMinor: "Tax",
      feesMinor: "Fees",
      commissionMinor: "Commission",
      commissionPpm: "Commission rate",
      valueScore: "Value score",
      priceRank: "Price rank",
      validUntil: "Valid until",
      declineReason: "Decline reason",
      policyId: "Policy",
      grossCommissionMinor: "Gross commission",
      channelCommissionMinor: "Channel commission",
      netCommissionMinor: "Net commission",
      reversalOf: "Reverses",
      providerSettlementId: "Provider settlement",
      channelSettlementId: "Channel settlement",
      txnId: "Transaction",
      earnedAt: "Earned",
      score: "Score",
      expectedValueMinor: "Expected value",
      suppressReason: "Suppressed because",

      "kind.b2c": "Direct",
      "kind.b2b": "Partner",
      "kind.new_business": "New business",
      "kind.renewal": "Renewal",
      "kind.endorsement": "Endorsement",
      "kind.clawback": "Clawback",
      "kind.adjustment": "Adjustment",
      "kind.cross_sell": "Cross-sell",
      "kind.upsell": "Upsell",
      "kind.bundle": "Bundle",
      "kind.top_up": "Top-up",

      "status.draft": "Draft",
      "status.active": "Active",
      "status.paused": "Paused",
      "status.terminated": "Terminated",
      "status.withdrawn": "Withdrawn",

      "medium.web": "Website",
      "medium.app": "App",
      "medium.portal": "Partner portal",
      "medium.api": "API",
      "medium.branch": "Branch",
      "medium.call_centre": "Call centre",
      "medium.embed": "Embedded",

      "collectsPayment.us": "We collect",
      "collectsPayment.partner": "Partner collects",
      "collectsPayment.underwriter": "Underwriter collects",

      "pricingMode.api": "Live API",
      "pricingMode.table": "Rate table",
      "pricingMode.manual": "Manual",
      "pricingMode.referral": "Referral",

      "earnedOn.issue": "On issue",
      "earnedOn.collection": "On collection",

      "state.open": "Open",
      "state.fanned_out": "Fanned out",
      "state.complete": "Complete",
      "state.expired": "Expired",
      "state.converted": "Converted",
      "state.abandoned": "Abandoned",
      "state.pending": "Pending",
      "state.quoted": "Quoted",
      "state.declined": "Declined",
      "state.referred": "Referred",
      "state.timeout": "Timed out",
      "state.error": "Error",
      "state.accrued": "Accrued",
      "state.invoiced": "Invoiced",
      "state.received": "Received",
      "state.payable": "Payable",
      "state.paid": "Paid",
      "state.clawed_back": "Clawed back",
      "state.disputed": "Disputed",
      "state.written_off": "Written off",
      "state.proposed": "Proposed",
      "state.surfaced": "Surfaced",
      "state.accepted": "Accepted",
      "state.dismissed": "Dismissed",
      "state.suppressed": "Suppressed"
    },
    ar: {
      channels: "القنوات",
      "link.onboarding": "قائمة مهام التهيئة",
      offerings: "العروض",
      "commission-rates": "أسعار العمولة",
      "quote-requests": "طلبات التسعير",
      "quote-responses": "ردود التسعير",
      "commission-entries": "قيود العمولة",
      "next-best-offers": "أفضل العروض التالية",
      statement: "كشف العمولات",
      suggest: "اقتراح عروض",
      referrals: "الإحالات",
      clawback: "استرداد",
      compare: "المقارنة",

      key: "المفتاح",
      kind: "النوع",
      medium: "الوسيط",
      collectsPayment: "جهة التحصيل",
      partnerId: "الشريك",
      defaultCommissionPpm: "العمولة الافتراضية",
      status: "الحالة",
      nameJson: "الاسم",
      currency: "العملة",
      settlementTermsJson: "شروط التسوية",
      code: "الرمز",
      productId: "المنتج",
      providerId: "المزود",
      pricingMode: "طريقة التسعير",
      minPremiumMinor: "الحد الأدنى للقسط",
      baseCommissionPpm: "العمولة الأساسية",
      maxDiscountPpm: "الحد الأقصى للخصم",
      slaSeconds: "مهلة التسعير",
      effectiveFrom: "ساري من",
      effectiveTo: "ساري حتى",
      coverageJson: "التغطية",
      eligibilityJson: "شروط الأهلية",
      ratingTableJson: "جدول الأسعار",
      channelId: "القناة",
      offeringId: "العرض",
      line: "خط المنتج",
      channelSharePpm: "حصة القناة",
      flatFeeMinor: "رسوم ثابتة",
      earnedOn: "استحقاق العمولة",
      clawbackDays: "مهلة الاسترداد",
      structureJson: "الشرائح والمكافآت",
      "structureJson.hint": "اختياري. تتصاعد الشرائح والأخيرة بلا حد أعلى، مثل {\"tiers\":[{\"uptoMinor\":1000000,\"ratePpm\":100000},{\"ratePpm\":150000}]}.",
      customerId: "العميل",
      caseId: "الحالة",
      state: "الوضع",
      fanoutCount: "عدد المرسل إليهم",
      respondedCount: "عدد الردود",
      bestPremiumMinor: "أفضل قسط",
      inputsJson: "بيانات الخطر",
      consentId: "الموافقة",
      expiresAt: "تنتهي في",
      requestId: "الطلب",
      premiumMinor: "القسط",
      taxMinor: "الضريبة",
      feesMinor: "الرسوم",
      commissionMinor: "العمولة",
      commissionPpm: "نسبة العمولة",
      valueScore: "درجة القيمة",
      priceRank: "ترتيب السعر",
      validUntil: "صالح حتى",
      declineReason: "سبب الرفض",
      policyId: "الوثيقة",
      grossCommissionMinor: "إجمالي العمولة",
      channelCommissionMinor: "عمولة القناة",
      netCommissionMinor: "صافي العمولة",
      reversalOf: "يعكس القيد",
      providerSettlementId: "تسوية المزود",
      channelSettlementId: "تسوية القناة",
      txnId: "المعاملة",
      earnedAt: "تاريخ الاستحقاق",
      score: "الدرجة",
      expectedValueMinor: "القيمة المتوقعة",
      suppressReason: "سبب الحجب",

      "kind.b2c": "مباشر",
      "kind.b2b": "عبر شريك",
      "kind.new_business": "أعمال جديدة",
      "kind.renewal": "تجديد",
      "kind.endorsement": "ملحق",
      "kind.clawback": "استرداد",
      "kind.adjustment": "تسوية",
      "kind.cross_sell": "بيع تكميلي",
      "kind.upsell": "ترقية",
      "kind.bundle": "باقة",
      "kind.top_up": "تعزيز التغطية",

      "status.draft": "مسودة",
      "status.active": "نشط",
      "status.paused": "متوقف مؤقتًا",
      "status.terminated": "منتهٍ",
      "status.withdrawn": "مسحوب",

      "medium.web": "الموقع",
      "medium.app": "التطبيق",
      "medium.portal": "بوابة الشريك",
      "medium.api": "واجهة برمجية",
      "medium.branch": "فرع",
      "medium.call_centre": "مركز الاتصال",
      "medium.embed": "مضمّن",

      "collectsPayment.us": "نحن نحصّل",
      "collectsPayment.partner": "الشريك يحصّل",
      "collectsPayment.underwriter": "شركة التأمين تحصّل",

      "pricingMode.api": "واجهة مباشرة",
      "pricingMode.table": "جدول أسعار",
      "pricingMode.manual": "يدوي",
      "pricingMode.referral": "إحالة",

      "earnedOn.issue": "عند الإصدار",
      "earnedOn.collection": "عند التحصيل",

      "state.open": "مفتوح",
      "state.fanned_out": "تم الإرسال",
      "state.complete": "مكتمل",
      "state.expired": "منتهي الصلاحية",
      "state.converted": "تم التحويل",
      "state.abandoned": "متروك",
      "state.pending": "قيد الانتظار",
      "state.quoted": "تم التسعير",
      "state.declined": "مرفوض",
      "state.referred": "محال",
      "state.timeout": "انتهت المهلة",
      "state.error": "خطأ",
      "state.accrued": "مستحق",
      "state.invoiced": "مفوتر",
      "state.received": "مستلم",
      "state.payable": "واجب الدفع",
      "state.paid": "مدفوع",
      "state.clawed_back": "تم استرداده",
      "state.disputed": "متنازع عليه",
      "state.written_off": "مشطوب",
      "state.proposed": "مقترح",
      "state.surfaced": "معروض",
      "state.accepted": "مقبول",
      "state.dismissed": "مستبعد",
      "state.suppressed": "محجوب"
    }
  },
  tabs: [
    {
      key: "channels",
      api: "/v1/dist/channels",
      read: "dist:channels:read",
      create: "dist:channels:write",
      update: "dist:channels:write",
      remove: "dist:channels:write",
      recordLink: { href: "/onboarding/channels/{id}", labelKey: "link.onboarding" },
      search: true,
      filters: [
        { name: "kind", options: ["b2c", "b2b"] },
        { name: "status", options: ["active", "paused", "terminated"] }
      ],
      columns: [
        { name: "key", type: "text", sortable: true },
        { name: "kind", type: "text" },
        { name: "medium", type: "text" },
        { name: "partnerId", type: "text" },
        { name: "collectsPayment", type: "text" },
        { name: "defaultCommissionPpm", type: "rate" },
        { name: "status", type: "text", badge: true },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      fields: [
        { name: "key", type: "text", required: true },
        { name: "kind", type: "select", required: true, options: ["b2c", "b2b"] },
        { name: "nameJson", type: "json", required: true },
        { name: "partnerId", type: "text" },
        {
          name: "medium",
          type: "select",
          options: ["web", "app", "portal", "api", "branch", "call_centre", "embed"]
        },
        {
          name: "collectsPayment",
          type: "select",
          options: ["us", "partner", "underwriter"]
        },
        { name: "currency", type: "text" },
        { name: "defaultCommissionPpm", type: "rate" },
        { name: "settlementTermsJson", type: "json" }
      ],
      editable: [
        { name: "status", type: "select", options: ["active", "paused", "terminated"] },
        {
          name: "medium",
          type: "select",
          options: ["web", "app", "portal", "api", "branch", "call_centre", "embed"]
        },
        { name: "collectsPayment", type: "select", options: ["us", "partner", "underwriter"] },
        { name: "defaultCommissionPpm", type: "rate" },
        { name: "nameJson", type: "json" },
        { name: "settlementTermsJson", type: "json" }
      ]
    },
    {
      key: "offerings",
      api: "/v1/dist/offerings",
      read: "dist:offerings:read",
      create: "dist:offerings:write",
      update: "dist:offerings:write",
      remove: "dist:offerings:write",
      search: true,
      filters: [
        { name: "status", options: ["draft", "active", "paused", "withdrawn"] },
        { name: "pricingMode", options: ["api", "table", "manual", "referral"] }
      ],
      columns: [
        { name: "code", type: "text", sortable: true },
        { name: "providerId", type: "text" },
        { name: "productId", type: "text" },
        { name: "pricingMode", type: "text" },
        { name: "minPremiumMinor", type: "money", currencyFrom: "currency" },
        { name: "baseCommissionPpm", type: "rate" },
        { name: "status", type: "text", badge: true },
        { name: "effectiveFrom", type: "date", sortable: true }
      ],
      fields: [
        { name: "productId", type: "text", required: true },
        { name: "providerId", type: "text", required: true },
        { name: "code", type: "text", required: true },
        { name: "nameJson", type: "json", required: true },
        { name: "currency", type: "text", required: true },
        {
          name: "pricingMode",
          type: "select",
          required: true,
          options: ["api", "table", "manual", "referral"]
        },
        { name: "effectiveFrom", type: "date", required: true },
        { name: "effectiveTo", type: "date" },
        { name: "baseCommissionPpm", type: "rate" },
        { name: "maxDiscountPpm", type: "rate" },
        { name: "minPremiumMinor", type: "money" },
        { name: "slaSeconds", type: "number" },
        { name: "coverageJson", type: "json" },
        { name: "eligibilityJson", type: "json" }
      ],
      // Publishing is consequential: the API routes the status change through
      // `dist.offering_publish` (resources.ts) rather than writing it directly.
      editable: [
        { name: "status", type: "select", options: ["draft", "active", "paused", "withdrawn"] },
        { name: "baseCommissionPpm", type: "rate" },
        { name: "maxDiscountPpm", type: "rate" },
        { name: "minPremiumMinor", type: "money" },
        { name: "effectiveTo", type: "date" },
        { name: "coverageJson", type: "json" },
        { name: "eligibilityJson", type: "json" },
        { name: "ratingTableJson", type: "json" }
      ]
    },
    {
      key: "commission-rates",
      api: "/v1/dist/commission-rates",
      read: "dist:rates:read",
      // Immutable in the API: a rate change opens a new row so a settlement can
      // always re-derive the rate that applied on the sale date.
      create: "dist:rates:write",
      filters: [{ name: "earnedOn", options: ["issue", "collection"] }],
      sort: "effectiveFrom",
      columns: [
        { name: "channelId", type: "text" },
        { name: "offeringId", type: "text" },
        { name: "productId", type: "text" },
        { name: "channelSharePpm", type: "rate" },
        { name: "flatFeeMinor", type: "money", currencyFrom: "currency" },
        { name: "earnedOn", type: "text", badge: true },
        { name: "effectiveFrom", type: "date", sortable: true },
        { name: "effectiveTo", type: "date" }
      ],
      fields: [
        { name: "channelId", type: "text", required: true },
        { name: "offeringId", type: "text" },
        { name: "productId", type: "text" },
        { name: "line", type: "text" },
        { name: "channelSharePpm", type: "rate", required: true },
        { name: "baseCommissionPpm", type: "rate" },
        { name: "flatFeeMinor", type: "money" },
        { name: "currency", type: "text" },
        { name: "earnedOn", type: "select", options: ["issue", "collection"] },
        { name: "clawbackDays", type: "number" },
        { name: "effectiveFrom", type: "date", required: true },
        { name: "effectiveTo", type: "date" },
        // ADR-0084 tiers, volume bonus and override. Validated by the API on
        // write, so a malformed ladder is refused rather than paid flat.
        { name: "structureJson", type: "json", hintKey: "structureJson.hint" }
      ]
    },
    {
      key: "quote-requests",
      api: "/v1/dist/quote-requests",
      read: "dist:quote_requests:read",
      recordLink: { href: "/distribution/quote-requests/{id}/compare", labelKey: "compare" },
      create: "dist:quote_requests:create",
      update: "dist:quote_requests:create",
      filters: [
        {
          name: "state",
          options: ["open", "fanned_out", "complete", "expired", "converted", "abandoned"]
        }
      ],
      columns: [
        { name: "customerId", type: "text" },
        { name: "channelId", type: "text" },
        { name: "productId", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "fanoutCount", type: "number" },
        { name: "respondedCount", type: "number" },
        { name: "bestPremiumMinor", type: "money", currencyFrom: "currency" },
        { name: "createdAt", type: "datetime", sortable: true }
      ],
      // The fan-out itself is `POST /v1/dist/quote-requests/shop`; this form only
      // opens the shop, and without a consent id nothing leaves the tenant.
      fields: [
        { name: "channelId", type: "text", required: true },
        { name: "productId", type: "text", required: true },
        // A shop is the start of a sale; the API refuses one with no customer.
        { name: "customerId", type: "text", required: true },
        { name: "caseId", type: "text" },
        { name: "inputsJson", type: "json", required: true },
        { name: "consentId", type: "text" },
        { name: "currency", type: "text", required: true },
        { name: "expiresAt", type: "datetime" }
      ],
      editable: [
        {
          name: "state",
          type: "select",
          options: ["open", "fanned_out", "complete", "expired", "converted", "abandoned"]
        },
        { name: "consentId", type: "text" },
        { name: "expiresAt", type: "datetime" }
      ]
    },
    {
      key: "quote-responses",
      api: "/v1/dist/quote-responses",
      read: "dist:quote_requests:read",
      filters: [
        {
          name: "state",
          options: ["pending", "quoted", "declined", "referred", "timeout", "error"]
        }
      ],
      // What one underwriter answered, in full: the price a customer pays is
      // premium + tax + fees, and a quote nobody can act on after `validUntil`
      // is not a quote. A decline is kept for the same reason (schema/dist.ts) —
      // it is the panel's quality signal, and unreadable if the reason is hidden.
      columns: [
        { name: "offeringId", type: "text" },
        { name: "providerId", type: "text" },
        { name: "requestId", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "premiumMinor", type: "money", currencyFrom: "currency" },
        { name: "taxMinor", type: "money", currencyFrom: "currency" },
        { name: "feesMinor", type: "money", currencyFrom: "currency" },
        { name: "commissionMinor", type: "money", currencyFrom: "currency" },
        // ppm, like every other rate here (schema/dist.ts: 12.5% is 125_000).
        { name: "commissionPpm", type: "rate" },
        { name: "priceRank", type: "number" },
        { name: "valueScore", type: "number" },
        { name: "coverageJson", type: "json" },
        { name: "validUntil", type: "datetime" },
        { name: "declineReason", type: "text" },
        { name: "createdAt", type: "datetime", sortable: true }
      ]
    },
    {
      key: "commission-entries",
      api: "/v1/dist/commission-entries",
      read: "dist:commissions:read",
      update: "dist:commissions:adjust",
      sort: "earnedAt",
      // Reversing an entry is not a field edit: it writes a second, negated
      // entry and needs the figures and a reason in front of the actor first,
      // so it is a screen rather than an inline action.
      recordLink: {
        href: "/distribution/commission-entries/{id}/clawback",
        labelKey: "clawback"
      },
      filters: [
        {
          name: "state",
          options: [
            "accrued",
            "invoiced",
            "received",
            "payable",
            "paid",
            "clawed_back",
            "disputed",
            "written_off"
          ]
        },
        {
          name: "kind",
          options: ["new_business", "renewal", "endorsement", "clawback", "adjustment"]
        }
      ],
      // The three-way view only reads as money if the base it was computed from
      // and the settlements that discharge it are on the row: premium in, gross
      // from the provider, channel share out, and the two settlement ids that
      // say whether either leg has actually moved.
      columns: [
        { name: "policyId", type: "text" },
        { name: "providerId", type: "text" },
        { name: "kind", type: "text" },
        { name: "premiumMinor", type: "money", currencyFrom: "currency" },
        { name: "grossCommissionMinor", type: "money", currencyFrom: "currency" },
        { name: "channelCommissionMinor", type: "money", currencyFrom: "currency" },
        { name: "netCommissionMinor", type: "money", currencyFrom: "currency" },
        { name: "earnedOn", type: "text" },
        { name: "state", type: "text", badge: true },
        { name: "providerSettlementId", type: "text" },
        { name: "channelSettlementId", type: "text" },
        { name: "txnId", type: "text" },
        { name: "reversalOf", type: "text" },
        { name: "earnedAt", type: "datetime", sortable: true }
      ],
      // No create form: an entry is accrued by `POST /commission-entries/accrue`
      // and reversed by `/:id/clawback`, never typed in (CLAUDE.md §12). The
      // amounts stay read-only here — an adjustment is an approval, not an edit.
      editable: [
        {
          name: "state",
          type: "select",
          options: [
            "accrued",
            "invoiced",
            "received",
            "payable",
            "paid",
            "clawed_back",
            "disputed",
            "written_off"
          ]
        }
      ]
    },
    {
      key: "next-best-offers",
      api: "/v1/dist/next-best-offers",
      read: "dist:offers:read",
      update: "dist:offers:override",
      sort: "score",
      order: "desc",
      filters: [
        {
          name: "state",
          options: [
            "proposed",
            "surfaced",
            "accepted",
            "dismissed",
            "suppressed",
            "expired",
            "converted"
          ]
        },
        { name: "kind", options: ["cross_sell", "upsell", "renewal", "bundle", "top_up"] }
      ],
      columns: [
        { name: "customerId", type: "text" },
        { name: "kind", type: "text" },
        { name: "offeringId", type: "text" },
        { name: "score", type: "number", sortable: true },
        { name: "expectedValueMinor", type: "money", currencyFrom: "currency" },
        { name: "state", type: "text", badge: true },
        { name: "suppressReason", type: "text" },
        { name: "expiresAt", type: "date" }
      ],
      // Proposals come from the model (`POST /next-best-offers/propose`); a human
      // only ever decides one, which is the single editable field.
      editable: [
        {
          name: "state",
          type: "select",
          options: [
            "proposed",
            "surfaced",
            "accepted",
            "dismissed",
            "suppressed",
            "expired",
            "converted"
          ]
        }
      ]
    }
  ],
  // Permissions are the ones each screen's own loader checks, so a link that
  // renders is a screen that opens rather than a denied notice.
  links: [
    { href: "/distribution/commission-entries/statement", labelKey: "statement", permission: "dist:commissions:read" },
    { href: "/distribution/next-best-offers/suggest", labelKey: "suggest", permission: "dist:offers:read" },
    // docs/30 Distribution 4. The desk's loader lets either verb in; qualify is the first step.
    { href: "/distribution/referrals", labelKey: "referrals", permission: "dist:commissions:adjust" }
  ]
};
