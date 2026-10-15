import { and, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, conflict, diffWords, notFound, type Ctx, type DiffSpan } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";

// ADR-0123: a policy wording is **transcribed, not parsed.**
//
// `docs/modules/scout.md` §8 clause 2 asks the wording differ to catch a
// coverage-term change **between two policy PDFs**. The differ existed and took
// `textA`/`textB`; nothing produced those from a document, because
// `POST /v1/axis/documents/:id/extract` returns *named fields* and never the
// document's words (`routes/axis.ts:309`).
//
// The rejected alternative is worth keeping in view, because it is the obvious
// one: a PDF-text dependency. It returns the **empty string** on a scanned
// wording, and the differ then reports *no coverage-term change* between two
// documents it could not read — a confident false negative taken to a provider,
// with nothing surfacing it. A transcription of a scan returns words.

/** What is stored on the document. Pinned, because two runs may disagree. */
export interface WordingReading {
  text: string;
  model: string;
  tier: string;
  at: number;
}

/** One side of a comparison, with where its text came from. */
export interface WordingSide {
  documentId: string;
  reading: WordingReading;
  /** False when this reading was reused rather than taken now. */
  transcribedNow: boolean;
}

export interface WordingComparison {
  left: WordingSide;
  right: WordingSide;
  spans: DiffSpan[];
  /**
   * True when **both** sides were read by a model rather than by a text layer.
   * The surface must say so: a comparison of two model readings is a different
   * claim from a comparison of two text layers, and presenting them as the same
   * thing is the failure the compliance posture tile's `live` vs `on_file` rule
   * exists to prevent.
   */
  bothTranscribed: boolean;
}

/** The words of a wording, from the model, one document. */
export async function transcribeWording(
  ctx: Ctx,
  gateway: Gateway,
  input: { documentId: string; bytes: Uint8Array; mimeType: string }
): Promise<WordingReading> {
  if (input.mimeType !== "application/pdf") {
    // A transcription is for a rendered page. A text file has words already, and
    // sending it to a model would invent rather than read.
    throw badRequest(`a wording is transcribed from a PDF, not ${input.mimeType}`);
  }
  const res = await gateway.complete(ctx, {
    module: "scout",
    purpose: "wording.transcribe",
    tier: "reasoning",
    subjectRef: input.documentId,
    // The document's own language, which the gateway passes to the provider; the
    // transcription must come back in the language it was written in or the diff
    // compares two languages and reports the whole document as changed.
    locale: ctx.locale,
    messages: [
      {
        role: "system",
        content:
          "Transcribe the attached policy wording, page by page, in its original language. " +
          "Reproduce every clause, exclusion, limit and figure exactly as written. " +
          "Add nothing, summarise nothing, correct nothing — a difference you introduce " +
          "is a coverage change a reader will act on."
      },
      { role: "user", content: `Transcribe this wording in full. Document ${input.documentId}.` }
    ]
  });
  const text = res.text.trim();
  if (!text) {
    // An empty reading is not a reading. Storing it would make the diff report a
    // total rewrite, or agree with anything — both worse than a refusal.
    throw conflict("the transcription came back empty; nothing was stored");
  }
  return {
    text,
    model: res.model ?? "unknown",
    tier: "reasoning",
    at: ctx.now
  };
}

/** Store a reading on its document, and answer it back. */
export async function saveWording(
  ctx: Ctx,
  documentId: string,
  reading: WordingReading
): Promise<void> {
  const [row] = await ctx.db
    .select({ id: schema.axisDocuments.id, tenantId: schema.axisDocuments.tenantId })
    .from(schema.axisDocuments)
    .where(and(eq(schema.axisDocuments.tenantId, ctx.tenantId), eq(schema.axisDocuments.id, documentId)));
  if (!row) throw notFound("document");
  await ctx.db
    .update(schema.axisDocuments)
    .set({ wordingJson: JSON.stringify(reading) })
    .where(and(eq(schema.axisDocuments.tenantId, ctx.tenantId), eq(schema.axisDocuments.id, documentId)));
}

/**
 * The stored reading for a document, or null. Read rather than re-transcribed:
 * a comparison re-run must compare the same two readings it compared before, or
 * the spans move for a reason that has nothing to do with the wordings.
 */
export async function storedWording(ctx: Ctx, documentId: string): Promise<WordingReading | null> {
  const [row] = await ctx.db
    .select({ wordingJson: schema.axisDocuments.wordingJson })
    .from(schema.axisDocuments)
    .where(and(eq(schema.axisDocuments.tenantId, ctx.tenantId), eq(schema.axisDocuments.id, documentId)));
  if (!row) throw notFound("document");
  if (!row.wordingJson) return null;
  try {
    const parsed = JSON.parse(row.wordingJson) as WordingReading;
    return typeof parsed?.text === "string" && parsed.text.length ? parsed : null;
  } catch {
    // A malformed blob is "we do not know what this said", the safe reading of
    // which is to transcribe again rather than to compare against nonsense.
    return null;
  }
}

/**
 * Compare two wordings, transcribing whichever side has no reading yet.
 *
 * `read` is injected rather than reached for, so the engine is testable without
 * an R2 binding and the route is the only thing that knows where bytes live.
 */
export async function compareWordings(
  ctx: Ctx,
  gateway: Gateway,
  input: {
    leftId: string;
    rightId: string;
    read: (documentId: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  }
): Promise<WordingComparison> {
  if (input.leftId === input.rightId) throw badRequest("a wording cannot be compared with itself");

  const side = async (documentId: string): Promise<WordingSide> => {
    const stored = await storedWording(ctx, documentId);
    if (stored) return { documentId, reading: stored, transcribedNow: false };
    const file = await input.read(documentId);
    const reading = await transcribeWording(ctx, gateway, {
      documentId,
      bytes: file.bytes,
      mimeType: file.mimeType
    });
    await saveWording(ctx, documentId, reading);
    return { documentId, reading, transcribedNow: true };
  };

  // Sequential rather than parallel: the two calls share one tenant's AI budget,
  // and a rate-limit refusal on one side would leave the other transcribed and
  // the comparison unmade.
  const left = await side(input.leftId);
  const right = await side(input.rightId);

  return {
    left,
    right,
    spans: diffWords(left.reading.text, right.reading.text),
    bothTranscribed: true
  };
}

/** A stable id for an audit row about a comparison — no write, just a name. */
export const comparisonRef = (leftId: string, rightId: string): string =>
  `wording:${leftId}:${rightId}`;
