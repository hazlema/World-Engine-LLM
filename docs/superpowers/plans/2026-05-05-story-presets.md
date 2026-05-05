# Story Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players start each run from a chosen preset (or a random one) that seeds the world with a premise, in-world objects, and a list of pinned objectives. Win when every objective is achieved; offer "keep exploring" or "new game" afterward.

**Architecture:** Presets are markdown files in `presets/`. They seed a fresh `WorldStack` at run start (`objects` → `entries`, `objectives` → pinned `Objective[]`, body fed into the narrator's system context). The archivist returns `achievedObjectiveIndices: number[]` per turn; the server unions monotonically and computes win in code. The frontend swaps `reset` for two buttons (`new game`, `mission`) backed by one modal with three views (`select` / `briefing` / `win`).

**Tech Stack:** Bun (runtime, test, bundler), TypeScript, React 19, WebSockets via `Bun.serve`. No new dependencies; YAML frontmatter parsed with a small focused parser since the shape is fixed.

**Note on commits:** This repo is not currently a git repository. The commit steps below assume `git init` has been run; if not, skip the `git add` / `git commit` steps and treat each task boundary as a logical checkpoint.

---

## File Structure

**Create:**
- `presets/lunar-rescue.md` — bundled preset content
- `presets/cellar-of-glass.md` — bundled preset content
- `presets/the-last-train.md` — bundled preset content
- `src/presets.ts` — preset file format + loader (parsing, discovery, validation)
- `src/presets.test.ts` — preset loader tests

**Modify:**
- `src/stack.ts` — `Objective` type, `WorldStack` additions, `applyPresetToStack`, `unionAchievedIndices`, format helpers updated
- `src/stack.test.ts` — coverage for new helpers and format changes
- `src/engine.ts` — narrator + archivist system prompts and archivist schema
- `src/engine.test.ts` — coverage for new prompt sections and the new archivist field
- `src/server.ts` — preset cache, new client messages (`start`, `keep-exploring`), win detection, snapshot/stack-update extensions
- `src/server.test.ts` — coverage for new flows
- `src/web/app.tsx` — modal component (3 views), button rewiring, tick badges, protocol updates

**Out of scope for this plan:** preset editor UI, sharing/import flow, hidden-then-revealed objectives.

---

## Task 1: Preset file format and loader

**Files:**
- Create: `src/presets.ts`
- Create: `src/presets.test.ts`
- Test: `src/presets.test.ts`

The preset format is markdown with YAML-ish frontmatter. Since the schema is small and fixed (4 fields, two of which are simple string lists), we write a focused parser rather than pulling in a YAML dependency.

- [ ] **Step 1: Write failing tests for parsing**

Create `src/presets.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parsePresetText, presetSlugFromPath } from "./presets";

const SAMPLE = `---
title: Lunar Rescue
description: Stranded on the far side. Send the signal.
objects:
  - damaged transmitter half-buried in regolith
  - oxygen cache strapped to the lander hull
objectives:
  - Find the transmitter
  - Send the distress signal
---
You are an astronaut stranded on the lunar far side.
Your suit is functional.`;

test("parsePresetText: extracts title, description, objects, objectives, body", () => {
  const p = parsePresetText(SAMPLE, "lunar-rescue");
  expect(p.slug).toBe("lunar-rescue");
  expect(p.title).toBe("Lunar Rescue");
  expect(p.description).toBe("Stranded on the far side. Send the signal.");
  expect(p.objects).toEqual([
    "damaged transmitter half-buried in regolith",
    "oxygen cache strapped to the lander hull",
  ]);
  expect(p.objectives).toEqual([
    "Find the transmitter",
    "Send the distress signal",
  ]);
  expect(p.body).toBe(
    "You are an astronaut stranded on the lunar far side.\nYour suit is functional."
  );
});

test("parsePresetText: throws when frontmatter delimiters are missing", () => {
  expect(() => parsePresetText("no frontmatter here", "x")).toThrow(/frontmatter/);
});

test("parsePresetText: throws when a required field is missing", () => {
  const missingObjectives = `---
title: T
description: D
objects:
  - a
---
body`;
  expect(() => parsePresetText(missingObjectives, "x")).toThrow(/objectives/);
});

test("parsePresetText: throws when title is empty", () => {
  const empty = `---
title:
description: D
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(empty, "x")).toThrow(/title/);
});

test("parsePresetText: throws when a list field is empty", () => {
  const empty = `---
title: T
description: D
objects:
objectives:
  - o
---
body`;
  expect(() => parsePresetText(empty, "x")).toThrow(/objects/);
});

test("presetSlugFromPath: derives slug from a presets/*.md path", () => {
  expect(presetSlugFromPath("presets/lunar-rescue.md")).toBe("lunar-rescue");
  expect(presetSlugFromPath("./presets/the-last-train.md")).toBe("the-last-train");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/presets.test.ts`
Expected: FAIL — module `./presets` not found.

- [ ] **Step 3: Implement parser and discovery**

Create `src/presets.ts`:

```ts
export interface Preset {
  slug: string;
  title: string;
  description: string;
  objects: string[];
  objectives: string[];
  body: string;
}

export function presetSlugFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

const REQUIRED_STRING_FIELDS = ["title", "description"] as const;
const REQUIRED_LIST_FIELDS = ["objects", "objectives"] as const;

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

  return {
    slug,
    title: fields.strings.title!,
    description: fields.strings.description!,
    objects: fields.lists.objects!,
    objectives: fields.lists.objectives!,
    body,
  };
}

function parseFrontmatter(
  text: string,
  slug: string
): { strings: Record<string, string>; lists: Record<string, string[]> } {
  const strings: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const lines = text.split(/\r?\n/);

  let currentList: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") {
      currentList = null;
      continue;
    }
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      lists[currentList].push(listItem[1].trim());
      continue;
    }
    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (keyValue) {
      const [, key, rest] = keyValue;
      const value = rest.trim();
      if (value === "") {
        // List header (or empty scalar — caller's required-field check catches the latter).
        lists[key] = [];
        currentList = key;
      } else {
        strings[key] = value;
        currentList = null;
      }
      continue;
    }
    throw new Error(`Preset ${slug}: malformed frontmatter line: ${line}`);
  }
  return { strings, lists };
}

export async function loadAllPresets(dir = "presets"): Promise<Map<string, Preset>> {
  const out = new Map<string, Preset>();
  const glob = new Bun.Glob(`${dir}/*.md`);
  for await (const path of glob.scan(".")) {
    const slug = presetSlugFromPath(path);
    const text = await Bun.file(path).text();
    out.set(slug, parsePresetText(text, slug));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/presets.test.ts`
Expected: PASS — all six tests green.

- [ ] **Step 5: Commit**

```bash
git add src/presets.ts src/presets.test.ts
git commit -m "feat: preset file format and loader"
```

---

## Task 2: WorldStack data model — types, defaults, helpers

**Files:**
- Modify: `src/stack.ts`
- Test: `src/stack.test.ts`

Adds `Objective`, two new fields to `WorldStack`, `applyPresetToStack`, `unionAchievedIndices`. Format helpers come in Task 3.

- [ ] **Step 1: Write failing tests for new types and helpers**

Append to `src/stack.test.ts`:

```ts
import { applyPresetToStack, unionAchievedIndices, loadStack, type WorldStack } from "./stack";
import type { Preset } from "./presets";

const samplePreset: Preset = {
  slug: "lunar-rescue",
  title: "Lunar Rescue",
  description: "test",
  objects: ["damaged transmitter", "oxygen cache"],
  objectives: ["Find the transmitter", "Send the signal"],
  body: "You are an astronaut.",
};

test("applyPresetToStack: seeds entries from objects, objectives from objectives, sets slug", () => {
  const s = applyPresetToStack(samplePreset);
  expect(s.entries).toEqual(["damaged transmitter", "oxygen cache"]);
  expect(s.threads).toEqual([]);
  expect(s.turn).toBe(0);
  expect(s.position).toEqual([0, 0]);
  expect(s.places).toEqual({});
  expect(s.presetSlug).toBe("lunar-rescue");
  expect(s.objectives).toEqual([
    { text: "Find the transmitter", achieved: false },
    { text: "Send the signal", achieved: false },
  ]);
});

test("unionAchievedIndices: flips named indices to achieved", () => {
  const before = [
    { text: "a", achieved: false },
    { text: "b", achieved: false },
    { text: "c", achieved: false },
  ];
  const after = unionAchievedIndices(before, [1]);
  expect(after).toEqual([
    { text: "a", achieved: false },
    { text: "b", achieved: true },
    { text: "c", achieved: false },
  ]);
});

test("unionAchievedIndices: monotonic — already-achieved stays achieved when index not present", () => {
  const before = [
    { text: "a", achieved: true },
    { text: "b", achieved: false },
  ];
  const after = unionAchievedIndices(before, [1]);
  expect(after[0].achieved).toBe(true);
  expect(after[1].achieved).toBe(true);
});

test("unionAchievedIndices: ignores out-of-range and non-integer indices", () => {
  const before = [{ text: "a", achieved: false }];
  const after = unionAchievedIndices(before, [5, -1, 1.5 as unknown as number]);
  expect(after).toEqual([{ text: "a", achieved: false }]);
});

test("unionAchievedIndices: returns a new array (does not mutate input)", () => {
  const before = [{ text: "a", achieved: false }];
  const after = unionAchievedIndices(before, [0]);
  expect(before[0].achieved).toBe(false);
  expect(after[0].achieved).toBe(true);
});

test("loadStack: defaults objectives to [] and presetSlug to null when absent", async () => {
  // We can't easily mock Bun.file in-place; test the post-load shape using the
  // saved file fixture. This relies on STACK_FILE pointing at the repo's
  // world-stack.json which currently lacks the new fields.
  const s = await loadStack();
  expect(Array.isArray(s.objectives)).toBe(true);
  expect(s.objectives.length).toBe(0);
  expect(s.presetSlug).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/stack.test.ts`
Expected: FAIL — `applyPresetToStack` and `unionAchievedIndices` are not exported.

- [ ] **Step 3: Implement types and helpers**

Edit `src/stack.ts`. Add `import type { Preset }` near top, extend types, update `emptyStack`, `loadStack`, and add the two helpers:

```ts
import type { Preset } from "./presets";

export interface Objective {
  text: string;
  achieved: boolean;
}

export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
  objectives: Objective[];
  presetSlug: string | null;
}

function emptyStack(): WorldStack {
  return {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
}
```

In `loadStack`, extend the success branch to default the new fields when reading an older save:

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
      .map((o: any) => ({ text: o.text, achieved: o.achieved }))
  : [];
const presetSlug: string | null =
  typeof data.presetSlug === "string" ? data.presetSlug : null;

return {
  entries: data.entries,
  threads: Array.isArray(data.threads) ? data.threads : [],
  turn: data.turn,
  position,
  places,
  objectives,
  presetSlug,
};
```

Add the two helpers at the bottom of the file:

```ts
export function applyPresetToStack(preset: Preset): WorldStack {
  return {
    entries: [...preset.objects],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: preset.objectives.map((text) => ({ text, achieved: false })),
    presetSlug: preset.slug,
  };
}

export function unionAchievedIndices(
  current: Objective[],
  achievedIndices: number[]
): Objective[] {
  const flips = new Set<number>();
  for (const i of achievedIndices) {
    if (Number.isInteger(i) && i >= 0 && i < current.length) {
      flips.add(i);
    }
  }
  return current.map((o, i) =>
    flips.has(i) && !o.achieved ? { ...o, achieved: true } : o
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/stack.test.ts`
Expected: PASS — new tests green; the existing format-helper tests still pass because `formatStackForNarrator`/`formatStackForArchivist` haven't changed yet.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): Objective type, applyPresetToStack, unionAchievedIndices"
```

---

## Task 3: Stack format helpers — briefing and objectives sections

**Files:**
- Modify: `src/stack.ts`
- Test: `src/stack.test.ts`

`formatStackForNarrator` gains an optional `briefing` parameter (the preset body) and renders briefing + objectives sections when present. `formatStackForArchivist` gains an OBJECTIVES section so the archivist can map indices back to text.

- [ ] **Step 1: Write failing tests**

Append to `src/stack.test.ts`:

```ts
test("formatStackForNarrator: includes MISSION BRIEFING when briefing is provided", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForNarrator(stack, "You are an astronaut.");
  expect(out).toContain("MISSION BRIEFING (durable premise):");
  expect(out).toContain("You are an astronaut.");
});

test("formatStackForNarrator: omits MISSION BRIEFING when briefing is undefined", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("MISSION BRIEFING");
});

test("formatStackForNarrator: renders OBJECTIVES checkboxes when objectives present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the transmitter", achieved: true },
      { text: "Send the signal", achieved: false },
    ],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES:");
  expect(out).toContain("[x] Find the transmitter");
  expect(out).toContain("[ ] Send the signal");
});

test("formatStackForNarrator: omits OBJECTIVES when none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  expect(formatStackForNarrator(stack)).not.toContain("OBJECTIVES:");
});

test("formatStackForArchivist: includes OBJECTIVES with indices when present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the transmitter", achieved: false },
      { text: "Send the signal", achieved: false },
    ],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("OBJECTIVES:");
  expect(out).toContain("0: [ ] Find the transmitter");
  expect(out).toContain("1: [ ] Send the signal");
});

test("formatStackForArchivist: omits OBJECTIVES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  expect(formatStackForArchivist(stack)).not.toContain("OBJECTIVES:");
});
```

The existing `formatStackForNarrator: empty stack returns empty string` test (line ~4) will need its `WorldStack` literal updated to include `objectives: []` and `presetSlug: null` — TypeScript will already require this after Task 2, but make sure all existing fixtures in the file have the two new fields. Same for the other existing test stacks in this file.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/stack.test.ts`
Expected: FAIL on the new tests; existing tests still passing.

- [ ] **Step 3: Implement format helper updates**

Edit `src/stack.ts`. Replace `formatStackForNarrator` and `formatStackForArchivist`:

```ts
export function formatStackForNarrator(stack: WorldStack, briefing?: string): string {
  const parts: string[] = [];
  if (briefing && briefing.trim().length > 0) {
    parts.push(`MISSION BRIEFING (durable premise):\n${briefing.trim()}`);
  }
  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map(
      (o) => `[${o.achieved ? "x" : " "}] ${o.text}`
    );
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
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
    const lines = stack.objectives.map(
      (o, i) => `${i}: [${o.achieved ? "x" : " "}] ${o.text}`
    );
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
  }
  return `${parts.join("\n\n")}\n\n`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/stack.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat(stack): briefing and objectives sections in format helpers"
```

---

## Task 4: Engine — narrator prompt rules and signature

**Files:**
- Modify: `src/engine.ts`
- Test: `src/engine.test.ts`

The narrator gets two new system-prompt rules and `narratorTurn` accepts an optional `briefing` parameter that flows through to `formatStackForNarrator`.

- [ ] **Step 1: Write failing tests**

Append to `src/engine.test.ts`:

```ts
test("narratorTurn: omits MISSION BRIEFING when briefing is undefined", async () => {
  let captured = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    captured = inp;
    return "ok";
  });
  await narratorTurn(emptyStack, "look");
  expect(captured).not.toContain("MISSION BRIEFING");
});

test("narratorTurn: includes MISSION BRIEFING and OBJECTIVES when provided", async () => {
  const stackWithObjectives: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the transmitter", achieved: false }],
    presetSlug: "lunar-rescue",
  };
  let captured = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    captured = inp;
    return "ok";
  });
  await narratorTurn(stackWithObjectives, "look", "You are an astronaut.");
  expect(captured).toContain("MISSION BRIEFING (durable premise):");
  expect(captured).toContain("You are an astronaut.");
  expect(captured).toContain("OBJECTIVES:");
  expect(captured).toContain("[ ] Find the transmitter");
});

test("NARRATOR_SYSTEM: instructs the narrator to honor the mission briefing", () => {
  expect(NARRATOR_SYSTEM).toContain("MISSION BRIEFING");
  expect(NARRATOR_SYSTEM).toContain("OBJECTIVES");
});
```

Also: every existing test fixture in this file uses a `WorldStack` literal — add `objectives: []` and `presetSlug: null` to each (`emptyStack` at top, `populatedStack` at top, the inline ones in archivist tests). TypeScript will complain at compile/test time until you do.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/engine.test.ts`
Expected: FAIL — `narratorTurn` doesn't accept a third arg yet, and `NARRATOR_SYSTEM` lacks the new strings.

- [ ] **Step 3: Update narrator system prompt and signature**

Edit `src/engine.ts`. Append two rules to `NARRATOR_SYSTEM` (just before the closing backtick of the existing template):

```
- If the input contains a "MISSION BRIEFING (durable premise)" section, that is the durable premise of this run. Honor it. Do not contradict the setting (no trees on a lunar surface, no spacecraft in a medieval cellar). Build on it.
- If the input contains an "OBJECTIVES" section with checkboxes, those are concrete things the player is trying to accomplish. Do not list them at the player. Do not tell them what to do. Surface them through the world — what they encounter, what they notice — when their actions head that way. The player solves; you describe.
```

Update `narratorTurn`:

```ts
export async function narratorTurn(
  stack: WorldStack,
  playerInput: string,
  briefing?: string
): Promise<string> {
  const input = `${formatStackForNarrator(stack, briefing)}PLAYER ACTION: ${playerInput}`;
  return await api.callModel(NARRATOR_SYSTEM, input);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat(engine): narrator briefing/objectives prompt and signature"
```

---

## Task 5: Engine — archivist schema, system prompt, return type

**Files:**
- Modify: `src/engine.ts`
- Test: `src/engine.test.ts`

The archivist returns `achievedObjectiveIndices: number[]` per turn.

- [ ] **Step 1: Write failing tests**

Append to `src/engine.test.ts`:

```ts
test("archivistTurn: returns achievedObjectiveIndices from model", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0, 2],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([0, 2]);
});

test("archivistTurn: defaults achievedObjectiveIndices to [] when missing", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
  } as any));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([]);
});

test("archivistTurn: filters non-integer or negative achievedObjectiveIndices", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0, -1, 1.5, 3, "bad" as any],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([0, 3]);
});

test("ARCHIVIST_SYSTEM: instructs the archivist on conservative objective completion", async () => {
  // Reach into the engine module for the constant — exporting it for the test.
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  expect(ARCHIVIST_SYSTEM).toContain("achievedObjectiveIndices");
  expect(ARCHIVIST_SYSTEM.toLowerCase()).toContain("when in doubt");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/engine.test.ts`
Expected: FAIL — `achievedObjectiveIndices` is not in `ArchivistResult`, schema, or system prompt.

- [ ] **Step 3: Update archivist schema, prompt, and result type**

Edit `src/engine.ts`. Append to `ARCHIVIST_SYSTEM` (just before the final closing backtick):

```
Rules for "achievedObjectiveIndices":
- The OBJECTIVES list (if present) is shown with its indices: "0: [ ] Find the transmitter".
- Return an index ONLY if THIS narrative passage explicitly depicts that objective being completed.
- "Approached the transmitter" or "saw the transmitter" is NOT completion. "Repaired the transmitter" or "the transmitter chimes back to life" is.
- When in doubt, return [].
- Do not invent indices outside the provided list. Return [] if no OBJECTIVES section is present.
```

Update the schema:

```ts
const ARCHIVIST_SCHEMA = {
  type: "object",
  properties: {
    entries: { type: "array", items: { type: "string" }, maxItems: MAX_STACK_ENTRIES },
    threads: { type: "array", items: { type: "string" }, maxItems: MAX_THREADS },
    moved: { type: "boolean" },
    locationDescription: { type: "string" },
    achievedObjectiveIndices: { type: "array", items: { type: "integer", minimum: 0 } },
  },
  required: ["entries", "threads", "moved", "locationDescription", "achievedObjectiveIndices"],
  additionalProperties: false,
};
```

Update the result type and the function:

```ts
export interface ArchivistResult {
  entries: string[];
  threads: string[];
  turn: number;
  moved: boolean;
  locationDescription: string;
  achievedObjectiveIndices: number[];
}

export async function archivistTurn(
  stack: WorldStack,
  narrative: string
): Promise<ArchivistResult> {
  const input = `${formatStackForArchivist(stack)}NEW NARRATIVE:\n${narrative}\n\nReturn updated entries, threads, whether the player moved to a new location, a 1-2 sentence canonical description of the place the player is now at, and the indices of any objectives just completed:`;
  const result = await api.callModelStructured<{
    entries: string[];
    threads: string[];
    moved?: boolean;
    locationDescription?: string;
    achievedObjectiveIndices?: unknown;
  }>(ARCHIVIST_SYSTEM, input, "world_stack", ARCHIVIST_SCHEMA);

  if (!Array.isArray(result.entries) || !Array.isArray(result.threads)) {
    throw new Error(`Archivist returned unexpected shape: ${JSON.stringify(result)}`);
  }

  const indices = Array.isArray(result.achievedObjectiveIndices)
    ? result.achievedObjectiveIndices.filter(
        (i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0
      )
    : [];

  return {
    entries: result.entries.slice(0, MAX_STACK_ENTRIES),
    threads: result.threads.slice(0, MAX_THREADS),
    turn: stack.turn + 1,
    moved: typeof result.moved === "boolean" ? result.moved : false,
    locationDescription: typeof result.locationDescription === "string" ? result.locationDescription : "",
    achievedObjectiveIndices: indices,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat(engine): archivist achievedObjectiveIndices field"
```

---

## Task 6: Server — preset cache, protocol shape, hello extension

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

Replace `reset` with `start`/`keep-exploring`. Load and cache presets at boot. Extend `hello` snapshot with `presets`, `objectives`, `presetSlug`. Extend `stack-update` with `objectives`. Add `win` server message.

- [ ] **Step 1: Write failing tests for `processInput` extension and message shape**

The `processInput` tests don't exercise `start`/`keep-exploring` directly (those are in `handleClientMessage`, which is unexported). Refactor: export a `handleClientMessage` so it's testable. Alternatively, expose smaller helpers (`startWithPreset`, `keepExploring`) and test them. Pick the second; it's cleaner.

Append to `src/server.test.ts`:

```ts
import { startWithPreset, keepExploring } from "./server";
import type { Preset } from "./presets";

const lunarPreset: Preset = {
  slug: "lunar-rescue",
  title: "Lunar Rescue",
  description: "test",
  objects: ["damaged transmitter", "oxygen cache"],
  objectives: ["Find the transmitter", "Send the signal"],
  body: "You are an astronaut.",
};

test("startWithPreset: seeds a stack from the preset", () => {
  const s = startWithPreset(lunarPreset);
  expect(s.entries).toEqual(["damaged transmitter", "oxygen cache"]);
  expect(s.objectives).toEqual([
    { text: "Find the transmitter", achieved: false },
    { text: "Send the signal", achieved: false },
  ]);
  expect(s.presetSlug).toBe("lunar-rescue");
  expect(s.turn).toBe(0);
  expect(s.position).toEqual([0, 0]);
});

test("keepExploring: clears presetSlug, leaves objectives intact", () => {
  const s: WorldStack = {
    entries: ["x"],
    threads: ["y"],
    turn: 5,
    position: [1, 0],
    places: { "1,0": "p" },
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: true },
    ],
    presetSlug: "lunar-rescue",
  };
  const after = keepExploring(s);
  expect(after.presetSlug).toBeNull();
  expect(after.objectives).toEqual(s.objectives);
  expect(after.entries).toEqual(s.entries);
  expect(after.turn).toBe(5);
});
```

Update existing server test fixtures: every `WorldStack` literal in this file needs `objectives: []` and `presetSlug: null`. TypeScript will force the issue.

- [ ] **Step 2: Write failing test for `stack-update` and `win` message shape**

Append to `src/server.test.ts`:

```ts
test("processInput: stack-update includes objectives", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "a", achieved: false }],
    presetSlug: "x",
  };
  const messages: ServerMessage[] = [];
  await processInput(stack, "look", (m) => messages.push(m));
  const update = messages.find((m) => m.type === "stack-update") as any;
  expect(update.objectives).toEqual([{ text: "a", achieved: false }]);
});

test("processInput: applies achievedObjectiveIndices monotonically", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: false },
      { text: "b", achieved: false },
    ],
    presetSlug: "x",
  };
  const newStack = await processInput(stack, "look", () => {});
  expect(newStack.objectives[0].achieved).toBe(true);
  expect(newStack.objectives[1].achieved).toBe(false);
});

test("processInput: emits win when last objective is achieved", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [1],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: false },
    ],
    presetSlug: "x",
  };
  const messages: ServerMessage[] = [];
  await processInput(stack, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(true);
});

test("processInput: does NOT re-emit win on subsequent turns when already won", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 2,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const alreadyWon: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: true },
    ],
    presetSlug: "x",
  };
  const messages: ServerMessage[] = [];
  await processInput(alreadyWon, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(false);
});

test("processInput: free-play (no objectives) never emits win", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(false);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test src/server.test.ts`
Expected: FAIL — `startWithPreset`, `keepExploring`, win logic, and `objectives` in stack-update don't exist.

- [ ] **Step 4: Update server types and add helpers**

Edit `src/server.ts`. Update message types:

```ts
import type { Preset } from "./presets";
import { applyPresetToStack, unionAchievedIndices, type Objective } from "./stack";

export interface PresetSummary {
  slug: string;
  title: string;
  description: string;
}

export type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      presetSlug: string | null;
      presets: PresetSummary[];
    }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | {
      type: "stack-update";
      entries: string[];
      threads: string[];
      objectives: Objective[];
    }
  | { type: "win" }
  | { type: "error"; source: "narrator" | "archivist"; message: string };

export type ClientMessage =
  | { type: "input"; text: string }
  | { type: "start"; presetSlug: string | null }
  | { type: "keep-exploring" }
  | { type: "hello" };
```

Add the two helpers:

```ts
export function startWithPreset(preset: Preset): WorldStack {
  return applyPresetToStack(preset);
}

export function emptyWorld(): WorldStack {
  return {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
}

export function keepExploring(stack: WorldStack): WorldStack {
  return { ...stack, presetSlug: null };
}
```

- [ ] **Step 5: Update `processInput` for objective union and win detection**

Replace the relevant portion of `processInput`. The key changes: load briefing if presetSlug is set (Task 7 wires up the preset cache; for now accept a `briefing` parameter), apply the union, compute win, include objectives in stack-update.

Modify `processInput` signature and body:

```ts
export async function processInput(
  stack: WorldStack,
  input: string,
  send: Send,
  briefing?: string
): Promise<WorldStack> {
  send({ type: "turn-start", input });

  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch {
    action = { action: "stay" };
  }

  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;
  const narratorStack: WorldStack = { ...stack, position: prospective };

  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input, briefing);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    send({ type: "error", source: "narrator", message: String(err) });
    return stack;
  }

  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    send({ type: "error", source: "archivist", message: String(err) });
    return stack;
  }

  const finalPosition = dir && archived.moved ? prospective : stack.position;
  const finalKey = posKey(finalPosition);
  const places = { ...stack.places };
  if (!places[finalKey] && archived.locationDescription) {
    places[finalKey] = archived.locationDescription;
  }

  const wasAllDone =
    stack.objectives.length > 0 && stack.objectives.every((o) => o.achieved);
  const newObjectives = unionAchievedIndices(
    stack.objectives,
    archived.achievedObjectiveIndices
  );
  const isAllDone =
    newObjectives.length > 0 && newObjectives.every((o) => o.achieved);

  const newStack: WorldStack = {
    entries: archived.entries,
    threads: archived.threads,
    turn: archived.turn,
    position: finalPosition,
    places,
    objectives: newObjectives,
    presetSlug: stack.presetSlug,
  };

  await appendPlayLog(archived.turn, input, narrative, finalPosition);

  send({
    type: "stack-update",
    entries: newStack.entries,
    threads: newStack.threads,
    objectives: newStack.objectives,
  });

  if (isAllDone && !wasAllDone) {
    send({ type: "win" });
  }

  return newStack;
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test src/server.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): start/keep-exploring helpers, win detection, objective union"
```

---

## Task 7: Server — wire preset cache and client message handlers

**Files:**
- Modify: `src/server.ts`

Wire `startWithPreset`, `keepExploring`, `emptyWorld`, the preset cache (loaded at boot), and the new client messages into `handleClientMessage`. Update `hello` to include presets/objectives/presetSlug. The `briefing` for `processInput` comes from the cached preset matching `currentStack.presetSlug`.

- [ ] **Step 1: Add module-level preset cache and update `main`**

Edit `src/server.ts`. Add at module scope:

```ts
import { loadAllPresets, type Preset } from "./presets";

let currentStack: WorldStack;
let presets: Map<string, Preset> = new Map();
```

Update `main`:

```ts
async function main() {
  presets = await loadAllPresets();
  currentStack = await loadStack();
  // ... existing Bun.serve(...) call unchanged
}
```

- [ ] **Step 2: Replace `handleClientMessage` body**

Replace the existing `handleClientMessage` with:

```ts
function presetSummaries(): PresetSummary[] {
  return [...presets.values()].map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
  }));
}

function snapshotMessage(stack: WorldStack): ServerMessage {
  return {
    type: "snapshot",
    turn: stack.turn,
    entries: stack.entries,
    threads: stack.threads,
    objectives: stack.objectives,
    presetSlug: stack.presetSlug,
    presets: presetSummaries(),
  };
}

async function handleClientMessage(
  raw: string,
  send: Send,
  broadcast: Send
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: "error", source: "narrator", message: "Invalid client message" });
    return;
  }

  if (msg.type === "hello") {
    send(snapshotMessage(currentStack));
    return;
  }

  if (msg.type === "start") {
    let next: WorldStack;
    if (msg.presetSlug === null) {
      next = emptyWorld();
    } else {
      const preset = presets.get(msg.presetSlug);
      if (!preset) {
        send({
          type: "error",
          source: "archivist",
          message: `Unknown preset: ${msg.presetSlug}`,
        });
        return;
      }
      next = startWithPreset(preset);
    }
    try {
      await saveStack(next);
      currentStack = next;
      broadcast(snapshotMessage(currentStack));
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Start failed: ${err}` });
    }
    return;
  }

  if (msg.type === "keep-exploring") {
    const next = keepExploring(currentStack);
    try {
      await saveStack(next);
      currentStack = next;
      broadcast(snapshotMessage(currentStack));
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Save failed: ${err}` });
    }
    return;
  }

  if (msg.type === "input") {
    const briefing = currentStack.presetSlug
      ? presets.get(currentStack.presetSlug)?.body
      : undefined;
    const newStack = await processInput(currentStack, msg.text, broadcast, briefing);
    if (newStack !== currentStack) {
      currentStack = newStack;
      try {
        await saveStack(currentStack);
      } catch (err) {
        broadcast({
          type: "error",
          source: "archivist",
          message: `Save failed: ${err}`,
        });
      }
    }
  }
}
```

- [ ] **Step 3: Type-check and run all tests**

Run: `bun test`
Expected: PASS — full suite green.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): preset cache, hello/start/keep-exploring handlers"
```

---

## Task 8: Bundled preset content

**Files:**
- Create: `presets/lunar-rescue.md`
- Create: `presets/cellar-of-glass.md`
- Create: `presets/the-last-train.md`

Three deliberately different settings.

- [ ] **Step 1: Create `presets/lunar-rescue.md`**

```markdown
---
title: Lunar Rescue
description: Stranded on the far side. Send the signal.
objects:
  - damaged transmitter half-buried in regolith
  - oxygen cache strapped to the lander hull
  - abandoned rover wreck on the eastern crater rim
objectives:
  - Find the transmitter
  - Restore power to the comm array
  - Send the distress signal
---
You are an astronaut stranded on the lunar far side after a hard landing. Your suit is functional but your visor cracked on impact and the seal is improvised. The lander's main systems are dark; only emergency LEDs flicker in the cabin. Earth is one horizon away — invisible from here. Communications are dead. You have hours of breathable air, not days.
```

- [ ] **Step 2: Create `presets/cellar-of-glass.md`**

```markdown
---
title: Cellar of Glass
description: A locksmith's tomb beneath the cathedral.
objects:
  - brass key tarnished green at the bow
  - shattered apothecary jar leaking clear fluid
  - iron-bound chest with a broken lock plate
objectives:
  - Find the locksmith's journal
  - Open the iron-bound chest
  - Escape the cellar before the candles burn out
---
You are a thief who descended into the cellar of an abandoned cathedral and found the door above sealed when the wind shifted. The cellar is a locksmith's grave — the master who built the cathedral's locks was buried with his work. Glass apothecary jars line the walls; some have shattered, leaking sticky fluid across the flagstones. Three candles burn on a sconce at the foot of the stairs. You have what's in your pockets and what's down here.
```

- [ ] **Step 3: Create `presets/the-last-train.md`**

```markdown
---
title: The Last Train
description: One car, six strangers, ninety minutes.
objects:
  - leather satchel left on a window seat
  - half-empty bottle of plum wine on the floor
  - conductor's cap on the empty conductor's seat
objectives:
  - Find out where the conductor went
  - Identify the owner of the leather satchel
  - Convince another passenger to help you stop the train
---
You are a passenger on the last train out of a city you no longer trust. The train shouldn't be running this late, and the conductor's seat at the front of the car has been empty since the last station. There are five other passengers in the car with you, all silent, all avoiding eye contact. The lights flicker every few minutes. Through the windows: pine forest in pitch dark, sliding past too fast. You have ninety minutes before the next station — if there is one.
```

- [ ] **Step 4: Verify all presets load**

Run a quick smoke test:

```bash
bun -e 'import("./src/presets").then(m => m.loadAllPresets()).then(p => console.log([...p.keys()]))'
```

Expected output: `[ "lunar-rescue", "cellar-of-glass", "the-last-train" ]` (order may vary).

- [ ] **Step 5: Commit**

```bash
git add presets/
git commit -m "content: bundle three starting presets"
```

---

## Task 9: Frontend — protocol and modal scaffolding

**Files:**
- Modify: `src/web/app.tsx`

Update the client-side protocol types, add modal state, render an inert modal frame. No content yet — that's the next two tasks.

- [ ] **Step 1: Update protocol types in `app.tsx`**

Replace the existing `ServerMessage` type and `Stack` type at top of file:

```ts
type Objective = { text: string; achieved: boolean };

type PresetSummary = { slug: string; title: string; description: string };

type Stack = {
  turn: number;
  entries: string[];
  threads: string[];
  objectives: Objective[];
  presetSlug: string | null;
};

type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      presetSlug: string | null;
      presets: PresetSummary[];
    }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | {
      type: "stack-update";
      entries: string[];
      threads: string[];
      objectives: Objective[];
    }
  | { type: "win" }
  | { type: "error"; source: "narrator" | "archivist"; message: string };
```

- [ ] **Step 2: Add modal state and presets/preset-active state to `App`**

Inside `function App()`, add new state hooks alongside the existing ones:

```ts
type ModalView = null | "select" | "briefing" | "win";
const [modal, setModal] = useState<ModalView>(null);
const [presets, setPresets] = useState<PresetSummary[]>([]);
```

Update the initial `stack` state to include the new fields:

```ts
const [stack, setStack] = useState<Stack>({
  turn: 0,
  entries: [],
  threads: [],
  objectives: [],
  presetSlug: null,
});
```

- [ ] **Step 3: Handle the new message fields in the WebSocket listener**

In the existing `ws.addEventListener("message", ...)`, update the snapshot/stack-update branches and add a `win` branch:

```ts
if (msg.type === "snapshot") {
  setStack({
    turn: msg.turn,
    entries: msg.entries,
    threads: msg.threads,
    objectives: msg.objectives,
    presetSlug: msg.presetSlug,
  });
  setPresets(msg.presets);
  // Auto-open select view on a truly fresh world.
  if (msg.presetSlug === null && msg.turn === 0 && msg.entries.length === 0) {
    setModal("select");
  }
  return;
}
if (msg.type === "stack-update") {
  setStack((s) => ({
    ...s,
    entries: msg.entries,
    threads: msg.threads,
    objectives: msg.objectives,
    turn: s.turn + 1,
  }));
  updateLastInputTurn((t) => ({ ...t, pending: false }));
  setPending(false);
  return;
}
if (msg.type === "win") {
  setModal("win");
  return;
}
```

- [ ] **Step 4: Render an inert modal placeholder**

Just before the closing `</>` of `App`'s return, add:

```tsx
{modal !== null && (
  <div className="modal-overlay" onClick={() => setModal(null)}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-body">{modal} view (placeholder)</div>
      <button className="action-button" onClick={() => setModal(null)}>close</button>
    </div>
  </div>
)}
```

Add minimal CSS to `src/web/styles.css` (append at end):

```css
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.modal {
  background: #111; border: 1px solid #444;
  padding: 1.5rem; min-width: 320px; max-width: 600px;
  font-family: monospace;
}
.modal-body { margin-bottom: 1rem; white-space: pre-wrap; }
.preset-row {
  display: flex; gap: 1rem; padding: 0.5rem;
  cursor: pointer; align-items: baseline;
}
.preset-row:hover { background: #222; }
.preset-row .title { color: #fff; min-width: 12rem; }
.preset-row .description { color: #888; }
.modal-divider { border-top: 1px solid #333; margin: 0.5rem 0; }
.objective-line { display: block; }
```

- [ ] **Step 5: Smoke-check that the app still builds and runs**

Run: `bun --hot ./src/server.ts` (in another terminal, or briefly). Open `http://localhost:3000`.
Expected: app loads, the modal placeholder appears auto-opened on a fresh world. Close it; the app behaves normally otherwise.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.tsx src/web/styles.css
git commit -m "feat(web): protocol types, modal scaffolding, auto-open"
```

---

## Task 10: Frontend — selection view and `new game` button

**Files:**
- Modify: `src/web/app.tsx`

Render the select view; wire up `new game` button to open it; wire up clicks to send `start`.

- [ ] **Step 1: Replace the modal placeholder with a `Modal` component dispatcher**

In `app.tsx`, replace the placeholder JSX with a dispatcher and add a `SelectView` component. At the bottom of the file (before `createRoot`):

```tsx
function SelectView(props: {
  presets: PresetSummary[];
  onPick: (slug: string | null) => void;
  onCancel: () => void;
}) {
  const { presets, onPick, onCancel } = props;
  const surprise = () => {
    if (presets.length === 0) return;
    const p = presets[Math.floor(Math.random() * presets.length)];
    onPick(p.slug);
  };
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">PICK A STORY</div>
        <div className="preset-row" onClick={surprise}>
          <span className="title">🎲 Surprise me</span>
          <span className="description">random preset</span>
        </div>
        {presets.map((p) => (
          <div key={p.slug} className="preset-row" onClick={() => onPick(p.slug)}>
            <span className="title">{p.title}</span>
            <span className="description">{p.description}</span>
          </div>
        ))}
        <div className="modal-divider" />
        <div className="preset-row" onClick={() => onPick(null)}>
          <span className="title">Empty world</span>
          <span className="description">No preset — make your own way.</span>
        </div>
      </div>
      <button className="action-button" onClick={onCancel}>cancel</button>
    </>
  );
}
```

- [ ] **Step 2: Wire the modal dispatcher**

Replace the modal JSX inside `App`:

```tsx
{modal !== null && (
  <div className="modal-overlay" onClick={() => setModal(null)}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      {modal === "select" && (
        <SelectView
          presets={presets}
          onPick={(slug) => {
            wsRef.current?.send(JSON.stringify({ type: "start", presetSlug: slug }));
            setTurns([]);
            nextIdRef.current = 1;
            setModal(slug === null ? null : "briefing");
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === "briefing" && (
        <div className="modal-body">briefing view (next task)</div>
      )}
      {modal === "win" && (
        <div className="modal-body">win view (later task)</div>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 3: Replace the `reset` button with `new game`**

In the `button-row` JSX, replace the `reset` button:

```tsx
<button
  className="action-button critical"
  onClick={() => setModal("select")}
  disabled={!connected}
>
  new game
</button>
```

Also remove the `reset` text command branch from `send()` (the entire `if (lower === "reset") { ... }` block) and remove `reset` from the `help` command's `items` list. Replace with:

```tsx
if (lower === "help") {
  addTurn({
    id: nextIdRef.current++,
    kind: "system",
    title: "Commands",
    items: [
      "stack       show world state",
      "threads     show active threads",
      "help        this list",
      "(or type any action — use the new game button to switch stories)",
    ],
  });
  return;
}
```

- [ ] **Step 4: Manual smoke test**

Run: `bun --hot ./src/server.ts`. Open `http://localhost:3000`.

Verify:
- On a fresh world, the modal auto-opens to the select view.
- Clicking "🎲 Surprise me" picks one preset and dismisses to briefing placeholder.
- Clicking a named preset works similarly.
- Clicking "Empty world" closes the modal entirely.
- Cancel closes the modal without changing state.
- Clicking "new game" in the action bar opens the modal.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): selection view and new game button"
```

---

## Task 11: Frontend — briefing view, mission button, win view

**Files:**
- Modify: `src/web/app.tsx`

Render briefing and win views, wire up the `mission` button.

- [ ] **Step 1: Add `BriefingView` and `WinView` components**

Append below `SelectView`:

```tsx
function ObjectivesList({ objectives }: { objectives: Objective[] }) {
  return (
    <ul className="system-list">
      {objectives.map((o, i) => (
        <li key={i} className="objective-line">
          [{o.achieved ? "x" : " "}] {o.text}
        </li>
      ))}
    </ul>
  );
}

function BriefingView(props: {
  title: string;
  body: string;
  objectives: Objective[];
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">{props.title.toUpperCase()}</div>
        <p>{props.body}</p>
        <div className="modal-divider" />
        <div>OBJECTIVES</div>
        <ObjectivesList objectives={props.objectives} />
      </div>
      <button className="action-button" onClick={props.onClose}>close</button>
    </>
  );
}

function WinView(props: {
  objectives: Objective[];
  onKeepExploring: () => void;
  onNewGame: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">MISSION COMPLETE</div>
        <ObjectivesList objectives={props.objectives} />
      </div>
      <button className="action-button" onClick={props.onKeepExploring}>keep exploring</button>
      <button className="action-button" onClick={props.onNewGame}>new game</button>
    </>
  );
}
```

- [ ] **Step 2: Track current preset summary in `App`**

The briefing view needs the preset's title and body. Body isn't currently sent by the server (we only send `presets: PresetSummary[]` and `presetSlug`). Two options:
- Server-side: include `body` in `PresetSummary`.
- Client-side: stop here and send only what's already on the wire.

Pick option 1 — extend `PresetSummary` to include `body`. Update `src/server.ts`:

```ts
export interface PresetSummary {
  slug: string;
  title: string;
  description: string;
  body: string;
}

function presetSummaries(): PresetSummary[] {
  return [...presets.values()].map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
  }));
}
```

And in `app.tsx`:

```ts
type PresetSummary = {
  slug: string;
  title: string;
  description: string;
  body: string;
};
```

- [ ] **Step 3: Wire briefing/win views in the modal dispatcher**

Replace the placeholder branches in the modal JSX:

```tsx
{modal === "briefing" && (() => {
  const p = presets.find((x) => x.slug === stack.presetSlug);
  return p ? (
    <BriefingView
      title={p.title}
      body={p.body}
      objectives={stack.objectives}
      onClose={() => setModal(null)}
    />
  ) : (
    <div className="modal-body">No mission active.</div>
  );
})()}
{modal === "win" && (
  <WinView
    objectives={stack.objectives}
    onKeepExploring={() => {
      wsRef.current?.send(JSON.stringify({ type: "keep-exploring" }));
      setModal(null);
    }}
    onNewGame={() => setModal("select")}
  />
)}
```

- [ ] **Step 4: Add `mission` button to the action bar**

In the `button-row` JSX, add before the `new game` button:

```tsx
<button
  className="action-button"
  onClick={() => setModal("briefing")}
  disabled={!connected || stack.presetSlug === null}
>
  mission
</button>
```

- [ ] **Step 5: Manual smoke test**

Run: `bun --hot ./src/server.ts`. Open `http://localhost:3000`.

Verify:
- Pick a preset → modal switches to briefing view, shows title/body/objectives.
- Close briefing, type something → narrative comes back.
- Click `mission` → briefing view re-opens; close it.
- After picking "Empty world", `mission` button is greyed.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.tsx src/server.ts
git commit -m "feat(web): briefing view, mission button, win view"
```

---

## Task 12: Frontend — inline objective-tick badges

**Files:**
- Modify: `src/web/app.tsx`

When a stack-update flips an objective, surface a `SystemTurn` badge in the narrative scroll.

- [ ] **Step 1: Add a pure helper `diffAchievedTexts`**

At the bottom of `app.tsx`, before `createRoot`:

```ts
export function diffAchievedTexts(
  prev: Objective[],
  curr: Objective[]
): string[] {
  const flips: string[] = [];
  const upTo = Math.min(prev.length, curr.length);
  for (let i = 0; i < upTo; i++) {
    if (!prev[i].achieved && curr[i].achieved) {
      flips.push(curr[i].text);
    }
  }
  return flips;
}
```

(Exported for testability if you ever add frontend tests; harmless otherwise.)

- [ ] **Step 2: Emit a SystemTurn for each flip in the stack-update branch**

Inside the WebSocket listener, replace the `stack-update` branch:

```ts
if (msg.type === "stack-update") {
  setStack((s) => {
    const flips = diffAchievedTexts(s.objectives, msg.objectives);
    if (flips.length > 0) {
      // Defer the addTurn to the next tick to avoid setState-during-setState.
      queueMicrotask(() => {
        for (const text of flips) {
          addTurn({
            id: nextIdRef.current++,
            kind: "system",
            title: "✓ Objective complete",
            items: [text],
          });
        }
      });
    }
    return {
      ...s,
      entries: msg.entries,
      threads: msg.threads,
      objectives: msg.objectives,
      turn: s.turn + 1,
    };
  });
  updateLastInputTurn((t) => ({ ...t, pending: false }));
  setPending(false);
  return;
}
```

- [ ] **Step 3: Manual smoke test**

This step needs an actual play session, since objective completion depends on the LLM. Start the server, pick the Lunar Rescue preset, and play toward "Find the transmitter." When the narrator describes the transmitter being found and the archivist returns the index, the badge `✓ Objective complete: Find the transmitter` should appear in the narrative scroll, and the briefing modal (when opened) shows that line as `[x]`.

If the archivist over- or under-fires, that is an LLM-quality issue and is iterated on via the play log, not via code.

- [ ] **Step 4: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): inline objective-tick badges"
```

---

## Task 13: Final verification pass

**Files:**
- None modified.

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS for all of `presets.test.ts`, `stack.test.ts`, `engine.test.ts`, `server.test.ts`, plus any pre-existing tests.

- [ ] **Step 2: Manual end-to-end through one full preset**

Run: `bun --hot ./src/server.ts`. Open `http://localhost:3000`.

Walk through:
- Fresh-world auto-opens the select modal.
- Pick "Lunar Rescue" → briefing pops with the right body and three unchecked objectives.
- Close briefing; type a few actions referencing the seeded objects (transmitter, oxygen cache).
- Verify the narrator describes a lunar setting (no oak trees, no streams).
- Check the `mission` button re-opens the briefing.
- Continue until at least one objective gets ticked. Verify the badge appears and the briefing reflects the tick.
- Test `new game` mid-run → opens select modal; cancelling returns you to the same run.
- Test "Empty world" path → free-play, `mission` button greyed.

- [ ] **Step 3: Verify graceful old-save loading**

Stop the dev server. Save the current `world-stack.json`. Replace it temporarily with an old-shape file (no `objectives` or `presetSlug` fields) — for example, by hand-editing — then start the server again.

Expected: server boots, app loads, `objectives: []` and `presetSlug: null` in the snapshot, modal auto-opens to select view since the world reads as fresh empty. Restore the saved file afterwards if you want to keep state.

- [ ] **Step 4: Commit if anything was tweaked during smoke-testing**

```bash
git status
# If anything changed:
git add <files>
git commit -m "fix: smoke-test follow-ups"
```

---

## Self-Review Checklist (executed before delivery)

- **Spec coverage:** preset format ✓ (T1, T8), `WorldStack` additions ✓ (T2), `applyPresetToStack` ✓ (T2), narrator briefing+objectives ✓ (T3, T4), archivist `achievedObjectiveIndices` ✓ (T5), pinned monotonic union ✓ (T2, T6), win detection ✓ (T6), `start`/`keep-exploring`/removed `reset` ✓ (T6, T7), `hello` extension ✓ (T7), `stack-update` extension ✓ (T6), modal three views ✓ (T9–T11), auto-open ✓ (T9), buttons replaced ✓ (T10, T11), tick badges ✓ (T12), bundled presets ✓ (T8), tests for each layer ✓.
- **Placeholder scan:** no TBDs or TODOs remain.
- **Type consistency:** `Objective`, `PresetSummary`, `WorldStack` shapes consistent across server and client.
