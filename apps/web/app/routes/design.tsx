import { useState } from "react";
import { Link } from "react-router";
import { surfaceCatalogue } from "../modules/surfaces";
import { shouldInclude } from "../routing";
import {
  Field,
  POST_RATIOS,
  PostingFlow,
  Slider,
  StateFlow,
  postCardSvg,
  type FlowBalance,
  type FlowLeg,
  type FlowMachine,
  type FlowVisit,
  type PostRatio
} from "@lyra/ui";
import { FOCUS, HeroStat, HeroWall } from "../components/hero";
import { DraftTray } from "../components/signal-handover";
import {
  CommentaryChip,
  CommentaryGhost,
  commentaryLabels,
  type WhitespaceCommentary
} from "../components/whitespace-commentary";
import { labelsFrom } from "./detail-kit";
import { useShellData } from "./workspace";

// The doctrine (Horizon comp §doctrine): the design system explaining itself —
// the four rules the platform is built to, the palette it inherits and the three
// type voices. The comp draws this as a z-95 overlay; docs/15 §4 has no modal
// pattern, and CLAUDE.md's definition of done names a design-system playground
// that never existed. One route satisfies both.
//
// Every swatch prints `var(--token)`, never a hex: a tenant that re-sets
// `--accent` (docs/01 §6) must see its own colour here, not ours.

type Labels = Record<string, Record<string, string>>;

/** `n` is the rule's number, `hue` the module accent that numbers it. */
const RULES = [
  { n: "01", hue: "text-module-axis" },
  { n: "02", hue: "text-module-orbit" },
  { n: "03", hue: "text-module-signal" },
  { n: "04", hue: "text-module-scout" }
] as const;

/** The palette, in reading order: identity, status, the five module marks, then
 *  the field they sit on. `key` names the row; the token is the only value. */
export const PALETTE = [
  { key: "accent", token: "--accent" },
  { key: "success", token: "--success" },
  { key: "warning", token: "--warning" },
  { key: "danger", token: "--danger" },
  { key: "info", token: "--info" },
  { key: "axis", token: "--module-axis" },
  { key: "orbit", token: "--module-orbit" },
  { key: "signal", token: "--module-signal" },
  { key: "scout", token: "--module-scout" },
  { key: "north", token: "--module-north" },
  { key: "bg", token: "--bg" },
  { key: "card", token: "--s2" },
  { key: "raised", token: "--s4" },
  { key: "line", token: "--line2" },
  { key: "text", token: "--tx" },
  { key: "quiet", token: "--tx4" }
] as const;

/** The three voices, each shown in the job it holds. The samples are figures and
 *  labels, not sentences, so they read the same in both languages. */
const VOICES = [
  { key: "serif", cls: "font-serif text-28 leading-display" },
  { key: "display", cls: "font-display text-18 font-600 tracking-[.02em]" },
  { key: "mono", cls: "font-mono text-22" }
] as const;

/**
 * The specimen figures the in-hand frame carries. Figures, not copy: they read
 * the same in both languages, exactly like the mono voice sample above. `hue`
 * is the token the delta is coloured by — down is not automatically bad, so the
 * direction is stated rather than derived.
 */
export const IN_HAND = [
  { key: "open", value: "34", delta: "+6", hue: "text-warning" },
  { key: "cleared", value: "18", delta: "+4", hue: "text-success" },
  { key: "response", value: "6.2m", delta: "−18%", hue: "text-success" },
  { key: "exposure", value: "41.8M", delta: "+2.1%", hue: "text-tx4" }
] as const;

/**
 * The specimen machine. Not a copy of a real one — a real one lives beside the
 * screen that draws it (routes/txn-detail.tsx, claim-detail.tsx, case-detail.tsx,
 * policy-detail.tsx) — but the same shape, so the playground documents the two
 * decisions every caller has to make: which path is the spine, and which states
 * are exits rather than steps.
 */
export const SPECIMEN_MACHINE: FlowMachine = {
  transitions: {
    drafted: ["approved", "rejected"],
    approved: ["posting", "rejected"],
    posting: ["posted", "failed"],
    posted: [],
    rejected: [],
    failed: ["posting"]
  },
  spine: ["drafted", "approved", "posting", "posted"],
  exits: ["rejected", "failed"]
};

/**
 * A history with an `at` and an `actor` on each hop, because a flow that cannot
 * say when or by whom is a picture rather than a record. Fixed instants, not
 * `Date.now()`: a doctrine page that shifts every hour is a page no screenshot
 * can review.
 */
export const SPECIMEN_VISITS: readonly FlowVisit[] = [
  { state: "drafted", at: 1_763_000_000_000, actor: "svc:axis-lifecycle" },
  { state: "approved", at: 1_763_003_600_000, actor: "user:underwriter" }
];

/**
 * A balanced posting, and the legs a real one carries: an account code, the
 * reader's name for it, a side, a minor-unit amount, and the seal docs/19 §10
 * asks to make visible on a line that can no longer move.
 */
export const SPECIMEN_LEGS: readonly FlowLeg[] = [
  { id: "l1", account: "1100", label: "Receivable", side: "debit", amountMinor: 428_50, sealed: true },
  { id: "l2", account: "4000", label: "Written premium", side: "credit", amountMinor: 372_61, sealed: true },
  { id: "l3", account: "2200", label: "Levy payable", side: "credit", amountMinor: 55_89, sealed: true }
];

/**
 * A commentary the server would serve: the sentence, the evidence it was
 * grounded against, the grounding lines verbatim, and the provenance of the run
 * that wrote it. `coverage` is a COUNT of contracts on the book — the specimen
 * says so out loud because an earlier version of this component printed it as a
 * percentage under the word "Uncovered".
 */
export const SPECIMEN_COMMENTARY: WhitespaceCommentary = {
  whitespaceId: "wsp_specimen",
  category: "motor",
  status: "validated",
  commentary: "Demand is firm on this line and only one rival on the panel covers it.",
  evidence: { category: "motor", momentum: 78, coverage: 2400, competitionScore: 30, signalCount: 34 },
  why: [
    "Category: motor",
    "Demand momentum score (0-100): 78",
    "Active policies on the book for this category: 2400",
    "Competition score (0-100, share of the panel that bids): 30",
    "Demand signals behind this candidate: 34"
  ],
  ai: {
    marker: "\u2726",
    auditId: "aud_specimen",
    model: "claude-sonnet-5",
    provider: "anthropic",
    tier: "cloud",
    at: 1_763_000_000_000
  },
  suppressed: false
};

/** The same cell under the k-anonymity floor: no sentence, no evidence, no ✦. */
export const SPECIMEN_SUPPRESSED: WhitespaceCommentary = {
  ...SPECIMEN_COMMENTARY,
  commentary: null,
  evidence: null,
  why: [],
  ai: null,
  suppressed: true
};

/** The ledger's totals, as `balanceCheck` returns them — never re-derived here. */
export const SPECIMEN_BALANCE: FlowBalance = {
  debitMinor: 428_50,
  creditMinor: 428_50,
  deltaMinor: 0,
  balanced: true
};

const LABELS: Labels = {
  en: {
    eyebrow: "Horizon — the doctrine",
    headline: "Software that takes the shape of the person using it.",
    lead:
      "Most platforms ship one interface and hang role permissions off it: the same navigation, fewer items. This one inverts that. The identity is the interface — each role arrives in a workspace built for the work it does, and the seam between them is a first-class object rather than a disabled button.",
    "rule.01.title": "The identity is the interface",
    "rule.01.body":
      "Your roles decide the workspace you land in, the rail you navigate by and the home you read. Nothing hides behind a greyed-out control: a surface you have no claim on is absent, not disabled.",
    "rule.01.why": "packages/core lens · docs/06",
    "rule.02.title": "AI is ambient, never modal",
    "rule.02.body":
      "Drafts arrive as ghost text and quiet chips beside the work, never as a dialogue that stops it. Every artifact carries one ✦ and an inspectable why, and nothing is sent for you outside the autonomy policy.",
    "rule.02.why": "docs/15 §4",
    "rule.03.title": "Consequence waits for a person",
    "rule.03.body":
      "Anything that moves money or contractual state is a transaction: an idempotency key, a state machine, balanced journal lines, an approval. Automation is an allowlist a tenant writes, never a default we ship.",
    "rule.03.why": "docs/19",
    "rule.04.title": "Vocabulary is data",
    "rule.04.body":
      "The nouns in every label come from the active domain pack; the name, mark and accent above come from the tenant. There is not one brand string in this screen — including the one at the top of it.",
    "rule.04.why": "docs/21 · docs/01 §6",
    "palette.heading": "Palette — inherited, re-weighted",
    "palette.note": "Swatches read the live token. Re-theme the tenant and this page re-paints with it.",
    "palette.accent": "Accent",
    "palette.success": "Success",
    "palette.warning": "Warning",
    "palette.danger": "Danger",
    "palette.info": "Information",
    "palette.axis": "Operations",
    "palette.orbit": "Conversations",
    "palette.signal": "Marketing",
    "palette.scout": "Market",
    "palette.north": "Insight",
    "palette.bg": "Field",
    "palette.card": "Card",
    "palette.raised": "Raised",
    "palette.line": "Line",
    "palette.text": "Text",
    "palette.quiet": "Quiet text",
    "type.heading": "Type — three voices, one per job",
    "voice.serif.sample": "The narrated line",
    "voice.serif.note": "One human sentence per surface, and never twice.",
    "voice.display.sample": "STRUCTURE & LABELS",
    "voice.display.note": "Module marks and micro-labels, tracked wide, never bolder than 600.",
    "voice.mono.sample": "41.8M · 6.2 min · −18.4%",
    "voice.mono.note": "Every figure, reference and tick — so columns of numbers line up.",
    "hero.heading": "Hero figures — every number is a door",
    "hero.note":
      "The figure at the top of a screen counts rows, so clicking it lists exactly those rows: one predicate over one array, never a second query that can disagree with the first. The tile whose lens is showing is marked; a figure with no rows behind it — a median, a rate, an age — is plain text and does not pretend to be clickable.",
    "hero.inert": "A duration, not a set of rows",
    heroAll: "Show everything",
    "flow.heading": "Process flows — the machine, not a drawing of one",
    "flow.note":
      "A flow is rendered from two things that are already true: the state machine the transaction is documented to follow, and the journal lines it posted. The spine is the path when nothing goes wrong; an exit is how it ends instead of continuing, so a live transaction is never told it is pending its own failure. A state the data claims but the machine does not document is reported as drift and refused, never drawn.",
    "flow.state.title": "Where it stands",
    "flow.state.label": "Specimen transaction lifecycle",
    "flow.post.title": "Value moving",
    "flow.post.label": "Specimen journal posting",
    "flow.post.note": "Totals come from the ledger. The legs on screen are re-added only to check they say the same thing — a mismatch downgrades the verdict, it never gets smoothed over.",
    "flow.state.drafted": "Drafted",
    "flow.state.approved": "Approved",
    "flow.state.posting": "Posting",
    "flow.state.posted": "Posted",
    "flow.state.rejected": "Rejected",
    "flow.state.failed": "Failed",
    "flow.debits": "Out of",
    "flow.credits": "Into",
    "ai.heading": "Ambient AI — a chip, a ghost and a tray",
    "pull.heading": "The design pull",
    "pull.note": "Every screen the Constellation design file drew, over its own sample data. Reference, not workspaces — the live screens are in the rail.",
    "ai.note":
      "Model output never arrives as a modal and is never sent on its own. It sits beside the thing it is about: a hover reading that is in the accessibility tree before any hover, a chip whose evidence opens as the exact lines the sentence was written from, and a tray of drafts to read rather than something that already happened. The ✦ is a claim that a model wrote it — a deterministic fallback sentence carries none, and a cell below the k-anonymity floor says why it is silent instead of going blank.",
    "ai.ghost": "Hover reading",
    "ai.ghostNote": "Hover or tab to the dot. Present in the markup either way.",
    "ai.dot": "Specimen whitespace",
    "ai.chip": "With a reading",
    "ai.chipHidden": "Under the k-anonymity floor",
    "ai.tray": "Drafts, queued",
    "ai.trayDone": "Drafts, written",
    "hand.heading": "In hand",
    "hand.note":
      "The same doctrine at 328px: one narrated line, figures in mono, the ambient draft as a card beside the work rather than a dialogue over it. Nothing is re-styled for the phone — the tokens are the tokens.",
    "hand.title": "Your shift",
    "hand.head": "Two decisions are waiting on you.",
    "hand.open": "Open with you",
    "hand.cleared": "Cleared today",
    "hand.response": "Median response",
    "hand.exposure": "Exposure",
    "hand.card.label": "Drafted for you",
    "hand.card.body":
      "The renewal is priced 4% under last term because the vehicle moved to a lower-risk district. Nothing has been sent.",
    "hand.card.primary": "Review",
    "hand.card.secondary": "Why this",
    "hand.footer": "Approvals and evidence stay on the phone; anything consequential still waits for you to press it.",
    "hand.tab1": "Shift",
    "hand.tab2": "Records",
    "post.heading": "The post itself",
    "post.note": "A cleared SIGNAL variant rendered at the three frames the networks take, from the tenant\u2019s own brand. Preview and download are the same bytes.",
    "post.headline": "Cover the gap before renewal.",
    "post.body": "Two minutes, no paperwork, and your no-claim year stays yours.",
    "post.kicker": "Renewal save",
    "slider.heading": "Price knobs — a range, and a box to type in",
    "slider.note":
      "A criterion a customer can move is a native `input[type=range]`: arrows, Home/End and Page Up/Down work, the thumb is grabbable on a phone, and the track reverses itself in Arabic without a line of code. Two things the platform does not give are added — the value announced in words rather than as a bare number, and a typed box beside it, because dragging is the one gesture some people cannot make. Both controls carry the same bounds, so typing past the end is refused the way dragging past it is. The panel decides which knobs exist: a criterion that moves no price is never drawn.",
    "slider.age": "Driver age",
    "slider.ageNumber": "Driver age, exact value",
    "slider.cover": "Value to insure",
    "slider.coverNumber": "Value to insure, exact value",
    "slider.indicative": "Moving a knob asks the panel to price again. Nothing shown that way is an offer."
  },
  ar: {
    eyebrow: "Horizon — العقيدة التصميمية",
    headline: "برنامج يأخذ شكل من يستخدمه.",
    lead:
      "معظم المنصات تشحن واجهة واحدة ثم تعلّق عليها صلاحيات الأدوار: التنقل نفسه، وعناصر أقل. هنا العكس. الهوية هي الواجهة — كل دور يصل إلى مساحة عمل مبنية للعمل الذي يؤديه، والفاصل بينها كائن قائم بذاته لا زرًا معطلًا.",
    "rule.01.title": "الهوية هي الواجهة",
    "rule.01.body":
      "أدوارك تحدد مساحة العمل التي تصل إليها، وشريط التنقل، والصفحة التي تقرؤها. لا شيء يختبئ خلف عنصر باهت: السطح الذي لا صلاحية لك عليه غائب لا معطل.",
    "rule.01.why": "packages/core lens · docs/06",
    "rule.02.title": "الذكاء الاصطناعي محيط لا حاجز",
    "rule.02.body":
      "المسودات تصل كنص شبحي ورقائق هادئة بجوار العمل، لا كنافذة توقفه. كل ناتج يحمل علامة ✦ واحدة وسببًا قابلًا للفحص، ولا يُرسل شيء نيابة عنك خارج سياسة الاستقلالية.",
    "rule.02.why": "docs/15 §4",
    "rule.03.title": "ما له أثر ينتظر إنسانًا",
    "rule.03.body":
      "كل ما يحرك مالًا أو حالة تعاقدية معاملة: مفتاح تكرار، وآلة حالات، وقيود متوازنة، وموافقة. الأتمتة قائمة سماح يكتبها المستأجر، لا وضعًا افتراضيًا نشحنه.",
    "rule.03.why": "docs/19",
    "rule.04.title": "المفردات بيانات",
    "rule.04.body":
      "أسماء الأشياء في كل تسمية تأتي من حزمة المجال الفعّالة، والاسم والشعار واللون تأتي من المستأجر. لا توجد في هذه الشاشة سلسلة علامة تجارية واحدة — بما في ذلك التي في أعلاها.",
    "rule.04.why": "docs/21 · docs/01 §6",
    "palette.heading": "اللوحة — موروثة، معاد وزنها",
    "palette.note": "كل مربع يقرأ الرمز الحي. غيّر سمة المستأجر وتعاد طلاء هذه الصفحة معها.",
    "palette.accent": "لون الهوية",
    "palette.success": "نجاح",
    "palette.warning": "تحذير",
    "palette.danger": "خطر",
    "palette.info": "معلومة",
    "palette.axis": "العمليات",
    "palette.orbit": "المحادثات",
    "palette.signal": "التسويق",
    "palette.scout": "السوق",
    "palette.north": "التحليل",
    "palette.bg": "الحقل",
    "palette.card": "البطاقة",
    "palette.raised": "المرتفع",
    "palette.line": "الخط",
    "palette.text": "النص",
    "palette.quiet": "النص الهادئ",
    "type.heading": "الخط — ثلاثة أصوات، صوت لكل مهمة",
    "voice.serif.sample": "السطر المروي",
    "voice.serif.note": "جملة إنسانية واحدة لكل سطح، ولا تتكرر.",
    "voice.display.sample": "البنية والتسميات",
    "voice.display.note": "علامات الوحدات والتسميات الدقيقة، متباعدة الأحرف، ولا أثقل من 600.",
    "voice.mono.sample": "41.8M · 6.2 min · −18.4%",
    "voice.mono.note": "كل رقم ومرجع وعلامة قياس — حتى تصطف أعمدة الأرقام.",
    "hero.heading": "الأرقام الرئيسية — كل رقم باب",
    "hero.note":
      "الرقم في أعلى الشاشة يعدّ سطورًا، فالنقر عليه يعرض تلك السطور بعينها: محدد واحد على مصفوفة واحدة، لا استعلامًا ثانيًا قد يخالف الأول. والبطاقة التي عدستها معروضة مُعلَّمة؛ والرقم الذي لا سطور خلفه — وسيط أو نسبة أو عمر — نص عادي لا يتظاهر بأنه قابل للنقر.",
    "hero.inert": "مدة زمنية لا مجموعة سطور",
    heroAll: "إظهار الكل",
    "flow.heading": "مسارات العمليات — الآلة نفسها لا رسمًا لها",
    "flow.note":
      "يُرسم المسار من أمرين قائمين بالفعل: آلة الحالات الموثّقة التي تتبعها الحركة، وسطور اليومية التي سجّلتها. العمود الفقري هو المسار حين لا يحدث خطأ؛ والمخرج هو كيف تنتهي بدل أن تستمر، فلا تُخبر حركة قائمة أنها في انتظار فشلها. وأي حالة تدّعيها البيانات ولا توثّقها الآلة تُعلَن انحرافًا وتُرفَض، ولا تُرسَم أبدًا.",
    "flow.state.title": "موضعها الآن",
    "flow.state.label": "دورة حياة حركة نموذجية",
    "flow.post.title": "القيمة تتحرّك",
    "flow.post.label": "قيد يومية نموذجي",
    "flow.post.note": "الإجماليات من دفتر الأستاذ. وتُجمَع السطور المعروضة للتحقق أنها ذاتها التي أنتجت الإجماليات — والتعارض يخفض الحكم ولا يُغطّى أبدًا.",
    "flow.state.drafted": "مسودة",
    "flow.state.approved": "معتمدة",
    "flow.state.posting": "قيد الترحيل",
    "flow.state.posted": "مُرحَّلة",
    "flow.state.rejected": "مرفوضة",
    "flow.state.failed": "فاشلة",
    "flow.debits": "من",
    "flow.credits": "إلى",
    "ai.heading": "ذكاء محيطي — شارة وطيف ودرج",
    "pull.heading": "ملف التصميم",
    "pull.note": "كل شاشة رسمها ملف تصميم Constellation، ببياناتها التجريبية. مرجع وليست مساحات عمل — الشاشات الفعلية في شريط التنقل.",
    "ai.note":
      "لا يصل ناتج النموذج في نافذة منبثقة ولا يُرسل من تلقائه. بل يجلس بجوار ما يتحدث عنه: قراءة تظهر عند التحويم وهي أصلًا في شجرة الوصول قبله، وشارة تفتح أدلتها كالسطور ذاتها التي كُتبت منها الجملة، ودرج مسودات يُقرأ لا أمر وقع بالفعل. والعلامة ✦ ادّعاء بأن نموذجًا كتبها — فالجملة الاحتياطية الحتمية لا تحملها، والخانة تحت حد إخفاء الهوية تقول سبب صمتها بدل أن تُترك فارغة.",
    "ai.ghost": "قراءة التحويم",
    "ai.ghostNote": "حوّم أو انتقل بالتبويب إلى النقطة. وهي حاضرة في الترميز في الحالتين.",
    "ai.dot": "فجوة نموذجية",
    "ai.chip": "مع قراءة",
    "ai.chipHidden": "تحت حد إخفاء الهوية",
    "ai.tray": "مسودات في الانتظار",
    "ai.trayDone": "مسودات مكتوبة",
    "hand.heading": "في اليد",
    "hand.note":
      "العقيدة نفسها بعرض 328 بكسل: سطر مروي واحد، وأرقام بخط أحادي، والمسودة المحيطة بطاقة بجوار العمل لا نافذة فوقه. لا شيء يُعاد تنسيقه للهاتف — الرموز هي الرموز.",
    "hand.title": "نوبتك",
    "hand.head": "قراران ينتظران قرارك.",
    "hand.open": "مفتوح لديك",
    "hand.cleared": "أُنجز اليوم",
    "hand.response": "وسيط زمن الرد",
    "hand.exposure": "التعرّض",
    "hand.card.label": "مسودة لك",
    "hand.card.body":
      "التجديد مسعّر أقل بنسبة ٤٪ من المدة السابقة لأن المركبة انتقلت إلى منطقة أقل خطرًا. لم يُرسل شيء.",
    "hand.card.primary": "مراجعة",
    "hand.card.secondary": "لماذا",
    "hand.footer": "الموافقات والأدلة تبقى على الهاتف؛ وكل ما له أثر ينتظر ضغطتك.",
    "hand.tab1": "النوبة",
    "hand.tab2": "السجلات",
    "post.heading": "المنشور نفسه",
    "post.note": "نسخة معتمدة من سيجنال بمقاسات المنصات الثلاثة، بهوية العميل نفسه. المعاينة والتنزيل ملف واحد.",
    "post.headline": "غطِّ الفجوة قبل التجديد.",
    "post.body": "دقيقتان دون أوراق، وخصمك يبقى لك.",
    "post.kicker": "حملة التجديد",
    "slider.heading": "مقابض السعر — شريط وخانة للكتابة",
    "slider.note":
      "كل معيار يمكن للعميل تحريكه هو عنصر `input[type=range]` أصلي: الأسهم وHome/End وPage Up/Down تعمل، والمقبض قابل للسحب على الهاتف، والمسار ينعكس في العربية دون سطر واحد. أضفنا ما لا توفره المنصة: نطق القيمة بكلمات لا كرقم مجرد، وخانة كتابة بجواره لأن السحب حركة لا يقدر عليها الجميع. الحدّان متطابقان في الاثنين، فالكتابة خارج المدى تُرفض كما يُرفض السحب خارجه. اللوحة هي من تحدد المقابض: معيار لا يحرّك سعرًا لا يُرسم.",
    "slider.age": "عمر السائق",
    "slider.ageNumber": "عمر السائق، القيمة الدقيقة",
    "slider.cover": "القيمة المراد تأمينها",
    "slider.coverNumber": "القيمة المراد تأمينها، القيمة الدقيقة",
    "slider.indicative": "تحريك أي مقبض يطلب تسعيرًا جديدًا من اللوحة. وما يظهر بهذه الطريقة ليس عرضًا ملزمًا."
  }
};

/**
 * The comparison knobs (packages/ui primitives.tsx §Slider), live rather than
 * drawn — a specimen you cannot tab into documents nothing. State is local: the
 * real one posts to the portal's re-price action, which is per-screen wiring.
 * Mobile parity: both controls are 44px tall and the pair wraps at 328px.
 */
function SliderSpecimen({ l, locale }: { l: (key: string) => string; locale: string }) {
  const [age, setAge] = useState(34);
  const [coverMajor, setCoverMajor] = useState(28_000);
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "AED", maximumFractionDigits: 0 });

  return (
    <div className="flex flex-col gap-4 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
      <Field label={l("slider.age")} id="specimen-age">
        <Slider
          min={18}
          max={99}
          value={age}
          onValueChange={setAge}
          numberLabel={l("slider.ageNumber")}
          valueText={new Intl.NumberFormat(locale).format(age)}
        />
      </Field>
      <Field label={l("slider.cover")} id="specimen-cover">
        <Slider
          min={0}
          max={200_000}
          step={1_000}
          value={coverMajor}
          onValueChange={setCoverMajor}
          numberLabel={l("slider.coverNumber")}
          // A bare "28000" read aloud is not a price. The announced value is the
          // one on screen, currency and all.
          valueText={money.format(coverMajor)}
        />
      </Field>
      <p className="text-13 leading-body text-tx5">{l("slider.indicative")}</p>
    </div>
  );
}

export function Doctrine({
  locale,
  brandName = "",
  accent
}: {
  locale: string;
  /** The tenant's own name on the post specimen — never a literal (CLAUDE.md §5). */
  brandName?: string;
  accent?: string | undefined;
}) {
  const l = labelsFrom(LABELS)(locale);
  // The SCOUT specimens read from SCOUT's own catalogue, not this page's:
  // a playground that re-labels a component documents labels nobody ships.
  const wl = commentaryLabels(locale);

  return (
    <div className="lyra-enter mx-auto flex max-w-[1000px] flex-col gap-8 py-2">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-12 uppercase tracking-[.18em] text-tx5">{l("eyebrow")}</p>
        <hr className="border-0 border-t border-line2" />
        <h1 className="font-serif text-36 leading-display text-tx0">{l("headline")}</h1>
        <p className="max-w-[78ch] text-14 leading-body text-tx4">{l("lead")}</p>
      </header>

      <div className="lyra-stagger grid gap-3 sm:grid-cols-2">
        {RULES.map((rule) => (
          <article key={rule.n} className="rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <p className={`font-mono text-12 ${rule.hue}`}>{rule.n}</p>
            <h2 className="mt-2 font-display text-16 font-600 text-tx">{l(`rule.${rule.n}.title`)}</h2>
            <p className="mt-2 text-13 leading-body text-tx4">{l(`rule.${rule.n}.body`)}</p>
            <p className="mt-3 font-mono text-12 text-tx5">{l(`rule.${rule.n}.why`)}</p>
          </article>
        ))}
      </div>

      <div className="grid gap-7 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("palette.heading")}</h2>
          <p className="text-13 leading-body text-tx4">{l("palette.note")}</p>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
            {PALETTE.map((swatch) => (
              <li key={swatch.token} className="flex flex-col gap-1">
                {/* The swatch is the token, not a copy of it. */}
                <span
                  className="block h-[42px] rounded-2 border border-line2"
                  style={{ background: `var(${swatch.token})` }}
                />
                <span className="text-12 text-tx4">{l(`palette.${swatch.key}`)}</span>
                {/* A token name is an identifier: untranslated in both directions,
                    and forced left-to-right so it does not shred in Arabic. */}
                <span className="truncate font-mono text-12 text-tx5" dir="ltr">
                  {swatch.token}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("type.heading")}</h2>
          <ul className="flex flex-col gap-4">
            {VOICES.map((voice) => (
              <li key={voice.key} className="border-t border-line2 pt-3">
                <p className={`${voice.cls} text-tx0`}>{l(`voice.${voice.key}.sample`)}</p>
                <p className="mt-2 text-13 leading-body text-tx4">{l(`voice.${voice.key}.note`)}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* components/hero.tsx, shown in the state that matters: one tile drilled
          into, its siblings still reachable, the way back out present, and one
          figure that is deliberately not a link. The hrefs are this page's own
          `?focus=` so the specimen is clickable rather than drawn — it filters
          nothing here, which is the point: the wiring is per-screen, only the
          affordance is shared. Mobile parity: the same three figures stack in
          the 328px frame below, where they are the rows of the shift list. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("hero.heading")}</h2>
          <p className="max-w-[60ch] text-13 leading-body text-tx4">{l("hero.note")}</p>
        </div>
        <HeroWall focus="open" allLabel={l("heroAll")}>
          {IN_HAND.slice(0, 2).map((row, i) => (
            <HeroStat
              key={row.key}
              label={l(`hand.${row.key}`)}
              value={row.value}
              to={`?${FOCUS}=${row.key}`}
              active={i === 0}
            />
          ))}
          <HeroStat label={l("hand.response")} value="6.2m" hint={l("hero.inert")} />
        </HeroWall>
      </section>

      {/* packages/ui/src/flow.tsx, both components, in the state that carries the
          doctrine: a history with timestamps and actors behind it, a current
          state, the pending remainder the machine documents, and the two exits
          drawn as endings rather than steps. `posting` is current here on
          purpose — it is the one state with both a past and a future, so the
          three step tones are all on screen at once. The posting beside it is
          balanced and sealed; the discrepancy path is exercised in
          packages/ui/src/flow.test.tsx rather than drawn, because a doctrine
          page asserting a broken ledger reads as one. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("flow.heading")}</h2>
          <p className="max-w-[78ch] text-13 leading-body text-tx4">{l("flow.note")}</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("flow.state.title")}</h3>
            <StateFlow
              machine={SPECIMEN_MACHINE}
              visits={SPECIMEN_VISITS}
              current="posting"
              label={l("flow.state.label")}
              labelFor={(state) => l(`flow.state.${state}`)}
              locale={locale}
            />
          </div>
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("flow.post.title")}</h3>
            <PostingFlow
              legs={SPECIMEN_LEGS}
              currency="ZAR"
              balance={SPECIMEN_BALANCE}
              fromLabel={l("flow.debits")}
              toLabel={l("flow.credits")}
              label={l("flow.post.label")}
              note={l("flow.post.note")}
              locale={locale}
            />
          </div>
        </div>
      </section>

      {/* The design pull's 66 fixture screens used to sit in every reader's
          rail. They are reference, so they are listed here. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("pull.heading")}</h2>
          <p className="max-w-[78ch] text-13 leading-body text-tx4">{l("pull.note")}</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {surfaceCatalogue(shouldInclude).map(({ group, items }) => (
            <nav key={group} aria-label={group} className="flex flex-col gap-1">
              <h3 className="font-mono text-12 uppercase text-tx5">{group}</h3>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.href}>
                    <Link to={item.href} className="font-ui text-13 text-tx3 underline-offset-4 hover:text-tx hover:underline">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </section>

      {/* components/whitespace-commentary.tsx and components/signal-handover.tsx:
          the three ambient-AI surfaces SCOUT added, each in the two states that
          carry the rule. The ghost is drawn twice — once with a reading, once
          suppressed — because "blank" and "we will not describe this few people"
          are different answers and the reader has to be able to tell them apart.
          The tray is drawn queued as well as written: a consequential action may
          come back waiting for approval, and that is not a failure state. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("ai.heading")}</h2>
          <p className="max-w-[78ch] text-13 leading-body text-tx4">{l("ai.note")}</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("ai.ghost")}</h3>
            <p className="text-13 leading-body text-tx4">{l("ai.ghostNote")}</p>
            {/* The `group` and the height are the dot's job on the real chart
                (routes/scout-radar.tsx); the ghost only positions itself. */}
            <div className="group relative flex h-32 items-end justify-center pb-2">
              <button
                type="button"
                aria-describedby="wc-specimen"
                className="size-3 rounded-full bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="sr-only">{l("ai.dot")}</span>
              </button>
              <CommentaryGhost id="wc-specimen" commentary={SPECIMEN_COMMENTARY} l={wl} locale={locale} />
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("ai.chip")}</h3>
            <CommentaryChip commentary={SPECIMEN_COMMENTARY} l={wl} locale={locale} />
            <h3 className="font-display text-14 font-600 text-tx">{l("ai.chipHidden")}</h3>
            <CommentaryChip commentary={SPECIMEN_SUPPRESSED} l={wl} locale={locale} />
          </div>
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("ai.tray")}</h3>
            <DraftTray
              promoted={{ state: "pending_approval", campaignId: null, drafts: 0 }}
              mayOpen={false}
              l={wl}
              locale={locale}
            />
          </div>
          <div className="flex flex-col gap-3 rounded-3 border border-line2 bg-s2 px-[18px] py-[17px]">
            <h3 className="font-display text-14 font-600 text-tx">{l("ai.trayDone")}</h3>
            <DraftTray
              promoted={{ state: "committed", campaignId: "cmp_specimen", drafts: 3 }}
              mayOpen={true}
              l={wl}
              locale={locale}
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-line2 pt-7 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex flex-1 flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("slider.heading")}</h2>
          <p className="max-w-[60ch] text-13 leading-body text-tx4">{l("slider.note")}</p>
        </div>
        <div className="w-full lg:max-w-[420px]">
          <SliderSpecimen l={l} locale={locale} />
        </div>
      </section>

      {/* CLAUDE.md's definition of done asks every UI change to note its mobile
          parity; this is where that is noted. A specimen, not a control: the
          frame is inert, and the phone itself is apps/mobile. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex flex-1 flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("hand.heading")}</h2>
          <p className="max-w-[60ch] text-13 leading-body text-tx4">{l("hand.note")}</p>
        </div>

        <div className="w-[328px] max-w-full flex-none rounded-[25px] border border-line4 bg-bg p-[9px] shadow-raised">
          <div className="flex h-[604px] flex-col overflow-hidden rounded-[18px] border border-line2 bg-s1">
            <div className="flex flex-none items-center justify-between px-4 py-2 font-mono text-12 text-tx5">
              {/* A drawn status bar, not the reader's clock: a doctrine page that
                  ticks reads as a live screen it is not. */}
              <span dir="ltr">09:41</span>
              <span aria-hidden="true">▮▮▮ ◗</span>
            </div>

            <div className="flex flex-none items-center gap-2 px-4 pb-2">
              <span className="block h-[18px] w-[18px] rounded-orbit bg-accent" aria-hidden="true" />
              <span className="text-12 text-tx4">{l("hand.title")}</span>
            </div>

            <div className="flex-1 overflow-hidden px-4 pb-4">
              <p className="font-serif text-22 leading-display text-tx0">{l("hand.head")}</p>

              <ul className="mt-3 flex flex-col">
                {IN_HAND.map((row) => (
                  <li
                    key={row.key}
                    className="flex items-baseline justify-between gap-2 border-b border-line2 py-2.5"
                  >
                    <span className="text-12 text-tx4">{l(`hand.${row.key}`)}</span>
                    <span className="flex flex-none items-baseline gap-2 font-mono">
                      <span className="text-13 text-tx">{row.value}</span>
                      {/* Fixed width so the deltas form a column rather than a
                          ragged edge — the same reason the mono voice exists. */}
                      <span className={`w-11 text-end text-12 ${row.hue}`} dir="ltr">
                        {row.delta}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 border border-line2 bg-s2 p-3">
                <p className="flex items-center gap-2">
                  <span className="text-accent" aria-hidden="true">
                    ✦
                  </span>
                  <span className="font-display text-12 uppercase tracking-[.14em] text-tx4">
                    {l("hand.card.label")}
                  </span>
                </p>
                <p className="mt-2 text-13 leading-body text-tx">{l("hand.card.body")}</p>
                <p className="mt-3 flex gap-2">
                  {/* WCAG 2.2 AA target size, drawn at the phone's own scale:
                      44px is the floor the real app is built to. */}
                  <span className="flex h-11 flex-1 items-center justify-center rounded-md bg-accent text-13 font-600 text-accent-contrast">
                    {l("hand.card.primary")}
                  </span>
                  <span className="flex h-11 w-[88px] flex-none items-center justify-center rounded-md border border-line4 text-13 text-tx3">
                    {l("hand.card.secondary")}
                  </span>
                </p>
              </div>

              <p className="mt-4 text-12 leading-body text-tx5">{l("hand.footer")}</p>
            </div>

            <div className="flex flex-none border-t border-line2">
              <span className="flex h-12 flex-1 items-center justify-center text-12 text-accent">
                {l("hand.tab1")}
              </span>
              <span className="flex h-12 flex-1 items-center justify-center text-12 text-tx5">
                {l("hand.tab2")}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* The one artifact the platform emits as a file rather than a screen, so
          it is the one specimen that has to be drawn from its real renderer —
          packages/ui/src/post-card.ts, the same call the studio and the
          download make. Locale drives the face and the direction. */}
      <section className="flex flex-col gap-4 border-t border-line2 pt-7">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-16 font-600 text-tx">{l("post.heading")}</h2>
          <p className="max-w-[60ch] text-13 leading-body text-tx4">{l("post.note")}</p>
        </div>
        <ul className="flex flex-wrap items-start gap-5">
          {(Object.keys(POST_RATIOS) as PostRatio[]).map((ratio) => (
            <li key={ratio} className="flex flex-col gap-2">
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                  postCardSvg({
                    headline: l("post.headline"),
                    body: l("post.body"),
                    kicker: l("post.kicker"),
                    brandName: brandName,
                    accent,
                    locale,
                    ratio
                  })
                )}`}
                alt={l("post.headline")}
                width={POST_RATIOS[ratio].w}
                height={POST_RATIOS[ratio].h}
                className="w-[200px] rounded-md border border-line2"
              />
              <span className="font-mono text-12 text-tx5" dir="ltr">
                {POST_RATIOS[ratio].w}×{POST_RATIOS[ratio].h}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function DesignRoute() {
  const shell = useShellData();
  return (
    <Doctrine
      locale={shell?.locale ?? "en"}
      brandName={shell?.brand?.name ?? ""}
      accent={shell?.brand?.palette?.accent}
    />
  );
}
