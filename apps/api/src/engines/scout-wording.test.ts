import { describe, expect, it, vi } from "vitest";
import { compareWordings, storedWording, transcribeWording } from "./scout-wording.js";
import type { Ctx } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";

// ADR-0123: a policy wording is transcribed, not parsed. What these tests hold is
// the behaviour the criterion depends on and the two ways it can lie — a
// comparison against a reading that was never taken, and a "no change" answer
// built from nothing.

/** A Ctx whose db answers the three statements this engine makes. */
function ctxWith(wordingJson: string | null, updates: string[]) {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [{ wordingJson, id: "doc_1", tenantId: "t1" }]
      })
    }),
    update: () => ({
      set: (values: { wordingJson?: string }) => ({
        where: async () => {
          if (values.wordingJson) updates.push(values.wordingJson);
        }
      })
    })
  };
  return { db, tenantId: "t1", now: 1_700_000_000_000, locale: "en" } as unknown as Ctx;
}

const gatewayReturning = (text: string): Gateway =>
  ({ complete: vi.fn(async () => ({ text, model: "stub-1", usage: {} })) }) as unknown as Gateway;

/**
 * A problem object carries its reason in `detail`, not `message` — so a test that
 * matches the message matches "Bad request" for every refusal in the tree.
 */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { detail?: string; message?: string }).detail ?? (error as Error).message);
  }
  throw new Error("expected a refusal");
}

describe("transcribeWording", () => {
  it("refuses a document that is not a PDF, because a text file has words already", async () => {
    const ctx = ctxWith(null, []);
    expect(
      await refusal(() =>
        transcribeWording(ctx, gatewayReturning("x"), { documentId: "d", bytes: new Uint8Array(), mimeType: "text/plain" })
      )
    ).toMatch(/transcribed from a PDF/);
  });

  it("refuses an empty reading rather than storing one", async () => {
    // An empty transcript would make the diff agree with anything, which is the
    // false negative this whole decision was made to avoid.
    const ctx = ctxWith(null, []);
    expect(
      await refusal(() =>
        transcribeWording(ctx, gatewayReturning("   "), { documentId: "d", bytes: new Uint8Array(), mimeType: "application/pdf" })
      )
    ).toMatch(/came back empty/);
  });

  it("pins the reading to the model that made it", async () => {
    const ctx = ctxWith(null, []);
    const reading = await transcribeWording(ctx, gatewayReturning("Windscreen is covered."), {
      documentId: "d",
      bytes: new Uint8Array(),
      mimeType: "application/pdf"
    });
    expect(reading.text).toBe("Windscreen is covered.");
    expect(reading.model).toBe("stub-1");
    expect(reading.at).toBe(ctx.now);
  });
});

describe("compareWordings", () => {
  it("transcribes both sides once and stores each reading", async () => {
    const updates: string[] = [];
    const ctx = ctxWith(null, updates);
    const gateway = { complete: vi.fn(async () => ({ text: "cover A", model: "stub-1", usage: {} })) } as unknown as Gateway;

    const result = await compareWordings(ctx, gateway, {
      leftId: "left",
      rightId: "right",
      read: async () => ({ bytes: new Uint8Array(), mimeType: "application/pdf" })
    });

    expect(updates).toHaveLength(2);
    expect(result.bothTranscribed).toBe(true);
    expect(result.left.transcribedNow).toBe(true);
  });

  it("reuses a stored reading instead of transcribing again", async () => {
    // A comparison re-run must compare the same two readings it compared before,
    // or the spans move for a reason that has nothing to do with the wordings.
    const ctx = ctxWith(JSON.stringify({ text: "cover A", model: "old", tier: "reasoning", at: 1 }), []);
    const gateway = { complete: vi.fn() } as unknown as Gateway;
    const result = await compareWordings(ctx, gateway, {
      leftId: "left",
      rightId: "right",
      read: async () => ({ bytes: new Uint8Array(), mimeType: "application/pdf" })
    });
    expect(result.left.transcribedNow).toBe(false);
    expect(result.left.reading.model).toBe("old");
  });

  it("refuses a wording compared with itself", async () => {
    const ctx = ctxWith(null, []);
    expect(
      await refusal(() =>
        compareWordings(ctx, gatewayReturning("x"), {
          leftId: "same",
          rightId: "same",
          read: async () => ({ bytes: new Uint8Array(), mimeType: "application/pdf" })
        })
      )
    ).toMatch(/compared with itself/);
  });
});

describe("storedWording", () => {
  it("treats a malformed blob as no reading, so the diff re-reads rather than compares nonsense", async () => {
    const ctx = ctxWith("{not json", []);
    expect(await storedWording(ctx, "d")).toBeNull();
  });
});
