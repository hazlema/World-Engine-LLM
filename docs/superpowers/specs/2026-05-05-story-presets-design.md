# Story Presets — Design

Date: 2026-05-05

## Problem

Today the world is born from an empty stack: no entries, no threads, no places, position `[0,0]`. The first narrator turn invents the setting on the fly with nothing to anchor it, so successive runs gravitate toward the LLM's mean — woods, paths, smoke, oaks. Players asking for variety get the same flavour.

We want the player to start runs in deliberately different settings (an astronaut on the moon, a locksmith in a flooded cathedral, a passenger on the last train) and to play with concrete intent — discrete objectives that, when all completed, mark the run as won.

## Solution overview

Add **presets**: small markdown files that seed a fresh stack with a premise, a starting set of in-world objects, and a list of pinned objectives. The narrator gets the premise as durable system context; the archivist gets the objectives as a checklist it can flip (but not delete). Win detection is pure server code: `objectives.every(o => o.achieved)`.

The pattern mirrors what already works for canonical place descriptions — anchor structure, generate prose. We're applying it to whole-world setting and intent rather than per-tile geography.

## Preset format

Presets live in `presets/<slug>.md`. Filename minus `.md` is the slug.

```yaml
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
You are an astronaut stranded on the lunar far side after a hard landing.
Your suit is functional. The lander's main systems are dark. Earth is one
horizon away.
```

- `title` — shown in the selection menu.
- `description` — one-line tagline in the menu.
- `objects` — seeded as `entries` on the fresh stack so the world's established canon includes them from turn 1.
- `objectives` — seeded as the pinned-objective list (see below).
- **body** — the premise text. Loaded fresh from disk each turn while a preset is active and injected into the narrator's prompt.

All four frontmatter fields are required. A missing or malformed field is a hard error at load time.

Discovery is `Array.fromAsync(new Bun.Glob("presets/*.md").scan("."))` at server boot. No registry or index file.

## Data model

`WorldStack` gains two fields:

```ts
interface Objective {
  text: string;
  achieved: boolean;
}

interface WorldStack {
  // ... existing fields unchanged
  objectives: Objective[];     // [] when no preset active
  presetSlug: string | null;   // null = free-play
}
```

`loadStack` defaults both fields when reading an older `world-stack.json`, so the existing save still loads. No migration script needed.

A new helper `applyPresetToStack(preset)` returns a fresh `WorldStack` with:
- `entries` ← `preset.objects`
- `threads` ← `[]`
- `objectives` ← `preset.objectives.map(text => ({ text, achieved: false }))`
- `presetSlug` ← preset's slug
- `turn`, `position`, `places` ← initial empty values

## Engine changes

### Narrator prompt

`formatStackForNarrator` adds two sections, included only when `presetSlug` is set:

```
MISSION BRIEFING (durable premise):
{preset body, loaded fresh from the file each turn}

OBJECTIVES:
[ ] Find the transmitter
[x] Restore power to the comm array
[ ] Send the distress signal
```

`NARRATOR_SYSTEM` gains two rules:

- *"If MISSION BRIEFING appears, it is the durable premise of this run. Don't contradict the setting (no trees on a lunar surface). Build on it."*
- *"If OBJECTIVES appear, surface them through the world — what the player encounters, what they notice — when their actions head that way. Don't list them at the player. The player solves; you describe."*

### Archivist schema

One new field:

```ts
achievedObjectiveIndices: number[]   // indices flipped to achieved THIS turn
```

`ARCHIVIST_SYSTEM` gains:

- *"You will be given the OBJECTIVES list. Return an index ONLY if THIS narrative passage explicitly depicts that objective being completed. 'Approached the transmitter' is not completion. 'The transmitter chimes back to life' is. When in doubt, return []. Do not invent indices outside the list."*

The server unions returned indices into the existing `objectives` array — once an objective is achieved, it stays achieved. Drift-proof against the small archivist model.

### Win detection

After every archivist turn:

```ts
const allDone = newStack.objectives.length > 0
  && newStack.objectives.every(o => o.achieved);
const justWon = allDone && !previouslyAllDone;
if (justWon) send({ type: "win" });
```

Pure server code, no model judgment. The LLM only ever flips individual checkboxes.

### Protocol changes

Replace the existing `reset` client message with:

```ts
| { type: "start"; presetSlug: string | null }   // null = empty world
| { type: "keep-exploring" }                     // null out presetSlug
```

`start` with a valid slug seeds a fresh stack from that preset and broadcasts a snapshot. `start` with `null` produces the existing empty-stack behaviour. `start` with an unknown slug emits an error and leaves the stack unchanged.

`keep-exploring` is a one-line server change: `presetSlug = null`, save, broadcast. Briefing stops being injected; the all-checked objectives stay visible in the log.

The `hello` snapshot response gains `presets: Array<{slug, title, description}>` so the client can render the menu without a second round-trip. It also gains `objectives` and `presetSlug` so the client knows whether to enable the `mission` button.

A new server-pushed message type `{ type: "win" }` exists. Stack updates also broadcast `objectives` so the inline objective-tick badges (below) work.

## UX flow

The current `reset` button in the action bar is replaced by two:

- **`new game`** — opens modal in *select* view.
- **`mission`** — opens modal in *briefing* view; greyed out when no preset is active.

The text commands `reset` and `start` go away — buttons are the surface.

A single modal component switches between three views.

### Select view

```
PICK A STORY

  🎲 Surprise me                              random preset
  Lunar Rescue          Stranded on the far side. Send the signal.
  Cellar of Glass       A locksmith's tomb beneath the cathedral.
  ...
  ─────────
  Empty world           No preset — make your own way.

  [cancel]
```

Click sends `start` with the chosen `presetSlug` (or `null`). On snapshot return, modal switches to *briefing* view automatically.

### Briefing view

Read-only display of the preset body and the objectives checklist with current state. The `mission` button toggles this open and closed.

### Win view

Auto-pops when the server sends `{ type: "win" }`. Same body as briefing view but with header `MISSION COMPLETE` and two buttons:

- `keep exploring` — sends `keep-exploring`, modal closes, player resumes in same world.
- `new game` — switches modal to *select* view.

### Auto-open on first connect

If the `hello` snapshot returns `presetSlug === null && turn === 0`, open the modal in *select* view automatically. Lands new users on the picker. Returning players with an in-progress run drop straight back into their world.

### Inline objective-tick badge

When the server's `stack-update` includes a newly-achieved objective, the client surfaces a small `SystemTurn`-style block in the narrative scroll:

```
  ✓ Objective complete: Find the transmitter
```

Reuses the existing `SystemBlock` component. The client compares previous and current `objectives` arrays to detect the flip.

## Testing

### `stack.test.ts`
- `loadStack` defaults `objectives: []` and `presetSlug: null` when reading an older save.
- `formatStackForNarrator` includes the briefing + objectives section when `presetSlug` is set, omits it when null.
- `applyPresetToStack(preset)` produces the expected shape.
- Unioning achieved indices is monotonic — already-achieved indices don't toggle off.

### `engine.test.ts`
- Archivist schema accepts `achievedObjectiveIndices: number[]` and rejects non-integer or out-of-range values.
- Narrator input contains `MISSION BRIEFING` and `OBJECTIVES` sections when the stack has a preset; omits them when not.

### `server.test.ts`
- `start` with a valid slug → snapshot reflects the seeded entries, objectives, presetSlug.
- `start` with `null` → empty stack.
- `start` with an unknown slug → error message, stack unchanged.
- `keep-exploring` → presetSlug becomes null, objectives unchanged, no other fields touched.
- Win detection: when the archivist's union flips the last unchecked index, server emits `{ type: "win" }` exactly once; subsequent turns don't re-emit.
- `hello` response includes `presets`, `objectives`, and `presetSlug`.

### `presets.test.ts` (new)
- Parsing a fixture file: frontmatter + body extracted correctly.
- Missing required frontmatter field throws with a clear error.
- Glob discovery returns slugs derived from filenames.

### Out of scope for unit tests
Whether the narrator actually honours the briefing and the archivist correctly identifies objective completion is LLM-quality territory and can't be unit-tested deterministically. Validate via the existing play-log iteration loop.

## Bundled presets

Three to start, chosen for setting diversity so the "every adventure feels the same" pull is broken on day one. Authored as part of this implementation and shipped in `presets/` alongside the engine changes:

- **Lunar Rescue** — astronaut, sci-fi, technical objectives.
- **Cellar of Glass** — fantasy, claustrophobic, exploration objectives.
- **The Last Train** — modern, time-pressured, social objectives (talk to passengers).

## Out of scope / future

- A preset editor UI for user-defined stories.
- Sharing presets between users (downloading from URL, importing a `.md` file).
- Hidden-then-revealed objectives (the "discovered log" hybrid considered during brainstorming).
- Auto-detection of when to "win" with a single fuzzy goal — discrete objectives sidestep this.
- Free-play "keep exploring" producing a different narrative tone now that the briefing is gone — accept current behaviour.
