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

describe("parseConfig — stage parsing", () => {
  test("parses simple comma form", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter,nvidia/nemotron-3-nano",
      ARCHIVIST_PROVIDER: "local,nvidia/nemotron-3-nano",
      INTERPRETER_PROVIDER: "local,nvidia/nemotron-3-nano",
      OPENROUTER_API_KEY: "or-test-key",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator).toEqual({
      provider: "openrouter",
      model: "nvidia/nemotron-3-nano",
    });
  });

  test("strips surrounding brackets", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "[openrouter, nvidia/nemotron-3-nano]",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      OPENROUTER_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator).toEqual({
      provider: "openrouter",
      model: "nvidia/nemotron-3-nano",
    });
  });

  test("trims whitespace around both halves", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "  openrouter  ,  some-model  ",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      OPENROUTER_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator).toEqual({ provider: "openrouter", model: "some-model" });
  });

  test("model with extra commas is preserved (only splits on first)", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter,vendor/model:tag,with,commas",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      OPENROUTER_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator.model).toBe("vendor/model:tag,with,commas");
  });

  test("missing NARRATOR_PROVIDER produces clear error", () => {
    const r = parseConfig(makeEnv({
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain(
      "NARRATOR_PROVIDER missing/invalid. Format: provider,model (e.g. openrouter,nvidia/nemotron-3-nano)"
    );
  });

  test("malformed (no comma) produces clear error", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes("NARRATOR_PROVIDER missing/invalid"))).toBe(true);
  });

  test("empty model half produces clear error", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter,",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes("NARRATOR_PROVIDER missing/invalid"))).toBe(true);
  });

  test("invalid provider lists the valid set", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "gemini,gemini-2.5-flash",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) =>
      e.includes("NARRATOR_PROVIDER provider \"gemini\" invalid. Must be one of: local, openrouter")
    )).toBe(true);
  });
});

describe("parseConfig — booleans", () => {
  test("USE_GEMINI_IMAGES=\"true\" is true", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "true",
      GEMINI_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiImages).toBe(true);
  });

  test("USE_GEMINI_IMAGES is case-insensitive on true", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "TRUE",
      GEMINI_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiImages).toBe(true);
  });

  test("USE_GEMINI_NARRATION=\"1\" is FALSE (strict)", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_NARRATION: "1",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiNarration).toBe(false);
  });

  test("USE_GEMINI_* unset is false", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiImages).toBe(false);
    expect(r.config.useGeminiNarration).toBe(false);
  });
});

describe("parseConfig — hidden tuning overrides", () => {
  test("LOCAL_NARRATOR_TEMP parses to a number", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      LOCAL_NARRATOR_TEMP: "0.85",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator.temperature).toBe(0.85);
  });

  test("LOCAL_NARRATOR_TOP_P parses to a number", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      LOCAL_NARRATOR_TOP_P: "0.9",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator.topP).toBe(0.9);
  });

  test("unparseable tuning value is silently undefined (not an error)", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      LOCAL_NARRATOR_TEMP: "not-a-number",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator.temperature).toBeUndefined();
  });

  test("tuning overrides apply to the correct stage", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      LOCAL_NARRATOR_TEMP: "0.95",
      LOCAL_ARCHIVIST_TEMP: "0.5",
      LOCAL_INTERPRETER_TEMP: "0",
      LOCAL_NARRATOR_TOP_P: "0.95",
      LOCAL_ARCHIVIST_TOP_P: "0.9",
      LOCAL_INTERPRETER_TOP_P: "1",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.narrator.temperature).toBe(0.95);
    expect(r.config.archivist.temperature).toBe(0.5);
    expect(r.config.interpreter.temperature).toBe(0);
    expect(r.config.narrator.topP).toBe(0.95);
    expect(r.config.archivist.topP).toBe(0.9);
    expect(r.config.interpreter.topP).toBe(1);
  });
});
