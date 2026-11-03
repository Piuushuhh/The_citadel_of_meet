import type { Command, StatusMsg } from "./protocol";
import { startupError, startupPhase, withTimeout } from "./popupState";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STARTUP_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 5_000;

let stickyUntil = 0;
let latestStatus: StatusMsg = { state: "idle", remoteAudioTracks: 0 };
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

async function sendCommand(command: Command) {
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
      COMMAND_TIMEOUT_MS,
      "The Meet tab did not respond within 5 seconds.",
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
    showStatusText(`${status.state}${status.detail ? `: ${status.detail}` : ""} · meeting audio tracks: ${status.remoteAudioTracks}`, status.state === "needs-user" || status.state === "disconnected");
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

async function init() {
  const saved = await chrome.storage.local.get(["name", "wake", "mode", "token", "captions"]);
  $<HTMLInputElement>("captions").checked = saved.captions === true;
  $<HTMLInputElement>("name").value = saved.name ?? "";
  $<HTMLInputElement>("wake").value = saved.wake ?? "";
  $<HTMLSelectElement>("mode").value = saved.mode ?? "explicit";
  $<HTMLInputElement>("token").value = saved.token ?? "";

  const startButton = $<HTMLButtonElement>("start");
  startButton.onclick = async () => {
    if (startRequested || startCommandPending || startButton.disabled) return;
    const name = $<HTMLInputElement>("name").value.trim();
    const wake = $<HTMLInputElement>("wake").value.trim() || name;
    const mode = $<HTMLSelectElement>("mode").value as "explicit" | "manual" | "automatic";
    const token = $<HTMLInputElement>("token").value.trim();
    const captions = $<HTMLInputElement>("captions").checked;
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
      await chrome.storage.local.set({ name, wake, mode, token, captions });
      const wakeSource = captions ? "captions" : "openai";
      const response = await sendCommand({ cmd: "start", cfg: { name, wakeName: wake, mode, wakeSource }, consentAt: Date.now() });
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
