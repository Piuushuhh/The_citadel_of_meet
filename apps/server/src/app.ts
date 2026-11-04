import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { mintClientSecret, parseSessionRequest, type ServerConfig } from "./session.js";
import { PDF_MAX_BYTES, pdfToText } from "./extract.js";
import { parseSummarizeRequest, summarize } from "./summarize.js";

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(cfg: ServerConfig, localToken: string) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/session", async (c) => {
    if (!tokenOk(c.req.header("x-standin-token"), localToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let req;
    try {
      req = parseSessionRequest(await c.req.json());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      return c.json(await mintClientSecret(cfg, req));
    } catch (e) {
      console.error(e);
      return c.json({ error: "upstream session creation failed" }, 502);
    }
  });
  // Running meeting summary for the extension's meeting memory.
  app.post("/summarize", async (c) => {
    if (!tokenOk(c.req.header("x-standin-token"), localToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let req;
    try {
      req = parseSummarizeRequest(await c.req.json());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      return c.json({ summary: await summarize({ apiKey: cfg.apiKey, model: cfg.summaryModel ?? "gpt-4.1-mini", fetchImpl: cfg.fetchImpl }, req) });
    } catch (e) {
      console.error(e);
      return c.json({ error: "summary failed" }, 502);
    }
  });
  // PDF -> text for the popup's "About you" upload. Local only; the PDF is not stored or sent anywhere.
  app.post("/extract-pdf", async (c) => {
    if (!tokenOk(c.req.header("x-standin-token"), localToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
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
