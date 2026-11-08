// Service worker: the only place that talks to the local backend and the Gemini Live WebSocket.
// (Meet's page CSP could block these, and keeping them here keeps the page minimal.)

const SERVER_DEFAULT = "http://127.0.0.1:8787";

interface Settings {
  serverUrl?: string;
  token?: string;
}

async function settings(): Promise<Settings> {
  return (await chrome.storage.local.get(["serverUrl", "token"])) as Settings;
}

async function mint(params: { name: string; style?: string }) {
  const s = await settings();
  if (!s.token) throw new Error("Set the local token in the popup first");
  // The "About you" text is read here from extension storage, never passed through the Meet page.
  const { profile } = (await chrome.storage.local.get("profile")) as { profile?: string };
  const res = await fetch(`${s.serverUrl || SERVER_DEFAULT}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-standin-token": s.token },
    body: JSON.stringify({ name: params.name, style: params.style, profile: profile?.trim() || undefined }),
  });
  if (!res.ok) throw new Error(`backend /session returned ${res.status}`);
  return res.json();
}

/** Meeting memory: running summary via the local backend (which holds the OpenAI key). */
async function summarize(params: { name: string; previousSummary?: string; lines: { speaker: string; text: string }[] }) {
  const s = await settings();
  if (!s.token) throw new Error("Set the local token in the popup first");
  const res = await fetch(`${s.serverUrl || SERVER_DEFAULT}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-standin-token": s.token },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`backend /summarize returned ${res.status}`);
  return ((await res.json()) as { summary: string }).summary;
}

/** Side call: "is the latest line meant for the delegate?" (text only, via the local backend). */
async function decide(params: { system: string; input: string }) {
  const s = await settings();
  if (!s.token) throw new Error("Set the local token in the popup first");
  const res = await fetch(`${s.serverUrl || SERVER_DEFAULT}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-standin-token": s.token },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`backend /decide returned ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

// Gemini Live socket, owned here (Meet's page CSP could block it). The content script relays over a Port:
// page -> {op:"open",url,setup} | {op:"send",data} | {op:"close"}; back: {ev:"open"|"msg"|"close"|"error",data}.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "standin-live") return;
  let ws: WebSocket | undefined;
  const post = (m: unknown) => {
    try {
      port.postMessage(m);
    } catch {
      /* port closed */
    }
  };
  const closeWs = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = undefined;
  };
  port.onMessage.addListener((m: { op: string; url?: string; setup?: unknown; data?: string }) => {
    if (m.op === "open" && m.url) {
      closeWs();
      const sock = (ws = new WebSocket(m.url));
      sock.onopen = () => {
        sock.send(JSON.stringify(m.setup));
        post({ ev: "open" });
      };
      sock.onmessage = async (e) => {
        const data = typeof e.data === "string" ? e.data : e.data instanceof Blob ? await e.data.text() : new TextDecoder().decode(e.data as ArrayBuffer);
        post({ ev: "msg", data });
      };
      sock.onerror = () => post({ ev: "error", data: "websocket error" });
      sock.onclose = (e) => {
        if (ws === sock) ws = undefined;
        post({ ev: "close", data: `${e.code} ${e.reason}`.trim() });
      };
    } else if (m.op === "send" && ws?.readyState === WebSocket.OPEN && typeof m.data === "string") {
      ws.send(m.data);
    } else if (m.op === "close") {
      closeWs();
    }
  });
  port.onDisconnect.addListener(closeWs);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind !== "rpc") return false;
  const run =
    msg.method === "mint"
      ? mint(msg.params)
      : msg.method === "decide"
        ? decide(msg.params)
        : msg.method === "summarize"
          ? summarize(msg.params)
          : null;
  if (!run) {
    sendResponse({ ok: false, error: "unknown method" });
    return false;
  }
  run.then(
    (result) => sendResponse({ ok: true, result }),
    (e: Error) => sendResponse({ ok: false, error: e.message }),
  );
  return true; // async
});
