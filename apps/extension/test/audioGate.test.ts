import { describe, expect, it, vi } from "vitest";
import { ParticipantTranscriptGate, setAudioGate } from "../src/audioGate";

describe("setAudioGate", () => {
  it("closes the gate immediately and cancels scheduled automation", () => {
    const gain = { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() };

    setAudioGate(gain, false, 12.5);

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(12.5);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0, 12.5);
  });

  it("reopens the gate immediately", () => {
    const gain = { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() };

    setAudioGate(gain, true, 7);

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(7);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 7);
  });
});

describe("ParticipantTranscriptGate", () => {
  it("rejects transcripts while paused", () => {
    const gate = new ParticipantTranscriptGate();
    gate.pause();

    expect(gate.acceptsTranscript()).toBe(false);
  });

  it("ignores late transcripts after Resume until new speech starts", () => {
    const gate = new ParticipantTranscriptGate();
    gate.pause();
    gate.resume();

    expect(gate.acceptsTranscript()).toBe(false);
    gate.speechStarted();
    expect(gate.acceptsTranscript()).toBe(true);
  });
});
