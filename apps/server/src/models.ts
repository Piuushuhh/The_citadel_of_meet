// Which Gemini models a given API key can use, for the popup's model pickers.

export interface ModelChoices {
  /** Models for the live voice session (bidiGenerateContent). */
  live: string[];
  /** Models for summaries and the "is this meant for me" check (generateContent, text-capable). */
  text: string[];
}

interface ModelInfo {
  name: string;
  supportedGenerationMethods?: string[];
}

export async function listModels(apiKey: string, fetchImpl?: typeof fetch): Promise<ModelChoices> {
  const f = fetchImpl ?? fetch;
  const res = await f("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Gemini models failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { models?: ModelInfo[] };
  const live: string[] = [];
  const text: string[] = [];
  for (const m of data.models ?? []) {
    const id = m.name.replace(/^models\//, "");
    const methods = m.supportedGenerationMethods ?? [];
    if (methods.includes("bidiGenerateContent")) {
      // Only audio-capable conversation models: not transcribe/translate/robotics variants.
      if (/live|native-audio/.test(id) && !/transcribe|translate|robotics/.test(id)) live.push(id);
    } else if (methods.includes("generateContent") && /^gemini-/.test(id) && !/tts|image|audio|embedding|live|robotics|computer-use|vision/.test(id)) {
      text.push(id);
    }
  }
  return { live: live.sort(), text: text.sort() };
}
