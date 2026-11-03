import { describe, expect, it } from "vitest";
import { CaptionWakeTracker, STABLE_MS } from "../src/captions";

const p = (text: string) => ({ speaker: "Priya", text });
const you = (text: string) => ({ speaker: "You", text });

describe("CaptionWakeTracker", () => {
  it("reports an addressed utterance once it has been stable", () => {
    const w = new CaptionWakeTracker("Sam");
    expect(w.update(1, p("Hi Sam, when is the launch?"), 0)).toBeNull();
    expect(w.update(1, p("Hi Sam, when is the launch?"), STABLE_MS - 1)).toBeNull();
    expect(w.update(1, p("Hi Sam, when is the launch?"), STABLE_MS)).toEqual({
      speaker: "Priya",
      text: "Hi Sam, when is the launch?",
      addressed: true,
    });
  });

  it("waits while the speaker is still talking", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam"), 0);
    expect(w.update(1, p("Hi Sam, when is"), 1000)).toBeNull();
    expect(w.update(1, p("Hi Sam, when is"), 1000 + STABLE_MS - 1)).toBeNull();
    expect(w.update(1, p("Hi Sam, when is"), 1000 + STABLE_MS)?.text).toBe("Hi Sam, when is");
  });

  it("does not report the same words twice", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam"), 0);
    expect(w.update(1, p("Hi Sam"), STABLE_MS)?.addressed).toBe(true);
    expect(w.update(1, p("Hi Sam"), STABLE_MS * 3)).toBeNull();
  });

  it("reports new speech appended to the same block", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam."), 0);
    w.update(1, p("Hi Sam."), STABLE_MS);
    w.update(1, p("Hi Sam. Thanks. Sam, one more thing?"), STABLE_MS + 10);
    expect(w.update(1, p("Hi Sam. Thanks. Sam, one more thing?"), STABLE_MS * 3)?.text).toBe("Thanks. Sam, one more thing?");
  });

  it("reports utterances that do not address the delegate as not addressed", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Samantha will present next"), 0);
    expect(w.update(1, p("Samantha will present next"), STABLE_MS)).toEqual({
      speaker: "Priya",
      text: "Samantha will present next",
      addressed: false,
    });
  });

  it("ignores the delegate's own voice (\"You\" while the delegate is speaking)", () => {
    const w = new CaptionWakeTracker("Sam");
    const intro = you("Hello, I'm an AI delegate for Sam.");
    w.update(1, intro, 0, true);
    expect(w.update(1, intro, STABLE_MS * 2, true)).toBeNull();
    // Still nothing once the delegate has stopped: those words were already discarded.
    expect(w.update(1, intro, STABLE_MS * 4, false)).toBeNull();
  });

  it("accepts the user's own speech (\"You\" while the delegate is quiet), after its intro", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, you("Hello, I'm an AI delegate for Sam."), 0, true);
    w.update(1, you("Hello, I'm an AI delegate for Sam. Hi Sam, when is the launch?"), 10000, false);
    expect(w.update(1, you("Hello, I'm an AI delegate for Sam. Hi Sam, when is the launch?"), 10000 + STABLE_MS, false)).toEqual({
      speaker: "You",
      text: "Hi Sam, when is the launch?",
      addressed: true,
    });
  });

  it("remembers the last thing heard for the Respond button", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("What is the budget?"), 0);
    w.update(1, p("What is the budget?"), STABLE_MS);
    expect(w.lastHeard?.text).toBe("What is the budget?");
  });

  it("tracks separate speaker blocks independently", () => {
    const w = new CaptionWakeTracker("Sam, Sambhram");
    w.update(1, p("Good morning"), 0);
    w.update(2, { speaker: "Ravi", text: "Sambhram, any update?" }, 0);
    expect(w.update(1, p("Good morning"), STABLE_MS)?.addressed).toBe(false);
    expect(w.update(2, { speaker: "Ravi", text: "Sambhram, any update?" }, STABLE_MS)?.addressed).toBe(true);
  });
});
