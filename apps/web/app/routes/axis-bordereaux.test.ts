import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  BORDEREAU_KINDS,
  COUNTERPARTY_KINDS,
  DIRECTIONS,
  LABELS,
  action,
  labelsIn,
  loader,
  recordHref,
  rowErrorsOf
} from "./axis-bordereaux";

// AXIS's periodic reconciliation file between us and a provider/channel/
// partner. Generation is idempotent-per-period for outbound and one-shot for
// inbound; reconciliation matches lines against our own policies and never
// overwrites totals a human has already actioned. Neither write PATCHes a
// row directly — both go through apps/api/src/engines/axis-bordereaux.ts.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null; idempotencyKey: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      idempotencyKey: new Headers(init.headers).get("idempotency-key")
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/axis/bordereaux", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

function form(fields: Record<string, string>) {
  const body = new FormData();
  body.set("idempotencyKey", "key-1");
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const json = ok;

const BORDEREAU = {
  id: "bdx_1",
  direction: "outbound",
  counterpartyKind: "provider",
  counterpartyId: "prv_1",
  kind: "premium",
  period: "2026-07",
  currency: "AED",
  lineCount: 2,
  grossPremiumMinor: 500_000,
  commissionMinor: 50_000,
  claimsPaidMinor: 0,
  reserveMinor: 0,
  varianceMinor: 0,
  state: "generated",
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_000
};

const LINE = {
  id: "bdxl_1",
  bordereauId: "bdx_1",
  lineNo: 1,
  externalRef: "POL-1",
  riskRef: "VIN-1",
  grossPremiumMinor: 100_000,
  commissionMinor: 10_000,
  claimsPaidMinor: 0,
  reserveMinor: 0,
  currency: "AED",
  matchState: "matched",
  varianceMinor: 0,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_000
};

function stubLoader(permissions: string[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/me")) return Promise.resolve(json({ permissions }));
    if (url.includes("/v1/axis/bordereaux?")) return Promise.resolve(json({ data: [BORDEREAU] }));
    if (url.endsWith("/v1/axis/bordereaux/bdx_1")) return Promise.resolve(json(BORDEREAU));
    if (url.includes("/v1/axis/bordereau-lines")) return Promise.resolve(json({ data: [LINE] }));
    return Promise.resolve(json({ data: [] }));
  });
  return calls;
}

function loadArgs(search = ""): LoaderFunctionArgs {
  return {
    request: new Request(`https://web.test/axis/bordereaux${search}`),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as LoaderFunctionArgs;
}

/* ------------------------------------------------------------------- tests */

describe("labelsIn", () => {
  it("answers every key in both languages, and never with the key itself", () => {
    for (const key of Object.keys(LABELS.en!)) {
      expect(LABELS.ar![key], key).toBeTruthy();
      for (const locale of ["en", "ar"]) expect(labelsIn(locale)(key), `${locale}:${key}`).not.toBe(key);
    }
    expect(Object.keys(LABELS.ar!).sort()).toEqual(Object.keys(LABELS.en!).sort());
  });

  it("keeps the Arabic distinct from the English", () => {
    for (const [key, value] of Object.entries(LABELS.en!)) expect(LABELS.ar![key], key).not.toBe(value);
  });

  it("names every direction, counterparty kind and bordereau kind this screen offers", () => {
    for (const direction of DIRECTIONS) expect(labelsIn("en")(`direction.${direction}`), direction).not.toBe(`direction.${direction}`);
    for (const kind of COUNTERPARTY_KINDS)
      expect(labelsIn("en")(`counterpartyKind.${kind}`), kind).not.toBe(`counterpartyKind.${kind}`);
    for (const kind of BORDEREAU_KINDS)
      expect(labelsIn("ar")(`bordereauKind.${kind}`), kind).not.toBe(`bordereauKind.${kind}`);
  });
});

describe("loader", () => {
  it("lists the register, and drills into a selected bordereau's lines when ?id= is given", async () => {
    stubLoader(["axis:bordereaux:read"]);

    const listOnly = await loader(loadArgs());
    expect(listOnly.bordereaux).toHaveLength(1);
    expect(listOnly.selected).toBeNull();
    expect(listOnly.lines).toHaveLength(0);

    const withSelection = await loader(loadArgs("?id=bdx_1"));
    expect(withSelection.selected?.id).toBe("bdx_1");
    expect(withSelection.lines).toHaveLength(1);
    expect(withSelection.lines[0]?.matchState).toBe("matched");
  });

  it("returns nothing when the actor cannot read bordereaux", async () => {
    stubLoader([]);
    const loaded = await loader(loadArgs());
    expect(loaded.bordereaux).toHaveLength(0);
    expect(loaded.may.read).toBe(false);
  });
});

describe("action: generate", () => {
  it("generates an outbound bordereau from the ledger, with no raw lines needed", async () => {
    const calls = stubFetch(ok({ bordereau: BORDEREAU, lines: [] }));

    const result = await action(
      args(
        form({
          intent: "generate",
          direction: "outbound",
          counterpartyKind: "provider",
          counterpartyId: "prv_1",
          kind: "premium",
          period: "2026-07",
          currency: "AED"
        })
      )
    );

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/bordereaux");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      direction: "outbound",
      counterpartyKind: "provider",
      counterpartyId: "prv_1",
      kind: "premium",
      period: "2026-07",
      currency: "AED",
      lines: []
    });
    expect(result.done).toBe("generateDone");
  });

  it("carries the raw lines an inbound bordereau needs, parsed from the form's JSON", async () => {
    const calls = stubFetch(ok({ bordereau: BORDEREAU, lines: [] }));
    const rawLines = [{ externalRef: "POL-1", grossPremiumMinor: 100_000 }];

    const result = await action(
      args(
        form({
          intent: "generate",
          direction: "inbound",
          counterpartyKind: "partner",
          counterpartyId: "ptn_1",
          kind: "combined",
          period: "2026-07",
          currency: "AED",
          lines: JSON.stringify(rawLines)
        })
      )
    );

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      direction: "inbound",
      counterpartyKind: "partner",
      counterpartyId: "ptn_1",
      kind: "combined",
      period: "2026-07",
      currency: "AED",
      lines: rawLines
    });
    expect(result.done).toBe("generateDone");
  });

  it("refuses a direction, counterparty kind or bordereau kind outside the declared sets", async () => {
    const calls = stubFetch(ok({}));
    const base = { intent: "generate", counterpartyId: "prv_1", period: "2026-07", currency: "AED" };

    const badDirection = await action(args(form({ ...base, direction: "sideways", counterpartyKind: "provider", kind: "premium" })));
    expect(badDirection.error).toBe("directionRequired");

    const badCounterparty = await action(args(form({ ...base, direction: "outbound", counterpartyKind: "vibes", kind: "premium" })));
    expect(badCounterparty.error).toBe("counterpartyKindRequired");

    const badKind = await action(args(form({ ...base, direction: "outbound", counterpartyKind: "provider", kind: "vibes" })));
    expect(badKind.error).toBe("kindRequired");

    expect(calls).toHaveLength(0);
  });

  it("refuses a period that is not a real calendar month, and an inbound request with no usable lines", async () => {
    const calls = stubFetch(ok({}));
    const base = {
      intent: "generate",
      direction: "outbound",
      counterpartyKind: "provider",
      counterpartyId: "prv_1",
      kind: "premium",
      currency: "AED"
    };

    for (const period of ["2026-13", "2026-7", "not-a-month", ""]) {
      const result = await action(args(form({ ...base, period })));
      expect(result.error, period).toBe("periodRequired");
    }

    const noLines = await action(
      args(form({ ...base, direction: "inbound", period: "2026-07", lines: "not json" }))
    );
    expect(noLines.error).toBe("linesRequired");

    const emptyLines = await action(args(form({ ...base, direction: "inbound", period: "2026-07", lines: "[]" })));
    expect(emptyLines.error).toBe("linesRequired");

    expect(calls).toHaveLength(0);
  });
});

describe("action: reconcile", () => {
  it("reconciles a named bordereau's lines against our own policies", async () => {
    const calls = stubFetch(ok({ bordereau: BORDEREAU, lines: [LINE] }));

    const result = await action(args(form({ intent: "reconcile", bordereauId: "bdx_1" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/bordereaux/bdx_1/reconcile");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({});
    expect(result.done).toBe("reconcileDone");
  });

  it("refuses to reconcile with no bordereau named", async () => {
    const calls = stubFetch(ok({}));
    const result = await action(args(form({ intent: "reconcile" })));
    expect(result.error).toBe("bordereauRequired");
    expect(calls).toHaveLength(0);
  });

  it("surfaces the permission refusal instead of pretending the lines were matched", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403, code: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "reconcile", bordereauId: "bdx_1" })));

    expect(result.problem?.status).toBe(403);
    expect(result.done).toBeNull();
  });
});

/* ------------------------------------------- inbound reconciliation (ADR-0105) */

// Mirrors the API's report (apps/api/src/engines/axis-bordereaux.ts
// `reconciliationReport`), in the server's shape.
const REPORT = {
  bordereauId: "bdx_in",
  kind: "premium",
  fields: ["grossPremiumMinor", "commissionMinor"],
  toleranceMinor: 0,
  groups: [
    {
      ref: "POL-2",
      currency: "AED",
      state: "variance",
      theirs: { ids: ["bdxl_2"], amounts: { grossPremiumMinor: 105_000, commissionMinor: 10_000 } },
      ours: { ids: ["ce_2"], amounts: { grossPremiumMinor: 100_000, commissionMinor: 10_000 }, records: [{ id: "ce_2", resource: "commission-entries" }] },
      deltas: { grossPremiumMinor: 5_000, commissionMinor: 0 },
      varianceMinor: 5_000,
      duplicate: false,
      policyId: "pol_2"
    }
  ],
  totals: [{ currency: "AED", matched: 0, variance: 1, missingOurs: 0, missingTheirs: 0, theirsMinor: 105_000, oursMinor: 100_000, varianceMinor: 5_000 }]
};

const INBOUND = { ...BORDEREAU, id: "bdx_in", direction: "inbound", toleranceMinor: 0 };

function stubInbound(bordereau: Record<string, unknown>, reconciliation: Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/me")) return Promise.resolve(json({ permissions: ["axis:bordereaux:read"] }));
    if (url.includes("/reconciliation")) return Promise.resolve(reconciliation.clone());
    if (url.includes("/v1/axis/bordereaux?")) return Promise.resolve(json({ data: [bordereau] }));
    if (url.endsWith(`/v1/axis/bordereaux/${String(bordereau.id)}`)) return Promise.resolve(json(bordereau));
    return Promise.resolve(json({ data: [] }));
  });
  return calls;
}

describe("loader: reconciliation report", () => {
  it("reads the report for a selected inbound provider bordereau", async () => {
    const calls = stubInbound(INBOUND, json(REPORT));
    const loaded = await loader(loadArgs("?id=bdx_in"));
    expect(calls).toContain("https://api.test/v1/axis/bordereaux/bdx_in/reconciliation");
    expect(loaded.report?.groups[0]?.state).toBe("variance");
  });

  it("asks nothing for an outbound bordereau, or a counterparty that is not a provider", async () => {
    for (const bordereau of [BORDEREAU, { ...INBOUND, counterpartyKind: "partner" }]) {
      const calls = stubInbound(bordereau, json(REPORT));
      const loaded = await loader(loadArgs(`?id=${bordereau.id}`));
      expect(calls.some((url) => url.includes("/reconciliation"))).toBe(false);
      expect(loaded.report).toBeNull();
    }
  });

  it("a refused report is no report, not a crash — any 4xx but 401", async () => {
    stubInbound(INBOUND, new Response(JSON.stringify({ title: "Conflict", status: 409 }), { status: 409, headers: { "content-type": "application/json" } }));
    const loaded = await loader(loadArgs("?id=bdx_in"));
    expect(loaded.report).toBeNull();
  });
});

describe("recordHref", () => {
  it("opens each of our records where its own adjustment path lives", () => {
    expect(recordHref({ id: "ce_1", resource: "commission-entries" })).toBe("/distribution/commission-entries/ce_1");
    expect(recordHref({ id: "clm_1", resource: "claims" })).toBe("/axis/claims/clm_1/detail");
    expect(recordHref({ id: "a b", resource: "claims" })).toBe("/axis/claims/a%20b/detail");
  });
});

describe("action: import", () => {
  function upload(fields: Record<string, string>, csv: string | null) {
    const body = form(fields);
    if (csv !== null) body.set("file", new File([csv], "bdx.csv", { type: "text/csv" }));
    return body;
  }
  const header = { intent: "import", counterpartyKind: "provider", counterpartyId: "prv_1", kind: "premium", period: "2026-07", currency: "AED" };

  it("sends the uploaded CSV with its header to the import route", async () => {
    const calls = stubFetch(ok({ bordereau: INBOUND, lines: [] }));
    const csv = "policyNo,grossPremiumMinor,commissionMinor\nPOL-1,100000,10000\n";
    const result = await action(args(upload(header, csv)));
    expect(calls[0]?.url).toBe("https://api.test/v1/axis/bordereaux/import");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ counterpartyKind: "provider", counterpartyId: "prv_1", kind: "premium", period: "2026-07", currency: "AED", csv });
    expect(calls[0]?.idempotencyKey).toBe("key-1:import:prv_1:premium:2026-07");
    expect(result.done).toBe("importDone");
  });

  it("refuses with no file, or an empty one, before asking the API", async () => {
    const calls = stubFetch(ok({}));
    expect((await action(args(upload(header, null)))).error).toBe("csvRequired");
    expect((await action(args(upload(header, "  \n")))).error).toBe("csvRequired");
    expect((await action(args(upload({ ...header, period: "2026-13" }, "a\n1")))).error).toBe("periodRequired");
    expect(calls).toHaveLength(0);
  });

  it("keeps every refused line the API named, so the reader can fix the file", async () => {
    const rowErrors = [{ line: 3, ref: "POL-3", error: "grossPremiumMinor must be a whole number of minor units" }];
    stubFetch(new Response(JSON.stringify({ title: "Cannot process", status: 422, code: "unprocessable", rowErrors }), { status: 422, headers: { "content-type": "application/json" } }));
    const result = await action(args(upload(header, "policyNo\nx")));
    expect(result.done).toBeNull();
    expect(result.problem?.status).toBe(422);
    expect(rowErrorsOf(result.problem)).toEqual(rowErrors);
    expect(rowErrorsOf({ title: "x", status: 400 })).toEqual([]);
  });
});

describe("action: reconcile with a tolerance", () => {
  it("carries a whole-number tolerance in minor units", async () => {
    const calls = stubFetch(ok({ bordereau: INBOUND, lines: [], report: REPORT }));
    await action(args(form({ intent: "reconcile", bordereauId: "bdx_in", toleranceMinor: "3" })));
    expect(JSON.parse(calls[0]!.body!)).toEqual({ toleranceMinor: 3 });
    expect(calls[0]?.idempotencyKey).toBe("key-1:reconcile:bdx_in:3");
  });

  it("refuses a tolerance that is not a whole number of minor units, zero or more", async () => {
    const calls = stubFetch(ok({}));
    for (const toleranceMinor of ["1.5", "-2", "abc"]) {
      const result = await action(args(form({ intent: "reconcile", bordereauId: "bdx_in", toleranceMinor })));
      expect(result.error, toleranceMinor).toBe("toleranceInvalid");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("action: unknown intent", () => {
  it("refuses rather than guessing what was meant", async () => {
    const calls = stubFetch(ok({}));
    const result = await action(args(form({ intent: "nonsense" })));
    expect(result.problem?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
