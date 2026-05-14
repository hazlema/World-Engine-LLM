# Player Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let preset authors declare immutable player attributes (species, descriptors, scope-bounded capabilities) via hierarchical bullets in preset frontmatter, injected into the narrator, archivist, and image-generator prompts each turn.

**Architecture:** Preset frontmatter gets a new optional `attributes:` field with hierarchical bullets. Parser is extended to track indent depth. Parsed `PlayerAttribute[]` lives on `WorldStack` (loaded from preset at session start, frozen for the session, persisted to `world-stack.json`). Three formatters inject the attributes into prompts: narrator and archivist (full block via `formatStackForNarrator/Archivist`), and image generator (an "apply only if player figure appears in frame" block in the constructed prompt).

**Tech Stack:** TypeScript, Bun runtime, `bun:test`. No new dependencies. Mirrors existing test patterns in `presets.test.ts`, `stack.test.ts`, `engine.test.ts`.

**Spec reference:** `docs/superpowers/specs/2026-05-14-player-attributes-design.md`

---

## Task 1: Parser — `PlayerAttribute` type, hierarchical-bullet support, validation

**Files:**
- Modify: `src/presets.ts` (add type, extend parser, add field to `Preset`)
- Modify: `src/presets.test.ts` (append new tests)

This task adds `PlayerAttribute`, extends `parseFrontmatter` to support 4-space sub-bullets under the `attributes:` list, validates length caps, and exposes the new `attributes` field on `Preset`. All other lists (`objects`, `objectives`) continue to reject sub-bullets.

- [ ] **Step 1: Write the failing parser tests**

Append to `src/presets.test.ts`:

```typescript
test("parsePresetText: parses attributes with hierarchical bullets", () => {
  const text = `---
title: T
description: D
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - magic
    - can manipulate objects
    - cannot manipulate time
objects:
  - oak staff
objectives:
  - do something
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([
    { name: "normal human abilities", scope: ["cannot lie"] },
    { name: "tattoo of a dove on left shoulder", scope: [] },
    { name: "magic", scope: ["can manipulate objects", "cannot manipulate time"] },
  ]);
});

test("parsePresetText: missing attributes field defaults to []", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([]);
});

test("parsePresetText: empty attributes header defaults to []", () => {
  const text = `---
title: T
description: D
attributes:
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([]);
});

test("parsePresetText: bare top-level attribute has empty scope", () => {
  const text = `---
title: T
description: D
attributes:
  - red hair
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([{ name: "red hair", scope: [] }]);
});

test("parsePresetText: throws when sub-bullet appears under objects:", () => {
  const text = `---
title: T
description: D
objects:
  - candle
    - melted
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when sub-bullet appears under objectives:", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - find it
    - in the corner
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when sub-bullet appears with no parent attribute", () => {
  const text = `---
title: T
description: D
attributes:
    - orphan sub-bullet
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when an attribute name exceeds 80 chars", () => {
  const longName = "x".repeat(81);
  const text = `---
title: T
description: D
attributes:
  - ${longName}
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/80/);
});

test("parsePresetText: throws when an attribute has more than 10 sub-bullets", () => {
  const subs = Array.from({ length: 11 }, (_, i) => `    - sub ${i}`).join("\n");
  const text = `---
title: T
description: D
attributes:
  - magic
${subs}
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/10 sub-bullets/);
});

test("parsePresetText: throws on empty attribute name", () => {
  const text = `---
title: T
description: D
attributes:
  - 
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/presets.test.ts`
Expected: 10 new tests FAIL — `p.attributes` is undefined; the existing parser doesn't recognize sub-bullets.

- [ ] **Step 3: Add `PlayerAttribute` type and extend `Preset`**

In `src/presets.ts`, near the top of the file (after the existing `import` and before the existing `PresetObjective` interface), add:

```typescript
export interface PlayerAttribute {
  name: string;
  scope: string[];   // sub-bullets in order; empty when no sub-bullets
}
```

Then extend the `Preset` interface to include the new field:

```typescript
export interface Preset {
  slug: string;
  title: string;
  description: string;
  objects: string[];
  objectives: PresetObjective[];
  attributes: PlayerAttribute[];   // empty array when no attributes: header
  body: string;
}
```

- [ ] **Step 4: Replace `parseFrontmatter` with the indent-aware version**

In `src/presets.ts`, replace the entire existing `parseFrontmatter` function (lines 64-100) with:

```typescript
function parseFrontmatter(
  text: string,
  slug: string
): { strings: Record<string, string>; lists: Record<string, string[]>; attributes: PlayerAttribute[] } {
  const strings: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const attributes: PlayerAttribute[] = [];
  const lines = text.split(/\r?\n/);

  let currentList: string | null = null;
  let inAttributesMode = false;
  let currentAttribute: PlayerAttribute | null = null;

  for (const line of lines) {
    if (line.trim() === "") {
      currentList = null;
      inAttributesMode = false;
      currentAttribute = null;
      continue;
    }

    // Sub-bullet (4-space indent). Valid only inside attributes mode under a top-level bullet.
    const subItem = line.match(/^    -\s+(.*)$/);
    if (subItem) {
      if (!inAttributesMode || !currentAttribute) {
        throw new Error(`Preset ${slug}: sub-bullet not allowed here: ${line}`);
      }
      const text = subItem[1].trim();
      if (!text) throw new Error(`Preset ${slug}: empty sub-bullet at line: ${line}`);
      currentAttribute.scope.push(text);
      if (currentAttribute.scope.length > 10) {
        throw new Error(
          `Preset ${slug}: more than 10 sub-bullets under attribute "${currentAttribute.name}"`
        );
      }
      continue;
    }

    // Top-level bullet (2-space indent).
    const listItem = line.match(/^  -\s+(.*)$/);
    if (listItem && currentList) {
      const text = listItem[1].trim();
      if (!text) throw new Error(`Preset ${slug}: empty bullet at line: ${line}`);
      if (inAttributesMode) {
        if (text.length > 80) {
          throw new Error(`Preset ${slug}: attribute name exceeds 80 chars: ${line}`);
        }
        currentAttribute = { name: text, scope: [] };
        attributes.push(currentAttribute);
      } else {
        lists[currentList].push(text);
      }
      continue;
    }

    // Key-value (scalar or list header).
    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (keyValue) {
      const [, key, rest] = keyValue;
      const value = rest.trim();
      if (value === "") {
        // List header.
        if (key === "attributes") {
          inAttributesMode = true;
          currentList = key;          // bookkeeping; attributes go into the separate array
          currentAttribute = null;
        } else {
          inAttributesMode = false;
          lists[key] = [];
          currentList = key;
          currentAttribute = null;
        }
      } else {
        strings[key] = value;
        currentList = null;
        inAttributesMode = false;
        currentAttribute = null;
      }
      continue;
    }

    throw new Error(`Preset ${slug}: malformed frontmatter line: ${line}`);
  }

  return { strings, lists, attributes };
}
```

- [ ] **Step 5: Update `parsePresetText` to surface the new field**

In `src/presets.ts`, modify the return statement at the end of `parsePresetText` (currently lines 48-55) to include the attributes:

```typescript
  return {
    slug,
    title: fields.strings.title!,
    description: fields.strings.description!,
    objects: fields.lists.objects!,
    objectives,
    attributes: fields.attributes,
    body,
  };
```

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test src/presets.test.ts`
Expected: All tests PASS (10 new + the existing presets.test.ts tests).

- [ ] **Step 7: Verify type check is clean**

Run: `bunx tsc --noEmit 2>&1 | grep -E "(presets|stack|engine)\.ts" | head -10`
Expected: No new errors in `src/presets.ts`. Pre-existing errors in test files (api.test.ts, etc.) are out of scope. There may be NEW errors in `src/stack.ts` and `src/engine.test.ts` because `WorldStack`-related fixtures don't yet have `attributes` — that's fine, Task 2 fixes those.

- [ ] **Step 8: Commit**

```bash
git add src/presets.ts src/presets.test.ts
git commit -m "feat(presets): hierarchical-bullet attributes in frontmatter"
```

---

## Task 2: WorldStack persistence — add `attributes` field

**Files:**
- Modify: `src/stack.ts` (`WorldStack`, `emptyStack`, `parseStackData`, `applyPresetToStack`)
- Modify: `src/stack.test.ts` (append tests)
- Modify: `src/engine.test.ts` (update fixtures to include `attributes: []`)

This task adds `attributes: PlayerAttribute[]` to `WorldStack`, copies preset attributes onto the stack at session start, defaults to `[]` for old `world-stack.json` files lacking the field, and updates in-memory test fixtures so the suite stays green.

- [ ] **Step 1: Write the failing stack tests**

Append to `src/stack.test.ts`:

```typescript
import type { Preset, PlayerAttribute } from "./presets";

test("applyPresetToStack: copies preset.attributes onto the new stack", () => {
  const preset: Preset = {
    slug: "test",
    title: "T",
    description: "D",
    objects: [],
    objectives: [],
    attributes: [
      { name: "magic", scope: ["can manipulate objects"] },
      { name: "red hair", scope: [] },
    ],
    body: "body",
  };
  const stack = applyPresetToStack(preset);
  expect(stack.attributes).toEqual([
    { name: "magic", scope: ["can manipulate objects"] },
    { name: "red hair", scope: [] },
  ]);
});

test("parseStackData: preserves attributes through JSON round-trip", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [{ name: "magic", scope: ["can manipulate objects"] }],
  };
  const json = JSON.stringify(stack);
  const reparsed = parseStackData(JSON.parse(json));
  expect(reparsed?.attributes).toEqual([{ name: "magic", scope: ["can manipulate objects"] }]);
});

test("parseStackData: defaults attributes to [] when field is missing (old stack file)", () => {
  const oldShape = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    // no attributes field
  };
  const parsed = parseStackData(oldShape);
  expect(parsed?.attributes).toEqual([]);
});

test("parseStackData: defaults attributes to [] when field is malformed", () => {
  const badShape = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: "not an array",
  };
  const parsed = parseStackData(badShape);
  expect(parsed?.attributes).toEqual([]);
});
```

Note: import `Preset, PlayerAttribute` from `./presets` (these are already type-exported from Task 1). Adjust the import line at the top of `src/stack.test.ts` accordingly if it doesn't already import from `./presets`.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/stack.test.ts`
Expected: 4 new tests FAIL — `stack.attributes` doesn't exist on the WorldStack type yet.

- [ ] **Step 3: Add `attributes` to `WorldStack` and supporting code**

In `src/stack.ts`, modify the `WorldStack` interface (lines 16-24) to add the new field:

```typescript
export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
  objectives: Objective[];
  presetSlug: string | null;
  attributes: PlayerAttribute[];
}
```

Update the import at the top of `src/stack.ts` (currently `import type { Preset } from "./presets";`) to also import `PlayerAttribute`:

```typescript
import type { Preset, PlayerAttribute } from "./presets";
```

Update `emptyStack` (lines 89-99) to include the new field:

```typescript
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
  };
}
```

Update `parseStackData` to read the new field. Add this just before the `presetSlug` parsing block (around line 145):

```typescript
  const attributes: PlayerAttribute[] = Array.isArray(data.attributes)
    ? data.attributes
        .filter(
          (a: any) =>
            a &&
            typeof a === "object" &&
            typeof a.name === "string" &&
            Array.isArray(a.scope) &&
            a.scope.every((s: any) => typeof s === "string")
        )
        .map((a: any) => ({ name: a.name, scope: [...a.scope] }))
    : [];
```

And include it in the return object (the existing return at line 148):

```typescript
  return {
    entries: data.entries,
    threads: Array.isArray(data.threads) ? data.threads : [],
    turn: data.turn,
    position,
    places,
    objectives,
    presetSlug,
    attributes,
  };
```

Update `applyPresetToStack` (around line 305) to copy the field. Find it and modify the return object:

```typescript
export function applyPresetToStack(preset: Preset): WorldStack {
  return {
    entries: [...preset.objects],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: preset.objectives.map((o) => ({
      text: o.text,
      achieved: false,
      ...(o.position ? { position: o.position } : {}),
    })),
    presetSlug: preset.slug,
    attributes: [...preset.attributes],
  };
}
```

(If the existing `applyPresetToStack` body looks slightly different, preserve its existing structure — only add the `attributes: [...preset.attributes],` line.)

- [ ] **Step 4: Update test fixtures in `src/engine.test.ts`**

The `WorldStack` interface now requires `attributes`. Find the in-memory fixtures at the top of `src/engine.test.ts` (around lines 14-23 and 25-36) and add `attributes: []` to each.

For `emptyStack` (line 14):
```typescript
const emptyStack: WorldStack = { entries: [] as string[], threads: [] as string[], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [] };
```

For `populatedStack` (line 15):
```typescript
const populatedStack: WorldStack = {
  entries: ["world is cold", "crow watches"],
  threads: ["find the watcher"],
  turn: 2,
  position: [0, 0] as [number, number],
  places: {},
  objectives: [],
  presetSlug: null,
  attributes: [],
};
```

For `makeStack` (line 25):
```typescript
function makeStack(overrides: Partial<WorldStack> = {}): WorldStack {
  return {
    entries: ["a rusted key lies on the floor here"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: { "0,0": "a stone cellar with damp walls" },
    objectives: [{ text: "Find the rusted key", achieved: false, position: [0, 0] }],
    presetSlug: null,
    attributes: [],
    ...overrides,
  };
}
```

Then grep the rest of `src/engine.test.ts` and `src/stack.test.ts` for any other inline `WorldStack`-typed fixtures and add `attributes: []` to each.

Run: `grep -n "presetSlug: null" src/engine.test.ts src/stack.test.ts src/server.test.ts`

For each match, verify that line is followed (after closing `}`) by a fixture that needs the field. Add `attributes: []` adjacent to `presetSlug: null` in each.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: All tests PASS, including the 4 new stack tests. Total count should be the prior baseline + 4.

- [ ] **Step 6: Verify type check**

Run: `bunx tsc --noEmit 2>&1 | grep -E "(presets|stack|engine|server)\.ts" | head -10`
Expected: No errors in production files. If any test file complains about a missing `attributes` field, find that file and add `attributes: []` to the offending fixture.

- [ ] **Step 7: Commit**

```bash
git add src/stack.ts src/stack.test.ts src/engine.test.ts src/server.test.ts
git commit -m "feat(stack): WorldStack.attributes loaded from preset, persisted, defaults to []"
```

---

## Task 3: Prompt injection — narrator + archivist sections, system-prompt rules

**Files:**
- Modify: `src/stack.ts` (`formatStackForNarrator`, `formatStackForArchivist`, add helper)
- Modify: `src/engine.ts` (`NARRATOR_SYSTEM` line revision, `ARCHIVIST_SYSTEM` new rule)
- Modify: `src/stack.test.ts` (append formatter tests)
- Modify: `src/engine.test.ts` (append snapshot test for narrator user message)

This task injects the `PLAYER ATTRIBUTES (immutable):` section as the first part of both formatters when populated, omits it when empty, and updates the system prompts to honor the section.

- [ ] **Step 1: Write the failing formatter tests**

Append to `src/stack.test.ts`:

```typescript
test("formatStackForNarrator: includes PLAYER ATTRIBUTES as the first section when populated", () => {
  const stack: WorldStack = {
    entries: ["dusty bookshelf"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [
      { name: "magic", scope: ["can manipulate objects", "cannot manipulate time"] },
      { name: "red hair", scope: [] },
    ],
  };
  const out = formatStackForNarrator(stack, "you wake in a study");
  // Section appears first.
  const attrIdx = out.indexOf("PLAYER ATTRIBUTES (immutable):");
  const briefingIdx = out.indexOf("MISSION BRIEFING");
  expect(attrIdx).toBeGreaterThanOrEqual(0);
  expect(briefingIdx).toBeGreaterThan(attrIdx);
  // Format check: top-level dash, sub-bullet 2-space indent.
  expect(out).toContain("- magic");
  expect(out).toContain("  - can manipulate objects");
  expect(out).toContain("  - cannot manipulate time");
  expect(out).toContain("- red hair");
});

test("formatStackForNarrator: omits PLAYER ATTRIBUTES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  const out = formatStackForNarrator(stack, "premise");
  expect(out).not.toContain("PLAYER ATTRIBUTES");
});

test("formatStackForArchivist: includes PLAYER ATTRIBUTES section when populated", () => {
  const stack: WorldStack = {
    entries: ["a key on the table"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [{ name: "wizard", scope: ["can read minds"] }],
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("PLAYER ATTRIBUTES (immutable):");
  expect(out).toContain("- wizard");
  expect(out).toContain("  - can read minds");
});

test("formatStackForArchivist: omits PLAYER ATTRIBUTES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("PLAYER ATTRIBUTES");
});
```

Append to `src/engine.test.ts`:

```typescript
test("narratorTurn: includes PLAYER ATTRIBUTES section in user message when stack has attributes", async () => {
  let capturedInput = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return "Something happens.";
  });
  const stack: WorldStack = {
    ...emptyStack,
    attributes: [{ name: "magic", scope: ["can manipulate objects"] }],
  };
  await narratorTurn(stack, "raise the candlestick with magic");
  expect(capturedInput).toContain("PLAYER ATTRIBUTES (immutable):");
  expect(capturedInput).toContain("- magic");
  expect(capturedInput).toContain("  - can manipulate objects");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/stack.test.ts src/engine.test.ts`
Expected: 5 new tests FAIL — formatters don't yet emit the section.

- [ ] **Step 3: Add the `formatPlayerAttributesBlock` helper**

In `src/stack.ts`, add this private helper near the other formatting helpers (e.g., right above `formatStackForNarrator`, around line 211):

```typescript
function formatPlayerAttributesBlock(attrs: PlayerAttribute[]): string | null {
  if (attrs.length === 0) return null;
  const lines: string[] = [];
  for (const a of attrs) {
    lines.push(`- ${a.name}`);
    for (const s of a.scope) {
      lines.push(`  - ${s}`);
    }
  }
  return `PLAYER ATTRIBUTES (immutable):\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Inject the section in `formatStackForNarrator`**

In `src/stack.ts`, modify the start of `formatStackForNarrator` (currently line 212-216) to prepend the attributes block:

```typescript
export function formatStackForNarrator(stack: WorldStack, briefing?: string): string {
  const parts: string[] = [];
  const attrBlock = formatPlayerAttributesBlock(stack.attributes);
  if (attrBlock) parts.push(attrBlock);
  if (briefing && briefing.trim().length > 0) {
    parts.push(`MISSION BRIEFING (durable premise):\n${briefing.trim()}`);
  }
  // ... rest of the function unchanged ...
```

(Leave everything from `let activeObjs: Objective[] = [];` onward exactly as it was.)

- [ ] **Step 5: Inject the section in `formatStackForArchivist`**

In `src/stack.ts`, modify `formatStackForArchivist` (around line 281) to prepend the attributes block. Replace the `parts` initialization:

```typescript
export function formatStackForArchivist(stack: WorldStack): string {
  const facts =
    stack.entries.length === 0
      ? "CURRENT STACK: (empty)"
      : `CURRENT STACK:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`;
  const threads =
    stack.threads.length === 0
      ? "ACTIVE THREADS: (none)"
      : `ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`;
  const attrBlock = formatPlayerAttributesBlock(stack.attributes);
  const parts: string[] = attrBlock ? [attrBlock, facts, threads] : [facts, threads];
  if (stack.objectives.length > 0) {
    // ... rest unchanged ...
```

(Leave the objectives block and the final return statement exactly as they were.)

- [ ] **Step 6: Update `NARRATOR_SYSTEM` rule on player capabilities**

In `src/engine.ts`, find the existing rule (currently around line 24):

```
- The player has the body of an ordinary mortal human. Flying, shapeshifting, teleporting, summoning, or any supernatural act does not happen unless an established entry explicitly grants that ability. Describe the futile attempt, the world's indifference, or the absurdity of their gesture.
```

Replace it with:

```
- When a `PLAYER ATTRIBUTES (immutable)` section is present in the input, those attributes are the player's true nature. Honor them: capabilities listed there work, descriptions listed there are visible facts about the player. **Sub-bullets scope the parent attribute** — judge each player action against the parent's scope. If the action fits the scope, depict success. If it falls outside the scope (or hits a `cannot` line), the action fails in-character (the magic fizzles, the limb won't bend, the attempt comes back wrong). **Absence is denial**: anything not granted by an attribute is not available. When no `PLAYER ATTRIBUTES` section is present, the player has the body of an ordinary mortal human and supernatural acts do not happen unless an established entry grants them. Describe futile attempts as the world's indifference or the absurdity of the gesture.
```

- [ ] **Step 7: Add the new `ARCHIVIST_SYSTEM` rule**

In `src/engine.ts`, find the lines at the top of `ARCHIVIST_SYSTEM` (currently around lines 57-62):

```
You are a world archivist. You extract facts AND active narrative threads from narrative passages.

Return a JSON object with two arrays:
- entries: short concrete facts about the world
- threads: open questions, goals, or unresolved hooks the player could pursue

Rules for entries:
```

Insert a new paragraph between the JSON-shape description and `Rules for entries:`:

```
You are a world archivist. You extract facts AND active narrative threads from narrative passages.

Return a JSON object with two arrays:
- entries: short concrete facts about the world
- threads: open questions, goals, or unresolved hooks the player could pursue

**Player attributes are immutable session data.** When you see a `PLAYER ATTRIBUTES (immutable)` section in the input, do NOT add entries that paraphrase or restate any attribute. Do NOT add entries describing the player's species, appearance, or innate capabilities — those are already canonical. Extract entries about the world and what changed in it; the player's identity is fixed.

Rules for entries:
```

- [ ] **Step 8: Run tests to verify pass**

Run: `bun test`
Expected: All tests PASS, including the 5 new ones from Step 1.

- [ ] **Step 9: Verify type check**

Run: `bunx tsc --noEmit 2>&1 | grep -E "(presets|stack|engine)\.ts" | head -5`
Expected: No new errors.

- [ ] **Step 10: Commit**

```bash
git add src/stack.ts src/engine.ts src/stack.test.ts src/engine.test.ts
git commit -m "feat(prompts): inject PLAYER ATTRIBUTES section + system-prompt rules"
```

---

## Task 4: Image generator — `playerAttributes` parameter + server wiring

**Files:**
- Modify: `src/gemini-image.ts` (extract `buildImagePrompt`, add `playerAttributes?` param)
- Modify: `src/server.ts` (pass `currentStack.attributes` to `generateImage`)
- Create: `src/gemini-image.test.ts`

This task extracts the prompt construction into a pure function so it can be tested without invoking the real Gemini SDK. The new optional `playerAttributes` parameter, when populated, adds a "Player character details (apply only if the player figure appears in frame)" block to the prompt.

- [ ] **Step 1: Write the failing image-prompt tests**

Create `src/gemini-image.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import { buildImagePrompt, DEFAULT_IMAGE_STYLE } from "./gemini-image";
import type { PlayerAttribute } from "./presets";

describe("buildImagePrompt", () => {
  test("with no playerAttributes: omits the Player character details block", () => {
    const prompt = buildImagePrompt("A scene unfolds.", DEFAULT_IMAGE_STYLE);
    expect(prompt).not.toContain("Player character details");
    expect(prompt).toContain("Scene:");
    expect(prompt).toContain("A scene unfolds.");
  });

  test("with empty playerAttributes array: omits the Player character details block", () => {
    const prompt = buildImagePrompt("A scene unfolds.", DEFAULT_IMAGE_STYLE, []);
    expect(prompt).not.toContain("Player character details");
  });

  test("with populated playerAttributes: includes the block before Scene", () => {
    const attrs: PlayerAttribute[] = [
      { name: "striking auburn hair in a ponytail", scope: [] },
      { name: "tattoo of a dove on left shoulder", scope: [] },
      { name: "magic", scope: ["can manipulate objects"] },
    ];
    const prompt = buildImagePrompt("She raises her hand; the lock clicks.", DEFAULT_IMAGE_STYLE, attrs);
    const detailsIdx = prompt.indexOf("Player character details (apply only if the player figure appears in frame):");
    const sceneIdx = prompt.indexOf("Scene:");
    expect(detailsIdx).toBeGreaterThanOrEqual(0);
    expect(sceneIdx).toBeGreaterThan(detailsIdx);
    expect(prompt).toContain("- striking auburn hair in a ponytail");
    expect(prompt).toContain("- tattoo of a dove on left shoulder");
    expect(prompt).toContain("- magic");
    expect(prompt).toContain("  - can manipulate objects");
  });

  test("preserves the existing 'Render this scene as a cinematic 21:9 ultrawide image.' opener", () => {
    const prompt = buildImagePrompt("X.", DEFAULT_IMAGE_STYLE);
    expect(prompt.startsWith("Render this scene as a cinematic 21:9 ultrawide image.")).toBe(true);
  });

  test("preserves the 'No text, captions, or watermarks.' rule", () => {
    const prompt = buildImagePrompt("X.", DEFAULT_IMAGE_STYLE);
    expect(prompt).toContain("No text, captions, or watermarks.");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/gemini-image.test.ts`
Expected: All tests FAIL — `buildImagePrompt` is not exported from `./gemini-image`.

- [ ] **Step 3: Refactor `gemini-image.ts` — extract `buildImagePrompt`, add the parameter**

Replace the entire body of `src/gemini-image.ts` with:

```typescript
import { GoogleGenAI, Modality } from "@google/genai";
import type { PlayerAttribute } from "./presets";

const IMAGE_MODEL = "gemini-2.5-flash-image";

export const IMAGE_STYLES = ["cinematic", "painterly", "noir", "photoreal", "anime"] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];
export const DEFAULT_IMAGE_STYLE: ImageStyle = "cinematic";

const STYLE_DESCRIPTIONS: Record<ImageStyle, string> = {
  cinematic:  "Atmospheric, moody, painterly. Cinematic lighting and composition.",
  painterly:  "Oil painting style. Visible brushstrokes. Rich textured colors.",
  noir:       "Black and white. High contrast. Film noir, deep shadows, dramatic lighting.",
  photoreal:  "Photorealistic. Natural lighting. High detail, sharp focus.",
  anime:      "Anime / cel-shaded illustration. Bold linework. Saturated palette.",
};

export function buildImagePrompt(
  narrative: string,
  style: ImageStyle = DEFAULT_IMAGE_STYLE,
  playerAttributes?: PlayerAttribute[],
): string {
  const styleDescription = STYLE_DESCRIPTIONS[style] ?? STYLE_DESCRIPTIONS[DEFAULT_IMAGE_STYLE];
  const parts: string[] = [
    "Render this scene as a cinematic 21:9 ultrawide image.",
    `Style: ${styleDescription}`,
    "No text, captions, or watermarks.",
  ];
  if (playerAttributes && playerAttributes.length > 0) {
    const attrLines: string[] = [];
    for (const a of playerAttributes) {
      attrLines.push(`- ${a.name}`);
      for (const s of a.scope) {
        attrLines.push(`  - ${s}`);
      }
    }
    parts.push("");
    parts.push("Player character details (apply only if the player figure appears in frame):");
    parts.push(...attrLines);
  }
  parts.push("");
  parts.push("Scene:");
  parts.push(narrative);
  return parts.join("\n");
}

export async function generateImage(
  narrative: string,
  style: ImageStyle = DEFAULT_IMAGE_STYLE,
  playerAttributes?: PlayerAttribute[],
): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });
  const prompt = buildImagePrompt(narrative, style, playerAttributes);

  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.IMAGE],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) return Buffer.from(data, "base64");
  }

  // Surface the textual response (often a refusal or safety block) so caller can log it.
  const textParts = parts.map((p) => p.text).filter(Boolean).join(" ");
  throw new Error(`no image in response${textParts ? `: ${textParts.slice(0, 200)}` : ""}`);
}
```

- [ ] **Step 4: Wire attributes through in `src/server.ts`**

Find the `/api/image` handler (around line 519). The current call is:

```typescript
const png = await generateImage(text, style);
```

Replace with:

```typescript
const png = await generateImage(text, style, currentStack.attributes);
```

(The `currentStack` module-level variable is already in scope — line 368.)

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/gemini-image.test.ts`
Expected: All 5 tests PASS.

Run: `bun test`
Expected: Full suite still passes (no regressions).

- [ ] **Step 6: Verify type check**

Run: `bunx tsc --noEmit 2>&1 | grep -E "gemini-image|server\.ts" | head -5`
Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add src/gemini-image.ts src/server.ts src/gemini-image.test.ts
git commit -m "feat(images): playerAttributes prompt block + server wiring"
```

---

## Task 5: Bundled preset + README documentation

**Files:**
- Create: `presets/merlin-trial.md`
- Modify: `README.md` (Stories / presets section)

This task ships an end-to-end demonstration preset and updates the README so users know the field exists.

- [ ] **Step 1: Create the bundled Merlin preset**

Create `presets/merlin-trial.md`:

```markdown
---
title: The Merlin Trial
description: A wizard's first labor — open the apprentice's chest before the candle burns out.
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - striking auburn hair in a ponytail
  - magic
    - can manipulate objects
    - cannot manipulate time
    - cannot harm living things
objects:
  - oak staff with copper bands at each end
  - apprentice's chest, brass-bound, lock plate inscribed with runes
  - candle on a brass holder, half its wax already pooled
objectives:
  - Open the apprentice's chest @ 0,0
---
You stand in the candlelit study of your master, who left an hour ago with no return promised. On the desk sits the chest he forbade you to open — and the candle he lit before leaving. When the candle gutters, the testing window closes. You have your staff, your magic, and what your hands can find in this room. The chest does not yield to ordinary force, and the inscriptions on the lock plate suggest the apprentice who opens it must do so in a way the master would approve.
```

- [ ] **Step 2: Add docs to README**

In `README.md`, find the line that currently closes the `### Stories / presets` subsection:

```
Drop a new `.md` in `presets/` and it'll appear on the title screen on the next page load.
```

Insert the new `#### Optional: player attributes` subsection IMMEDIATELY BEFORE that line, so it nests inside the existing `### Stories / presets` section (peer to but appearing before the "drop a new .md" closing sentence). The exact text to insert (note the `####` heading and a trailing blank line):

````markdown
#### Optional: player attributes

Presets can declare immutable player attributes — species, descriptors, scope-bounded capabilities — that the engine treats as canonical:

```yaml
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - magic
    - can manipulate objects
    - cannot manipulate time
```

Top-level bullets are attributes; sub-bullets (4-space indent) scope the parent. The narrator judges each player action against the scope — `magic / can manipulate objects` lets the player snap a tree limb but denies teleport. `cannot ...` bullets create hard limits even when the parent is permissive.

The first attribute is conventionally the player's species or class (`normal human abilities`, `vampire`, `crow`, `demon`). The narrator inherits common-sense expectations from the name. Sub-bullets refine: confirm specific powers, add restrictions, override defaults.

The field is optional. Presets without it behave exactly as before — the player is treated as an ordinary mortal human. See `presets/merlin-trial.md` for a full example.

````

- [ ] **Step 3: Verify the preset parses cleanly**

Run: `bun test src/presets.test.ts`
Expected: All tests pass. (Add an end-to-end test only if you want to harden — the existing tests already cover the parser shape; loading the bundled preset is exercised in `loadAllPresets`.)

Optionally, sanity-check by running the server and confirming the preset appears in the title screen:

```bash
bun --hot src/server.ts
```

Then open `http://localhost:3000` and verify "The Merlin Trial" appears in the preset list. (This is a manual smoke; not a required step.)

- [ ] **Step 4: Run the full suite + type check one more time**

Run: `bun test && bunx tsc --noEmit 2>&1 | grep -E "(presets|stack|engine|gemini-image|server)\.ts" | head -10`
Expected: All tests pass; no new errors in production files.

- [ ] **Step 5: Commit**

```bash
git add presets/merlin-trial.md README.md
git commit -m "docs(presets): bundled Merlin Trial example + README attributes section"
```

---

## Verification command

`bun test && bunx tsc --noEmit` after each commit.

## Self-Review Notes (planner, not part of execution)

**Spec coverage:**
- Preset format with hierarchical bullets → Task 1 (parser + tests).
- `PlayerAttribute` type and `Preset.attributes` field → Task 1.
- Validation (length cap, sub-bullet cap, sub-bullets only under `attributes:`, empty bullet rejection) → Task 1.
- Optional field with `[]` default when absent → Task 1.
- `WorldStack.attributes` field, persistence, `applyPresetToStack` → Task 2.
- Backward-compatible JSON loading → Task 2.
- `PLAYER ATTRIBUTES (immutable):` section in narrator + archivist prompts → Task 3.
- `NARRATOR_SYSTEM` line revision (sub-bullet scope, absence-is-denial, fallback when no section) → Task 3.
- `ARCHIVIST_SYSTEM` immutable-attributes rule → Task 3.
- Image generator integration (`buildImagePrompt` extraction, `playerAttributes?` parameter, "apply only if player figure appears in frame" block) → Task 4.
- Server wiring (`/api/image` passes `currentStack.attributes`) → Task 4.
- Bundled preset demonstrating end-to-end use → Task 5.
- README documentation → Task 5.

**Type consistency check:**
- `PlayerAttribute` defined in Task 1 (`src/presets.ts`), imported by Task 2 (`src/stack.ts`), Task 3 (`src/stack.ts` already has the type via Task 2's import), Task 4 (`src/gemini-image.ts`).
- `WorldStack.attributes` field name is consistent across all tasks.
- `formatPlayerAttributesBlock` signature consistent (`PlayerAttribute[] → string | null`) — used by both formatters.
- `generateImage` signature: `(narrative, style?, playerAttributes?)` — consistent across `gemini-image.ts` definition, server caller, and test fixtures.
- `buildImagePrompt` signature mirrors `generateImage` for the prompt-building portion.

**No circular imports:** `presets.ts` exports `PlayerAttribute`; `stack.ts` imports from `presets.ts`; `gemini-image.ts` imports `PlayerAttribute` from `presets.ts`. No cycles introduced.

**Out of scope (per spec, not in plan):**
- Empty World UI / saved-adventures dialog (separate v2 spec).
- `/character` command or briefing-card update (visibility comes via images per the user's choice).
- Mid-session attribute mutation.
- Provider-routed image generation (separate v2+ idea — see `project_idea_image_provider_routing` memory).
