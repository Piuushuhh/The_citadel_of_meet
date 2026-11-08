import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadProjectEnv } from "./env.js";

loadProjectEnv(new URL("../../../.env", import.meta.url));

const apiKey = process.env.GEMINI_API_KEY ?? "";
// The key normally comes from the extension popup with each request; GEMINI_API_KEY is only an optional fallback.

const kpath = new URL("../knowledge.test.md", import.meta.url);
const knowledge = existsSync(kpath) ? readFileSync(kpath, "utf8") : "";

const app = createApp(
  {
    apiKey,
    model: process.env.LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025",
    voice: process.env.LIVE_VOICE ?? "Puck",
    summaryModel: process.env.TEXT_MODEL || "gemini-2.5-flash",
    knowledge,
  },
);
const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Stand-In server on http://127.0.0.1:${info.port} (loopback only)`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Please terminate any conflicting process before starting.`);
  } else {
    console.error(`Server error:`, err);
  }
  process.exit(1);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
