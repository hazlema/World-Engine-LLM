# Provider Keep-Alive & Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add startup reachability probes and a 60s keep-alive ping for every unique `(provider, model)` tuple used by the LLM stages, exiting on any startup failure with a stage-aware error message. Replaces the narrator-only `warmupOpenRouter()` in `src/api.ts`.

**Architecture:** One new file `src/prober.ts` exporting three functions: `buildProbeTargets` (pure dedup helper), `probeProvidersAtStartup` (parallel 1-token probes via `Promise.allSettled`, throws aggregated error on any failure), and `startKeepAlivePings` (60s `setInterval` over the same target list, warns rather than throws). Wired into `src/server.ts:main()` between `logStartupRouting()` and `Bun.serve()`. The existing `warmupOpenRouter()` and its WS-open call site are deleted.

**Tech Stack:** TypeScript, Bun runtime, `bun:test` for unit tests, global `fetch` with `AbortController` for per-probe timeouts (no SDK — same OpenAI-compatible `/v1/chat/completions` shape used by `src/api.ts`).

**Spec reference:** `docs/superpowers/specs/2026-05-14-provider-keepalive-and-probes-design.md`

---

## Task 1: `prober.ts` skeleton + `buildProbeTargets` (pure dedup helper)

**Files:**
- Create: `src/prober.ts`
- Create: `src/prober.test.ts`

This task produces the pure helper that walks `Config` and dedupes the three stages by `(provider, model)`. No network, no timers — fully testable without mocks.

- [ ] **Step 1: Write the failing dedup tests**

Create `src/prober.test.ts` with the four dedup cases from the spec:

```typescript
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
    expect(targets.map(t => t.usedBy.length)).toEqual([1, 1, 1]);
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/prober.test.ts`
Expected: All 4 tests FAIL — `Cannot find module './prober'`.

- [ ] **Step 3: Implement the prober skeleton with `buildProbeTargets`**

Create `src/prober.ts`:

```typescript
import type { Config } from "./config";

export type ProbeTarget = {
  provider: "local" | "openrouter";
  model: string;
  usedBy: string[];   // stage names that share this (provider, model) tuple
};

const STAGE_ORDER = ["narrator", "archivist", "interpreter"] as const;

/**
 * Dedup the three pipeline stages into the unique (provider, model) tuples
 * that need to be probed. Stages that share a tuple share a probe — and
 * therefore share a keep-alive connection.
 */
export function buildProbeTargets(config: Config): ProbeTarget[] {
  const byKey = new Map<string, ProbeTarget>();
  for (const stage of STAGE_ORDER) {
    const sc = config[stage];
    const key = `${sc.provider}|${sc.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.usedBy.push(stage);
    } else {
      byKey.set(key, { provider: sc.provider, model: sc.model, usedBy: [stage] });
    }
  }
  return Array.from(byKey.values());
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/prober.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prober.ts src/prober.test.ts
git commit -m "feat(prober): buildProbeTargets dedup helper"
```

---

## Task 2: `probeProvidersAtStartup` — parallel probes with timeout & error mapping

**Files:**
- Modify: `src/prober.ts` (append)
- Modify: `src/prober.test.ts` (append)

This task adds the network-touching startup probe. It sends one `POST /v1/chat/completions` per target in parallel, maps known failure modes to actionable hints, and throws an aggregated error if any probe fails.

- [ ] **Step 1: Write the failing probe tests**

Append to `src/prober.test.ts`:

```typescript
import { spyOn, beforeEach, afterEach } from "bun:test";
import { probeProvidersAtStartup } from "./prober";

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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/prober.test.ts`
Expected: 7 new tests FAIL — `probeProvidersAtStartup is not exported from './prober'`. The 4 Task-1 tests still PASS.

- [ ] **Step 3: Implement `probeOne`, error mapping, and `probeProvidersAtStartup`**

Append to `src/prober.ts`:

```typescript
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Map a probe failure (HTTP status code, fetch error) to a human-readable
 * actionable hint. Returns the hint string; the caller composes the full
 * "[prober] FAIL ..." line.
 */
function explainFailure(target: ProbeTarget, err: unknown): string {
  if (err instanceof ProbeHttpError) {
    const code = err.status;
    if (code === 401 || code === 403) return "check OPENROUTER_API_KEY";
    if (code === 402) return "OpenRouter out of credits";
    if (code === 404) {
      return target.provider === "local"
        ? `model "${target.model}" not loaded in LM Studio — load it via the UI or \`lms load\``
        : `model "${target.model}" not found on OpenRouter — check the slug`;
    }
    if (code === 429) return "rate-limited at startup — try again";
    return `HTTP ${code}: ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return `timeout after ${PROBE_TIMEOUT_MS / 1000}s`;
    // Bun surfaces ECONNREFUSED as TypeError("fetch failed"); the cause has
    // the underlying code. Match on either the message or the cause.
    const msg = err.message.toLowerCase();
    const cause = (err as { cause?: { code?: string } }).cause;
    if (msg.includes("econnrefused") || cause?.code === "ECONNREFUSED" || msg === "fetch failed") {
      return target.provider === "local"
        ? `connect refused: is LM Studio running?`
        : `connect refused: is the network up?`;
    }
    return err.message;
  }
  return String(err);
}

class ProbeHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Send one 1-token chat completion. Throws ProbeHttpError on non-2xx,
 * AbortError on timeout, or the raw error on network failure.
 */
async function probeOne(target: ProbeTarget, lmStudioUrl: string, openRouterApiKey: string | null): Promise<void> {
  const url = target.provider === "openrouter"
    ? OPENROUTER_URL
    : `${lmStudioUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.provider === "openrouter") {
    if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");
    headers["Authorization"] = `Bearer ${openRouterApiKey}`;
    headers["HTTP-Referer"] = "https://github.com/hazlema/World-Engine-LLM";
    headers["X-Title"] = "World Engine LLM";
  }
  const body = JSON.stringify({
    model: target.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProbeHttpError(res.status, text);
    }
    // Discard body — we only care that the round trip completed.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every unique (provider, model) tuple in parallel. On any failure,
 * throw an aggregated Error whose message names every failed tuple with an
 * actionable hint. On all-success, log "[prober] all N providers ready (Mms)"
 * and resolve.
 */
export async function probeProvidersAtStartup(config: Config): Promise<void> {
  const targets = buildProbeTargets(config);
  const start = Date.now();
  const results = await Promise.allSettled(
    targets.map(t => probeOne(t, config.lmStudioUrl, config.openRouterApiKey))
  );
  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const t = targets[i];
      const hint = explainFailure(t, r.reason);
      failures.push(
        `  ${t.provider},${t.model} (used by: ${t.usedBy.join(", ")})\n    → ${hint}`
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`[prober] ${failures.length} provider(s) failed startup probe:\n${failures.join("\n")}`);
  }
  console.log(`[prober] all ${targets.length} provider(s) ready (${Date.now() - start}ms)`);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/prober.test.ts`
Expected: All 11 tests PASS (4 from Task 1 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/prober.ts src/prober.test.ts
git commit -m "feat(prober): probeProvidersAtStartup with parallel probes + error mapping"
```

---

## Task 3: `runKeepAliveTick` + `startKeepAlivePings` (runtime ping loop)

**Files:**
- Modify: `src/prober.ts` (append)
- Modify: `src/prober.test.ts` (append)

This task adds the runtime keep-alive: a 60s `setInterval` that re-probes the same target list, logging warnings on failure rather than throwing. The per-tick logic is extracted as `runKeepAliveTick` so it can be tested without timer mocking.

- [ ] **Step 1: Write the failing keep-alive tests**

Append to `src/prober.test.ts`:

```typescript
import { runKeepAliveTick, startKeepAlivePings } from "./prober";

describe("runKeepAliveTick", () => {
  test("resolves silently when all probes succeed", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}"));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    try {
      await expect(
        runKeepAliveTick(buildProbeTargets(config), config.lmStudioUrl, config.openRouterApiKey)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("warns but does not throw when a probe fails", async () => {
    fetchSpy.mockImplementation(async () => new Response("err", { status: 500 }));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig({
      narrator: { provider: "openrouter", model: "x" },
      archivist: { provider: "openrouter", model: "x" },
      interpreter: { provider: "openrouter", model: "x" },
    });
    try {
      await expect(
        runKeepAliveTick(buildProbeTargets(config), config.lmStudioUrl, config.openRouterApiKey)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(msg).toContain("keep-alive failed");
      expect(msg).toContain("openrouter,x");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("startKeepAlivePings", () => {
  test("returns a Timer that ticks at the configured interval and stops on clearInterval", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}"));
    const config = makeConfig();
    const timer = startKeepAlivePings(config, 10);
    await Bun.sleep(35);
    clearInterval(timer);
    const callsWhileTicking = fetchSpy.mock.calls.length;
    // Single dedup'd target × ~3 ticks expected
    expect(callsWhileTicking).toBeGreaterThanOrEqual(2);

    await Bun.sleep(30);
    // No new ticks after clearInterval
    expect(fetchSpy.mock.calls.length).toBe(callsWhileTicking);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/prober.test.ts`
Expected: 3 new tests FAIL — `runKeepAliveTick`, `startKeepAlivePings` not exported. Existing tests still PASS.

- [ ] **Step 3: Implement `runKeepAliveTick` and `startKeepAlivePings`**

Append to `src/prober.ts`:

```typescript
const DEFAULT_KEEPALIVE_MS = 60_000;

/**
 * Per-tick keep-alive logic, extracted so tests can call it directly without
 * timer mocking. Re-probes every target in parallel; failures call
 * console.warn but do not throw.
 */
export async function runKeepAliveTick(
  targets: ProbeTarget[],
  lmStudioUrl: string,
  openRouterApiKey: string | null,
): Promise<void> {
  const results = await Promise.allSettled(
    targets.map(t => probeOne(t, lmStudioUrl, openRouterApiKey))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const t = targets[i];
      const hint = explainFailure(t, r.reason);
      console.warn(`[prober] keep-alive failed: ${t.provider},${t.model} — ${hint}`);
    }
  }
}

/**
 * Start a 60s setInterval that runs runKeepAliveTick. Returns the Timer so
 * callers can clearInterval it (mainly for tests). The Timer is .unref()'d
 * so it doesn't keep Bun alive on shutdown.
 *
 * `intervalMs` defaults to 60_000; tests pass a small value to verify ticking.
 */
export function startKeepAlivePings(config: Config, intervalMs: number = DEFAULT_KEEPALIVE_MS): Timer {
  const targets = buildProbeTargets(config);
  const timer = setInterval(() => {
    runKeepAliveTick(targets, config.lmStudioUrl, config.openRouterApiKey);
  }, intervalMs);
  timer.unref();
  return timer;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/prober.test.ts`
Expected: All 14 tests PASS (4 + 7 + 3).

- [ ] **Step 5: Commit**

```bash
git add src/prober.ts src/prober.test.ts
git commit -m "feat(prober): runKeepAliveTick + startKeepAlivePings runtime loop"
```

---

## Task 4: Wire the prober into `server.ts`; delete `warmupOpenRouter`

**Files:**
- Modify: `src/server.ts` (lines 19, 430-431, around 475)
- Modify: `src/api.ts` (delete lines 68-97)

This task replaces the narrator-only WS-open warmup with the full prober at startup, and starts the keep-alive ping after `Bun.serve()` returns. The old `warmupOpenRouter` and its single call site are deleted entirely.

- [ ] **Step 1: Update the import in `src/server.ts`**

Find line 19:

```typescript
import { warmupOpenRouter, logStartupRouting } from "./api";
```

Replace with:

```typescript
import { logStartupRouting } from "./api";
import { probeProvidersAtStartup, startKeepAlivePings } from "./prober";
```

- [ ] **Step 2: Delete the WS-open warmup call**

Find lines 430-431 in `src/server.ts` (inside the WS open handler):

```typescript
      // Fire-and-forget warmup so the first turn doesn't eat OpenRouter cold-start.
      warmupOpenRouter().catch(() => {});
```

Delete both lines.

- [ ] **Step 3: Add the startup probe call in `main()`**

Find line 475 in `src/server.ts`:

```typescript
async function main() {
  serverConfig = loadConfig();
  logStartupRouting();

  if (!serverConfig.useNarration) {
```

Insert the probe call after `logStartupRouting()`:

```typescript
async function main() {
  serverConfig = loadConfig();
  logStartupRouting();

  try {
    await probeProvidersAtStartup(serverConfig);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (!serverConfig.useNarration) {
```

- [ ] **Step 4: Add the keep-alive ping after `Bun.serve()`**

Find line 619 in `src/server.ts`:

```typescript
  console.log(`World Engine listening at http://localhost:${server.port}`);
```

Insert immediately after:

```typescript
  console.log(`World Engine listening at http://localhost:${server.port}`);

  startKeepAlivePings(serverConfig);
```

- [ ] **Step 5: Delete `warmupOpenRouter` from `src/api.ts`**

In `src/api.ts`, delete the entire function `warmupOpenRouter` (currently lines 68-97). It looks like:

```typescript
export async function warmupOpenRouter(): Promise<void> {
  const c = config();
  const usesOpenRouter =
    c.narrator.provider === "openrouter" ||
    c.archivist.provider === "openrouter" ||
    c.interpreter.provider === "openrouter";
  if (!usesOpenRouter) return;
  if (!c.openRouterApiKey) return;

  console.log("[api] warming OpenRouter...");
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(c.openRouterApiKey),
      body: JSON.stringify({
        model: c.narrator.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        reasoning: { effort: "none" },
      }),
    });
    if (res.ok) {
      console.log("[api] OpenRouter warm");
    } else {
      console.warn(`[api] OpenRouter warmup non-ok: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[api] OpenRouter warmup failed: ${err}`);
  }
}
```

Delete the entire block (the function and the blank line above it). Leave the surrounding code (`openRouterHeaders` above it, `callOpenRouterChat` below) untouched.

- [ ] **Step 6: Run the full test suite + type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests PASS, no type errors. The prober tests (14) + existing tests (~all of them) all green.

If `tsc` complains about `Timer` not being defined in `src/prober.ts`, it's a Bun global type — verify `bun-types` is in `devDependencies` (it is, per `package.json`); no action needed unless the error appears.

- [ ] **Step 7: Manual smoke (optional but recommended)**

If LM Studio is running and `.env` has a valid OpenRouter key:

Run: `bun start`
Expected first lines of output:
```
[api] [narrator] [openrouter] [mistralai/ministral-14b-2512]
[api] [archivist] [openrouter] [openai/gpt-4o-mini]
[api] [interpreter] [openrouter] [openai/gpt-4o-mini]
[prober] all 2 provider(s) ready (NNNms)
...
World Engine listening at http://localhost:3000
```

Then break it deliberately to confirm fail-fast:
- Stop LM Studio (if any stage is `provider=local`) and restart `bun start` → expect exit with `connect refused: is LM Studio running?`.
- OR set `OPENROUTER_API_KEY=bogus` and restart → expect exit with `check OPENROUTER_API_KEY`.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/api.ts
git commit -m "feat(server): wire prober at startup, delete warmupOpenRouter"
```

---

## Verification command

`bun test && bunx tsc --noEmit` after each commit.

## Self-Review Notes (planner, not part of execution)

**Spec coverage:**
- Module shape (3 exports + 1 internal `probeOne` + 1 internal `explainFailure`) → Tasks 1-3.
- Probe shape (POST /v1/chat/completions, 1 token, 10s timeout) → Task 2 step 3.
- Dedup rule by `(provider, model)` → Task 1 step 3 + 4 unit tests.
- Error mapping table → Task 2 step 3 (`explainFailure` covers 401/403, 402, 404 split by provider, 429, ECONNREFUSED, AbortError).
- Startup flow integration → Task 4 steps 3-4.
- Runtime keep-alive log+warn semantics → Task 3 step 3 (`runKeepAliveTick` writes to `console.warn`, never throws).
- `warmupOpenRouter` deletion + WS-open call site removal → Task 4 steps 2 + 5.
- Test patterns mirror `api.test.ts` (fetch spy + Response mocks, beforeEach/afterEach lifecycle) → Tasks 1-3.

**Type consistency check:**
- `ProbeTarget` defined in Task 1 — used unchanged in Tasks 2 and 3.
- `probeOne(target, lmStudioUrl, openRouterApiKey)` signature defined in Task 2, called identically in Task 3's `runKeepAliveTick` and `startKeepAlivePings`.
- `runKeepAliveTick(targets, lmStudioUrl, openRouterApiKey)` signature consistent across test file (Task 3 step 1) and implementation (Task 3 step 3).
- `startKeepAlivePings(config, intervalMs?)` returns `Timer` — Bun global; matches the test's `clearInterval(timer)`.
- `explainFailure(target, err)` is internal but referenced from both `probeProvidersAtStartup` and `runKeepAliveTick` — defined once in Task 2, reused in Task 3.

**No circular imports:** `prober.ts` imports only from `./config`; `server.ts` imports from both `./api` and `./prober`; `api.ts` is unchanged in its imports.
