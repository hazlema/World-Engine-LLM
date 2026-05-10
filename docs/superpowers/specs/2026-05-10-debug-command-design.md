# /debug Command — Design

**Date:** 2026-05-10
**Status:** Approved (pending implementation plan)

## Motivation

A 2026-05-09 Opus playthrough surfaced an objective-completion bug: the player entered the train car, found the satchel, identified its owner — and the matching objective never ticked. The archivist's `achievedObjectiveIndices` for that turn evidently came back empty, but we have no record of what the archivist actually proposed. Today's per-turn debug surface (`> debug: x:N y:N` inline under each turn) only shows position.

We need a richer diagnostic view to investigate failures like this, and the inline line is the wrong place for it — too cramped for "lots of info," and clutters the chat.

## Goals

- Replace the inline per-turn debug line with a richer on-demand view triggered by typing `/debug` in the chatbox.
- Surface enough state and last-turn pipeline detail to diagnose archivist misfires (objectives not ticking, vanishing entities, contradictions).
- Establish a slash-command pattern that future commands (`/help`, `/reset`, etc.) can slot into without redesign.

## Non-Goals

- Per-turn replay across the full session (Option B from brainstorming) — last turn only is sufficient for the immediate need.
- Persisting trace data across server restarts (e.g., extending `play-log.jsonl` with archivist raw output).
- State-editing tools (manually ticking an objective from the modal).
- A generic slash-command framework with help text, autocomplete, command discovery — defer until a second command exists.

## Architecture

### Slash-command intercept (client)

Where input is sent today, the client checks if the trimmed input starts with `/`. If so, route to a small slash-command handler instead of `socket.send({type: "input", ...})`. No WebSocket roundtrip, no LLM calls, no turn counter increment.

```
input "look around"  → existing path: send("input")
input "/debug"       → slash handler → open DebugModal
input "/something"   → slash handler → unknown-command toast
```

The handler is a single `switch` on the command name. Adding a new command later is one case.

### Last-turn trace (server)

The server holds an in-memory `lastTurnTrace` updated after each turn pipeline run. It is overwritten each turn. Lost on server restart. No file persistence.

Shape:

```ts
interface LastTurnTrace {
  ts: string;             // ISO timestamp
  turn: number;
  input: string;          // raw player input
  interpreter: {
    action: string;       // "move-north" | "move-blocked" | "look" | etc.
    provider: "local" | "gemini";
  };
  archivist: {
    entries: string[];               // raw entries returned this turn
    threads: string[];               // raw threads returned this turn
    achievedObjectiveIndices: number[];
    moved: boolean;
    locationDescription: string;
  } | null;                          // null if archivist errored / was skipped
  error?: { source: "narrator" | "archivist"; message: string };
}
```

Captured in the same `handleInput` flow in `src/server.ts` that already calls `interpreterTurn` (~L110), `narratorTurn` (~L129), and `archivistTurn` (~L161). Trace assembly happens just before `appendPlayLog` (~L196) and the `stack-update` push (~L199).

### Provider info

Surfaced in the existing snapshot (and refreshed after settings changes if any are wired up later). Read from env at boot:

```ts
interface ProviderInfo {
  narrator: { provider: string; model: string };
  interpreter: { provider: "local" | "gemini" };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
}
```

### Wire format

Two new `ServerMessage` variants:

```ts
| { type: "providers"; providers: ProviderInfo }
| { type: "debug-trace"; trace: LastTurnTrace }
```

`providers` is sent once on connect (alongside or after `snapshot`). `debug-trace` is pushed after each `stack-update`, so the client always has the latest trace cached and the modal opens instantly.

The client keeps the most recent `debug-trace` (and `providers`) in module-level state for the modal to read.

## Components

### Client

- **Slash handler** — small module (e.g., `src/web/slash.ts`) exporting `handle(text): { handled: boolean }`. Dispatches `/debug` → open modal. Returns `handled: false` for non-slash text so the caller falls through to the WS send.
- **DebugModal** — React component, 80%-width modal overlay, dismiss on Escape or backdrop click. Two-column layout (live state | last turn). Accessible via the existing modal pattern (or styled to match if none exists yet).
- **Removal** — delete the inline `<p className="turn-debug">…</p>` block in `src/web/app.tsx:901`.

### Server

- **Trace capture** — extend the turn pipeline to capture interpreter/archivist raw output into a module-level `lastTurnTrace` variable.
- **Provider snapshot** — assemble `ProviderInfo` once at startup from env and constants.
- **Wire emissions** — send `providers` on connect, `debug-trace` after each `stack-update` (and on initial snapshot if a trace exists from a prior turn — typically empty until first input).

## Data Flow

```
Player types "/debug"
  ↓ (client intercept)
DebugModal reads cached snapshot + providers + lastTrace from module state
  ↓
Renders two-column view
  ↓ Escape / backdrop click
Modal closes
```

Versus a normal turn:

```
Player types "look around"
  ↓ WS: input
Server: interpreter → narrator → archivist
  ↓ updates lastTurnTrace
Server: WS push → snapshot/stack-update → debug-trace
  ↓
Client caches debug-trace; UI updates as today
```

## Modal Contents

**Left column — Live state (from current snapshot):**

- Position `[x, y]` + place key (e.g. `-1,0`)
- Canonical place description for current tile (`places[posKey]`)
- Active objectives — index, achieved ✓/✗, text, position if any
- Distant objectives — same plus travel hint (`travelHint(here, obj.position)`)
- Stack entries — all (currently capped at 25)
- Threads — all (capped at 10)
- Turn count
- Preset slug
- Providers — narrator/interpreter/TTS/image (provider + model/voice/style)

**Right column — Last turn pipeline trace:**

- Player input (raw)
- Interpreter: action classification + provider
- Archivist raw output (JSON): entries, threads, achievedObjectiveIndices, moved, locationDescription
- Effective change summary: "added N entries, completed objective #i, moved from `[a,b]` → `[c,d]`"
- Any per-turn error (narrator or archivist)

If `lastTrace` is null (no turn has run yet this session), the right column shows a placeholder: "No turns yet — play a turn to see pipeline trace."

## Error Handling

- **Server-side trace capture failure** — wrap the trace assembly so a bug in trace formatting can never break the turn pipeline. If trace assembly throws, log and skip the `debug-trace` push for that turn.
- **Modal opened with no cached trace** — render the placeholder; never crash.
- **Unknown slash command** — small inline toast ("unknown command: /foo"); leave the input populated so the player can correct.

## Testing

- Unit: slash handler returns `handled: true` for `/debug` and known commands, `handled: false` for plain text and `/unknown`.
- Unit: server-side trace shape matches `LastTurnTrace` after a synthetic interpreter+archivist run; null archivist when archivist errors.
- Integration (server.test.ts): on a normal turn, server emits `debug-trace` after `stack-update` with the expected fields. On a `move-blocked` turn, trace shows the interpreter action and null archivist.
- Manual: open `/debug` modal mid-game, verify both columns populate; close, replay a turn, reopen, verify trace updated.

## Open Questions

None at this point. Implementation plan can proceed.
