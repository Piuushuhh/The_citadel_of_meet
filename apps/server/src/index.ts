import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import { createApp } from "./app.js";

const apiKey = process.env.OPENAI_API_KEY ?? "";
const localToken = process.env.STANDIN_LOCAL_TOKEN ?? "";
if (!apiKey) throw new Error("OPENAI_API_KEY is not set (backend only)");
if (localToken.length < 16) throw new Error("STANDIN_LOCAL_TOKEN must be at least 16 chars");

const kpath = new URL("../knowledge.test.md", import.meta.url);
const knowledge = existsSync(kpath) ? readFileSync(kpath, "utf8") : "";

const app = createApp(
  {
    apiKey,
    model: process.env.REALTIME_MODEL ?? "gpt-realtime",
    voice: process.env.REALTIME_VOICE ?? "marin",
    knowledge,
  },
  localToken,
);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`Stand-In server on http://127.0.0.1:${port} (loopback only)`);
