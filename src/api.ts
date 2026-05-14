import { type Config, type StageConfig, loadConfig } from "./config";

// Lazy module-level Config cache. First call lazy-loads from process.env.
// Tests call resetConfigForTesting() between cases to pick up new env values.
let _config: Config | null = null;
function config(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}

export function resetConfigForTesting(): void {
  _config = null;
}

const TIMEOUT_MS = 30_000;
const ARCHIVIST_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2500;
const ARCHIVIST_MAX_TOKENS = 2500;
const ARCHIVIST_RETRIES = 3;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function endpoint(): string {
  return `${config().lmStudioUrl.replace(/\/$/, "")}/v1/chat/completions`;
}

function logStage(job: string, stage: StageConfig): void {
  const where = stage.provider === "openrouter" ? "openrouter" : "local";
  const tempPart = stage.temperature !== undefined ? ` [temp=${stage.temperature}]` : "";
  const topPart = stage.topP !== undefined ? ` [top_p=${stage.topP}]` : "";
  console.log(`[api] [${job}] [${where}] [${stage.model}]${tempPart}${topPart}`);
}

/**
 * Print the resolved provider/model for each stage at startup.
 * Called from src/server.ts:main() after loadConfig(). Safe to call multiple
 * times — it just prints. resetConfigForTesting() does not clear this side
 * effect because it has no persistent state.
 */
export function logStartupRouting(): void {
  const c = config();
  logStage("narrator", c.narrator);
  logStage("archivist", c.archivist);
  logStage("interpreter", c.interpreter);
  if (
    c.narrator.provider === "local" ||
    c.archivist.provider === "local" ||
    c.interpreter.provider === "local"
  ) {
    console.log(`[api] local endpoint: ${endpoint()}`);
  }
}

interface CompletionsResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
  }>;
}

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/hazlema/World-Engine-LLM",
    "X-Title": "World Engine LLM",
  };
}

async function callOpenRouterChat(
  stage: StageConfig,
  apiKey: string,
  systemPrompt: string,
  input: string,
  maxTokens: number,
  timeoutMs: number,
  structuredSchema?: { name: string; schema: object },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: stage.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      max_tokens: maxTokens,
    };
    if (stage.temperature !== undefined) body.temperature = stage.temperature;
    if (stage.topP !== undefined) body.top_p = stage.topP;
    if (structuredSchema) {
      body.response_format = { type: "json_schema", json_schema: structuredSchema };
    }
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (res.status === 429) {
      throw new Error(`OpenRouter rate limit hit — wait a minute or add credits. (${rawText})`);
    }
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${rawText}`);

    const data = JSON.parse(rawText) as CompletionsResponse;
    const msg = data.choices?.[0]?.message;
    const content = (msg?.content || msg?.reasoning_content || "").trim();
    if (!content) throw new Error("Empty response from OpenRouter");
    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("OpenRouter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callLocalChat(
  stage: StageConfig,
  systemPrompt: string,
  input: string,
  maxTokens: number,
  timeoutMs: number,
  structuredSchema?: { name: string; schema: object },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: stage.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      max_tokens: maxTokens,
    };
    if (stage.temperature !== undefined) body.temperature = stage.temperature;
    if (stage.topP !== undefined) body.top_p = stage.topP;
    if (structuredSchema) {
      body.response_format = { type: "json_schema", json_schema: structuredSchema };
    }
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let data: CompletionsResponse;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error("[api] raw response:", rawText);
      throw new Error("Invalid JSON from local API");
    }

    const msg = data.choices?.[0]?.message;
    const content = (msg?.content || msg?.reasoning_content || "").trim();
    if (!content) throw new Error("No content in response");
    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Public entry points ---

export async function callModel(systemPrompt: string, input: string): Promise<string> {
  const c = config();
  const stage = c.narrator;
  if (stage.provider === "openrouter") {
    if (!c.openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");
    return callOpenRouterChat(stage, c.openRouterApiKey, systemPrompt, input, MAX_TOKENS, TIMEOUT_MS);
  }
  return callLocalChat(stage, systemPrompt, input, MAX_TOKENS, TIMEOUT_MS);
}

export async function callInterpreterStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object,
): Promise<T> {
  const c = config();
  const stage = c.interpreter;
  const structuredSchema = { name: schemaName, schema };
  let raw: string;
  if (stage.provider === "openrouter") {
    if (!c.openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");
    raw = await callOpenRouterChat(
      stage, c.openRouterApiKey, systemPrompt, input, 64, TIMEOUT_MS, structuredSchema,
    );
  } else {
    raw = await callLocalChat(stage, systemPrompt, input, 64, TIMEOUT_MS, structuredSchema);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON from interpreter: ${raw}`);
  }
}

async function callModelStructuredOnce<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object,
): Promise<T> {
  const c = config();
  const stage = c.archivist;
  const structuredSchema = { name: schemaName, schema };
  let raw: string;
  if (stage.provider === "openrouter") {
    if (!c.openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");
    raw = await callOpenRouterChat(
      stage, c.openRouterApiKey, systemPrompt, input, ARCHIVIST_MAX_TOKENS, ARCHIVIST_TIMEOUT_MS, structuredSchema,
    );
  } else {
    raw = await callLocalChat(
      stage, systemPrompt, input, ARCHIVIST_MAX_TOKENS, ARCHIVIST_TIMEOUT_MS, structuredSchema,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON from archivist: ${raw}`);
  }
}

export async function callModelStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object,
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

