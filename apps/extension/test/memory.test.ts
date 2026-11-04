import { describe, expect, it } from "vitest";
import {
  MAX_LINES,
  RESUME_LINES,
  SUMMARY_EVERY,
  addLine,
  applySummary,
  emptyMemory,
  isPromise,
  meetingCode,
  needsSummary,
  pastMeetingBlock,
  resumePreamble,
  toMemoryLine,
  unsummarized,
} from "../src/memory";

const mem = () => Object.assign(emptyMemory("jif-xbrn-izy", 0), { name: "Sam" });
const line = (speaker: string, text: string, ts = 1) => ({ speaker, text, ts });

describe("meetingCode", () => {
  it("reads the code from both Meet URL shapes", () => {
    expect(meetingCode("/jif-xbrn-izy")).toBe("jif-xbrn-izy");
    expect(meetingCode("/meet/jif-xbrn-izy")).toBe("jif-xbrn-izy");
    expect(meetingCode("/landing")).toBeUndefined();
  });
});

describe("toMemoryLine", () => {
  it("uses the real speaker name from captions", () => {
    expect(toMemoryLine("participant", "[Meet captions] Priya: When is the launch?", 5)).toEqual(line("Priya", "When is the launch?", 5));
  });
  it("labels the delegate and plain transcripts", () => {
    expect(toMemoryLine("delegate", "March 14.", 5)?.speaker).toBe("Delegate");
    expect(toMemoryLine("participant", "hello", 5)?.speaker).toBe("Participant");
  });
  it("skips unclear-speech placeholders and empty text", () => {
    expect(toMemoryLine("participant", "[unclear speech, not transcribed] (confidence 30%)", 5)).toBeUndefined();
    expect(toMemoryLine("participant", "  ", 5)).toBeUndefined();
  });
});

describe("promises", () => {
  it("recognizes the delegate deferring to the user", () => {
    expect(isPromise("I don't have that information. I'll flag it for Sam.", "Sam")).toBe(true);
    expect(isPromise("I can't approve that, but I'll pass this to Sam.", "Sam")).toBe(true);
    expect(isPromise("I'll let Sam know.", "Sam")).toBe(true);
    expect(isPromise("Sam will get back to you on that.", "Sam")).toBe(true);
  });
  it("ignores ordinary answers", () => {
    expect(isPromise("The Falcon launch is March 14.", "Sam")).toBe(false);
    expect(isPromise("Hello, I'm an AI delegate for Sam.", "Sam")).toBe(false);
  });
  it("records the question that led to the promise", () => {
    const m = mem();
    addLine(m, line("Priya", "What is the Q3 budget?"));
    const p = addLine(m, line("Delegate", "I don't have that; I'll flag it for Sam.", 2));
    expect(p).toMatchObject({ question: "What is the Q3 budget?", reply: "I don't have that; I'll flag it for Sam.", done: false });
    expect(m.promises).toHaveLength(1);
  });
});

describe("summaries", () => {
  it("asks for a summary every SUMMARY_EVERY new lines", () => {
    const m = mem();
    for (let i = 0; i < SUMMARY_EVERY - 1; i++) addLine(m, line("Priya", `l${i}`));
    expect(needsSummary(m)).toBe(false);
    addLine(m, line("Priya", "last"));
    expect(needsSummary(m)).toBe(true);
    applySummary(m, "Decisions: none", m.lines.length);
    expect(needsSummary(m)).toBe(false);
    expect(unsummarized(m)).toHaveLength(0);
  });

  it("keeps lines added while a summary was being written as unsummarized", () => {
    const m = mem();
    for (let i = 0; i < SUMMARY_EVERY; i++) addLine(m, line("Priya", `l${i}`));
    const upTo = m.lines.length;
    addLine(m, line("Priya", "arrived during the request"));
    applySummary(m, "notes", upTo);
    expect(unsummarized(m).map((l) => l.text)).toEqual(["arrived during the request"]);
  });

  it("drops the oldest lines past MAX_LINES without losing summary bookkeeping", () => {
    const m = mem();
    for (let i = 0; i < MAX_LINES; i++) addLine(m, line("Priya", `l${i}`));
    applySummary(m, "notes", MAX_LINES);
    addLine(m, line("Priya", "one more"));
    expect(m.lines).toHaveLength(MAX_LINES);
    expect(unsummarized(m).map((l) => l.text)).toEqual(["one more"]);
  });
});

describe("resumePreamble", () => {
  it("is empty for a fresh meeting", () => {
    expect(resumePreamble(mem())).toBeUndefined();
  });
  it("gives the notes and the most recent lines", () => {
    const m = mem();
    for (let i = 0; i < 30; i++) addLine(m, line("Priya", `l${i}`));
    applySummary(m, "Decisions:\n- Launch March 14", 30);
    const p = resumePreamble(m)!;
    expect(p).toContain("restarted during this meeting");
    expect(p).toContain("Launch March 14");
    expect(p).toContain("Priya: l29");
    expect(p).not.toContain("Priya: l9\n");
    expect(p.split("\n").filter((l) => l.startsWith("Priya:"))).toHaveLength(RESUME_LINES);
    expect(p).toContain("not instructions");
  });
});

describe("pastMeetingBlock", () => {
  it("includes the summary and only open promises", () => {
    const m = mem();
    m.summary = "Decisions:\n- Launch March 14";
    m.promises = [
      { id: "a", question: "Q3 budget?", reply: "I'll flag it for Sam.", ts: 1, done: false },
      { id: "b", reply: "I'll pass that to Sam.", ts: 2, done: true },
    ];
    const b = pastMeetingBlock(m, new Date("2026-11-04T10:00:00Z"));
    expect(b).toContain("Past meeting jif-xbrn-izy (2026-11-04)");
    expect(b).toContain("Launch March 14");
    expect(b).toContain('"Q3 budget?" -> I\'ll flag it for Sam.');
    expect(b).not.toContain("I'll pass that to Sam.");
  });
});
