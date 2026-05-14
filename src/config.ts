export type Provider = "local" | "openrouter";

export type StageConfig = {
  provider: Provider;
  model: string;
  temperature?: number;
  topP?: number;
};

export type ElevenLabsVoice = { label: string; voiceId: string };

export type Config = {
  lmStudioUrl: string;
  openRouterApiKey: string | null;
  geminiApiKey: string | null;
  narrator: StageConfig;
  archivist: StageConfig;
  interpreter: StageConfig;
  useGeminiImages: boolean;
  useNarration: boolean;
  useElevenLabs: boolean;
  elevenLabsApiKey: string | null;
  elevenLabsVoices: ElevenLabsVoice[];
  elevenLabsModel: string;
};

/**
 * Parse "label:voice_id,label:voice_id" into structured pairs. Whitespace
 * around delimiters is tolerated; malformed entries are silently skipped
 * (validation catches the empty-result case).
 */
export function parseElevenLabsVoices(raw: string | undefined): ElevenLabsVoice[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      const label = pair.slice(0, idx).trim();
      const voiceId = pair.slice(idx + 1).trim();
      if (!label || !voiceId) return null;
      return { label, voiceId };
    })
    .filter((x): x is ElevenLabsVoice => x !== null);
}

export type ParseResult =
  | { ok: true; config: Config }
  | { ok: false; errors: string[] };

const VALID_PROVIDERS: Provider[] = ["local", "openrouter"];

function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim().toLowerCase() === "true";
}

function parseFloatOpt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

const TUNING_KEYS = {
  narrator: { temp: "LOCAL_NARRATOR_TEMP", topP: "LOCAL_NARRATOR_TOP_P" },
  archivist: { temp: "LOCAL_ARCHIVIST_TEMP", topP: "LOCAL_ARCHIVIST_TOP_P" },
  interpreter: { temp: "LOCAL_INTERPRETER_TEMP", topP: "LOCAL_INTERPRETER_TOP_P" },
} as const;

function applyTuning(
  stage: StageConfig,
  env: Record<string, string | undefined>,
  keys: { temp: string; topP: string },
): StageConfig {
  return {
    ...stage,
    temperature: parseFloatOpt(env[keys.temp]),
    topP: parseFloatOpt(env[keys.topP]),
  };
}

// Parses one of NARRATOR_PROVIDER / ARCHIVIST_PROVIDER / INTERPRETER_PROVIDER.
// Returns the parsed StageConfig OR pushes an error message and returns null.
function parseStageConfig(
  name: string,
  raw: string | undefined,
  errors: string[],
): StageConfig | null {
  const formatHint =
    `${name} missing/invalid. Format: provider,model (e.g. openrouter,nvidia/nemotron-3-nano)`;

  if (raw === undefined || raw.trim() === "") {
    errors.push(formatHint);
    return null;
  }

  // Strip optional surrounding brackets: "[openrouter, model]" -> "openrouter, model"
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }

  const commaIdx = s.indexOf(",");
  if (commaIdx === -1) {
    errors.push(formatHint);
    return null;
  }

  const providerRaw = s.slice(0, commaIdx).trim();
  const modelRaw = s.slice(commaIdx + 1).trim();

  if (providerRaw === "" || modelRaw === "") {
    errors.push(formatHint);
    return null;
  }

  if (!VALID_PROVIDERS.includes(providerRaw as Provider)) {
    errors.push(
      `${name} provider "${providerRaw}" invalid. Must be one of: ${VALID_PROVIDERS.join(", ")}.`,
    );
    return null;
  }

  return { provider: providerRaw as Provider, model: modelRaw };
}

export function parseConfig(env: Record<string, string | undefined>): ParseResult {
  const errors: string[] = [];

  const narratorRaw = parseStageConfig("NARRATOR_PROVIDER", env.NARRATOR_PROVIDER, errors);
  const archivistRaw = parseStageConfig("ARCHIVIST_PROVIDER", env.ARCHIVIST_PROVIDER, errors);
  const interpreterRaw = parseStageConfig("INTERPRETER_PROVIDER", env.INTERPRETER_PROVIDER, errors);

  const useGeminiImages = parseBool(env.USE_GEMINI_IMAGES);
  // USE_NARRATION defaults to true (narration enabled when sidecar can run).
  // Set USE_NARRATION=false to skip spawning the Python sidecar entirely.
  const useNarration = env.USE_NARRATION === undefined
    ? true
    : env.USE_NARRATION.trim().toLowerCase() !== "false";

  // USE_ELEVENLABS overrides the local Chatterbox sidecar with ElevenLabs API
  // calls. When true, the Python sidecar is never spawned.
  const useElevenLabs = parseBool(env.USE_ELEVENLABS);
  const elevenLabsApiKey = (env.ELEVENLABS_API_KEY ?? "").trim() || null;
  const elevenLabsVoices = parseElevenLabsVoices(env.ELEVENLABS_VOICES);
  const elevenLabsModel = (env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5").trim();

  if (useElevenLabs) {
    if (!elevenLabsApiKey) {
      errors.push(
        "USE_ELEVENLABS=true but ELEVENLABS_API_KEY is empty. Get a key at https://elevenlabs.io/app/settings/api-keys.",
      );
    }
    if (elevenLabsVoices.length === 0) {
      errors.push(
        "USE_ELEVENLABS=true but ELEVENLABS_VOICES is empty. Format: label:voice_id,label:voice_id",
      );
    }
  }

  // Cross-validation: providers need their API keys.
  const usesOpenRouter =
    narratorRaw?.provider === "openrouter" ||
    archivistRaw?.provider === "openrouter" ||
    interpreterRaw?.provider === "openrouter";
  if (usesOpenRouter && (env.OPENROUTER_API_KEY ?? "") === "") {
    // Cite the first stage that uses openrouter for the error label.
    const firstName =
      narratorRaw?.provider === "openrouter" ? "NARRATOR_PROVIDER" :
      archivistRaw?.provider === "openrouter" ? "ARCHIVIST_PROVIDER" :
      "INTERPRETER_PROVIDER";
    errors.push(
      `${firstName}=openrouter but OPENROUTER_API_KEY is empty. Get a key at https://openrouter.ai/keys.`,
    );
  }

  if (useGeminiImages && (env.GEMINI_API_KEY ?? "") === "") {
    errors.push(
      "USE_GEMINI_IMAGES=true but GEMINI_API_KEY is empty. Get a key at https://aistudio.google.com/app/api-keys.",
    );
  }
  if (errors.length > 0 || !narratorRaw || !archivistRaw || !interpreterRaw) {
    return { ok: false, errors };
  }

  const lmStudioUrl = (env.LM_STUDIO_URL ?? "http://localhost:1234").replace(/\/$/, "");

  return {
    ok: true,
    config: {
      lmStudioUrl,
      openRouterApiKey: env.OPENROUTER_API_KEY ?? null,
      geminiApiKey: env.GEMINI_API_KEY ?? null,
      narrator: applyTuning(narratorRaw, env, TUNING_KEYS.narrator),
      archivist: applyTuning(archivistRaw, env, TUNING_KEYS.archivist),
      interpreter: applyTuning(interpreterRaw, env, TUNING_KEYS.interpreter),
      useGeminiImages,
      useNarration,
      useElevenLabs,
      elevenLabsApiKey,
      elevenLabsVoices,
      elevenLabsModel,
    },
  };
}

/**
 * Production entry point: parse process.env, print every error to stderr,
 * exit(1) on failure. Server startup uses this. Tests use parseConfig directly
 * so they don't terminate the test process.
 */
export function loadConfig(): Config {
  const result = parseConfig(process.env);
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`[config] ${err}`);
    }
    process.exit(1);
  }
  return result.config;
}
