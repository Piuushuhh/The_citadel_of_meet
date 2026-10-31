// Isolated-world bridge: page-world <-> background / popup.
import { TAG, type PageIn, type PageOut, type StatusMsg, type Command } from "./protocol";

let lastStatus: StatusMsg = { state: "idle", remoteAudioTracks: 0 };
const transcript: { speaker: string; text: string; ts: number }[] = [];

function toPage(msg: PageIn) {
  window.postMessage({ tag: TAG, dir: "to-page", msg }, window.location.origin);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.tag !== TAG || e.data.dir !== "to-content") return;
  const msg = e.data.msg as PageOut;
  if (msg.kind === "status") {
    lastStatus = msg.status;
  } else if (msg.kind === "transcript") {
    transcript.push({ speaker: msg.speaker, text: msg.text, ts: msg.ts });
    if (transcript.length > 500) transcript.shift();
  } else if (msg.kind === "rpc") {
    chrome.runtime
      .sendMessage({ kind: "rpc", method: msg.method, params: msg.params })
      .then((r: { ok: boolean; result?: unknown; error?: string }) =>
        toPage({ kind: "rpcResult", id: msg.id, ok: r.ok, result: r.result, error: r.error }),
      )
      .catch((err: Error) => toPage({ kind: "rpcResult", id: msg.id, ok: false, error: err.message }));
  }
});

chrome.runtime.onMessage.addListener((m: { kind?: string; command?: Command }, _s, sendResponse) => {
  if (m.kind === "command" && m.command) {
    if (m.command.cmd === "getStatus") {
      sendResponse({ status: lastStatus, transcript });
      return false;
    }
    toPage({ kind: "command", command: m.command });
    sendResponse({ ok: true });
  }
  return false;
});
