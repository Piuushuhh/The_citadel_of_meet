// Messages between the page-world script, the content script, the background worker, and the popup.

export const TAG = "standin-v1";

export type DelegateState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "paused"
  | "disconnected"
  | "needs-user";

export interface StartConfig {
  name: string;
  style?: string;
  /** Name(s) it answers to, comma-separated. Saying it always gets a reply; otherwise the AI decides. */
  wakeName: string;
}

export interface StatusMsg {
  state: DelegateState;
  /** Monotonic page-session status version, used to distinguish fresh Start feedback from cached status. */
  revision?: number;
  detail?: string;
  consentAt?: number;
  /** True while Meet's live captions (how the delegate hears the meeting) are on screen. */
  captions?: boolean;
  /** People in the meeting including you, from Meet's People badge. */
  participants?: number;
  debug?: {
    acState?: string;
    pc?: string;
    dc?: string;
  };
}

// popup/content -> page
export type Command =
  /** `memory` is filled in by the content script: what happened earlier in this meeting (restart recovery). */
  | { cmd: "start"; cfg: StartConfig; consentAt: number; memory?: string }
  | { cmd: "respond" }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "takeover" }
  | { cmd: "getStatus" }
  // Meeting memory (handled by the content script, never forwarded to the page):
  | { cmd: "getMemory" }
  | { cmd: "summarizeNow" }
  | { cmd: "setPromiseDone"; id: string; done: boolean }
  | { cmd: "forgetMeeting" };

/** Meeting memory as shown in the popup. */
export interface MemoryView {
  code?: string;
  summary?: string;
  lines: number;
  unsummarized: number;
  promises: { id: string; question?: string; reply: string; ts: number; done: boolean }[];
  summarizing: boolean;
  error?: string;
}

// page -> content (window.postMessage envelope)
export type PageOut =
  | { kind: "status"; status: StatusMsg }
  | { kind: "transcript"; speaker: "participant" | "delegate"; text: string; ts: number }
  | { kind: "log"; text: string }
  | { kind: "rpc"; id: number; method: "mint" | "decide"; params: unknown }
  /** Gemini Live socket control, relayed by the content script to the background worker. */
  | { kind: "live"; op: "open"; url: string; setup: unknown }
  | { kind: "live"; op: "send"; data: string }
  | { kind: "live"; op: "close" };

// content -> page
export type PageIn =
  | { kind: "command"; command: Command }
  /** New running notes for the live session (replaces the previous notes, older items are dropped). */
  | { kind: "memoryNotes"; text: string }
  | { kind: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
  | { kind: "liveEvent"; ev: "open" | "msg" | "close" | "error"; data?: string };

export interface MintResult {
  /** wss URL (with a one-use ephemeral token) and the first message to send on it. */
  url: string;
  setup: unknown;
  model: string;
}

/** True when the transcript text addresses the delegate by its wake name. */
export function isAddressed(text: string, wakeNames: string): boolean {
  // Several names may be given, comma-separated (speech-to-text often respells names).
  return wakeNames
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .some((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
    });
}
