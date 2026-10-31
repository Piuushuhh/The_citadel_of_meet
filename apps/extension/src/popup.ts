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
    setStatus({ state: "needs-user", detail: "Open this popup on a Google Meet tab", remoteAudioTracks: 0 });
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(id, { kind: "command", command });
  } catch {
    setStatus({ state: "needs-user", detail: "Reload the Meet tab once after installing the extension", remoteAudioTracks: 0 });
    return null;
  }
}

function setStatus(s: StatusMsg) {
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
    if (!name) return setStatus({ state: "needs-user", detail: "Enter your name", remoteAudioTracks: 0 });
    if (!token) return setStatus({ state: "needs-user", detail: "Enter the local backend token", remoteAudioTracks: 0 });
    if (!$<HTMLInputElement>("consent").checked)
      return setStatus({ state: "needs-user", detail: "Confirm participant consent first", remoteAudioTracks: 0 });
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
