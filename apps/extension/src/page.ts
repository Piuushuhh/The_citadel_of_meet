// Page-world script (runs inside meet.google.com's JS context at document_start).
//
// How the delegate hears: Google Meet's own live captions (captions.ts). Every finished caption line goes into
// the OpenAI Realtime conversation as text; no meeting audio is sent to OpenAI.
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
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  audioEl: HTMLAudioElement;
  consentAt: number;
}
let session: Session | undefined;
let state: DelegateState = "idle";
let detail: string | undefined;
let paused = false;
let responding = false; // a response is in flight or audio is playing
let consentAt: number | undefined;
let startAttempt = 0;
let statusRevision = 0;
const automaticResponseGate = new AutomaticResponseGate();
let automaticDecisionResponseId: string | undefined;
let automaticDecision: AutomaticDecision | undefined;
let automaticDecisionTimer: ReturnType<typeof setTimeout> | undefined;
let automaticAnswerTimer: ReturnType<typeof setTimeout> | undefined;

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
    const pcState = session.pc.connectionState;
    if (pcState === "failed" || pcState === "disconnected" || pcState === "closed") {
      s = "disconnected";
      d = "Voice connection is not connected";
    } else if (pcState !== "connected") {
      s = "connecting";
      d = "Connecting to the Realtime voice session";
    } else if (!captions) {
      s = "needs-user";
      d = "Meet captions are off, so the delegate cannot hear anyone. Turn on captions (CC).";
    }
  }
  const debug = session ? { acState: ac?.state, pc: session.pc.connectionState, dc: session.dc.readyState } : undefined;
  const participants = session ? meetingParticipantCount(document) : undefined;
  send({ kind: "status", status: { state: s, revision: ++statusRevision, detail: d, consentAt, captions, participants, debug } });
}

function sendEvent(ev: unknown) {
  if (session?.dc.readyState === "open") session.dc.send(JSON.stringify(ev));
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
  sendEvent({ type: "response.cancel" });
  sendEvent({ type: "output_audio_buffer.clear" });
  responding = false;
}

/**
 * Speak a reply. Without `instructions` the session's own instructions apply (identity, rules, knowledge) and
 * the whole conversation is visible. Only the fixed introduction passes instructions.
 */
function requestResponse(instructions?: string) {
  if (!session || paused || responding) return;
  responding = true;
  enableDelegateVoice();
  setState("thinking");
  sendEvent({ type: "response.create", ...(instructions ? { response: { instructions } } : {}) });
}

function clearAutomaticDecision() {
  automaticResponseGate.cancel();
  automaticDecisionResponseId = undefined;
  automaticDecision = undefined;
  if (automaticDecisionTimer) clearTimeout(automaticDecisionTimer);
  automaticDecisionTimer = undefined;
}

/** Ask the model (out of band, text only) whether this line is meant for the delegate. */
function startAutomaticDecision(line: string) {
  if (!session || paused || session.dc.readyState !== "open" || !automaticResponseGate.begin(line, Date.now(), responding)) return;
  automaticDecisionResponseId = undefined;
  automaticDecision = undefined;
  sendEvent({
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["text"],
      metadata: { standin_kind: "automatic_decision" },
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: automaticDecisionPrompt() }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: automaticDecisionInput(recentMeetingLines.slice(0, -1), line) }] },
      ],
    },
  });
  automaticDecisionTimer = setTimeout(() => {
    if (automaticResponseGate.hasPending) {
      clearAutomaticDecision();
      sendEvent({ type: "response.cancel" });
      log("automatic decision timed out");
    }
  }, 15000);
}

function onEvent(raw: string) {
  let ev: {
    type?: string;
    transcript?: string;
    text?: string;
    response_id?: string;
    response?: { id?: string; metadata?: Record<string, string>; status?: string };
    error?: { message?: string };
    item?: { id?: string };
  };
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  const t = ev.type ?? "";
  if (!t.endsWith(".delta")) log(`event ${t}`);
  if ((t === "conversation.item.added" || t === "conversation.item.created") && ev.item?.id) trackItem(ev.item.id);

  if (t === "response.created" && ev.response?.metadata?.standin_kind === "automatic_decision") {
    automaticDecisionResponseId = ev.response.id;
  } else if (t === "response.output_text.done" && ev.response_id === automaticDecisionResponseId) {
    automaticDecision = parseAutomaticDecision(ev.text ?? "");
  } else if (t === "response.created") {
    if (!paused) setState("thinking");
  } else if (t === "output_audio_buffer.started") {
    if (responding) setState("speaking");
  } else if (t === "output_audio_buffer.stopped" || t === "output_audio_buffer.cleared") {
    responding = false;
    // Hand the mic back as soon as the delegate finishes so you are not stuck muted.
    restoreRealMic();
    if (!paused) setState("listening");
  } else if (t === "response.output_audio_transcript.done" && ev.transcript) {
    send({ kind: "transcript", speaker: "delegate", text: ev.transcript, ts: Date.now() });
  } else if (t === "response.done") {
    if (ev.response?.id && ev.response.id === automaticDecisionResponseId) {
      automaticDecisionResponseId = undefined;
      if (automaticDecisionTimer) clearTimeout(automaticDecisionTimer);
      automaticDecisionTimer = undefined;
      const reply = automaticResponseGate.complete(automaticDecision);
      automaticDecision = undefined;
      if (reply && !paused) {
        // Give a participant who immediately continues speaking a chance to finish before audio starts.
        automaticAnswerTimer = setTimeout(() => {
          automaticAnswerTimer = undefined;
          log("reply (AI decided the line was meant for the delegate)");
          requestResponse();
        }, 500);
      }
    } else if (ev.response?.status && ev.response.status !== "completed" && responding) {
      // Cancelled/failed replies produce no audio-stopped event; hand the mic back now.
      responding = false;
      restoreRealMic();
      if (!paused) setState("listening");
    }
  } else if (t === "error") {
    clearAutomaticDecision();
    if (automaticAnswerTimer) clearTimeout(automaticAnswerTimer);
    automaticAnswerTimer = undefined;
    log(`realtime error: ${ev.error?.message ?? "unknown"}`);
    setState("needs-user", ev.error?.message ?? "Voice service error");
  }
}

// ---------- meeting memory in the live session ----------
/** Conversation items in order (ids from the server's item events), excluding our notes item. */
let conversationItems: string[] = [];
let notesItemId: string | undefined;
let notesCounter = 0;
/** Raw items kept after a summary; everything older is covered by the notes. */
const KEEP_ITEMS = 16;

function trackItem(id: string) {
  if (id === notesItemId || conversationItems.includes(id)) return;
  conversationItems.push(id);
}

function addSystemItem(id: string, text: string) {
  sendEvent({ type: "conversation.item.create", item: { id, type: "message", role: "system", content: [{ type: "input_text", text }] } });
}

/** Replace the running notes in the live conversation and drop raw turns they already cover. */
function applyMemoryNotes(text: string) {
  if (!session || session.dc.readyState !== "open") return;
  const id = `standin_notes_${++notesCounter}`;
  const previous = notesItemId;
  notesItemId = id;
  addSystemItem(id, text);
  if (previous) sendEvent({ type: "conversation.item.delete", item_id: previous });
  // Deleting items while a reply is being generated could disturb it; the next summary prunes instead.
  if (responding) return;
  const drop = conversationItems.slice(0, Math.max(0, conversationItems.length - KEEP_ITEMS));
  for (const itemId of drop) sendEvent({ type: "conversation.item.delete", item_id: itemId });
  conversationItems = conversationItems.slice(drop.length);
  log(`meeting notes updated; dropped ${drop.length} older items`);
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
  return Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label);
}

/** Put what was said into the Realtime conversation as text, so every reply sees the whole meeting so far. */
function addCaptionToConversation(speaker: string, text: string) {
  sendEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: `[Meet caption] ${speaker}: ${text}` }] },
  });
}

function startCaptions(wakeNames: string) {
  stopCaptions();
  const on = captionButton("Turn on captions");
  if (on) {
    on.click();
    captionsTurnedOnByUs = true;
    log("turned on Meet captions");
  }
  const tracker = (captionTracker = new CaptionWakeTracker(wakeNames));
  let captionsWereOn = true;
  captionTimer = setInterval(() => {
    if (!session) return;
    if (responding) delegateLastAudibleAt = Date.now();
    else interruptChars = 0;
    const delegateSpeaking = responding || Date.now() - delegateLastAudibleAt < DELEGATE_ECHO_MS;
    const region = document.querySelector(CAPTION_REGION_SELECTOR);
    if (!region) {
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

      // While paused nothing is recorded or sent to OpenAI.
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
async function startSession(cfg: StartConfig, consent: number, memory?: string) {
  if (session || state === "connecting") return;
  if (!consent) {
    setState("needs-user", "Consent to AI participation and transcription is required");
    return;
  }
  conversationItems = [];
  notesItemId = undefined;
  const attempt = ++startAttempt;
  automaticResponseGate.reset();
  consentAt = consent;
  paused = false;
  setState("connecting");
  try {
    const ctx = ensureAudio();
    const minted = await rpc<MintResult>("mint", { name: cfg.name, style: cfg.style });
    if (attempt !== startAttempt) return;
    const pc = new RTCPeerConnection();
    // The voice connection needs an outgoing audio track, but the delegate hears through captions:
    // this track is silent, so no meeting audio is ever sent to OpenAI.
    const silent = ctx.createMediaStreamDestination();
    const audioEl = new Audio();
    audioEl.muted = true; // Chrome only pumps remote WebRTC audio into Web Audio if it is also attached to an element
    const dc = pc.createDataChannel("oai-events");
    session = { cfg, pc, dc, audioEl, consentAt: consent };

    pc.addTrack(silent.stream.getAudioTracks()[0], silent.stream);
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      void audioEl.play().catch(() => undefined);
      ctx.createMediaStreamSource(e.streams[0]).connect(delegateGain);
    };
    dc.onmessage = (e) => onEvent(String(e.data));
    dc.onopen = () => {
      log("data channel open");
      // Restarted in a meeting it was already in: give it what happened before, so it picks up where it left off.
      if (memory) {
        notesItemId = `standin_notes_${++notesCounter}`;
        addSystemItem(notesItemId, memory);
        log("restored meeting memory");
      }
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

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await rpc<string>("sdp", { offer: offer.sdp, secret: minted.value, model: minted.model });
    if (attempt !== startAttempt) return;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    if (attempt !== startAttempt) return;
    setState("listening");
    startCaptions(cfg.wakeName);
  } catch (e) {
    if (attempt !== startAttempt) return;
    log(`start failed: ${(e as Error).message}`);
    teardown();
    setState("needs-user", `Could not start: ${(e as Error).message}`);
  }
}

function teardown() {
  // Invalidate any pending mint/SDP operation so it cannot resurrect the delegate after Take Over.
  startAttempt++;
  stopCaptions();
  cancelSpeech();
  restoreRealMic();
  if (session) {
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
  else if (msg.kind === "rpcResult") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "rpc failed"));
  }
});

emitStatus();
