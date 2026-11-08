// Experimental wake/question source: Google Meet's own live captions (free, Google speech recognition).
// Enabled per session with StartConfig.wakeSource = "captions". Remove this file and its call sites to drop it.
//
// Meet DOM (observed 2026-11-03): <div role="region" aria-label="Captions"> holds one block per speaker turn:
//   block > [ div(img avatar, span speaker name), div(caption text) ]
// Meet keeps appending to the last block while the same person keeps talking. Everything spoken through this
// browser's mic is labelled "You": that is both the user's own voice AND the delegate's voice (it is sent as
// the user's mic), so "You" captions are only ignored while the delegate is (or just was) speaking.

import { isAddressed } from "./protocol";

export const CAPTION_REGION_SELECTOR = '[role="region"][aria-label="Captions"]';
/** Speaker label Meet uses for this browser's own mic (English UI). */
export const SELF_LABEL = "You";
/** Wait this long after the caption text last changed, so the question is complete before replying. */
export const STABLE_MS = 1200;
/** Captions lag the audio; treat "You" captions as the delegate's for this long after it stops speaking. */
export const DELEGATE_ECHO_MS = 4000;

export interface CaptionBlock {
  speaker: string;
  text: string;
}

export interface CaptionUtterance {
  type: "utterance";
  speaker: string;
  /** The newly finished part of the caption (not previously reported). */
  text: string;
  /** True when it addresses the delegate by one of its wake names. */
  addressed: boolean;
}

/** Someone is speaking right now (their caption grew). Used to stop the delegate when it is interrupted. */
export interface CaptionActivity {
  type: "activity";
  speaker: string;
  /** Number of characters the caption grew by (0 for rewrites of earlier words). */
  grew: number;
}

export type CaptionEvent = CaptionUtterance | CaptionActivity;

/** Characters of new caption text from someone else, while the delegate talks, that count as an interruption. */
export const INTERRUPT_CHARS = 6;

/**
 * Explicit mode: reply when addressed by name, or, in a one-to-one meeting (2 people including you), to
 * anything the other person says: there is nobody else they could be talking to. Your own "You" speech still
 * needs the name.
 */
export function shouldReply(u: CaptionUtterance, participants: number | undefined): boolean {
  if (u.addressed) return true;
  return u.speaker !== SELF_LABEL && participants !== undefined && participants <= 2;
}

/**
 * People in the meeting (including you), from Meet's "People" badge; falls back to counting participant tiles.
 * Undefined when it cannot be determined.
 */
export function meetingParticipantCount(doc: Document): number | undefined {
  for (const b of Array.from(doc.querySelectorAll('button, [role="button"]'))) {
    const labelIds = (b.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const label = labelIds.map((id) => doc.getElementById(id)?.textContent?.trim()).join(" ");
    if (label !== "People") continue;
    const n = Number.parseInt((b as HTMLElement).innerText?.trim() ?? "", 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ids = new Set(Array.from(doc.querySelectorAll("[data-participant-id]")).map((e) => e.getAttribute("data-participant-id")));
  return ids.size > 0 ? ids.size : undefined;
}

/** Read caption blocks from the region. Blocks without an avatar image (e.g. "Jump to bottom") are skipped. */
export function readCaptionBlocks(region: Element): { el: Element; block: CaptionBlock }[] {
  const out: { el: Element; block: CaptionBlock }[] = [];
  for (const el of Array.from(region.children)) {
    if (!el.querySelector("img")) continue;
    const parts = Array.from(el.children);
    if (parts.length < 2) continue;
    const speaker = (parts[0] as HTMLElement).innerText?.trim() ?? "";
    const text = (parts[parts.length - 1] as HTMLElement).innerText?.trim() ?? "";
    if (speaker && text) out.push({ el, block: { speaker, text } });
  }
  return out;
}

interface Tracked {
  text: string;
  changedAt: number;
  /** Text length already handled; only speech after this point is reported. */
  consumed: number;
}

/** Pure decision logic: turns live-updating caption blocks into finished utterances. */
export class CaptionWakeTracker {
  private blocks = new Map<string | number, Tracked>();
  /** Most recent finished utterance from someone other than the delegate (used by the Respond button). */
  lastHeard: CaptionUtterance | undefined;

  constructor(private wakeNames: string) {}

  /**
   * Feed the current state of one caption block. Returns the newly finished part once it has been stable
   * for STABLE_MS, otherwise null. Each part of a block is reported at most once.
   * @param delegateSpeaking true while the delegate is talking or within DELEGATE_ECHO_MS after it stopped;
   *   "You" captions in that window are the delegate's own voice and are discarded.
   */
  update(id: string | number, block: CaptionBlock, now: number, delegateSpeaking = false): CaptionEvent | null {
    let t = this.blocks.get(id);
    const isNew = !t;
    if (!t) {
      t = { text: block.text, changedAt: now, consumed: 0 };
      this.blocks.set(id, t);
    }
    if (block.speaker === SELF_LABEL && delegateSpeaking) {
      // The delegate's own words: mark everything so far as handled, never react to it.
      t.text = block.text;
      t.consumed = block.text.length;
      t.changedAt = now;
      return null;
    }
    if (isNew) return { type: "activity", speaker: block.speaker, grew: block.text.length };
    if (t.text !== block.text) {
      const grew = Math.max(0, block.text.length - t.text.length);
      // Meet sometimes rewrites earlier words; if the text got shorter, start over for this block.
      if (block.text.length < t.consumed) t.consumed = 0;
      t.text = block.text;
      t.changedAt = now;
      return { type: "activity", speaker: block.speaker, grew };
    }
    if (now - t.changedAt < STABLE_MS) return null;
    const fresh = t.text.slice(t.consumed).trim();
    if (!fresh) return null;
    t.consumed = t.text.length;
    const u: CaptionUtterance = { type: "utterance", speaker: block.speaker, text: fresh, addressed: isAddressed(fresh, this.wakeNames) };
    this.lastHeard = u;
    return u;
  }

  reset(): void {
    this.blocks.clear();
    this.lastHeard = undefined;
  }
}
