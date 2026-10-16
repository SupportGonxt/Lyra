import { describe, expect, it } from "vitest";
import { SLO, evaluate, summarise, telemetrySql } from "./telemetry-report.mjs";

// The reader for the request telemetry nothing read (TECHNOLOGY-GAP-REGISTER §1).
//
// What these tests hold: the query names the right dataset and window; the SLO has
// three outcomes rather than two, because **"too little traffic to judge" is not
// "healthy"**; and the platform is as healthy as its worst judged route, not its
// average.

describe("telemetrySql", () => {
  it("reads the dataset it was given, for the window it was given", () => {
    const sql = telemetrySql("lyra_telemetry_staging", 1);
    expect(sql).toContain("FROM lyra_telemetry_staging");
    expect(sql).toContain("INTERVAL '1' HOUR");
    // The columns are positional — blob2 route, blob3 status, double1 latency —
    // so a wrong index would read a plausible number off the wrong field.
    expect(sql).toContain("blob2 AS route");
    expect(sql).toContain("double1");
  });
});

describe("evaluate", () => {
  it("passes a route inside both thresholds", () => {
    expect(evaluate({ requests: 1000, errors: 2, p95: 120 })).toMatchObject({ verdict: "ok", reasons: [] });
  });

  it("breaches on the error rate and names the number", () => {
    const out = evaluate({ requests: 1000, errors: 50, p95: 120 });
    expect(out.verdict).toBe("breach");
    expect(out.reasons.join(" ")).toContain("5.00%");
  });

  it("breaches on p95 independently of the error rate", () => {
    // A route that never errors and takes two seconds is not a healthy route.
    const out = evaluate({ requests: 1000, errors: 0, p95: 2000 });
    expect(out.verdict).toBe("breach");
    expect(out.reasons.join(" ")).toContain("p95");
  });

  it("refuses to call a nearly-idle route healthy", () => {
    // The one that matters: SLO.maxRequests exists so a green report cannot hide a
    // monitoring gap. Three requests prove nothing, and saying "ok" about them is
    // how a gap survives.
    const out = evaluate({ requests: SLO.minRequests - 1, errors: 0, p95: 10 });
    expect(out.verdict).toBe("insufficient");
    expect(out.reasons.join(" ")).toContain("requests");
  });

  it("accepts exactly the floor", () => {
    expect(evaluate({ requests: SLO.minRequests, errors: 0, p95: 10 }).verdict).toBe("ok");
  });

  it("does not divide by zero on an empty route", () => {
    expect(evaluate({ requests: 0, errors: 0, p95: 0 })).toMatchObject({ verdict: "insufficient", errorRate: 0 });
  });
});

describe("summarise", () => {
  const ok = { route: "/ok", requests: 500, errors: 1, p95: 100 };
  const bad = { route: "/bad", requests: 500, errors: 100, p95: 100 };

  it("is as healthy as its worst judged route, not its average", () => {
    // An average would call this pair healthy: 101 errors in 1000 requests is 10%,
    // but split 1-in-500 and 100-in-500, one route is failing half its traffic.
    const out = summarise([ok, bad]);
    expect(out.verdict).toBe("breach");
    expect(out.breaches.map((b) => b.route)).toEqual(["/bad"]);
  });

  it("reports ok only when at least one route was judged", () => {
    expect(summarise([ok]).verdict).toBe("ok");
  });

  it("is not ok when nothing could be judged", () => {
    // No traffic at all is not a pass — it is a report that cannot answer.
    expect(summarise([{ route: "/quiet", requests: 1, errors: 0, p95: 0 }]).verdict).toBe("insufficient");
    expect(summarise([]).verdict).toBe("insufficient");
  });
});
