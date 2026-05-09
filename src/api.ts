const ENDPOINT = "http://localhost:1234/v1/chat/completions";
// google/gemma-3-12b
// Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF
const NARRATOR_MODEL = "google/gemma-3-12b";
const ARCHIVIST_MODEL = "google/gemma-3-12b";
const TIMEOUT_MS = 30_000;
const ARCHIVIST_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 1500;
// Grows with threads/entries; 2500 gives headroom for 30+ established + 15 loose
const ARCHIVIST_MAX_TOKENS = 2500;
const ARCHIVIST_RETRIES = 3;

interface CompletionsResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
  }>;
}

export async function callModel(systemPrompt: string, input: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NARRATOR_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        reasoning: { effort: "off" },
        max_tokens: MAX_TOKENS,
        temperature: 0.95,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let data: CompletionsResponse;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error("[api] raw narrator response:", rawText);
      throw new Error("Invalid JSON from narrator API");
    }

    const msg = data.choices?.[0]?.message;
    const content = (msg?.content || msg?.reasoning_content || "").trim();
    if (!content) throw new Error("No message in response");
    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callModelStructuredOnce<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVIST_TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ARCHIVIST_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
        max_tokens: ARCHIVIST_MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let outer: CompletionsResponse;
    try {
      outer = JSON.parse(rawText);
    } catch {
      console.error("[api] raw completions response:", rawText);
      throw new Error("Invalid JSON from completions API");
    }

    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.reasoning_content || msg?.content || "").trim();
    if (!raw) throw new Error("No content in structured response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      console.error("[api] raw structured content:", raw);
      throw new Error("Invalid JSON in structured response content");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModelStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  let lastErr: Error = new Error("No attempts made");
  for (let attempt = 1; attempt <= ARCHIVIST_RETRIES; attempt++) {
    try {
      return await callModelStructuredOnce<T>(systemPrompt, input, schemaName, schema);
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[api] archivist attempt ${attempt}/${ARCHIVIST_RETRIES} failed: ${lastErr.message}`);
      if (attempt < ARCHIVIST_RETRIES) await Bun.sleep(500 * attempt);
    }
  }
  throw lastErr;
}
