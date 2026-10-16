#!/usr/bin/env node
// The reader for the request telemetry this platform has been writing to nobody.
//
// `apps/api/src/mw.ts:115` writes a data point per request — method, route, status,
// tenant in `blobs`, **latency in `doubles`**, tenant in `indexes` — into the
// Analytics Engine dataset `lyra_telemetry` (`apps/api/wrangler.jsonc:60`).
//
// Nothing read it. A repository-wide sweep for a consumer returned the write site and
// the binding declaration and nothing else (`TECHNOLOGY-GAP-REGISTER.md` §1), so on
// launch day there was no way to answer what the error rate was, what p95 latency was,
// or whether yesterday was worse than today.
//
// This is that reader, and it carries the SLO so the numbers have thresholds rather
// than a chart.
//
//   node scripts/telemetry-report.mjs                 # last 24h, SLO applied, exit 1 on breach
//   node scripts/telemetry-report.mjs --hours 1       # the launch-day window
//   node scripts/telemetry-report.mjs --json          # for a dashboard or an alert
//   node scripts/telemetry-report.mjs --env staging   # the staging dataset
//
// **Fails closed with a named reason when the Cloudflare credentials are absent** —
// the platform's own idiom for every credential-gated surface (GO-LIVE-RUNBOOK §3.3).
// An unread metric is not a passing metric, and this must never report "healthy"
// because it could not look.

import { parseArgs } from "node:util";

/** What "healthy" means, in numbers. A threshold nobody wrote down is a chart. */
export const SLO = {
  /** Share of 5xx responses the platform accepts over the window. */
  maxErrorRate: 0.01,
  /** p95 request latency, milliseconds. */
  maxP95Ms: 800,
  /** Below this many requests a window is too small to judge, and is reported as such. */
  minRequests: 50
};

const DATASETS = { production: "lyra_telemetry", staging: "lyra_telemetry_staging" };

/**
 * The query. Analytics Engine's SQL dialect; `double1` is latency, `blob3` the status.
 *
 * Kept as a pure function so it can be asserted on rather than eyeballed — the columns
 * are positional and a wrong index reads a plausible number off the wrong field.
 */
export function telemetrySql(dataset, hours) {
  return `SELECT blob2 AS route,
       count() AS requests,
       sum(if(startsWith(blob3, '5'), 1, 0)) AS errors,
       quantileWeighted(0.95)(double1, 1) AS p95
FROM ${dataset}
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
GROUP BY route
ORDER BY errors DESC, requests DESC
LIMIT 200`;
}

/**
 * Apply the SLO to one row, or to nothing.
 *
 * Pure, and the whole point of the exercise: a report that prints numbers and leaves
 * the judgement to a reader at 02:00 is the same failure one step later.
 */
export function evaluate(row) {
  const requests = Number(row.requests ?? 0);
  const errors = Number(row.errors ?? 0);
  const p95 = Number(row.p95 ?? 0);
  const errorRate = requests > 0 ? errors / requests : 0;

  // Too little traffic to judge is **not** a pass. Saying "ok" on 3 requests is how a
  // monitoring gap hides inside a green report.
  if (requests < SLO.minRequests) {
    return { verdict: "insufficient", errorRate, p95, reasons: [`only ${requests} requests (< ${SLO.minRequests})`] };
  }

  const reasons = [];
  if (errorRate > SLO.maxErrorRate) reasons.push(`error rate ${(errorRate * 100).toFixed(2)}% > ${SLO.maxErrorRate * 100}%`);
  if (p95 > SLO.maxP95Ms) reasons.push(`p95 ${Math.round(p95)}ms > ${SLO.maxP95Ms}ms`);
  return { verdict: reasons.length ? "breach" : "ok", errorRate, p95, reasons };
}

/** Roll the per-route rows into one verdict, so a caller can gate on a single word. */
export function summarise(rows) {
  const judged = rows.map((r) => ({ route: r.route, ...evaluate(r) }));
  const breaches = judged.filter((r) => r.verdict === "breach");
  const judgedRows = judged.filter((r) => r.verdict !== "insufficient");
  return {
    breaches,
    insufficient: judged.filter((r) => r.verdict === "insufficient"),
    // The platform is as healthy as its worst judged route, not its average.
    verdict: breaches.length ? "breach" : judgedRows.length ? "ok" : "insufficient",
    rows: judged
  };
}

async function query(sql, { accountId, token }) {
  // `globalThis.fetch`, not the bare global: `scripts/` is not in the eslint config's
  // browser/node global set, and widening the config to reach one call is the wrong
  // trade.
  const res = await globalThis.fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: sql
  });
  if (!res.ok) throw new Error(`analytics engine answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main() {
  const { values } = parseArgs({
    options: {
      hours: { type: "string", default: "24" },
      env: { type: "string", default: "production" },
      json: { type: "boolean", default: false }
    }
  });

  const dataset = DATASETS[values.env];
  if (!dataset) {
    console.error(`--env must be one of ${Object.keys(DATASETS).join(", ")}`);
    process.exit(2);
  }

  const accountId = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    // Named, and distinct from a breach: this run *could not look*.
    console.error(
      "cannot read telemetry: set CF_ACCOUNT_ID and CF_API_TOKEN (or the CLOUDFLARE_* pair).\n" +
        "The dataset is queried through Cloudflare's API, so there is no offline fallback —\n" +
        "an unread metric is not a passing metric, and this will not report healthy."
    );
    process.exit(2);
  }

  const hours = Number(values.hours);
  const body = await query(telemetrySql(dataset, hours), { accountId, token });
  const data = (body.data ?? []).map((r) => ({ route: r.route, requests: r.requests, errors: r.errors, p95: r.p95 }));
  const summary = summarise(data);

  if (values.json) {
    console.log(JSON.stringify({ env: values.env, dataset, hours, slo: SLO, ...summary }, null, 2));
  } else {
    console.log(`${values.env} · ${dataset} · last ${hours}h · SLO error≤${SLO.maxErrorRate * 100}% p95≤${SLO.maxP95Ms}ms\n`);
    for (const r of summary.rows) {
      const mark = r.verdict === "breach" ? "BREACH" : r.verdict === "insufficient" ? "  --  " : "  ok  ";
      console.log(
        `${mark} ${String(r.route).padEnd(48)} ${String(r.requests).padStart(7)} req  ` +
          `${(r.errorRate * 100).toFixed(2).padStart(6)}% err  p95 ${Math.round(r.p95).toString().padStart(5)}ms` +
          (r.reasons.length ? `  ← ${r.reasons.join("; ")}` : "")
      );
    }
    console.log(`\nverdict: ${summary.verdict.toUpperCase()}`);
  }

  process.exit(summary.verdict === "breach" ? 1 : 0);
}

// Only run when invoked directly, so the exports above are testable.
if (import.meta.url === `file://${process.argv[1]}`) await main();
