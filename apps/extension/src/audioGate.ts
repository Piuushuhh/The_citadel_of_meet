export interface GainParamLike {
  cancelScheduledValues(time: number): void;
  setValueAtTime(value: number, time: number): unknown;
}

/** Change an audio gate immediately, removing any previously scheduled ramp. */
export function setAudioGate(gain: GainParamLike, open: boolean, currentTime: number): void {
  gain.cancelScheduledValues(currentTime);
  gain.setValueAtTime(open ? 1 : 0, currentTime);
}

/** Reject late transcription events across Pause until fresh post-Resume speech starts. */
export class ParticipantTranscriptGate {
  private paused = false;
  private needsFreshSpeech = false;

  pause(): void {
    this.paused = true;
    this.needsFreshSpeech = true;
  }

  resume(): void {
    this.paused = false;
  }

  reset(): void {
    this.paused = false;
    this.needsFreshSpeech = false;
  }

  speechStarted(): void {
    if (!this.paused) this.needsFreshSpeech = false;
  }

  acceptsTranscript(): boolean {
    return !this.paused && !this.needsFreshSpeech;
  }
}
