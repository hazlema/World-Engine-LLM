# World Engine Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the prototype `adventure.ts` into four focused modules under `src/`, fix the multi-turn silent-failure bug, and switch the archivist to structured JSON output via the completions endpoint.

**Architecture:** `src/api.ts` owns both HTTP endpoints (narrator uses `/api/v1/chat`, archivist uses `/v1/chat/completions` with JSON schema). `src/stack.ts` owns the WorldStack type and all persistence/formatting. `src/engine.ts` composes them into narrator and archivist turns. `src/main.ts` owns the readline loop with isolated try/catch blocks per turn pass.

**Tech Stack:** Bun, TypeScript, `bun:test`, `bun.file` / `Bun.write` for I/O, local LM Studio API at `http://localhost:1234`

> **Note:** This project has no git repository. Run `git init && git add -A && git commit -m "chore: initial commit of prototype"` before starting if you want history. Commit steps in each task assume git is available; skip them if not.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/stack.ts` | Create | `WorldStack` type, `loadStack`, `saveStack`, `formatStackForNarrator`, `formatStackForArchivist` |
| `src/stack.test.ts` | Create | Unit tests for all four exported functions |
| `src/api.ts` | Create | `callModel` (narrator endpoint), `callModelStructured` (completions endpoint with json_schema) |
| `src/api.test.ts` | Create | Unit tests via `spyOn(globalThis, "fetch")` |
| `src/engine.ts` | Create | `narratorTurn`, `archivistTurn`, prompt constants, archivist JSON schema |
| `src/engine.test.ts` | Create | Unit tests mocking `callModel` / `callModelStructured` |
| `src/main.ts` | Create | readline loop, command dispatcher, UI helpers |
| `adventure.ts` | Delete | Replaced entirely by the above |

---

## Task 1: src/stack.ts — world state data layer

**Files:**
- Create: `src/stack.ts`
- Create: `src/stack.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/stack.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { formatStackForNarrator, formatStackForArchivist } from "./stack";

test("formatStackForNarrator: empty stack returns empty string", () => {
  expect(formatStackForNarrator({ entries: [], turn: 0 })).toBe("");
});

test("formatStackForNarrator: non-empty stack returns ESTABLISHED WORLD block", () => {
  const stack = { entries: ["world is cold", "crow watches"], turn: 1 };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n- crow watches\n\n"
  );
});

test("formatStackForArchivist: empty stack returns empty header", () => {
  expect(formatStackForArchivist({ entries: [], turn: 0 })).toBe(
    "CURRENT STACK: (empty)\n\n"
  );
});

test("formatStackForArchivist: non-empty stack returns CURRENT STACK block", () => {
  const stack = { entries: ["world is cold"], turn: 2 };
  expect(formatStackForArchivist(stack)).toBe(
    "CURRENT STACK:\n- world is cold\n\n"
  );
});
```

- [ ] **Step 1.2: Run tests — expect failure**

```bash
bun test src/stack.test.ts
```

Expected: `Cannot find module './stack'`

- [ ] **Step 1.3: Implement src/stack.ts**

Create `src/stack.ts`:

```typescript
const STACK_FILE = "./world-stack.json";
export const MAX_STACK_ENTRIES = 25;

export interface WorldStack {
  entries: string[];
  turn: number;
}

export async function loadStack(): Promise<WorldStack> {
  const file = Bun.file(STACK_FILE);
  if (!(await file.exists())) return { entries: [], turn: 0 };
  try {
    return await file.json();
  } catch {
    console.error("Corrupt stack file, starting fresh.");
    return { entries: [], turn: 0 };
  }
}

export async function saveStack(stack: WorldStack): Promise<void> {
  await Bun.write(STACK_FILE, JSON.stringify(stack, null, 2));
}

export function formatStackForNarrator(stack: WorldStack): string {
  if (stack.entries.length === 0) return "";
  return `ESTABLISHED WORLD:\n${stack.entries.map(e => `- ${e}`).join("\n")}\n\n`;
}

export function formatStackForArchivist(stack: WorldStack): string {
  if (stack.entries.length === 0) return "CURRENT STACK: (empty)\n\n";
  return `CURRENT STACK:\n${stack.entries.map(e => `- ${e}`).join("\n")}\n\n`;
}
```

- [ ] **Step 1.4: Run tests — expect pass**

```bash
bun test src/stack.test.ts
```

Expected: 4 tests pass

- [ ] **Step 1.5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat: add stack module with Bun.file I/O and format helpers"
```

---

## Task 2: src/api.ts — HTTP layer with timeout and structured output

**Files:**
- Create: `src/api.ts`
- Create: `src/api.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `src/api.test.ts`:

```typescript
import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { callModel, callModelStructured } from "./api";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// callModel tests

test("callModel: extracts message content from output array", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      output: [
        { type: "reasoning", content: "thinking..." },
        { type: "message", content: "The world shivers." },
      ],
    }))
  );
  expect(await callModel("system", "input")).toBe("The world shivers.");
});

test("callModel: throws on empty message content", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      output: [{ type: "message", content: "" }],
    }))
  );
  expect(callModel("system", "input")).rejects.toThrow("No message in response");
});

test("callModel: throws on non-ok response", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response("Server error", { status: 500 })
  );
  expect(callModel("system", "input")).rejects.toThrow("API 500");
});

test("callModel: throws on missing message block", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({ output: [{ type: "reasoning", content: "hmm" }] }))
  );
  expect(callModel("system", "input")).rejects.toThrow("No message in response");
});

// callModelStructured tests

test("callModelStructured: extracts from reasoning_content when content empty", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
          reasoning_content: '{"entries":["world is cold","crow watches"]}',
        },
      }],
    }))
  );
  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "test", {}
  );
  expect(result.entries).toEqual(["world is cold", "crow watches"]);
});

test("callModelStructured: extracts from content when reasoning_content empty", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"entries":["lone fact"]}',
          reasoning_content: "",
        },
      }],
    }))
  );
  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "test", {}
  );
  expect(result.entries).toEqual(["lone fact"]);
});

test("callModelStructured: throws on empty content and reasoning_content", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }))
  );
  expect(
    callModelStructured("system", "input", "test", {})
  ).rejects.toThrow("No content in structured response");
});
```

- [ ] **Step 2.2: Run tests — expect failure**

```bash
bun test src/api.test.ts
```

Expected: `Cannot find module './api'`

- [ ] **Step 2.3: Implement src/api.ts**

Create `src/api.ts`:

```typescript
const NARRATOR_ENDPOINT = "http://localhost:1234/api/v1/chat";
const COMPLETIONS_ENDPOINT = "http://localhost:1234/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-4b";
const TIMEOUT_MS = 15_000;

interface NarratorResponse {
  output: Array<{ type: string; content: string }>;
}

interface CompletionsResponse {
  choices: Array<{
    message: { content: string; reasoning_content: string };
  }>;
}

export async function callModel(systemPrompt: string, input: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(NARRATOR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, system_prompt: systemPrompt, input }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let data: NarratorResponse;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error("[api] raw narrator response:", rawText);
      throw new Error("Invalid JSON from narrator API");
    }

    const msg = data.output?.find(o => o.type === "message");
    if (!msg?.content?.trim()) throw new Error("No message in response");
    return msg.content.trim();
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModelStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let outer: CompletionsResponse;
    try {
      outer = JSON.parse(rawText);
    } catch {
      console.error("[api] raw completions response:", rawText);
      throw new Error("Invalid JSON from completions API");
    }

    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.content || msg?.reasoning_content || "").trim();
    if (!raw) throw new Error("No content in structured response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      console.error("[api] raw structured content:", raw);
      throw new Error("Invalid JSON in structured response content");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```bash
bun test src/api.test.ts
```

Expected: 7 tests pass

- [ ] **Step 2.5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat: add api module with 15s timeout, structured output, and raw-log on failure"
```

---

## Task 3: src/engine.ts — narrator and archivist turns

**Files:**
- Create: `src/engine.ts`
- Create: `src/engine.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `src/engine.test.ts`:

```typescript
import { test, expect, mock, beforeEach } from "bun:test";

// Mock the api module before importing engine
const mockCallModel = mock(async (_sys: string, _inp: string) => "");
const mockCallModelStructured = mock(async () => ({ entries: [] as string[] }));

mock.module("./api", () => ({
  callModel: mockCallModel,
  callModelStructured: mockCallModelStructured,
}));

const { narratorTurn, archivistTurn } = await import("./engine");

const emptyStack = { entries: [], turn: 0 };
const populatedStack = { entries: ["world is cold", "crow watches"], turn: 2 };

beforeEach(() => {
  mockCallModel.mockReset();
  mockCallModelStructured.mockReset();
});

// narratorTurn tests

test("narratorTurn: returns narrative from callModel", async () => {
  mockCallModel.mockImplementationOnce(async () => "Dust drifts across cracked earth.");
  const result = await narratorTurn(emptyStack, "look around");
  expect(result).toBe("Dust drifts across cracked earth.");
});

test("narratorTurn: throws on empty string response", async () => {
  mockCallModel.mockImplementationOnce(async () => "");
  expect(narratorTurn(emptyStack, "look around")).rejects.toThrow(
    "Narrator returned empty response"
  );
});

test("narratorTurn: omits ESTABLISHED WORLD on empty stack", async () => {
  let capturedInput = "";
  mockCallModel.mockImplementationOnce(async (_sys, inp) => {
    capturedInput = inp;
    return "Something happens.";
  });
  await narratorTurn(emptyStack, "look around");
  expect(capturedInput).toBe("PLAYER ACTION: look around");
  expect(capturedInput).not.toContain("ESTABLISHED WORLD");
});

test("narratorTurn: includes ESTABLISHED WORLD on non-empty stack", async () => {
  let capturedInput = "";
  mockCallModel.mockImplementationOnce(async (_sys, inp) => {
    capturedInput = inp;
    return "Something happens.";
  });
  await narratorTurn(populatedStack, "look around");
  expect(capturedInput).toContain("ESTABLISHED WORLD:");
  expect(capturedInput).toContain("- world is cold");
  expect(capturedInput).toContain("PLAYER ACTION: look around");
});

// archivistTurn tests

test("archivistTurn: returns updated WorldStack with incremented turn", async () => {
  mockCallModelStructured.mockImplementationOnce(async () => ({
    entries: ["new fact one", "new fact two"],
  }));
  const result = await archivistTurn(emptyStack, "The crow flew away.");
  expect(result.entries).toEqual(["new fact one", "new fact two"]);
  expect(result.turn).toBe(1);
});

test("archivistTurn: caps entries at MAX_STACK_ENTRIES (25)", async () => {
  const manyEntries = Array.from({ length: 30 }, (_, i) => `fact ${i}`);
  mockCallModelStructured.mockImplementationOnce(async () => ({ entries: manyEntries }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.entries.length).toBe(25);
});

test("archivistTurn: uses CURRENT STACK: (empty) header for empty stack", async () => {
  let capturedInput = "";
  mockCallModelStructured.mockImplementationOnce(async (_sys, inp) => {
    capturedInput = inp;
    return { entries: [] };
  });
  await archivistTurn(emptyStack, "Some narrative.");
  expect(capturedInput).toContain("CURRENT STACK: (empty)");
});
```

- [ ] **Step 3.2: Run tests — expect failure**

```bash
bun test src/engine.test.ts
```

Expected: `Cannot find module './engine'`

- [ ] **Step 3.3: Implement src/engine.ts**

Create `src/engine.ts`:

```typescript
import { callModel, callModelStructured } from "./api";
import { WorldStack, MAX_STACK_ENTRIES, formatStackForNarrator, formatStackForArchivist } from "./stack";

export const NARRATOR_SYSTEM = `You are a living world. Not an assistant. A world.

You have physics, weather, consequences, politics, and characters with their own agendas who exist independently of the player. You do not bend easily to the player's will. You describe what happens — not what the player wants to happen.

Rules:
- Speak as the world itself. Never say "I" or break character.
- Keep responses under 120 words. Terse and vivid.
- NPCs can refuse, lie, fail, or act against the player's interests.
- Things can go wrong. Rewards must be earned.
- Never offer the player a menu of options. Just describe what the world does.
- The world has memory. Reference established facts when relevant.`;

export const ARCHIVIST_SYSTEM = `You are a world archivist. You extract facts from narrative passages and maintain a world state stack.

Return a JSON object with an entries array of short fact strings.

Rules:
- Each entry under 12 words.
- Do not repeat existing facts verbatim — update them if they've changed.
- Capture: locations visited, characters met, relationships, items held, active threads, world tone/genre.
- Remove facts that are no longer relevant or have resolved.
- Max ${MAX_STACK_ENTRIES} entries total.`;

const ARCHIVIST_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_STACK_ENTRIES,
    },
  },
  required: ["entries"],
};

export async function narratorTurn(stack: WorldStack, playerInput: string): Promise<string> {
  const input = `${formatStackForNarrator(stack)}PLAYER ACTION: ${playerInput}`;
  const result = await callModel(NARRATOR_SYSTEM, input);
  if (!result) throw new Error("Narrator returned empty response");
  return result;
}

export async function archivistTurn(stack: WorldStack, narrative: string): Promise<WorldStack> {
  const input = `${formatStackForArchivist(stack)}NEW NARRATIVE:\n${narrative}\n\nReturn updated entries:`;
  const result = await callModelStructured<{ entries: string[] }>(
    ARCHIVIST_SYSTEM,
    input,
    "world_stack",
    ARCHIVIST_SCHEMA
  );
  return { entries: result.entries.slice(0, MAX_STACK_ENTRIES), turn: stack.turn + 1 };
}
```

- [ ] **Step 3.4: Run tests — expect pass**

```bash
bun test src/engine.test.ts
```

Expected: 8 tests pass

- [ ] **Step 3.5: Run the full test suite**

```bash
bun test src/
```

Expected: all 19 tests pass (4 stack + 7 api + 8 engine)

- [ ] **Step 3.6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat: add engine module with narrator/archivist turns and structured archivist output"
```

---

## Task 4: src/main.ts — readline loop with resilient turn structure

**Files:**
- Create: `src/main.ts`

No unit tests — this is UI glue. Verified manually in Task 5.

- [ ] **Step 4.1: Create src/main.ts**

```typescript
import * as readline from "readline";
import { loadStack, saveStack, WorldStack } from "./stack";
import { narratorTurn, archivistTurn } from "./engine";

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════╗
║           W O R L D  E N G I N E    ║
╚══════════════════════════════════════╝
`);
}

function printHelp(): void {
  console.log(`
  Commands:
    stack   show current world state
    reset   wipe the world and start over
    help    this message
    quit    suspend the world
`);
}

function printStack(stack: WorldStack): void {
  if (stack.entries.length === 0) {
    console.log("\n  (world stack is empty)\n");
  } else {
    console.log(`\n  World state — turn ${stack.turn}:`);
    stack.entries.forEach(e => console.log(`    · ${e}`));
    console.log();
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let stack = await loadStack();

  printBanner();

  if (stack.turn === 0) {
    console.log("  The world is empty. What do you do?\n");
  } else {
    console.log(`  Resuming turn ${stack.turn}. World has ${stack.entries.length} established facts.\n`);
  }

  const ask = () => {
    rl.question("> ", async (raw) => {
      const input = raw.trim();
      const cmd = input.toLowerCase();

      if (!cmd || cmd === "quit" || cmd === "exit") {
        console.log("\n  World suspended.\n");
        rl.close();
        return;
      }

      if (cmd === "help") { printHelp(); ask(); return; }
      if (cmd === "stack") { printStack(stack); ask(); return; }

      if (cmd === "reset") {
        stack = { entries: [], turn: 0 };
        await saveStack(stack);
        console.log("\n  World reset. The void is empty again.\n");
        ask(); return;
      }

      process.stdout.write("\n");

      let narrative: string;
      try {
        narrative = await narratorTurn(stack, input);
        console.log("  " + narrative.replace(/\n/g, "\n  "));
        console.log();
      } catch (err) {
        console.error("\n  [narrator error]", err, "\n");
        ask();
        return;
      }

      try {
        stack = await archivistTurn(stack, narrative);
        await saveStack(stack);
      } catch (err) {
        console.warn("  [archivist failed — keeping old stack]", err);
      }

      ask();
    });
  };

  ask();
}

main();
```

- [ ] **Step 4.2: Commit**

```bash
git add src/main.ts
git commit -m "feat: add main module with resilient narrator/archivist turn isolation"
```

---

## Task 5: Cleanup and end-to-end verification

**Files:**
- Delete: `adventure.ts`

- [ ] **Step 5.1: Run the full test suite one final time**

```bash
bun test src/
```

Expected output (19 tests, all passing):
```
✓ src/stack.test.ts > formatStackForNarrator: empty stack returns empty string
✓ src/stack.test.ts > formatStackForNarrator: non-empty stack returns ESTABLISHED WORLD block
✓ src/stack.test.ts > formatStackForArchivist: empty stack returns empty header
✓ src/stack.test.ts > formatStackForArchivist: non-empty stack returns CURRENT STACK block
✓ src/api.test.ts > callModel: extracts message content from output array
✓ src/api.test.ts > callModel: throws on empty message content
✓ src/api.test.ts > callModel: throws on non-ok response
✓ src/api.test.ts > callModel: throws on missing message block
✓ src/api.test.ts > callModelStructured: extracts from reasoning_content when content empty
✓ src/api.test.ts > callModelStructured: extracts from content when reasoning_content empty
✓ src/api.test.ts > callModelStructured: throws on empty content and reasoning_content
✓ src/engine.test.ts > narratorTurn: returns narrative from callModel
✓ src/engine.test.ts > narratorTurn: throws on empty string response
✓ src/engine.test.ts > narratorTurn: omits ESTABLISHED WORLD on empty stack
✓ src/engine.test.ts > narratorTurn: includes ESTABLISHED WORLD on non-empty stack
✓ src/engine.test.ts > archivistTurn: returns updated WorldStack with incremented turn
✓ src/engine.test.ts > archivistTurn: caps entries at MAX_STACK_ENTRIES (25)
✓ src/engine.test.ts > archivistTurn: uses CURRENT STACK: (empty) header for empty stack
```

- [ ] **Step 5.2: Start the game and verify turn 1 works**

```bash
bun src/main.ts
```

At the prompt, enter: `look to the stars`

Expected: narrative output appears (non-empty), then `>` prompt returns.

- [ ] **Step 5.3: Verify turn 2 works (the bug fix)**

At the `>` prompt, enter: `look around`

Expected: another narrative appears. This is the bug fix — previously this would print a blank line.

- [ ] **Step 5.4: Verify stack command**

Enter: `stack`

Expected: world state entries from turns 1 and 2 are printed with bullet points.

- [ ] **Step 5.5: Verify archivist error resilience**

With the game running, temporarily kill the LM Studio server, enter a command, and observe:

Expected: `[narrator error]` message appears and `>` prompt returns (game does not hang or crash). Restart the server and verify the game recovers on the next input.

- [ ] **Step 5.6: Delete the old prototype**

```bash
rm adventure.ts
```

- [ ] **Step 5.7: Final commit**

```bash
git add -A
git commit -m "refactor: replace adventure.ts with modular src/ layout, fix multi-turn bug"
```

---

## Spec coverage checklist (self-review)

| Spec requirement | Task |
|-----------------|------|
| Split into src/api.ts, src/stack.ts, src/engine.ts, src/main.ts | Tasks 1–4 |
| Separate try/catch for narrator vs archivist | Task 4 (main.ts `ask()`) |
| 15s fetch timeout via AbortController | Task 2 (api.ts both functions) |
| Empty narrator response → throw | Task 3 (engine.ts `narratorTurn`) |
| Raw response logged before parse failure | Task 2 (api.ts both functions) |
| `node:fs` → `Bun.file` / `Bun.write` | Task 1 (stack.ts) |
| Archivist → `/v1/chat/completions` with json_schema | Task 2 + Task 3 |
| Extract archivist result from `reasoning_content \|\| content` | Task 2 (api.ts `callModelStructured`) |
| Archivist parse: `.slice(0, 25)` on schema-guaranteed array | Task 3 (engine.ts `archivistTurn`) |
| Commands: stack, reset, help, quit | Task 4 (main.ts) |
| `world-stack.json` persists between sessions | Task 1 (loadStack/saveStack) |
| Delete adventure.ts | Task 5 |
