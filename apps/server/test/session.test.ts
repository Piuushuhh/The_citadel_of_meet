import { describe, it, expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildInstructions } from "../src/session.js";

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "gk-test",
  model: "live-model",
  voice: "Puck",
  knowledge: "Launch is March 14.",
  fetchImpl,
});
const TOKEN = "a".repeat(20);
const H = { "x-standin-token": TOKEN };

describe("POST /session", () => {
  it("rejects missing or wrong token", async () => {
    const app = createApp(cfg(vi.fn() as never), TOKEN);
    const r = await app.request("/session", { method: "POST", body: JSON.stringify({ name: "Sam" }) });
    expect(r.status).toBe(401);
    const r2 = await app.request("/session", {
      method: "POST",
      headers: { "x-standin-token": "b".repeat(20) },
      body: "{}",
    });
    expect(r2.status).toBe(401);
  });

  it("requires a name", async () => {
    const app = createApp(cfg(vi.fn() as never), TOKEN);
    const r = await app.request("/session", { method: "POST", headers: H, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("mints an ephemeral token and never returns the API key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/abc" }), { status: 200 }));
    const app = createApp(cfg(f as never), TOKEN);
    const r = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam" }) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("auth_tokens%2Fabc");
    expect(text).not.toContain("gk-test");
    const body = JSON.parse(text);
    expect(body.url).toMatch(/^wss:\/\/generativelanguage\.googleapis\.com\//);
    expect(body.setup.setup.model).toBe("models/live-model");
    expect(body.setup.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(body.setup.setup.systemInstruction.parts[0].text).toContain("AI delegate for Sam");
    expect(body.setup.setup.systemInstruction.parts[0].text).toContain("[Meet caption]");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gk-test");
  });

  it("returns 502 without leaking upstream detail", async () => {
    const f = vi.fn(async () => new Response("secret upstream detail", { status: 500 }));
    const app = createApp(cfg(f as never), TOKEN);
    const r = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam" }) });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("upstream detail");
  });
});

describe("instructions", () => {
  it("contains guardrails and delimits knowledge", () => {
    const s = buildInstructions({ name: "Sam" }, "X");
    expect(s).toContain("untrusted");
    expect(s).toContain("=== APPROVED KNOWLEDGE ===");
  });

  it("tells the model to keep meeting context and trust caption text", () => {
    const s = buildInstructions({ name: "Sam" }, "X");
    expect(s).toContain("whole conversation so far");
    expect(s).toContain("[Meet caption]");
  });
});
