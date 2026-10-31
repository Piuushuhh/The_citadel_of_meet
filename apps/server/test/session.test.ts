import { describe, it, expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildInstructions } from "../src/session.js";

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "sk-test",
  model: "gpt-realtime",
  voice: "marin",
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

  it("mints a secret and never returns the API key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ value: "ek_abc", expires_at: 123 }), { status: 200 }));
    const app = createApp(cfg(f as never), TOKEN);
    const r = await app.request("/session", { method: "POST", headers: H, body: JSON.stringify({ name: "Sam" }) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("ek_abc");
    expect(text).not.toContain("sk-test");
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.session.instructions).toContain("AI delegate for Sam");
    expect(sent.session.audio.input.turn_detection.create_response).toBe(false);
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
});
