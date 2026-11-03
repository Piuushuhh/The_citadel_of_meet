import type { StatusMsg } from "./protocol";

export type StartupPhase = "idle" | "starting" | "ready" | "failed";

/** A session is ready only after both the Realtime peer and event channel are open. */
export function startupPhase(status: StatusMsg): StartupPhase {
  if (status.debug?.pc === "connected" && status.debug.dc === "open") return "ready";
  if (status.state === "connecting") return "starting";
  if (status.state === "needs-user" || status.state === "disconnected") return "failed";
  if (status.state === "idle") return "idle";
  return "starting";
}

export function startupError(status: StatusMsg): string {
  return status.detail || (status.state === "disconnected" ? "Voice connection disconnected" : "Session startup failed");
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
