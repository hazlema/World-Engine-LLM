# Room State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-tile structured object state with `states[]` to the archivist output so room state survives turns and return-to-tile visits — snuffed candles stay snuffed.

**Architecture:** Adds a `RoomObject` type (name, states[], optional location, category) stored per-tile on `WorldStack.placeObjects` keyed by `posKey`. Archivist emits these alongside existing `entries`/`threads`; narrator gets them as a `ROOM STATE` block it must honor. Category drives eviction priority via a constant lookup; active-objective anchors override to high and a deterministic safety net restores dropped pins from prior state. No new LLM stage.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`. Modifies `src/stack.ts`, `src/engine.ts`, `src/server.ts` and their test files.

**Spec reference:** `docs/superpowers/specs/2026-05-15-room-state-design.md`

---

## File Structure

**Files modified:**
- `src/stack.ts` — `RoomObject` type, `ObjectCategory`, `CATEGORY_PRIORITY`, `MAX_PLACE_OBJECTS`, extend `WorldStack`, update `emptyStack`/`applyPresetToStack`/`parseStackData`, new helpers (`extractPinnedNames`, `applyRoomObjectsSafetyNet`), update `formatStackForArchivist` and `formatStackForNarrator`.
- `src/stack.test.ts` — tests for new helpers, migration, formatter blocks. Mechanical sweep to add `placeObjects: {}` to existing `WorldStack` literals.
- `src/engine.ts` — extend `ARCHIVIST_SCHEMA` and `ARCHIVIST_SYSTEM`, extend `ArchivistResult`, map `objects` in `archivistTurn` return, add `ROOM STATE` rule to `NARRATOR_SYSTEM`.
- `src/engine.test.ts` — schema acceptance fixture + `archivistTurn` returning objects. Mechanical sweep for `placeObjects: {}`.
- `src/server.ts` — call safety net after `archivistTurn`, persist `placeObjects` into `newStack`.
- `src/server.test.ts` — sweep for `placeObjects: {}` if any tests build stacks; otherwise unchanged behaviorally.

---

### Task 1: Add `RoomObject` type, `ObjectCategory`, and constants in `stack.ts`

**Files:**
- Modify: `src/stack.ts` (top of file, near other types/constants)

- [ ] **Step 1: Add types and constants**

Insert near the top of `src/stack.ts`, after the existing `MAX_THREADS` constant (around line 5):

```ts
export const MAX_PLACE_OBJECTS = 10;

export type ObjectCategory = "item" | "fixture" | "feature" | "character";

export interface RoomObject {
  name: string;
  states: string[];
  location?: string;
  category: ObjectCategory;
}

export const CATEGORY_PRIORITY: Record<ObjectCategory, "high" | "normal" | "low"> = {
  item: "high",
  character: "high",
  fixture: "normal",
  feature: "low",
};
```

- [ ] **Step 2: Run tests to confirm no regression**

Run: `bun test src/stack.test.ts`
Expected: existing tests still pass (no behavior change yet).

- [ ] **Step 3: Commit**

```bash
git add src/stack.ts
git commit -m "feat(stack): add RoomObject type + CATEGORY_PRIORITY constant"
```

---

### Task 2: Extend `WorldStack` with `placeObjects` and update constructors

**Files:**
- Modify: `src/stack.ts` (WorldStack interface, emptyStack, applyPresetToStack, parseStackData)
- Modify: `src/stack.test.ts`, `src/engine.test.ts`, `src/server.test.ts` (mechanical sweep for inline `WorldStack` literals)

- [ ] **Step 1: Write failing test for `parseStackData` migration**

Add to `src/stack.test.ts` (anywhere with other `parseStackData` tests):

```ts
test("parseStackData: missing placeObjects defaults to empty object", () => {
  const raw = {
    entries: ["a"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  const parsed = parseStackData(raw);
  expect(parsed?.placeObjects).toEqual({});
});

test("parseStackData: preserves valid placeObjects", () => {
  const raw = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on desk", category: "fixture" },
      ],
    },
  };
  const parsed = parseStackData(raw);
  expect(parsed?.placeObjects["0,0"]?.[0]?.name).toBe("candle");
  expect(parsed?.placeObjects["0,0"]?.[0]?.states).toEqual(["lit"]);
  expect(parsed?.placeObjects["0,0"]?.[0]?.category).toBe("fixture");
});
```

- [ ] **Step 2: Run tests to verify they fail at compile**

Run: `bun test src/stack.test.ts`
Expected: TypeScript errors — `WorldStack` has no property `placeObjects`.

- [ ] **Step 3: Extend `WorldStack` interface**

In `src/stack.ts`, update the `WorldStack` interface:

```ts
export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
  objectives: Objective[];
  presetSlug: string | null;
  attributes: PlayerAttribute[];
  placeObjects: Record<string, RoomObject[]>;
}
```

- [ ] **Step 4: Update `emptyStack` to include `placeObjects: {}`**

```ts
function emptyStack(): WorldStack {
  return {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
}
```

- [ ] **Step 5: Update `applyPresetToStack` to include `placeObjects: {}`**

In the return object near line 338 of stack.ts, add `placeObjects: {},` to the returned literal:

```ts
return {
  entries: [...preset.objects],
  threads: [],
  turn: 0,
  position: [0, 0],
  places: {},
  objectives: preset.objectives.map(/* unchanged */),
  presetSlug: preset.slug,
  attributes: preset.attributes.map((a) => ({ name: a.name, scope: [...a.scope] })),
  placeObjects: {},
};
```

- [ ] **Step 6: Update `parseStackData` to parse/default `placeObjects`**

In `src/stack.ts`, inside `parseStackData` after the `attributes` block and before the return statement, add:

```ts
const placeObjects: Record<string, RoomObject[]> = {};
if (data.placeObjects !== null && typeof data.placeObjects === "object" && !Array.isArray(data.placeObjects)) {
  for (const key of Object.keys(data.placeObjects)) {
    const arr = data.placeObjects[key];
    if (!Array.isArray(arr)) continue;
    const cleaned: RoomObject[] = [];
    for (const obj of arr) {
      if (!obj || typeof obj !== "object") continue;
      if (typeof obj.name !== "string" || obj.name.length === 0) continue;
      if (!Array.isArray(obj.states)) continue;
      if (!obj.states.every((s: any) => typeof s === "string")) continue;
      if (obj.category !== "item" && obj.category !== "fixture" && obj.category !== "feature" && obj.category !== "character") continue;
      const ro: RoomObject = {
        name: obj.name,
        states: [...obj.states],
        category: obj.category,
      };
      if (typeof obj.location === "string" && obj.location.length > 0) {
        ro.location = obj.location;
      }
      cleaned.push(ro);
    }
    placeObjects[key] = cleaned;
  }
}
```

Then add `placeObjects` to the returned object:

```ts
return {
  entries: data.entries,
  threads: Array.isArray(data.threads) ? data.threads : [],
  turn: data.turn,
  position,
  places,
  objectives,
  presetSlug,
  attributes,
  placeObjects,
};
```

- [ ] **Step 7: Sweep existing `WorldStack` literals**

Across `src/stack.test.ts`, `src/engine.test.ts`, `src/server.test.ts`, find every inline `WorldStack` literal (any object that has `entries:`, `threads:`, `turn:`, etc.) and add `placeObjects: {},` to it. The literals follow a clear pattern — typically near `attributes: []` is a good place to put the new field.

The shared fixture builders are the best places to start:
- `src/engine.test.ts` line ~14 (`emptyStack`) and line ~16 (`populatedStack`) — fixed constants at top of file.
- `src/engine.test.ts` `makeStack` helper around line ~25 — defaults object.
- `src/stack.test.ts` — many inline literals in tests; add `placeObjects: {}` next to `attributes: []` in each.
- `src/server.test.ts` — same pattern.

After sweeping, also check that any helper that constructs a `WorldStack` via spreads doesn't lose the field (e.g., `{ ...emptyStack, entries: [...] }` will inherit `placeObjects: {}` from the base, so those are fine).

- [ ] **Step 8: Run all tests to verify migration test passes and existing tests still pass**

Run: `bun test src/stack.test.ts src/engine.test.ts src/server.test.ts`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/stack.ts src/stack.test.ts src/engine.test.ts src/server.test.ts
git commit -m "feat(stack): extend WorldStack with placeObjects (per-tile RoomObject lists)"
```

---

### Task 3: `extractPinnedNames` helper

Helper that derives the pinned-names set from active objectives + unresolved threads. Used by both the archivist prompt (`MUST INCLUDE` line) and the safety net (force-pinning + restoration).

**Files:**
- Modify: `src/stack.ts` (add new exported function)
- Modify: `src/stack.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Add to `src/stack.test.ts`:

```ts
test("extractPinnedNames: pulls anchor nouns from active LOCATE objectives", () => {
  const objectives: Objective[] = [
    { text: "Find the brass key", achieved: false },
    { text: "Locate the wooden rose", achieved: false },
    { text: "Open the iron chest", achieved: false },
  ];
  const names = extractPinnedNames(objectives, []);
  expect(names).toContain("key");
  expect(names).toContain("rose");
});

test("extractPinnedNames: skips achieved objectives", () => {
  const objectives: Objective[] = [
    { text: "Find the brass key", achieved: true },
    { text: "Locate the wooden rose", achieved: false },
  ];
  const names = extractPinnedNames(objectives, []);
  expect(names).not.toContain("key");
  expect(names).toContain("rose");
});

test("extractPinnedNames: pulls trailing nouns from threads as cheap heuristic", () => {
  const names = extractPinnedNames([], ["find out who lit the distant fire", "discover the brass altar"]);
  // last word of each thread, length>2, lowercase
  expect(names).toContain("fire");
  expect(names).toContain("altar");
});

test("extractPinnedNames: returns empty set when nothing to pin", () => {
  expect(extractPinnedNames([], [])).toEqual(new Set());
});
```

You'll also need to add `extractPinnedNames` to the existing import line at the top of `src/stack.test.ts`:

```ts
import { /* existing names */, extractPinnedNames, type Objective } from "./stack";
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/stack.test.ts`
Expected: failure — `extractPinnedNames` does not exist.

- [ ] **Step 3: Implement `extractPinnedNames`**

Add to `src/stack.ts`, after `locateObjectiveAnchor`:

```ts
// Cheap trailing-noun extraction for threads. Mirrors locateObjectiveAnchor's
// last-word-length>2 rule. Used only as a prompt-side hint; the safety net is
// the real guard against the archivist dropping critical objects.
function trailingNoun(text: string): string | null {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 2);
  const last = words[words.length - 1];
  if (!last) return null;
  return last.replace(/[^a-z0-9]/gi, "").toLowerCase() || null;
}

export function extractPinnedNames(
  objectives: Objective[],
  threads: string[]
): Set<string> {
  const names = new Set<string>();
  for (const obj of objectives) {
    if (obj.achieved) continue;
    const anchor = locateObjectiveAnchor(obj.text);
    if (anchor) names.add(anchor);
    // Also pull trailing noun for non-LOCATE objectives ("open the iron chest").
    if (!anchor) {
      const n = trailingNoun(obj.text);
      if (n) names.add(n);
    }
  }
  for (const t of threads) {
    const n = trailingNoun(t);
    if (n) names.add(n);
  }
  return names;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/stack.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): extractPinnedNames helper for room-state pinning"
```

---

### Task 4: `applyRoomObjectsSafetyNet` helper

Deterministic post-archivist filter that drops player-self-referential objects, force-pins anchor-named objects to `high`, restores missing pinned objects from prior state, and enforces the cap.

**Files:**
- Modify: `src/stack.ts` (add new exported function)
- Modify: `src/stack.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Add to `src/stack.test.ts`. Also extend the import line to include `applyRoomObjectsSafetyNet`, `CATEGORY_PRIORITY`, `MAX_PLACE_OBJECTS`, and types `RoomObject`, `ObjectCategory`:

```ts
test("safetyNet: drops player-self-referential objects", () => {
  const archivistObjects: RoomObject[] = [
    { name: "your hair", states: ["red"], category: "feature" },
    { name: "the player's eyes", states: ["alert"], category: "feature" },
    { name: "Player's shadow", states: ["long"], category: "feature" },
    { name: "candle", states: ["lit"], category: "fixture" },
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, [], new Set());
  expect(result.map((o) => o.name)).toEqual(["candle"]);
});

test("safetyNet: restores missing pinned object from prior state", () => {
  const prior: RoomObject[] = [
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    { name: "key", states: ["worn smooth"], category: "item" },
  ];
  const archivistObjects: RoomObject[] = [
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    // archivist dropped "key" by mistake — should be restored
  ];
  const pinned = new Set(["key"]);
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, pinned);
  expect(result.map((o) => o.name).sort()).toEqual(["candle", "key"]);
  const restored = result.find((o) => o.name === "key");
  expect(restored?.states).toEqual(["worn smooth"]);
});

test("safetyNet: does not invent objects not in prior state", () => {
  const prior: RoomObject[] = [];
  const archivistObjects: RoomObject[] = [];
  const pinned = new Set(["unicorn"]);
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, pinned);
  expect(result).toEqual([]);
});

test("safetyNet: cap enforcement drops feature before fixture before item", () => {
  const archivistObjects: RoomObject[] = [
    { name: "item-1", states: [], category: "item" },
    { name: "item-2", states: [], category: "item" },
    { name: "item-3", states: [], category: "item" },
    { name: "fix-1", states: [], category: "fixture" },
    { name: "fix-2", states: [], category: "fixture" },
    { name: "fix-3", states: [], category: "fixture" },
    { name: "feat-1", states: [], category: "feature" },
    { name: "feat-2", states: [], category: "feature" },
    { name: "feat-3", states: [], category: "feature" },
    { name: "feat-4", states: [], category: "feature" },
    { name: "feat-5", states: [], category: "feature" },
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, [], new Set());
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  // No features should survive when 6 normals/highs exist
  const remaining = result.map((o) => o.category);
  const featureCount = remaining.filter((c) => c === "feature").length;
  expect(featureCount).toBeLessThanOrEqual(MAX_PLACE_OBJECTS - 6);
});

test("safetyNet: pinned name forces high priority and survives cap", () => {
  // 10 features + 1 pinned feature; the pinned one must survive.
  const features: RoomObject[] = Array.from({ length: 10 }, (_, i) => ({
    name: `feat-${i}`,
    states: [],
    category: "feature" as ObjectCategory,
  }));
  const pinnedFeature: RoomObject = {
    name: "candle",
    states: ["lit"],
    category: "feature",
  };
  const result = applyRoomObjectsSafetyNet(
    [...features, pinnedFeature],
    [],
    new Set(["candle"])
  );
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  expect(result.some((o) => o.name === "candle")).toBe(true);
});

test("safetyNet: within a tier, prefers keeping objects whose state changed this turn", () => {
  const prior: RoomObject[] = [
    { name: "lever", states: ["up"], category: "fixture" },
    { name: "hatch", states: ["closed"], category: "fixture" },
  ];
  // Eleven fixtures, two of which appear in prior. Of the two in prior, only
  // "hatch" has a state change ("closed" → "open"). Cap drops one — should
  // prefer dropping the unchanged "lever" over the changed "hatch".
  const archivistObjects: RoomObject[] = [
    { name: "lever", states: ["up"], category: "fixture" },          // unchanged
    { name: "hatch", states: ["open"], category: "fixture" },        // changed
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `fix-new-${i}`,
      states: [] as string[],
      category: "fixture" as ObjectCategory,
    })),
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, new Set());
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  // The changed one must survive.
  expect(result.some((o) => o.name === "hatch")).toBe(true);
  // The unchanged one is the only natural drop candidate.
  expect(result.some((o) => o.name === "lever")).toBe(false);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/stack.test.ts`
Expected: failure — `applyRoomObjectsSafetyNet` does not exist.

- [ ] **Step 3: Implement `applyRoomObjectsSafetyNet`**

Add to `src/stack.ts` after `extractPinnedNames`:

```ts
const PLAYER_NAME_PREFIXES = [
  /^your\s+/i,
  /^the\s+player'?s\s+/i,
  /^player'?s\s+/i,
];

function isPlayerSelfReferential(name: string): boolean {
  return PLAYER_NAME_PREFIXES.some((re) => re.test(name));
}

function priorityRank(p: "high" | "normal" | "low"): number {
  return p === "high" ? 2 : p === "normal" ? 1 : 0;
}

function stateChanged(current: RoomObject, prior: RoomObject[]): boolean {
  const match = prior.find((p) => p.name.toLowerCase() === current.name.toLowerCase());
  if (!match) return true; // brand-new object counts as a change
  if (match.states.length !== current.states.length) return true;
  for (const s of current.states) if (!match.states.includes(s)) return true;
  return false;
}

// Post-archivist deterministic pass. Input: archivist's returned objects for
// the current tile, the prior turn's objects for the same tile, and the set
// of pinned names (from objectives + threads).
//
// The function: (1) drops player-self-referential names, (2) force-pins
// objects whose names are in the pinned set to "high" priority for eviction,
// (3) restores any pinned name that is missing from the archivist output but
// existed in prior state, (4) enforces MAX_PLACE_OBJECTS by dropping
// lowest-priority objects first; within a tier, prefers dropping objects with
// no state change this turn.
//
// Never invents objects. Restoration only re-injects entries from prior state.
export function applyRoomObjectsSafetyNet(
  archivistObjects: RoomObject[],
  priorObjects: RoomObject[],
  pinnedNames: Set<string>
): RoomObject[] {
  // 1. Drop player-self-referential objects.
  const filtered = archivistObjects.filter((o) => !isPlayerSelfReferential(o.name));

  // 2. Track which names are present, lowercased for matching.
  const presentNames = new Set(filtered.map((o) => o.name.toLowerCase()));

  // 3. Restore pinned objects missing from archivist output, using prior state.
  const restored: RoomObject[] = [...filtered];
  for (const name of pinnedNames) {
    if (presentNames.has(name.toLowerCase())) continue;
    const priorMatch = priorObjects.find((o) => o.name.toLowerCase().includes(name.toLowerCase()));
    if (priorMatch) {
      console.warn(`[room-state] archivist dropped pinned object: ${priorMatch.name}`);
      restored.push({ ...priorMatch, states: [...priorMatch.states] });
    }
  }

  // 4. Compute effective priority and per-object state-change flag.
  const annotated = restored.map((o) => {
    const isPinned = Array.from(pinnedNames).some((p) =>
      o.name.toLowerCase().includes(p.toLowerCase())
    );
    const basePriority = CATEGORY_PRIORITY[o.category];
    const effective: "high" | "normal" | "low" = isPinned ? "high" : basePriority;
    return { obj: o, priority: effective, changed: stateChanged(o, priorObjects) };
  });

  // 5. Cap enforcement: highest priority first, changed-this-turn breaks ties.
  if (annotated.length <= MAX_PLACE_OBJECTS) {
    return annotated.map((x) => x.obj);
  }
  annotated.sort((a, b) => {
    const pDiff = priorityRank(b.priority) - priorityRank(a.priority);
    if (pDiff !== 0) return pDiff;
    return (b.changed ? 1 : 0) - (a.changed ? 1 : 0);
  });
  return annotated.slice(0, MAX_PLACE_OBJECTS).map((x) => x.obj);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/stack.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): applyRoomObjectsSafetyNet — deterministic post-archivist pass"
```

---

### Task 5: Add `CURRENT TILE OBJECTS` and `MUST INCLUDE` blocks to `formatStackForArchivist`

**Files:**
- Modify: `src/stack.ts` (`formatStackForArchivist`)
- Modify: `src/stack.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Add to `src/stack.test.ts`:

```ts
test("formatStackForArchivist: includes CURRENT TILE OBJECTS when current tile has prior objects", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on desk", category: "fixture" },
        { name: "key", states: ["worn smooth"], category: "item" },
      ],
    },
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("CURRENT TILE OBJECTS:");
  expect(out).toContain("- candle (fixture, on desk): lit");
  expect(out).toContain("- key (item): worn smooth");
});

test("formatStackForArchivist: omits CURRENT TILE OBJECTS when current tile has none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("CURRENT TILE OBJECTS");
});

test("formatStackForArchivist: includes MUST INCLUDE when pinned names exist", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the brass key", achieved: false, position: [0, 0] },
    ],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("MUST INCLUDE: key");
});

test("formatStackForArchivist: omits MUST INCLUDE when no pinned names", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("MUST INCLUDE");
});

test("formatStackForArchivist: object without states formats without colon-empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [{ name: "wall", states: [], category: "feature" }],
    },
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("- wall (feature)");
  expect(out).not.toContain("- wall (feature): ");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/stack.test.ts`
Expected: failures on the new tests.

- [ ] **Step 3: Update `formatStackForArchivist`**

In `src/stack.ts`, modify `formatStackForArchivist` to add the two new blocks. Replace the function body:

```ts
export function formatStackForArchivist(stack: WorldStack): string {
  const parts: string[] = [];
  const attrBlock = formatPlayerAttributesBlock(stack.attributes);
  if (attrBlock) parts.push(attrBlock);
  const facts =
    stack.entries.length === 0
      ? "CURRENT STACK: (empty)"
      : `CURRENT STACK:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`;
  const threads =
    stack.threads.length === 0
      ? "ACTIVE THREADS: (none)"
      : `ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`;
  parts.push(facts);
  parts.push(threads);

  const currentObjects = stack.placeObjects[posKey(stack.position)] ?? [];
  if (currentObjects.length > 0) {
    const lines = currentObjects.map((o) => {
      const loc = o.location ? `, ${o.location}` : "";
      const statesPart = o.states.length > 0 ? `: ${o.states.join(", ")}` : "";
      return `- ${o.name} (${o.category}${loc})${statesPart}`;
    });
    parts.push(`CURRENT TILE OBJECTS:\n${lines.join("\n")}`);
  }

  const pinned = extractPinnedNames(stack.objectives, stack.threads);
  if (pinned.size > 0) {
    parts.push(`MUST INCLUDE: ${Array.from(pinned).join(", ")}`);
  }

  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map((o, i) => {
      const status = o.achieved ? "x" : " ";
      const distantFlag =
        o.position && manhattan(stack.position, o.position) > 0
          ? " [OFF-TILE — cannot be completed this turn]"
          : "";
      return `${i}: [${status}] ${o.text}${distantFlag}`;
    });
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
  }
  return `${parts.join("\n\n")}\n\n`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/stack.test.ts`
Expected: all pass (including pre-existing `formatStackForArchivist` tests — verify those still pass since we kept their structure intact).

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): format CURRENT TILE OBJECTS + MUST INCLUDE for archivist prompt"
```

---

### Task 6: Add `ROOM STATE` block to `formatStackForNarrator`

**Files:**
- Modify: `src/stack.ts` (`formatStackForNarrator`)
- Modify: `src/stack.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Add to `src/stack.test.ts`:

```ts
test("formatStackForNarrator: includes ROOM STATE block with objects", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
        { name: "key", states: ["worn smooth"], category: "item" },
      ],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("ROOM STATE:");
  expect(out).toContain("- candle: lit (on oak desk)");
  expect(out).toContain("- key: worn smooth");
});

test("formatStackForNarrator: omits ROOM STATE block when current tile has none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      // Different tile has objects, but current tile [0,0] does not.
      "1,0": [{ name: "candle", states: ["lit"], category: "fixture" }],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("ROOM STATE");
});

test("formatStackForNarrator: object with no states omits trailing colon", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [{ name: "oak desk", states: [], category: "feature" }],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("- oak desk");
  expect(out).not.toContain("- oak desk: ");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/stack.test.ts`
Expected: failures on the new tests.

- [ ] **Step 3: Update `formatStackForNarrator`**

In `src/stack.ts`, modify `formatStackForNarrator`. Find the block that pushes `CURRENT LOCATION (canonical description)` (around line 262-265) and insert the ROOM STATE block immediately after it:

```ts
  const here = stack.places[posKey(stack.position)];
  if (here) {
    parts.push(`CURRENT LOCATION (canonical description):\n${here}`);
  }
  const roomObjects = stack.placeObjects[posKey(stack.position)] ?? [];
  if (roomObjects.length > 0) {
    const lines = roomObjects.map((o) => {
      const loc = o.location ? ` (${o.location})` : "";
      const statesPart = o.states.length > 0 ? `: ${o.states.join(", ")}` : "";
      return `- ${o.name}${statesPart}${loc}`;
    });
    parts.push(`ROOM STATE:\n${lines.join("\n")}`);
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/stack.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): format ROOM STATE block for narrator prompt"
```

---

### Task 7: Extend `ARCHIVIST_SCHEMA`, `ArchivistResult`, and `archivistTurn` to return objects

**Files:**
- Modify: `src/engine.ts` (`ARCHIVIST_SCHEMA`, `ArchivistResult`, `archivistTurn`)
- Modify: `src/engine.test.ts` (add tests)

- [ ] **Step 1: Write failing test**

Add to `src/engine.test.ts` (after existing archivist tests):

```ts
test("archivistTurn: returns objects parsed from model response", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: ["a candle on a desk"],
    threads: [],
    moved: false,
    locationDescription: "a small study with an oak desk",
    achievedObjectiveIndices: [],
    objects: [
      { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
      { name: "key", states: ["worn smooth"], category: "item" },
    ],
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects).toEqual([
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    { name: "key", states: ["worn smooth"], category: "item" },
  ]);
});

test("archivistTurn: defaults objects to empty array when missing", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
    // no `objects` field at all
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects).toEqual([]);
});

test("archivistTurn: filters invalid objects (bad category, missing name)", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
    objects: [
      { name: "good", states: [], category: "fixture" },
      { name: "", states: [], category: "fixture" }, // empty name — drop
      { name: "bad-cat", states: [], category: "player_body" }, // not in enum — drop
      { name: "no-cat", states: [] }, // missing category — drop
    ],
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects.map((o) => o.name)).toEqual(["good"]);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/engine.test.ts`
Expected: failures — `ArchivistResult` has no `objects` field; `archivistTurn` does not return one.

- [ ] **Step 3: Add `objects` to `ARCHIVIST_SCHEMA`**

In `src/engine.ts`, replace `ARCHIVIST_SCHEMA`:

```ts
const ARCHIVIST_SCHEMA = {
  type: "object",
  properties: {
    entries: { type: "array", items: { type: "string" }, maxItems: MAX_STACK_ENTRIES },
    threads: { type: "array", items: { type: "string" }, maxItems: MAX_THREADS },
    moved: { type: "boolean" },
    locationDescription: { type: "string" },
    achievedObjectiveIndices: { type: "array", items: { type: "integer", minimum: 0 } },
    objects: {
      type: "array",
      maxItems: MAX_PLACE_OBJECTS,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          states: { type: "array", items: { type: "string" } },
          location: { type: "string" },
          category: { type: "string", enum: ["item", "fixture", "feature", "character"] },
        },
        required: ["name", "states", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries", "threads", "moved", "locationDescription", "achievedObjectiveIndices", "objects"],
  additionalProperties: false,
};
```

Also update the import at the top of `src/engine.ts`:

```ts
import { WorldStack, MAX_STACK_ENTRIES, MAX_THREADS, MAX_PLACE_OBJECTS, formatStackForNarrator, formatStackForArchivist, locateObjectiveAnchor, type RoomObject } from "./stack";
```

- [ ] **Step 4: Extend `ArchivistResult` and `archivistTurn` return mapping**

In `src/engine.ts`, update `ArchivistResult`:

```ts
export interface ArchivistResult {
  entries: string[];
  threads: string[];
  turn: number;
  moved: boolean;
  locationDescription: string;
  achievedObjectiveIndices: number[];
  objects: RoomObject[];
}
```

Update the `callModelStructured` generic type and the return mapping in `archivistTurn`:

```ts
  const result = await api.callModelStructured<{
    entries: string[];
    threads: string[];
    moved?: boolean;
    locationDescription?: string;
    achievedObjectiveIndices?: unknown;
    objects?: unknown;
  }>(ARCHIVIST_SYSTEM, input, "world_stack", ARCHIVIST_SCHEMA);

  if (!Array.isArray(result.entries) || !Array.isArray(result.threads)) {
    throw new Error(`Archivist returned unexpected shape: ${JSON.stringify(result)}`);
  }

  const indices = Array.isArray(result.achievedObjectiveIndices)
    ? result.achievedObjectiveIndices.filter(
        (i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0
      )
    : [];

  const objects: RoomObject[] = Array.isArray(result.objects)
    ? (result.objects as any[]).flatMap((o): RoomObject[] => {
        if (!o || typeof o !== "object") return [];
        if (typeof o.name !== "string" || o.name.length === 0) return [];
        if (!Array.isArray(o.states)) return [];
        if (!o.states.every((s: any) => typeof s === "string")) return [];
        if (o.category !== "item" && o.category !== "fixture" && o.category !== "feature" && o.category !== "character") return [];
        const ro: RoomObject = { name: o.name, states: [...o.states], category: o.category };
        if (typeof o.location === "string" && o.location.length > 0) ro.location = o.location;
        return [ro];
      })
    : [];

  return {
    entries: result.entries.slice(0, MAX_STACK_ENTRIES),
    threads: result.threads.slice(0, MAX_THREADS),
    turn: stack.turn + 1,
    moved: typeof result.moved === "boolean" ? result.moved : false,
    locationDescription: typeof result.locationDescription === "string" ? result.locationDescription : "",
    achievedObjectiveIndices: indices,
    objects,
  };
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `bun test src/engine.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat(engine): archivist schema + result include objects[]"
```

---

### Task 8: Add object rules to `ARCHIVIST_SYSTEM`

**Files:**
- Modify: `src/engine.ts` (`ARCHIVIST_SYSTEM` constant)

- [ ] **Step 1: Add object rules to the archivist system prompt**

In `src/engine.ts`, locate `ARCHIVIST_SYSTEM` (around line 58) and add a new rules section between the existing `Rules for "achievedObjectiveIndices":` block and the closing `Return only the JSON object. No preamble, no markdown fences, no commentary.` line.

Insert this new section before that closing sentence:

```
Rules for "objects" (current tile only):
- Extract discrete physical things at the player's CURRENT tile: items they could interact with, fixtures attached to the room, immovable features, and characters present.
- Each object gets: \`name\` (canonical lowercase noun, e.g. "brass candle"), \`states\` (observable conditions, e.g. ["lit"], ["snuffed"], ["worn smooth"], ["open"]), optional \`location\` (within-tile detail like "on oak desk"), \`category\` (item | fixture | feature | character).
- CATEGORIES:
  - "item" = a pickup-able discrete object (key, scroll, coin, dagger).
  - "character" = an NPC or creature in the room (the woman in wool, the watchman, a crow).
  - "fixture" = a durable thing attached to the room with state worth tracking (candle, chest, lever, painting, hearth).
  - "feature" = immovable scenery (wall, floor, ceiling, dust motes, the shape of the corridor).
- PRESERVE STATES ACROSS TURNS. The CURRENT TILE OBJECTS block (when present) shows what was true last turn. Carry states forward unchanged unless the new narrative depicts a state change. The default is keep.
- UPDATE STATES ONLY WHEN THE NARRATIVE DEPICTS A CHANGE. Player snuffs the candle → \`states\` ["lit"] becomes ["snuffed"]. Player opens the chest → states include "open". Do not accumulate contradictory states.
- PRESERVE \`location\` ACROSS STATE CHANGES. The desk is still the desk after the candle on it is snuffed.
- MAX ${MAX_PLACE_OBJECTS} OBJECTS. When over the cap, prefer dropping "feature" before "fixture", and drop fixtures with no recent state change before fixtures that just changed.
- MUST INCLUDE names cannot be dropped. If the input shows \`MUST INCLUDE: brass candle\`, the brass candle must be in your output.
- NEVER emit objects describing the player. The player's body, hair, eyes, innate appearance, and anything covered by PLAYER ATTRIBUTES is immutable session data. Do not duplicate it as a room object. The player is the camera, not an object in the room.
- Object updates apply only to the CURRENT tile. Do not invent objects from other tiles. Other tiles' state is preserved server-side and not your concern this turn.
```

(Use template-literal escaping consistent with the surrounding code — the existing `ARCHIVIST_SYSTEM` is a single template string, so embed `${MAX_PLACE_OBJECTS}` directly without escaping. The triple-backtick code-blocks above are just for plan readability; in the actual prompt, use plain text and single backticks.)

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: all pass. No new test added in this step — this is a prompt-only change. Existing tests verify the schema; prompt quality is evaluated manually.

- [ ] **Step 3: Commit**

```bash
git add src/engine.ts
git commit -m "feat(engine): archivist prompt rules for room objects"
```

---

### Task 9: Add `ROOM STATE` canonical rule to `NARRATOR_SYSTEM`

**Files:**
- Modify: `src/engine.ts` (`NARRATOR_SYSTEM` constant)

- [ ] **Step 1: Append the new rule to the narrator system prompt**

In `src/engine.ts`, locate `NARRATOR_SYSTEM` (around line 7). Add a new paragraph at the end of the prompt, before the closing backtick. Place it AFTER the existing description of how the narrator should write but BEFORE any closing summary. The simplest place is at the very end:

```
ROOM STATE is canonical. If a ROOM STATE block appears in the context, every object listed there with a state must be consistent with that state in your prose. The candle is lit if and only if ROOM STATE says lit. Do not relight snuffed candles, re-close opened chests, or restore broken items. State changes happen through the player's actions across turns — they are recorded by the archivist between turns, never by your prose alone.
```

Insert this immediately before the closing backtick of the `NARRATOR_SYSTEM` template string.

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/engine.ts
git commit -m "feat(engine): narrator rule — ROOM STATE is canonical"
```

---

### Task 10: Wire safety net into `server.ts` and persist `placeObjects`

**Files:**
- Modify: `src/server.ts` (call safety net, persist `placeObjects` into `newStack`)

- [ ] **Step 1: Update imports in `server.ts`**

Near the top of `src/server.ts`, find the existing import from `./stack` and add the new names. The current import likely includes `posKey`, `inferLocateCompletions`, `unionAchievedIndices`, etc. Add `applyRoomObjectsSafetyNet` and `extractPinnedNames`:

```ts
import {
  // existing names...
  applyRoomObjectsSafetyNet,
  extractPinnedNames,
} from "./stack";
```

(Match the surrounding import style — multiline if the existing one is multiline, single-line otherwise.)

- [ ] **Step 2: Apply safety net and persist `placeObjects` in the archivist turn handler**

Locate the block around line 308-337 of `src/server.ts` (where `newStack` is constructed). Insert the safety-net application immediately before `newStack` is built:

```ts
  // Apply room-state safety net for the current (post-move) tile.
  const priorObjectsForTile = stack.placeObjects[finalKey] ?? [];
  const pinnedNames = extractPinnedNames(stack.objectives, archived.threads);
  const cleanedObjects = applyRoomObjectsSafetyNet(
    archived.objects,
    priorObjectsForTile,
    pinnedNames
  );
  const placeObjects = { ...stack.placeObjects, [finalKey]: cleanedObjects };
```

Then update the `newStack` literal to include `placeObjects`:

```ts
  const newStack: WorldStack = {
    entries: archived.entries,
    threads: archived.threads,
    turn: archived.turn,
    position: finalPosition,
    places,
    objectives: newObjectives,
    presetSlug: stack.presetSlug,
    attributes: stack.attributes,
    placeObjects,
  };
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: all pass. If any `src/server.test.ts` test builds a `WorldStack` literal that was missed in the Task 2 sweep, add `placeObjects: {}` and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): apply room-state safety net + persist placeObjects per turn"
```

---

### Task 11: Manual integration verification

Manual smoke check. No code changes. Record results in the commit message for the implementer's run.

- [ ] **Step 1: Start the dev server**

Run: `bun run src/main.ts` (or whatever start command `package.json` lists — verify with `grep -A2 \"scripts\" package.json`).

- [ ] **Step 2: Load a preset, navigate to a room with a candle or similar lit fixture**

Use the web UI to start a session. Take a turn that introduces a candle (or use a preset that has one).

- [ ] **Step 3: Snuff the candle**

Type `snuff the candle` (or `blow out the candle`). The narrator should describe the candle going out.

- [ ] **Step 4: Inspect the next archivist output**

Open `world-stack.json` or use the debug trace. Verify `placeObjects["<currentPosKey>"]` has the candle with `states: ["snuffed"]`.

- [ ] **Step 5: Look around / wait one turn**

Type `look around`. Narrator should NOT relight the candle. The narrative must be consistent with `states: ["snuffed"]`.

- [ ] **Step 6: Walk three tiles away, then return**

Move north, north, north, then south, south, south. On return, verify:
- `world-stack.json` still has the snuffed-candle entry at the original tile.
- Narrator's prose on the return turn keeps the candle snuffed.

- [ ] **Step 7: Cap stress (optional)**

Type a turn that introduces an 11th object into a busy room. Verify in `world-stack.json` that the cap held at 10 and a low-priority feature was dropped, not a fixture/item.

- [ ] **Step 8: Record results**

If all checks pass, commit a final marker:

```bash
git commit --allow-empty -m "chore(room-state): manual integration verified — snuff persists, returns survive, cap holds"
```

If a check fails, file the failure as a follow-up bug (don't shoehorn fixes into this plan — the design accounts for prompt-driven failure modes that may need separate iteration).
