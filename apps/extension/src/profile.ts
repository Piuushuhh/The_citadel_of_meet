// "About you" context for the delegate: typed text and/or uploaded PDF / Markdown / text files.
// Stored in chrome.storage.local ("profile"); the background worker adds it to the session (server instructions).

/** Must match the server's PROFILE_MAX_CHARS (apps/server/src/session.ts). */
export const PROFILE_MAX_CHARS = 40_000;

export type ProfileFileKind = "pdf" | "text";

/** Which uploads are accepted: PDF (extracted by the local backend) and Markdown / plain text (read directly). */
export function profileFileKind(name: string, mime: string): ProfileFileKind | undefined {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown|txt)$/.test(n) || mime === "text/markdown" || mime === "text/plain") return "text";
  return undefined;
}

/**
 * Append an uploaded document to what is already there (so a typed bio and documents can be combined),
 * labelled with its file name, capped at PROFILE_MAX_CHARS.
 */
export function appendProfile(existing: string, fileName: string, text: string): { text: string; truncated: boolean } {
  const doc = text.replace(/\r\n?/g, "\n").trim();
  const block = `--- ${fileName} ---\n${doc}`;
  const combined = existing.trim() ? `${existing.trim()}\n\n${block}` : block;
  return combined.length > PROFILE_MAX_CHARS
    ? { text: combined.slice(0, PROFILE_MAX_CHARS), truncated: true }
    : { text: combined, truncated: false };
}
