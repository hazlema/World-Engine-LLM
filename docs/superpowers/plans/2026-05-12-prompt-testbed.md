# Prompt Testbed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun-native isolation testbed for the three production prompts (narrator, archivist, interpreter) with `lms`-driven model cycling, auto-scoring rubrics, and resumable unattended sweeps, on the existing `lab/local-models` branch.

**Architecture:** Two-branch split. The instrumentation hook for capturing fixtures lives on `main` (it imports from `src/`). Everything else — probes, scoring, sweep orchestration — lives on `lab/local-models`, which stays standalone (reads JSONL fixtures, never imports from `../src`). The lab's existing `probe.ts` is kept as a back-compat alias; new modules live under `probes/`, `score/`, with a top-level `sweep.ts` runner. Sweep cycles models via the `lms` CLI, runs `(stage × model × variant × snapshot)` cells with per-cell timeout, appends scored rows to a manifest as it goes, and is resumable via `--continue`.

**Tech Stack:** Bun (test runner, `Bun.$`, `Bun.file`, `Bun.serve` for nothing here), TypeScript, LM Studio's OpenAI-compatible HTTP API, the `lms` CLI for model load/unload, JSONL for all on-disk records.

**Branch policy:** Every task starts with `git status` and a check that you're on the correct branch. Phase 1 is on `main`. Phases 2–10 are on `lab/local-models`. The plan calls out switches explicitly.

---

## Phase 1 — Snapshot capture (on `main`)

### Task 1: Add SNAPSHOT_FIXTURES env-var hook to engine

Live-capture approach: when `SNAPSHOT_FIXTURES=/path/to/file.jsonl` is set, every narrator + archivist call writes a row to that file. Historical reconstruction of objective state is not reliable; live capture sidesteps the problem.

**Files:**
- Modify: `src/engine.ts`
- Test: `src/engine.test.ts` (existing; append cases)

- [ ] **Step 1: Confirm branch**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: on `main`, clean working tree (commit any in-flight work first).

- [ ] **Step 2: Write failing tests for the capture hook**

Append to `src/engine.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narratorTurn, archivistTurn } from "./engine";
import type { WorldStack } from "./stack";

function makeStack(overrides: Partial<WorldStack> = {}): WorldStack {
  return {
    entries: ["a rusted key lies on the floor here"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: { "0,0": "a stone cellar with damp walls" },
    objectives: [{ text: "Find the rusted key", achieved: false, position: [0, 0] }],
    presetSlug: null,
    ...overrides,
  };
}

test("SNAPSHOT_FIXTURES off → no fixture file written", async () => {
  const prev = process.env.SNAPSHOT_FIXTURES;
  delete process.env.SNAPSHOT_FIXTURES;
  // Stub api.callModel so the test runs offline.
  const api = await import("./api");
  const orig = api.callModel;
  (api as any).callModel = async () => "narration text";
  try {
    await narratorTurn(makeStack(), "look");
  } finally {
    (api as any).callModel = orig;
    if (prev !== undefined) process.env.SNAPSHOT_FIXTURES = prev;
  }
  // Nothing to assert on file system — the test passes by not throwing.
  expect(true).toBe(true);
});

test("SNAPSHOT_FIXTURES on → narrator + archivist rows appended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snap-"));
  const fixturePath = join(dir, "out.jsonl");
  process.env.SNAPSHOT_FIXTURES = fixturePath;
  const api = await import("./api");
  const origCall = api.callModel;
  const origStructured = api.callModelStructured;
  (api as any).callModel = async () => "you find a rusted key on the floor.";
  (api as any).callModelStructured = async () => ({
    entries: ["the rusted key is in the player's hand"],
    threads: [],
    moved: false,
    locationDescription: "a stone cellar",
    achievedObjectiveIndices: [0],
  });
  try {
    const stack = makeStack();
    const narrative = await narratorTurn(stack, "look");
    await archivistTurn(stack, narrative);
  } finally {
    (api as any).callModel = origCall;
    (api as any).callModelStructured = origStructured;
    delete process.env.SNAPSHOT_FIXTURES;
  }
  const text = await Bun.file(fixturePath).text();
  const lines = text.trim().split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  const narratorRow = JSON.parse(lines[0]);
  const archivistRow = JSON.parse(lines[1]);
  expect(narratorRow.stage).toBe("narrator");
  expect(narratorRow.snapshotId).toMatch(/^t\d+$/);
  expect(narratorRow.narrator.userMessage).toContain("PLAYER ACTION: look");
  expect(narratorRow.narrator.userMessage).toContain("rusted key");
  expect(narratorRow.narrator.mustNameTarget).toBe("key");
  expect(archivistRow.stage).toBe("archivist");
  expect(archivistRow.archivist.userMessage).toContain("NEW NARRATIVE:");
  expect(archivistRow.archivist.narrativePassage).toContain("rusted key");
  expect(archivistRow.archivist.objectiveCount).toBe(1);
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
bun test src/engine.test.ts
```

Expected: the two new tests fail (`SNAPSHOT_FIXTURES on → narrator + archivist rows appended` will fail because no file is written; the off-test will pass trivially).

- [ ] **Step 4: Implement the hook**

In `src/engine.ts`, add a private helper near the top (after the imports) and call it inside `narratorTurn` and `archivistTurn`:

```ts
// Extract the trailing-noun anchor from a LOCATE-style objective text.
// Mirrors inferLocateCompletions in src/stack.ts. Returns null if not LOCATE-shaped.
function extractMustNameAnchor(objectiveText: string): string | null {
  const m = objectiveText.match(/^(?:Find|Locate|Reach|Discover the location of)\s+(?:the\s+)?(.+)$/i);
  if (!m || !m[1]) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => w.length > 2);
  const last = words[words.length - 1];
  if (!last) return null;
  return last.toLowerCase();
}

async function appendSnapshot(row: Record<string, unknown>): Promise<void> {
  const path = process.env.SNAPSHOT_FIXTURES;
  if (!path) return;
  const line = JSON.stringify(row) + "\n";
  const existing = await Bun.file(path).exists() ? await Bun.file(path).text() : "";
  await Bun.write(path, existing + line);
}
```

Then, inside `narratorTurn`, replace the body so the input is captured before the API call and a row is appended after:

```ts
export async function narratorTurn(
  stack: WorldStack,
  playerInput: string,
  briefing?: string
): Promise<string> {
  const input = `${formatStackForNarrator(stack, briefing)}PLAYER ACTION: ${playerInput}`;
  // Determine mustNameTarget: first active LOCATE-style objective on the current tile.
  let mustNameTarget: string | null = null;
  for (const obj of stack.objectives) {
    if (obj.achieved) continue;
    if (!obj.position) continue;
    if (obj.position[0] !== stack.position[0] || obj.position[1] !== stack.position[1]) continue;
    const anchor = extractMustNameAnchor(obj.text);
    if (anchor) { mustNameTarget = anchor; break; }
  }
  await appendSnapshot({
    stage: "narrator",
    snapshotId: `t${stack.turn}`,
    turn: stack.turn,
    position: stack.position,
    playerInput,
    narrator: { userMessage: input, mustNameTarget },
  });
  const raw = await api.callModel(NARRATOR_SYSTEM, input);
  return stripNarratorMarkup(raw);
}
```

And inside `archivistTurn`, capture before the API call:

```ts
export async function archivistTurn(
  stack: WorldStack,
  narrative: string
): Promise<ArchivistResult> {
  const input = `${formatStackForArchivist(stack)}NEW NARRATIVE:\n${narrative}\n\nReturn updated entries, threads, whether the player moved to a new location, a 1-2 sentence canonical description of the place the player is now at, and the indices of any objectives just completed:`;
  await appendSnapshot({
    stage: "archivist",
    snapshotId: `t${stack.turn}`,
    turn: stack.turn,
    position: stack.position,
    archivist: {
      userMessage: input,
      narrativePassage: narrative,
      objectiveCount: stack.objectives.length,
    },
  });
  const result = await api.callModelStructured<{
    entries: string[];
    threads: string[];
    moved?: boolean;
    locationDescription?: string;
    achievedObjectiveIndices?: unknown;
  }>(ARCHIVIST_SYSTEM, input, "world_stack", ARCHIVIST_SCHEMA);
  // ... (rest of body unchanged)
```

Leave the rest of `archivistTurn` (the result-shape handling) untouched.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun test src/engine.test.ts
```

Expected: all tests in `src/engine.test.ts` pass, including the two new SNAPSHOT_FIXTURES cases.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "$(cat <<'EOF'
feat(engine): SNAPSHOT_FIXTURES hook for lab testbed

When the env var is set, narratorTurn and archivistTurn append a per-turn
JSONL row capturing the exact user-message they send. The mustNameTarget
field is extracted with the same regex inferLocateCompletions uses, so the
lab can score "did narrator name the LOCATE target" against the same anchor
production uses for completion.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Capture a real fixture session

This is a manual gameplay step. The engineer (or Claude) plays a session with the env var set, producing the `snapshots.jsonl` the lab will read.

**Files:**
- Create: `/tmp/lab-snapshots.jsonl` (temporary)
- Eventual destination: `lab/local-models/fixtures/snapshots.jsonl`

- [ ] **Step 1: Start the server with the env var set**

```bash
SNAPSHOT_FIXTURES=/tmp/lab-snapshots.jsonl bun --hot src/server.ts
```

- [ ] **Step 2: Play a session covering required scenarios**

Open the web UI. Play through scenarios that the spec mandates:
- ≥5 turns where a LOCATE objective is active on the current tile (e.g. start a preset with a "Find the X" objective; move to its tile)
- ≥3 turns with `look` / `inspect` / `examine` commands
- ≥3 turns at boundary tiles (move to a tile that hasn't been visited)
- Cover early/mid/late game positions

20 total turns is the target. Stop the server (`Ctrl-C`) when done.

- [ ] **Step 3: Validate the captured file**

```bash
wc -l /tmp/lab-snapshots.jsonl
head -1 /tmp/lab-snapshots.jsonl | bun -e "console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()), null, 2))"
```

Expected: ≥40 lines (one narrator + one archivist row per turn × 20 turns); the first record validates as JSON with the documented shape (`stage`, `snapshotId`, `turn`, etc.).

- [ ] **Step 4: Verify mustNameTarget coverage**

```bash
grep '"mustNameTarget":"' /tmp/lab-snapshots.jsonl | grep -v '"mustNameTarget":null' | wc -l
```

Expected: ≥5 (matches the spec floor for LOCATE-active turns). If fewer, play more turns with a "Find the X" objective active.

---

## Phase 2 — Lab branch setup (switch to `lab/local-models`)

### Task 3: Switch to lab branch and copy fixtures + seed prompts

**Files:**
- Create: `fixtures/snapshots.jsonl` (copied from /tmp)
- Create: `fixtures/interpreter-cases.jsonl`
- Create: `fixtures/prompts/narrator/v0-baseline.txt`
- Create: `fixtures/prompts/archivist/v0-baseline.txt`
- Create: `fixtures/prompts/interpreter/v0-baseline.txt`

- [ ] **Step 1: Snapshot the current production prompts before switching branches**

While still on `main`:

```bash
bun -e "import('./src/engine').then(m => { Bun.write('/tmp/v0-narrator.txt', m.NARRATOR_SYSTEM); Bun.write('/tmp/v0-archivist.txt', m.ARCHIVIST_SYSTEM); Bun.write('/tmp/v0-interpreter.txt', m.INTERPRETER_SYSTEM); })"
ls -la /tmp/v0-*.txt
```

Expected: three non-empty files at `/tmp/v0-narrator.txt`, `/tmp/v0-archivist.txt`, `/tmp/v0-interpreter.txt`.

- [ ] **Step 2: Switch to lab branch**

```bash
git checkout lab/local-models
git status
```

Expected: on `lab/local-models`, clean.

- [ ] **Step 3: Create directories**

```bash
mkdir -p fixtures/prompts/narrator fixtures/prompts/archivist fixtures/prompts/interpreter
mkdir -p probes score results
```

- [ ] **Step 4: Move fixtures and prompts into place**

```bash
mv /tmp/lab-snapshots.jsonl fixtures/snapshots.jsonl
mv /tmp/v0-narrator.txt fixtures/prompts/narrator/v0-baseline.txt
mv /tmp/v0-archivist.txt fixtures/prompts/archivist/v0-baseline.txt
mv /tmp/v0-interpreter.txt fixtures/prompts/interpreter/v0-baseline.txt
```

- [ ] **Step 5: Write interpreter-cases.jsonl**

Create `fixtures/interpreter-cases.jsonl` with the following content:

```jsonl
{"id":"i1","input":"go north","expected":"move-north"}
{"id":"i2","input":"n","expected":"move-north"}
{"id":"i3","input":"head south","expected":"move-south"}
{"id":"i4","input":"east","expected":"move-east"}
{"id":"i5","input":"walk west","expected":"move-west"}
{"id":"i6","input":"go north through the door","expected":"move-north"}
{"id":"i7","input":"head north then look around","expected":"move-north"}
{"id":"i8","input":"look around","expected":"stay"}
{"id":"i9","input":"examine the door","expected":"stay"}
{"id":"i10","input":"wait","expected":"stay"}
{"id":"i11","input":"talk to the woman","expected":"stay"}
{"id":"i12","input":"pick up the satchel","expected":"stay"}
{"id":"i13","input":"grab the rusted key","expected":"stay"}
{"id":"i14","input":"open the chest","expected":"stay"}
{"id":"i15","input":"head toward the crater","expected":"move-blocked"}
{"id":"i16","input":"follow the path","expected":"move-blocked"}
{"id":"i17","input":"go through the door","expected":"move-blocked"}
{"id":"i18","input":"walk to the lander","expected":"move-blocked"}
{"id":"i19","input":"head up the road","expected":"move-blocked"}
{"id":"i20","input":"return to the ship","expected":"move-blocked"}
{"id":"i21","input":"northeast","expected":"move-blocked"}
{"id":"i22","input":"northwest into the trees","expected":"move-north"}
```

(i22 deliberately tests the "if a cardinal is named anywhere, classify by it" rule — `northwest` contains `north`.)

- [ ] **Step 6: Update .gitignore to ignore raw sweep results**

Append to `.gitignore`:

```
results/raw/
results/*/sweep.log
```

- [ ] **Step 7: Commit**

```bash
git add fixtures/ .gitignore
git commit -m "$(cat <<'EOF'
feat(lab): seed snapshots, interpreter cases, and v0-baseline prompts

Production prompts copied verbatim from src/engine.ts on main as v0 controls.
Snapshots captured via the SNAPSHOT_FIXTURES hook over a ~20-turn session.
Interpreter cases hand-labeled to cover cardinals, abbreviations, compound
commands, non-cardinal verbs, and the "cardinal-anywhere" rule.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Shared module

### Task 4: Build probes/shared.ts (types, loaders, LM Studio caller)

Extracts and generalizes the existing `probe.ts` machinery into a shared module that all three stage probes import.

**Files:**
- Create: `probes/shared.ts`
- Create: `probes/shared.test.ts`

- [ ] **Step 1: Write failing tests**

Create `probes/shared.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSnapshots,
  loadInterpreterCases,
  loadPromptVariant,
  callLMStudio,
} from "./shared";

test("loadSnapshots parses JSONL and groups by snapshotId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-"));
  const file = join(dir, "snaps.jsonl");
  await Bun.write(file, [
    JSON.stringify({ stage: "narrator", snapshotId: "t1", turn: 1, position: [0,0], playerInput: "look", narrator: { userMessage: "U1", mustNameTarget: null } }),
    JSON.stringify({ stage: "archivist", snapshotId: "t1", turn: 1, position: [0,0], archivist: { userMessage: "A1", narrativePassage: "N1", objectiveCount: 0 } }),
    JSON.stringify({ stage: "narrator", snapshotId: "t2", turn: 2, position: [0,1], playerInput: "north", narrator: { userMessage: "U2", mustNameTarget: "key" } }),
  ].join("\n"), { createPath: true });
  const snaps = await loadSnapshots(file);
  expect(snaps.length).toBe(2);
  expect(snaps[0].snapshotId).toBe("t1");
  expect(snaps[0].narrator?.userMessage).toBe("U1");
  expect(snaps[0].archivist?.userMessage).toBe("A1");
  expect(snaps[1].snapshotId).toBe("t2");
  expect(snaps[1].narrator?.mustNameTarget).toBe("key");
  await rm(dir, { recursive: true });
});

test("loadInterpreterCases parses JSONL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-"));
  const file = join(dir, "cases.jsonl");
  await Bun.write(file, [
    JSON.stringify({ id: "i1", input: "n", expected: "move-north" }),
    JSON.stringify({ id: "i2", input: "look", expected: "stay" }),
  ].join("\n"));
  const cases = await loadInterpreterCases(file);
  expect(cases.length).toBe(2);
  expect(cases[0].id).toBe("i1");
  expect(cases[1].expected).toBe("stay");
  await rm(dir, { recursive: true });
});

test("loadPromptVariant rejects bad variant names", async () => {
  await expect(loadPromptVariant("narrator", "../etc/passwd")).rejects.toThrow();
});

test("callLMStudio (injected fetch) returns model id + body", async () => {
  const fakeFetch = async (url: string) => {
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "fake-model" }] }), { status: 200 });
    }
    if (url.endsWith("/v1/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const result = await callLMStudio(
    [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    { fetchImpl: fakeFetch, baseUrl: "http://localhost:1234" },
  );
  expect(result.modelId).toBe("fake-model");
  expect((result.response as any).choices[0].message.content).toBe("hello");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test probes/shared.test.ts
```

Expected: module-not-found errors for `./shared`.

- [ ] **Step 3: Implement shared.ts**

Create `probes/shared.ts`:

```ts
const FIXTURES_PATH = new URL("../fixtures/", import.meta.url);

export type Stage = "narrator" | "archivist" | "interpreter";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface NarratorSnapshotPart {
  userMessage: string;
  mustNameTarget: string | null;
}

export interface ArchivistSnapshotPart {
  userMessage: string;
  narrativePassage: string;
  objectiveCount: number;
}

export interface Snapshot {
  snapshotId: string;
  turn: number;
  position: [number, number];
  playerInput?: string;
  narrator?: NarratorSnapshotPart;
  archivist?: ArchivistSnapshotPart;
}

interface RawRow {
  stage: "narrator" | "archivist";
  snapshotId: string;
  turn: number;
  position: [number, number];
  playerInput?: string;
  narrator?: NarratorSnapshotPart;
  archivist?: ArchivistSnapshotPart;
}

export async function loadSnapshots(path: string): Promise<Snapshot[]> {
  const text = await Bun.file(path).text();
  const rows: RawRow[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawRow);
  const byId = new Map<string, Snapshot>();
  for (const row of rows) {
    let snap = byId.get(row.snapshotId);
    if (!snap) {
      snap = {
        snapshotId: row.snapshotId,
        turn: row.turn,
        position: row.position,
        playerInput: row.playerInput,
      };
      byId.set(row.snapshotId, snap);
    }
    if (row.stage === "narrator" && row.narrator) snap.narrator = row.narrator;
    if (row.stage === "archivist" && row.archivist) snap.archivist = row.archivist;
  }
  return [...byId.values()].sort((a, b) => a.turn - b.turn);
}

export interface InterpreterCase {
  id: string;
  input: string;
  expected: "move-north" | "move-south" | "move-east" | "move-west" | "stay" | "move-blocked";
}

export async function loadInterpreterCases(path: string): Promise<InterpreterCase[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as InterpreterCase);
}

export async function loadPromptVariant(stage: Stage, variant: string): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/.test(variant)) {
    throw new Error(`Invalid variant name "${variant}" — letters, digits, dots, hyphens, underscores only`);
  }
  if (!["narrator", "archivist", "interpreter"].includes(stage)) {
    throw new Error(`Invalid stage "${stage}"`);
  }
  const file = Bun.file(new URL(`prompts/${stage}/${variant}.txt`, FIXTURES_PATH));
  if (!(await file.exists())) {
    throw new Error(`No prompt fixture at fixtures/prompts/${stage}/${variant}.txt`);
  }
  return file.text();
}

export interface CallOpts {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: object };
  timeoutMs?: number;
}

export interface ProbeResult {
  modelId: string;
  request: { model: string; messages: ChatMessage[]; temperature: number; max_tokens: number };
  response: unknown;
}

export async function callLMStudio(messages: ChatMessage[], opts: CallOpts = {}): Promise<ProbeResult> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
  const modelsRes = await f(`${baseUrl}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`LM Studio /v1/models returned ${modelsRes.status}`);
  }
  const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
  const modelId = modelsJson.data?.[0]?.id;
  if (!modelId) throw new Error("LM Studio reported no loaded model");

  const request = {
    model: modelId,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? 1500,
  };
  const body: Record<string, unknown> = { ...request };
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const ctrl = new AbortController();
  const t = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  try {
    const chatRes = await f(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!chatRes.ok) {
      const text = await chatRes.text();
      throw new Error(`LM Studio /v1/chat/completions returned ${chatRes.status}: ${text.slice(0, 500)}`);
    }
    const response = await chatRes.json();
    return { modelId, request, response };
  } finally {
    if (t) clearTimeout(t);
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test probes/shared.test.ts
```

Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add probes/shared.ts probes/shared.test.ts
git commit -m "$(cat <<'EOF'
feat(lab): probes/shared module — types, loaders, LM Studio caller

Snapshots are loaded by merging the per-stage narrator+archivist rows
written by the SNAPSHOT_FIXTURES hook on main. callLMStudio accepts a
fetchImpl for testability and a timeoutMs for sweep robustness.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Stage probes

### Task 5: Build probes/narrator.ts

**Files:**
- Create: `probes/narrator.ts`
- Create: `probes/narrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `probes/narrator.test.ts`:

```ts
import { test, expect } from "bun:test";
import { runNarratorProbe } from "./narrator";
import type { Snapshot } from "./shared";

const fakeSnap: Snapshot = {
  snapshotId: "t1",
  turn: 1,
  position: [0, 0],
  playerInput: "look",
  narrator: { userMessage: "CANONICAL STATE:\n(here)\n\nPLAYER ACTION: look", mustNameTarget: null },
};

test("runNarratorProbe sends system+user and returns content", async () => {
  let seen: any = null;
  const fakeFetch = async (url: string, init?: any) => {
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "fake" }] }), { status: 200 });
    }
    seen = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "you look around." } }] }), { status: 200 });
  };
  const out = await runNarratorProbe({
    snapshot: fakeSnap,
    systemPrompt: "SYS",
    fetchImpl: fakeFetch,
  });
  expect(out.content).toBe("you look around.");
  expect(seen.messages[0]).toEqual({ role: "system", content: "SYS" });
  expect(seen.messages[1].content).toContain("PLAYER ACTION: look");
});

test("runNarratorProbe throws if snapshot lacks narrator part", async () => {
  await expect(
    runNarratorProbe({
      snapshot: { ...fakeSnap, narrator: undefined },
      systemPrompt: "SYS",
      fetchImpl: async () => new Response("", { status: 200 }),
    }),
  ).rejects.toThrow(/missing narrator/);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test probes/narrator.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement narrator.ts**

Create `probes/narrator.ts`:

```ts
import { callLMStudio, type Snapshot, type ChatMessage } from "./shared";

export interface NarratorProbeOpts {
  snapshot: Snapshot;
  systemPrompt: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface NarratorProbeResult {
  modelId: string;
  content: string;
  raw: unknown;
}

export async function runNarratorProbe(opts: NarratorProbeOpts): Promise<NarratorProbeResult> {
  if (!opts.snapshot.narrator) {
    throw new Error(`snapshot ${opts.snapshot.snapshotId} missing narrator part`);
  }
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.snapshot.narrator.userMessage },
  ];
  const { modelId, response } = await callLMStudio(messages, {
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    temperature: opts.temperature ?? 0.8,
    maxTokens: opts.maxTokens ?? 1500,
  });
  const content = (response as any)?.choices?.[0]?.message?.content ?? "";
  return { modelId, content: String(content), raw: response };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test probes/narrator.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add probes/narrator.ts probes/narrator.test.ts
git commit -m "feat(lab): narrator probe module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Build probes/archivist.ts

**Files:**
- Create: `probes/archivist.ts`
- Create: `probes/archivist.test.ts`

- [ ] **Step 1: Write failing tests**

Create `probes/archivist.test.ts`:

```ts
import { test, expect } from "bun:test";
import { runArchivistProbe } from "./archivist";
import type { Snapshot } from "./shared";

const fakeSnap: Snapshot = {
  snapshotId: "t1",
  turn: 1,
  position: [0, 0],
  archivist: { userMessage: "STACK:\n...\nNEW NARRATIVE:\nyou look around.", narrativePassage: "you look around.", objectiveCount: 0 },
};

test("runArchivistProbe requests JSON response_format and returns parsed", async () => {
  let body: any = null;
  const fakeFetch = async (url: string, init?: any) => {
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "fake" }] }));
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ entries: ["a"], threads: [] }) } }],
    }), { status: 200 });
  };
  const out = await runArchivistProbe({ snapshot: fakeSnap, systemPrompt: "SYS", fetchImpl: fakeFetch });
  expect(out.content).toBe(JSON.stringify({ entries: ["a"], threads: [] }));
  expect(body.response_format).toEqual({ type: "json_object" });
});

test("runArchivistProbe throws if snapshot lacks archivist part", async () => {
  await expect(
    runArchivistProbe({
      snapshot: { ...fakeSnap, archivist: undefined },
      systemPrompt: "SYS",
      fetchImpl: async () => new Response("", { status: 200 }),
    }),
  ).rejects.toThrow(/missing archivist/);
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
bun test probes/archivist.test.ts
```

- [ ] **Step 3: Implement archivist.ts**

Create `probes/archivist.ts`:

```ts
import { callLMStudio, type Snapshot, type ChatMessage } from "./shared";

export interface ArchivistProbeOpts {
  snapshot: Snapshot;
  systemPrompt: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ArchivistProbeResult {
  modelId: string;
  content: string;
  raw: unknown;
}

export async function runArchivistProbe(opts: ArchivistProbeOpts): Promise<ArchivistProbeResult> {
  if (!opts.snapshot.archivist) {
    throw new Error(`snapshot ${opts.snapshot.snapshotId} missing archivist part`);
  }
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.snapshot.archivist.userMessage },
  ];
  const { modelId, response } = await callLMStudio(messages, {
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    temperature: 0.4,
    maxTokens: 1500,
    responseFormat: { type: "json_object" },
  });
  const content = (response as any)?.choices?.[0]?.message?.content ?? "";
  return { modelId, content: String(content), raw: response };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test probes/archivist.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add probes/archivist.ts probes/archivist.test.ts
git commit -m "feat(lab): archivist probe module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Build probes/interpreter.ts

**Files:**
- Create: `probes/interpreter.ts`
- Create: `probes/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `probes/interpreter.test.ts`:

```ts
import { test, expect } from "bun:test";
import { runInterpreterProbe } from "./interpreter";
import type { InterpreterCase } from "./shared";

const fakeCase: InterpreterCase = { id: "i1", input: "go north", expected: "move-north" };

test("runInterpreterProbe sends PLAYER INPUT: prefix and returns content", async () => {
  let body: any = null;
  const fakeFetch = async (url: string, init?: any) => {
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "fake" }] }));
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ action: "move-north" }) } }],
    }), { status: 200 });
  };
  const out = await runInterpreterProbe({ caseRow: fakeCase, systemPrompt: "SYS", fetchImpl: fakeFetch });
  expect(out.content).toContain("move-north");
  expect(body.messages[1].content).toBe("PLAYER INPUT: go north");
  expect(body.response_format).toEqual({ type: "json_object" });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test probes/interpreter.test.ts
```

- [ ] **Step 3: Implement interpreter.ts**

Create `probes/interpreter.ts`:

```ts
import { callLMStudio, type InterpreterCase, type ChatMessage } from "./shared";

export interface InterpreterProbeOpts {
  caseRow: InterpreterCase;
  systemPrompt: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface InterpreterProbeResult {
  modelId: string;
  content: string;
  raw: unknown;
}

export async function runInterpreterProbe(opts: InterpreterProbeOpts): Promise<InterpreterProbeResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: `PLAYER INPUT: ${opts.caseRow.input}` },
  ];
  const { modelId, response } = await callLMStudio(messages, {
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    temperature: 0.1,
    maxTokens: 100,
    responseFormat: { type: "json_object" },
  });
  const content = (response as any)?.choices?.[0]?.message?.content ?? "";
  return { modelId, content: String(content), raw: response };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test probes/interpreter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add probes/interpreter.ts probes/interpreter.test.ts
git commit -m "feat(lab): interpreter probe module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 5 — Scoring

### Task 8: Build score/narrator.ts

**Files:**
- Create: `score/narrator.ts`
- Create: `score/narrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `score/narrator.test.ts`:

```ts
import { test, expect } from "bun:test";
import { scoreNarrator } from "./narrator";

test("must_name_target passes when target appears as a whole word", () => {
  const r = scoreNarrator(
    { mustNameTarget: "key" },
    "you see a rusted key on the floor.",
  );
  const c = r.find((x) => x.name === "must_name_target")!;
  expect(c.pass).toBe(true);
});

test("must_name_target passes on plural", () => {
  const r = scoreNarrator({ mustNameTarget: "key" }, "you see two keys here.");
  expect(r.find((x) => x.name === "must_name_target")!.pass).toBe(true);
});

test("must_name_target fails when target is absent", () => {
  const r = scoreNarrator({ mustNameTarget: "key" }, "you see a door.");
  expect(r.find((x) => x.name === "must_name_target")!.pass).toBe(false);
});

test("must_name_target is skipped when target is null", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "you see a door.");
  expect(r.find((x) => x.name === "must_name_target")).toBeUndefined();
});

test("no_label_leak fails on Sound: line start", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "you look around.\nSound: a single bell.");
  expect(r.find((x) => x.name === "no_label_leak")!.pass).toBe(false);
});

test("no_label_leak fails on OBJECTIVE: leak", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "OBJECTIVE: find the key.");
  expect(r.find((x) => x.name === "no_label_leak")!.pass).toBe(false);
});

test("no_label_leak passes on clean prose", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "you walk into the cellar. dust drifts down.");
  expect(r.find((x) => x.name === "no_label_leak")!.pass).toBe(true);
});

test("no_menu_closer fails on 'What do you do?'", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "the room is dark.\nWhat do you do?");
  expect(r.find((x) => x.name === "no_menu_closer")!.pass).toBe(false);
});

test("no_menu_closer passes on a beat closer", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "the room is dark. a small object glints in the corner.");
  expect(r.find((x) => x.name === "no_menu_closer")!.pass).toBe(true);
});

test("plausible_length is true for 80-400 words", () => {
  const text = "word ".repeat(150).trim();
  const r = scoreNarrator({ mustNameTarget: null }, text);
  expect(r.find((x) => x.name === "plausible_length")!.pass).toBe(true);
});

test("plausible_length is false for too-short output", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "tiny.");
  expect(r.find((x) => x.name === "plausible_length")!.pass).toBe(false);
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test score/narrator.test.ts
```

- [ ] **Step 3: Implement narrator scoring**

Create `score/narrator.ts`:

```ts
export interface CheckResult {
  name: string;
  pass: boolean;
  note?: string;
}

export interface NarratorScoreInput {
  mustNameTarget: string | null;
}

const LABEL_LEAK_RE = /^\s*(Sound|Tone|Mood|OBJECTIVE|MISSION BRIEFING|CANONICAL STATE|ACTIVE THREADS|MUST-NAME|ESTABLISHED WORLD|CURRENT LOCATION|OFF-TILE OBJECTIVES|PLAYER ACTION)\s*:/im;

const MENU_CLOSER_RES = [
  /what do you do\??\s*$/i,
  /what(?:'s| is) your next move\??\s*$/i,
  /will you [^.?!]+\?\s*$/i,
  /\bchoose:\s*$/im,
];

export function scoreNarrator(input: NarratorScoreInput, output: string): CheckResult[] {
  const results: CheckResult[] = [];

  if (input.mustNameTarget) {
    const anchor = input.mustNameTarget.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word-boundary match with optional plural -s/-es.
    const re = new RegExp(`\\b${anchor}(?:e?s)?\\b`, "i");
    results.push({ name: "must_name_target", pass: re.test(output) });
  }

  // no_label_leak: scan each line, fail if any matches the label-start regex.
  let leakFound: string | null = null;
  for (const line of output.split("\n")) {
    if (LABEL_LEAK_RE.test(line)) { leakFound = line.slice(0, 80); break; }
  }
  results.push({
    name: "no_label_leak",
    pass: leakFound === null,
    ...(leakFound ? { note: `leaked: "${leakFound}"` } : {}),
  });

  const menuMatch = MENU_CLOSER_RES.find((re) => re.test(output));
  results.push({
    name: "no_menu_closer",
    pass: !menuMatch,
    ...(menuMatch ? { note: `matched ${menuMatch.source}` } : {}),
  });

  const wordCount = output.trim().split(/\s+/).filter(Boolean).length;
  results.push({
    name: "plausible_length",
    pass: wordCount >= 80 && wordCount <= 400,
    note: `${wordCount} words`,
  });

  return results;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test score/narrator.test.ts
```

Expected: all eleven tests pass.

- [ ] **Step 5: Commit**

```bash
git add score/narrator.ts score/narrator.test.ts
git commit -m "feat(lab): narrator scoring rubric

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Build score/archivist.ts

**Files:**
- Create: `score/archivist.ts`
- Create: `score/archivist.test.ts`

- [ ] **Step 1: Write failing tests**

Create `score/archivist.test.ts`:

```ts
import { test, expect } from "bun:test";
import { scoreArchivist } from "./archivist";

const baseInput = {
  narrativePassage: "you find a rusted key on the floor of the cellar.",
  objectiveCount: 2,
};

test("json_parse fails on non-JSON", () => {
  const r = scoreArchivist(baseInput, "not json");
  expect(r.find((x) => x.name === "json_parse")!.pass).toBe(false);
  // Other checks should be skipped (hard-fail short-circuits).
  expect(r.find((x) => x.name === "schema_valid")).toBeUndefined();
});

test("schema_valid fails when entries is not an array", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({ entries: "nope", threads: [] }));
  expect(r.find((x) => x.name === "schema_valid")!.pass).toBe(false);
});

test("schema_valid passes minimal shape", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({ entries: [], threads: [] }));
  expect(r.find((x) => x.name === "schema_valid")!.pass).toBe(true);
});

test("entry_count_sane fails on 9+ entries", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: ["a","b","c","d","e","f","g","h","i"],
    threads: [],
  }));
  expect(r.find((x) => x.name === "entry_count_sane")!.pass).toBe(false);
});

test("entries_reference_input passes when entries share tokens with passage", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: ["the rusted key is held"],
    threads: [],
  }));
  expect(r.find((x) => x.name === "entries_reference_input")!.pass).toBe(true);
});

test("entries_reference_input fails on token-disjoint entry", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: ["dragon eggs glimmer overhead"],
    threads: [],
  }));
  expect(r.find((x) => x.name === "entries_reference_input")!.pass).toBe(false);
});

test("no_label_leak fails when entry begins with Sound:", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: ["Sound: a single bell"],
    threads: [],
  }));
  expect(r.find((x) => x.name === "no_label_leak")!.pass).toBe(false);
});

test("objective_indices_valid passes when index is within range", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: [], threads: [], achievedObjectiveIndices: [0, 1],
  }));
  expect(r.find((x) => x.name === "objective_indices_valid")!.pass).toBe(true);
});

test("objective_indices_valid fails when index exceeds objectiveCount", () => {
  const r = scoreArchivist(baseInput, JSON.stringify({
    entries: [], threads: [], achievedObjectiveIndices: [5],
  }));
  expect(r.find((x) => x.name === "objective_indices_valid")!.pass).toBe(false);
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test score/archivist.test.ts
```

- [ ] **Step 3: Implement archivist scoring**

Create `score/archivist.ts`:

```ts
import type { CheckResult } from "./narrator";

export type { CheckResult } from "./narrator";

export interface ArchivistScoreInput {
  narrativePassage: string;
  objectiveCount: number;
}

const LABEL_LEAK_RE = /^\s*(Sound|Tone|Mood|OBJECTIVE|MISSION BRIEFING|CANONICAL STATE|ACTIVE THREADS|MUST-NAME|ESTABLISHED WORLD|CURRENT LOCATION|OFF-TILE OBJECTIVES|PLAYER ACTION)\s*:/im;

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4),
  );
}

export function scoreArchivist(input: ArchivistScoreInput, output: string): CheckResult[] {
  const results: CheckResult[] = [];

  let parsed: any;
  try {
    parsed = JSON.parse(output);
    results.push({ name: "json_parse", pass: true });
  } catch (e) {
    results.push({ name: "json_parse", pass: false, note: (e as Error).message.slice(0, 80) });
    return results; // hard-fail short-circuit
  }

  const entriesOk = Array.isArray(parsed.entries) && parsed.entries.every((x: unknown) => typeof x === "string");
  const threadsOk = Array.isArray(parsed.threads) && parsed.threads.every((x: unknown) => typeof x === "string");
  const movedOk = parsed.moved === undefined || typeof parsed.moved === "boolean";
  const locOk = parsed.locationDescription === undefined || typeof parsed.locationDescription === "string";
  const idxOk = parsed.achievedObjectiveIndices === undefined ||
    (Array.isArray(parsed.achievedObjectiveIndices) &&
      parsed.achievedObjectiveIndices.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0));
  const schemaPass = entriesOk && threadsOk && movedOk && locOk && idxOk;
  results.push({
    name: "schema_valid",
    pass: schemaPass,
    ...(schemaPass ? {} : {
      note: `entries=${entriesOk} threads=${threadsOk} moved=${movedOk} loc=${locOk} idx=${idxOk}`,
    }),
  });
  if (!schemaPass) return results;

  const entries: string[] = parsed.entries;
  results.push({
    name: "entry_count_sane",
    pass: entries.length >= 0 && entries.length <= 8,
    note: `${entries.length} entries`,
  });

  const passageTokens = tokenize(input.narrativePassage);
  let firstUnref: string | null = null;
  for (const e of entries) {
    const eTokens = [...tokenize(e)];
    if (eTokens.length === 0) continue;
    if (!eTokens.some((t) => passageTokens.has(t))) { firstUnref = e.slice(0, 80); break; }
  }
  results.push({
    name: "entries_reference_input",
    pass: firstUnref === null,
    ...(firstUnref ? { note: `unref: "${firstUnref}"` } : {}),
  });

  let leak: string | null = null;
  for (const s of [...entries, ...(parsed.threads as string[])]) {
    if (LABEL_LEAK_RE.test(s)) { leak = s.slice(0, 80); break; }
  }
  results.push({
    name: "no_label_leak",
    pass: leak === null,
    ...(leak ? { note: `leaked: "${leak}"` } : {}),
  });

  if (Array.isArray(parsed.achievedObjectiveIndices)) {
    const bad = parsed.achievedObjectiveIndices.find((n: number) => n >= input.objectiveCount);
    results.push({
      name: "objective_indices_valid",
      pass: bad === undefined,
      ...(bad !== undefined ? { note: `index ${bad} >= objectiveCount ${input.objectiveCount}` } : {}),
    });
  }

  return results;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test score/archivist.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add score/archivist.ts score/archivist.test.ts
git commit -m "feat(lab): archivist scoring rubric

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Build score/interpreter.ts

**Files:**
- Create: `score/interpreter.ts`
- Create: `score/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `score/interpreter.test.ts`:

```ts
import { test, expect } from "bun:test";
import { scoreInterpreter } from "./interpreter";

test("json_parse fails on garbage", () => {
  const r = scoreInterpreter({ expected: "move-north" }, "not json");
  expect(r.find((x) => x.name === "json_parse")!.pass).toBe(false);
});

test("schema_valid fails on unknown action", () => {
  const r = scoreInterpreter({ expected: "move-north" }, JSON.stringify({ action: "fly" }));
  expect(r.find((x) => x.name === "schema_valid")!.pass).toBe(false);
});

test("matches_expected passes on correct action", () => {
  const r = scoreInterpreter({ expected: "move-north" }, JSON.stringify({ action: "move-north" }));
  expect(r.find((x) => x.name === "matches_expected")!.pass).toBe(true);
});

test("matches_expected fails on wrong action", () => {
  const r = scoreInterpreter({ expected: "move-north" }, JSON.stringify({ action: "stay" }));
  expect(r.find((x) => x.name === "matches_expected")!.pass).toBe(false);
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test score/interpreter.test.ts
```

- [ ] **Step 3: Implement interpreter scoring**

Create `score/interpreter.ts`:

```ts
import type { CheckResult } from "./narrator";

export type { CheckResult } from "./narrator";

const VALID_ACTIONS = new Set([
  "move-north", "move-south", "move-east", "move-west", "stay", "move-blocked",
]);

export interface InterpreterScoreInput {
  expected: string;
}

export function scoreInterpreter(input: InterpreterScoreInput, output: string): CheckResult[] {
  const results: CheckResult[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(output);
    results.push({ name: "json_parse", pass: true });
  } catch (e) {
    results.push({ name: "json_parse", pass: false, note: (e as Error).message.slice(0, 80) });
    return results;
  }
  const schemaPass = typeof parsed?.action === "string" && VALID_ACTIONS.has(parsed.action);
  results.push({
    name: "schema_valid",
    pass: schemaPass,
    ...(schemaPass ? {} : { note: `got action=${JSON.stringify(parsed?.action)}` }),
  });
  if (!schemaPass) return results;
  results.push({
    name: "matches_expected",
    pass: parsed.action === input.expected,
    note: `got ${parsed.action}, expected ${input.expected}`,
  });
  return results;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test score/interpreter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add score/interpreter.ts score/interpreter.test.ts
git commit -m "feat(lab): interpreter scoring rubric

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 6 — Model orchestration

### Task 11: Build lms.ts wrapper with TDD

**Files:**
- Create: `lms.ts`
- Create: `lms.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lms.test.ts`:

```ts
import { test, expect } from "bun:test";
import { listInstalledModels, parseLmsLsOutput, waitUntilModelReady } from "./lms";

test("parseLmsLsOutput extracts model ids from typical lms ls output", () => {
  const out = `LLM
You have N model(s):
  1.  gemma-3-12b-it (Q4_K_M, 7.3 GB)
  2.  ministral-instruct-3b (Q5_K_M, 2.1 GB)
  3.  qwen-2.5-7b-instruct (Q4_K_M, 4.5 GB)
`;
  const ids = parseLmsLsOutput(out);
  expect(ids).toContain("gemma-3-12b-it");
  expect(ids).toContain("ministral-instruct-3b");
  expect(ids).toContain("qwen-2.5-7b-instruct");
});

test("waitUntilModelReady succeeds when fetch reports the model", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls < 2) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ id: "gemma-3-12b-it" }] }), { status: 200 });
  };
  await waitUntilModelReady("gemma-3-12b-it", { fetchImpl: fakeFetch, baseUrl: "http://x", pollMs: 1, timeoutMs: 1000 });
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("waitUntilModelReady throws after timeout", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  await expect(
    waitUntilModelReady("missing", { fetchImpl: fakeFetch, baseUrl: "http://x", pollMs: 10, timeoutMs: 50 }),
  ).rejects.toThrow(/timeout/i);
});

test("listInstalledModels returns empty array when lms not installed", async () => {
  // Inject a runner that throws ENOENT.
  const fakeRun = async () => { throw new Error("ENOENT lms"); };
  await expect(listInstalledModels({ runner: fakeRun })).rejects.toThrow(/lms/);
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test lms.test.ts
```

- [ ] **Step 3: Implement lms.ts**

Create `lms.ts`:

```ts
import { $ } from "bun";

export interface LmsRunner {
  (args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: LmsRunner = async (args) => {
  const proc = Bun.spawn(["lms", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`lms ${args.join(" ")} exit ${code}: ${stderr.slice(0, 200)}`);
  }
  return { stdout, stderr };
};

export function parseLmsLsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split("\n")) {
    // Match lines like "  1.  model-id (...)" or "  - model-id ..."
    const m = line.match(/^\s*(?:\d+\.|-)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export interface LmsOpts {
  runner?: LmsRunner;
}

export async function listInstalledModels(opts: LmsOpts = {}): Promise<string[]> {
  const runner = opts.runner ?? defaultRunner;
  const { stdout } = await runner(["ls"]);
  return parseLmsLsOutput(stdout);
}

export async function unloadAll(opts: LmsOpts = {}): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  await runner(["unload", "--all"]);
}

export async function loadModel(modelId: string, opts: LmsOpts = {}): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  await runner(["load", modelId, "-y"]);
}

export interface WaitOpts {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export async function waitUntilModelReady(modelId: string, opts: WaitOpts = {}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await f(`${baseUrl}/v1/models`);
      if (res.ok) {
        const json = (await res.json()) as { data: Array<{ id: string }> };
        if (json.data?.some((d) => d.id === modelId)) return;
      }
    } catch {
      // ignore; LM Studio may not be up yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timeout waiting for model ${modelId} to appear at ${baseUrl}/v1/models`);
}
```

- [ ] **Step 4: Run tests**

```bash
bun test lms.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lms.ts lms.test.ts
git commit -m "feat(lab): lms wrapper for model load/unload/list + readiness poll

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: Create models.config.ts

**Files:**
- Create: `models.config.ts`

- [ ] **Step 1: Author the config file**

Create `models.config.ts`:

```ts
export const SHORTLISTS: Record<"narrator" | "archivist" | "interpreter", string[]> = {
  narrator: [
    "ministral-instruct-3b",
    "gemma-3-12b-it",
    "qwen-2.5-7b-instruct",
  ],
  archivist: [
    "gemma-3-12b-it",
    "qwen-2.5-14b-instruct",
  ],
  interpreter: [
    "ministral-instruct-3b",
    "qwen-2.5-7b-instruct",
  ],
};
```

Note: model IDs must match the IDs reported by `lms ls`. Edit by hand to add/remove. Sweep validates them up-front.

- [ ] **Step 2: Commit**

```bash
git add models.config.ts
git commit -m "feat(lab): curated per-stage model shortlists

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 7 — Sweep orchestrator

### Task 13: Build sweep.ts core (matrix runner, no resumability yet)

This task focuses on the core matrix iteration with mocked dependencies. Resumability + log + summary are added in subsequent tasks.

**Files:**
- Create: `sweep.ts`
- Create: `sweep.test.ts`

- [ ] **Step 1: Write failing tests for the matrix runner**

Create `sweep.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep } from "./sweep";
import type { Snapshot } from "./probes/shared";

const fakeSnap: Snapshot = {
  snapshotId: "t1", turn: 1, position: [0, 0], playerInput: "look",
  narrator: { userMessage: "U1", mustNameTarget: null },
};

test("runSweep iterates (model × variant × snapshot) and writes manifest rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-"));
  const events: string[] = [];
  await runSweep({
    stage: "narrator",
    snapshots: [fakeSnap],
    variants: [{ name: "v0", body: "SYS" }],
    models: ["modelA", "modelB"],
    sweepDir: dir,
    lms: {
      unloadAll: async () => { events.push("unload"); },
      load: async (m) => { events.push(`load:${m}`); },
      waitReady: async (m) => { events.push(`ready:${m}`); },
    },
    probe: async (_stage, _snap, _sys, model) => ({
      modelId: model, content: "you look around.".repeat(20), raw: {},
    }),
    score: () => [{ name: "always_pass", pass: true }],
  });
  const manifest = await readFile(join(dir, "manifest.jsonl"), "utf8");
  const rows = manifest.trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.length).toBe(2); // 2 models × 1 variant × 1 snapshot
  expect(rows[0].model).toBe("modelA");
  expect(rows[1].model).toBe("modelB");
  expect(events).toEqual([
    "unload", "load:modelA", "ready:modelA",
    "unload", "load:modelB", "ready:modelB",
    "unload", // final unload after all models
  ]);
  await rm(dir, { recursive: true });
});

test("runSweep records a cell_error row when probe throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-"));
  await runSweep({
    stage: "narrator",
    snapshots: [fakeSnap],
    variants: [{ name: "v0", body: "SYS" }],
    models: ["modelA"],
    sweepDir: dir,
    lms: { unloadAll: async () => {}, load: async () => {}, waitReady: async () => {} },
    probe: async () => { throw new Error("simulated http 500"); },
    score: () => [],
  });
  const manifest = await readFile(join(dir, "manifest.jsonl"), "utf8");
  const rows = manifest.trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.length).toBe(1);
  expect(rows[0].error).toMatch(/simulated http 500/);
  expect(rows[0].allPassed).toBe(false);
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test sweep.test.ts
```

- [ ] **Step 3: Implement sweep.ts core**

Create `sweep.ts`:

```ts
import type { Stage, Snapshot, InterpreterCase } from "./probes/shared";
import type { CheckResult } from "./score/narrator";

export interface SweepLms {
  unloadAll: () => Promise<void>;
  load: (modelId: string) => Promise<void>;
  waitReady: (modelId: string) => Promise<void>;
}

export interface Variant { name: string; body: string }

export interface ProbeOutput {
  modelId: string;
  content: string;
  raw: unknown;
}

export type ProbeFn = (
  stage: Stage,
  item: Snapshot | InterpreterCase,
  systemPrompt: string,
  model: string,
) => Promise<ProbeOutput>;

export type ScoreFn = (
  stage: Stage,
  item: Snapshot | InterpreterCase,
  content: string,
) => CheckResult[];

export interface RunSweepOpts {
  stage: Stage;
  snapshots?: Snapshot[];
  cases?: InterpreterCase[];
  variants: Variant[];
  models: string[];
  sweepDir: string;
  lms: SweepLms;
  probe: ProbeFn;
  score: ScoreFn;
}

export interface SweepRow {
  stage: Stage;
  model: string;
  variant: string;
  snapshotId: string;
  checks: CheckResult[];
  allPassed: boolean;
  durationMs: number;
  rawPath?: string;
  error?: string;
}

async function appendJsonl(path: string, obj: unknown): Promise<void> {
  const line = JSON.stringify(obj) + "\n";
  const existing = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "";
  await Bun.write(path, existing + line);
}

export async function runSweep(opts: RunSweepOpts): Promise<void> {
  const items: Array<{ id: string; data: Snapshot | InterpreterCase }> =
    opts.stage === "interpreter"
      ? (opts.cases ?? []).map((c) => ({ id: c.id, data: c }))
      : (opts.snapshots ?? []).map((s) => ({ id: s.snapshotId, data: s }));

  const manifestPath = `${opts.sweepDir}/manifest.jsonl`;

  for (const model of opts.models) {
    await opts.lms.unloadAll();
    await opts.lms.load(model);
    await opts.lms.waitReady(model);
    for (const variant of opts.variants) {
      for (const item of items) {
        const start = Date.now();
        try {
          const out = await opts.probe(opts.stage, item.data, variant.body, model);
          const checks = opts.score(opts.stage, item.data, out.content);
          const allPassed = checks.every((c) => c.pass);
          const row: SweepRow = {
            stage: opts.stage,
            model,
            variant: variant.name,
            snapshotId: item.id,
            checks,
            allPassed,
            durationMs: Date.now() - start,
          };
          await appendJsonl(manifestPath, row);
        } catch (err) {
          const row: SweepRow = {
            stage: opts.stage,
            model,
            variant: variant.name,
            snapshotId: item.id,
            checks: [],
            allPassed: false,
            durationMs: Date.now() - start,
            error: (err as Error).message,
          };
          await appendJsonl(manifestPath, row);
        }
      }
    }
  }
  await opts.lms.unloadAll();
}
```

- [ ] **Step 4: Run tests**

```bash
bun test sweep.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add sweep.ts sweep.test.ts
git commit -m "feat(lab): sweep matrix runner (no resumability yet)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 14: Add resumability via --continue

**Files:**
- Modify: `sweep.ts`
- Modify: `sweep.test.ts`

- [ ] **Step 1: Write failing test for resumability**

Append to `sweep.test.ts`:

```ts
test("runSweep with skipExisting reads prior manifest and skips done cells", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-"));
  // Seed a manifest with one already-done cell.
  await Bun.write(join(dir, "manifest.jsonl"), JSON.stringify({
    stage: "narrator", model: "modelA", variant: "v0", snapshotId: "t1",
    checks: [], allPassed: true, durationMs: 1,
  }) + "\n");
  let probeCalls = 0;
  await runSweep({
    stage: "narrator",
    snapshots: [fakeSnap],
    variants: [{ name: "v0", body: "SYS" }],
    models: ["modelA"],
    sweepDir: dir,
    lms: { unloadAll: async () => {}, load: async () => {}, waitReady: async () => {} },
    probe: async () => { probeCalls++; return { modelId: "modelA", content: "x", raw: {} }; },
    score: () => [],
    skipExisting: true,
  });
  expect(probeCalls).toBe(0); // resumability skipped the only cell
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test sweep.test.ts -t "skipExisting"
```

- [ ] **Step 3: Implement skipExisting**

In `sweep.ts`, add to `RunSweepOpts`:

```ts
  skipExisting?: boolean;
```

And add helper + skip check inside `runSweep`:

```ts
async function loadExistingCells(manifestPath: string): Promise<Set<string>> {
  if (!(await Bun.file(manifestPath).exists())) return new Set();
  const text = await Bun.file(manifestPath).text();
  const done = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SweepRow;
      done.add(`${row.stage}|${row.model}|${row.variant}|${row.snapshotId}`);
    } catch {
      // ignore malformed lines
    }
  }
  return done;
}
```

Then near the top of `runSweep`:

```ts
  const existing = opts.skipExisting ? await loadExistingCells(manifestPath) : new Set<string>();
```

And inside the inner loop, before calling probe:

```ts
        const cellKey = `${opts.stage}|${model}|${variant.name}|${item.id}`;
        if (existing.has(cellKey)) continue;
```

- [ ] **Step 4: Run tests**

```bash
bun test sweep.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add sweep.ts sweep.test.ts
git commit -m "feat(lab): sweep --continue resumability via manifest scan

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 15: Add timeout + event log + summary.md

**Files:**
- Modify: `sweep.ts`
- Modify: `sweep.test.ts`
- Create: `summary.ts`
- Create: `summary.test.ts`

- [ ] **Step 1: Write failing test for summary generation**

Create `summary.test.ts`:

```ts
import { test, expect } from "bun:test";
import { renderSummaryMarkdown } from "./summary";
import type { SweepRow } from "./sweep";

test("renderSummaryMarkdown groups by (model, variant) and shows pass counts", () => {
  const rows: SweepRow[] = [
    { stage: "narrator", model: "A", variant: "v0", snapshotId: "t1", checks: [{ name: "x", pass: true }], allPassed: true, durationMs: 1 },
    { stage: "narrator", model: "A", variant: "v0", snapshotId: "t2", checks: [{ name: "x", pass: false }], allPassed: false, durationMs: 1 },
    { stage: "narrator", model: "B", variant: "v0", snapshotId: "t1", checks: [{ name: "x", pass: true }], allPassed: true, durationMs: 1 },
  ];
  const md = renderSummaryMarkdown(rows);
  expect(md).toContain("| A | v0 | 1/2 |");
  expect(md).toContain("| B | v0 | 1/1 |");
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
bun test summary.test.ts
```

- [ ] **Step 3: Implement summary.ts**

Create `summary.ts`:

```ts
import type { SweepRow } from "./sweep";

export function renderSummaryMarkdown(rows: SweepRow[]): string {
  if (rows.length === 0) return "# Sweep summary\n\n_no rows yet_\n";
  const stage = rows[0].stage;
  const groups = new Map<string, { passed: number; total: number; checkFails: Map<string, number> }>();
  for (const row of rows) {
    const key = `${row.model}|${row.variant}`;
    const g = groups.get(key) ?? { passed: 0, total: 0, checkFails: new Map() };
    g.total++;
    if (row.allPassed) g.passed++;
    for (const c of row.checks) {
      if (!c.pass) g.checkFails.set(c.name, (g.checkFails.get(c.name) ?? 0) + 1);
    }
    groups.set(key, g);
  }
  const lines: string[] = [];
  lines.push(`# Sweep summary — ${stage}\n`);
  lines.push("| model | variant | passed | top failures |");
  lines.push("|---|---|---|---|");
  const sorted = [...groups.entries()].sort((a, b) => b[1].passed / b[1].total - a[1].passed / a[1].total);
  for (const [key, g] of sorted) {
    const [model, variant] = key.split("|");
    const fails = [...g.checkFails.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${name}:${n}`)
      .join(", ") || "—";
    lines.push(`| ${model} | ${variant} | ${g.passed}/${g.total} | ${fails} |`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests**

```bash
bun test summary.test.ts
```

- [ ] **Step 5: Write failing tests for timeout + event log in sweep**

Append to `sweep.test.ts`:

```ts
test("runSweep writes JSON-lines sweep.log with cell_start/cell_done events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-"));
  await runSweep({
    stage: "narrator",
    snapshots: [fakeSnap],
    variants: [{ name: "v0", body: "SYS" }],
    models: ["modelA"],
    sweepDir: dir,
    lms: { unloadAll: async () => {}, load: async () => {}, waitReady: async () => {} },
    probe: async () => ({ modelId: "modelA", content: "x", raw: {} }),
    score: () => [],
  });
  const log = await readFile(join(dir, "sweep.log"), "utf8");
  const events = log.trim().split("\n").map((l) => JSON.parse(l));
  const names = events.map((e) => e.event);
  expect(names).toContain("model_load_start");
  expect(names).toContain("cell_start");
  expect(names).toContain("cell_done");
  expect(names).toContain("sweep_done");
  await rm(dir, { recursive: true });
});

test("runSweep regenerates summary.md after each cell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-"));
  await runSweep({
    stage: "narrator",
    snapshots: [fakeSnap],
    variants: [{ name: "v0", body: "SYS" }],
    models: ["modelA"],
    sweepDir: dir,
    lms: { unloadAll: async () => {}, load: async () => {}, waitReady: async () => {} },
    probe: async () => ({ modelId: "modelA", content: "x", raw: {} }),
    score: () => [{ name: "x", pass: true }],
  });
  const md = await readFile(join(dir, "summary.md"), "utf8");
  expect(md).toContain("modelA");
  expect(md).toContain("v0");
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 6: Run, confirm fail**

```bash
bun test sweep.test.ts -t "sweep.log"
bun test sweep.test.ts -t "summary.md"
```

- [ ] **Step 7: Add event log + summary regeneration to sweep.ts**

In `sweep.ts`, add an `appendEvent` helper near `appendJsonl`:

```ts
async function appendEvent(sweepDir: string, event: Record<string, unknown>): Promise<void> {
  await appendJsonl(`${sweepDir}/sweep.log`, { t: new Date().toISOString(), ...event });
}
```

Import `renderSummaryMarkdown`:

```ts
import { renderSummaryMarkdown } from "./summary";
```

Inside `runSweep`, emit events around each operation and regenerate summary after each cell:

```ts
  for (const model of opts.models) {
    await appendEvent(opts.sweepDir, { event: "model_load_start", model });
    await opts.lms.unloadAll();
    try {
      await opts.lms.load(model);
      await opts.lms.waitReady(model);
      await appendEvent(opts.sweepDir, { event: "model_load_done", model });
    } catch (err) {
      await appendEvent(opts.sweepDir, { event: "model_load_failed", model, reason: (err as Error).message });
      continue;
    }
    for (const variant of opts.variants) {
      for (const item of items) {
        const cellKey = `${opts.stage}|${model}|${variant.name}|${item.id}`;
        if (existing.has(cellKey)) continue;
        await appendEvent(opts.sweepDir, { event: "cell_start", model, variant: variant.name, item: item.id });
        const start = Date.now();
        try {
          const out = await opts.probe(opts.stage, item.data, variant.body, model);
          const checks = opts.score(opts.stage, item.data, out.content);
          const allPassed = checks.every((c) => c.pass);
          const row: SweepRow = {
            stage: opts.stage, model, variant: variant.name,
            snapshotId: item.id, checks, allPassed, durationMs: Date.now() - start,
          };
          await appendJsonl(manifestPath, row);
          await appendEvent(opts.sweepDir, { event: "cell_done", model, variant: variant.name, item: item.id, passed: allPassed, ms: row.durationMs });
        } catch (err) {
          const row: SweepRow = {
            stage: opts.stage, model, variant: variant.name,
            snapshotId: item.id, checks: [], allPassed: false,
            durationMs: Date.now() - start, error: (err as Error).message,
          };
          await appendJsonl(manifestPath, row);
          await appendEvent(opts.sweepDir, { event: "cell_error", model, variant: variant.name, item: item.id, reason: row.error });
        }
        // Regenerate summary after each cell.
        const allRows = (await Bun.file(manifestPath).text())
          .split("\n").filter(Boolean).map((l) => JSON.parse(l) as SweepRow);
        await Bun.write(`${opts.sweepDir}/summary.md`, renderSummaryMarkdown(allRows));
      }
    }
  }
  await opts.lms.unloadAll();
  await appendEvent(opts.sweepDir, { event: "sweep_done" });
```

- [ ] **Step 8: Run tests**

```bash
bun test sweep.test.ts summary.test.ts
```

Expected: all sweep + summary tests pass.

- [ ] **Step 9: Commit**

```bash
git add sweep.ts sweep.test.ts summary.ts summary.test.ts
git commit -m "feat(lab): sweep event log + live summary.md regeneration

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16: Build the sweep CLI entrypoint

**Files:**
- Modify: `sweep.ts` (add `main()` and `import.meta.main` block)

- [ ] **Step 1: Read current sweep.ts to find the end**

```bash
wc -l sweep.ts
```

- [ ] **Step 2: Append the CLI wrapper to sweep.ts**

At the end of `sweep.ts`, add:

```ts
import { SHORTLISTS } from "./models.config";
import { loadSnapshots, loadInterpreterCases, loadPromptVariant } from "./probes/shared";
import { unloadAll, loadModel, waitUntilModelReady, listInstalledModels } from "./lms";
import { runNarratorProbe } from "./probes/narrator";
import { runArchivistProbe } from "./probes/archivist";
import { runInterpreterProbe } from "./probes/interpreter";
import { scoreNarrator } from "./score/narrator";
import { scoreArchivist } from "./score/archivist";
import { scoreInterpreter } from "./score/interpreter";
import { readdir, mkdir } from "node:fs/promises";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

async function findLatestSweepDir(stage: Stage): Promise<string | null> {
  try {
    const entries = await readdir("results");
    const matching = entries
      .filter((e) => e.startsWith(`${stage}-`))
      .sort()
      .reverse();
    return matching.length > 0 ? `results/${matching[0]}` : null;
  } catch {
    return null;
  }
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const stage = args[0] as Stage;
  if (!["narrator", "archivist", "interpreter"].includes(stage)) {
    console.error("usage: bun sweep.ts <narrator|archivist|interpreter> [--models a,b] [--variants v0,v1] [--snapshots id1,id2] [--continue]");
    process.exit(2);
  }
  const wantContinue = args.includes("--continue");
  let sweepDir: string;
  if (wantContinue) {
    const latest = await findLatestSweepDir(stage);
    if (!latest) { console.error(`no prior sweep for stage=${stage}`); process.exit(1); }
    sweepDir = latest;
    console.error(`[sweep] resuming ${sweepDir}`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    sweepDir = `results/${stage}-${stamp}`;
    await mkdir(sweepDir, { recursive: true });
  }

  const modelArg = arg(args, "--models");
  const models = modelArg ? modelArg.split(",") : SHORTLISTS[stage];
  const installed = await listInstalledModels();
  const missing = models.filter((m) => !installed.includes(m));
  if (missing.length > 0) {
    console.error(`[sweep] models not installed: ${missing.join(", ")}`);
    console.error(`[sweep] installed: ${installed.join(", ")}`);
    process.exit(1);
  }

  const variantArg = arg(args, "--variants");
  const variantNames = variantArg ? variantArg.split(",") : ["v0-baseline"];
  const variants: Variant[] = [];
  for (const name of variantNames) {
    variants.push({ name, body: await loadPromptVariant(stage, name) });
  }

  let snapshots: Snapshot[] = [];
  let cases: InterpreterCase[] = [];
  if (stage === "interpreter") {
    cases = await loadInterpreterCases(new URL("./fixtures/interpreter-cases.jsonl", import.meta.url).pathname);
  } else {
    snapshots = await loadSnapshots(new URL("./fixtures/snapshots.jsonl", import.meta.url).pathname);
    if (stage === "narrator") snapshots = snapshots.filter((s) => s.narrator);
    if (stage === "archivist") snapshots = snapshots.filter((s) => s.archivist);
  }
  const snapshotFilter = arg(args, "--snapshots");
  if (snapshotFilter) {
    const wanted = new Set(snapshotFilter.split(","));
    snapshots = snapshots.filter((s) => wanted.has(s.snapshotId));
    cases = cases.filter((c) => wanted.has(c.id));
  }

  const probe: ProbeFn = async (s, item, sys, model) => {
    if (s === "narrator") {
      const out = await runNarratorProbe({ snapshot: item as Snapshot, systemPrompt: sys, timeoutMs: 60_000 });
      return { modelId: model, content: out.content, raw: out.raw };
    }
    if (s === "archivist") {
      const out = await runArchivistProbe({ snapshot: item as Snapshot, systemPrompt: sys, timeoutMs: 60_000 });
      return { modelId: model, content: out.content, raw: out.raw };
    }
    const out = await runInterpreterProbe({ caseRow: item as InterpreterCase, systemPrompt: sys, timeoutMs: 30_000 });
    return { modelId: model, content: out.content, raw: out.raw };
  };

  const score: ScoreFn = (s, item, content) => {
    if (s === "narrator") {
      const snap = item as Snapshot;
      return scoreNarrator({ mustNameTarget: snap.narrator?.mustNameTarget ?? null }, content);
    }
    if (s === "archivist") {
      const snap = item as Snapshot;
      return scoreArchivist({
        narrativePassage: snap.archivist!.narrativePassage,
        objectiveCount: snap.archivist!.objectiveCount,
      }, content);
    }
    return scoreInterpreter({ expected: (item as InterpreterCase).expected }, content);
  };

  await runSweep({
    stage,
    snapshots: snapshots.length > 0 ? snapshots : undefined,
    cases: cases.length > 0 ? cases : undefined,
    variants,
    models,
    sweepDir,
    lms: {
      unloadAll: () => unloadAll(),
      load: (m) => loadModel(m),
      waitReady: (m) => waitUntilModelReady(m, { timeoutMs: 60_000 }),
    },
    probe,
    score,
    skipExisting: wantContinue,
  });

  console.error(`[sweep] done. summary at ${sweepDir}/summary.md`);
}

if (import.meta.main) {
  cliMain().catch((err) => { console.error("[sweep] error:", err); process.exit(1); });
}
```

- [ ] **Step 3: Type-check the file by running tests**

```bash
bun test sweep.test.ts
```

Expected: still passes (the CLI block is only executed under `import.meta.main`).

- [ ] **Step 4: Commit**

```bash
git add sweep.ts
git commit -m "feat(lab): sweep CLI entrypoint wiring real probes, score, lms

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 8 — Single-shot probe CLIs

### Task 17: Add CLI entrypoints to each probe module

Each probe module gets an `import.meta.main` block for standalone single-shot debugging.

**Files:**
- Modify: `probes/narrator.ts`
- Modify: `probes/archivist.ts`
- Modify: `probes/interpreter.ts`

- [ ] **Step 1: Append CLI block to probes/narrator.ts**

Append to the bottom of `probes/narrator.ts`:

```ts
import { loadSnapshots, loadPromptVariant } from "./shared";

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const snapshotId = args[0];
  if (!snapshotId) {
    console.error("usage: bun probes/narrator.ts <snapshot-id> [--variant <name>]");
    process.exit(2);
  }
  const variantIdx = args.indexOf("--variant");
  const variant = variantIdx === -1 ? "v0-baseline" : args[variantIdx + 1];
  const systemPrompt = await loadPromptVariant("narrator", variant);
  const snapshots = await loadSnapshots(new URL("../fixtures/snapshots.jsonl", import.meta.url).pathname);
  const snap = snapshots.find((s) => s.snapshotId === snapshotId && s.narrator);
  if (!snap) { console.error(`no narrator snapshot with id=${snapshotId}`); process.exit(1); }
  const out = await runNarratorProbe({ snapshot: snap, systemPrompt });
  console.log(JSON.stringify({ modelId: out.modelId, content: out.content }, null, 2));
}

if (import.meta.main) {
  cliMain().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Append CLI block to probes/archivist.ts**

Append to the bottom of `probes/archivist.ts`:

```ts
import { loadSnapshots, loadPromptVariant } from "./shared";

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const snapshotId = args[0];
  if (!snapshotId) {
    console.error("usage: bun probes/archivist.ts <snapshot-id> [--variant <name>]");
    process.exit(2);
  }
  const variantIdx = args.indexOf("--variant");
  const variant = variantIdx === -1 ? "v0-baseline" : args[variantIdx + 1];
  const systemPrompt = await loadPromptVariant("archivist", variant);
  const snapshots = await loadSnapshots(new URL("../fixtures/snapshots.jsonl", import.meta.url).pathname);
  const snap = snapshots.find((s) => s.snapshotId === snapshotId && s.archivist);
  if (!snap) { console.error(`no archivist snapshot with id=${snapshotId}`); process.exit(1); }
  const out = await runArchivistProbe({ snapshot: snap, systemPrompt });
  console.log(JSON.stringify({ modelId: out.modelId, content: out.content }, null, 2));
}

if (import.meta.main) {
  cliMain().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 3: Append CLI block to probes/interpreter.ts**

Append to the bottom of `probes/interpreter.ts`:

```ts
import { loadInterpreterCases, loadPromptVariant } from "./shared";

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const caseId = args[0];
  if (!caseId) {
    console.error("usage: bun probes/interpreter.ts <case-id> [--variant <name>]");
    process.exit(2);
  }
  const variantIdx = args.indexOf("--variant");
  const variant = variantIdx === -1 ? "v0-baseline" : args[variantIdx + 1];
  const systemPrompt = await loadPromptVariant("interpreter", variant);
  const cases = await loadInterpreterCases(new URL("../fixtures/interpreter-cases.jsonl", import.meta.url).pathname);
  const caseRow = cases.find((c) => c.id === caseId);
  if (!caseRow) { console.error(`no case with id=${caseId}`); process.exit(1); }
  const out = await runInterpreterProbe({ caseRow, systemPrompt });
  console.log(JSON.stringify({ modelId: out.modelId, content: out.content, expected: caseRow.expected }, null, 2));
}

if (import.meta.main) {
  cliMain().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run all tests to confirm nothing regressed**

```bash
bun test
```

Expected: all tests still pass.

- [ ] **Step 5: Commit**

```bash
git add probes/narrator.ts probes/archivist.ts probes/interpreter.ts
git commit -m "feat(lab): single-shot CLI entrypoints for each stage probe

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 9 — Smoke test against a live model

### Task 18: End-to-end smoke test of the sweep CLI

This step is interactive — LM Studio must be running with `gemma-3-12b-it` (or another model from the shortlist) installed.

- [ ] **Step 1: Verify LM Studio + lms are available**

```bash
lms ls
curl -s http://localhost:1234/v1/models | bun -e "console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()), null, 2))"
```

Expected: at least one model listed by both.

- [ ] **Step 2: Run a minimal interpreter sweep (fastest stage)**

```bash
bun sweep.ts interpreter --models ministral-instruct-3b --variants v0-baseline --snapshots i1,i8,i15
```

Expected: completes in <60 seconds. Stdout ends with `[sweep] done. summary at results/interpreter-<stamp>/summary.md`.

- [ ] **Step 3: Inspect the summary**

```bash
cat results/interpreter-*/summary.md | head -20
tail -5 results/interpreter-*/sweep.log
```

Expected: table shows pass counts. Log ends with `{"event":"sweep_done", ...}`.

- [ ] **Step 4: Run a minimal narrator sweep**

```bash
bun sweep.ts narrator --models gemma-3-12b-it --variants v0-baseline --snapshots t1
```

(Replace `t1` with a real snapshotId from `fixtures/snapshots.jsonl` if `t1` doesn't exist.)

Expected: produces a non-empty `results/narrator-<stamp>/manifest.jsonl`.

- [ ] **Step 5: Run a minimal archivist sweep**

```bash
bun sweep.ts archivist --models gemma-3-12b-it --variants v0-baseline --snapshots t1
```

Expected: same shape of output.

- [ ] **Step 6: No commit needed — this is a smoke test**

If everything passes, proceed to Phase 10. If anything fails, diagnose before continuing.

---

## Phase 10 — Documentation

### Task 19: Update lab README with new commands

**Files:**
- Modify: `README.md` (the lab README, not the main project README)

- [ ] **Step 1: Read current README**

```bash
cat README.md | head -50
```

- [ ] **Step 2: Replace the README**

Overwrite `README.md` with content that documents the new commands. Keep the existing tone:

```markdown
# lab/local-models

Throwaway sandbox for finding good (model, prompt) combinations for the
adventure engine's three production prompts. Lives on the `lab/local-models`
branch — does not import from `../src`.

## What's here

- `probes/{narrator,archivist,interpreter}.ts` — single-shot stage probes
- `sweep.ts` — matrix runner that cycles `(model × variant × snapshot)`
- `score/{narrator,archivist,interpreter}.ts` — auto-scoring rubrics
- `lms.ts` — wrapper around the `lms` CLI
- `models.config.ts` — curated per-stage model shortlists
- `fixtures/` — frozen snapshots + interpreter cases + prompt variants
- `results/` — per-sweep manifest, summary, log, and raw responses

## Prerequisites

- Bun on PATH
- LM Studio running at `http://localhost:1234` (or `LM_STUDIO_URL=...`)
- `lms` CLI installed
- At least one model from `models.config.ts` installed

## Single-shot debugging

```sh
bun probes/narrator.ts t12 --variant v0-baseline
bun probes/archivist.ts t12 --variant v0-baseline
bun probes/interpreter.ts i1 --variant v0-baseline
```

## Sweep

```sh
bun sweep.ts narrator                              # full matrix from models.config
bun sweep.ts narrator --models gemma-3-12b-it --variants v0-baseline,v1-test
bun sweep.ts narrator --snapshots t1,t12           # only specific snapshots
bun sweep.ts archivist --continue                  # resume the most recent sweep for archivist
```

Results land in `results/<stage>-<timestamp>/`:
- `manifest.jsonl` — one row per cell with auto-score results
- `summary.md` — grouped pass-count table, regenerated each cell
- `sweep.log` — JSON-lines event log (tailable)
- `raw/` — full LM Studio responses per cell (gitignored)

## Authoring a new prompt variant

```sh
cp fixtures/prompts/narrator/v0-baseline.txt fixtures/prompts/narrator/v1-hint-after-canonical.txt
# edit the new file, add a rationale comment at the top
bun sweep.ts narrator --variants v0-baseline,v1-hint-after-canonical
```

Variants should change exactly one thing from their parent. Always start with
a rationale header in HTML-comment form so the experiment is self-documenting.

## Refreshing snapshots

Snapshots are captured on `main` via the `SNAPSHOT_FIXTURES` env var:

```sh
git checkout main
SNAPSHOT_FIXTURES=/tmp/new-snaps.jsonl bun --hot src/server.ts
# play a session covering desired scenarios
git checkout lab/local-models
cp /tmp/new-snaps.jsonl fixtures/snapshots.jsonl
```
```

- [ ] **Step 3: Run final test suite**

```bash
bun test
```

Expected: every test in the lab passes.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(lab): update README for probes/sweep/scoring workflow

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| Architecture & file layout | Tasks 3–17 (the layout is built piece by piece) |
| Fixtures (`snapshots.jsonl`) | Task 1 (hook), Task 2 (capture), Task 3 (move into lab) |
| Fixtures (`interpreter-cases.jsonl`) | Task 3 step 5 |
| Fixtures (`prompts/<stage>/v0-baseline`) | Task 3 step 1 |
| Snapshot tool | Tasks 1 + 2 (live capture instead of historical reconstruction — covered by the env-var hook approach) |
| Narrator probe | Task 5 |
| Archivist probe | Task 6 |
| Interpreter probe | Task 7 |
| Narrator scoring | Task 8 |
| Archivist scoring | Task 9 |
| Interpreter scoring | Task 10 |
| `lms` wrapper | Task 11 |
| `models.config.ts` | Task 12 |
| Sweep core | Task 13 |
| Resumability | Task 14 |
| Event log + summary | Task 15 |
| CLI entrypoint | Task 16 + 17 |
| End-to-end validation | Task 18 |
| README | Task 19 |

The "iteration mechanic" section of the spec (one-variable-per-variant, rationale headers, stuck detection) is workflow guidance for Claude when *using* the testbed — not a build deliverable. The README in Task 19 mentions the rationale-header convention; the rest is captured in the spec and findings doc that grows during use.

**Placeholder scan:** none. Every code block has actual code; every command is concrete.

**Type consistency:** `Stage`, `Snapshot`, `InterpreterCase`, `CheckResult`, `SweepRow`, `ProbeFn`, `ScoreFn`, `Variant`, `RunSweepOpts` are all defined exactly once and referenced consistently. The `loadPromptVariant(stage, variant)` signature in Task 4 matches its callers in Tasks 16 + 17.

One detail worth noting: Task 4 places `FIXTURES_PATH` as `../fixtures/` relative to `probes/shared.ts`, while Task 17's probe CLI blocks pass an explicit absolute pathname to `loadSnapshots`. This is intentional — `loadSnapshots(path)` takes any path, but the CLI blocks resolve the path explicitly to be robust against the caller's CWD.
