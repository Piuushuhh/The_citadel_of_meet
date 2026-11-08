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
const H = { "x-gemini-key": "user-key" };

describe("POST /session", () => {
  it("refuses web-page origins and requests with no key", async () => {
    const noKeyCfg = { ...cfg(vi.fn() as never), apiKey: "" };
    const app = createApp(noKeyCfg);
    const noKey = await app.request("/session", { method: "POST", body: JSON.stringify({ name: "Sam" }) });
    expect(noKey.status).toBe(401);
    const web = await app.request("/session", { method: "POST", headers: { ...H, origin: "https://evil.example" }, body: JSON.stringify({ name: "Sam" }) });
    expect(web.status).toBe(403);
    const ext = await app.request("/session", { method: "POST", headers: { ...H, origin: "chrome-extension://abc" }, body: "{}" });
    expect(ext.status).toBe(400); // got past the origin check; the body is missing a name
  });

  it("requires a name", async () => {
    const app = createApp(cfg(vi.fn() as never));
    const r = await app.request("/session", { method: "POST", headers: H, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("mints an ephemeral token and never returns the API key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/abc" }), { status: 200 }));
    const app = createApp(cfg(f as never));
    const r = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam" }) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("auth_tokens%2Fabc");
    expect(text).not.toContain("gk-test");
    expect(text).not.toContain("user-key");
    const body = JSON.parse(text);
    expect(body.url).toMatch(/^wss:\/\/generativelanguage\.googleapis\.com\//);
    expect(body.setup.setup.model).toBe("models/live-model");
    expect(body.setup.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(body.setup.setup.systemInstruction.parts[0].text).toContain("AI delegate for Sam");
    expect(body.setup.setup.systemInstruction.parts[0].text).toContain("[Meet caption]");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("user-key"); // the caller's key wins over the server default
  });

  it("uses the model and voice the caller chose", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/abc" }), { status: 200 }));
    const app = createApp(cfg(f as never));
    const r = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam", liveModel: "gemini-3.8-live", voice: "Kore" }) });
    const body = await r.json();
    expect(body.setup.setup.model).toBe("models/gemini-3.8-live");
    expect(body.setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    const bad = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam", liveModel: "x/../y" }) });
    expect((await bad.json()).setup.setup.model).toBe("models/live-model"); // invalid names fall back to the default
  });

  it("returns 502 without leaking upstream detail", async () => {
    const f = vi.fn(async () => new Response("secret upstream detail", { status: 500 }));
    const app = createApp(cfg(f as never));
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
