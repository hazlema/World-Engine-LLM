import { GoogleGenAI } from "@google/genai";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const ENDPOINT = `${LM_STUDIO_URL.replace(/\/$/, "")}/v1/chat/completions`;
console.log(`[api] local endpoint: ${ENDPOINT}`);
// google/gemma-3-12b
// Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF
const NARRATOR_MODEL = "google/gemma-3-12b";
const ARCHIVIST_MODEL = "google/gemma-3-12b";
const TIMEOUT_MS = 30_000;
const ARCHIVIST_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2500;
// Grows with threads/entries; 2500 gives headroom for 30+ established + 15 loose
const ARCHIVIST_MAX_TOKENS = 2500;
const ARCHIVIST_RETRIES = 3;

// Narrator can be routed to Gemini for richer prose. Archivist + interpreter
// always use the local model (structured-extraction tasks where Gemma is fine).
const NARRATOR_PROVIDER = (process.env.NARRATOR_PROVIDER ?? "local").toLowerCase();
const NARRATOR_GEMINI_MODEL = process.env.NARRATOR_GEMINI_MODEL ?? "gemini-2.5-flash";
console.log(`[api] narrator provider: ${NARRATOR_PROVIDER}${NARRATOR_PROVIDER === "gemini" ? ` (${NARRATOR_GEMINI_MODEL})` : ` (${NARRATOR_MODEL})`}`);

const INTERPRETER_MODEL = "google/gemma-3-12b";
const INTERPRETER_PROVIDER = (process.env.INTERPRETER_PROVIDER ?? "local").toLowerCase();
const INTERPRETER_GEMINI_MODEL = process.env.INTERPRETER_GEMINI_MODEL ?? "gemini-2.5-flash";
console.log(`[api] interpreter provider: ${INTERPRETER_PROVIDER}${INTERPRETER_PROVIDER === "gemini" ? ` (${INTERPRETER_GEMINI_MODEL})` : ` (${INTERPRETER_MODEL})`}`);

interface CompletionsResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
  }>;
}

async function callNarratorGemini(systemPrompt: string, input: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set (required for NARRATOR_PROVIDER=gemini)");

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: NARRATOR_GEMINI_MODEL,
    contents: [{ parts: [{ text: input }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0.95,
      maxOutputTokens: MAX_TOKENS,
      // 2.5 Flash defaults to thinking mode which burns the token budget
      // on scratchpad and returns empty content (see thinking-models memory).
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("Empty response from Gemini narrator");
  return text;
}

async function callInterpreterGemini<T>(
  systemPrompt: string,
  input: string,
  schema: object
): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set (required for INTERPRETER_PROVIDER=gemini)");

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: INTERPRETER_GEMINI_MODEL,
    contents: [{ parts: [{ text: input }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0,
      maxOutputTokens: 64,
      responseMimeType: "application/json",
      responseSchema: schema,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("Empty response from Gemini interpreter");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from Gemini interpreter: ${text}`);
  }
}

export async function callInterpreterStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  if (INTERPRETER_PROVIDER === "gemini") {
    return callInterpreterGemini<T>(systemPrompt, input, schema);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: INTERPRETER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
        max_tokens: 64,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let outer: CompletionsResponse;
    try {
      outer = JSON.parse(rawText);
    } catch {
      console.error("[api] raw interpreter response:", rawText);
      throw new Error("Invalid JSON from interpreter API");
    }

    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.reasoning_content || msg?.content || "").trim();
    if (!raw) throw new Error("No content in interpreter response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      console.error("[api] raw interpreter content:", raw);
      throw new Error("Invalid JSON in interpreter response content");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Interpreter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(systemPrompt: string, input: string): Promise<string> {
  if (NARRATOR_PROVIDER === "gemini") return callNarratorGemini(systemPrompt, input);

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
