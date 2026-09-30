import { createHmac } from "node:crypto";
import type { BENCH } from "./bench.js";
import { call, find, pool, type Client } from "./lib.js";
import type { Seat } from "./month.js";

export interface FlowContext {
  base: string;
  anon: Client;
  people: Seat[];
  admin: Seat;
  bench: typeof BENCH;
}

/** How far each funnel got — the report's "did the business actually run". */
export const funnel = new Map<string, number>();
const bump = (k: string, n = 1) => funnel.set(k, (funnel.get(k) ?? 0) + n);

const DAY = 86_400_000;
const SLUG = "gonxt";
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * A call that may be stopped by an approval gate: the approver decides, the
 * requester repeats the identical call (docs/19, packages/core approvals.ts).
 * Returns the final response; counts gates met and cleared.
 */
async function gated(
  requester: Client,
  approver: Client,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any; text: string }> {
  let res = await call(requester, method, path, body);
  for (let round = 0; round < 3 && res.status === 403 && /approval_required/.test(res.text); round++) {
    const approvalId = res.json?.approval_id ?? res.json?.approvalId;
    const key = res.json?.policy_key ?? res.json?.policyKey ?? "?";
    bump(`gate:${key}`);
    const decided = await call(approver, "POST", `/v1/me/approvals/${approvalId}/decide`, { decision: "approved" });
    if (decided.status >= 300) {
      bump(`gate-undecidable:${key}`);
      find({ severity: "medium", kind: "gate", route: `${method} ${path.replace(/\/[a-z]+_[0-9A-Z]+/g, "/{id}")}`, persona: approver.persona, status: decided.status, detail: `${key}: ${decided.text.slice(0, 160)}` });
      return res;
    }
    res = await call(requester, method, path, body);
  }
  return res;
}

export function flows(ctx: FlowContext) {
  const by = (email: string) => ctx.people.find((p) => p.email === `${email}@gonxt.ae`)!;
  const agent = by("layla.hassan");
  const lead = by("omar.farouk");
  const orbit = by("sara.nasser");
  const retention = by("yusuf.karim");
  const partners = by("dana.aziz");
  const orbitAdmin = by("hind.saqr");
  const marketer = by("noor.jamal");
  const exec = by("hala.zayed");
  const analyst = by("rana.hadid");
  const controller = by("faisal.omar");
  const controller2 = by("nadia.rahman");
  const finAnalyst = by("mona.idris");
  const compliance = by("khalid.rashed");
  const tenantAdmin = by("amina.saleh");
  const demo = ctx.admin;

  let webhook: { id: string; secret: string } | null = null;
  let motorProduct = "";
  let webChannel = "";
  const campaigns: string[] = [];
  const policies: string[] = [];
  const customers: string[] = [];

  /** Every GET list route a persona may read, for the "staff reads screens" load. */
  const readable = new Map<string, string[]>();

  async function setup(): Promise<void> {
    const hook = await call(tenantAdmin, "POST", "/v1/core/webhooks", { url: "https://hooks.example.invalid/lyra-sim", eventTypesJson: ["sim.never.emitted"] });
    if (hook.status === 201) webhook = { id: hook.json.id, secret: hook.json.secret };
    else find({ severity: "high", kind: "setup", route: "POST /v1/core/webhooks", persona: tenantAdmin.persona, status: hook.status, detail: hook.text.slice(0, 200) });

    const site = await call(ctx.anon, "GET", `/v1/portal/${SLUG}/site`);
    motorProduct = (site.json?.products ?? []).find((p: any) => p.line === "motor")?.id ?? site.json?.products?.[0]?.id ?? "";
    const ch = await call(lead, "GET", "/v1/dist/channels?key=gonxt-web");
    webChannel = ch.json?.data?.[0]?.id ?? "";

    const chat = await call(orbitAdmin, "POST", "/v1/orbit/channel-connectors", { provider: "lyra-webchat", transport: "web", label: "Web chat", secretsJson: {}, configJson: {}, status: "active" });
    if (chat.status >= 300) find({ severity: "medium", kind: "setup", route: "POST /v1/orbit/channel-connectors", persona: orbitAdmin.persona, status: chat.status, detail: chat.text.slice(0, 200) });

    // Four live campaigns, one per paid channel, the last flagged as holdout.
    for (const [i, channel] of ctx.bench.channels.entries()) {
      const c = await call(marketer, "POST", "/v1/signal/campaigns", {
        name: `Motor acquisition — ${channel}`,
        objective: "acquisition",
        channelsJson: JSON.stringify([channel]),
        budgetJson: JSON.stringify({ dailyMinor: Math.round(ctx.bench.spendMinorPerMonth / 30 / 4) }),
        ownerRef: "signal.lead",
        state: "draft",
        ...(i === 3 ? { holdout: true } : {})
      });
      if (c.status !== 201) {
        find({ severity: "high", kind: "setup", route: "POST /v1/signal/campaigns", persona: marketer.persona, status: c.status, detail: c.text.slice(0, 200) });
        continue;
      }
      campaigns.push(c.json.id);
      await gated(marketer, compliance, "PATCH", `/v1/signal/campaigns/${c.json.id}`, { state: "live" });
    }

    const spec = (await call(ctx.anon, "GET", "/openapi.json")).json;
    const lists = Object.entries(spec.paths as Record<string, any>)
      .filter(([p, m]) => m.get && !p.includes("{") && !/^\/v1\/(auth|portal|channels|scim)/.test(p))
      .map(([p, m]) => ({ p, perm: m.get.security?.[0]?.session?.[0] as string | undefined }));
    for (const seat of ctx.people) readable.set(seat.email, lists.filter((l) => !l.perm || seat.permissions.has(l.perm)).map((l) => l.p));
  }

  function sign(body: string): Record<string, string> {
    const ts = String(Date.now());
    const sig = createHmac("sha256", webhook!.secret).update(`${ts}.${body}`).digest("hex");
    return { "content-type": "application/json", "x-lyra-key-id": webhook!.id, "x-lyra-timestamp": ts, "x-lyra-signature": `v1=${sig}` };
  }

  async function signedTouch(touch: Record<string, unknown>): Promise<void> {
    if (!webhook) return;
    const raw = JSON.stringify(touch);
    const res = await call(ctx.anon, "POST", `/v1/portal/${SLUG}/track`, raw, sign(raw));
    bump(res.status < 300 ? `touch:${touch.touchType}` : `touch-refused:${touch.touchType}:${res.status}`);
  }

  async function acquisition(day: number): Promise<void> {
    const p = ctx.bench.perDay;
    // Anonymous traffic on the storefront pixel.
    const kinds = ["impression", "impression", "impression", "click", "visit"] as const;
    await pool(Array.from({ length: p.touches }, (_, i) => i), 16, async (i) => {
      const res = await call(ctx.anon, "POST", `/v1/portal/${SLUG}/track`, {
        touchType: kinds[i % kinds.length],
        channel: ctx.bench.channels[i % 4],
        anonId: `anon-${day}-${i}`,
        ...(campaigns[i % 4] ? { campaignId: campaigns[i % 4] } : {}),
        ...(i % 4 === 0 ? { gclid: `gclid-${day}-${i}` } : {})
      });
      bump(res.status < 300 ? "touch:anonymous" : `touch-refused:${res.status}`);
    });

    // Leads: the J-C1 self-serve quote, priced by the panel.
    const leads: { quoteRequestId: string; channel: string; campaign?: string }[] = [];
    await pool(Array.from({ length: p.leads }, (_, i) => i), 8, async (i) => {
      const email = `lead-${uid()}@sim.example`;
      const res = await call(ctx.anon, "POST", `/v1/portal/${SLUG}/leads`, {
        productId: motorProduct,
        name: i % 7 === 0 ? `محمد ${uid()}` : `Lead ${uid()}`,
        email,
        consent: true,
        inputs: { age: 22 + (i % 50), sumInsuredMinor: 5_000_000 + (i % 40) * 1_000_000, priorClaims: i % 9 === 0, vehicleUse: "private" }
      });
      if (res.status === 201 && res.json?.quoteRequestId) {
        bump("lead");
        if ((res.json.offers ?? []).length) bump("lead:priced");
        const channel = ctx.bench.channels[i % 4]!;
        leads.push({ quoteRequestId: res.json.quoteRequestId, channel, ...(campaigns[i % 4] ? { campaign: campaigns[i % 4] } : {}) });
        await signedTouch({ touchType: "lead", eventId: `lead-${res.json.quoteRequestId}`, channel, ...(campaigns[i % 4] ? { campaignId: campaigns[i % 4] } : {}) });
      } else bump(`lead-refused:${res.status}`);
    });

    // Binds: staff select the cheapest quoted response and bind (axis.bind gate).
    const toBind = leads.slice(0, p.binds);
    await pool(toBind, 4, async (l) => {
      const rs = await call(lead, "GET", `/v1/dist/quote-responses?requestId=${l.quoteRequestId}&limit=50`);
      const quoted = (rs.json?.data ?? []).filter((r: any) => r.state === "quoted" && r.premiumMinor > 0).sort((a: any, b: any) => a.premiumMinor - b.premiumMinor)[0];
      if (!quoted) return void bump("bind:no-quote");
      const sel = await call(lead, "POST", `/v1/dist/quote-requests/${l.quoteRequestId}/select`, { responseId: quoted.id });
      if (sel.status >= 300) return void bump(`bind:select-refused:${sel.status}`);
      const start = Date.now() + DAY;
      const bound = await gated(lead, demo, "POST", `/v1/axis/quote-responses/${quoted.id}/bind`, { policyNo: `SIM-${uid()}`.toUpperCase(), startAt: start, endAt: start + 365 * DAY });
      if (bound.status < 300) {
        bump("bind");
        const policyId = bound.json?.policy?.id ?? bound.json?.id;
        if (policyId) policies.push(policyId);
        await signedTouch({ touchType: "bind", eventId: `bind-${quoted.id}`, channel: l.channel, valueMinor: quoted.premiumMinor, currency: "AED", ...(l.campaign ? { campaignId: l.campaign } : {}) });
      } else bump(`bind-refused:${bound.status}`);
    });
  }

  async function marketing(day: number): Promise<void> {
    const date = new Date(Date.now() + (day - 1) * DAY).toISOString().slice(0, 10);
    const perChannel = Math.round(ctx.bench.spendMinorPerMonth / 30 / 4);
    const rows = ctx.bench.channels.map((ch, i) => `${date},${campaigns[i] ?? ""},${ch},${perChannel},AED,${perChannel / 10},${perChannel / 400},0`);
    const csv = ["day,campaignId,channel,amountMinor,currency,impressions,clicks,conversions", ...rows].join("\n");
    const imp = await call(marketer, "POST", "/v1/signal/spend/import", { csv });
    bump(imp.status < 300 ? "spend:imported" : `spend-refused:${imp.status}`);
    await gated(marketer, demo, "POST", "/v1/signal/autopilot/run", {});
    const since = Date.now() - 30 * DAY;
    await call(marketer, "GET", `/v1/signal/attribution/range?since=${since}&currency=AED`);
    await call(marketer, "GET", `/v1/signal/holdout/readout?since=${since}&until=${Date.now() + 40 * DAY}`);
  }

  async function service(day: number): Promise<void> {
    const n = ctx.bench.perDay.chats;
    await pool(Array.from({ length: n }, (_, i) => i), 8, async (i) => {
      const first = await call(ctx.anon, "POST", `/v1/portal/${SLUG}/chat/messages`, { name: i % 5 ? `Visitor ${i}` : `زائر ${i}`, text: i % 3 ? "Is my car covered in Oman?" : "كم سعر التأمين الشامل؟" });
      if (first.status !== 201) return void bump(`chat-refused:${first.status}`);
      bump("chat");
      await call(ctx.anon, "POST", `/v1/portal/${SLUG}/chat/messages`, { text: "And roadside assistance?" }, { "x-lyra-visitor": first.json.visitorToken });
    });
    const convs = await call(orbit, "GET", "/v1/orbit/conversations?limit=50&status=open");
    await pool((convs.json?.data ?? []).slice(0, Math.ceil(n / 3)), 4, async (c: any) => {
      const r = await call(orbit, "POST", `/v1/orbit/conversations/${c.id}/reply`, { text: "Yes — GCC cover is included. Want a quote?" });
      bump(r.status < 300 ? "chat:replied" : `chat-reply-refused:${r.status}`);
    });
    await call(retention, "POST", "/v1/orbit/renewals/sweep");
    const ren = await call(retention, "GET", "/v1/orbit/renewals?state=scheduled&limit=20");
    for (const r of (ren.json?.data ?? []).slice(0, 10)) {
      const o = await call(retention, "PATCH", `/v1/orbit/renewals/${r.id}`, { state: day % 2 ? "offered" : "accepted" });
      bump(o.status < 300 ? "renewal:progressed" : `renewal-refused:${o.status}`);
    }
  }

  async function partnerDesk(day: number): Promise<void> {
    if (day % 3 === 1) {
      const s = await call(ctx.anon, "POST", "/v1/onboarding/partners/signup", { tenantSlug: SLUG, companyName: `Sim Aggregator ${day}`, contactEmail: `partner-${uid()}@sim.example`, contactName: "Partner Lead", kind: "aggregator" });
      bump(s.status < 300 ? "partner:signup" : `partner-refused:${s.status}`);
    }
    const list = await call(partners, "GET", "/v1/orbit/partners?limit=20");
    const ids = (list.json?.data ?? []).map((p: any) => p.id);
    await pool(Array.from({ length: Math.min(ctx.bench.perDay.partnerQuotes, 200) }, (_, i) => i), 6, async (i) => {
      if (!ids.length) return;
      const q = await call(partners, "POST", `/v1/orbit/partners/${ids[i % ids.length]}/quotes`, { productLine: "motor", amountMinor: 100_000 + i, currency: "AED" });
      bump(q.status < 300 ? "partner:quote" : `partner-quote-refused:${q.status}`);
    });
  }

  async function backOffice(day: number): Promise<void> {
    // CRM backfill by CSV, Arabic names and duplicates included.
    const rows = Array.from({ length: ctx.bench.perDay.customersImported }, (_, i) =>
      i % 11 === 0 ? `"Dup, Existing",dup${i % 3}@sim.example,,motor` : `${i % 6 ? `Customer ${uid()}` : `عميل ${uid()}`},c-${uid()}@sim.example,+97150${String(i).padStart(7, "0")},motor;health`
    );
    for (let i = 0; i < rows.length; i += 500) {
      const csv = ["name,email,phone,tags", ...rows.slice(i, i + 500)].join("\n");
      const res = await call(agent, "POST", "/v1/core/customers/import", { csv });
      bump(res.status < 300 ? "customers:imported" : `customers-refused:${res.status}`, res.status < 300 ? res.json?.created ?? 0 : 1);
    }
    // Compliance: screen a sample, including the stub's known-hit name.
    const hit = await call(compliance, "POST", "/v1/compliance/screenings/run", { name: day % 5 === 0 ? `lyra-test-hit ${uid()}` : `Clean Name ${uid()}` });
    bump(hit.status < 300 ? "screening" : `screening-refused:${hit.status}`);
    // Finance: a dual-controlled manual journal twice a week.
    if (day % 3 === 0) {
      const j = await gated(finAnalyst, controller, "POST", "/v1/ledger/txn/MANUAL-JRNL", {
        idempotencyKey: `sim-mj-${day}`,
        currency: "AED",
        args: { lines: [{ accountCode: "5400", side: "debit", amountMinor: 1_200_000 }, { accountCode: "2100", side: "credit", amountMinor: 1_200_000 }], reason: `sim accrual day ${day}` }
      });
      bump(j.status < 300 ? "journal" : `journal-refused:${j.status}`);
    }
    // NORTH: the day's snapshot.
    const snap = await call(exec, "POST", "/v1/north/snapshotter/run");
    bump(snap.status < 300 ? "north:snapshot" : `north-refused:${snap.status}`);
  }

  /** Every persona reads its screens' data: lists, the heavy ones at volume. */
  async function staffReads(): Promise<void> {
    await pool(ctx.people, 6, async (seat) => {
      const paths = readable.get(seat.email) ?? [];
      for (let i = 0; i < Math.min(ctx.bench.perDay.staffReads, paths.length); i++) {
        await call(seat, "GET", `${paths[(i * 7) % paths.length]}?limit=200`);
      }
    });
  }

  async function day(n: number): Promise<void> {
    await acquisition(n);
    await marketing(n);
    await service(n);
    await partnerDesk(n);
    await backOffice(n);
    await staffReads();
  }

  async function close(): Promise<void> {
    // Month end: settlement run, period soft close, and the deal's pinned metric.
    const period = new Date().toISOString().slice(0, 7);
    const run = await call(controller2, "POST", "/v1/settlement/runs", { counterpartyKind: "partner", counterpartyRef: `channel:${webChannel}`, period });
    bump(run.status < 300 ? "settlement:drafted" : `settlement-refused:${run.status}`);
    const sid = run.json?.id ?? run.json?.settlement?.id;
    if (sid) {
      const ap = await gated(controller2, controller, "POST", `/v1/settlement/settlements/${sid}/approve`, {});
      bump(ap.status < 300 ? "settlement:approved" : `settlement-approve-refused:${ap.status}`);
    }
    const closeP = await gated(controller, controller2, "POST", `/v1/ledger/periods/${period}/close`, { to: "soft_closed" });
    bump(closeP.status < 300 ? "period:closed" : `period-close-refused:${closeP.status}`);
    const snaps = await call(analyst, "GET", "/v1/north/snapshots?limit=50");
    const s = (snaps.json?.data ?? [])[0];
    if (s) {
      const v = await call(analyst, "POST", `/v1/north/snapshots/${s.id}/verify`, { ref: "sim-month-end" });
      const pin = await call(controller, "POST", "/v1/ledger/metric-pins", { snapshotId: s.id });
      bump(v.status < 300 ? "north:verified" : `verify-refused:${v.status}`);
      bump(pin.status < 300 ? "pin:created" : `pin-refused:${pin.status}`);
      if (pin.status < 300) {
        const a = await call(controller2, "POST", `/v1/ledger/metric-pins/${pin.json.id}/countersign/tenant`, {});
        const b = await call(controller, "POST", `/v1/ledger/metric-pins/${pin.json.id}/countersign/counterparty`, { evidenceRef: "sim-esign" });
        bump(a.status < 300 && b.status < 300 ? "pin:countersigned" : `pin-sign-refused:${a.status}/${b.status}`);
      }
    }
  }

  async function invariants(): Promise<void> {
    const tb = await call(controller, "GET", "/v1/ledger/reports/trial-balance");
    if (!tb.json?.balanced) find({ severity: "critical", kind: "ledger-unbalanced", route: "GET /v1/ledger/reports/trial-balance", detail: JSON.stringify({ d: tb.json?.totalDebitMinor, c: tb.json?.totalCreditMinor }) });
    const bs = await call(controller, "GET", `/v1/ledger/reports/balance-sheet?asOf=${Date.now() + 40 * DAY}`);
    if (bs.status < 300 && bs.json?.balanced === false) find({ severity: "critical", kind: "balance-sheet-unbalanced", route: "GET /v1/ledger/reports/balance-sheet", detail: "balanced: false" });
    // Every bind the sim counted must exist as a policy.
    let found = 0;
    for (const id of policies.slice(0, 200)) if ((await call(lead, "GET", `/v1/axis/policies/${id}`)).status === 200) found++;
    if (found < Math.min(200, policies.length)) find({ severity: "high", kind: "lost-policies", route: "GET /v1/axis/policies/{id}", detail: `${found}/${Math.min(200, policies.length)} bound policies readable` });
    void customers;
    void tenantAdmin;
  }

  return { setup, day, close, invariants };
}
