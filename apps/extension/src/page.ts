// Page-world script (runs inside meet.google.com's JS context at document_start).
//
// How the delegate hears: Google Meet's own live captions (captions.ts). Every finished caption line goes into
// the Gemini Live conversation as text; no meeting audio is sent to Gemini.
// How the delegate speaks: getUserMedia is wrapped so the mic Meet receives is a switchable Web Audio mix
// (your real mic normally; the delegate's voice while it talks).
// When it replies (always automatic): when its name is said, in a one-to-one meeting, on a follow-up from the
// person it just answered, or when an AI decision says the line is meant for it.
// Passive until the user presses Start. Nothing is sent anywhere before Start.

import { TAG, type Command, type DelegateState, type MintResult, type PageIn, type PageOut, type StartConfig } from "./protocol";
import {
  CAPTION_REGION_SELECTOR,
  CaptionWakeTracker,
  DELEGATE_ECHO_MS,
  INTERRUPT_CHARS,
  SELF_LABEL,
  meetingParticipantCount,
  readCaptionBlocks,
  shouldReply,
} from "./captions";
import { AutomaticResponseGate, automaticDecisionInput, automaticDecisionPrompt, parseAutomaticDecision, type AutomaticDecision } from "./automaticResponse";

// ---------- messaging ----------
/** Recent meeting lines (participants and the delegate), given to the automatic reply decision. */
const recentMeetingLines: string[] = [];
const send = (msg: PageOut) => {
  if (msg.kind === "transcript") {
    recentMeetingLines.push(msg.speaker === "delegate" ? `Delegate: ${msg.text}` : msg.text.replace(/^\[Meet captions\]\s*/, ""));
    if (recentMeetingLines.length > 30) recentMeetingLines.shift();
  }
  window.postMessage({ tag: TAG, dir: "to-content", msg }, window.location.origin);
};
const log = (text: string) => {
  console.debug("[Stand-In]", text);
  send({ kind: "log", text });
};

let rpcId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc<T>(method: "mint" | "decide", params: unknown): Promise<T> {
  const id = ++rpcId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ kind: "rpc", id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15000);
  });
}

// ---------- outgoing audio: your mic, or the delegate's voice ----------
let ac: AudioContext | undefined;
let outDest: MediaStreamAudioDestinationNode;
let realGain: GainNode; // your real microphone
let delegateGain: GainNode; // the delegate's synthetic voice

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

function enableDelegateVoice() {
  if (!ac) return;
  realGain.gain.setValueAtTime(0, ac.currentTime); // your real mic is off while the delegate talks
  delegateGain.gain.setValueAtTime(1, ac.currentTime);
}

function restoreRealMic() {
  if (!ac) return;
  delegateGain.gain.cancelScheduledValues(ac.currentTime);
  delegateGain.gain.setValueAtTime(0, ac.currentTime);
  realGain.gain.setValueAtTime(1, ac.currentTime);
}

// ---------- session state ----------
interface Session {
  cfg: StartConfig;
  consentAt: number;
  /** Socket to Gemini is open (relayed through the background worker). */
  open: boolean;
  /** Gemini accepted the setup message; replies can be requested. */
  ready: boolean;
}
let session: Session | undefined;
let state: DelegateState = "idle";
let detail: string | undefined;
let paused = false;
let responding = false; // a reply is in flight or its audio is playing
let consentAt: number | undefined;
let startAttempt = 0;
let statusRevision = 0;
const automaticResponseGate = new AutomaticResponseGate();
let decisionSeq = 0;
let automaticAnswerTimer: ReturnType<typeof setTimeout> | undefined;
let introduced = false;
let reconnects = 0;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
/** Right after Start, Meet needs a moment to show captions; do not call them "off" before then. */
let captionsGraceUntil = 0;

function setState(s: DelegateState, d?: string) {
  state = s;
  detail = d;
  emitStatus();
}

function emitStatus() {
  let s = state;
  let d = detail;
  const captions = !!document.querySelector(CAPTION_REGION_SELECTOR);
  if (session && (s === "listening" || s === "thinking" || s === "speaking")) {
    if (!session.open || !session.ready) {
      s = "connecting";
      d = "Connecting to the Gemini voice session";
    } else if (!captions && Date.now() > captionsGraceUntil) {
      s = "needs-user";
      d = "Meet captions are off, so the delegate cannot hear anyone. Turn on captions (CC).";
    }
  }
  const debug = session ? { acState: ac?.state, pc: session.ready ? "ready" : "not-ready", dc: session.open ? "open" : "closed" } : undefined;
  const participants = session ? meetingParticipantCount(document) : undefined;
  send({ kind: "status", status: { state: s, revision: ++statusRevision, detail: d, consentAt, captions, participants, debug } });
}

function sendLive(obj: unknown) {
  if (session?.open) send({ kind: "live", op: "send", data: JSON.stringify(obj) });
}

// ---------- what Gemini has not been told yet ----------
/** Caption lines since the last reply request; sent together with the next one. */
let pendingTurns: string[] = [];
/** Latest running meeting notes (replaces older notes); sent with the next reply request. */
let pendingNotes: string | undefined;

// ---------- playing the delegate's voice (24 kHz 16-bit PCM from Gemini) ----------
const sources = new Set<AudioBufferSourceNode>();
let playHead = 0;
let turnDone = false;
let staleTurn = false; // a cancelled turn may still stream audio; drop it until it ends
let staleTimer: ReturnType<typeof setTimeout> | undefined;
let delegateText = "";

function playChunk(b64: string) {
  const ctx = ensureAudio();
  const bin = atob(b64);
  const n = bin.length >> 1;
  const buf = ctx.createBuffer(1, n, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    ch[i] = (v > 32767 ? v - 65536 : v) / 32768;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(delegateGain);
  const at = Math.max(ctx.currentTime + 0.05, playHead);
  src.start(at);
  playHead = at + buf.duration;
  sources.add(src);
  src.onended = () => {
    sources.delete(src);
    if (turnDone && sources.size === 0) finishSpeaking();
  };
}

/** The reply has been fully played (or nothing was played): hand the mic back. */
function finishSpeaking() {
  turnDone = false;
  if (!responding) return;
  responding = false;
  restoreRealMic();
  if (!paused) setState("listening");
}

function stopAudio() {
  for (const s of sources) {
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  playHead = 0;
}

// ---------- replies ----------
/** Immediately silence output and cancel anything pending. Idempotent. */
function cancelSpeech() {
  clearAutomaticDecision();
  if (automaticAnswerTimer) clearTimeout(automaticAnswerTimer);
  automaticAnswerTimer = undefined;
  if (ac) {
    delegateGain.gain.cancelScheduledValues(ac.currentTime);
    delegateGain.gain.setValueAtTime(0, ac.currentTime); // hard cut, no ramp
  }
  stopAudio();
  if (responding) {
    // Gemini may keep streaming this turn: ignore it until it ends (or a few seconds pass).
    staleTurn = true;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => (staleTurn = false), 5000);
  }
  turnDone = false;
  delegateText = "";
  responding = false;
}

/**
 * Speak a reply: send the captions heard since the last reply (and the latest notes) as one user turn and
 * let Gemini answer. Without `instructions` the session's own instructions apply (identity, rules, knowledge).
 */
function requestResponse(instructions?: string) {
  if (!session || paused || responding || !session.ready) return;
  responding = true;
  turnDone = false;
  delegateText = "";
  enableDelegateVoice();
  setState("thinking");
  const lines: string[] = [];
  if (pendingNotes) lines.push(pendingNotes);
  lines.push(...pendingTurns);
  pendingNotes = undefined;
  pendingTurns = [];
  lines.push(instructions ? `[Instruction] ${instructions}` : "[Instruction] Reply now, speaking to the person who most recently addressed you.");
  sendLive({ clientContent: { turns: [{ role: "user", parts: [{ text: lines.join("\n") }] }], turnComplete: true } });
}

function clearAutomaticDecision() {
  automaticResponseGate.cancel();
  decisionSeq++;
}

/** Ask Gemini (text only, via the local backend) whether this line is meant for the delegate. */
function startAutomaticDecision(line: string) {
  if (!session || paused || !session.ready || !automaticResponseGate.begin(line, Date.now(), responding)) return;
  const id = ++decisionSeq;
  rpc<string>("decide", {
    system: automaticDecisionPrompt(),
    input: automaticDecisionInput(recentMeetingLines.slice(0, -1), line),
  }).then(
    (text) => {
      if (id !== decisionSeq) return;
      const reply = automaticResponseGate.complete(parseAutomaticDecision(text));
      if (reply && !paused) {
        // Give a participant who immediately continues speaking a chance to finish before audio starts.
        automaticAnswerTimer = setTimeout(() => {
          automaticAnswerTimer = undefined;
          log("reply (AI decided the line was meant for the delegate)");
          requestResponse();
        }, 500);
      }
    },
    (e: Error) => {
      if (id !== decisionSeq) return;
      automaticResponseGate.cancel();
      log(`automatic decision failed: ${e.message}`);
    },
  );
}

interface LiveMessage {
  setupComplete?: unknown;
  goAway?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  error?: { message?: string };
}

function onLiveMessage(raw: string) {
  let m: LiveMessage;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.setupComplete !== undefined) {
    if (!session) return;
    session.ready = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = undefined;
    log("gemini session ready");
    if (!captionTimer) startCaptions(session.cfg.wakeName);
    setState("listening");
    if (!introduced) {
      introduced = true;
      // Introduce the delegate (disclosure) before anything else.
      requestResponse(
        `Say exactly this, nothing more: "Hello, I'm an AI delegate for ${session.cfg.name}. I'm here on their behalf, and this meeting may be transcribed."`,
      );
    }
    return;
  }
  if (m.goAway !== undefined) log("gemini will end this session soon; reconnecting when it closes");
  if (m.error) {
    log(`gemini error: ${m.error.message ?? "unknown"}`);
    setState("needs-user", m.error.message ?? "Voice service error");
    return;
  }
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.interrupted) {
    staleTurn = false;
    return;
  }
  for (const p of sc.modelTurn?.parts ?? []) {
    const data = p.inlineData?.data;
    if (!data || staleTurn || !responding) continue;
    if (state !== "speaking" && !paused) setState("speaking");
    playChunk(data);
  }
  if (sc.outputTranscription?.text && !staleTurn) delegateText += sc.outputTranscription.text;
  if (sc.turnComplete) {
    if (staleTurn) {
      staleTurn = false;
      return;
    }
    if (delegateText.trim()) send({ kind: "transcript", speaker: "delegate", text: delegateText.trim(), ts: Date.now() });
    delegateText = "";
    turnDone = true;
    if (sources.size === 0) finishSpeaking();
  }
}

// ---------- meeting memory in the live session ----------
/** Replace the running notes; they ride along with the next reply request (Gemini compresses old context itself). */
function applyMemoryNotes(text: string) {
  pendingNotes = text;
  log("meeting notes updated");
}

// ---------- hearing the meeting: Google Meet live captions ----------
let captionTimer: ReturnType<typeof setInterval> | undefined;
let captionsTurnedOnByUs = false;
const captionIds = new WeakMap<Element, number>();
let nextCaptionId = 0;
let captionTracker: CaptionWakeTracker | undefined;
let delegateLastAudibleAt = 0;
/** Caption growth from other people since the delegate started its current reply. */
let interruptChars = 0;
/** Who last addressed the delegate, and when: their immediate follow-ups get a reply too. */
let lastAddresser: { speaker: string; at: number } | undefined;
const FOLLOW_UP_MS = 15000;

function captionButton(label: string): HTMLButtonElement | undefined {
  // Meet sometimes appends the shortcut, e.g. "Turn on captions (c)".
  const want = label.toLowerCase();
  return Array.from(document.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? "").trim().toLowerCase().startsWith(want));
}

/** Queue what was said; it goes to Gemini as text with the next reply request, so replies see the whole meeting. */
function addCaptionToConversation(speaker: string, text: string) {
  pendingTurns.push(`[Meet caption] ${speaker}: ${text}`);
  if (pendingTurns.length > 200) pendingTurns.shift();
}

function startCaptions(wakeNames: string) {
  stopCaptions();
  captionsGraceUntil = Date.now() + 10000;
  const turnOn = () => {
    const on = captionButton("Turn on captions");
    if (on) {
      on.click();
      captionsTurnedOnByUs = true;
      log("turned on Meet captions");
    } else if (!document.querySelector(CAPTION_REGION_SELECTOR)) {
      const seen = Array.from(document.querySelectorAll("button[aria-label]"))
        .map((b) => b.getAttribute("aria-label"))
        .filter((l) => /caption|subtitle|cc/i.test(l ?? ""));
      log(`no "Turn on captions" button found; caption-like buttons: ${JSON.stringify(seen)}`);
    }
  };
  turnOn();
  let lastRetry = Date.now();
  const tracker = (captionTracker = new CaptionWakeTracker(wakeNames));
  let captionsWereOn = true;
  captionTimer = setInterval(() => {
    if (!session) return;
    if (responding) delegateLastAudibleAt = Date.now();
    else interruptChars = 0;
    const delegateSpeaking = responding || Date.now() - delegateLastAudibleAt < DELEGATE_ECHO_MS;
    const region = document.querySelector(CAPTION_REGION_SELECTOR);
    if (!region) {
      // Still within the first seconds: keep trying to switch captions on (the CC button may not exist yet).
      if (Date.now() < captionsGraceUntil && Date.now() - lastRetry > 1500) {
        lastRetry = Date.now();
        turnOn();
      }
      // Captions were switched off (or Meet changed): say so, the delegate is deaf without them.
      if (captionsWereOn) {
        captionsWereOn = false;
        log("Meet captions not found");
        emitStatus();
      }
      return;
    }
    if (!captionsWereOn) {
      captionsWereOn = true;
      emitStatus();
    }
    const now = Date.now();
    for (const { el, block } of readCaptionBlocks(region)) {
      let id = captionIds.get(el);
      if (id === undefined) captionIds.set(el, (id = ++nextCaptionId));
      const ev = tracker.update(id, block, now, delegateSpeaking);
      if (!ev || !session) continue;

      if (ev.type === "activity") {
        // Someone else talking over the delegate: stop it. (Your own mic is muted while it speaks, and
        // "You" captions in that window are the delegate itself, which the tracker already drops.)
        if (responding && ev.speaker !== SELF_LABEL) {
          interruptChars += ev.grew;
          if (interruptChars >= INTERRUPT_CHARS) {
            interruptChars = 0;
            log(`interrupted by ${ev.speaker}`);
            cancelSpeech();
            restoreRealMic();
            if (!paused) setState("listening", `Stopped: ${ev.speaker} started talking`);
          }
        }
        continue;
      }

      // While paused nothing is recorded or sent to Gemini.
      if (paused) continue;
      const u = ev;
      send({ kind: "transcript", speaker: "participant", text: `[Meet captions] ${u.speaker}: ${u.text}`, ts: now });
      addCaptionToConversation(u.speaker, u.text);
      const participants = meetingParticipantCount(document);
      const followUp = lastAddresser?.speaker === u.speaker && now - Math.max(lastAddresser.at, delegateLastAudibleAt) < FOLLOW_UP_MS;
      if (shouldReply(u, participants) || followUp) {
        // Clearly meant for the delegate: reply directly, no decision call needed.
        lastAddresser = { speaker: u.speaker, at: now };
        log(`reply (${u.addressed ? "name" : followUp ? "follow-up" : "one-to-one meeting"}): ${u.speaker}`);
        clearAutomaticDecision();
        requestResponse();
      } else {
        // Let the AI decide whether this line is meant for the delegate.
        startAutomaticDecision(`${u.speaker}: ${u.text}`);
      }
    }
  }, 300);
}

function stopCaptions() {
  if (captionTimer) clearInterval(captionTimer);
  captionTimer = undefined;
  captionTracker = undefined;
  lastAddresser = undefined;
  interruptChars = 0;
  if (captionsTurnedOnByUs) {
    captionButton("Turn off captions")?.click();
    captionsTurnedOnByUs = false;
  }
}

// ---------- start / stop ----------
const LIVE_READY_TIMEOUT_MS = 15000;

/** Mint a one-use token via the backend and open the Gemini Live socket (through the background worker). */
async function openLive(attempt: number): Promise<boolean> {
  const cfg = session?.cfg;
  if (!cfg) return false;
  const minted = await rpc<MintResult>("mint", { name: cfg.name, style: cfg.style });
  if (attempt !== startAttempt || !session) return false;
  session.open = false;
  session.ready = false;
  send({ kind: "live", op: "open", url: minted.url, setup: minted.setup });
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (attempt === startAttempt && session && !session.ready) {
      log("gemini did not accept the session in time");
      teardown();
      setState("needs-user", "Could not start: Gemini did not accept the session");
    }
  }, LIVE_READY_TIMEOUT_MS);
  return true;
}

async function startSession(cfg: StartConfig, consent: number, memory?: string) {
  if (session || state === "connecting") return;
  if (!consent) {
    setState("needs-user", "Consent to AI participation and transcription is required");
    return;
  }
  pendingTurns = [];
  pendingNotes = memory;
  introduced = false;
  reconnects = 0;
  const attempt = ++startAttempt;
  automaticResponseGate.reset();
  consentAt = consent;
  paused = false;
  setState("connecting");
  try {
    ensureAudio();
    session = { cfg, consentAt: consent, open: false, ready: false };
    // Hearing (captions) does not depend on the voice connection: switch captions on right away.
    startCaptions(cfg.wakeName);
    await openLive(attempt);
  } catch (e) {
    if (attempt !== startAttempt) return;
    log(`start failed: ${(e as Error).message}`);
    teardown();
    setState("needs-user", `Could not start: ${(e as Error).message}`);
  }
}

function onLiveClosed(reason: string) {
  if (!session) return;
  const attempt = startAttempt;
  cancelSpeech();
  restoreRealMic();
  session.open = false;
  session.ready = false;
  // Gemini ends a live session after a while: reconnect (a few times) and hand it the recent meeting.
  if (reconnects < 3) {
    reconnects++;
    log(`gemini session closed (${reason}); reconnecting (${reconnects}/3)`);
    pendingNotes = [pendingNotes, "[Earlier in this meeting]", ...recentMeetingLines].filter(Boolean).join("\n");
    setState("connecting", "Reconnecting to the voice session");
    openLive(attempt).catch((e: Error) => {
      if (attempt !== startAttempt) return;
      teardown();
      setState("disconnected", `Voice connection lost: ${e.message}. Your real microphone is active again`);
    });
    return;
  }
  teardown();
  setState("disconnected", "Voice connection lost; your real microphone is active again");
}

function teardown() {
  // Invalidate any pending mint operation so it cannot resurrect the delegate after Take Over.
  startAttempt++;
  stopCaptions();
  cancelSpeech();
  restoreRealMic();
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = undefined;
  if (session) {
    send({ kind: "live", op: "close" });
    session = undefined;
  }
  pendingTurns = [];
  pendingNotes = undefined;
  responding = false;
}

function handle(cmd: Command) {
  switch (cmd.cmd) {
    case "start":
      void startSession(cmd.cfg, cmd.consentAt, cmd.memory);
      break;
    case "respond":
      // "Answer now": reply to the last thing said, even if it was not clearly meant for the delegate.
      if (session) {
        if (paused) {
          setState("paused", "Delegate is paused; press Resume before responding");
          break;
        }
        if (captionTracker?.lastHeard) {
          clearAutomaticDecision();
          requestResponse();
        } else setState("listening", "Nothing has been said yet to answer");
      }
      break;
    case "pause":
      if (session) {
        paused = true;
        automaticResponseGate.pause();
        cancelSpeech();
        restoreRealMic();
        setState("paused", "Delegate is paused; it is not recording or replying");
      }
      break;
    case "resume":
      if (session) {
        paused = false;
        automaticResponseGate.resume();
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
  else if (msg.kind === "memoryNotes") applyMemoryNotes(msg.text);
  else if (msg.kind === "liveEvent") {
    if (msg.ev === "open" && session) {
      session.open = true;
      log("gemini socket open");
    } else if (msg.ev === "msg" && msg.data) onLiveMessage(msg.data);
    else if (msg.ev === "close" || msg.ev === "error") {
      if (session) onLiveClosed(msg.data ?? msg.ev);
    }
  } else if (msg.kind === "rpcResult") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "rpc failed"));
  }
});

emitStatus();
