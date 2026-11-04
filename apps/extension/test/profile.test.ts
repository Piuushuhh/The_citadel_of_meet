import { describe, expect, it } from "vitest";
import { PROFILE_MAX_CHARS, appendProfile, profileFileKind } from "../src/profile";

describe("profileFileKind", () => {
  it("accepts PDF, Markdown and plain text", () => {
    expect(profileFileKind("cv.pdf", "application/pdf")).toBe("pdf");
    expect(profileFileKind("CV.PDF", "")).toBe("pdf");
    expect(profileFileKind("about.md", "")).toBe("text");
    expect(profileFileKind("notes.markdown", "")).toBe("text");
    expect(profileFileKind("bio.txt", "text/plain")).toBe("text");
  });

  it("rejects other files", () => {
    expect(profileFileKind("photo.png", "image/png")).toBeUndefined();
    expect(profileFileKind("deck.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeUndefined();
  });
});

describe("appendProfile", () => {
  it("labels an upload and keeps what was typed before it", () => {
    expect(appendProfile("I lead the Falcon team.", "cv.pdf", "Sam Rane\r\nEngineer").text).toBe(
      "I lead the Falcon team.\n\n--- cv.pdf ---\nSam Rane\nEngineer",
    );
  });

  it("works on an empty profile", () => {
    expect(appendProfile("  ", "about.md", "# Sam").text).toBe("--- about.md ---\n# Sam");
  });

  it("caps the total length and says so", () => {
    const r = appendProfile("", "big.pdf", "x".repeat(PROFILE_MAX_CHARS * 2));
    expect(r.text).toHaveLength(PROFILE_MAX_CHARS);
    expect(r.truncated).toBe(true);
  });
});
