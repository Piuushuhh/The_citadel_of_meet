import { describe, expect, it } from "vitest";
import { assessTranscript } from "../src/transcriptConfidence";

const lp = (...probs: number[]) => probs.map((p, i) => ({ token: `t${i}`, logprob: Math.log(p) }));

describe("assessTranscript", () => {
  it("accepts confident transcripts", () => {
    const r = assessTranscript(lp(0.99, 0.95, 0.9, 0.97));
    expect(r.accepted).toBe(true);
    expect(r.mean).toBeGreaterThan(0.9);
  });

  it("rejects when the model was guessing overall", () => {
    expect(assessTranscript(lp(0.5, 0.4, 0.6, 0.5)).accepted).toBe(false);
  });

  it("rejects when one word is very likely wrong", () => {
    expect(assessTranscript(lp(0.99, 0.99, 0.05, 0.99)).accepted).toBe(false);
  });

  it("accepts when no confidence data is available", () => {
    expect(assessTranscript(undefined).accepted).toBe(true);
    expect(assessTranscript([]).accepted).toBe(true);
  });

  it("ignores whitespace-only tokens", () => {
    expect(assessTranscript([{ token: " ", logprob: Math.log(0.01) }, ...lp(0.99, 0.98)]).accepted).toBe(true);
  });
});
