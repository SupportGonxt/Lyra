// Does Lyra tell each role the truth about the month it just ran?
//
// After `sim/month.ts`, every insight screen should agree with the rows the
// month actually wrote. This reads each insight the way its screen does (the
// API) and recomputes the same figure straight from the database with plain
// SQL that shares no code with the engine — so a wrong formula, a missed
// writer or a double count shows as a disagreement, not as a green test.
//
//   SIM_DB=<dir>/sim.db SIM_API=http://127.0.0.1:8797 npx tsx sim/insights.ts
//
// Local only, read only. Prints `INSIGHT {json}` per check.
import { createClient } from "@libsql/client";

const DB = process.env.SIM_DB;
const API = process.env.SIM_API ?? "http://127.0.0.1:8797";
if (!DB) throw new Error("SIM_DB is required");
const db = createClient({ url: `file:${DB}` });
const one = async (sql: string, args: (string | number)[] = []): Promise<Record<string, any>> => (await db.execute({ sql, args })).rows[0] ?? {};
const num = (v: unknown) => Number(v ?? 0);

const login = await fetch(`${API}/v1/auth/demo/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "demo@gonxt.ae" }) });
const token = ((await login.json()) as { token: string }).token;
const api = async (path: string): Promise<any> => {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : { status: res.status };
};

const tenant = String((await one("select tenant_id t from axis_policies where policy_no like 'SIM-%' limit 1")).t);
const span = await one("select min(created_at) a, max(created_at) b from axis_policies where tenant_id = ? and policy_no like 'SIM-%'", [tenant]);
const since = num(span.a);
const until = num((await one("select max(ts) b from core_audit_log where tenant_id = ?", [tenant])).b) + 1;
const now = num(((await (await fetch(`${API}/v1/auth/demo/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"advanceMs":0}' })).json()) as { simNow: number }).simNow);

interface Check { role: string; insight: string; app: number | string | null; truth: number | string; tolerance?: number; note?: string; ok?: boolean }
const checks: Check[] = [];
const check = (c: Check) => checks.push(c);

/* --- NORTH: each monthly snapshot against the month's own rows ----------------------------- */
const months: string[] = [];
for (let t = since; t < until; t += 86_400_000) {
  const m = new Date(t).toISOString().slice(0, 7);
  if (!months.includes(m)) months.push(m);
}
for (const period of months) {
  const from = Date.parse(`${period}-01T00:00:00Z`);
  const to = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth() + 1, 1);
  const snaps = (await api(`/v1/north/snapshots?period=${period}&grain=month&limit=200`)).data ?? [];
  const snap = (key: string) => snaps.find((s: any) => s.metricKey === key && !s.dimsHash)?.value ?? null;
  const pol = await one("select count(*) n, sum(premium_minor) p, sum(commission_minor) c from axis_policies where tenant_id = ? and created_at >= ? and created_at < ?", [tenant, from, to]);
  const spend = num((await one("select sum(amount_minor) s from signal_spend where tenant_id = ? and ts >= ? and ts < ?", [tenant, from, to])).s);
  const claims = await one("select count(*) n from axis_claims where tenant_id = ? and closed_at is null and status not in ('withdrawn','rejected')", [tenant]);
  check({ role: "north.exec", insight: `GWP ${period}`, app: snap("gwp"), truth: num(pol.p) });
  check({ role: "north.exec", insight: `Net commission ${period}`, app: snap("net_commission"), truth: num(pol.c) });
  // A daily metric: the month is the sum of its days.
  const days = ((await api(`/v1/north/snapshots?metricKey=policies_issued&grain=day&limit=200`)).data ?? []).filter((s: any) => !s.dimsHash && String(s.period).startsWith(period));
  check({ role: "north.exec", insight: `Policies issued ${period} (sum of days)`, app: days.length ? days.reduce((a: number, s: any) => a + s.value, 0) : null, truth: num(pol.n), note: "a day not yet snapshotted is missing" });
  check({ role: "signal.lead", insight: `CAC per policy ${period}`, app: snap("cac_per_policy"), truth: num(pol.n) ? Math.round(spend / num(pol.n)) : 0, tolerance: 1 });
  check({ role: "north.exec", insight: `Open claims ${period}`, app: snap("open_claim_count"), truth: num(claims.n), note: "snapshot is as at its last nightly run" });
}

/* --- SIGNAL: attribution against the touches written --------------------------------------- */
const funnel = (await api(`/v1/signal/attribution/funnel?since=${since}&until=${until}`)).data ?? [];
const touches = async (type: string) => num((await one("select count(*) n from signal_attribution_events where tenant_id = ? and touch_type = ? and ts >= ? and ts < ?", [tenant, type, since, until])).n);
check({ role: "signal.lead", insight: "Attributed binds", app: funnel.reduce((s: number, r: any) => s + r.binds, 0), truth: await touches("bind") });
check({ role: "signal.lead", insight: "Attributed leads", app: funnel.reduce((s: number, r: any) => s + r.leads, 0), truth: await touches("lead") });
const range = await api(`/v1/signal/attribution/range?since=${since}&until=${until}&currency=AED`);
const spendAll = num((await one("select sum(amount_minor) s from signal_spend where tenant_id = ? and ts >= ? and ts < ?", [tenant, since, until])).s);
check({ role: "signal.lead", insight: "Media spend in window", app: range.spendMinor ?? null, truth: spendAll });

/* --- Finance: the ledger against the business it books ------------------------------------- */
const pnl = await api(`/v1/ledger/reports/pnl?from=${since}&to=${until}`);
const income = (code: string) => pnl.income?.rows?.find((r: any) => r.accountCode === code)?.amountMinor ?? 0;
const expense = (code: string) => pnl.expense?.rows?.find((r: any) => r.accountCode === code)?.amountMinor ?? 0;
const commissionBooked = num((await one("select sum(net_commission_minor + channel_commission_minor) c from dist_commission_entries where tenant_id = ? and created_at >= ? and created_at < ?", [tenant, since, until])).c);
check({ role: "finance.controller", insight: "P&L commission income vs accrued entries", app: income("4000"), truth: commissionBooked, note: "accrual happens on approval, so the last day may lag" });
check({ role: "finance.controller", insight: "P&L media spend vs SIGNAL spend", app: expense("5100"), truth: spendAll, note: "docs/19: MEDIA-SPEND is recorded from channel spend" });
const flow = await api(`/v1/ledger/reports/value-flow?period=${months.at(-1)}`);
const premiumIn = flow.nodes?.find((n: any) => n.key === "premium-in")?.amountMinor ?? null;
const lastFrom = Date.parse(`${months.at(-1)}-01T00:00:00Z`);
const written = num((await one("select sum(gross_minor) g from axis_policies where tenant_id = ? and created_at >= ?", [tenant, lastFrom])).g);
check({ role: "finance.analyst", insight: `Money map premium in ${months.at(-1)} vs written`, app: premiumIn, truth: written, note: "written premium no customer has paid yet has no node" });

/* --- Journey health against the records behind each step ----------------------------------- */
const days = Math.ceil((now - since) / 86_400_000) + 1;
const journeys = (await api(`/v1/north/journeys?days=${days}`)).data ?? [];
const c1 = journeys.find((j: any) => j.id === "J-C1");
const step = (key: string) => c1?.steps?.find((s: any) => s.key === key)?.count ?? null;
const priced = num((await one("select count(distinct request_id) n from dist_quote_responses where tenant_id = ? and created_at >= ? and state = 'quoted'", [tenant, since])).n);
const docs = num((await one("select count(distinct p.id) n from axis_policies p join axis_policy_versions v on v.policy_id = p.id where p.tenant_id = ? and p.created_at >= ? and v.document_file_id is not null", [tenant, since])).n);
const bound = num((await one("select count(*) n from axis_policies where tenant_id = ? and created_at >= ?", [tenant, since])).n);
check({ role: "north.analyst", insight: "J-C1 offers shown", app: step("offers"), truth: priced });
check({ role: "north.analyst", insight: "J-C1 issued", app: step("issued"), truth: bound });
check({ role: "north.analyst", insight: "J-C1 schedule delivered", app: step("delivered"), truth: docs });

/* --- What the executive reads first ---------------------------------------------------------- */
const brief = await one("select max(created_at) t from north_briefings where tenant_id = ? and audience = 'exec'", [tenant]);
check({ role: "north.exec", insight: "Morning brief age (days)", app: Math.floor((now - num(brief.t)) / 86_400_000), truth: 1, tolerance: 0, note: "J-E1: a brief every morning" });

for (const c of checks) {
  const app = typeof c.app === "number" ? c.app : null;
  const truth = typeof c.truth === "number" ? c.truth : null;
  c.ok = app !== null && truth !== null && Math.abs(app - truth) <= (c.tolerance ?? 0);
  console.log(`INSIGHT ${JSON.stringify(c)}`);
}
console.log(`insights: ${checks.filter((c) => c.ok).length}/${checks.length} agree (window ${new Date(since).toISOString().slice(0, 10)} → ${new Date(until).toISOString().slice(0, 10)})`);
