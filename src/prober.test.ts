import { test, expect, describe, spyOn, beforeEach, afterEach } from "bun:test";
import { buildProbeTargets, probeProvidersAtStartup } from "./prober";
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

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let logSpy: ReturnType<typeof spyOn<typeof console, "log">>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  logSpy.mockRestore();
});

describe("probeProvidersAtStartup", () => {
  test("resolves and logs when all probes return 2xx", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
    );
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "narr" },
      archivist: { provider: "local", model: "arch" },
      interpreter: { provider: "local", model: "arch" },
    });
    await expect(probeProvidersAtStartup(config)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // dedup: arch shared by archivist+interpreter
    const logs = logSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(logs).toContain("ready");
    expect(logs).toContain("2");
  });

  test("throws aggregated error when any probe fails (401)", async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("openrouter.ai")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("{}");
    });
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "narr-model" },
      archivist: { provider: "local", model: "arch-model" },
      interpreter: { provider: "local", model: "arch-model" },
    });
    await expect(probeProvidersAtStartup(config)).rejects.toThrow(/openrouter,narr-model/);
    await expect(probeProvidersAtStartup(config)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  test("aggregated error names every failed target", async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("openrouter.ai")) {
        return new Response("nope", { status: 402 });
      }
      return new Response("nope", { status: 404 });
    });
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "narr-model" },
      archivist: { provider: "local", model: "arch-model" },
      interpreter: { provider: "local", model: "interp-model" },
    });
    try {
      await probeProvidersAtStartup(config);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("openrouter,narr-model");
      expect(msg).toContain("local,arch-model");
      expect(msg).toContain("local,interp-model");
      expect(msg).toContain("credits");          // 402 hint
      expect(msg).toContain("not loaded");        // local 404 hint
    }
  });

  test("maps ECONNREFUSED to 'is LM Studio running?'", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");      // Bun surfaces ECONNREFUSED as TypeError("fetch failed") with cause
    });
    const config = makeConfig({
      narrator: { provider: "local", model: "m" },
      archivist: { provider: "local", model: "m" },
      interpreter: { provider: "local", model: "m" },
    });
    await expect(probeProvidersAtStartup(config)).rejects.toThrow(/LM Studio/);
  });

  test("maps timeout (AbortError) to 'timeout' hint", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new DOMException("aborted", "AbortError"))
    );
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "m" },
      archivist: { provider: "openrouter", model: "m" },
      interpreter: { provider: "openrouter", model: "m" },
    });
    await expect(probeProvidersAtStartup(config)).rejects.toThrow(/timeout/);
  });

  test("usedBy stages appear in the error message", async () => {
    fetchSpy.mockImplementation(async () => new Response("err", { status: 500 }));
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "shared" },
      archivist: { provider: "openrouter", model: "shared" },
      interpreter: { provider: "local", model: "x" },
    });
    try {
      await probeProvidersAtStartup(config);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("narrator");
      expect(msg).toContain("archivist");
    }
  });

  test("probes fire in parallel, not serially", async () => {
    const callTimes: number[] = [];
    fetchSpy.mockImplementation(async () => {
      callTimes.push(Date.now());
      await Bun.sleep(20);
      return new Response("{}");
    });
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "a" },
      archivist: { provider: "openrouter", model: "b" },
      interpreter: { provider: "local", model: "c" },
    });
    await probeProvidersAtStartup(config);
    expect(callTimes).toHaveLength(3);
    // All three calls should fire within ~5ms of each other if parallel;
    // serial would be ~20ms apart per call.
    const spread = Math.max(...callTimes) - Math.min(...callTimes);
    expect(spread).toBeLessThan(15);
  });
});
