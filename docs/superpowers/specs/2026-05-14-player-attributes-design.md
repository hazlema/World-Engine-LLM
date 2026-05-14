# Player Attributes — Design Spec

**Date:** 2026-05-14
**Status:** Approved, ready for implementation plan
**Scope:** Presets only (Empty World support is a separate v2 spec)

## Goal

Let preset authors declare immutable player attributes — species, descriptors, capabilities — that the narrator and archivist must honor as canonical. Solves the recurring "wizard refused magic" problem (the narrator denies player-declared abilities even when established in the briefing) by giving the engine a structured, scope-bounded place for player identity that runs adjacent to but separate from world entries. A wizard preset gets a `magic` attribute scoped to "can manipulate objects" — the narrator allows snap-a-tree-limb, denies teleport, with no per-narrator-model tuning.

## Non-goals

- Empty World UI for declaring attributes at session start. The runtime design supports this cleanly (attributes live on `WorldStack`, not on `Preset`), but the dialog and "saved adventures" UX is a separate v2 spec.
- Any in-app UI command (`/character`, briefing-card update). Visibility comes through gameplay — the narrator references attributes when relevant, and the per-turn image generator renders them visually. The preset file is the source of truth for the player.
- Mid-session attribute mutation. Attributes are loaded from preset at session start and frozen.
- Attributes that change over time (curses lifting, abilities unlocking). Would require archivist write access, which v1 explicitly forbids.
- Formalized precedence between positive and negative scope sub-bullets. The narrator judges in plain English; we don't try to encode "cannot beats can" as a rule.
- Per-attribute mechanics (cooldowns, costs, charges). Out of scope — this design carries identity, not gameplay systems.

## Architecture

One new optional field in preset frontmatter (`attributes:`) with hierarchical bullets. Parsed into a structured array. Stored on `WorldStack` at session start, frozen for the session. Read at three injection points each turn: the narrator prompt, the archivist prompt, and the image generator prompt.

The runtime is **source-agnostic**: nothing in the engine knows or cares that attributes came from a preset file specifically. A future v2 (Empty World dialog, saved adventures) will populate the same `WorldStack.attributes` field through a different code path without touching narrator/archivist/image plumbing.

## Preset format

The new optional field appears in the YAML-like frontmatter alongside existing fields:

```yaml
---
title: The Merlin Trial
description: A wizard's first labor.
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - striking auburn hair in a ponytail
  - magic
    - can manipulate objects
    - cannot manipulate time
objects:
  - oak staff with copper bands
  - locked apprentice's chest
objectives:
  - Open the chest @ 0,0
---
```

**Bullet structure:**
- Top-level bullets (2-space indent): each is one attribute. The text is the attribute's name.
- Sub-bullets (4-space indent): each is a scope/detail line under its parent attribute. Order is preserved.
- A top-level bullet with no sub-bullets is a bare attribute (e.g. a tattoo, a hair description) with no scope.
- Sub-bullets may be positive (`can ...`) or negative (`cannot ...`) — both are plain English the narrator judges in context.

**Authoring convention** (recommended, not enforced by the parser):
- Lead with what the player IS (`normal human abilities`, `vampire`, `werewolf`, `crow`). The narrator inherits common-sense expectations from the species name.
- Then descriptors (appearance, marks, accent).
- Then capabilities (`magic`, `prophecy`, `flight`).
- Sub-bullets narrow each: confirmations, additions, restrictions.

## Parsed shape

```typescript
type PlayerAttribute = {
  name: string;            // top-level bullet text, trimmed
  scope: string[];         // sub-bullets in order, trimmed; empty when no sub-bullets
};

interface Preset {
  // ... existing fields
  attributes: PlayerAttribute[];   // [] when frontmatter field is absent or empty
}
```

## Parser changes (`src/presets.ts`)

`parseFrontmatter` is extended to track indentation depth:

- Top-level list items (current behavior): `^  -\s+(.*)$` — 2 spaces, dash, space, content.
- Sub-list items (new): `^    -\s+(.*)$` — 4 spaces, dash, space, content. Sub-items attach to the most recent top-level item under the active list field.
- Sub-items are accepted **only** under the `attributes:` list. If a sub-item appears under `objects:` or `objectives:`, the parser throws with a clear error message naming the line.
- Sub-item before any top-level item: parser throws (orphaned sub-bullet).
- Tabs are rejected for indentation; only spaces. (Consistent with the current parser, which also assumes spaces.)

Validation:
- `attributes:` is optional. When absent, `Preset.attributes = []`.
- Empty attributes list (`attributes:` header with no bullets): treated as absent — `[]`, no prompt section emitted.
- Each top-level attribute name capped at 80 characters; longer throws with the line number.
- Sub-bullets are not individually length-capped (they may need to express conditional language).
- Soft cap: 10 sub-bullets per attribute. Above 10, parser throws — almost always a smell.
- No cap on top-level attribute count.
- Empty bullet text (e.g. `  - ` followed by whitespace) throws.

## Persistence (`src/stack.ts`)

`WorldStack` gets a new field:

```typescript
interface WorldStack {
  // ... existing fields
  attributes: PlayerAttribute[];   // empty array when no preset attributes
}
```

`applyPresetToStack(preset)` copies `preset.attributes` onto the new stack at session start. **No other code path writes to `stack.attributes`.** It is frozen for the session.

`parseStackJson` reads the new field. When loading older `world-stack.json` files that lack it, default to `[]` (no migration step needed; backward-compatible).

## Prompt injection — narrator (`src/stack.ts:formatStackForNarrator`)

When `stack.attributes.length > 0`, prepend a new section as the **first** part:

```
PLAYER ATTRIBUTES (immutable):
- normal human abilities
  - cannot lie
- tattoo of a dove on left shoulder
- striking auburn hair in a ponytail
- magic
  - can manipulate objects
  - cannot manipulate time
```

Then `MISSION BRIEFING` follows as today, then the rest of the existing sections in their current order.

When `stack.attributes` is empty, no section is emitted — the prompt looks identical to today's behavior.

## NARRATOR_SYSTEM revision (`src/engine.ts`)

The current line 24 plausibility rule:

> The player has the body of an ordinary mortal human. Flying, shapeshifting, teleporting, summoning, or any supernatural act does not happen unless an established entry explicitly grants that ability.

Becomes:

> When a `PLAYER ATTRIBUTES (immutable)` section is present, those attributes are the player's true nature. Honor them: capabilities listed there work; descriptions listed there are visible facts about the player. **Sub-bullets scope the parent attribute** — judge each player action against the parent's scope. If the action fits the scope, depict success. If it falls outside the scope (or hits a `cannot` line), the action fails in-character (the magic fizzles, the limb won't bend, the attempt comes back wrong). **Absence is denial**: anything not granted by an attribute is not available. When no `PLAYER ATTRIBUTES` section is present, the player has the body of an ordinary mortal human and supernatural acts do not happen unless an established entry grants them.

The rest of the narrator system prompt is untouched.

## Prompt injection — archivist (`src/stack.ts:formatStackForArchivist`)

Same `PLAYER ATTRIBUTES (immutable):` section, prepended as the first part when `stack.attributes.length > 0`. Identical formatting to the narrator section.

## ARCHIVIST_SYSTEM addition (`src/engine.ts`)

One new rule, inserted near the top of the existing rules block (after the section that introduces entries):

> **Player attributes are immutable session data.** When you see a `PLAYER ATTRIBUTES (immutable)` section, do NOT add entries that paraphrase or restate any attribute. Do NOT add entries describing the player's species, appearance, or innate capabilities — those are already canonical. Extract entries about the world and what changed in it; the player's identity is fixed.

## Image generator integration (`src/gemini-image.ts`)

`generateImage` gets a new optional parameter:

```typescript
export async function generateImage(
  narrative: string,
  style: ImageStyle = DEFAULT_IMAGE_STYLE,
  playerAttributes?: PlayerAttribute[],          // new
): Promise<Buffer>
```

When `playerAttributes` is non-empty, a new block is added to the constructed prompt before "Scene:":

```
Player character details (apply only if the player figure appears in frame):
- striking auburn hair in a ponytail
- tattoo of a dove on left shoulder
[... and any other visually-renderable attributes]
```

The "apply only if the player figure appears in frame" guard is deliberate — most narratives are POV from the player and the player isn't visible. The model decides per-frame whether to apply the details.

**v1 behavior**: pass *all* attributes through. The model decides what's visual ("striking auburn hair") versus what's not ("can manipulate objects"). The image style and "no text/captions" rules stay identical.

**Expected to iterate**: this prompt wording will likely need refinement once we see real Nano Banana outputs. Specifically, attribution to the player vs NPCs in multi-figure scenes is the area most likely to need tuning.

The route handler in `src/server.ts` (`/api/image`) reads `currentStack.attributes` and passes it through to `generateImage`. No frontend change.

## Backward compatibility

- All existing presets work unchanged. The 3 in `presets/` (cellar-of-glass, lunar-rescue, the-last-train) have no `attributes:` field, so `Preset.attributes` is `[]`, no prompt section is emitted, the narrator's hardcoded "ordinary mortal human" fallback (the second sentence of the revised rule) does its job exactly as today.
- Old `world-stack.json` files load with `attributes: []`. No migration step.
- `generateImage` callers without the new parameter behave exactly as today.

## Testing

`src/presets.test.ts` (extensions):
- Hierarchical-bullet happy path: parses the example above, returns the expected `PlayerAttribute[]`.
- Bare top-level attribute (no sub-bullets) → `{ name, scope: [] }`.
- Sub-bullet under `objects:` or `objectives:` → throws with the line.
- Sub-bullet before any top-level bullet → throws.
- Empty bullet → throws.
- Missing `attributes:` → `Preset.attributes === []`.
- `attributes:` header with no bullets → `Preset.attributes === []`.
- 11+ sub-bullets under one attribute → throws.

`src/stack.test.ts` (extensions):
- `applyPresetToStack` copies `preset.attributes` to the new stack.
- Stack JSON round-trip preserves `attributes`.
- Loading a stack JSON without an `attributes` field defaults to `[]`.
- `formatStackForNarrator` includes the `PLAYER ATTRIBUTES (immutable):` section as the first part when populated.
- `formatStackForNarrator` omits the section when `attributes` is empty.
- `formatStackForArchivist` includes/omits the same way.

`src/engine.test.ts` (snapshot extension or new):
- Snapshot the narrator user message for a stack with attributes; confirm the section sits at the top with correct indentation.

`src/gemini-image.test.ts` (new file — image generation has no test coverage today; this work creates the file):
- When `playerAttributes` is non-empty, the constructed prompt contains the "Player character details (apply only if the player figure appears in frame):" block followed by the attribute lines.
- When `playerAttributes` is empty or undefined, the prompt is identical to today's behavior (no new block).
- Test by stubbing `@google/genai`'s `GoogleGenAI` to capture the prompt string passed to `generateContent`; assert on the prompt text rather than on a real image response.

## Documentation

- `presets/cellar-of-glass.md` (or whichever existing preset is most pedagogical) gets a commented `attributes:` example showing the format. Optional field, doesn't change the preset's behavior.
- README's *Stories / presets* section gets a short paragraph plus a code-block example showing the new field. Note that it's optional and that absence preserves current behavior.
- A new bundled preset `presets/merlin-trial.md` (or similar) ships demonstrating the system end-to-end with a wizard character — gives a fresh user something concrete to play with the new feature.

## Verification command

`bun test && bunx tsc --noEmit` after each commit.

## Out of scope (future work)

- Empty World UI: dialog at session start showing "last used adventures" with editable attributes (separate v2 spec).
- Saved adventures persistence: a new `adventures/<name>.json` shape distinct from presets, populated through the Empty World dialog (paired with the above).
- Attribute mutation during play (curses, ability unlocks). Requires archivist write path; intentionally forbidden in v1.
- A `/character` UI command. Visibility comes through the narrator and per-turn images.
- Per-attribute mechanics (cooldowns, charges). Out of scope — identity, not gameplay systems.
