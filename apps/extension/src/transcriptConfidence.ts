// Decide whether a participant transcript is trustworthy enough to show and act on.
// The Realtime session includes per-token log probabilities (see server session config).

export interface TokenLogprob {
  token?: string;
  logprob: number;
}

export interface TranscriptConfidence {
  /** Geometric-mean token probability, 0..1 (undefined when no logprobs were sent). */
  mean?: number;
  /** Lowest single-token probability, 0..1. */
  min?: number;
  accepted: boolean;
}

/**
 * Below these, the transcript is treated as "unclear" and neither shown as fact nor acted on.
 * mean < 0.55 means the model was guessing across the whole utterance; a single word below 0.15
 * means at least one word is very likely wrong (e.g. a misheard name or number).
 */
export const MIN_MEAN_PROB = 0.55;
export const MIN_TOKEN_PROB = 0.15;

export function assessTranscript(logprobs: TokenLogprob[] | undefined | null): TranscriptConfidence {
  const lp = (logprobs ?? []).filter((t) => Number.isFinite(t.logprob) && (t.token ?? "x").trim() !== "");
  // No confidence data (older server config): fall back to accepting, as before.
  if (lp.length === 0) return { accepted: true };
  const mean = Math.exp(lp.reduce((s, t) => s + t.logprob, 0) / lp.length);
  const min = Math.exp(Math.min(...lp.map((t) => t.logprob)));
  return { mean, min, accepted: mean >= MIN_MEAN_PROB && min >= MIN_TOKEN_PROB };
}
