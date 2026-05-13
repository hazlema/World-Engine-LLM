import { test, expect, describe, beforeEach } from "bun:test";
import { parseConfig, type Config, type ParseResult } from "./config";

// Every test gets a clean env slate. The full list of env vars config.ts
// reads — anything new added later must be cleared here too.
const ENV_KEYS = [
  "LM_STUDIO_URL",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "NARRATOR_PROVIDER",
  "ARCHIVIST_PROVIDER",
  "INTERPRETER_PROVIDER",
  "USE_GEMINI_IMAGES",
  "USE_GEMINI_NARRATION",
  "LOCAL_NARRATOR_TEMP",
  "LOCAL_ARCHIVIST_TEMP",
  "LOCAL_INTERPRETER_TEMP",
  "LOCAL_NARRATOR_TOP_P",
  "LOCAL_ARCHIVIST_TOP_P",
  "LOCAL_INTERPRETER_TOP_P",
];

function makeEnv(overrides: Record<string, string>): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) base[k] = undefined;
  return { ...base, ...overrides };
}

function validMinimalEnv(): Record<string, string | undefined> {
  return makeEnv({
    NARRATOR_PROVIDER: "local,nvidia/nemotron-3-nano",
    ARCHIVIST_PROVIDER: "local,nvidia/nemotron-3-nano",
    INTERPRETER_PROVIDER: "local,nvidia/nemotron-3-nano",
  });
}

describe("parseConfig — shape", () => {
  test("returns ok:true with a Config for a valid minimal env", () => {
    const result = parseConfig(validMinimalEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.narrator.provider).toBe("local");
    expect(result.config.narrator.model).toBe("nvidia/nemotron-3-nano");
    expect(result.config.lmStudioUrl).toBe("http://localhost:1234");
    expect(result.config.useGeminiImages).toBe(false);
    expect(result.config.useGeminiNarration).toBe(false);
  });
});
