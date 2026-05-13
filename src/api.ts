import { GoogleGenAI } from "@google/genai";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const ENDPOINT = `${LM_STUDIO_URL.replace(/\/$/, "")}/v1/chat/completions`;
console.log(`[api] local endpoint: ${ENDPOINT}`);
// Local model id sent to LM Studio. Override with LOCAL_MODEL=... for all
// local stages, or with per-stage LOCAL_NARRATOR_MODEL / LOCAL_ARCHIVIST_MODEL
// / LOCAL_INTERPRETER_MODEL for finer routing. Each id must match what LM
// Studio reports at /v1/models (e.g. "google/gemma-3-12b", "mistralai/ministral-3-3b").
const LOCAL_MODEL = process.env.LOCAL_MODEL ?? "google/gemma-3-12b";
const NARRATOR_MODEL = process.env.LOCAL_NARRATOR_MODEL ?? LOCAL_MODEL;
const ARCHIVIST_MODEL = process.env.LOCAL_ARCHIVIST_MODEL ?? LOCAL_MODEL;
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

const INTERPRETER_MODEL = process.env.LOCAL_INTERPRETER_MODEL ?? LOCAL_MODEL;
const INTERPRETER_PROVIDER = (process.env.INTERPRETER_PROVIDER ?? "local").toLowerCase();
const INTERPRETER_GEMINI_MODEL = process.env.INTERPRETER_GEMINI_MODEL ?? "gemini-2.5-flash";

// Per-stage sampling for LOCAL calls. Temperature defaults preserve previous
// behavior; top_p is undefined unless explicitly set (LM Studio default kicks in).
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
function envFloatOpt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}
const LOCAL_NARRATOR_TEMP    = envFloat("LOCAL_NARRATOR_TEMP", 0.95);
const LOCAL_ARCHIVIST_TEMP   = envFloat("LOCAL_ARCHIVIST_TEMP", 0.5);
const LOCAL_INTERPRETER_TEMP = envFloat("LOCAL_INTERPRETER_TEMP", 0);
const LOCAL_NARRATOR_TOP_P    = envFloatOpt("LOCAL_NARRATOR_TOP_P");
const LOCAL_ARCHIVIST_TOP_P   = envFloatOpt("LOCAL_ARCHIVIST_TOP_P");
const LOCAL_INTERPRETER_TOP_P = envFloatOpt("LOCAL_INTERPRETER_TOP_P");

function logStage(job: string, provider: string, model: string, temp?: number, topP?: number): void {
  const where = provider === "gemini" ? "remote" : "local";
  const tempPart = where === "local" && temp !== undefined ? ` [temp=${temp}]` : "";
  const topPart = where === "local" && topP !== undefined ? ` [top_p=${topP}]` : "";
  console.log(`[api] [${job}] [${where}] [${model}]${tempPart}${topPart}`);
}
logStage(
  "narrator",
  NARRATOR_PROVIDER,
  NARRATOR_PROVIDER === "gemini" ? NARRATOR_GEMINI_MODEL : NARRATOR_MODEL,
  LOCAL_NARRATOR_TEMP,
  LOCAL_NARRATOR_TOP_P,
);
logStage("archivist", "local", ARCHIVIST_MODEL, LOCAL_ARCHIVIST_TEMP, LOCAL_ARCHIVIST_TOP_P);
logStage(
  "interpreter",
  INTERPRETER_PROVIDER,
  INTERPRETER_PROVIDER === "gemini" ? INTERPRETER_GEMINI_MODEL : INTERPRETER_MODEL,
  LOCAL_INTERPRETER_TEMP,
  LOCAL_INTERPRETER_TOP_P,
);

// Validation is exported (rather than run at module load) so tests can
// import this module without process.exit firing on a real-but-test-broken
// .env. Call from the actual server entry point (src/server.ts main()).
export function validateApiConfig(): void {
  const VALID_PROVIDERS = ["local", "gemini"];
  for (const [name, value] of [
    ["NARRATOR_PROVIDER", NARRATOR_PROVIDER],
    ["INTERPRETER_PROVIDER", INTERPRETER_PROVIDER],
  ] as const) {
    if (!VALID_PROVIDERS.includes(value)) {
      console.error(`[api] ${name}="${value}" is invalid. Must be "local" or "gemini".`);
      console.error(`[api] (If you meant to pick a local model id, use LOCAL_MODEL or LOCAL_${name.replace("_PROVIDER", "_MODEL")} instead.)`);
      process.exit(1);
    }
  }

  const geminiNeeded = NARRATOR_PROVIDER === "gemini" || INTERPRETER_PROVIDER === "gemini";
  if (geminiNeeded && !process.env.GEMINI_API_KEY) {
    const stages = [
      NARRATOR_PROVIDER === "gemini" ? "NARRATOR_PROVIDER=gemini" : null,
      INTERPRETER_PROVIDER === "gemini" ? "INTERPRETER_PROVIDER=gemini" : null,
    ].filter(Boolean).join(" and ");
    console.error(`[api] ${stages} but GEMINI_API_KEY is not set.`);
    console.error(`[api] Either set GEMINI_API_KEY in .env, or switch to local (the default).`);
    process.exit(1);
  }
}

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
        temperature: LOCAL_INTERPRETER_TEMP,
        ...(LOCAL_INTERPRETER_TOP_P !== undefined ? { top_p: LOCAL_INTERPRETER_TOP_P } : {}),
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

  // Nvidia's Nemotron family uses an in-prompt directive to control its
  // chain-of-thought ("detailed thinking on/off"). The API-level reasoning
  // hint below is not enough on its own — the directive must appear in the
  // system prompt for Nemotron to honor it. Other model families ignore it.
  const isNemotron = NARRATOR_MODEL.startsWith("nvidia/nemotron-");
  const effectiveSystem = isNemotron
    ? `detailed thinking off\n\n${systemPrompt}`
    : systemPrompt;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NARRATOR_MODEL,
        messages: [
          { role: "system", content: effectiveSystem },
          { role: "user", content: input },
        ],
        reasoning: { effort: "off" },
        max_tokens: MAX_TOKENS,
        temperature: LOCAL_NARRATOR_TEMP,
        ...(LOCAL_NARRATOR_TOP_P !== undefined ? { top_p: LOCAL_NARRATOR_TOP_P } : {}),
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
        temperature: LOCAL_ARCHIVIST_TEMP,
        ...(LOCAL_ARCHIVIST_TOP_P !== undefined ? { top_p: LOCAL_ARCHIVIST_TOP_P } : {}),
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
