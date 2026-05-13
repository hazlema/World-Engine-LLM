# OpenRouter Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `openrouter` as a third provider option (peer of `local` and `gemini`) and introduce `ARCHIVIST_PROVIDER` so the archivist can escape local too, defaulting to free `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` with thinking-on.

**Architecture:** OpenRouter speaks the OpenAI-compatible `/v1/chat/completions` shape. Three new call functions in `src/api.ts` mirror the local siblings, target `https://openrouter.ai/api/v1/chat/completions` with `Bearer` auth, and include `reasoning.effort` for Nemotron's thinking control. Provider routing reads from env at call time (matching the Gemini pattern), enabling unit tests via fetch-spies. Validator extends to accept the new value across all three stages.

**Tech Stack:** TypeScript, Bun runtime, `bun:test` for unit tests, global `fetch` (no SDK — OpenRouter is OpenAI-compatible). Existing `src/api.ts` test conventions (fetch spies + Response mocks) are reused.

**Spec reference:** `docs/superpowers/specs/2026-05-12-openrouter-provider-design.md`

---

## Task 1: Bootstrap — validator, `ARCHIVIST_PROVIDER`, env reads at call time

**Files:**
- Modify: `src/api.ts` (constants and `validateApiConfig`)
- Test: `src/api.test.ts` (append)

This task refactors the three `*_PROVIDER` env reads from module-load constants to small per-call helpers so later tests can flip them without re-importing the module. It also adds `ARCHIVIST_PROVIDER` (defaults `local`) and extends `validateApiConfig` to accept `openrouter` and check for `OPENROUTER_API_KEY`.

- [ ] **Step 1: Write the failing validator tests**

First, update the existing `./api` import line at the top of `src/api.test.ts` to also import `validateApiConfig`:

```typescript
import { callModel, callModelStructured, validateApiConfig } from "./api";
```

Then append the new tests at the bottom of the file:

```typescript
test("validateApiConfig: accepts NARRATOR_PROVIDER=openrouter with key set", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit called"); });
  try {
    expect(() => validateApiConfig()).not.toThrow();
  } finally {
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("validateApiConfig: rejects ARCHIVIST_PROVIDER=gemini", () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "gemini";
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  try {
    expect(() => validateApiConfig()).toThrow("exit");
    const calls = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(calls).toContain("ARCHIVIST_PROVIDER");
    expect(calls).toContain("local");
    expect(calls).toContain("openrouter");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("validateApiConfig: exits when any stage is openrouter but OPENROUTER_API_KEY missing", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  delete process.env.OPENROUTER_API_KEY;
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  try {
    expect(() => validateApiConfig()).toThrow("exit");
    const calls = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(calls).toContain("OPENROUTER_API_KEY");
    expect(calls).toContain("NARRATOR_PROVIDER=openrouter");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/api.test.ts`
Expected: 3 new tests FAIL — `openrouter` not yet accepted; `ARCHIVIST_PROVIDER` not validated; key check missing.

- [ ] **Step 3: Refactor provider reads to per-call helpers**

In `src/api.ts`, replace these module-load constants:

```typescript
const NARRATOR_PROVIDER = (process.env.NARRATOR_PROVIDER ?? "local").toLowerCase();
// ...
const INTERPRETER_PROVIDER = (process.env.INTERPRETER_PROVIDER ?? "local").toLowerCase();
```

with helper functions just above `validateApiConfig`:

```typescript
function narratorProvider(): string {
  return (process.env.NARRATOR_PROVIDER ?? "local").toLowerCase();
}
function interpreterProvider(): string {
  return (process.env.INTERPRETER_PROVIDER ?? "local").toLowerCase();
}
function archivistProvider(): string {
  return (process.env.ARCHIVIST_PROVIDER ?? "local").toLowerCase();
}
```

Then update every site that currently reads `NARRATOR_PROVIDER` or `INTERPRETER_PROVIDER` to call the helper instead. There are six sites:
1. `logStage("narrator", NARRATOR_PROVIDER, ...)` → `logStage("narrator", narratorProvider(), ...)`
2. `logStage("interpreter", INTERPRETER_PROVIDER, ...)` → `logStage("interpreter", interpreterProvider(), ...)`
3. The `for (const [name, value] of [...])` loop inside `validateApiConfig` → use the helpers
4. The `geminiNeeded` line inside `validateApiConfig`
5. The `if (INTERPRETER_PROVIDER === "gemini")` in `callInterpreterStructured` → `interpreterProvider() === "gemini"`
6. The `if (NARRATOR_PROVIDER === "gemini")` in `callModel` → `narratorProvider() === "gemini"`

(Plus the two ternaries inside the `logStage` calls that pick gemini-vs-local model names — those reference the module-load constants too; switch them to helper calls.)

- [ ] **Step 4: Extend validator to accept openrouter + check ARCHIVIST_PROVIDER + check key**

Replace the body of `validateApiConfig` with:

```typescript
export function validateApiConfig(): void {
  const VALID = ["local", "gemini", "openrouter"];
  const VALID_ARCHIVIST = ["local", "openrouter"];

  const checks: Array<[string, string, string[]]> = [
    ["NARRATOR_PROVIDER", narratorProvider(), VALID],
    ["INTERPRETER_PROVIDER", interpreterProvider(), VALID],
    ["ARCHIVIST_PROVIDER", archivistProvider(), VALID_ARCHIVIST],
  ];
  for (const [name, value, valid] of checks) {
    if (!valid.includes(value)) {
      console.error(`[api] ${name}="${value}" is invalid. Must be one of: ${valid.join(", ")}.`);
      console.error(`[api] (If you meant to pick a local model id, use LOCAL_MODEL or LOCAL_${name.replace("_PROVIDER", "_MODEL")} instead.)`);
      process.exit(1);
    }
  }

  const geminiNeeded = narratorProvider() === "gemini" || interpreterProvider() === "gemini";
  if (geminiNeeded && !process.env.GEMINI_API_KEY) {
    const stages = [
      narratorProvider() === "gemini" ? "NARRATOR_PROVIDER=gemini" : null,
      interpreterProvider() === "gemini" ? "INTERPRETER_PROVIDER=gemini" : null,
    ].filter(Boolean).join(" and ");
    console.error(`[api] ${stages} but GEMINI_API_KEY is not set.`);
    console.error(`[api] Either set GEMINI_API_KEY in .env, or switch to local (the default).`);
    process.exit(1);
  }

  const orNeeded =
    narratorProvider() === "openrouter" ||
    interpreterProvider() === "openrouter" ||
    archivistProvider() === "openrouter";
  if (orNeeded && !process.env.OPENROUTER_API_KEY) {
    const stages = [
      narratorProvider() === "openrouter" ? "NARRATOR_PROVIDER=openrouter" : null,
      interpreterProvider() === "openrouter" ? "INTERPRETER_PROVIDER=openrouter" : null,
      archivistProvider() === "openrouter" ? "ARCHIVIST_PROVIDER=openrouter" : null,
    ].filter(Boolean).join(" and ");
    console.error(`[api] ${stages} but OPENROUTER_API_KEY is not set.`);
    console.error(`[api] Either set OPENROUTER_API_KEY in .env (https://openrouter.ai/keys), or switch to local.`);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run all tests to verify pass**

Run: `bun test src/api.test.ts`
Expected: all tests pass (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): bootstrap openrouter provider validation + ARCHIVIST_PROVIDER"
```

---

## Task 2: OpenRouter narrator path + routing

**Files:**
- Modify: `src/api.ts` (add `callNarratorOpenRouter`, route in `callModel`)
- Test: `src/api.test.ts` (append)

- [ ] **Step 1: Write the failing narrator tests**

Append to `src/api.test.ts`:

```typescript
test("openrouter narrator: posts to openrouter URL with bearer + thinking on by default", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "test/model:free";
  delete process.env.OPENROUTER_NARRATOR_THINKING;

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "remote prose", reasoning_content: "" } }],
    }));
  });

  try {
    const result = await callModel("system", "input");
    expect(result).toBe("remote prose");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.model).toBe("test/model:free");
    expect(body.reasoning).toEqual({ effort: "medium" });
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: per-stage thinking=off disables reasoning", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_NARRATOR_THINKING = "off";

  let capturedBody: { reasoning: { effort: string } } | undefined;
  fetchSpy.mockImplementationOnce(async (_url, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "fast prose", reasoning_content: "" } }],
    }));
  });

  try {
    await callModel("system", "input");
    expect(capturedBody!.reasoning).toEqual({ effort: "off" });
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: uses OPENROUTER_NARRATOR_MODEL override when set", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "default/model:free";
  process.env.OPENROUTER_NARRATOR_MODEL = "specific/narrator:free";

  let capturedBody: { model: string } | undefined;
  fetchSpy.mockImplementationOnce(async (_url, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "x", reasoning_content: "" } }],
    }));
  });

  try {
    await callModel("system", "input");
    expect(capturedBody!.model).toBe("specific/narrator:free");
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: surfaces 429 rate-limit message", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
  );

  try {
    await expect(callModel("system", "input")).rejects.toThrow(/OpenRouter rate limit/);
  } finally {
    process.env = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/api.test.ts`
Expected: 4 new tests FAIL — `callModel` doesn't route to openrouter yet.

- [ ] **Step 3: Add the OpenRouter narrator function**

Add to `src/api.ts` (near the existing Gemini helpers, around line 105):

```typescript
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterModel(stage: "NARRATOR" | "INTERPRETER" | "ARCHIVIST"): string {
  const perStage = process.env[`OPENROUTER_${stage}_MODEL`];
  if (perStage) return perStage;
  return process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
}

function openRouterThinking(stage: "NARRATOR" | "INTERPRETER" | "ARCHIVIST"): boolean {
  const raw = (process.env[`OPENROUTER_${stage}_THINKING`] ?? "on").toLowerCase();
  return raw !== "off";
}

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/hazlema/World-Engine-LLM",
    "X-Title": "World Engine LLM",
  };
}

async function callNarratorOpenRouter(systemPrompt: string, input: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (required for NARRATOR_PROVIDER=openrouter)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(key),
      body: JSON.stringify({
        model: openRouterModel("NARRATOR"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        reasoning: { effort: openRouterThinking("NARRATOR") ? "medium" : "off" },
        max_tokens: MAX_TOKENS,
        temperature: LOCAL_NARRATOR_TEMP,
        ...(LOCAL_NARRATOR_TOP_P !== undefined ? { top_p: LOCAL_NARRATOR_TOP_P } : {}),
      }),
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
    if (!content) throw new Error("Empty response from OpenRouter narrator");
    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("OpenRouter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Route narrator calls through OpenRouter**

In `src/api.ts`, find `callModel`. At the top, replace:

```typescript
export async function callModel(systemPrompt: string, input: string): Promise<string> {
  if (narratorProvider() === "gemini") return callNarratorGemini(systemPrompt, input);
```

with:

```typescript
export async function callModel(systemPrompt: string, input: string): Promise<string> {
  if (narratorProvider() === "gemini") return callNarratorGemini(systemPrompt, input);
  if (narratorProvider() === "openrouter") return callNarratorOpenRouter(systemPrompt, input);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/api.test.ts`
Expected: all tests pass (existing + 4 new openrouter narrator).

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): route narrator to OpenRouter (free nemotron)"
```

---

## Task 3: OpenRouter interpreter path + routing

**Files:**
- Modify: `src/api.ts`
- Test: `src/api.test.ts` (append)

- [ ] **Step 1: Write the failing interpreter test**

Append to `src/api.test.ts`:

```typescript
test("openrouter interpreter: posts to openrouter URL with json schema + parses content", async () => {
  const orig = { ...process.env };
  process.env.INTERPRETER_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_INTERPRETER_THINKING = "off";

  let capturedUrl = "";
  let capturedBody: { response_format: { type: string }; reasoning: { effort: string } } | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"direction":"north"}', reasoning_content: "" } }],
    }));
  });

  try {
    const result = await callInterpreterStructured<{ direction: string }>(
      "system", "go forth", "move", { type: "object" }
    );
    expect(result.direction).toBe("north");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedBody!.response_format.type).toBe("json_schema");
    expect(capturedBody!.reasoning.effort).toBe("off");
  } finally {
    process.env = orig;
  }
});

test("openrouter interpreter: throws on invalid JSON in content", async () => {
  const orig = { ...process.env };
  process.env.INTERPRETER_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "not json", reasoning_content: "" } }],
    }))
  );

  try {
    await expect(
      callInterpreterStructured("system", "input", "test", {})
    ).rejects.toThrow(/Invalid JSON/);
  } finally {
    process.env = orig;
  }
});
```

Extend the existing `./api` import line at the top of `src/api.test.ts` to include `callInterpreterStructured`:

```typescript
import { callModel, callModelStructured, callInterpreterStructured, validateApiConfig } from "./api";
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/api.test.ts`
Expected: 2 new interpreter tests FAIL — no routing for openrouter in `callInterpreterStructured`.

- [ ] **Step 3: Add the OpenRouter interpreter function**

Add to `src/api.ts` after `callNarratorOpenRouter`:

```typescript
async function callInterpreterOpenRouter<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (required for INTERPRETER_PROVIDER=openrouter)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(key),
      body: JSON.stringify({
        model: openRouterModel("INTERPRETER"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
        reasoning: { effort: openRouterThinking("INTERPRETER") ? "medium" : "off" },
        max_tokens: 64,
        temperature: LOCAL_INTERPRETER_TEMP,
        ...(LOCAL_INTERPRETER_TOP_P !== undefined ? { top_p: LOCAL_INTERPRETER_TOP_P } : {}),
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (res.status === 429) {
      throw new Error(`OpenRouter rate limit hit — wait a minute or add credits. (${rawText})`);
    }
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${rawText}`);

    const outer = JSON.parse(rawText) as CompletionsResponse;
    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.content || msg?.reasoning_content || "").trim();
    if (!raw) throw new Error("No content in OpenRouter interpreter response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Invalid JSON from OpenRouter interpreter: ${raw}`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("OpenRouter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

Note: the function signature accepts a `schemaName` parameter (unlike the Gemini interpreter, which doesn't need one). This matches what `callInterpreterStructured` already passes through to the local path.

- [ ] **Step 4: Route interpreter calls through OpenRouter**

In `src/api.ts`, find `callInterpreterStructured`. Replace:

```typescript
export async function callInterpreterStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  if (interpreterProvider() === "gemini") {
    return callInterpreterGemini<T>(systemPrompt, input, schema);
  }
```

with:

```typescript
export async function callInterpreterStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  if (interpreterProvider() === "gemini") {
    return callInterpreterGemini<T>(systemPrompt, input, schema);
  }
  if (interpreterProvider() === "openrouter") {
    return callInterpreterOpenRouter<T>(systemPrompt, input, schemaName, schema);
  }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/api.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): route interpreter to OpenRouter"
```

---

## Task 4: OpenRouter archivist path + routing

**Files:**
- Modify: `src/api.ts`
- Test: `src/api.test.ts` (append)

- [ ] **Step 1: Write the failing archivist test**

Append to `src/api.test.ts`:

```typescript
test("openrouter archivist: posts to openrouter URL with json schema + retries on failure", async () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_ARCHIVIST_THINKING = "off";

  // First call fails, second succeeds — verifies the retry wrapper still applies
  fetchSpy
    .mockImplementationOnce(async () => new Response("Server error", { status: 500 }))
    .mockImplementationOnce(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"entries":["a","b"]}', reasoning_content: "" } }],
      }))
    );

  try {
    const result = await callModelStructured<{ entries: string[] }>(
      "system", "input", "facts", { type: "object" }
    );
    expect(result.entries).toEqual(["a", "b"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    process.env = orig;
  }
});

test("openrouter archivist: prefers content over reasoning_content", async () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"entries":["from content"]}',
          reasoning_content: '{"entries":["from reasoning"]}',
        },
      }],
    }))
  );

  try {
    const result = await callModelStructured<{ entries: string[] }>(
      "system", "input", "facts", { type: "object" }
    );
    expect(result.entries).toEqual(["from content"]);
  } finally {
    process.env = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/api.test.ts`
Expected: 2 new archivist tests FAIL — no routing in `callModelStructured`.

- [ ] **Step 3: Add the OpenRouter archivist function**

Add to `src/api.ts` after `callInterpreterOpenRouter`:

```typescript
async function callArchivistOpenRouterOnce<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (required for ARCHIVIST_PROVIDER=openrouter)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVIST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(key),
      body: JSON.stringify({
        model: openRouterModel("ARCHIVIST"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
        reasoning: { effort: openRouterThinking("ARCHIVIST") ? "medium" : "off" },
        max_tokens: ARCHIVIST_MAX_TOKENS,
        temperature: LOCAL_ARCHIVIST_TEMP,
        ...(LOCAL_ARCHIVIST_TOP_P !== undefined ? { top_p: LOCAL_ARCHIVIST_TOP_P } : {}),
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (res.status === 429) {
      throw new Error(`OpenRouter rate limit hit — wait a minute or add credits. (${rawText})`);
    }
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${rawText}`);

    const outer = JSON.parse(rawText) as CompletionsResponse;
    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.content || msg?.reasoning_content || "").trim();
    if (!raw) throw new Error("No content in OpenRouter archivist response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Invalid JSON from OpenRouter archivist: ${raw}`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("OpenRouter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Route archivist calls through OpenRouter (preserving the retry wrapper)**

Find `callModelStructured` in `src/api.ts`. Replace the whole function body with:

```typescript
export async function callModelStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const useOpenRouter = archivistProvider() === "openrouter";
  let lastErr: Error = new Error("No attempts made");
  for (let attempt = 1; attempt <= ARCHIVIST_RETRIES; attempt++) {
    try {
      if (useOpenRouter) {
        return await callArchivistOpenRouterOnce<T>(systemPrompt, input, schemaName, schema);
      }
      return await callModelStructuredOnce<T>(systemPrompt, input, schemaName, schema);
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[api] archivist attempt ${attempt}/${ARCHIVIST_RETRIES} failed: ${lastErr.message}`);
      if (attempt < ARCHIVIST_RETRIES) await Bun.sleep(500 * attempt);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/api.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): route archivist to OpenRouter (preserves retry wrapper)"
```

---

## Task 5: Three-way `logStage` and accurate startup banner

**Files:**
- Modify: `src/api.ts`
- Test: `src/api.test.ts` (append)

The current `logStage` collapses provider into `remote` (gemini) vs `local` (everything else), so openrouter currently logs as `[local]`. Fix that, and add archivist's provider to the startup banner.

- [ ] **Step 1: Refactor `logStage` to a 3-way `where`**

In `src/api.ts`, replace `logStage`:

```typescript
function logStage(job: string, provider: string, model: string, temp?: number, topP?: number): void {
  const where = provider === "gemini" ? "remote"
              : provider === "openrouter" ? "openrouter"
              : "local";
  const showSampling = where === "local";
  const tempPart = showSampling && temp !== undefined ? ` [temp=${temp}]` : "";
  const topPart = showSampling && topP !== undefined ? ` [top_p=${topP}]` : "";
  console.log(`[api] [${job}] [${where}] [${model}]${tempPart}${topPart}`);
}
```

- [ ] **Step 2: Update the startup banner to reflect provider per stage**

In `src/api.ts`, find the existing `logStage("narrator", ...)` / `logStage("archivist", "local", ...)` / `logStage("interpreter", ...)` calls just below `logStage`. Replace them with:

```typescript
function stageModel(stage: "NARRATOR" | "INTERPRETER" | "ARCHIVIST", provider: string, localModel: string): string {
  if (provider === "gemini") {
    return stage === "NARRATOR" ? NARRATOR_GEMINI_MODEL : INTERPRETER_GEMINI_MODEL;
  }
  if (provider === "openrouter") return openRouterModel(stage);
  return localModel;
}

logStage("narrator", narratorProvider(), stageModel("NARRATOR", narratorProvider(), NARRATOR_MODEL),
  LOCAL_NARRATOR_TEMP, LOCAL_NARRATOR_TOP_P);
logStage("archivist", archivistProvider(), stageModel("ARCHIVIST", archivistProvider(), ARCHIVIST_MODEL),
  LOCAL_ARCHIVIST_TEMP, LOCAL_ARCHIVIST_TOP_P);
logStage("interpreter", interpreterProvider(), stageModel("INTERPRETER", interpreterProvider(), INTERPRETER_MODEL),
  LOCAL_INTERPRETER_TEMP, LOCAL_INTERPRETER_TOP_P);
```

Note: archivist gemini is invalid (validator rejects it), so the `stage === "NARRATOR" ? ... : ...` ternary inside `stageModel` will return `INTERPRETER_GEMINI_MODEL` for the archivist case if it ever fires — but it cannot fire because validation runs first. The reachable arms are local + openrouter for archivist.

- [ ] **Step 3: Run tests + boot the server to spot-check the banner**

Run: `bun test src/api.test.ts`
Expected: all tests pass.

Then do a quick manual banner check (no real LLM call needed — just observe the log lines):

```bash
OPENROUTER_API_KEY=test-key NARRATOR_PROVIDER=openrouter \
INTERPRETER_PROVIDER=openrouter ARCHIVIST_PROVIDER=openrouter \
bun -e "import('./src/api.ts').then(m => m.validateApiConfig())"
```

Expected output includes three `[openrouter]` lines and no errors.

- [ ] **Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): logStage shows openrouter as its own 'where' + per-stage banner"
```

---

## Task 6: Update `.env-sample`

**Files:**
- Modify: `.env-sample`

- [ ] **Step 1: Replace the current Gemini fallback block with the relabeled-Gemini + new-OpenRouter blocks**

Open `.env-sample`. The current tail looks like:

```
###########################################################
## Too use images and narration set a google api key
## https://aistudio.google.com/app/api-keys
##
## Only required for narration and per-turn images.
## Adds a lot to the game and costs fractions of a penny per use.
###########################################################
## GEMINI_API_KEY=

## If you don't have or can't run LM Studio, you can enable these and run the full game with Gemini.
## NARRATOR_PROVIDER=gemini
## NARRATOR_GEMINI_MODEL=gemini-2.5-flash
## INTERPRETER_PROVIDER=gemini
## INTERPRETER_GEMINI_MODEL=gemini-2.5-flash
```

Replace from `## If you don't have or can't run LM Studio` down to the end of the file with:

```
###########################################################
## --- GEMINI (paid cloud, best prose) ---
## If you don't have or can't run LM Studio, enable these for full-game Gemini.
## Note: archivist is not wired for Gemini; pair Gemini narrator/interpreter
## with LOCAL_ARCHIVIST_MODEL, or use OpenRouter below for all three stages.
###########################################################
## NARRATOR_PROVIDER=gemini
## NARRATOR_GEMINI_MODEL=gemini-2.5-flash
## INTERPRETER_PROVIDER=gemini
## INTERPRETER_GEMINI_MODEL=gemini-2.5-flash

###########################################################
## --- OPENROUTER (free cloud, no local model needed) ---
## Get a key at https://openrouter.ai/keys
## Free Nemotron follows rules well; thinking-on by default (slower, better).
###########################################################
## OPENROUTER_API_KEY=
## NARRATOR_PROVIDER=openrouter
## INTERPRETER_PROVIDER=openrouter
## ARCHIVIST_PROVIDER=openrouter
##
## Single model knob covers all three stages.
## Override per-stage with OPENROUTER_NARRATOR_MODEL / _INTERPRETER_MODEL / _ARCHIVIST_MODEL.
## OPENROUTER_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
##
## Thinking mode is ON by default. Flip OFF per stage if you want speed:
## OPENROUTER_NARRATOR_THINKING=off
## OPENROUTER_INTERPRETER_THINKING=off
## OPENROUTER_ARCHIVIST_THINKING=off
```

Leave the existing GEMINI_API_KEY header section above untouched.

- [ ] **Step 2: Commit**

```bash
git add .env-sample
git commit -m "docs(env): add OpenRouter free-cloud preset; relabel Gemini block"
```

---

## Task 7: Manual smoke test — one full turn on OpenRouter

**Files:** none modified

This is a real-API check. It needs an OpenRouter key and uses the free tier (no charge, but rate-limited).

- [ ] **Step 1: Set up the env**

```bash
cp .env .env.backup
```

Edit `.env`:
- Add `OPENROUTER_API_KEY=<your key>` (get one at https://openrouter.ai/keys)
- Set `NARRATOR_PROVIDER=openrouter`
- Set `INTERPRETER_PROVIDER=openrouter`
- Set `ARCHIVIST_PROVIDER=openrouter`
- Leave `OPENROUTER_MODEL` unset (defaults to the free Nemotron)
- Leave thinking unset (defaults to on)

- [ ] **Step 2: Boot the server and confirm the banner**

```bash
bun run src/server.ts
```

Expected log lines:
```
[api] [narrator] [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free] ...
[api] [archivist] [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free] ...
[api] [interpreter] [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free] ...
```

If any line still says `[local]`, the env isn't being read — stop and debug before continuing.

- [ ] **Step 3: Play one turn**

Open the web UI, pick a preset, type a single command (e.g. `look around`). Verify:
- Narrator returns prose (not empty)
- Archivist updates state without parse errors in the server log
- Interpreter resolves direction/intent without parse errors

- [ ] **Step 4: Repeat with thinking off**

Stop the server. Edit `.env` to add:
```
OPENROUTER_NARRATOR_THINKING=off
OPENROUTER_INTERPRETER_THINKING=off
OPENROUTER_ARCHIVIST_THINKING=off
```

Restart and play one more turn. Verify it still works (just faster, possibly looser rule-following).

- [ ] **Step 5: Restore env**

```bash
mv .env.backup .env
```

- [ ] **Step 6: No commit needed (smoke test only)**

If the smoke test surfaces any issue, capture the failure and address it in a follow-up commit before declaring the work done.

---

## Done check

After Task 7 passes:
- All `src/api.test.ts` tests green (`bun test src/api.test.ts`)
- `.env-sample` has the OpenRouter block
- Smoke test confirmed one full turn works with thinking on AND thinking off
- Banner shows `[openrouter]` for all three stages when configured
