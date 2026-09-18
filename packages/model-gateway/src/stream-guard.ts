import { blocked, checkOutput, type GuardrailHit, type PostCheckInput } from "./guardrails.js";

// docs/15 §2 ("streamed always") + docs/27 F35. Streaming and a post-flight
// guardrail are in direct tension: `checkOutput` decides about a finished
// answer, and a stream has no finished answer until it is already on the
// reader's screen. This is where that tension is resolved, and it is a pure
// function so the golden set (evals/streaming) can drive it.
//
// The naive resolutions are both wrong. Checking each chunk on its own misses
// every phrase that lands across a boundary — "we gua" + "rantee this" is two
// clean chunks and one blocked sentence. Buffering the whole answer and
// checking once at the end is not streaming at all, it is a slower `complete()`.

/**
 * Characters held back from the reader until more text arrives or the stream
 * ends. It must exceed the longest phrase any rule can match, or a pattern
 * could complete entirely inside text already emitted — the one failure this
 * design cannot recover from, because emitted text cannot be recalled.
 *
 * The longest floor today is an Arabic regulated claim at well under 60
 * characters; 160 leaves room for rules nobody has written yet, and costs the
 * reader a delay of one chunk.
 */
export const HOLDBACK = 160;

export interface StreamGuardState {
  /** How much of the accumulated text has already gone to the reader. */
  emittedUpTo: number;
  refused: boolean;
}

export function newStreamGuard(): StreamGuardState {
  return { emittedUpTo: 0, refused: false };
}

export interface StreamStep {
  /** Text to send now. Empty is normal: most chunks land inside the holdback. */
  emit: string;
  /** Every rule that has fired on the answer so far. */
  hits: GuardrailHit[];
  /** The answer is blocked. Nothing further may be emitted, ever. */
  refused: boolean;
}

/**
 * Advance the guard over everything the model has said so far.
 *
 * Called with the *accumulated* text rather than the latest delta, because a
 * rule is about the answer and not about a transport artefact — which chunk a
 * phrase happened to be split across is the provider's business, not a
 * guardrail's.
 *
 * On a block the reader gets nothing more. Text already emitted stays emitted:
 * that is why the holdback exists and why it is sized against the rules rather
 * than against a network buffer.
 */
export function guardChunk(
  state: StreamGuardState,
  accumulated: string,
  done: boolean,
  opts: Omit<PostCheckInput, "text">
): StreamStep {
  if (state.refused) return { emit: "", hits: [], refused: true };

  const hits = checkOutput({ ...opts, text: accumulated });
  if (blocked(hits)) {
    state.refused = true;
    return { emit: "", hits, refused: true };
  }

  // Hold the tail back while the answer is still arriving; release everything
  // once it cannot grow.
  const safeUpTo = done ? accumulated.length : Math.max(state.emittedUpTo, accumulated.length - HOLDBACK);
  const emit = accumulated.slice(state.emittedUpTo, safeUpTo);
  state.emittedUpTo = safeUpTo;
  return { emit, hits, refused: false };
}
