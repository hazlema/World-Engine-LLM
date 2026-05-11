# Local Models Probe Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-turn probe CLI in an orphan-branch worktree that replays a real turn from frozen fixtures against whatever LM Studio model is loaded, dumping the raw stringified response for eyeballing.

**Architecture:** Orphan branch `lab/local-models` checked out as a worktree at `.claude/worktrees/local-models/`. Self-contained Bun project — no shared code or deps with the main app. Single `probe.ts` plus a minimal `probe.test.ts` for the pure functions. Fixtures (play-log, world-stack, narrator system prompt) are copied at branch creation. Output goes to stdout and `results/*.txt` (gitignored). HTML render is a deferred follow-on task to be built only after raw output looks promising.

**Tech Stack:** Bun, TypeScript, LM Studio's OpenAI-compatible HTTP endpoint. No frameworks. No runtime deps; one devDep (`bun-types`).

**Working convention:** test-after for pure functions (write fn, write test, run `bun test`, commit). HTTP / file IO is smoke-tested manually with LM Studio running.

---

## Task 1: Create orphan branch in a git worktree

**Files:**
- Create: `.claude/worktrees/local-models/` (worktree directory)
- Modify: `.gitignore` (main repo, add the worktree path defensively)

- [ ] **Step 1: Confirm the target path is unused**

Run from main repo root (`/home/frosty/Dev/ai/adventure`):

```bash
ls .claude/worktrees/local-models 2>/dev/null && echo "EXISTS — STOP" || echo "ok, path is free"
```

Expected: `ok, path is free`

- [ ] **Step 2: Add the worktree path to main's .gitignore**

Append to `/home/frosty/Dev/ai/adventure/.gitignore`:

```
.claude/worktrees/local-models/
```

- [ ] **Step 3: Create a detached worktree, then switch to an empty orphan branch**

```bash
git worktree add --detach .claude/worktrees/local-models
cd .claude/worktrees/local-models
git switch --orphan lab/local-models
```

`git switch --orphan` (git ≥ 2.27) starts the branch with an empty index and empty working tree — no leftover files from main.

**Fallback** if `git switch --orphan` is unavailable (older git):

```bash
git checkout --orphan lab/local-models
git rm -rf --quiet .
```

`git rm -rf .` operates only on tracked files; the `.git` worktree marker file is preserved because it isn't tracked.

- [ ] **Step 4: Verify the working tree is empty**

From inside `.claude/worktrees/local-models`:

```bash
ls -A
```

Expected: empty output (or just `.git` listed if `-A` is interpreted differently — only `.git` is permissible).

- [ ] **Step 5: Commit main's .gitignore change**

The `.gitignore` we edited in Step 2 belongs to **main's** working tree, not the worktree. Switch back to main to stage and commit it:

```bash
cd /home/frosty/Dev/ai/adventure
git add .gitignore
git commit -m "chore: ignore lab/local-models worktree path"
```

No commit yet inside the worktree — it stays empty until Task 2. Return to the worktree before continuing:

```bash
cd .claude/worktrees/local-models
```

---

## Task 2: Bootstrap the minimal Bun project

**Files (all inside `.claude/worktrees/local-models/`):**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `results/.gitkeep`

All work in this task happens from inside the worktree directory.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "lab-local-models",
  "private": true,
  "type": "module",
  "scripts": {
    "probe": "bun probe.ts",
    "test": "bun test"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
results/*.txt
results/*.html
bun.lock
.DS_Store
```

- [ ] **Step 4: Create the results directory placeholder**

```bash
mkdir -p results && touch results/.gitkeep
```

- [ ] **Step 5: Install devDependencies**

```bash
bun install
```

Expected: a `bun.lock` is created and `node_modules/` populated with `bun-types`.

- [ ] **Step 6: Commit the bootstrap**

```bash
git add package.json tsconfig.json .gitignore results/.gitkeep
git commit -m "chore: bootstrap minimal Bun project for local-models probe lab"
```

---

## Task 3: Snapshot fixtures from main into the lab

**Files (inside the worktree):**
- Create: `fixtures/play-log.jsonl` (copy from main)
- Create: `fixtures/world-stack.json` (copy from main)
- Create: `fixtures/narrator-system.txt` (extract from `src/engine.ts` in main)

The main repo lives three directories up from the worktree (`../../..` resolves to `/home/frosty/Dev/ai/adventure`). All copy commands are run from inside the worktree.

- [ ] **Step 1: Create fixtures directory and copy the play-log + world-stack**

```bash
mkdir -p fixtures
cp ../../../play-log.jsonl fixtures/play-log.jsonl
cp ../../../world-stack.json fixtures/world-stack.json
```

- [ ] **Step 2: Extract `NARRATOR_SYSTEM` text from main into `fixtures/narrator-system.txt`**

Open `../../../src/engine.ts` and locate the `export const NARRATOR_SYSTEM = \`...\`;` declaration (currently starting around line 4). Copy the **string contents** (everything between the backticks, NOT the `export const` line or the trailing semicolon) into `fixtures/narrator-system.txt`. Use the Read tool on the source then Write the destination — do not attempt to `sed` it out.

- [ ] **Step 3: Sanity-check the fixtures**

```bash
head -1 fixtures/play-log.jsonl | head -c 200 && echo
wc -l fixtures/play-log.jsonl
wc -c fixtures/narrator-system.txt
head -c 80 fixtures/world-stack.json && echo
```

Expected:
- `fixtures/play-log.jsonl`: first line is a JSON object containing `"turn":1`, `"input":...`, etc.
- Line count > 0.
- `fixtures/narrator-system.txt`: byte count > 3000 (the prompt is large — currently ~7KB).
- `fixtures/world-stack.json`: starts with `{`.

- [ ] **Step 4: Commit fixtures**

```bash
git add fixtures/
git commit -m "chore: snapshot play-log, world-stack, and narrator system prompt as fixtures"
```

---

## Task 4: Implement and test `loadTurn`

**Files (inside the worktree):**
- Create: `probe.ts`
- Create: `probe.test.ts`

`loadTurn(turnIndex)` reads `fixtures/play-log.jsonl`, finds the entry whose `turn` field matches, and returns it.

- [ ] **Step 1: Write the function in `probe.ts`**

```ts
export interface PlayLogEntry {
  ts: string;
  turn: number;
  input: string;
  position: [number, number];
  narrative: string;
}

const FIXTURES_PATH = new URL("./fixtures/", import.meta.url);

export async function loadTurn(turnIndex: number): Promise<PlayLogEntry> {
  const text = await Bun.file(new URL("play-log.jsonl", FIXTURES_PATH)).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as PlayLogEntry;
    if (entry.turn === turnIndex) return entry;
  }
  throw new Error(`No entry with turn=${turnIndex} in play-log fixture`);
}
```

- [ ] **Step 2: Write a test in `probe.test.ts`**

```ts
import { test, expect } from "bun:test";
import { loadTurn } from "./probe";

test("loadTurn returns the first turn from the fixture", async () => {
  const entry = await loadTurn(1);
  expect(entry.turn).toBe(1);
  expect(typeof entry.input).toBe("string");
  expect(entry.input.length).toBeGreaterThan(0);
  expect(Array.isArray(entry.position)).toBe(true);
  expect(entry.position).toHaveLength(2);
});

test("loadTurn throws on a missing turn", async () => {
  await expect(loadTurn(999_999)).rejects.toThrow(/No entry with turn=999999/);
});
```

- [ ] **Step 3: Run the tests**

```bash
bun test probe.test.ts
```

Expected: 2 pass.

- [ ] **Step 4: Commit**

```bash
git add probe.ts probe.test.ts
git commit -m "feat: loadTurn reads a single play-log entry from the fixture"
```

---

## Task 5: Implement and test `buildMessages`

**Files (inside the worktree):**
- Modify: `probe.ts` (add `buildMessages` and types)
- Modify: `probe.test.ts` (add tests)

`buildMessages` produces the OpenAI-style messages array. System message = the narrator system text. User message = a slice of canonical state (current tile + four cardinal neighbors) followed by `PLAYER ACTION: <input>`.

The exact `formatStackForNarrator` from `src/stack.ts` in the main app is more elaborate than what we need here. The probe uses a simplified slicer that's sufficient for "does this model produce coherent prose" evaluation.

- [ ] **Step 1: Inspect the world-stack fixture shape**

Read `fixtures/world-stack.json` to confirm the entry shape. The relevant fields are at minimum `position: [x, y]` and either a `canonical` / `description` string and / or an `entries` array of short fact strings. Pick whichever the actual fixture uses; the code below assumes a `places` array with `{ position, canonical, entries }` — adjust the type to match the fixture.

```bash
head -c 600 fixtures/world-stack.json
```

- [ ] **Step 2: Add types and `buildMessages` to `probe.ts`**

Append to `probe.ts` (after `loadTurn`):

```ts
export interface Place {
  position: [number, number];
  canonical?: string;
  entries?: string[];
}

export interface WorldStackFixture {
  places?: Place[];
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function buildMessages(opts: {
  systemPrompt: string;
  worldStack: WorldStackFixture;
  position: [number, number];
  input: string;
}): ChatMessage[] {
  const [x, y] = opts.position;
  const wanted: Array<[number, number]> = [
    [x, y],
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
  const places = opts.worldStack.places ?? [];
  const slice = places.filter((p) =>
    wanted.some(([wx, wy]) => p.position[0] === wx && p.position[1] === wy)
  );
  const stateBlock =
    slice.length === 0
      ? "CANONICAL STATE: (no nearby places established)"
      : "CANONICAL STATE:\n" +
        slice
          .map((p) => {
            const tag = `(${p.position[0]},${p.position[1]})`;
            const desc = p.canonical ?? "(no canonical description)";
            const entries = (p.entries ?? []).map((e) => `  - ${e}`).join("\n");
            return entries
              ? `${tag} ${desc}\nentries:\n${entries}`
              : `${tag} ${desc}`;
          })
          .join("\n\n");
  const userContent = `${stateBlock}\n\nPLAYER ACTION: ${opts.input}`;
  return [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: userContent },
  ];
}
```

- [ ] **Step 3: Add a fixture-loader helper for the system prompt and world-stack**

Append to `probe.ts`:

```ts
export async function loadSystemPrompt(): Promise<string> {
  return Bun.file(new URL("narrator-system.txt", FIXTURES_PATH)).text();
}

export async function loadWorldStack(): Promise<WorldStackFixture> {
  return (await Bun.file(
    new URL("world-stack.json", FIXTURES_PATH)
  ).json()) as WorldStackFixture;
}
```

- [ ] **Step 4: Add tests in `probe.test.ts`**

Append to `probe.test.ts`:

```ts
import { buildMessages, loadSystemPrompt, loadWorldStack } from "./probe";

test("buildMessages produces a system + user pair", () => {
  const messages = buildMessages({
    systemPrompt: "SYSTEM",
    worldStack: { places: [] },
    position: [0, 0],
    input: "look around",
  });
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("system");
  expect(messages[0].content).toBe("SYSTEM");
  expect(messages[1].role).toBe("user");
  expect(messages[1].content).toContain("PLAYER ACTION: look around");
});

test("buildMessages includes canonical state for current tile and cardinal neighbors", () => {
  const messages = buildMessages({
    systemPrompt: "SYSTEM",
    worldStack: {
      places: [
        { position: [0, 0], canonical: "the gate", entries: ["wooden door"] },
        { position: [1, 0], canonical: "the path" },
        { position: [5, 5], canonical: "far away — should be excluded" },
      ],
    },
    position: [0, 0],
    input: "north",
  });
  const userMsg = messages[1].content;
  expect(userMsg).toContain("the gate");
  expect(userMsg).toContain("the path");
  expect(userMsg).toContain("wooden door");
  expect(userMsg).not.toContain("far away");
});

test("loadSystemPrompt reads the fixture", async () => {
  const text = await loadSystemPrompt();
  expect(text.length).toBeGreaterThan(1000);
});

test("loadWorldStack returns a parseable object", async () => {
  const stack = await loadWorldStack();
  expect(typeof stack).toBe("object");
});
```

- [ ] **Step 5: Run the tests**

```bash
bun test probe.test.ts
```

Expected: 6 pass total (the original 2 from Task 4 plus 4 new).

- [ ] **Step 6: Commit**

```bash
git add probe.ts probe.test.ts
git commit -m "feat: buildMessages assembles narrator prompt from fixtures"
```

---

## Task 6: Implement `callLMStudio` (HTTP client)

**Files (inside the worktree):**
- Modify: `probe.ts` (add `callLMStudio`)

LM Studio exposes an OpenAI-compatible API at `http://localhost:1234/v1/` by default. This function:
1. `GET /v1/models` to discover the loaded model id (LM Studio returns the currently-loaded model).
2. `POST /v1/chat/completions` with the messages array.
3. Returns both the raw HTTP response object (parsed JSON) and the model id, so the caller can dump everything.

No unit test — this requires LM Studio to be running. Smoke-tested in Task 7.

- [ ] **Step 1: Add `callLMStudio` to `probe.ts`**

Append to `probe.ts`:

```ts
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";

export interface ProbeResult {
  modelId: string;
  request: { model: string; messages: ChatMessage[]; temperature: number; max_tokens: number };
  response: unknown;
}

export async function callLMStudio(messages: ChatMessage[]): Promise<ProbeResult> {
  const modelsRes = await fetch(`${LM_STUDIO_URL}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(
      `LM Studio /v1/models returned ${modelsRes.status}. Is LM Studio running with a model loaded at ${LM_STUDIO_URL}?`
    );
  }
  const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
  const modelId = modelsJson.data?.[0]?.id;
  if (!modelId) throw new Error("LM Studio reported no loaded model");

  const request = {
    model: modelId,
    messages,
    temperature: 0.8,
    max_tokens: 1500,
  };
  const chatRes = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!chatRes.ok) {
    const body = await chatRes.text();
    throw new Error(
      `LM Studio /v1/chat/completions returned ${chatRes.status}: ${body.slice(0, 500)}`
    );
  }
  const response = await chatRes.json();
  return { modelId, request, response };
}
```

Defaults chosen to match the app's narrator (per memory: `MAX_TOKENS=1500`, narrator temperature `0.8`). These are documented in the README.

- [ ] **Step 2: Type-check the file**

```bash
bunx tsc --noEmit
```

Expected: no errors. If `bunx tsc` is unavailable, run `bun build probe.ts --outfile /tmp/probe-build.js` to surface type problems through Bun's bundler.

- [ ] **Step 3: Commit**

```bash
git add probe.ts
git commit -m "feat: callLMStudio wraps /v1/models discovery and /v1/chat/completions"
```

---

## Task 7: Wire the CLI entrypoint and smoke-test against LM Studio

**Files (inside the worktree):**
- Modify: `probe.ts` (add main entrypoint)

- [ ] **Step 1: Add the CLI entry to `probe.ts`**

Append to `probe.ts`:

```ts
async function main(): Promise<void> {
  const turnArg = process.argv[2];
  if (!turnArg) {
    console.error("usage: bun probe.ts <turn-index>");
    process.exit(2);
  }
  const turnIndex = Number.parseInt(turnArg, 10);
  if (!Number.isInteger(turnIndex)) {
    console.error(`invalid turn index: ${turnArg}`);
    process.exit(2);
  }

  const [entry, systemPrompt, worldStack] = await Promise.all([
    loadTurn(turnIndex),
    loadSystemPrompt(),
    loadWorldStack(),
  ]);
  const messages = buildMessages({
    systemPrompt,
    worldStack,
    position: entry.position,
    input: entry.input,
  });
  const result = await callLMStudio(messages);

  const dump = JSON.stringify(
    { turn: entry.turn, position: entry.position, input: entry.input, ...result },
    null,
    2
  );
  console.log(dump);

  const safeModelId = result.modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = new URL(
    `./results/${stamp}--${safeModelId}--turn-${entry.turn}.txt`,
    import.meta.url
  );
  await Bun.write(outPath, dump);
  console.error(`[probe] wrote ${outPath.pathname}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[probe] error:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Smoke test — verify the CLI runs without LM Studio**

```bash
bun probe.ts
```

Expected: prints `usage: bun probe.ts <turn-index>`, exits 2.

```bash
bun probe.ts abc
```

Expected: prints `invalid turn index: abc`, exits 2.

- [ ] **Step 3: Smoke test — run against a live LM Studio**

Manual steps (the user / executor does these):

1. Start LM Studio, load any model (e.g. `gemma-3-12b` to confirm the baseline path before swapping to a thinking model).
2. Confirm LM Studio's server is enabled (Settings → Local Server → Start; default port 1234).
3. From inside `.claude/worktrees/local-models`:

   ```bash
   bun probe.ts 1
   ```

Expected:
- stdout shows the assembled JSON: `turn`, `position`, `input`, `modelId`, `request`, `response`.
- stderr shows `[probe] wrote .../results/<stamp>--<model>--turn-1.txt`.
- A new file exists in `results/` with the same content.

If LM Studio is not running, the command exits 1 with a message containing `Is LM Studio running with a model loaded`.

- [ ] **Step 4: Commit**

```bash
git add probe.ts
git commit -m "feat: probe.ts CLI entrypoint streams raw LM Studio response to stdout and disk"
```

---

## Task 8: README

**Files (inside the worktree):**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# lab/local-models

Throwaway sandbox for evaluating local models (especially thinking models)
against the adventure narrator prompt. Lives on an orphan branch — nothing
here imports from or affects the main app.

## What it does

`bun probe.ts <turn-index>` picks a turn from the frozen play-log fixture,
reconstructs an approximation of the narrator prompt, sends it to whatever
model is currently loaded in LM Studio, and dumps the raw stringified
response to stdout and `results/`.

## Prerequisites

- Bun installed and on PATH
- LM Studio running with the local server enabled (default `http://localhost:1234`)
- A model loaded in LM Studio (you swap models manually between probe runs)

## Setup

```sh
bun install
```

## Run a probe

```sh
bun probe.ts 1     # replays turn 1 from fixtures/play-log.jsonl
bun probe.ts 42    # replays turn 42, etc.
```

Override the LM Studio URL with `LM_STUDIO_URL=http://host:port bun probe.ts 1`.

## Iteration loop

1. Load a model in LM Studio.
2. `bun probe.ts <turn>` and read the raw dump.
3. Note whether the prose lives in the post-response or inside `<think>...</think>`.
4. Unload, load the next model, repeat.

All raw dumps land in `results/` for later comparison — they're gitignored.

## Fixtures

- `fixtures/play-log.jsonl` — frozen copy of the main app's play log
- `fixtures/world-stack.json` — frozen copy of the main app's world state
- `fixtures/narrator-system.txt` — frozen snapshot of `NARRATOR_SYSTEM` from
  `src/engine.ts` in main

Re-snapshot by manually copying the latest versions from main if you want
fresher fixtures. The lab does **not** symlink — isolation is the point.

## Defaults

The probe uses the narrator's documented defaults: temperature `0.8`,
`max_tokens` `1500`. Edit `probe.ts` if you want to sweep these.

## Render mode (planned, not yet implemented)

`bun probe.ts <turn> --render` is reserved for a follow-on task that strips
`<think>...</think>` blocks and emits a styled HTML view of the cleaned
narrative. It only gets built if raw output looks promising.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for the local-models probe lab"
```

---

## Task 9 (deferred follow-on): Render mode

**Only execute this task after the raw-mode probe (Tasks 1–8) has produced output worth cleaning.** If no model's raw dump shows promising prose (in either the post-response or inside `<think>...</think>`), skip this task entirely — the spec explicitly allows abandonment.

**Files (inside the worktree):**
- Modify: `probe.ts` (add `--render` branch, `stripThinking`, `renderHtml`)
- Modify: `probe.test.ts` (add tests for `stripThinking`)

- [ ] **Step 1: Add `stripThinking` to `probe.ts`**

Append to `probe.ts`:

```ts
const THINKING_RE = /<(think|thinking|reasoning)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export function stripThinking(raw: string): { cleaned: string; firstThinkBlock: string | null } {
  let firstThinkBlock: string | null = null;
  const cleaned = raw.replace(THINKING_RE, (_, _tag, inner) => {
    if (firstThinkBlock === null) firstThinkBlock = inner;
    return "";
  }).trim();
  return { cleaned, firstThinkBlock };
}

export function extractNarrative(raw: string): string {
  const { cleaned, firstThinkBlock } = stripThinking(raw);
  if (cleaned.length > 0) return cleaned;
  if (firstThinkBlock) {
    const paragraphs = firstThinkBlock
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paragraphs.length > 0) return paragraphs[paragraphs.length - 1];
  }
  return raw.trim();
}
```

- [ ] **Step 2: Add tests in `probe.test.ts`**

Append to `probe.test.ts`:

```ts
import { stripThinking, extractNarrative } from "./probe";

test("stripThinking removes <think> blocks", () => {
  const { cleaned, firstThinkBlock } = stripThinking(
    "before<think>scratch</think>after"
  );
  expect(cleaned).toBe("beforeafter");
  expect(firstThinkBlock).toBe("scratch");
});

test("stripThinking handles <thinking> and <reasoning> variants case-insensitively", () => {
  const { cleaned } = stripThinking(
    "a<THINKING>x</THINKING>b<reasoning>y</reasoning>c"
  );
  expect(cleaned).toBe("abc");
});

test("extractNarrative falls back to the last paragraph in the think block when post-think is empty", () => {
  const raw = "<think>first paragraph.\n\nfinal paragraph here.</think>";
  expect(extractNarrative(raw)).toBe("final paragraph here.");
});

test("extractNarrative prefers post-think content when present", () => {
  const raw = "<think>scratch</think>real narrative.";
  expect(extractNarrative(raw)).toBe("real narrative.");
});
```

- [ ] **Step 3: Run tests**

```bash
bun test probe.test.ts
```

Expected: all prior tests still pass plus 4 new = 10 total.

- [ ] **Step 4: Add `renderHtml` to `probe.ts`**

Append to `probe.ts`:

```ts
export function renderHtml(opts: {
  modelId: string;
  turn: number;
  input: string;
  narrative: string;
}): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>turn ${opts.turn} — ${escape(opts.modelId)}</title>
<style>
  body { margin: 0; padding: 2rem; background: #1a1a1a; color: #e6e6e6; font-family: Inter, system-ui, sans-serif; line-height: 1.6; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .card { max-width: 700px; margin: 0 auto; }
  .input { color: #d97757; margin-bottom: 1rem; }
  .narrative { white-space: pre-wrap; }
</style></head>
<body><div class="card">
  <div class="meta">model: ${escape(opts.modelId)} · turn ${opts.turn}</div>
  <div class="input">&gt; ${escape(opts.input)}</div>
  <div class="narrative">${escape(opts.narrative)}</div>
</div></body></html>`;
}
```

- [ ] **Step 5: Wire `--render` into `main()` in `probe.ts`**

Replace the existing `main()` function with:

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const renderFlag = args.includes("--render");
  const turnArg = args.find((a) => !a.startsWith("--"));
  if (!turnArg) {
    console.error("usage: bun probe.ts <turn-index> [--render]");
    process.exit(2);
  }
  const turnIndex = Number.parseInt(turnArg, 10);
  if (!Number.isInteger(turnIndex)) {
    console.error(`invalid turn index: ${turnArg}`);
    process.exit(2);
  }

  if (renderFlag) {
    await renderMode(turnIndex);
    return;
  }

  const [entry, systemPrompt, worldStack] = await Promise.all([
    loadTurn(turnIndex),
    loadSystemPrompt(),
    loadWorldStack(),
  ]);
  const messages = buildMessages({
    systemPrompt,
    worldStack,
    position: entry.position,
    input: entry.input,
  });
  const result = await callLMStudio(messages);

  const dump = JSON.stringify(
    { turn: entry.turn, position: entry.position, input: entry.input, ...result },
    null,
    2
  );
  console.log(dump);

  const safeModelId = result.modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = new URL(
    `./results/${stamp}--${safeModelId}--turn-${entry.turn}.txt`,
    import.meta.url
  );
  await Bun.write(outPath, dump);
  console.error(`[probe] wrote ${outPath.pathname}`);
}

async function renderMode(turnIndex: number): Promise<void> {
  const glob = new Bun.Glob(`results/*--turn-${turnIndex}.txt`);
  const files: string[] = [];
  for await (const f of glob.scan(".")) files.push(f);
  files.sort();
  const latest = files.at(-1);
  if (!latest) {
    console.error(`[probe] no raw result for turn ${turnIndex} in results/`);
    process.exit(1);
  }
  const dump = JSON.parse(await Bun.file(latest).text()) as {
    turn: number;
    input: string;
    modelId: string;
    response: { choices?: Array<{ message?: { content?: string } }> };
  };
  const rawContent = dump.response?.choices?.[0]?.message?.content ?? "";
  const narrative = extractNarrative(rawContent);
  const html = renderHtml({
    modelId: dump.modelId,
    turn: dump.turn,
    input: dump.input,
    narrative,
  });
  const htmlPath = latest.replace(/\.txt$/, ".html");
  await Bun.write(htmlPath, html);
  console.log(htmlPath);
}
```

- [ ] **Step 6: Smoke test render mode**

After Task 7 has produced at least one raw result file:

```bash
bun probe.ts 1 --render
```

Expected:
- stdout: a path like `results/<stamp>--<model>--turn-1.html`
- The HTML file exists; opening it shows the cleaned narrative on a dark card.

- [ ] **Step 7: Update the README**

In `README.md`, replace the `## Render mode (planned, not yet implemented)` section with:

```markdown
## Render mode

After a raw run, render the cleaned narrative as HTML:

```sh
bun probe.ts <turn> --render
```

The newest matching `results/*--turn-<n>.txt` is parsed; `<think>...</think>`
blocks are stripped; if the post-think content is empty, the last paragraph
inside the first think block is used as the narrative (the "translation
matrix" case). HTML lands next to the raw file with a `.html` suffix.
```

- [ ] **Step 8: Commit**

```bash
git add probe.ts probe.test.ts README.md
git commit -m "feat: --render emits cleaned narrative as HTML with thinking-tag fallback"
```

---

## Done

After Task 8 (or Task 9 if executed), the lab is complete: a single-file Bun probe, deterministic fixtures, raw-dump-by-default with optional HTML rendering. The orphan branch can be deleted with `git worktree remove .claude/worktrees/local-models && git branch -D lab/local-models` once the experiment concludes — nothing here is depended on by the main app.
