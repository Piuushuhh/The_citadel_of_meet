import { describe, expect, it } from "vitest";
import {
  AutomaticResponseGate,
  automaticDecisionPrompt,
  isLatinScriptTranscript,
  parseAutomaticDecision,
  transcriptRoute,
} from "../src/automaticResponse";

describe("automatic response routing", () => {
  it("preserves explicit-address behavior and supports automatic mode", () => {
    expect(transcriptRoute("explicit", "Maya, what is the launch date?", "Maya")).toBe("explicit");
    expect(transcriptRoute("explicit", "What is the launch date?", "Maya")).toBe("ignore");
    expect(transcriptRoute("manual", "What is the launch date?", "Maya")).toBe("manual");
    expect(transcriptRoute("automatic", "What is the launch date?", "Maya")).toBe("automatic");
  });

  it("accepts English Latin text and rejects non-Latin transcripts", () => {
    expect(isLatinScriptTranscript("What is the launch date?" )).toBe(true);
    expect(isLatinScriptTranscript("مرحبا، ما موعد الإطلاق؟")).toBe(false);
  });

  it("only returns an answer after a completed relevant-question decision", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("What is the launch date?", 1_000, false)).toBe(true);
    expect(gate.complete(parseAutomaticDecision('{"respond":true,"answer":"March 14."}'))).toBe("March 14.");
    expect(automaticDecisionPrompt()).toContain("Ignore greetings");
  });

  it("ignores irrelevant speech and duplicate completed transcript events", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("Good morning everyone.", 1_000, false)).toBe(true);
    expect(gate.complete(parseAutomaticDecision('{"respond":false}'))).toBeUndefined();
    expect(gate.begin("Good morning everyone.", 2_000, false)).toBe(false);
  });

  it("blocks automatic work while paused, including a pending decision", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("What is the launch date?", 1_000, false)).toBe(true);
    gate.pause();
    expect(gate.complete({ respond: true, answer: "March 14." })).toBeUndefined();
    expect(gate.begin("Another question?", 2_000, false)).toBe(false);
    gate.resume();
    expect(gate.begin("Another question?", 3_000, false)).toBe(true);
  });
});
