# Location Coordinate System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor narrative continuity across turns by giving each visited place a stable identity on a 2D integer grid. When the player returns to a previously-visited tile, the narrator must honor the canonical description captured on the first visit instead of improvising a fresh one.

**Architecture:** Three-pass turn flow. (1) An **interpreter** pass classifies player input into a movement intent (`move-north|south|east|west|stay`) using the structured-output API. (2) The **narrator** is then anchored with the destination tile's stored description (if any). (3) The **archivist** runs as before, plus extracts a canonical description for the current location and confirms whether movement actually occurred (so a blocked move doesn't update position). The `WorldStack` gains a 2D `position` and a `places` map keyed by `"x,y"`. Coordinates are internal — the player never sees them. Convention: `position[0]` is the N/S axis (north = +1), `position[1]` is the E/W axis (east = +1). Player starts at `[0, 0]`.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing `api.callModelStructured` (LM Studio JSON-schema endpoint).

> **Note:** This project still has no git repository. Skip git steps if not initialised; otherwise commit after each task.

---

## Design Decisions

- **Cardinal-only for MVP.** Interpreter outputs one of five values: `move-north`, `move-south`, `move-east`, `move-west`, `stay`. Anything ambiguous (e.g. "follow the path") resolves to `stay` — the narrator describes the path, the player picks a direction next turn.
- **First-visit captures, return visits read.** A tile's description is set the first time the player is on it. Return visits do not overwrite. (Future work: detect significant changes that warrant updating.)
- **Movement is two-stage.** Interpreter declares *intent*; archivist confirms *outcome*. If the narrator describes the move as blocked, archivist returns `moved: false` and position is reverted.
- **Z-axis deferred.** Towers, caves, indoor rooms — handled later via an `elsewhere` escape hatch or a Z dimension. For now, the world is a flat 2D plane.
- **Backwards-compat.** Saved stacks predating this change get default `position: [0, 0]` and `places: {}` on load.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/stack.ts` | Modify | Add `position: [number, number]` and `places: Record<string, string>` to `WorldStack`. Default both in `loadStack` for old files. Add coordinate helpers `posKey` and `applyDirection`. Extend `formatStackForNarrator` to include current location's stored description (if any). |
| `src/stack.test.ts` | Modify | Test load defaulting, coord helpers, narrator formatter. |
| `src/engine.ts` | Modify | Add `interpreterTurn`. Modify `narratorTurn` signature to take an optional anchor description. Modify `archivistTurn` to extract `moved: boolean` and `locationDescription: string`. |
| `src/engine.test.ts` | Modify | Add tests for `interpreterTurn` and the new archivist fields. |
| `src/server.ts` | Modify | Update `processInput` to orchestrate the 3-pass flow with position resolution and place capture. |
| `src/server.test.ts` | Modify | Update existing tests for the new flow; add new tests for first-visit capture, return-visit anchor, and blocked-move position revert. |

---

## Task 1: Extend WorldStack with position and places (TDD)

**Files:**
- Modify: `src/stack.ts`
- Modify: `src/stack.test.ts`

- [ ] **Step 1.1: Read the existing stack tests so you know the patterns**

```bash
cat /home/frosty/Dev/ai/adventure/src/stack.test.ts
```

- [ ] **Step 1.2: Add failing tests for the new fields**

Append to `src/stack.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { posKey, applyDirection, formatStackForNarrator, type WorldStack } from "./stack";

test("posKey: serialises position to comma-separated string", () => {
  expect(posKey([0, 0])).toBe("0,0");
  expect(posKey([1, -2])).toBe("1,-2");
  expect(posKey([-3, 5])).toBe("-3,5");
});

test("applyDirection: north increments first coordinate", () => {
  expect(applyDirection([0, 0], "north")).toEqual([1, 0]);
});

test("applyDirection: south decrements first coordinate", () => {
  expect(applyDirection([0, 0], "south")).toEqual([-1, 0]);
});

test("applyDirection: east increments second coordinate", () => {
  expect(applyDirection([0, 0], "east")).toEqual([0, 1]);
});

test("applyDirection: west decrements second coordinate", () => {
  expect(applyDirection([0, 0], "west")).toEqual([0, -1]);
});

test("formatStackForNarrator: includes stored location description when present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: { "1,0": "A windswept dune crowned by a single dead tree." },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("CURRENT LOCATION (canonical description):");
  expect(out).toContain("A windswept dune crowned by a single dead tree.");
});

test("formatStackForNarrator: omits the location section when no description stored", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("CURRENT LOCATION (canonical description):");
});
```

- [ ] **Step 1.3: Run tests — expect failures**

```bash
~/.bun/bin/bun test src/stack.test.ts
```

Expected: `Cannot find name 'posKey'` / `Cannot find name 'applyDirection'` and the location-description tests fail.

- [ ] **Step 1.4: Update `src/stack.ts` — extend the type, add helpers, default on load**

Replace the contents of `src/stack.ts` with:

```typescript
const STACK_FILE = new URL("../world-stack.json", import.meta.url).pathname;
export const MAX_STACK_ENTRIES = 25;
export const MAX_THREADS = 10;

export type Position = [number, number];
export type Direction = "north" | "south" | "east" | "west";

export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
}

const DELTAS: Record<Direction, Position> = {
  north: [1, 0],
  south: [-1, 0],
  east: [0, 1],
  west: [0, -1],
};

export function posKey(p: Position): string {
  return `${p[0]},${p[1]}`;
}

export function applyDirection(p: Position, dir: Direction): Position {
  const d = DELTAS[dir];
  return [p[0] + d[0], p[1] + d[1]];
}

function emptyStack(): WorldStack {
  return { entries: [], threads: [], turn: 0, position: [0, 0], places: {} };
}

export async function loadStack(): Promise<WorldStack> {
  const file = Bun.file(STACK_FILE);
  if (!(await file.exists())) return emptyStack();
  try {
    const data = await file.json();
    if (
      data !== null &&
      typeof data === "object" &&
      Array.isArray(data.entries) &&
      typeof data.turn === "number"
    ) {
      const position: Position =
        Array.isArray(data.position) &&
        data.position.length === 2 &&
        typeof data.position[0] === "number" &&
        typeof data.position[1] === "number"
          ? [data.position[0], data.position[1]]
          : [0, 0];
      const places: Record<string, string> =
        data.places !== null && typeof data.places === "object" && !Array.isArray(data.places)
          ? data.places
          : {};
      return {
        entries: data.entries,
        threads: Array.isArray(data.threads) ? data.threads : [],
        turn: data.turn,
        position,
        places,
      };
    }
    console.error("Stack file has unexpected shape, starting fresh.");
    return emptyStack();
  } catch {
    console.error("Corrupt stack file, starting fresh.");
    return emptyStack();
  }
}

export async function saveStack(stack: WorldStack): Promise<void> {
  try {
    await Bun.write(STACK_FILE, JSON.stringify(stack, null, 2));
  } catch (err) {
    console.error("Failed to save stack:", err);
    throw err;
  }
}

export function formatStackForNarrator(stack: WorldStack): string {
  const parts: string[] = [];
  const here = stack.places[posKey(stack.position)];
  if (here) {
    parts.push(`CURRENT LOCATION (canonical description):\n${here}`);
  }
  if (stack.entries.length > 0) {
    parts.push(`ESTABLISHED WORLD:\n${stack.entries.map(e => `- ${e}`).join("\n")}`);
  }
  if (stack.threads.length > 0) {
    parts.push(`ACTIVE THREADS:\n${stack.threads.map(t => `- ${t}`).join("\n")}`);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
}

export function formatStackForArchivist(stack: WorldStack): string {
  const facts = stack.entries.length === 0
    ? "CURRENT STACK: (empty)"
    : `CURRENT STACK:\n${stack.entries.map(e => `- ${e}`).join("\n")}`;
  const threads = stack.threads.length === 0
    ? "ACTIVE THREADS: (none)"
    : `ACTIVE THREADS:\n${stack.threads.map(t => `- ${t}`).join("\n")}`;
  return `${facts}\n\n${threads}\n\n`;
}
```

- [ ] **Step 1.5: Run tests — expect pass**

```bash
~/.bun/bin/bun test src/stack.test.ts
```

Expected: all tests in `src/stack.test.ts` pass (existing 4 + 7 new = 11).

- [ ] **Step 1.6: Run full suite for regressions**

```bash
~/.bun/bin/bun test src/
```

Expected: 0 failures. Some existing engine/server tests may TS-fail because their `WorldStack` literals lack `position` and `places`; if so, that signals Tasks 4–6 will need to update them. For now Step 1.6 should pass because we kept `position` and `places` optional-by-default-via-`emptyStack` for runtime, but TypeScript treats them as required on the type. **If you see TS errors in engine/server tests, do not patch them in this task — fix them in their respective tasks.** If runtime tests fail, that *is* a regression and must be fixed before commit.

- [ ] **Step 1.7: Reset persisted state to clean slate**

```bash
echo '{"entries":[],"threads":[],"turn":0,"position":[0,0],"places":{}}' > /home/frosty/Dev/ai/adventure/world-stack.json
```

- [ ] **Step 1.8: Commit (skip if no git)**

```bash
git add src/stack.ts src/stack.test.ts world-stack.json
git commit -m "feat: extend WorldStack with 2D position and places map"
```

---

## Task 2: Patch existing engine and server test fixtures for the new shape

**Files:**
- Modify: `src/engine.test.ts`
- Modify: `src/server.test.ts`

The existing tests construct `WorldStack` literals with only `{entries, threads, turn}`. With the type widened in Task 1, those literals are TS errors. This task adds the two new fields to every existing fixture so the suite compiles. No behavioural changes — pure mechanical updates.

- [ ] **Step 2.1: Run the suite to surface every failing fixture**

```bash
~/.bun/bin/bun test src/ 2>&1 | head -40
```

Expected: TypeScript errors listing each fixture missing `position` and `places`. Note the file:line of each.

- [ ] **Step 2.2: In `src/server.test.ts`, update `emptyStack`**

Replace:

```typescript
const emptyStack = { entries: [] as string[], threads: [] as string[], turn: 0 };
```

with:

```typescript
const emptyStack = {
  entries: [] as string[],
  threads: [] as string[],
  turn: 0,
  position: [0, 0] as [number, number],
  places: {} as Record<string, string>,
};
```

- [ ] **Step 2.3: In `src/server.test.ts`, update the inline stack in the "passes the current stack" test**

Replace:

```typescript
const stack = { entries: ["fact"], threads: ["thread"], turn: 5 };
```

with:

```typescript
const stack = {
  entries: ["fact"],
  threads: ["thread"],
  turn: 5,
  position: [0, 0] as [number, number],
  places: {},
};
```

- [ ] **Step 2.4: In `src/server.test.ts`, update the archivist mock returns**

Each `archivistSpy.mockImplementationOnce(async () => ({...}))` currently returns a `WorldStack`-shaped object missing `position` and `places`. For each one (there are two — happy-path and "passes the current stack"), add `position: [0, 0], places: {}` to the returned object.

Example — replace:

```typescript
archivistSpy.mockImplementationOnce(async () => ({
  entries: ["world stirred"],
  threads: ["find the cause"],
  turn: 1,
}));
```

with:

```typescript
archivistSpy.mockImplementationOnce(async () => ({
  entries: ["world stirred"],
  threads: ["find the cause"],
  turn: 1,
  position: [0, 0] as [number, number],
  places: {},
  moved: false,
  locationDescription: "",
}));
```

(The `moved` and `locationDescription` fields will be defined in Task 5; including them now is harmless because the tests only assert specific keys, but they document intent.)

Apply the same shape to the second mock return inside "passes the current stack" — its turn becomes 6.

- [ ] **Step 2.5: Apply the same fixes to `src/engine.test.ts`**

```bash
grep -n "entries:\s*\[\|turn:\s*[0-9]" /home/frosty/Dev/ai/adventure/src/engine.test.ts
```

For every `WorldStack` literal in that file, append `, position: [0, 0] as [number, number], places: {}`.

- [ ] **Step 2.6: Run full suite — expect green**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass with no TS errors.

- [ ] **Step 2.7: Commit**

```bash
git add src/engine.test.ts src/server.test.ts
git commit -m "test: update fixtures for extended WorldStack shape"
```

---

## Task 3: Interpreter pass (TDD)

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/engine.test.ts`

The interpreter is a third LLM call that classifies player input into one of five enum values. It runs *before* the narrator so we can pre-resolve the destination tile and pass its canonical description as an anchor.

- [ ] **Step 3.1: Add failing tests**

Append to `src/engine.test.ts`:

```typescript
import { interpreterTurn } from "./engine";
import * as api from "./api";

test("interpreterTurn: classifies 'go north' as move-north", async () => {
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({ action: "move-north" }));
  const result = await interpreterTurn("go north");
  expect(result).toEqual({ action: "move-north" });
  spy.mockRestore();
});

test("interpreterTurn: classifies 'look around' as stay", async () => {
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({ action: "stay" }));
  const result = await interpreterTurn("look around");
  expect(result).toEqual({ action: "stay" });
  spy.mockRestore();
});

test("interpreterTurn: passes the player input to the structured call", async () => {
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({ action: "stay" }));
  await interpreterTurn("head west toward the dunes");
  // 4th call arg is the schema; 2nd arg is the input
  expect(spy.mock.calls[0][1]).toContain("head west toward the dunes");
  spy.mockRestore();
});

test("interpreterTurn: defaults to stay when API returns an unknown action", async () => {
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({ action: "invalid" as any }));
  const result = await interpreterTurn("?????");
  expect(result).toEqual({ action: "stay" });
  spy.mockRestore();
});
```

(If `spyOn` is not yet imported at top of file, add it: `import { test, expect, spyOn } from "bun:test";` — match the existing import line.)

- [ ] **Step 3.2: Run tests — expect failure**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: `Cannot find name 'interpreterTurn'`.

- [ ] **Step 3.3: Implement `interpreterTurn` in `src/engine.ts`**

Add to `src/engine.ts` after the existing `archivistTurn`:

```typescript
export const INTERPRETER_SYSTEM = `You classify a single player command in a text adventure into a structured movement intent.

Output JSON with one field, "action", whose value is exactly one of:
- "move-north" — the player intends to move northward
- "move-south" — the player intends to move southward
- "move-east"  — the player intends to move eastward
- "move-west"  — the player intends to move westward
- "stay"       — the player is doing something other than directional movement (looking, waiting, examining, talking, or any ambiguous/non-cardinal action)

Rules:
- Pure observation or interaction without movement is "stay" (e.g. "look around", "wait", "examine the door", "talk to the woman").
- "Follow the path", "go through the door", or any non-cardinal phrasing is "stay" — the player must specify a cardinal direction to move.
- Compass synonyms count: "head up the road" alone is "stay"; "head north" is "move-north".
- Output only the JSON object. No prose.`;

const INTERPRETER_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["move-north", "move-south", "move-east", "move-west", "stay"],
    },
  },
  required: ["action"],
  additionalProperties: false,
};

export type InterpretedAction =
  | { action: "move-north" }
  | { action: "move-south" }
  | { action: "move-east" }
  | { action: "move-west" }
  | { action: "stay" };

const VALID_ACTIONS = new Set(["move-north", "move-south", "move-east", "move-west", "stay"]);

export async function interpreterTurn(playerInput: string): Promise<InterpretedAction> {
  const result = await api.callModelStructured<{ action: string }>(
    INTERPRETER_SYSTEM,
    `PLAYER INPUT: ${playerInput}`,
    "movement_intent",
    INTERPRETER_SCHEMA
  );
  if (!VALID_ACTIONS.has(result.action)) return { action: "stay" };
  return { action: result.action } as InterpretedAction;
}
```

- [ ] **Step 3.4: Run tests — expect pass**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: all engine tests pass (including the 4 new ones).

- [ ] **Step 3.5: Run full suite for regressions**

```bash
~/.bun/bin/bun test src/
```

Expected: 0 failures.

- [ ] **Step 3.6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat: add interpreter pass to classify player movement intent"
```

---

## Task 4: Narrator location anchor (TDD)

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/engine.test.ts`

The narrator already receives the formatted `WorldStack` (which now includes `CURRENT LOCATION` when a description is stored — see Task 1). What's missing is a **rule** in the system prompt instructing it to honor that stored description on return visits and not contradict it. This task adds the rule. The function signature does not change.

- [ ] **Step 4.1: Add a failing test asserting the rule wording**

Append to `src/engine.test.ts`:

```typescript
import { NARRATOR_SYSTEM } from "./engine";

test("NARRATOR_SYSTEM: instructs the narrator to honor a canonical location description", () => {
  expect(NARRATOR_SYSTEM).toContain("CURRENT LOCATION");
  expect(NARRATOR_SYSTEM.toLowerCase()).toMatch(/honor|consistent|do not contradict/);
});
```

- [ ] **Step 4.2: Run — expect failure**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: the new test fails because NARRATOR_SYSTEM does not yet mention `CURRENT LOCATION`.

- [ ] **Step 4.3: Add the rule to `NARRATOR_SYSTEM`**

In `src/engine.ts`, locate the `Plausibility — non-negotiable:` block (added previously) and append a new bullet at its end:

```typescript
- If the input contains a "CURRENT LOCATION (canonical description)" section, the player is at that established location. Honor that description: do not contradict it, do not invent a different layout, do not reinvent its core features. Build on it — describe what changes or what the player notices on this visit, but the place itself is fixed.
```

- [ ] **Step 4.4: Run — expect pass**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: all engine tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat: instruct narrator to honor canonical location descriptions"
```

---

## Task 5: Archivist movement confirmation + location capture (TDD)

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/engine.test.ts`

Extend the archivist's structured output with two new fields:
- `moved: boolean` — did the narrative actually depict the player moving to a new location? (False if blocked, refused, or the action was non-movement.)
- `locationDescription: string` — a 1-2 sentence canonical description of the place the player is currently at (after this turn, accounting for movement). Used to capture the description on first visit.

The archivist's *return type* changes — it now returns `{ entries, threads, turn, moved, locationDescription }`. Position and places are NOT updated by `archivistTurn`; the server orchestrates that in Task 6.

- [ ] **Step 5.1: Add failing tests**

Append to `src/engine.test.ts`:

```typescript
test("archivistTurn: returns moved and locationDescription fields", async () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
  };
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({
    entries: ["dune"],
    threads: [],
    moved: true,
    locationDescription: "A windswept dune.",
  }));
  const result = await archivistTurn(stack, "narrative");
  expect(result.moved).toBe(true);
  expect(result.locationDescription).toBe("A windswept dune.");
  expect(result.entries).toEqual(["dune"]);
  expect(result.turn).toBe(1);
  spy.mockRestore();
});

test("archivistTurn: missing moved/locationDescription default safely", async () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
  };
  const spy = spyOn(api, "callModelStructured").mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
  } as any));
  const result = await archivistTurn(stack, "narrative");
  expect(result.moved).toBe(false);
  expect(result.locationDescription).toBe("");
  spy.mockRestore();
});
```

(`WorldStack` import — if not already imported, add it at the top of the file: `import { type WorldStack } from "./stack";`.)

- [ ] **Step 5.2: Run — expect failure**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: the new tests fail because `archivistTurn` doesn't return these fields.

- [ ] **Step 5.3: Update `archivistTurn` and its schema**

In `src/engine.ts`, replace `ARCHIVIST_SCHEMA` with:

```typescript
const ARCHIVIST_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_STACK_ENTRIES,
    },
    threads: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_THREADS,
    },
    moved: {
      type: "boolean",
    },
    locationDescription: {
      type: "string",
    },
  },
  required: ["entries", "threads", "moved", "locationDescription"],
  additionalProperties: false,
};
```

Update the return type and body of `archivistTurn`:

```typescript
export interface ArchivistResult {
  entries: string[];
  threads: string[];
  turn: number;
  moved: boolean;
  locationDescription: string;
}

export async function archivistTurn(stack: WorldStack, narrative: string): Promise<ArchivistResult> {
  const input = `${formatStackForArchivist(stack)}NEW NARRATIVE:\n${narrative}\n\nReturn updated entries, threads, whether the player moved to a new location, and a 1-2 sentence canonical description of the place the player is now at:`;
  const result = await api.callModelStructured<{
    entries: string[];
    threads: string[];
    moved?: boolean;
    locationDescription?: string;
  }>(
    ARCHIVIST_SYSTEM,
    input,
    "world_stack",
    ARCHIVIST_SCHEMA
  );
  if (!Array.isArray(result.entries) || !Array.isArray(result.threads)) {
    throw new Error(`Archivist returned unexpected shape: ${JSON.stringify(result)}`);
  }
  return {
    entries: result.entries.slice(0, MAX_STACK_ENTRIES),
    threads: result.threads.slice(0, MAX_THREADS),
    turn: stack.turn + 1,
    moved: typeof result.moved === "boolean" ? result.moved : false,
    locationDescription: typeof result.locationDescription === "string" ? result.locationDescription : "",
  };
}
```

Also extend `ARCHIVIST_SYSTEM` with new rules. Locate the existing prompt and append (just before the final "Return only the JSON object." line — replace that closing instruction so the new fields are mentioned):

```typescript
Rules for the "moved" field:
- Set moved=true ONLY if the narrative depicts the player's body actually relocating to a new place (a step taken, a threshold crossed, an arrival described).
- Set moved=false if the player attempted to move but was blocked, refused, or the action was non-movement (looking, waiting, examining, talking).

Rules for "locationDescription":
- A 1-2 sentence canonical description of the place the PLAYER IS NOW AT after this turn. Concrete physical features only: terrain, light, the most prominent objects/structures.
- If the location is already established and unchanged, you may keep the description identical to the previous canonical (the server will deduplicate).
- Do not include atmosphere, NPCs, or transient events — only durable physical features of the place itself.

Return only the JSON object. No preamble, no markdown fences, no commentary.`;
```

(Make sure the closing backtick of the template literal is preserved.)

- [ ] **Step 5.4: Run engine tests — expect pass**

```bash
~/.bun/bin/bun test src/engine.test.ts
```

Expected: all engine tests pass.

- [ ] **Step 5.5: Run full suite**

```bash
~/.bun/bin/bun test src/
```

Expected: server tests will FAIL because the existing archivist mocks return the old shape (no `moved`/`locationDescription`). That's fine — Task 6 fixes them. **Do not patch server tests in this task.** Note which tests fail and proceed. If anything *outside* server.test.ts fails, that's a regression.

- [ ] **Step 5.6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat: archivist returns movement confirmation and canonical location description"
```

---

## Task 6: Server orchestration of the 3-pass turn (TDD)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

This is the heart of the change. `processInput` now:

1. Calls `interpreterTurn(playerInput)` → an action.
2. Computes the *prospective* target position. (If action is `stay`, target = current position.)
3. Calls `narratorTurn` with a stack that has its `position` set to the prospective target — so `formatStackForNarrator` surfaces the target tile's stored description (if any).
4. Calls `archivistTurn`. Reads `moved`.
5. Resolves the *final* position: if `action !== "stay"` AND `moved === true`, position = prospective target. Otherwise position = original.
6. If `places[finalKey]` is empty AND `locationDescription` is non-empty, store it.
7. Returns the new stack.

- [ ] **Step 6.1: Update existing tests + add new ones**

Replace the body of `src/server.test.ts` with the following. (This is a full rewrite to keep the test code clean; existing assertions are preserved and new ones added.)

```typescript
import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as engine from "./engine";
import { processInput, type ServerMessage } from "./server";
import type { WorldStack } from "./stack";

let interpreterSpy: any;
let narratorSpy: any;
let archivistSpy: any;

const emptyStack: WorldStack = {
  entries: [],
  threads: [],
  turn: 0,
  position: [0, 0],
  places: {},
};

beforeEach(() => {
  interpreterSpy = spyOn(engine, "interpreterTurn");
  narratorSpy = spyOn(engine, "narratorTurn");
  archivistSpy = spyOn(engine, "archivistTurn");
});

afterEach(() => {
  interpreterSpy.mockRestore();
  narratorSpy.mockRestore();
  archivistSpy.mockRestore();
});

test("processInput: stay action does not change position", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "You look around.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["sand"],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "A flat expanse of sand.",
  }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look around", (m) => messages.push(m));

  expect(newStack.position).toEqual([0, 0]);
  expect(newStack.places["0,0"]).toBe("A flat expanse of sand.");
});

test("processInput: successful move updates position and captures new place", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You walk north into the dunes.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: true,
    locationDescription: "A windswept dune crowned by a single dead tree.",
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([1, 0]);
  expect(newStack.places["1,0"]).toBe("A windswept dune crowned by a single dead tree.");
});

test("processInput: blocked move (moved=false) keeps original position", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "A wall of thorns blocks the way.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["wall of thorns to the north"],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "A flat expanse of sand.",
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([0, 0]);
  expect(newStack.places["1,0"]).toBeUndefined();
});

test("processInput: narrator receives the target tile's stored description as anchor", async () => {
  const stackWithKnownPlace: WorldStack = {
    entries: [],
    threads: [],
    turn: 5,
    position: [0, 0],
    places: { "1,0": "A windswept dune crowned by a single dead tree." },
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return to the dune.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "A windswept dune crowned by a single dead tree.",
  }));

  await processInput(stackWithKnownPlace, "north", () => {});

  // Narrator should have been called with a stack whose position is [1,0]
  // so formatStackForNarrator surfaces the canonical description.
  const stackPassedToNarrator = narratorSpy.mock.calls[0][0] as WorldStack;
  expect(stackPassedToNarrator.position).toEqual([1, 0]);
});

test("processInput: return visit does NOT overwrite stored description", async () => {
  const stackWithKnownPlace: WorldStack = {
    entries: [],
    threads: [],
    turn: 5,
    position: [0, 0],
    places: { "1,0": "ORIGINAL DESCRIPTION" },
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "DIFFERENT DESCRIPTION",
  }));

  const newStack = await processInput(stackWithKnownPlace, "north", () => {});

  expect(newStack.places["1,0"]).toBe("ORIGINAL DESCRIPTION");
});

test("processInput: emits turn-start, narrative, stack-update on happy path", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "The world stirs.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["world stirred"],
    threads: ["find the cause"],
    turn: 1,
    moved: false,
    locationDescription: "An empty void.",
  }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "The world stirs." });
  expect(messages[2]).toMatchObject({
    type: "stack-update",
    entries: ["world stirred"],
    threads: ["find the cause"],
  });
});

test("processInput: on narrator failure, emits error and returns unchanged stack", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => {
    throw new Error("API timeout");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(2);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toMatchObject({ type: "error", source: "narrator" });
  expect(newStack).toBe(emptyStack);
  expect(archivistSpy).not.toHaveBeenCalled();
});

test("processInput: on archivist failure, narrative is sent but stack is unchanged", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "Something happens.");
  archivistSpy.mockImplementationOnce(async () => {
    throw new Error("schema mismatch");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(3);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "Something happens." });
  expect(messages[2]).toMatchObject({ type: "error", source: "archivist" });
  expect(newStack).toBe(emptyStack);
});

test("processInput: on interpreter failure, falls back to stay (still runs narrator)", async () => {
  interpreterSpy.mockImplementationOnce(async () => {
    throw new Error("interpreter API error");
  });
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([0, 0]);
  // narrator was still called
  expect(narratorSpy).toHaveBeenCalled();
});
```

- [ ] **Step 6.2: Run tests — expect failure**

```bash
~/.bun/bin/bun test src/server.test.ts
```

Expected: failures because `processInput` doesn't yet handle interpreter or position updates.

- [ ] **Step 6.3: Update `processInput` in `src/server.ts`**

Replace the existing `processInput` implementation (between `export async function processInput` and the next `import` line) with:

```typescript
import { posKey, applyDirection, type Direction } from "./stack";
import { interpreterTurn, type InterpretedAction } from "./engine";

const ACTION_TO_DIRECTION: Record<string, Direction> = {
  "move-north": "north",
  "move-south": "south",
  "move-east": "east",
  "move-west": "west",
};

export async function processInput(
  stack: WorldStack,
  input: string,
  send: Send
): Promise<WorldStack> {
  send({ type: "turn-start", input });

  // 1. Interpret intent — fall back to stay on failure.
  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch {
    action = { action: "stay" };
  }

  // 2. Compute prospective target tile.
  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;

  // 3. Build a stack for the narrator with position pre-set to the prospective target,
  //    so formatStackForNarrator surfaces the canonical description (if any).
  const narratorStack: WorldStack = { ...stack, position: prospective };

  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    send({ type: "error", source: "narrator", message: String(err) });
    return stack;
  }

  // 4. Archive — extracts entries, threads, moved confirmation, location description.
  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    send({ type: "error", source: "archivist", message: String(err) });
    return stack;
  }

  // 5. Resolve final position: only commit the move if archivist confirms.
  const finalPosition = dir && archived.moved ? prospective : stack.position;

  // 6. Capture canonical description on first visit only.
  const finalKey = posKey(finalPosition);
  const places = { ...stack.places };
  if (!places[finalKey] && archived.locationDescription) {
    places[finalKey] = archived.locationDescription;
  }

  const newStack: WorldStack = {
    entries: archived.entries,
    threads: archived.threads,
    turn: archived.turn,
    position: finalPosition,
    places,
  };

  send({
    type: "stack-update",
    entries: newStack.entries,
    threads: newStack.threads,
  });

  return newStack;
}
```

(The original `processInput` is replaced wholesale. Do not leave the old version behind. Confirm `import type { WorldStack } from "./stack";` is still at the top of the file — `posKey` etc. are added in the new `import` line shown above.)

- [ ] **Step 6.4: Run server tests — expect pass**

```bash
~/.bun/bin/bun test src/server.test.ts
```

Expected: all server tests pass.

- [ ] **Step 6.5: Run full suite**

```bash
~/.bun/bin/bun test src/
```

Expected: every test passes.

- [ ] **Step 6.6: Reset persisted state**

```bash
echo '{"entries":[],"threads":[],"turn":0,"position":[0,0],"places":{}}' > /home/frosty/Dev/ai/adventure/world-stack.json
```

- [ ] **Step 6.7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: server orchestrates 3-pass turn with location anchoring and movement confirmation"
```

---

## Task 7: End-to-end browser verification (manual, with user)

**Files:** None modified. Hand off to user.

- [ ] **Step 7.1: Confirm LM Studio is running and has both models**

```bash
curl -s http://localhost:1234/v1/models | head -20
```

Expected: JSON listing `google/gemma-4-e2b` (narrator) and `nvidia/nemotron-3-nano-4b` (archivist + interpreter).

- [ ] **Step 7.2: Restart the server (kill any prior bun process for this project)**

```bash
pkill -f "bun.*src/server.ts" 2>/dev/null; sleep 1
~/.bun/bin/bun --hot src/server.ts
```

Expected: `World Engine listening at http://localhost:3000`.

- [ ] **Step 7.3: Open `http://localhost:3000` and verify first-visit capture**

In the browser, type `look around`. Wait for narrative.

Then run, in another terminal:

```bash
cat /home/frosty/Dev/ai/adventure/world-stack.json | grep -A3 places
```

Expected: `places["0,0"]` is set to a 1-2 sentence description.

- [ ] **Step 7.4: Move north and verify position update + new place capture**

Type `go north`. Wait. Then:

```bash
cat /home/frosty/Dev/ai/adventure/world-stack.json | grep -E "position|places"
```

Expected: `position` is `[1, 0]` and `places` now has both `"0,0"` and `"1,0"` entries.

- [ ] **Step 7.5: Return to origin and verify the description is consistent**

Type `go south`. The narrative should describe a return to the same place — read it and confirm it does NOT contradict the original `places["0,0"]` description (e.g. if the original said "flat sand", returning shouldn't suddenly say "rolling hills"). Then:

```bash
cat /home/frosty/Dev/ai/adventure/world-stack.json | grep "0,0"
```

Expected: `places["0,0"]` is unchanged from Step 7.3. (Return visits do NOT overwrite.)

- [ ] **Step 7.6: Try a blocked move**

Type something that should fail, like `go north` after the world has established a barrier (or simply pick a direction the narrator describes as blocked). Inspect the file:

```bash
cat /home/frosty/Dev/ai/adventure/world-stack.json | grep position
```

Expected: if the narrative depicted blockage, `position` is unchanged; if it depicted movement, position advanced. Compare against what the narrative actually said. If they're inconsistent, the archivist's `moved` extraction is the weak link — note it for tuning but it's not a blocker.

- [ ] **Step 7.7: Try a non-cardinal move ("follow the path")**

Type `follow the path`. Expected: interpreter classifies this as `stay`, position is unchanged, narrator describes the path. The player must then say `go north` (or similar cardinal) to actually move.

- [ ] **Step 7.8: Run the full test suite one final time**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass.

- [ ] **Step 7.9: Final commit (if anything changed)**

```bash
git status
# if changes:
git add -A
git commit -m "chore: end-to-end verification of location coordinate system"
```

---

## Spec Coverage Self-Review

| Requirement | Task |
|-------------|------|
| 2D integer coordinate system, internal-only | Task 1 (`Position`, `posKey`) |
| Player starts at `[0, 0]` | Task 1 (`emptyStack` default) |
| North = +1 on first axis | Task 1 (`DELTAS`, `applyDirection` tests) |
| Place identity by coordinate, not by name | Task 1 (`places: Record<string, string>` keyed by `posKey`) |
| LLM-based parsing of player input → movement intent | Task 3 (`interpreterTurn`) |
| Cardinal-only for MVP, ambiguous → stay | Task 3 (`INTERPRETER_SYSTEM` prompt + enum schema) |
| Narrator anchored with canonical description on return visits | Task 1 (`formatStackForNarrator`) + Task 4 (prompt rule) + Task 6 (server passes prospective target) |
| First visit captures, return visits do NOT overwrite | Task 6 (`if (!places[finalKey] && archived.locationDescription)`) |
| Blocked move does not advance position | Task 5 (archivist `moved` field) + Task 6 (`finalPosition` resolution) |
| Backwards-compat with saved stacks predating this change | Task 1 (`loadStack` defaults) |
| Z-axis deferred | Out of scope — documented in Design Decisions |
| Existing tests keep passing | Task 2 (fixture updates) |
