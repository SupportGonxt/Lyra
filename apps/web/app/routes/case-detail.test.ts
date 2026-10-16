import { flowPlan } from "@lyra/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  CASE_FLOW,
  CASE_TRANSITIONS,
  LABELS,
  STATES,
  action,
  caseLede,
  labelsIn,
  stateOfAudit
} from "./case-detail";

// The work item's two transitions are the only writes: move the state machine,
// or mark one document verified. Both are the API's own state changes, so the
// reducer only guards the inputs and passes a refusal through untouched.

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
      idempotencyKey: init.headers instanceof Headers ? init.headers.get("idempotency-key") : null
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/axis/cases/cas_1/detail", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: { id: "cas_1" }
  } as unknown as ActionFunctionArgs;
}

function form(fields: Record<string, string>) {
  const body = new FormData();
  body.set("idempotencyKey", "key-1");
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
}

const ok = () =>
  new Response(JSON.stringify({ id: "cas_1" }), { status: 200, headers: { "content-type": "application/json" } });

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

  it("names every state it offers to move to, in both languages", () => {
    for (const state of STATES) {
      for (const locale of ["en", "ar"]) {
        expect(labelsIn(locale)(`status.${state}`), `${locale}:${state}`).not.toBe(`status.${state}`);
      }
    }
  });

  it("answers the chrome Gate needs, with the rule interpolated", () => {
    expect(labelsIn("en")("approvalBody", { policy: "axis.case_transition" })).toContain("axis.case_transition");
  });
});

describe("caseLede", () => {
  it("states the status and priority from the loaded record", () => {
    const lede = caseLede({ status: "review", priority: "high", slaDueAt: null }, labelsIn("en"), "en");
    expect(lede).toBe("Review · High priority");
  });

  it("adds the SLA due date when the record has one", () => {
    const lede = caseLede(
      { status: "awaiting_docs", priority: "urgent", slaDueAt: Date.parse("2026-09-01T00:00:00Z") },
      labelsIn("en"),
      "en"
    );
    expect(lede).toContain("Awaiting documents");
    expect(lede).toContain("Urgent priority");
    expect(lede).toContain("2026");
  });
});

describe("action: move", () => {
  it("patches only the status", async () => {
    const calls = stubFetch(ok());

    const result = await action(args(form({ intent: "move", status: "review" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/cases/cas_1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: "review" });
    expect(result.done).toBe("moved");
  });

  it("refuses a state the machine does not have", async () => {
    const calls = stubFetch(ok());
    for (const status of ["", "done", "INTAKE"]) {
      const result = await action(args(form({ intent: "move", status })));
      expect(result.error, status).toBe("stateRequired");
    }
    expect(calls).toHaveLength(0);
  });

  it("surfaces a refusal rather than claiming the item moved", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403, code: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "move", status: "issued" })));

    expect(result.problem?.status).toBe(403);
    expect(result.done).toBeNull();
  });
});

describe("action: verify", () => {
  it("posts the verify step for one document", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "verify", documentId: "doc_1" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/documents/doc_1/verify");
    expect(calls[0]?.method).toBe("POST");
    expect(result.done).toBe("verified");
  });

  it("refuses a missing document without calling anything", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));

    const result = await action(args(form({ intent: "verify", documentId: "  " })));

    expect(result.error).toBe("documentRequired");
    expect(calls).toHaveLength(0);
  });
});

describe("action: copilot", () => {
  it("asks the case copilot and returns its answer", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ answer: "It is worth 5000 AED.", confidence: 0.95, mismatches: [], auditId: "aud_1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "copilot", question: "What is this case worth?", locale: "en" })));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/cases/cas_1/copilot");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ question: "What is this case worth?", locale: "en" });
    // Suffixed with the intent: the same page-load key must not collide across
    // this form and the case's move/verify/export forms (regression: IMPORTANT 4/5).
    expect(calls[0]?.idempotencyKey).toBe("key-1:copilot");
    expect(result.done).toBe("answered");
    expect(result.answer).toBe("It is worth 5000 AED.");
    expect(result.mismatches).toEqual([]);
  });

  it("surfaces flagged groundedness mismatches from the API", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ answer: "It is worth 999999 AED.", confidence: 0.5, mismatches: [999999], auditId: "aud_2" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await action(args(form({ intent: "copilot", question: "What is this case worth?", locale: "en" })));

    expect(result.mismatches).toEqual([999999]);
  });

  it("refuses an empty question without calling anything", async () => {
    const calls = stubFetch(ok());

    const result = await action(args(form({ intent: "copilot", question: "  ", locale: "en" })));

    expect(result.error).toBe("questionRequired");
    expect(calls).toHaveLength(0);
  });
});

describe("action: anything else", () => {
  it("rejects an intent it does not implement", async () => {
    const calls = stubFetch(ok());

    const result = await action(args(form({ intent: "close" })));

    expect(result.problem?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("action: export", () => {
  it("requests an internal evidence bundle scoped to this case", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ id: "evb_1", state: "ready" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "export" })));

    // docs/modules/axis.md §8 criterion 3: the case's own audit bundle, not a
    // generic compliance bundle scoped by subjectRef.
    expect(calls[0]?.url).toBe("https://api.test/v1/axis/cases/cas_1/audit-bundle");
    expect(calls[0]?.method).toBe("POST");
    expect(result.done).toBe("exported");
    expect(result.bundleId).toBe("evb_1");
  });

  it("surfaces a refusal rather than claiming the bundle exists", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403, code: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(args(form({ intent: "export" })));

    expect(result.problem?.status).toBe(403);
    expect(result.done).toBeNull();
  });
});

// The diagram is only as true as the machine it is handed, and the history it
// draws is only as true as the trail it reads. These pin both.

describe("CASE_FLOW", () => {
  it("is the screen's machine by reference, not a second copy of it", () => {
    expect(CASE_FLOW.transitions).toBe(CASE_TRANSITIONS);
  });

  it("documents exactly the states the screen's picker offers", () => {
    // The move form is built from STATES; a state it can send that the flow
    // cannot draw would be a case the diagram silently loses.
    expect(Object.keys(CASE_TRANSITIONS).sort()).toEqual([...STATES].sort());
  });

  it("names no state the machine does not document", () => {
    for (const state of [...CASE_FLOW.spine, ...(CASE_FLOW.exits ?? [])]) {
      expect(CASE_TRANSITIONS[state]).toBeDefined();
    }
  });

  it("is a spine of documented transitions, whole", () => {
    // `flowPlan` throws on an undocumented spine edge, so this both plans and
    // proves the happy path is one the case engine can actually walk.
    const plan = flowPlan(CASE_FLOW, [], "intake");
    expect(plan.steps.map((step) => step.state)).toEqual([...CASE_FLOW.spine]);
    expect(plan.unknown).toEqual([]);
  });

  it("can draw every state the machine can reach, on the spine or off it", () => {
    for (const state of Object.keys(CASE_TRANSITIONS)) {
      const plan = flowPlan(CASE_FLOW, [{ state }], state);
      expect(plan.steps.map((step) => step.state)).toContain(state);
      expect(plan.unknown).toEqual([]);
    }
  });

  it("never tells a live case it is pending failure or cancellation", () => {
    // An exit is how a case ends instead of continuing, so it is never drawn as
    // work still owed on a case that is still going.
    for (const state of CASE_FLOW.spine) {
      const plan = flowPlan(CASE_FLOW, [], state);
      for (const exit of CASE_FLOW.exits ?? []) {
        expect(plan.steps.map((step) => step.state)).not.toContain(exit);
      }
    }
  });

  it("promises nothing further once a case is issued or cancelled", () => {
    for (const state of ["issued", "cancelled"]) {
      const plan = flowPlan(CASE_FLOW, [{ state }], state);
      expect(plan.steps.filter((step) => step.status === "pending")).toEqual([]);
    }
  });

  it("offers a failed case the one hop the machine documents", () => {
    // Failure is not the end of the road the way cancellation is: the machine
    // says a failed case may be taken back to intake, so the flow says so too.
    const plan = flowPlan(CASE_FLOW, [{ state: "failed" }], "failed");
    expect(plan.steps.map((step) => step.state)).toEqual(["failed", "intake"]);
  });

  it("shows the detour, not the spine, while a case waits on documents", () => {
    const plan = flowPlan(CASE_FLOW, [{ state: "quoting" }], "awaiting_docs");
    expect(plan.steps.map((step) => step.state)).toEqual(["quoting", "awaiting_docs", "quoting", "review"]);
  });
});

describe("stateOfAudit", () => {
  it("reads the state out of a hop the case lifecycle engine wrote", () => {
    expect(stateOfAudit("axis.case.quoting")).toBe("quoting");
    expect(stateOfAudit("axis.case.issued")).toBe("issued");
    expect(stateOfAudit("axis.case.awaiting_docs")).toBe("awaiting_docs");
  });

  it("is not a state change for anything else on the trail", () => {
    for (const entry of [
      // The generic resource writes this on create; the status it created the
      // row with is whatever the caller posted, so it is not read as `intake`.
      "axis.cases.create",
      "axis.cases.update",
      "axis.documents.verify",
      "core.approval.decided",
      "axis.claim.assessing",
      "axis.case.",
      ""
    ]) {
      expect(stateOfAudit(entry)).toBeNull();
    }
  });
});

describe("action: census", () => {
  // docs/modules/axis.md §2.2. The wiring worth testing is the translation: a
  // screen gets text and the API takes rows, and everything between them is
  // `parseCensusText`.

  it("parses a pasted spreadsheet into rows and reads the census back", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ census: { asOf: 1, members: [], problems: [] }, rollup: { lives: 3, byAgeBand: {}, bySalaryBand: {}, dependents: 4, averageDependents: 1.3, unpriced: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await action(
      args(form({ intent: "census", censusText: "Employee No\tName\tSalary\nE1\tRania\t24000\nE2\tOmar\t9600\n" }))
    );

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/census/normalise");
    const body = JSON.parse(calls[0]!.body!);
    // Tabs are the column separator and the trailing newline is not a row.
    expect(body.rows).toEqual([
      ["Employee No", "Name", "Salary"],
      ["E1", "Rania", "24000"],
      ["E2", "Omar", "9600"]
    ]);
    // An age is meaningless without a date, so the census states the day it was
    // taken. The exact instant is the screen's clock, not the file's.
    expect(typeof body.asOf).toBe("number");
    expect(body.priorRows).toBeUndefined();
    expect(result.done).toBe("census");
    expect(result.census?.rollup.lives).toBe(3);
  });

  it("sends last year's list only when one was pasted", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ census: { asOf: 1, members: [], problems: [] }, rollup: { lives: 1, byAgeBand: {}, bySalaryBand: {}, dependents: 0, averageDependents: 0, unpriced: 0 }, diff: { added: [], removed: [], moved: [], dependentsChanged: [], unchanged: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await action(args(form({ intent: "census", censusText: "Name,Age\nRania,34", priorCensusText: "Name,Age\nRania,33" })));

    const body = JSON.parse(calls[0]!.body!);
    expect(body.priorRows).toEqual([["Name", "Age"], ["Rania", "33"]]);
  });

  it("refuses an empty paste without calling the API", async () => {
    const calls = stubFetch(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await action(args(form({ intent: "census", censusText: "   \n  " })));
    expect(result.error).toBe("censusRequired");
    expect(calls).toHaveLength(0);
  });
});
