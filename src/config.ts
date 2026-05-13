export type Provider = "local" | "openrouter";

export type StageConfig = {
  provider: Provider;
  model: string;
  temperature?: number;
  topP?: number;
};

export type Config = {
  lmStudioUrl: string;
  openRouterApiKey: string | null;
  geminiApiKey: string | null;
  narrator: StageConfig;
  archivist: StageConfig;
  interpreter: StageConfig;
  useGeminiImages: boolean;
  useGeminiNarration: boolean;
};

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

  const narrator = parseStageConfig("NARRATOR_PROVIDER", env.NARRATOR_PROVIDER, errors);
  const archivist = parseStageConfig("ARCHIVIST_PROVIDER", env.ARCHIVIST_PROVIDER, errors);
  const interpreter = parseStageConfig("INTERPRETER_PROVIDER", env.INTERPRETER_PROVIDER, errors);

  if (!narrator || !archivist || !interpreter) {
    return { ok: false, errors };
  }

  const lmStudioUrl = (env.LM_STUDIO_URL ?? "http://localhost:1234").replace(/\/$/, "");

  return {
    ok: true,
    config: {
      lmStudioUrl,
      openRouterApiKey: env.OPENROUTER_API_KEY ?? null,
      geminiApiKey: env.GEMINI_API_KEY ?? null,
      narrator: applyTuning(narrator, env, TUNING_KEYS.narrator),
      archivist: applyTuning(archivist, env, TUNING_KEYS.archivist),
      interpreter: applyTuning(interpreter, env, TUNING_KEYS.interpreter),
      useGeminiImages: parseBool(env.USE_GEMINI_IMAGES),
      useGeminiNarration: parseBool(env.USE_GEMINI_NARRATION),
    },
  };
}
