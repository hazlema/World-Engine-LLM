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

// Stub implementation — Tasks 2-4 build out real parsing + validation.
// Returns a hardcoded valid Config so the shape test passes.
export function parseConfig(_env: Record<string, string | undefined>): ParseResult {
  const stage: StageConfig = { provider: "local", model: "nvidia/nemotron-3-nano" };
  return {
    ok: true,
    config: {
      lmStudioUrl: "http://localhost:1234",
      openRouterApiKey: null,
      geminiApiKey: null,
      narrator: stage,
      archivist: stage,
      interpreter: stage,
      useGeminiImages: false,
      useGeminiNarration: false,
    },
  };
}
