import { appendFileSync, writeFileSync } from "node:fs";

/** One API call's outcome, kept for latency percentiles and error rates per route. */
interface Sample {
  route: string;
  status: number;
  ms: number;
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  kind: string;
  route: string;
  persona?: string;
  status?: number;
  detail: string;
}

const samples: Sample[] = [];
const findings: Finding[] = [];
let findingsFile: string | null = null;

export function recordTo(path: string): void {
  findingsFile = path;
  writeFileSync(path, "");
}

export function find(f: Finding): void {
  const key = `${f.kind}|${f.route}|${f.persona ?? ""}|${f.status ?? ""}`;
  if (findings.some((x) => `${x.kind}|${x.route}|${x.persona ?? ""}|${x.status ?? ""}` === key)) return;
  findings.push(f);
  if (findingsFile) appendFileSync(findingsFile, JSON.stringify(f) + "\n");
}

export const allFindings = () => findings;

/** Collapse ids in a path so latency groups by route, not by record. */
export function template(path: string): string {
  return path
    .split("?")[0]!
    .replace(/\/[a-z]{2,6}_[0-9A-Z]{20,}/g, "/{id}")
    .replace(/\/[0-9a-f-]{32,36}/g, "/{id}");
}

export interface Client {
  base: string;
  token?: string;
  persona: string;
}

export async function call(
  client: Client,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any; text: string; ms: number }> {
  const started = performance.now();
  let status = 0;
  let text = "";
  try {
    const res = await fetch(client.base + path, {
      method,
      headers: {
        ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
        ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    text = String(err);
  }
  const ms = performance.now() - started;
  samples.push({ route: `${method} ${template(path)}`, status, ms });
  if (status >= 500 || status === 0) {
    find({ severity: "high", kind: "server-error", route: `${method} ${template(path)}`, persona: client.persona, status, detail: text.slice(0, 300) });
  }
  if (ms > 5_000) {
    find({ severity: "medium", kind: "slow", route: `${method} ${template(path)}`, persona: client.persona, status, detail: `${Math.round(ms)}ms` });
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (CSV export, HTML) — callers that need it read `text`
  }
  return { status, json, text, ms };
}

/** p50/p95/p99, error rate and volume per route, slowest p95 first. */
export function latencyTable(): { route: string; n: number; p50: number; p95: number; p99: number; max: number; errors5xx: number }[] {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.route, [...(by.get(s.route) ?? []), s]);
  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
  return [...by.entries()]
    .map(([route, xs]) => {
      const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
      return {
        route,
        n: xs.length,
        p50: Math.round(pct(ms, 50)),
        p95: Math.round(pct(ms, 95)),
        p99: Math.round(pct(ms, 99)),
        max: Math.round(ms[ms.length - 1] ?? 0),
        errors5xx: xs.filter((x) => x.status >= 500 || x.status === 0).length
      };
    })
    .sort((a, b) => b.p95 - a.p95);
}

export const totalCalls = () => samples.length;

/** Run `jobs` with at most `width` in flight. */
export async function pool<T>(items: readonly T[], width: number, job: (item: T, i: number) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await job(items[i]!, i);
      }
    })
  );
}
