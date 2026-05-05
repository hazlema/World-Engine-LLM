# World Engine — Refactor Design

**Date:** 2026-05-04
**Status:** Approved

## Problem

The prototype (`adventure.ts`) works on turn 1 but produces silent blank output on subsequent turns. Root causes:

1. Narrator and archivist share one try/catch — an archivist failure can mask which pass failed and leaves the loop in an undefined state.
2. No timeout on `fetch` — a hung API call stalls the loop indefinitely.
3. No guard on empty narrator response — the model silently returns `""` when the ESTABLISHED WORLD context is present; the game prints a blank line and re-asks with no indication of failure.
4. File I/O uses `node:fs` — should use `Bun.file` / `Bun.write` per project conventions.

## Approach: 4-file module split

Single `adventure.ts` → `src/api.ts`, `src/stack.ts`, `src/engine.ts`, `src/main.ts`.

Each module has one responsibility and communicates through explicit imports. Entry point: `bun src/main.ts`.

## File Layout

```
adventure/
  src/
    api.ts       HTTP layer — callModel(), timeout, raw-log on failure
    stack.ts     WorldStack type, load/save/format, Bun.file I/O
    engine.ts    Narrator + Archivist prompts and turn functions
    main.ts      readline loop, commands, banner
  adventure.ts   (deleted — replaced by src/main.ts)
  world-stack.json
  package.json
  tsconfig.json
```

## Module Designs

### `src/api.ts`

Two exports, two endpoints.

**`callModel(systemPrompt, input): Promise<string>`** — uses `/api/v1/chat`
- `AbortController` + `setTimeout(15_000)` — throws `"API timeout"` on expiry
- Non-OK HTTP status → throws with status + body text
- Missing `message` block in output array → throws `"No message in response"`
- JSON parse failure → logs raw body to stderr, then rethrows
- Used by narrator

**`callModelStructured<T>(systemPrompt, input, schema): Promise<T>`** — uses `/v1/chat/completions`
- Same 15s timeout + error handling
- Passes `response_format: { type: "json_schema", json_schema: { name, schema } }`
- Extracts from `choices[0].message.reasoning_content || choices[0].message.content`
  (model routes constrained output to `reasoning_content` regardless of effort setting)
- Logs raw before JSON parse failure, then rethrows
- Used by archivist

No global state; both are pure functions.

### `src/stack.ts`

Exports:
- `WorldStack` interface: `{ entries: string[]; turn: number }`
- `loadStack(): Promise<WorldStack>` — reads `world-stack.json` via `Bun.file`; returns `{ entries: [], turn: 0 }` on missing or corrupt file
- `saveStack(stack: WorldStack): Promise<void>` — writes via `Bun.write`
- `formatStackForNarrator(stack: WorldStack): string` — returns `"ESTABLISHED WORLD:\n- …\n\n"` or `""` when empty
- `formatStackForArchivist(stack: WorldStack): string` — returns `"CURRENT STACK:\n- …\n\n"` or `"CURRENT STACK: (empty)\n\n"`

No LLM calls, no readline — pure data layer.

### `src/engine.ts`

Exports NARRATOR_SYSTEM and ARCHIVIST_SYSTEM prompt constants, plus:

- `narratorTurn(stack: WorldStack, input: string): Promise<string>`
  - Builds narrator input via `formatStackForNarrator`
  - Calls `callModel`
  - **Throws if result is empty** — empty string is the current silent-failure bug
- `archivistTurn(stack: WorldStack, narrative: string): Promise<WorldStack>`
  - Builds archivist input via `formatStackForArchivist`
  - Calls `callModelStructured<{ entries: string[] }>` with schema:
    `{ entries: { type: "array", items: "string", maxItems: 25 } }`
  - Returns `{ entries: result.entries.slice(0, 25), turn: stack.turn + 1 }`
  - No bullet parsing — schema guarantees structure

### `src/main.ts`

Readline loop and command dispatcher.

**Resilient turn structure (core bug fix):**

```typescript
try {
  narrative = await narratorTurn(stack, input);
  print(narrative);
} catch (err) {
  console.error("[narrator error]", err);
  ask(); return;
}

try {
  stack = await archivistTurn(stack, narrative);
  await saveStack(stack);
} catch (err) {
  console.warn("[archivist failed — keeping old stack]", err);
}

ask();
```

Archivist failure is a warning: the player never sees it, the world continues with the previous stack.

**Commands:** `stack`, `reset`, `help`, `quit` — unchanged from prototype.

## Bug Fixes Applied

| Fix | Where |
|-----|-------|
| Separate try/catch for narrator vs archivist | `main.ts` |
| 15s fetch timeout via AbortController | `api.ts` |
| Empty narrator response → throw, not silent blank | `engine.ts` |
| Raw response logged before JSON parse failure | `api.ts` |
| `node:fs` → `Bun.file` / `Bun.write` | `stack.ts` |
| Archivist uses structured JSON output (no bullet parsing) | `api.ts` + `engine.ts` |
| Archivist switches to `/v1/chat/completions` for schema support | `api.ts` |

## Future Features (out of scope for this implementation)

- **Loose direction / world seed** — a way to nudge the world's tone or setting at session start (e.g., a short phrase injected into the initial stack before turn 0)
- **Goals and rewards** — archivist-tracked objectives; narrator acknowledges when they resolve
- **Second model for archivist** — the endpoint supports multiple models; a lighter model could run archivist to save tokens
- **Web UI** — `Bun.serve()` wrapper around the engine for a browser-based play surface

These are natural extensions of the stack-based architecture and do not require structural changes to what's designed here.

## Out of Scope

- Streaming output
- Multi-player / shared world
- Prompt tuning beyond what's in the spec
