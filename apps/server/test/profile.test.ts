import { describe, it, expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import { PROFILE_MAX_CHARS, buildInstructions, parseSessionRequest } from "../src/session.js";

const H = {};
const app = () =>
  createApp({ apiKey: "gk-test", model: "live-model", voice: "Puck", knowledge: "K", fetchImpl: vi.fn() as never });

/** A minimal valid one-page PDF containing `text` (xref offsets computed so pdf.js accepts it). */
function makePdf(text: string): Blob {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: "application/pdf" });
}

describe("profile (About you)", () => {
  it("keeps line breaks and caps the length", () => {
    const r = parseSessionRequest({ name: "Sam", profile: "Line 1\r\nLine 2\n\n\n\nLine 3" });
    expect(r.profile).toBe("Line 1\nLine 2\n\nLine 3");
    expect(parseSessionRequest({ name: "Sam", profile: "x".repeat(PROFILE_MAX_CHARS + 500) }).profile).toHaveLength(PROFILE_MAX_CHARS);
    expect(parseSessionRequest({ name: "Sam", profile: "   " }).profile).toBeUndefined();
  });

  it("adds a delimited About section that keeps the delegate identity", () => {
    const s = buildInstructions({ name: "Sam", profile: "Sam leads the Falcon team." }, "K");
    expect(s).toContain("=== ABOUT SAM");
    expect(s).toContain("Sam leads the Falcon team.");
    expect(s).toContain("=== END ABOUT SAM ===");
    expect(s).toContain("never Sam");
    // Identity and rules come before the user-supplied text.
    expect(s.indexOf("AI delegate for Sam")).toBeLessThan(s.indexOf("Sam leads the Falcon team."));
  });

  it("omits the section when there is no profile", () => {
    expect(buildInstructions({ name: "Sam" }, "K")).not.toContain("=== ABOUT");
  });
});

describe("POST /extract-pdf", () => {
  it("refuses requests from web pages (only the extension origin is allowed)", async () => {
    const r = await app().request("/extract-pdf", { method: "POST", headers: { origin: "https://evil.example" }, body: makePdf("Hi") });
    expect(r.status).toBe(403);
  });

  it("extracts text from a real PDF", async () => {
    const r = await app().request("/extract-pdf", { method: "POST", headers: { ...H, "content-type": "application/pdf" }, body: makePdf("Sam leads the Falcon team") });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { text: string; pages: number };
    expect(j.text).toContain("Sam leads the Falcon team");
    expect(j.pages).toBe(1);
  });

  it("rejects files that are not PDFs", async () => {
    const r = await app().request("/extract-pdf", { method: "POST", headers: H, body: "# just markdown" });
    expect(r.status).toBe(400);
  });
});
