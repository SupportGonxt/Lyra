import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { FOCUS, focusIn, lensOf } from "../components/hero";
import {
  DOC_LENSES,
  FIELD_PREFIX,
  OPEN_DOC_STATUSES,
  REVIEW_FLOOR,
  action,
  bboxOf,
  carriedJson,
  confidenceOf,
  fieldsOf,
  headlineFor,
  isSealedValue,
  labelsIn,
  mergeCorrections,
  needsReview,
  phrase,
  statusTone,
  typedFrom,
  worstDoc,
  type DocRow
} from "./axis-doc-intel";

// This screen shows a model's guesses next to a human's box, and the one thing it
// must never do is quietly turn a guess into a record. So: what the merge accepts,
// what it refuses, that confidence is read in the units it was stored in, and
// that verify sends no body it could use to name its own verifier.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null; key: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      key: new Headers(init.headers).get("idempotency-key")
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/axis/doc-intelligence", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

describe("labelsIn", () => {
  it("translates every key into Arabic, statuses included", () => {
    const en = labelsIn("en");
    const ar = labelsIn("ar");
    const keys = [
      "title",
      "intro",
      "stat.open",
      "stat.extracted",
      "stat.received",
      "stat.rejected",
      "filter.label",
      "filter.open",
      "filter.all",
      "filter.submit",
      "why",
      "why.noModel",
      "confidence.label",
      "review.title",
      "review.reason",
      "evidence.label",
      "evidence.file",
      "evidence.type",
      "evidence.read",
      "evidence.verified",
      "correct.title",
      "correct.intro",
      "correct.placeholder",
      "correct.submit",
      "correct.none",
      "sealed.value",
      "sealed.why",
      "sealed.submit",
      "done.reveal",
      "verify.submit",
      "verify.hint",
      "extract.title",
      "extract.intro",
      "extract.rawText",
      "extract.locale",
      "extract.submit",
      "locale.en",
      "locale.ar",
      "status.received",
      "status.extracting",
      "status.extracted",
      "status.rejected",
      "status.verified",
      "done.correct",
      "done.verify",
      "done.extract",
      "empty.title",
      "empty.body",
      "approvalTitle",
      "approvalBody",
      "approvalLink",
      "problem.bad_intent",
      "problem.missing_doc",
      "problem.no_change",
      "problem.conflict",
      "headline.clear",
      "headline.review",
      "headline.rejected",
      "headline.reading",
      "headline.open"
    ];

    for (const key of keys) {
      expect(en(key), key).not.toBe(key);
      expect(ar(key), key).not.toBe(key);
      expect(ar(key), key).not.toBe(en(key));
    }
  });

  it("names the model that read the file in the inspectable why", () => {
    expect(labelsIn("en")("why", { model: "@cf/meta/llama-3.1-8b" })).toContain("@cf/meta/llama-3.1-8b");
    expect(labelsIn("ar")("why", { model: "@cf/meta/llama-3.1-8b" })).toContain("@cf/meta/llama-3.1-8b");
  });

  it("says accuracy is not what the percentage measures", () => {
    expect(labelsIn("en")("why").toLowerCase()).toContain("not a measure of accuracy");
  });
});

describe("carriedJson", () => {
  // The correction form posts the model's own values back so the merge compares
  // against what the human was shown. `extractionJson` arrives already parsed
  // (apps/api/src/crud.ts `hydrate`), and an object handed to an input `value`
  // is stringified by the DOM as "[object Object]" — which parses back to
  // nothing, so every correction merged against an empty model and was refused
  // as `no_change`. Nobody could save a correction at all.
  it("carries the model's values through a form value, not [object Object]", () => {
    const doc = { extractionJson: { fullName: "Aisha", idNumber: null } };
    expect(String(carriedJson(doc))).not.toContain("[object Object]");
    expect(fieldsOf({ extractionJson: carriedJson(doc) })).toEqual(fieldsOf(doc));
  });

  it("survives the round trip the action actually does", async () => {
    const doc = { extractionJson: { fullName: "Aisha", idNumber: null } };
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_1");
    form.set("extractionJson", carriedJson(doc));
    form.set(`${FIELD_PREFIX}idNumber`, "784-1990");

    const calls = stubFetch(new Response(JSON.stringify({ id: "doc_1" })));
    const result = await action(args(form));

    expect(result.problem).toBeNull();
    expect(result.done).toBe("correct");
    expect(calls[0]?.body).toBe(
      JSON.stringify({ extractionJson: JSON.stringify({ fullName: "Aisha", idNumber: "784-1990" }) })
    );
  });

  it("still carries an empty model for a document nothing has read", () => {
    expect(carriedJson({ extractionJson: null })).toBe("{}");
  });
});

describe("fieldsOf", () => {
  it("reads the model's answers and keeps an omitted field as null", () => {
    expect(fieldsOf({ extractionJson: { fullName: "Aisha", idNumber: "  ", expiryDate: null } })).toEqual({
      fullName: "Aisha",
      idNumber: null,
      expiryDate: null
    });
  });

  it("treats an unread document, bad JSON and a JSON array as nothing extracted", () => {
    expect(fieldsOf({ extractionJson: null })).toEqual({});
    expect(fieldsOf({ extractionJson: "not json" })).toEqual({});
    expect(fieldsOf({ extractionJson: ["a", "b"] })).toEqual({});
  });

  it("keeps the reserved _bbox key out of the correctable fields", () => {
    expect(fieldsOf({ extractionJson: { fullName: "Aisha", _bbox: { fullName: [1, 2, 3, 4] } } })).toEqual({
      fullName: "Aisha"
    });
  });
});

describe("bboxOf", () => {
  it("reads the model's box per field, as a percentage of the page", () => {
    expect(
      bboxOf({ extractionJson: { fullName: "Aisha", _bbox: { fullName: [12.5, 30, 40, 6] } } })
    ).toEqual({ fullName: [12.5, 30, 40, 6] });
  });

  it("treats a missing, malformed or absent box as nothing to draw", () => {
    expect(bboxOf({ extractionJson: null })).toEqual({});
    expect(bboxOf({ extractionJson: { fullName: "Aisha" } })).toEqual({});
    expect(bboxOf({ extractionJson: { _bbox: { fullName: [1, 2, 3] } } })).toEqual({});
    expect(bboxOf({ extractionJson: { _bbox: "not an object" } })).toEqual({});
  });
});

describe("confidenceOf / needsReview", () => {
  it("converts the stored 0-100 into the 0-1 the meter wants", () => {
    expect(confidenceOf({ extractionConfidence: 80 })).toBe(0.8);
    expect(confidenceOf({ extractionConfidence: 0 })).toBe(0);
  });

  it("treats a document nothing has read as unknown, not as zero confidence", () => {
    expect(confidenceOf({ extractionConfidence: null })).toBeNull();
    expect(needsReview({ extractionConfidence: null })).toBe(false);
  });

  it("asks for review below the floor and not at it", () => {
    expect(needsReview({ extractionConfidence: REVIEW_FLOOR * 100 })).toBe(false);
    expect(needsReview({ extractionConfidence: REVIEW_FLOOR * 100 - 1 })).toBe(true);
  });
});

const doc = (over: Partial<DocRow> = {}): DocRow => ({
  id: "doc_1",
  caseId: null,
  fileId: "file_1",
  docType: "id_card",
  status: "extracted",
  extractionJson: null,
  extractionConfidence: null,
  extractionModel: null,
  verifiedBy: null,
  verifiedAt: null,
  createdAt: 1_770_000_000_000,
  ...over
});

describe("headlineFor", () => {
  const l = labelsIn("en");

  it("says nothing is waiting when the desk is empty", () => {
    expect(headlineFor({ open: 0, needsReview: 0, rejected: 0 }, l)).toBe(l("headline.clear"));
  });

  it("leads with low-confidence rows over rejections", () => {
    expect(headlineFor({ open: 4, needsReview: 2, rejected: 1 }, l)).toBe(
      l("headline.review", { count: "2" })
    );
  });

  it("calls out rejections when nothing needs a closer look", () => {
    expect(headlineFor({ open: 3, needsReview: 0, rejected: 1 }, l)).toBe(
      l("headline.rejected", { count: "1" })
    );
  });

  it("falls back to reading when nothing needs review or was rejected", () => {
    expect(headlineFor({ open: 3, needsReview: 0, rejected: 0 }, l)).toBe(l("headline.reading"));
  });
});

describe("worstDoc", () => {
  it("picks the lowest-confidence row over a merely unread one", () => {
    const rows = [
      doc({ id: "received", status: "received" }),
      doc({ id: "weak", status: "extracted", extractionConfidence: 10 })
    ];
    expect(worstDoc(rows)?.id).toBe("weak");
  });

  it("falls back to the first extracted row when nothing is below the floor", () => {
    const rows = [
      doc({ id: "received", status: "received" }),
      doc({ id: "extracted", status: "extracted", extractionConfidence: 95 })
    ];
    expect(worstDoc(rows)?.id).toBe("extracted");
  });

  it("returns null when nothing is waiting on a person", () => {
    expect(worstDoc([doc({ status: "received" })])).toBeNull();
    expect(worstDoc([])).toBeNull();
  });
});

describe("statusTone", () => {
  it("gives every known status a tone and never crashes on a new one", () => {
    expect(statusTone("verified")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
    expect(statusTone("something_new")).toBe("neutral");
  });
});

describe("typedFrom", () => {
  it("picks up only prefixed field boxes, so intent and docId cannot become fields", () => {
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_1");
    form.set(`${FIELD_PREFIX}fullName`, "Aisha");
    expect(typedFrom(form)).toEqual({ fullName: "Aisha" });
  });
});

describe("mergeCorrections", () => {
  const model = { fullName: "Aisha", idNumber: null };

  it("takes the human's value over the model's", () => {
    expect(mergeCorrections(model, { fullName: "Aisha Khan" })).toEqual({
      fullName: "Aisha Khan",
      idNumber: null
    });
  });

  it("fills a field the model left empty", () => {
    expect(mergeCorrections(model, { idNumber: "784-1990" })).toEqual({
      fullName: "Aisha",
      idNumber: "784-1990"
    });
  });

  it("refuses a submission that typed nothing, so no write pretends to be a correction", () => {
    expect(mergeCorrections(model, {})).toBeNull();
    expect(mergeCorrections(model, { fullName: "   " })).toBeNull();
  });

  it("refuses a retype of exactly what the model already said", () => {
    expect(mergeCorrections(model, { fullName: "Aisha" })).toBeNull();
  });

  it("ignores a field the model was never asked about", () => {
    expect(mergeCorrections(model, { smuggled: "value" })).toBeNull();
    expect(mergeCorrections(model, { smuggled: "value", fullName: "A K" })).toEqual({
      fullName: "A K",
      idNumber: null
    });
  });
});

describe("correct", () => {
  it("patches the merged extraction, with an idempotency key", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_2");
    form.set("extractionJson", '{"fullName":"Aisha","idNumber":null}');
    form.set(`${FIELD_PREFIX}idNumber`, "784-1990");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/documents/doc_2");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toBe(
      JSON.stringify({ extractionJson: JSON.stringify({ fullName: "Aisha", idNumber: "784-1990" }) })
    );
    expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.done).toBe("correct");
  });

  it("never touches the confidence or the model the row was read by", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_2");
    form.set("extractionJson", '{"fullName":"Aisha"}');
    form.set(`${FIELD_PREFIX}fullName`, "Aisha Khan");

    await action(args(form));

    expect(calls[0]?.body).not.toContain("extractionConfidence");
    expect(calls[0]?.body).not.toContain("extractionModel");
    expect(calls[0]?.body).not.toContain("verifiedBy");
    expect(calls[0]?.body).not.toContain("status");
  });

  it("carries the sealed envelope through untouched when another field is corrected", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_2");
    form.set("extractionJson", '{"fullName":"Aisha","idNumber":"enc.v1.Zm9vYmFy"}');
    form.set(`${FIELD_PREFIX}fullName`, "Aisha Khan");

    await action(args(form));

    expect(calls[0]?.body).toContain("enc.v1.Zm9vYmFy");
  });

  it("refuses an empty correction without calling the API", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "correct");
    form.set("docId", "doc_2");
    form.set("extractionJson", '{"fullName":"Aisha"}');

    expect((await action(args(form))).problem?.code).toBe("no_change");
    expect(calls).toHaveLength(0);
  });
});

describe("isSealedValue", () => {
  // Mirrors the envelope packages/core/src/field-crypto.ts writes. The screen
  // never decrypts anything — it only has to know not to show the envelope as
  // if it were the value the model read.
  it("recognises a sealed identifier and nothing else", () => {
    expect(isSealedValue("enc.v1.Zm9vYmFy")).toBe(true);
    expect(isSealedValue("784-1990-1234567-1")).toBe(false);
    expect(isSealedValue(null)).toBe(false);
  });
});

describe("reveal", () => {
  it("asks the reveal door for the plaintext and hands back what it opened", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ values: { fullName: "Aisha", idNumber: "784-1990-1234567-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const form = new FormData();
    form.set("intent", "reveal");
    form.set("docId", "doc_6");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/documents/doc_6/reveal");
    expect(calls[0]?.method).toBe("POST");
    expect(result.done).toBe("reveal");
    expect(result.revealed).toEqual({ fullName: "Aisha", idNumber: "784-1990-1234567-1" });
  });

  it("reports the API's own 403 rather than pretending nothing is sealed", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "core:pii:view", status: 403, code: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );
    const form = new FormData();
    form.set("intent", "reveal");
    form.set("docId", "doc_6");

    const result = await action(args(form));

    expect(result.problem?.status).toBe(403);
    expect(result.revealed).toBeFalsy();
  });
});

describe("verify", () => {
  // `verifiedBy`/`verifiedAt` are evidence. The endpoint takes no input for them
  // and this screen must not start offering any.
  it("posts to the verify verb with no verifier of its own", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ status: "verified" }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "verify");
    form.set("docId", "doc_3");
    form.set("verifiedBy", "someone_else");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/documents/doc_3/verify");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("{}");
    expect(result.done).toBe("verify");
  });

  it("reports a second verification as the API's own conflict", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "document is already verified", status: 409, code: "conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    );
    const form = new FormData();
    form.set("intent", "verify");
    form.set("docId", "doc_3");

    const result = await action(args(form));

    expect(result.done).toBeNull();
    expect(result.problem?.status).toBe(409);
  });
});

describe("extract", () => {
  it("sends the pasted text and the document's language", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ status: "extracted" }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "extract");
    form.set("docId", "doc_4");
    form.set("rawText", "EMIRATES ID ... ");
    form.set("locale", "ar");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/documents/doc_4/extract");
    expect(calls[0]?.body).toBe(JSON.stringify({ rawText: "EMIRATES ID ...", locale: "ar" }));
    expect(result.done).toBe("extract");
  });

  it("falls back to English rather than sending a locale the endpoint rejects", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "extract");
    form.set("docId", "doc_4");
    form.set("rawText", "text");
    form.set("locale", "fr");

    await action(args(form));

    expect(calls[0]?.body).toBe(JSON.stringify({ rawText: "text", locale: "en" }));
  });

  // The API reads the stored file itself when no text is sent (vision,
  // routes/axis.ts); the screen used to refuse an empty paste, so a scanned
  // upload could only be read by retyping it (docs/30, AXIS gap 1).
  it("reads the stored file when nothing is pasted", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "extract");
    form.set("docId", "doc_4");
    form.set("rawText", "   ");
    form.set("locale", "ar");

    expect((await action(args(form))).done).toBe("extract");
    expect(calls[0]?.body).toBe(JSON.stringify({ locale: "ar" }));
  });
});

describe("refusals", () => {
  it("needs a document before anything else", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "verify");

    expect((await action(args(form))).problem?.code).toBe("missing_doc");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown intent as a 400 and touches nothing", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const form = new FormData();
    form.set("intent", "reject-all");
    form.set("docId", "doc_5");

    const result = await action(args(form));

    expect(result.problem?.status).toBe(400);
    expect(result.problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });
});

describe("phrase", () => {
  it("swaps a known code and leaves the API's own wording alone", () => {
    const l = labelsIn("en");
    expect(phrase({ title: "no_change", status: 400, code: "no_change" }, l).title).toBe(
      l("problem.no_change")
    );
    expect(phrase({ title: "budget exhausted", status: 402, code: "budget" }, l).title).toBe(
      "budget exhausted"
    );
  });
});

describe("the documents on the desk", () => {
  it("are the ones not yet vouched for", () => {
    expect([...OPEN_DOC_STATUSES]).toEqual(["received", "extracting", "extracted", "rejected"]);
    expect(OPEN_DOC_STATUSES).not.toContain("verified");
  });
});

describe("the hero figures and what clicking one shows", () => {
  // The desk's four figures are counts over one page of documents, and the list
  // beside them is that same page. So the drill-down is a lens over the array the
  // figure counted — which is what makes a "Rejected: 3" that opens a list of two
  // impossible rather than merely unlikely.
  const rows = [
    doc({ id: "a", status: "received" }),
    doc({ id: "b", status: "extracted" }),
    doc({ id: "c", status: "extracted" }),
    doc({ id: "d", status: "rejected" }),
    doc({ id: "e", status: "extracting" })
  ];

  it("lists exactly the rows each drillable figure counted", () => {
    for (const lens of ["extracted", "received", "rejected"]) {
      const listed = lensOf(rows, DOC_LENSES, lens);
      expect(listed, lens).toHaveLength(rows.filter((row) => row.status === lens).length);
      expect(
        listed.every((row) => row.status === lens),
        lens
      ).toBe(true);
    }
  });

  it("keeps the desk total meaning the whole page, so its own link clears the lens", () => {
    expect(lensOf(rows, DOC_LENSES, null)).toHaveLength(rows.length);
    // `extracting` is fetched but has no figure on the wall, so it has no lens: a
    // filter nobody can read off a hero must not be reachable by hand-typing it.
    expect(focusIn(new URLSearchParams(`${FOCUS}=extracting`), DOC_LENSES)).toBeNull();
  });
});
