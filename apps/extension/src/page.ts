// Page-world script (runs inside meet.google.com's JS context at document_start).
//
// Passive until the user explicitly presses Start:
//  - wraps getUserMedia so the mic Meet receives is a switchable Web Audio mix
//    (real mic by default; real mic muted + delegate voice while the delegate is active)
//  - records (but does not read) incoming remote audio tracks
// Nothing is sent anywhere before Start.

import {
  TAG,
  isAddressed,
  type Command,
  type DelegateState,
  type MintResult,
  type PageIn,
  type PageOut,
  type StartConfig,
} from "./protocol";

// ---------- messaging ----------
const send = (msg: PageOut) => window.postMessage({ tag: TAG, dir: "to-content", msg }, window.location.origin);
const log = (text: string) => {
  console.debug("[Stand-In]", text);
  send({ kind: "log", text });
};

let rpcId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc<T>(method: "mint" | "sdp", params: unknown): Promise<T> {
  const id = ++rpcId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ kind: "rpc", id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15000);
  });
}

// ---------- audio graph (created lazily) ----------
let ac: AudioContext | undefined;
let outDest: MediaStreamAudioDestinationNode;
let realGain: GainNode; // user's real microphone
let delegateGain: GainNode; // delegate's synthetic voice

function ensureAudio(): AudioContext {
  if (!ac) {
    ac = new AudioContext();
    outDest = ac.createMediaStreamDestination();
    realGain = ac.createGain();
    delegateGain = ac.createGain();
    delegateGain.gain.value = 0;
    realGain.connect(outDest);
    delegateGain.connect(outDest);
  }
  if (ac.state === "suspended") void ac.resume().catch(() => undefined);
  return ac;
}

// ---------- getUserMedia wrapper ----------
const md = navigator.mediaDevices;
if (md?.getUserMedia) {
  const origGUM = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await origGUM(constraints);
    if (!constraints?.audio || stream.getAudioTracks().length === 0) return stream;
    const ctx = ensureAudio();
    ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(realGain);
    // Return a clone so Meet stopping it never kills our shared destination track.
    const outTrack = outDest.stream.getAudioTracks()[0].clone();
    return new MediaStream([outTrack, ...stream.getVideoTracks()]);
  };
}

// ---------- remote (incoming) audio tracks: record only ----------
const remoteTracks = new Set<MediaStreamTrack>();
const OrigPC = window.RTCPeerConnection;
class HookedPC extends OrigPC {
  constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
    super(...args);
    this.addEventListener("track", (e) => {
      if (e.track.kind !== "audio") return;
      remoteTracks.add(e.track);
      e.track.addEventListener("ended", () => remoteTracks.delete(e.track));
      if (session) attachRemote(e.track);
      emitStatus();
    });
  }
}
window.RTCPeerConnection = HookedPC as unknown as typeof RTCPeerConnection;

// ---------- delegate session ----------
interface Session {
  cfg: StartConfig;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  inDest: MediaStreamAudioDestinationNode;
  sources: Map<MediaStreamTrack, MediaStreamAudioSourceNode>;
  audioEl: HTMLAudioElement;
  consentAt: number;
}
let session: Session | undefined;
let state: DelegateState = "idle";
let detail: string | undefined;
let paused = false;
let responding = false; // a response is in flight or audio is playing
let consentAt: number | undefined;

function setState(s: DelegateState, d?: string) {
  state = s;
  detail = d;
  emitStatus();
}

function liveRemote(): MediaStreamTrack[] {
  return [...remoteTracks].filter((t) => t.readyState === "live");
}

function emitStatus() {
  // Never claim "listening" unless the peer is up AND meeting audio is actually reaching it.
  let s = state;
  let d = detail;
  if (session && (s === "listening" || s === "thinking" || s === "speaking")) {
    if (session.pc.connectionState !== "connected") {
      s = "disconnected";
      d = "Voice connection is not connected";
    } else if (session.sources.size === 0) {
      s = "needs-user";
      d = "No meeting audio is being captured (is anyone else in the call speaking/unmuted?)";
    }
  }
  send({ kind: "status", status: { state: s, detail: d, remoteAudioTracks: session?.sources.size ?? 0, consentAt } });
}

function attachRemote(track: MediaStreamTrack) {
  if (!session || session.sources.has(track) || track.readyState !== "live") return;
  const ctx = ensureAudio();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  src.connect(session.inDest);
  session.sources.set(track, src);
  track.addEventListener("ended", () => {
    session?.sources.get(track)?.disconnect();
    session?.sources.delete(track);
    emitStatus();
  });
}

function sendEvent(ev: unknown) {
  if (session?.dc.readyState === "open") session.dc.send(JSON.stringify(ev));
}

/** Immediately silence output and cancel anything pending. Idempotent. */
function cancelSpeech() {
  if (ac) {
    delegateGain.gain.cancelScheduledValues(ac.currentTime);
    delegateGain.gain.setValueAtTime(0, ac.currentTime); // hard cut, no ramp
  }
  sendEvent({ type: "response.cancel" });
  sendEvent({ type: "output_audio_buffer.clear" });
  responding = false;
}

function enableDelegateVoice() {
  if (!ac) return;
  realGain.gain.setValueAtTime(0, ac.currentTime); // user's real mic off while the delegate is active
  delegateGain.gain.setValueAtTime(1, ac.currentTime);
}

function restoreRealMic() {
  if (!ac) return;
  delegateGain.gain.cancelScheduledValues(ac.currentTime);
  delegateGain.gain.setValueAtTime(0, ac.currentTime);
  realGain.gain.setValueAtTime(1, ac.currentTime);
}

function requestResponse(instructions?: string) {
  if (!session || paused || responding) return;
  responding = true;
  enableDelegateVoice();
  setState("thinking");
  sendEvent({ type: "response.create", ...(instructions ? { response: { instructions } } : {}) });
}

function onEvent(raw: string) {
  let ev: { type?: string; transcript?: string; error?: { message?: string } };
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  const t = ev.type ?? "";
  // Log every event type during M1 so the live check can confirm names.
  if (!t.endsWith(".delta")) log(`event ${t}`);

  if (t === "input_audio_buffer.speech_started") {
    // Someone started talking: if the delegate is mid-speech, stop it now (interruption).
    if (state === "speaking" || state === "thinking") {
      cancelSpeech();
      if (!paused) setState("listening");
    }
  } else if (t === "conversation.item.input_audio_transcription.completed" && ev.transcript) {
    const text = ev.transcript.trim();
    if (text) {
      send({ kind: "transcript", speaker: "participant", text, ts: Date.now() });
      if (session?.cfg.mode === "explicit" && isAddressed(text, session.cfg.wakeName)) requestResponse();
    }
  } else if (t === "response.created") {
    if (!paused) setState("thinking");
  } else if (t === "output_audio_buffer.started") {
    if (responding) setState("speaking");
  } else if (t === "output_audio_buffer.stopped" || t === "output_audio_buffer.cleared") {
    responding = false;
    if (!paused) {
      // Hand the mic back as soon as the delegate finishes so the user is not stuck muted.
      setState("listening");
    }
  } else if (t === "response.output_audio_transcript.done" && ev.transcript) {
    send({ kind: "transcript", speaker: "delegate", text: ev.transcript, ts: Date.now() });
  } else if (t === "response.done") {
    // Audio may still be playing out; state flips on output_audio_buffer.stopped.
  } else if (t === "error") {
    log(`realtime error: ${ev.error?.message ?? "unknown"}`);
    setState("needs-user", ev.error?.message ?? "Voice service error");
  }
}

async function startSession(cfg: StartConfig, consent: number) {
  if (session) return;
  if (!consent) {
    setState("needs-user", "Consent to AI participation and transcription is required");
    return;
  }
  consentAt = consent;
  paused = false;
  setState("connecting");
  try {
    const ctx = ensureAudio();
    const minted = await rpc<MintResult>("mint", { name: cfg.name, style: cfg.style });
    // MUST be the original class: the hooked one would record the delegate's own voice as "meeting audio" (feedback loop).
    const pc = new OrigPC();
    const inDest = ctx.createMediaStreamDestination();
    const audioEl = new Audio();
    audioEl.muted = true; // Chrome only pumps remote WebRTC audio into Web Audio if it is also attached to an element
    const dc = pc.createDataChannel("oai-events");
    session = { cfg, pc, dc, inDest, sources: new Map(), audioEl, consentAt: consent };

    pc.addTrack(inDest.stream.getAudioTracks()[0], inDest.stream);
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      ctx.createMediaStreamSource(e.streams[0]).connect(delegateGain);
    };
    dc.onmessage = (e) => onEvent(String(e.data));
    dc.onopen = () => {
      log("data channel open");
      // Introduce the delegate (disclosure) before anything else.
      requestResponse(
        `Say exactly this, nothing more: "Hello, I'm an AI delegate for ${cfg.name}. I'm here on their behalf, and this meeting may be transcribed."`,
      );
    };
    pc.onconnectionstatechange = () => {
      log(`pc ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        cancelSpeech();
        restoreRealMic();
        setState("disconnected", "Voice connection lost; your real microphone is active again");
      } else emitStatus();
    };

    for (const t of liveRemote()) attachRemote(t);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await rpc<string>("sdp", { offer: offer.sdp, secret: minted.value, model: minted.model });
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    setState("listening");
  } catch (e) {
    log(`start failed: ${(e as Error).message}`);
    teardown();
    setState("needs-user", `Could not start: ${(e as Error).message}`);
  }
}

function teardown() {
  cancelSpeech();
  restoreRealMic();
  if (session) {
    session.sources.forEach((s) => s.disconnect());
    try {
      session.dc.close();
      session.pc.close();
    } catch {
      /* ignore */
    }
    session.audioEl.srcObject = null;
    session = undefined;
  }
  responding = false;
}

function handle(cmd: Command) {
  switch (cmd.cmd) {
    case "start":
      void startSession(cmd.cfg, cmd.consentAt);
      break;
    case "respond":
      if (session) {
        paused = false;
        requestResponse();
      }
      break;
    case "pause":
      if (session) {
        paused = true;
        cancelSpeech();
        restoreRealMic();
        setState("paused");
      }
      break;
    case "resume":
      if (session) {
        paused = false;
        setState("listening");
      }
      break;
    case "takeover":
      teardown();
      setState("idle", "You have taken over; the delegate is stopped");
      break;
    case "getStatus":
      emitStatus();
      break;
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.tag !== TAG || e.data.dir !== "to-page") return;
  const msg = e.data.msg as PageIn;
  if (msg.kind === "command") handle(msg.command);
  else if (msg.kind === "rpcResult") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "rpc failed"));
  }
});

emitStatus();
