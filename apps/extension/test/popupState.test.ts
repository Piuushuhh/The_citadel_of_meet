import { describe, expect, it, vi } from "vitest";
import { startupError, startupPhase, withTimeout } from "../src/popupState";
import type { StatusMsg } from "../src/protocol";

const status = (state: StatusMsg["state"], debug?: StatusMsg["debug"], detail?: string): StatusMsg => ({
  state,
  debug,
  detail,
});

describe("popup startup status", () => {
  it("reports Starting while the page is connecting", () => {
    expect(startupPhase(status("connecting"))).toBe("starting");
  });

  it("reports ready only when the peer and data channel are ready", () => {
    expect(startupPhase(status("thinking", { pc: "connected", dc: "open" }))).toBe("ready");
    expect(startupPhase(status("listening", { pc: "connected", dc: "connecting" }))).toBe("starting");
  });

  it("reports startup errors and preserves the useful detail", () => {
    const failure = status("needs-user", undefined, "Could not start: backend unavailable");
    expect(startupPhase(failure)).toBe("failed");
    expect(startupError(failure)).toBe("Could not start: backend unavailable");
  });

  it("provides a fallback for failures without detail", () => {
    expect(startupError(status("disconnected"))).toBe("Voice connection disconnected");
  });

  it("propagates rejected requests", async () => {
    await expect(withTimeout(Promise.reject(new Error("no receiver")), 100, "timeout")).rejects.toThrow("no receiver");
  });

  it("rejects a request that does not answer before its timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => undefined), 100, "request timed out");
      const assertion = expect(pending).rejects.toThrow("request timed out");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
