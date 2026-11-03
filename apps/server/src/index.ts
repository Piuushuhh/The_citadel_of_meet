import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadProjectEnv } from "./env.js";

loadProjectEnv(new URL("../../../.env", import.meta.url));

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
