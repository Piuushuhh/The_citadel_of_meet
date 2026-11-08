// Isolated-world bridge: page-world <-> background / popup.
// Also owns the meeting memory (lines, running summary, promises), stored per meeting in chrome.storage.local.
import { TAG, type PageIn, type PageOut, type StatusMsg, type Command, type MemoryView } from "./protocol";
import {
  MEMORY_TTL_MS,
  addLine,
  applySummary,
  emptyMemory,
  meetingCode,
  needsSummary,
  notesItemText,
  resumePreamble,
  toMemoryLine,
  unsummarized,
  type MeetingMemory,
} from "./memory";

let lastStatus: StatusMsg = { state: "idle" };
const transcript: { speaker: string; text: string; ts: number }[] = [];

function toPage(msg: PageIn) {
  window.postMessage({ tag: TAG, dir: "to-page", msg }, window.location.origin);
}

// ---------- meeting memory ----------
let mem: MeetingMemory | undefined;
let summarizing = false;
let summaryError: string | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const key = (code: string) => `meeting:${code}`;

/** The memory for the meeting this tab is in (loaded on first use; Meet changes URL without reloading). */
async function memory(): Promise<MeetingMemory | undefined> {
  const code = meetingCode(location.pathname);
  if (!code) return undefined;
  if (mem?.code === code) return mem;
  const stored = (await chrome.storage.local.get(key(code)))[key(code)] as MeetingMemory | undefined;
  mem = stored ?? emptyMemory(code);
  void pruneOldMeetings();
  return mem;
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (mem) void chrome.storage.local.set({ [key(mem.code)]: mem });
  }, 500);
}

async function pruneOldMeetings() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.entries(all)
    .filter(([k, v]) => k.startsWith("meeting:") && Date.now() - ((v as MeetingMemory).updatedAt ?? 0) > MEMORY_TTL_MS)
    .map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

/** Summarize the lines not yet covered. `force` summarizes even a few lines (popup "Update now"). */
async function runSummary(force = false): Promise<void> {
  const m = await memory();
  if (!m || summarizing || !m.name) return;
  const lines = unsummarized(m);
  if (lines.length === 0 || (!force && !needsSummary(m))) return;
  const upTo = m.lines.length;
  summarizing = true;
  try {
    const r = (await chrome.runtime.sendMessage({
      kind: "rpc",
      method: "summarize",
      params: { name: m.name, previousSummary: m.summary, lines: lines.map((l) => ({ speaker: l.speaker, text: l.text })) },
    })) as { ok: boolean; result?: string; error?: string };
    if (!r.ok || !r.result) throw new Error(r.error ?? "summary failed");
    applySummary(m, r.result, upTo);
    summaryError = undefined;
    save();
    // Give the live session the new notes, so older raw turns can be dropped without forgetting them.
    toPage({ kind: "memoryNotes", text: notesItemText(r.result) });
  } catch (e) {
    summaryError = (e as Error).message;
  } finally {
    summarizing = false;
  }
}

async function remember(speaker: "participant" | "delegate", text: string, ts: number) {
  const line = toMemoryLine(speaker, text, ts);
  const m = await memory();
  if (!line || !m) return;
  addLine(m, line);
  save();
  if (needsSummary(m)) void runSummary();
}

async function memoryView(): Promise<MemoryView> {
  const m = await memory();
  if (!m) return { lines: 0, unsummarized: 0, promises: [], summarizing: false, error: "Not in a meeting" };
  return {
    code: m.code,
    summary: m.summary,
    lines: m.lines.length,
    unsummarized: unsummarized(m).length,
    promises: m.promises,
    summarizing,
    error: summaryError,
  };
}

// ---------- page <-> extension ----------
let livePort: chrome.runtime.Port | undefined;
function openLivePort() {
  livePort?.disconnect();
  const port = (livePort = chrome.runtime.connect({ name: "standin-live" }));
  port.onMessage.addListener((m: { ev: "open" | "msg" | "close" | "error"; data?: string }) => toPage({ kind: "liveEvent", ev: m.ev, data: m.data }));
  port.onDisconnect.addListener(() => {
    if (livePort === port) {
      livePort = undefined;
      toPage({ kind: "liveEvent", ev: "close", data: "background connection lost" });
    }
  });
}
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.tag !== TAG || e.data.dir !== "to-content") return;
  const msg = e.data.msg as PageOut;
  if (msg.kind === "status") {
    lastStatus = msg.status;
  } else if (msg.kind === "transcript") {
    transcript.push({ speaker: msg.speaker, text: msg.text, ts: msg.ts });
    if (transcript.length > 500) transcript.shift();
    void remember(msg.speaker, msg.text, msg.ts);
  } else if (msg.kind === "live") {
    if (msg.op === "open") openLivePort();
    livePort?.postMessage(msg.op === "open" ? { op: "open", url: msg.url, setup: msg.setup } : msg);
    if (msg.op === "close") {
      livePort?.disconnect();
      livePort = undefined;
    }
  } else if (msg.kind === "rpc") {
    chrome.runtime
      .sendMessage({ kind: "rpc", method: msg.method, params: msg.params })
      .then((r: { ok: boolean; result?: unknown; error?: string }) =>
        toPage({ kind: "rpcResult", id: msg.id, ok: r.ok, result: r.result, error: r.error }),
      )
      .catch((err: Error) => toPage({ kind: "rpcResult", id: msg.id, ok: false, error: err.message }));
  }
});

async function handleCommand(command: Command): Promise<unknown> {
  switch (command.cmd) {
    case "getStatus":
      return { status: lastStatus, transcript };
    case "start": {
      // Attach what happened earlier in this meeting so a restarted delegate picks up where it left off.
      const m = await memory();
      if (m) {
        m.name = command.cfg.name;
        save();
      }
      toPage({ kind: "command", command: { ...command, memory: m ? resumePreamble(m) : undefined } });
      return { ok: true };
    }
    case "getMemory":
      return memoryView();
    case "summarizeNow":
      await runSummary(true);
      return memoryView();
    case "setPromiseDone": {
      const m = await memory();
      const p = m?.promises.find((x) => x.id === command.id);
      if (p) {
        p.done = command.done;
        save();
      }
      return memoryView();
    }
    case "forgetMeeting": {
      const m = await memory();
      if (m) {
        await chrome.storage.local.remove(key(m.code));
        mem = emptyMemory(m.code);
      }
      return memoryView();
    }
    default:
      toPage({ kind: "command", command });
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((m: { kind?: string; command?: Command }, _s, sendResponse) => {
  if (m.kind !== "command" || !m.command) return false;
  handleCommand(m.command).then(sendResponse, (e: Error) => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});
