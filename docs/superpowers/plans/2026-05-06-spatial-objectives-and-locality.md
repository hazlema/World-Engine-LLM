# Spatial Objectives & Locality Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make objective firing semantic (not literal), and tie objects/objectives to map coordinates so the player has to actually be there to interact or complete.

**Architecture:** Add a Manhattan distance helper and an optional `position` field to objectives. Partition objectives at prompt-formatting time into `ACTIVE` (no position OR at the player's current tile) versus `DISTANT` (positioned elsewhere). The narrator sees both lists under separate headers and gets a new plausibility rule restricting interaction to the current tile. The archivist sees indices flagged `[DISTANT]` and refuses to mark them complete, plus a semantic-matching rule with positive AND negative examples. Preset YAML gets an inline `@ x,y` suffix on objective lines for opt-in positioning; objectives without the suffix remain global (achievable anywhere) so existing presets keep working.

**Tech Stack:** Bun + TypeScript. `bun test` for the test suite. Edits live in `src/stack.ts`, `src/engine.ts`, `src/presets.ts`, `src/web/app.tsx`, and the preset markdown files in `presets/`.

---

## File Structure

**Modified:**
- `src/stack.ts` — add `manhattan()`, `position?: Position` on `Objective`, `partitionObjectivesByReach()`, update `formatStackForNarrator` and `formatStackForArchivist`, update `parseStackData` and `applyPresetToStack` to round-trip the new field
- `src/engine.ts` — extend `NARRATOR_SYSTEM` (locality + distant-objective rules) and `ARCHIVIST_SYSTEM` (semantic matching + `[DISTANT]` refusal)
- `src/presets.ts` — change `Preset.objectives` from `string[]` to `PresetObjective[]`; teach `parsePresetText` to strip an inline `@ x,y` suffix into a position
- `src/stack.test.ts`, `src/presets.test.ts` — extend coverage
- `src/web/app.tsx` — extend the local `Objective` type with optional `position` so the wire payload type-checks (no UI behavior change in this plan)
- `presets/cellar-of-glass.md`, `presets/lunar-rescue.md` — author edits to demonstrate spatial objectives

**Not modified:**
- `src/server.ts` — `Objective` is re-exported through `stack.ts`; no logic change needed
- `world-stack.json` — old saved games without `position` continue to load (the field is optional)
- The web UI rendering of objectives — distinct visual treatment for distant objectives is out of scope (note for follow-up)

---

### Task 1: Manhattan distance helper

**Files:**
- Modify: `src/stack.ts` (add export near `posKey` around line 32)
- Test: `src/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/stack.test.ts`:

```ts
import { manhattan } from "./stack";

test("manhattan: zero when positions match", () => {
  expect(manhattan([0, 0], [0, 0])).toBe(0);
  expect(manhattan([3, -2], [3, -2])).toBe(0);
});

test("manhattan: sum of cardinal step counts", () => {
  expect(manhattan([0, 0], [0, 1])).toBe(1);
  expect(manhattan([0, 0], [1, 0])).toBe(1);
  expect(manhattan([0, 0], [2, 3])).toBe(5);
  expect(manhattan([-1, -1], [1, 1])).toBe(4);
});

test("manhattan: symmetric", () => {
  expect(manhattan([5, 2], [-3, 4])).toBe(manhattan([-3, 4], [5, 2]));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/stack.test.ts`
Expected: FAIL with `manhattan` not exported.

- [ ] **Step 3: Implement `manhattan`**

In `src/stack.ts`, add directly below `posKey` (after line 34):

```ts
export function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/stack.test.ts`
Expected: PASS for the three new `manhattan` tests; pre-existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): add manhattan distance helper"
```

---

### Task 2: Add `position?` to Objective; round-trip through parse/apply

**Files:**
- Modify: `src/stack.ts:10-13` (Objective interface), `src/stack.ts:73-83` (parseStackData), `src/stack.ts:165-175` (applyPresetToStack), `src/stack.ts:177-190` (unionAchievedIndices preserve)
- Test: `src/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/stack.test.ts`:

```ts
test("Objective accepts an optional position", () => {
  const o: import("./stack").Objective = { text: "Open the chest", achieved: false, position: [2, 1] };
  expect(o.position).toEqual([2, 1]);
});

test("parseStackData: preserves objective position when valid", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "a", achieved: false, position: [3, -2] },
      { text: "b", achieved: false },
    ],
  });
  expect(parsed?.objectives).toEqual([
    { text: "a", achieved: false, position: [3, -2] },
    { text: "b", achieved: false },
  ]);
});

test("parseStackData: drops malformed position (wrong shape) but keeps objective", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "a", achieved: false, position: [1, "x"] },
      { text: "b", achieved: false, position: "nope" },
      { text: "c", achieved: false, position: [1, 2, 3] },
    ],
  });
  expect(parsed?.objectives).toEqual([
    { text: "a", achieved: false },
    { text: "b", achieved: false },
    { text: "c", achieved: false },
  ]);
});

test("unionAchievedIndices: preserves position when flipping achieved", () => {
  const before = [
    { text: "a", achieved: false, position: [1, 1] as [number, number] },
    { text: "b", achieved: false },
  ];
  const after = unionAchievedIndices(before, [0]);
  expect(after).toEqual([
    { text: "a", achieved: true, position: [1, 1] },
    { text: "b", achieved: false },
  ]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/stack.test.ts`
Expected: FAILs on the new tests (position not stored / not preserved).

- [ ] **Step 3: Update `Objective` interface**

Replace `src/stack.ts:10-13`:

```ts
export interface Objective {
  text: string;
  achieved: boolean;
  position?: Position;
}
```

- [ ] **Step 4: Update `parseStackData` to validate and preserve position**

Replace the objectives parsing block at `src/stack.ts:73-83` with:

```ts
  const objectives: Objective[] = Array.isArray(data.objectives)
    ? data.objectives
        .filter(
          (o: any) =>
            o &&
            typeof o === "object" &&
            typeof o.text === "string" &&
            typeof o.achieved === "boolean"
        )
        .map((o: any) => {
          const base: Objective = { text: o.text, achieved: o.achieved };
          if (
            Array.isArray(o.position) &&
            o.position.length === 2 &&
            typeof o.position[0] === "number" &&
            typeof o.position[1] === "number"
          ) {
            base.position = [o.position[0], o.position[1]];
          }
          return base;
        })
    : [];
```

- [ ] **Step 5: Update `unionAchievedIndices` to preserve `position`**

The existing spread `{ ...o }` already copies `position` because it's an own enumerable property. Verify by re-reading `src/stack.ts:177-190` — no edit needed unless the test still fails. If it does, change the flip branch to `{ ...o, achieved: true }` (already that shape) and confirm.

- [ ] **Step 6: Run tests, verify they pass**

Run: `bun test src/stack.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): add optional position to Objective with parse round-trip"
```

---

### Task 3: Preset objective positions via inline `@ x,y` syntax

**Files:**
- Modify: `src/presets.ts:1-8` (Preset interface), `src/presets.ts:18-47` (parsePresetText), `src/presets.ts:49-85` (parseFrontmatter — no change needed; handled in parsePresetText)
- Modify: `src/stack.ts:165-175` (applyPresetToStack — map PresetObjective → Objective)
- Test: `src/presets.test.ts`, `src/stack.test.ts`

- [ ] **Step 1: Write failing preset-parser tests**

Append to `src/presets.test.ts`:

```ts
test("parsePresetText: parses positioned objective '@ x,y' suffix", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Open the chest @ 2,1
  - Find the journal @ -1,3
  - Escape the cellar
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Open the chest", position: [2, 1] },
    { text: "Find the journal", position: [-1, 3] },
    { text: "Escape the cellar" },
  ]);
});

test("parsePresetText: '@' inside the text without a coord pair is left alone", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Email the curator @ midnight
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Email the curator @ midnight" },
  ]);
});

test("parsePresetText: tolerates whitespace around the coord pair", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Find the key @  4 , -2
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Find the key", position: [4, -2] },
  ]);
});
```

Append to `src/stack.test.ts`:

```ts
test("applyPresetToStack: forwards objective position from preset", () => {
  const preset: Preset = {
    slug: "demo",
    title: "Demo",
    description: "test",
    objects: [],
    objectives: [
      { text: "Open chest", position: [1, 0] },
      { text: "Wander" },
    ],
    body: "body",
  };
  const s = applyPresetToStack(preset);
  expect(s.objectives).toEqual([
    { text: "Open chest", achieved: false, position: [1, 0] },
    { text: "Wander", achieved: false },
  ]);
});
```

Also fix the existing preset-shape used in `src/stack.test.ts` at lines 110-117 — `samplePreset.objectives` will need to change shape in Step 3 below; the existing assertion at lines 119-131 stays valid because applyPresetToStack output is still `Objective[]`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/presets.test.ts src/stack.test.ts`
Expected: FAIL — `Preset.objectives` is `string[]`; the parser doesn't extract `@`.

- [ ] **Step 3: Update Preset type and parser**

Replace `src/presets.ts:1-8`:

```ts
import type { Position } from "./stack";

export interface PresetObjective {
  text: string;
  position?: Position;
}

export interface Preset {
  slug: string;
  title: string;
  description: string;
  objects: string[];
  objectives: PresetObjective[];
  body: string;
}
```

Replace `src/presets.ts:18-47` (the body of `parsePresetText`) with:

```ts
export function parsePresetText(text: string, slug: string): Preset {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Preset ${slug}: missing frontmatter delimiters`);
  }
  const [, frontmatter, rawBody] = match;
  const fields = parseFrontmatter(frontmatter, slug);
  const body = rawBody.trim();

  for (const f of REQUIRED_STRING_FIELDS) {
    const v = fields.strings[f];
    if (!v) throw new Error(`Preset ${slug}: required field "${f}" is missing or empty`);
  }
  for (const f of REQUIRED_LIST_FIELDS) {
    const v = fields.lists[f];
    if (!v || v.length === 0) {
      throw new Error(`Preset ${slug}: required list "${f}" is missing or empty`);
    }
  }
  if (!body) throw new Error(`Preset ${slug}: body is empty`);

  const objectives: PresetObjective[] = fields.lists.objectives!.map(parseObjectiveLine);

  return {
    slug,
    title: fields.strings.title!,
    description: fields.strings.description!,
    objects: fields.lists.objects!,
    objectives,
    body,
  };
}

function parseObjectiveLine(raw: string): PresetObjective {
  const m = raw.match(/^(.*?)\s*@\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
  if (!m) return { text: raw };
  const [, text, x, y] = m;
  return { text: text.trim(), position: [Number(x), Number(y)] };
}
```

- [ ] **Step 4: Update `applyPresetToStack` for the new shape**

Replace `src/stack.ts:165-175`:

```ts
export function applyPresetToStack(preset: Preset): WorldStack {
  return {
    entries: [...preset.objects],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: preset.objectives.map((o) => {
      const obj: Objective = { text: o.text, achieved: false };
      if (o.position) obj.position = [o.position[0], o.position[1]];
      return obj;
    }),
    presetSlug: preset.slug,
  };
}
```

- [ ] **Step 5: Update the existing samplePreset literal in `src/stack.test.ts`**

In `src/stack.test.ts:110-117`, replace the body of `samplePreset`:

```ts
const samplePreset: Preset = {
  slug: "lunar-rescue",
  title: "Lunar Rescue",
  description: "test",
  objects: ["damaged transmitter", "oxygen cache"],
  objectives: [
    { text: "Find the transmitter" },
    { text: "Send the signal" },
  ],
  body: "You are an astronaut.",
};
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `bun test src/presets.test.ts src/stack.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/presets.ts src/stack.ts src/presets.test.ts src/stack.test.ts
git commit -m "feat(presets): parse '@ x,y' suffix as objective position"
```

---

### Task 4: `partitionObjectivesByReach` helper

**Files:**
- Modify: `src/stack.ts` (add export near `manhattan`)
- Test: `src/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/stack.test.ts`:

```ts
import { partitionObjectivesByReach } from "./stack";

test("partitionObjectivesByReach: positionless objectives are always active", () => {
  const obs = [
    { text: "global a", achieved: false },
    { text: "global b", achieved: true },
  ];
  const out = partitionObjectivesByReach(obs, [3, 4]);
  expect(out.active).toEqual([
    { obj: { text: "global a", achieved: false }, distance: null },
    { obj: { text: "global b", achieved: true }, distance: null },
  ]);
  expect(out.distant).toEqual([]);
});

test("partitionObjectivesByReach: positioned at current tile is active with distance 0", () => {
  const obs = [{ text: "open chest", achieved: false, position: [2, 1] as [number, number] }];
  const out = partitionObjectivesByReach(obs, [2, 1]);
  expect(out.active).toEqual([
    { obj: obs[0], distance: 0 },
  ]);
  expect(out.distant).toEqual([]);
});

test("partitionObjectivesByReach: positioned elsewhere is distant with manhattan distance", () => {
  const obs = [
    { text: "open chest", achieved: false, position: [2, 1] as [number, number] },
    { text: "find key", achieved: false, position: [-1, 0] as [number, number] },
  ];
  const out = partitionObjectivesByReach(obs, [0, 0]);
  expect(out.active).toEqual([]);
  expect(out.distant).toEqual([
    { obj: obs[0], distance: 3 },
    { obj: obs[1], distance: 1 },
  ]);
});

test("partitionObjectivesByReach: preserves original index for archivist mapping", () => {
  const obs = [
    { text: "a", achieved: false, position: [5, 5] as [number, number] },
    { text: "b", achieved: false },
    { text: "c", achieved: false, position: [0, 0] as [number, number] },
  ];
  const out = partitionObjectivesByReach(obs, [0, 0]);
  expect(out.active.map((e) => e.index)).toEqual([1, 2]);
  expect(out.distant.map((e) => e.index)).toEqual([0]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/stack.test.ts`
Expected: FAIL — `partitionObjectivesByReach` not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/stack.ts` directly after `manhattan` (so it's near its dependency):

```ts
export interface ReachEntry {
  obj: Objective;
  index: number;
  distance: number | null;
}

export function partitionObjectivesByReach(
  objectives: Objective[],
  here: Position
): { active: ReachEntry[]; distant: ReachEntry[] } {
  const active: ReachEntry[] = [];
  const distant: ReachEntry[] = [];
  objectives.forEach((obj, index) => {
    if (!obj.position) {
      active.push({ obj, index, distance: null });
      return;
    }
    const d = manhattan(here, obj.position);
    if (d === 0) {
      active.push({ obj, index, distance: 0 });
    } else {
      distant.push({ obj, index, distance: d });
    }
  });
  return { active, distant };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/stack.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): add partitionObjectivesByReach helper"
```

---

### Task 5: Use the partition in `formatStackForNarrator`

**Files:**
- Modify: `src/stack.ts:122-144`
- Test: `src/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/stack.test.ts`:

```ts
test("formatStackForNarrator: positionless objectives still render under OBJECTIVES (active this turn)", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the journal", achieved: false }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).not.toContain("DISTANT OBJECTIVES");
});

test("formatStackForNarrator: positioned objective at current tile is active", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [2, 1],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Open the chest");
  expect(out).not.toContain("DISTANT OBJECTIVES");
});

test("formatStackForNarrator: positioned objective elsewhere is distant with travel hint", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("DISTANT OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (3 moves away)");
  expect(out).not.toContain("OBJECTIVES (active this turn):");
});

test("formatStackForNarrator: mixed active and distant render in their own sections", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the journal", achieved: false },
      { text: "Open the chest", achieved: false, position: [1, 0] },
      { text: "Escape", achieved: false, position: [0, 0] },
    ],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).toContain("[ ] Escape");
  expect(out).toContain("DISTANT OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (1 move away)");
});
```

Also update the existing test at `src/stack.test.ts` for `formatStackForNarrator: renders OBJECTIVES checkboxes when objectives present` (around line 236): change the expected header from `OBJECTIVES:` to `OBJECTIVES (active this turn):`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/stack.test.ts`
Expected: FAIL on the new tests (header is still `OBJECTIVES:`, no distant section).

- [ ] **Step 3: Update `formatStackForNarrator`**

Replace `src/stack.ts:122-144`:

```ts
export function formatStackForNarrator(stack: WorldStack, briefing?: string): string {
  const parts: string[] = [];
  if (briefing && briefing.trim().length > 0) {
    parts.push(`MISSION BRIEFING (durable premise):\n${briefing.trim()}`);
  }
  if (stack.objectives.length > 0) {
    const { active, distant } = partitionObjectivesByReach(stack.objectives, stack.position);
    if (active.length > 0) {
      const lines = active.map(({ obj }) => `[${obj.achieved ? "x" : " "}] ${obj.text}`);
      parts.push(`OBJECTIVES (active this turn):\n${lines.join("\n")}`);
    }
    if (distant.length > 0) {
      const lines = distant.map(({ obj, distance }) => {
        const word = distance === 1 ? "move" : "moves";
        return `[${obj.achieved ? "x" : " "}] ${obj.text} (${distance} ${word} away)`;
      });
      parts.push(`DISTANT OBJECTIVES (require travel):\n${lines.join("\n")}`);
    }
  }
  const here = stack.places[posKey(stack.position)];
  if (here) {
    parts.push(`CURRENT LOCATION (canonical description):\n${here}`);
  }
  if (stack.entries.length > 0) {
    parts.push(`ESTABLISHED WORLD:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`);
  }
  if (stack.threads.length > 0) {
    parts.push(`ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/stack.test.ts`
Expected: all PASS (including the updated existing test).

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): split narrator objectives into active/distant by player tile"
```

---

### Task 6: Flag distant objectives in `formatStackForArchivist`

**Files:**
- Modify: `src/stack.ts:146-163`
- Test: `src/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/stack.test.ts`:

```ts
test("formatStackForArchivist: positionless objective shows no flag", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the journal", achieved: false }],
    presetSlug: null,
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Find the journal");
  expect(out).not.toContain("[DISTANT");
});

test("formatStackForArchivist: positioned-at-current-tile objective shows no flag", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [2, 1],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Open the chest");
  expect(out).not.toContain("[DISTANT");
});

test("formatStackForArchivist: positioned-elsewhere objective is flagged [DISTANT — cannot be completed this turn]", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Open the chest", achieved: false, position: [2, 1] },
      { text: "Find the journal", achieved: false },
    ],
    presetSlug: null,
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Open the chest [DISTANT — cannot be completed this turn]");
  expect(out).toContain("1: [ ] Find the journal");
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/stack.test.ts`
Expected: FAIL — `[DISTANT ...]` flag missing.

- [ ] **Step 3: Update `formatStackForArchivist`**

Replace `src/stack.ts:146-163`:

```ts
export function formatStackForArchivist(stack: WorldStack): string {
  const facts =
    stack.entries.length === 0
      ? "CURRENT STACK: (empty)"
      : `CURRENT STACK:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`;
  const threads =
    stack.threads.length === 0
      ? "ACTIVE THREADS: (none)"
      : `ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`;
  const parts = [facts, threads];
  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map((o, i) => {
      const status = o.achieved ? "x" : " ";
      const distantFlag =
        o.position && manhattan(stack.position, o.position) > 0
          ? " [DISTANT — cannot be completed this turn]"
          : "";
      return `${i}: [${status}] ${o.text}${distantFlag}`;
    });
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
  }
  return `${parts.join("\n\n")}\n\n`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/stack.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): flag distant objectives [DISTANT] for the archivist"
```

---

### Task 7: Locality + distant rules in `NARRATOR_SYSTEM`

**Files:**
- Modify: `src/engine.ts:21-29`

- [ ] **Step 1: Edit the prompt**

Replace `src/engine.ts:21-29` (the entire "Plausibility — non-negotiable" block + the OBJECTIVES bullet) with:

```ts
Plausibility — non-negotiable:
- Treat the player's input as INTENT or ATTEMPT, never as fact. Phrases like "I find a sword", "I turn into a wolf", "I am suddenly the king" describe what they try or claim — you decide what actually occurs.
- The player has the body of an ordinary mortal human. Flying, shapeshifting, teleporting, summoning, or any supernatural act does not happen unless an established entry explicitly grants that ability. Describe the futile attempt, the world's indifference, or the absurdity of their gesture.
- The player can only physically interact with elements present at their CURRENT LOCATION. Objects established in entries that belong to other tiles are out of reach until the player travels there. If the player tries to manipulate something not at their current tile, narrate the absence — they reach for nothing, the chest is in another room, the rover is across the crater. Pointing, watching, hearing, or shouting toward distant features is fine; touching, opening, taking, or using them is not.
- Physics, distance, and time apply. The player cannot cross continents in a step or skip ahead through narration. Out-of-scale actions resolve as small concrete movements within the immediate scene.
- Honor what is already established. Contradicting an entry (e.g. an "unarmed" player suddenly wielding a blade) does not happen unless the world supplies the means.
- If the input contains a "CURRENT LOCATION (canonical description)" section, the player is at that established location. Honor that description: do not contradict it, do not invent a different layout, do not reinvent its core features. Build on it — describe what changes or what the player notices on this visit, but the place itself is fixed.
- If the input contains a "MISSION BRIEFING (durable premise)" section, that is the durable premise of this run. Honor it. Do not contradict the setting (no trees on a lunar surface, no spacecraft in a medieval cellar). Build on it.
- If the input contains an "OBJECTIVES (active this turn)" section, those are concrete things the player is trying to accomplish AT THIS TILE. Do not list them at the player. Surface them through the world — what they encounter, what they notice — when their actions head that way. The player solves; you describe.
- If the input contains a "DISTANT OBJECTIVES (require travel)" section, those goals exist elsewhere on the map and the player must MOVE to reach them. Do not allow them to be completed this turn. You may hint at direction or atmosphere ("a faint signal pulses to the east"), but the act itself happens only when the player arrives.`;
```

(Note: the closing backtick stays on the last line — the existing template literal already ends here.)

- [ ] **Step 2: Verify the file still parses**

Run: `bun build src/engine.ts --target=bun --outfile=/tmp/engine-check.js && rm /tmp/engine-check.js`
Expected: no compile error.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: all PASS (no test directly asserts narrator prompt text).

- [ ] **Step 4: Commit**

```bash
git add src/engine.ts
git commit -m "feat(engine): narrator enforces current-tile interaction and distant-goal travel"
```

---

### Task 8: Semantic matching + `[DISTANT]` refusal in `ARCHIVIST_SYSTEM`

**Files:**
- Modify: `src/engine.ts:62-68`

- [ ] **Step 1: Edit the prompt**

Replace `src/engine.ts:62-68` (the `Rules for "achievedObjectiveIndices":` block) with:

```ts
Rules for "achievedObjectiveIndices":
- The OBJECTIVES list (if present) is shown with its indices: "0: [ ] Find the transmitter".
- Some objectives may carry the suffix "[DISTANT — cannot be completed this turn]". NEVER return their index, regardless of what the narrative says — the player is not at that tile.
- For non-distant objectives, judge completion SEMANTICALLY, not by literal phrasing. Match intent and outcome, not exact words.
- Examples that DO complete "open the iron-bound chest": "the heavy lid shifts and creaks open", "the latch yields, the lid swings up", "you pry the chest apart". Examples that DO NOT complete it: "you reach for the chest, but the lock holds firm", "you imagine the lid lifting", "the chest looms, untouched".
- A passage that depicts attempt-without-success, observation, or approach is NOT completion. Only a depicted, successful, accomplished action counts.
- When in doubt, return [].
- Do not invent indices outside the provided list. Return [] if no OBJECTIVES section is present.
```

- [ ] **Step 2: Verify the file still parses**

Run: `bun build src/engine.ts --target=bun --outfile=/tmp/engine-check.js && rm /tmp/engine-check.js`
Expected: no compile error.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/engine.ts
git commit -m "feat(engine): archivist matches objectives semantically and refuses distant indices"
```

---

### Task 9: Web `Objective` type accepts `position`

**Files:**
- Modify: `src/web/app.tsx:23`

- [ ] **Step 1: Update the type alias**

Replace `src/web/app.tsx:23`:

```tsx
type Position = [number, number];
type Objective = { text: string; achieved: boolean; position?: Position };
```

(If `Position` is already defined elsewhere in this file, skip the alias and just add `position?: [number, number]` inline on the Objective type.)

- [ ] **Step 2: Verify the bundle still builds**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/web-check.js && rm /tmp/web-check.js`
Expected: no type or build error.

- [ ] **Step 3: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): accept optional position on Objective payload"
```

---

### Task 10: Position objectives in the Cellar of Glass and Lunar Rescue presets

**Files:**
- Modify: `presets/cellar-of-glass.md:8-11`
- Modify: `presets/lunar-rescue.md:8-11`

- [ ] **Step 1: Update Cellar of Glass**

Replace `presets/cellar-of-glass.md:8-11`:

```yaml
objectives:
  - Find the locksmith's journal @ -1,0
  - Open the iron-bound chest @ 0,0
  - Escape the cellar before the candles burn out @ 0,1
```

Why these tiles: the chest sits at the start tile (`0,0`) where the player begins, the journal is one step west into a deeper alcove, the escape (stairs up) is one step east. Players will discover the layout through cardinal exploration; the briefing already mentions stairs and shattered jars so the geometry is consistent with the body text.

- [ ] **Step 2: Update Lunar Rescue**

Replace `presets/lunar-rescue.md:8-11`:

```yaml
objectives:
  - Find the transmitter @ 1,0
  - Restore power to the comm array @ 0,1
  - Send the distress signal @ 1,0
```

Why these tiles: transmitter and distress-signal share a tile (you signal from the transmitter). Comm-array power is one tile east of the lander — a separate site to traverse to. Lander remains at `0,0` so the player starts in the cabin.

- [ ] **Step 3: Sanity-check the parse**

Run: `bun test src/presets.test.ts`
Expected: PASS (existing tests untouched; no preset asserts on these specific files).

Optional manual sanity check:

```bash
bun -e 'import("./src/presets").then(async ({ loadAllPresets }) => { const m = await loadAllPresets(); for (const [k, p] of m) console.log(k, JSON.stringify(p.objectives)); })'
```

Expected: `cellar-of-glass` objectives carry positions `[-1,0]`, `[0,0]`, `[0,1]`; `lunar-rescue` carries `[1,0]`, `[0,1]`, `[1,0]`; `the-last-train` objectives stay positionless.

- [ ] **Step 4: Commit**

```bash
git add presets/cellar-of-glass.md presets/lunar-rescue.md
git commit -m "feat(presets): distribute Cellar of Glass and Lunar Rescue objectives across tiles"
```

---

### Task 11: Manual playtest — verify the three issues are fixed end-to-end

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite once more**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 2: Start the server**

Run: `bun src/server.ts`
Expected: piper ready, server listening, no startup errors.

- [ ] **Step 3: Verify Issue 1 (semantic objective matching)**

Open the web client, start a fresh **Cellar of Glass** game, and on the very first turn type `open the chest`. Confirm:

- Narrator describes the chest opening (the player IS at `0,0` where the chest lives, so this is allowed).
- The "Open the iron-bound chest" objective flips to checked in the right rail within one turn.

If the objective does not flip, examine the archivist's structured response in the server logs — the rule wording or examples may need iterating before declaring success.

- [ ] **Step 4: Verify Issue 2 (locality enforcement)**

In the same Cellar of Glass session, with the player still at `0,0`, type `open the journal` (the journal is at `-1,0`). Confirm:

- Narrator refuses, describes that the journal is not in reach, and does NOT mark the journal objective complete.

Then type `head west` to move to `-1,0`, then `read the journal`. Confirm:

- Narrator now describes the journal interaction successfully.
- Objective "Find the locksmith's journal" flips to checked.

- [ ] **Step 5: Verify Issue 3 (sector distribution forces traversal)**

Start a fresh **Lunar Rescue** game. Confirm at start:

- Briefing renders.
- The right rail shows three objectives.
- Narrator on the first turn does NOT immediately describe completing all three — the transmitter (at `1,0`) and comm array (at `0,1`) require eastward and northward travel respectively.

Move east, attempt the transmitter; move north, attempt the comm array. Confirm each fires only after the player arrives at the matching tile.

- [ ] **Step 6: If everything works, sign off**

Note results in chat. If any step misbehaves, capture the narrator output, the archivist's structured response (visible in server logs), and the current `world-stack.json` for diagnosis — most likely the prompt examples need an additional concrete pair, or the radius/position convention needs adjusting. Do NOT silently weaken the rules; surface the failure first.

- [ ] **Step 7: Final commit (if there are no code changes from this task, skip)**

If the playtest revealed nothing to change, this task ends without a commit.

---

## Out of scope (note for follow-up sessions)

- **Web UI distinct treatment for distant objectives.** The right rail currently renders all objectives uniformly. Greying out distant objectives or annotating them with `(elsewhere)` would help the player see which goals are local — but it requires UI design choices and is not blocking.
- **Briefing wording for positioned-objective presets.** The briefing currently does not hint at locations. Whether to add directional hints ("the comm array lies east of the lander") is a content-design call worth deciding before authoring more presets.
- **Procedural objective placement.** The current change makes positions explicit per preset. A separate plan could randomize objective positions across procedurally-generated sectors at session start for replayability.
