import { describe, expect, it } from "vitest";
import { CaptionWakeTracker, STABLE_MS, shouldReply, type CaptionEvent, type CaptionUtterance } from "../src/captions";

const p = (text: string) => ({ speaker: "Priya", text });
const you = (text: string) => ({ speaker: "You", text });
/** Only finished utterances (ignore "activity" events). */
const utt = (e: CaptionEvent | null) => (e?.type === "utterance" ? e : null);

describe("CaptionWakeTracker utterances", () => {
  it("reports an addressed utterance once it has been stable", () => {
    const w = new CaptionWakeTracker("Sam");
    expect(utt(w.update(1, p("Hi Sam, when is the launch?"), 0))).toBeNull();
    expect(w.update(1, p("Hi Sam, when is the launch?"), STABLE_MS - 1)).toBeNull();
    expect(w.update(1, p("Hi Sam, when is the launch?"), STABLE_MS)).toEqual({
      type: "utterance",
      speaker: "Priya",
      text: "Hi Sam, when is the launch?",
      addressed: true,
    });
  });

  it("waits while the speaker is still talking", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam"), 0);
    expect(utt(w.update(1, p("Hi Sam, when is"), 1000))).toBeNull();
    expect(w.update(1, p("Hi Sam, when is"), 1000 + STABLE_MS - 1)).toBeNull();
    expect(utt(w.update(1, p("Hi Sam, when is"), 1000 + STABLE_MS))?.text).toBe("Hi Sam, when is");
  });

  it("does not report the same words twice", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam"), 0);
    expect(utt(w.update(1, p("Hi Sam"), STABLE_MS))?.addressed).toBe(true);
    expect(w.update(1, p("Hi Sam"), STABLE_MS * 3)).toBeNull();
  });

  it("reports new speech appended to the same block", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Hi Sam."), 0);
    w.update(1, p("Hi Sam."), STABLE_MS);
    w.update(1, p("Hi Sam. Thanks. Sam, one more thing?"), STABLE_MS + 10);
    expect(utt(w.update(1, p("Hi Sam. Thanks. Sam, one more thing?"), STABLE_MS * 3))?.text).toBe("Thanks. Sam, one more thing?");
  });

  it("reports utterances that do not address the delegate as not addressed", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("Samantha will present next"), 0);
    expect(utt(w.update(1, p("Samantha will present next"), STABLE_MS))?.addressed).toBe(false);
  });

  it("ignores the delegate's own voice (\"You\" while the delegate is speaking)", () => {
    const w = new CaptionWakeTracker("Sam");
    const intro = you("Hello, I'm an AI delegate for Sam.");
    expect(w.update(1, intro, 0, true)).toBeNull();
    expect(w.update(1, intro, STABLE_MS * 2, true)).toBeNull();
    // Still nothing once the delegate has stopped: those words were already discarded.
    expect(w.update(1, intro, STABLE_MS * 4, false)).toBeNull();
  });

  it("accepts the user's own speech (\"You\" while the delegate is quiet), after its intro", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, you("Hello, I'm an AI delegate for Sam."), 0, true);
    w.update(1, you("Hello, I'm an AI delegate for Sam. Hi Sam, when is the launch?"), 10000, false);
    expect(utt(w.update(1, you("Hello, I'm an AI delegate for Sam. Hi Sam, when is the launch?"), 10000 + STABLE_MS, false))).toEqual({
      type: "utterance",
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
    expect(utt(w.update(1, p("Good morning"), STABLE_MS))?.addressed).toBe(false);
    expect(utt(w.update(2, { speaker: "Ravi", text: "Sambhram, any update?" }, STABLE_MS))?.addressed).toBe(true);
  });
});

describe("CaptionWakeTracker activity (interruption signal)", () => {
  it("reports how much a caption grew while someone is talking", () => {
    const w = new CaptionWakeTracker("Sam");
    expect(w.update(1, p("Wait"), 0)).toEqual({ type: "activity", speaker: "Priya", grew: 4 });
    expect(w.update(1, p("Wait, stop there"), 300)).toEqual({ type: "activity", speaker: "Priya", grew: 12 });
  });

  it("reports rewrites of earlier words as zero growth", () => {
    const w = new CaptionWakeTracker("Sam");
    w.update(1, p("when is the lunch"), 0);
    expect(w.update(1, p("when is the launch"), 300)).toEqual({ type: "activity", speaker: "Priya", grew: 1 });
    expect(w.update(1, p("When is the launch"), 600)).toEqual({ type: "activity", speaker: "Priya", grew: 0 });
  });

  it("never reports the delegate's own voice as activity", () => {
    const w = new CaptionWakeTracker("Sam");
    expect(w.update(1, you("Hello, I'm an AI delegate"), 0, true)).toBeNull();
    expect(w.update(1, you("Hello, I'm an AI delegate for Sam"), 300, true)).toBeNull();
  });
});

describe("shouldReply", () => {
  const u = (speaker: string, addressed: boolean): CaptionUtterance => ({ type: "utterance", speaker, text: "x", addressed });

  it("replies when addressed by name, whatever the meeting size", () => {
    expect(shouldReply(u("Priya", true), 8)).toBe(true);
    expect(shouldReply(u("You", true), 8)).toBe(true);
  });

  it("replies to the other person without the name in a one-to-one meeting", () => {
    expect(shouldReply(u("Priya", false), 2)).toBe(true);
  });

  it("needs the name when more people are present", () => {
    expect(shouldReply(u("Priya", false), 3)).toBe(false);
  });

  it("needs the name when the meeting size is unknown", () => {
    expect(shouldReply(u("Priya", false), undefined)).toBe(false);
  });

  it("still needs the name for your own speech in a one-to-one meeting", () => {
    expect(shouldReply(u("You", false), 2)).toBe(false);
  });
});
