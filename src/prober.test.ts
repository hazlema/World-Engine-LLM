import { test, expect, describe } from "bun:test";
import { buildProbeTargets } from "./prober";
import type { Config } from "./config";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    lmStudioUrl: "http://localhost:1234",
    openRouterApiKey: "or-test-key",
    geminiApiKey: null,
    narrator: { provider: "local", model: "test-model" },
    archivist: { provider: "local", model: "test-model" },
    interpreter: { provider: "local", model: "test-model" },
    useGeminiImages: false,
    useNarration: true,
    useElevenLabs: false,
    elevenLabsApiKey: null,
    elevenLabsVoices: [],
    elevenLabsModel: "eleven_flash_v2_5",
    ...overrides,
  };
}

describe("buildProbeTargets", () => {
  test("all three stages on the same (provider, model) → 1 target with 3 usedBy", () => {
    const config = makeConfig();
    const targets = buildProbeTargets(config);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      provider: "local",
      model: "test-model",
      usedBy: ["narrator", "archivist", "interpreter"],
    });
  });

  test("all three stages on different (provider, model) → 3 targets", () => {
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "narr-model" },
      archivist: { provider: "openrouter", model: "arch-model" },
      interpreter: { provider: "local", model: "interp-model" },
    });
    const targets = buildProbeTargets(config);
    expect(targets).toHaveLength(3);
    const narr = targets.find(t => t.model === "narr-model");
    expect(narr).toEqual({ provider: "openrouter", model: "narr-model", usedBy: ["narrator"] });
    const arch = targets.find(t => t.model === "arch-model");
    expect(arch).toEqual({ provider: "openrouter", model: "arch-model", usedBy: ["archivist"] });
    const interp = targets.find(t => t.model === "interp-model");
    expect(interp).toEqual({ provider: "local", model: "interp-model", usedBy: ["interpreter"] });
  });

  test("two stages share, one differs → 2 targets with shared usedBy", () => {
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "shared" },
      archivist: { provider: "openrouter", model: "shared" },
      interpreter: { provider: "local", model: "different" },
    });
    const targets = buildProbeTargets(config);
    expect(targets).toHaveLength(2);
    const shared = targets.find(t => t.model === "shared");
    expect(shared?.usedBy).toEqual(["narrator", "archivist"]);
    const different = targets.find(t => t.model === "different");
    expect(different?.usedBy).toEqual(["interpreter"]);
  });

  test("same provider, different models → 2 targets (dedup is on (provider, model), not provider alone)", () => {
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "model-a" },
      archivist: { provider: "openrouter", model: "model-b" },
      interpreter: { provider: "openrouter", model: "model-a" },
    });
    const targets = buildProbeTargets(config);
    expect(targets).toHaveLength(2);
    const a = targets.find(t => t.model === "model-a");
    expect(a?.usedBy).toEqual(["narrator", "interpreter"]);
    const b = targets.find(t => t.model === "model-b");
    expect(b?.usedBy).toEqual(["archivist"]);
  });
});
