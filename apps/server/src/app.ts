import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { mintClientSecret, parseSessionRequest, type ServerConfig } from "./session.js";

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
  return app;
}
