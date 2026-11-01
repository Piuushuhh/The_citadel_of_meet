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
  /** Spoken name that triggers a reply in explicit-address mode. */
  wakeName: string;
  mode: "explicit" | "manual";
}

export interface StatusMsg {
  state: DelegateState;
  detail?: string;
  remoteAudioTracks: number;
  consentAt?: number;
  /** Audio-routing diagnostics (levels are 0..1 peak, decaying). */
  debug?: {
    acState?: string;
    pc?: string;
    dc?: string;
    mixPeak: number;
    tracks: { id: string; ready: string; muted: boolean; enabled: boolean; peak: number }[];
    inboundBytesSent?: number;
    /** Meet's own receive stats: proves whether voice reaches the browser at all. */
    meetInbound?: { packets: number; audioLevel: number; energy: number }[];
    allRemoteSeen: number;
  };
}

// popup/content -> page
export type Command =
  | { cmd: "start"; cfg: StartConfig; consentAt: number }
  | { cmd: "respond" }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "takeover" }
  | { cmd: "getStatus" };

// page -> content (window.postMessage envelope)
export type PageOut =
  | { kind: "status"; status: StatusMsg }
  | { kind: "transcript"; speaker: "participant" | "delegate"; text: string; ts: number }
  | { kind: "log"; text: string }
  | { kind: "rpc"; id: number; method: "mint" | "sdp"; params: unknown };

// content -> page
export type PageIn =
  | { kind: "command"; command: Command }
  | { kind: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string };

export interface MintResult {
  value: string;
  expires_at: number;
  model: string;
}

/** True when the transcript text addresses the delegate by its wake name. */
export function isAddressed(text: string, wakeName: string): boolean {
  const w = wakeName.trim().toLowerCase();
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}
