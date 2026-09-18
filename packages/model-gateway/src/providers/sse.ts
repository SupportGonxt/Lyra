// docs/27 F35. Server-sent events, the wire format every streaming provider in
// the catalogue speaks. One reader, because three adapters each parsing SSE by
// hand is three places for the same boundary bug — an event split across two
// network reads is the normal case, not the edge one.

/**
 * Yield the `data:` payloads of an SSE body, in order, whole.
 *
 * Buffers across reads on purpose: a chunk boundary is a transport artefact and
 * lands wherever TCP decides, including halfway through a JSON object. The
 * terminating `[DONE]` sentinel is consumed here rather than handed on, because
 * it is a protocol marker and not a model's output.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line; \r\n\r\n is equally legal, so the
      // separator's own length has to come from the match and not from a
      // hard-coded 2.
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          if (payload) yield payload;
        }
      }
    }
    // A body that ends without its final blank line still carries an event.
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse an SSE payload, skipping anything that is not JSON rather than
 *  failing the stream over one malformed keep-alive. */
export function sseJson<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}
