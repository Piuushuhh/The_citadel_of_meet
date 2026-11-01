import type { Command, StatusMsg } from "./protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function activeMeetTab(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) return null;
  return tab.id;
}

async function sendCommand(command: Command) {
  const id = await activeMeetTab();
  if (id === null) {
    notice("Open this popup on a Google Meet tab (meet.google.com)");
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(id, { kind: "command", command });
  } catch {
    notice("Reload the Meet tab (F5) once after installing or updating the extension");
    return null;
  }
}

// Popup-side messages (validation, "reload the tab") stay visible for a few seconds
// instead of being wiped by the 1s status refresh.
let stickyUntil = 0;
function notice(detail: string) {
  stickyUntil = Date.now() + 5000;
  setStatus({ state: "needs-user", detail, remoteAudioTracks: 0 }, true);
}

function setStatus(s: StatusMsg, force = false) {
  if (!force && Date.now() < stickyUntil) return;
  const el = $("status");
  const bad = s.state === "disconnected" || s.state === "needs-user";
  el.className = bad ? "bad" : "";
  el.textContent = `${s.state}${s.detail ? ": " + s.detail : ""} · meeting audio tracks: ${s.remoteAudioTracks}`;
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
    setStatus(r.status);
    renderTranscript(r.transcript);
  }
}

async function init() {
  const saved = await chrome.storage.local.get(["name", "wake", "mode", "token"]);
  $<HTMLInputElement>("name").value = saved.name ?? "";
  $<HTMLInputElement>("wake").value = saved.wake ?? "";
  $<HTMLSelectElement>("mode").value = saved.mode ?? "explicit";
  $<HTMLInputElement>("token").value = saved.token ?? "";

  $("start").onclick = async () => {
    const name = $<HTMLInputElement>("name").value.trim();
    const wake = $<HTMLInputElement>("wake").value.trim() || name;
    const mode = $<HTMLSelectElement>("mode").value as "explicit" | "manual";
    const token = $<HTMLInputElement>("token").value.trim();
    if (!name) return notice("Enter your name");
    if (!token) return notice("Enter the local backend token");
    if (!$<HTMLInputElement>("consent").checked) return notice("Confirm participant consent first");
    await chrome.storage.local.set({ name, wake, mode, token });
    await sendCommand({ cmd: "start", cfg: { name, wakeName: wake, mode }, consentAt: Date.now() });
  };
  $("respond").onclick = () => sendCommand({ cmd: "respond" });
  $("pause").onclick = () => sendCommand({ cmd: "pause" });
  $("resume").onclick = () => sendCommand({ cmd: "resume" });
  $("takeover").onclick = () => sendCommand({ cmd: "takeover" });

  await refresh();
  setInterval(refresh, 1000);
}
void init();
