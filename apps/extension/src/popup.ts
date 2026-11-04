import type { Command, MemoryView, StatusMsg } from "./protocol";
import { pastMeetingBlock } from "./memory";
import { startupError, startupPhase, withTimeout } from "./popupState";
import { PROFILE_MAX_CHARS, appendProfile, profileFileKind } from "./profile";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STARTUP_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 5_000;
/** Writing a summary calls a model through the backend; allow for that. */
const SUMMARY_TIMEOUT_MS = 60_000;

let stickyUntil = 0;
let latestStatus: StatusMsg = { state: "idle" };
let startRequested = false;
let startCommandPending = false;
let startRevision = 0;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
let lastCommandError = "";

async function activeMeetTab(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) return null;
  return tab.id;
}

async function sendCommand(command: Command, timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    return await withTimeout(
      (async () => {
        const id = await activeMeetTab();
        if (id === null) {
          lastCommandError = "Open this popup on a Google Meet tab (meet.google.com)";
          notice(lastCommandError);
          return null;
        }
        return chrome.tabs.sendMessage(id, { kind: "command", command });
      })(),
      timeoutMs,
      `The Meet tab did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
    );
  } catch (error) {
    lastCommandError = error instanceof Error ? error.message : "Could not reach the Meet tab";
    notice(lastCommandError);
    return null;
  }
}

// Popup-side messages stay visible for a few seconds instead of being wiped by polling.
function showStatusText(detail: string, bad = false) {
  const el = $("status");
  el.className = bad ? "bad" : "";
  el.textContent = detail;
}

function notice(detail: string) {
  stickyUntil = Date.now() + 5000;
  showStatusText(detail, true);
}

function clearStartupTimer() {
  if (startupTimer !== undefined) clearTimeout(startupTimer);
  startupTimer = undefined;
}

function failStart(message: string) {
  clearStartupTimer();
  startRequested = false;
  startCommandPending = false;
  $<HTMLButtonElement>("start").disabled = false;
  stickyUntil = Date.now() + 5000;
  showStatusText(`Start failed: ${message}`, true);
}

function armStartupTimer() {
  if (startupTimer !== undefined) return;
  startupTimer = setTimeout(() => void handleStartupTimeout(), STARTUP_TIMEOUT_MS);
}

async function handleStartupTimeout() {
  startupTimer = undefined;
  if (!startRequested) return;
  await refresh();
  if (!startRequested || startupPhase(latestStatus) === "ready") return;

  // Stop an attempt that never reached a ready peer so it cannot finish invisibly later.
  const stopped = await sendCommand({ cmd: "takeover" });
  failStart(
    stopped
      ? "Timed out while connecting. The pending session was stopped; check the backend and try again."
      : "Timed out while connecting. Could not reach the Meet tab to stop the pending session.",
  );
}

function applyStatus(status: StatusMsg) {
  latestStatus = status;
  const phase = startupPhase(status);
  const startButton = $<HTMLButtonElement>("start");

  if (phase === "ready") {
    clearStartupTimer();
    startRequested = false;
    startCommandPending = false;
    startButton.disabled = true;
    if (Date.now() >= stickyUntil) {
      if (status.state === "paused") {
        showStatusText(`Paused${status.detail ? `: ${status.detail}` : ""}`);
      } else {
        showStatusText(`Started${status.detail ? `: ${status.detail}` : ""}`);
      }
    }
    return;
  }

  if (startRequested) {
    // Ignore cached pre-click status until the page publishes a newer revision.
    if (startCommandPending || (status.revision ?? 0) <= startRevision) {
      startButton.disabled = true;
      if (Date.now() >= stickyUntil) showStatusText("Starting…");
      armStartupTimer();
      return;
    }
    if (phase === "failed") {
      void sendCommand({ cmd: "takeover" });
      failStart(startupError(status));
      return;
    }
    if (phase === "starting" || phase === "idle") {
      startButton.disabled = true;
      if (Date.now() >= stickyUntil) showStatusText("Starting…");
      armStartupTimer();
      return;
    }
  }

  if (phase === "starting") {
    // A reopened popup reconstructs its controls from the current Meet tab status.
    startRequested = true;
    startRevision = (status.revision ?? 1) - 1;
    startButton.disabled = true;
    if (Date.now() >= stickyUntil) showStatusText("Starting…");
    armStartupTimer();
    return;
  }

  clearStartupTimer();
  startButton.disabled = false;
  if (Date.now() < stickyUntil) return;
  if (phase === "failed") {
    showStatusText(status.detail || startupError(status), true);
  } else {
    showStatusText(`${status.state}${status.detail ? `: ${status.detail}` : ""}${status.state !== "idle" && status.captions === false ? " · captions off" : ""}${status.participants ? ` · ${status.participants} in meeting` : ""}`, status.state === "needs-user" || status.state === "disconnected");
  }
}

function renderTranscript(items: { speaker: string; text: string; ts: number }[]) {
  const log = $("log");
  log.textContent = "";
  for (const it of items.slice(-30)) {
    const d = document.createElement("div");
    d.textContent = `${new Date(it.ts).toLocaleTimeString()} ${it.speaker}: ${it.text}`; // textContent: never HTML
    log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}

async function refresh() {
  const r = (await sendCommand({ cmd: "getStatus" })) as { status: StatusMsg; transcript: never[] } | null;
  if (r) {
    applyStatus(r.status);
    renderTranscript(r.transcript);
  }
}

// ---------- "About you" (profile) ----------
async function initProfile() {
  const box = $<HTMLTextAreaElement>("profile");
  const info = $("profileInfo");
  const count = $("profileCount");
  const { profile } = (await chrome.storage.local.get("profile")) as { profile?: string };
  box.value = profile ?? "";
  box.maxLength = PROFILE_MAX_CHARS;
  const showCount = () => {
    count.textContent = box.value.trim() ? `(${box.value.length.toLocaleString()} / ${PROFILE_MAX_CHARS.toLocaleString()} chars)` : "(empty)";
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => chrome.storage.local.set({ profile: box.value });
  box.addEventListener("input", () => {
    showCount();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 400);
  });
  showCount();

  const fileInput = $<HTMLInputElement>("profileFile");
  $("profileAdd").onclick = () => fileInput.click();
  $("profileClear").onclick = async () => {
    box.value = "";
    await save();
    showCount();
    info.textContent = "Cleared. Restart the delegate for it to take effect.";
  };
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const kind = profileFileKind(file.name, file.type);
    if (!kind) {
      info.textContent = "Only PDF, Markdown (.md) or text (.txt) files are supported.";
      return;
    }
    try {
      let text: string;
      if (kind === "text") {
        text = await file.text();
      } else {
        info.textContent = `Reading ${file.name}…`;
        const token = $<HTMLInputElement>("token").value.trim() || ((await chrome.storage.local.get("token")).token as string | undefined);
        if (!token) throw new Error("enter the local backend token first (PDFs are read by your local backend)");
        const { serverUrl } = (await chrome.storage.local.get("serverUrl")) as { serverUrl?: string };
        const res = await fetch(`${serverUrl || "http://127.0.0.1:8787"}/extract-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "x-standin-token": token },
          body: file,
        });
        const j = (await res.json().catch(() => ({}))) as { text?: string; pages?: number; error?: string };
        if (!res.ok || !j.text) throw new Error(j.error ?? `backend returned ${res.status}`);
        text = j.text;
      }
      if (!text.trim()) throw new Error("the file has no text");
      const r = appendProfile(box.value, file.name, text);
      box.value = r.text;
      await save();
      showCount();
      $<HTMLDetailsElement>("profileBox").open = true;
      info.textContent =
        `Added ${file.name}.` + (r.truncated ? ` Trimmed to ${PROFILE_MAX_CHARS.toLocaleString()} characters.` : "") + " Restart the delegate for it to take effect.";
    } catch (e) {
      info.textContent = `Could not add ${file.name}: ${(e as Error).message}`;
    }
  };
}

// ---------- Meeting memory ----------
function renderMemory(v: MemoryView | null) {
  const count = $("memoryCount");
  const list = $("promises");
  const summary = $("memorySummary");
  const info = $("memoryInfo");
  if (!v) return;
  const open = v.promises.filter((p) => !p.done).length;
  count.textContent = v.code ? `(${v.lines} lines${open ? `, ${open} to-do` : ""})` : "";
  summary.textContent = v.summary ?? (v.lines ? `(no summary yet: ${v.unsummarized} lines waiting)` : "(nothing yet)");
  list.textContent = "";
  if (v.promises.length === 0) list.textContent = "(none)";
  for (const p of v.promises) {
    const row = document.createElement("label");
    row.className = "consent";
    row.style.marginTop = "2px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = p.done;
    cb.onchange = async () => renderMemory((await sendCommand({ cmd: "setPromiseDone", id: p.id, done: cb.checked })) as MemoryView | null);
    const span = document.createElement("span");
    // textContent only: meeting text is never treated as HTML.
    span.textContent = `${p.question ? `"${p.question}" → ` : ""}${p.reply}`;
    if (p.done) span.style.textDecoration = "line-through";
    row.append(cb, span);
    list.appendChild(row);
  }
  info.textContent = v.summarizing ? "Writing summary…" : v.error && v.code ? `Summary problem: ${v.error}` : "";
}

async function initMemory() {
  const refresh = async () => renderMemory((await sendCommand({ cmd: "getMemory" })) as MemoryView | null);
  $("memoryBox").addEventListener("toggle", () => void refresh());
  $("memoryUpdate").onclick = async () => {
    $("memoryInfo").textContent = "Writing summary…";
    renderMemory((await sendCommand({ cmd: "summarizeNow" }, SUMMARY_TIMEOUT_MS)) as MemoryView | null);
  };
  $("memoryForget").onclick = async () => {
    renderMemory((await sendCommand({ cmd: "forgetMeeting" })) as MemoryView | null);
    $("memoryInfo").textContent = "Forgotten. A restarted delegate will start fresh in this meeting.";
  };
  // Opt-in carry-over to future meetings: only when the user presses this button.
  $("memorySave").onclick = async () => {
    $("memoryInfo").textContent = "Writing summary…";
    const v = (await sendCommand({ cmd: "summarizeNow" }, SUMMARY_TIMEOUT_MS)) as MemoryView | null;
    if (!v?.code || !v.summary) {
      $("memoryInfo").textContent = "Nothing to save yet (no summary). Is the backend running?";
      return;
    }
    const box = $<HTMLTextAreaElement>("profile");
    const r = appendProfile(box.value, "Past meetings", pastMeetingBlock({ code: v.code, summary: v.summary, promises: v.promises }, new Date()));
    box.value = r.text;
    box.dispatchEvent(new Event("input")); // saves and updates the count
    renderMemory(v);
    $("memoryInfo").textContent = `Saved to About you${r.truncated ? " (trimmed to fit)" : ""}. Future meetings will know this once you press Start.`;
  };
  await refresh();
}

async function init() {
  await initProfile();
  await initMemory();
  const saved = await chrome.storage.local.get(["name", "wake", "token"]);
  // Settings from older versions (modes, captions checkbox) no longer exist.
  void chrome.storage.local.remove(["mode", "captions"]);
  $<HTMLInputElement>("name").value = saved.name ?? "";
  $<HTMLInputElement>("wake").value = saved.wake ?? "";
  $<HTMLInputElement>("token").value = saved.token ?? "";

  const startButton = $<HTMLButtonElement>("start");
  startButton.onclick = async () => {
    if (startRequested || startCommandPending || startButton.disabled) return;
    const name = $<HTMLInputElement>("name").value.trim();
    const wake = $<HTMLInputElement>("wake").value.trim() || name;
    const token = $<HTMLInputElement>("token").value.trim();
    if (!name) return notice("Enter your name");
    if (!token) return notice("Enter the local backend token");
    if (!$<HTMLInputElement>("consent").checked) return notice("Confirm participant consent first");

    stickyUntil = 0;
    lastCommandError = "";
    startRequested = true;
    startCommandPending = true;
    startRevision = latestStatus.revision ?? 0;
    startButton.disabled = true;
    showStatusText("Starting…");
    armStartupTimer();
    try {
      await chrome.storage.local.set({ name, wake, token });
      const response = await sendCommand({ cmd: "start", cfg: { name, wakeName: wake }, consentAt: Date.now() });
      if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
        const failure = lastCommandError || "The Start request could not be delivered to the Meet tab.";
        await sendCommand({ cmd: "takeover" });
        failStart(failure);
        return;
      }
      startCommandPending = false;
      await refresh();
    } catch (error) {
      failStart(error instanceof Error ? error.message : "The Start request was rejected.");
    }
  };
  $("respond").onclick = () => sendCommand({ cmd: "respond" });
  $("pause").onclick = () => sendCommand({ cmd: "pause" });
  $("resume").onclick = () => sendCommand({ cmd: "resume" });
  $("takeover").onclick = () => sendCommand({ cmd: "takeover" });

  await refresh();
  setInterval(() => void refresh(), 1000);
}
void init();
