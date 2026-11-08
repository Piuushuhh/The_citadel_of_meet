import { Hono, type Context } from "hono";
import { mintClientSecret, parseSessionRequest, type ServerConfig } from "./session.js";
import { PDF_MAX_BYTES, pdfToText } from "./extract.js";
import { geminiText, parseSummarizeRequest, summarize } from "./summarize.js";
import { listModels } from "./models.js";

/**
 * There is no shared secret any more. The user's Gemini key lives in the extension and arrives with each
 * request (`x-gemini-key`); this server stores nothing. Browser pages from the web are refused: a browser
 * always sends an Origin on cross-site requests, and only the extension's own origin is accepted.
 * (Requests with no Origin, e.g. curl on this machine, are allowed: the server only listens on loopback.)
 */
function originOk(c: Context): boolean {
  const origin = c.req.header("origin");
  return !origin || origin.startsWith("chrome-extension://");
}

const MODEL_RE = /^[A-Za-z0-9._-]{1,100}$/;
const pick = (v: unknown, fallback: string) => (typeof v === "string" && MODEL_RE.test(v) ? v : fallback);

/** Map an upstream failure to a response that helps without leaking upstream detail. */
function upstreamError(c: Context, e: unknown, what: string) {
  console.error(e);
  const status = /failed: (\d{3})/.exec((e as Error).message ?? "")?.[1];
  if (status === "400" || status === "401" || status === "403") {
    return c.json({ error: "Gemini rejected the API key or model. Check them in the popup." }, 401);
  }
  return c.json({ error: what }, 502);
}

export function createApp(cfg: ServerConfig) {
  const app = new Hono();

  /** Per-request config: the caller's key and model choices over the server defaults. */
  const requestCfg = (c: Context, body?: Record<string, unknown>): ServerConfig | Response => {
    const apiKey = (c.req.header("x-gemini-key") ?? "").trim() || cfg.apiKey;
    if (!apiKey) return c.json({ error: "Enter your Gemini API key in the popup first." }, 401);
    return {
      ...cfg,
      apiKey,
      model: pick(body?.liveModel ?? c.req.header("x-live-model"), cfg.model),
      voice: pick(body?.voice ?? c.req.header("x-live-voice"), cfg.voice),
      summaryModel: pick(body?.textModel ?? c.req.header("x-text-model"), cfg.summaryModel ?? "gemini-2.5-flash"),
    };
  };

  app.use("*", async (c, next) => {
    if (!originOk(c)) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // The models this key can use, for the popup's pickers.
  app.get("/models", async (c) => {
    const r = requestCfg(c);
    if (r instanceof Response) return r;
    try {
      return c.json(await listModels(r.apiKey, cfg.fetchImpl));
    } catch (e) {
      return upstreamError(c, e, "could not list models");
    }
  });

  app.post("/session", async (c) => {
    let body: Record<string, unknown>;
    let req;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
      req = parseSessionRequest(body);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const r = requestCfg(c, body);
    if (r instanceof Response) return r;
    try {
      return c.json(await mintClientSecret(r, req));
    } catch (e) {
      return upstreamError(c, e, "upstream session creation failed");
    }
  });

  // Running meeting summary for the extension's meeting memory.
  app.post("/summarize", async (c) => {
    let body: Record<string, unknown>;
    let req;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
      req = parseSummarizeRequest(body);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const r = requestCfg(c, body);
    if (r instanceof Response) return r;
    try {
      return c.json({ summary: await summarize({ apiKey: r.apiKey, model: r.summaryModel!, fetchImpl: cfg.fetchImpl }, req) });
    } catch (e) {
      return upstreamError(c, e, "summary failed");
    }
  });

  // "Is the latest line meant for the delegate?" Text-only side call; the extension builds the prompt and parses the answer.
  app.post("/decide", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof b?.system !== "string" || typeof b.input !== "string" || b.system.length > 4000 || b.input.length > 8000) {
      return c.json({ error: "invalid body" }, 400);
    }
    const r = requestCfg(c, b);
    if (r instanceof Response) return r;
    try {
      return c.json({ text: await geminiText({ apiKey: r.apiKey, model: r.summaryModel!, fetchImpl: cfg.fetchImpl }, b.system, b.input) });
    } catch (e) {
      return upstreamError(c, e, "decision failed");
    }
  });

  // PDF -> text for the popup's "About you" upload. Local only; the PDF is not stored or sent anywhere.
  app.post("/extract-pdf", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > PDF_MAX_BYTES) return c.json({ error: "PDF is too large (max 15 MB)" }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > PDF_MAX_BYTES) return c.json({ error: "PDF is too large (max 15 MB)" }, 413);
    try {
      const { text, pages } = await pdfToText(bytes);
      if (!text) return c.json({ error: "No text found in this PDF (is it a scanned image?)" }, 422);
      return c.json({ text, pages });
    } catch (e) {
      return c.json({ error: `Could not read PDF: ${(e as Error).message}` }, 400);
    }
  });
  return app;
}
