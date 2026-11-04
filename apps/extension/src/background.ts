// Service worker: the only place that talks to the local backend and OpenAI SDP endpoint.
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

async function sdp(params: { offer: string; secret: string; model: string }) {
  const res = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(params.model)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.secret}`, "Content-Type": "application/sdp" },
    body: params.offer,
  });
  if (!res.ok) throw new Error(`realtime/calls returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind !== "rpc") return false;
  const run =
    msg.method === "mint"
      ? mint(msg.params)
      : msg.method === "sdp"
        ? sdp(msg.params)
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
