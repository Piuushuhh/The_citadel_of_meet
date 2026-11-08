// Service worker: the only place that talks to the local backend and the Gemini Live WebSocket.
// (Meet's page CSP could block these, and keeping them here keeps the page minimal.)

const SERVER_DEFAULT = "http://127.0.0.1:8787";

interface Settings {
  serverUrl?: string;
  /** The user's own Gemini API key, entered in the popup. Stored only in this browser profile. */
  apiKey?: string;
  liveModel?: string;
  textModel?: string;
  voice?: string;
  /** Let the delegate search the web for current facts. Default on. */
  webSearch?: boolean;
}

async function settings(): Promise<Settings> {
  return (await chrome.storage.local.get(["serverUrl", "apiKey", "liveModel", "textModel", "voice", "webSearch"])) as Settings;
}

/** POST to the local backend with the user's key and model choices; surfaces the backend's own error text. */
async function backend<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const s = await settings();
  if (!s.apiKey) throw new Error("Enter your Gemini API key in the popup first");
  const res = await fetch(`${s.serverUrl || SERVER_DEFAULT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gemini-key": s.apiKey },
    body: JSON.stringify({ ...body, liveModel: s.liveModel, textModel: s.textModel, voice: s.voice, webSearch: s.webSearch !== false }),
  });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(detail ?? `backend ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

async function mint(params: { name: string; style?: string }) {
  // The "About you" text is read here from extension storage, never passed through the Meet page.
  const { profile } = (await chrome.storage.local.get("profile")) as { profile?: string };
  return backend("/session", { name: params.name, style: params.style, profile: profile?.trim() || undefined });
}

/** Meeting memory: running summary via the local backend. */
async function summarize(params: { name: string; previousSummary?: string; lines: { speaker: string; text: string }[] }) {
  return (await backend<{ summary: string }>("/summarize", params)).summary;
}

/** Side call: "is the latest line meant for the delegate?" (text only, via the local backend). */
async function decide(params: { system: string; input: string }) {
  return (await backend<{ text: string }>("/decide", params)).text;
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
