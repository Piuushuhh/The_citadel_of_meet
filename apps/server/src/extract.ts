import { extractText, getDocumentProxy } from "unpdf";

/** Uploaded PDFs larger than this are refused (the text is capped far lower anyway). */
export const PDF_MAX_BYTES = 15 * 1024 * 1024;

/** Extract plain text from a PDF, pages separated by blank lines. Throws on non-PDF input. */
export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("not a PDF file");
  }
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { text: text.map((p) => p.trim()).filter(Boolean).join("\n\n"), pages: totalPages };
}
