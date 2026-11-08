import { describe, it, expect, vi } from "vitest";
import { createApp } from "../src/app.js";

const models = [
  { name: "models/gemini-2.5-flash-native-audio-preview-12-2025", supportedGenerationMethods: ["bidiGenerateContent"] },
  { name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] },
  { name: "models/gemini-3.5-transcribe-live", supportedGenerationMethods: ["bidiGenerateContent"] },
  { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
  { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
];

describe("GET /models", () => {
  it("lists live and text models for the caller's key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ models }), { status: 200 }));
    const app = createApp({ apiKey: "", model: "m", voice: "Puck", knowledge: "", fetchImpl: f as never });
    const r = await app.request("/models", { headers: { "x-gemini-key": "user-key" } });
    expect(await r.json()).toEqual({
      live: ["gemini-2.5-flash-native-audio-preview-12-2025", "gemini-3.8-live"],
      text: ["gemini-2.5-flash"],
    });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("user-key");
  });

  it("tells the user when Gemini rejects the key", async () => {
    const f = vi.fn(async () => new Response("bad key", { status: 400 }));
    const app = createApp({ apiKey: "", model: "m", voice: "Puck", knowledge: "", fetchImpl: f as never });
    const r = await app.request("/models", { headers: { "x-gemini-key": "nope" } });
    expect(r.status).toBe(401);
  });
});
