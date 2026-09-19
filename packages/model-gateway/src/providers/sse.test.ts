import { describe, expect, it } from "vitest";
import { sseData, sseJson } from "./sse.js";

// docs/27 F35. This was the streaming route's zero-coverage half of the SSE
// reader: exercised only through gateway.test.ts's fake providers, which
// never split an event across a chunk boundary — the case a hand-rolled SSE
// parser actually gets wrong. Built directly against a controllable stream.

function sseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    }
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of sseData(body)) out.push(payload);
  return out;
}

describe("sseData", () => {
  it("yields a single whole event terminated by a blank line", async () => {
    const out = await collect(sseStream(['data: {"a":1}\n\n']));
    expect(out).toEqual(['{"a":1}']);
  });

  it("buffers a payload split mid-event across two reads", async () => {
    // The boundary lands inside the JSON body itself, which is the normal
    // case for a network chunk, not the edge one.
    const out = await collect(sseStream(['data: {"a":1,', '"b":2}\n\n']));
    expect(out).toEqual(['{"a":1,"b":2}']);
  });

  it("reads two events across a boundary that splits the separator itself", async () => {
    const out = await collect(sseStream(["data: one\n", "\ndata: two\n\n"]));
    expect(out).toEqual(["one", "two"]);
  });

  it("accepts CRLF separators exactly like LF", async () => {
    const out = await collect(sseStream(["data: one\r\n\r\ndata: two\r\n\r\n"]));
    expect(out).toEqual(["one", "two"]);
  });

  it("stops at the [DONE] sentinel and yields nothing for it", async () => {
    const out = await collect(sseStream(["data: one\n\n", "data: [DONE]\n\n", "data: never\n\n"]));
    expect(out).toEqual(["one"]);
  });

  it("yields a trailing event that never got its closing blank line", async () => {
    const out = await collect(sseStream(["data: whole\n\ndata: trailing"]));
    expect(out).toEqual(["whole", "trailing"]);
  });

  it("drops a trailing [DONE] with no closing blank line rather than yielding it", async () => {
    const out = await collect(sseStream(["data: whole\n\ndata: [DONE]"]));
    expect(out).toEqual(["whole"]);
  });

  it("ignores non-data lines inside an event (event:, id:, comments)", async () => {
    const out = await collect(sseStream(["event: message\nid: 5\ndata: payload\n\n"]));
    expect(out).toEqual(["payload"]);
  });

  it("skips a blank data payload rather than yielding an empty string", async () => {
    const out = await collect(sseStream(["data:\n\ndata: real\n\n"]));
    expect(out).toEqual(["real"]);
  });

  it("trims exactly the leading space after the colon, no more", async () => {
    const out = await collect(sseStream(["data:  padded  \n\n"]));
    expect(out).toEqual(["padded"]);
  });

  it("releases the reader's lock when the stream ends", async () => {
    const stream = sseStream(["data: one\n\n"]);
    await collect(stream);
    // A released lock can be re-acquired; a still-locked stream throws.
    expect(() => stream.getReader()).not.toThrow();
  });
});

describe("sseJson", () => {
  it("parses a valid JSON payload", () => {
    expect(sseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null rather than throwing on malformed JSON", () => {
    expect(sseJson("not json")).toBeNull();
  });

  it("returns null on an empty payload", () => {
    expect(sseJson("")).toBeNull();
  });
});
