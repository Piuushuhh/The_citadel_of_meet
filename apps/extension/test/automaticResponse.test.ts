import { describe, expect, it } from "vitest";
import {
  AutomaticResponseGate,
  automaticDecisionInput,
  automaticDecisionPrompt,
  parseAutomaticDecision,
} from "../src/automaticResponse";

describe("automatic reply decision", () => {
  it("replies only after a completed relevant-question decision", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("What is the launch date?", 1_000, false)).toBe(true);
    expect(gate.complete(parseAutomaticDecision('{"respond":true}'))).toBe(true);
  });

  it("only decides; it never writes the answer (the reply keeps identity and context)", () => {
    const prompt = automaticDecisionPrompt();
    expect(prompt).toContain("You do NOT write the reply");
    expect(prompt).toContain("who or what it is");
    expect(prompt).toContain("follow-ups");
    expect(prompt).not.toContain('"answer"');
  });

  it("gives the decision recent meeting history", () => {
    const input = JSON.parse(automaticDecisionInput(["Priya: When is the launch?", "Delegate: March 14."], "And the budget?"));
    expect(input.recent_meeting).toEqual(["Priya: When is the launch?", "Delegate: March 14."]);
    expect(input.latest).toBe("And the budget?");
    expect(JSON.parse(automaticDecisionInput(Array.from({ length: 30 }, (_, i) => `l${i}`), "x")).recent_meeting).toHaveLength(12);
  });

  it("parses decisions and fails closed on anything else", () => {
    expect(parseAutomaticDecision('{"respond":true}')).toEqual({ respond: true });
    // Wrappers the Realtime model actually produced in a live test:
    expect(parseAutomaticDecision('```json\n{"respond":false}\n```')).toEqual({ respond: false });
    expect(parseAutomaticDecision('<edit><{"respond":true}></edit>')).toEqual({ respond: true });
    expect(parseAutomaticDecision('={"respond":false}')).toEqual({ respond: false });
    expect(parseAutomaticDecision('>{"respond":true}')).toEqual({ respond: true });
    expect(parseAutomaticDecision("sure!")).toBeUndefined();
    expect(parseAutomaticDecision('{"respond":"yes"}')).toBeUndefined();
    expect(parseAutomaticDecision('{"respond":true} {"respond":false}')).toBeUndefined();
  });

  it("ignores irrelevant speech and duplicate completed transcript events", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("Good morning everyone.", 1_000, false)).toBe(true);
    expect(gate.complete(parseAutomaticDecision('{"respond":false}'))).toBe(false);
    expect(gate.begin("Good morning everyone.", 2_000, false)).toBe(false);
  });

  it("blocks automatic work while paused, including a pending decision", () => {
    const gate = new AutomaticResponseGate();
    expect(gate.begin("What is the launch date?", 1_000, false)).toBe(true);
    gate.pause();
    expect(gate.complete({ respond: true })).toBe(false);
    expect(gate.begin("Another question?", 2_000, false)).toBe(false);
    gate.resume();
    expect(gate.begin("Another question?", 3_000, false)).toBe(true);
  });
});
