# Room State — Design

**Status:** approved, ready for implementation plan
**Date:** 2026-05-15

## Goal

Stop room state from snapping back between turns. When the player snuffs a candle, the candle stays snuffed — next turn, three turns later, and after walking away and returning.

Today the archivist tracks state through free-form `entries: string[]` with prompt-driven supersession ("drop 'three candles flicker', add 'two candles flicker'"). The supersession is too soft: states get buried in prose, the narrator regenerates from atmospheric memory, and changes drift away within a few turns. The fix is a structured anchor — discrete objects with first-class `states[]` — keyed per-tile so old rooms remember themselves on return.

This work tacks onto the existing archivist call. No new LLM stage.

## Data Model

New type and constant in `src/stack.ts`:

```ts
type ObjectCategory = "item" | "fixture" | "feature" | "character";

interface RoomObject {
  name: string;            // canonical lowercase noun, e.g. "brass candle"
  states: string[];        // observable conditions, e.g. ["lit"], ["snuffed"], ["worn smooth"]
  location?: string;       // within-tile detail, e.g. "on oak desk" — preserved across state changes
  category: ObjectCategory;
}

const CATEGORY_PRIORITY: Record<ObjectCategory, "high" | "normal" | "low"> = {
  item: "high",        // pickup-able, often quest-relevant
  character: "high",   // NPCs always matter
  fixture: "normal",   // durable things attached to the room — candle, chest, lever
  feature: "low",      // immovable scenery — wall, floor, dust motes
};

const MAX_PLACE_OBJECTS = 10;
```

Extend `WorldStack`:

```ts
interface WorldStack {
  // ...existing fields...
  placeObjects: Record<string, RoomObject[]>;   // keyed by posKey, mirrors places{}
}
```

Per-tile cap is 10. Eviction is category-driven (see Safety Net), with active-objective anchors overriding to high priority.

## Archivist Changes

### Schema

`ARCHIVIST_SCHEMA` in `src/engine.ts` gains an `objects` field:

```ts
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
}
```

`ArchivistResult` gains `objects: RoomObject[]`.

### Input formatting (`formatStackForArchivist`)

Adds a `CURRENT TILE OBJECTS:` block listing the prior turn's objects with their states, locations, and categories. Omitted when the current tile has no prior objects:

```
CURRENT TILE OBJECTS:
- brass candle (fixture, on oak desk): lit
- brass key (item, on oak desk): worn smooth
- oak desk (feature): scratched

MUST INCLUDE: brass candle, brass key
```

The `MUST INCLUDE` line is computed server-side from active-objective anchors (reusing `locateObjectiveAnchor` from `stack.ts`) plus any nouns from unresolved threads. The line is included only when the pinned set is non-empty; otherwise omitted. For threads, a simple noun-extraction heuristic is acceptable — the safety net is the real guard, this is just a prompt-side hint.

### Prompt additions (`ARCHIVIST_SYSTEM`)

Add a new section after the existing entries/threads rules:

> **Rules for objects:**
> - Extract discrete physical things at the current tile: items the player could interact with, fixtures, features, characters. Each goes in `objects`.
> - Each object gets: `name` (canonical lowercase), `states` (observable conditions like "lit", "snuffed", "open", "broken"), optional `location` (within-tile placement), `category` (item / fixture / feature / character).
> - **Preserve states across turns** — the existing `CURRENT TILE OBJECTS` block shows what was true last turn. Keep states unchanged unless the new narrative depicts a state change. The default is keep.
> - **Update states when the narrative depicts a change.** Player snuffs the candle → `states: ["lit"]` becomes `["snuffed"]`. Player opens the chest → add "open". Don't accumulate contradictory states.
> - **Preserve `location` across state changes.** The desk is still the desk after the candle is snuffed.
> - **Categories:** `item` = pickup-able discrete object; `character` = NPC or creature; `fixture` = durable thing attached to the room (candle, chest, lever, painting); `feature` = immovable scenery (wall, floor, dust motes).
> - **Never emit objects describing the player.** The player's body, hair, eyes, innate appearance, and anything covered by PLAYER ATTRIBUTES is immutable session data — do not duplicate it as a room object. The player is the camera, not an object in the room.
> - **Max 10 objects per tile.** Prefer dropping `feature` over `fixture`, and drop fixtures with no recent state change before fixtures that just changed.
> - **MUST INCLUDE names cannot be dropped.** If the input says `MUST INCLUDE: brass candle`, the brass candle must be in your output.
> - Object updates apply only to the **current tile**. Do not invent objects from other tiles.

The existing entries/threads rules remain unchanged. Entries continue to carry non-object facts (ambient long-lived truths, relationships, distances). Some overlap with objects is acceptable; objects are the canonical source for state.

## Narrator Changes

### Input formatting (`formatStackForNarrator`)

New block, shown only for the current tile:

```
ROOM STATE:
- brass candle: lit (on oak desk)
- brass key: worn smooth (on oak desk)
- oak desk: scratched
- bookshelf: half-opened
```

Format: `- <name>: <states joined by ", "> (<location>)`. Location parenthesized when present, omitted when not. `category` is not shown to the narrator (archivist-internal). The block is omitted entirely when `placeObjects[posKey]` is missing or an empty array — typical on a tile's first visit.

### Prompt addition (`NARRATOR_SYSTEM`)

Add one new rule:

> **ROOM STATE is canonical.** If an object is listed with a state, the narrative MUST be consistent with that state. The candle is lit if and only if ROOM STATE says lit. Do not relight snuffed candles, re-close opened chests, or restore broken items. The player's actions change ROOM STATE through the archivist — never through your prose alone.

## Safety Net (post-archivist, deterministic)

After `archivistTurn` returns and before persisting the new stack, in `src/server.ts` or a new helper in `src/stack.ts`:

1. **Drop player-self-referential objects.** Filter out any returned object whose `name` starts with `your `, `player's `, or `the player's ` (case-insensitive). Defensive backup for the archivist prompt rule; player attributes are already canonical session data.
2. **Compute pinned set.** Extract anchor nouns from active objectives via `locateObjectiveAnchor`. Add nouns from unresolved threads (simple noun extraction or first-content-word heuristic — keep it cheap).
3. **Force-pin priority.** For each returned object, compute effective priority: `CATEGORY_PRIORITY[obj.category]`, upgraded to `"high"` if `obj.name` matches the pinned set.
4. **Restore missing pinned objects.** If a pinned name was present in the prior turn's `placeObjects[currentPosKey]` but is absent from the archivist's output, re-inject the prior entry verbatim and log `archivist dropped pinned object: <name>` so the rate is observable.
5. **Cap enforcement.** If `objects.length > MAX_PLACE_OBJECTS`, drop by (lowest effective priority, then objects with no state change this turn). Never drop high-priority objects via cap enforcement.

The safety net never invents objects the archivist didn't return. It only restores from prior state and re-weights existing entries.

## Persistence & Migration

- `placeObjects` is part of `WorldStack` and serializes to `world-stack.json` alongside `places`.
- Loader: if the field is missing from a saved file, default to `{}`. Old saves continue to work; per-tile object lists start empty and populate on subsequent archivist turns.
- The `MAX_PLACE_OBJECTS` and `CATEGORY_PRIORITY` constants are exported from `src/stack.ts` next to `MAX_STACK_ENTRIES` and `MAX_THREADS`.

If hot-tunable weights become necessary, `CATEGORY_PRIORITY` can be moved to a JSON config later. Constant is enough to start.

## Testing

**`src/stack.test.ts`**
- `WorldStack` round-trip preserves `placeObjects`.
- Loader treats missing `placeObjects` as `{}`.
- `formatStackForArchivist` includes `CURRENT TILE OBJECTS` and `MUST INCLUDE` blocks when applicable, omits both when the current tile has no prior objects and no pinned set.
- `formatStackForNarrator` includes the `ROOM STATE` block when present, omits it when the current tile has no objects.
- Safety-net helper unit tests:
  - Player-self-referential objects (`your hair`, `the player's eyes`) dropped before pinning runs.
  - Pinned object missing from archivist output → restored from prior state.
  - Cap enforcement drops feature before fixture before item.
  - High-priority objects never evicted by cap enforcement.

**`src/engine.test.ts`**
- Archivist schema accepts and parses the new `objects` field on a fixture response.
- `ArchivistResult.objects` is populated correctly.

**Manual integration (record in spec, run after implementation)**
- Snuff candle → archivist returns `states: ["snuffed"]` → narrator next turn does not relight.
- Walk three tiles away, return → candle still snuffed (state survives via `placeObjects[posKey]`).
- Cap stress: enter a richly-described room, take a turn that introduces an 11th object, confirm the dropped object is a low-priority feature, not a quest-relevant fixture.

## Out of Scope

- **Inventory / player-held items.** Separate problem ([[project_inventory_not_implemented]]). Carrying an item between tiles is not modeled by this design.
- **Wearables (clothes/armor put on or taken off).** The natural use case for tracking player-body state in room objects. Deferred alongside inventory — when that work happens, revisit whether wearables live in inventory, in a new player-body slot, or back in room objects with a relaxed filter.
- **Adjacent-tile state injection.** Geography drift ([[project_geography_drift]]) is a separate concern; this pass shows the narrator the current tile only.
- **Narrator emphasis weighting.** Importance only drives eviction. The narrator does not see category or priority.
- **Cross-tile state effects.** Snuffing one candle does not affect a distant hallway. Future work if it surfaces.
- **`player_body` category.** Tied to inventory/body-state work; not handled here.

## References

- [[feedback_llm_narrative_continuity]] — structural state anchors beat prompt tightening
- [[project_emergent_mechanics]] — narrator + archivist already produce state changes; this pass makes them stick
- [[project_archivist_quality_bugs]] — supersession-via-prose failure modes this design targets
- [[feedback_llm_stages_are_the_product]] — keep the three-stage loop; enrich a stage, don't add one
- [[project_geography_drift]] — sibling problem, intentionally out of scope
- [[project_inventory_not_implemented]] — sibling problem, intentionally out of scope
