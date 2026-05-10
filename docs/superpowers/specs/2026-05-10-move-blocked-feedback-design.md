# Move-Blocked Feedback — Design

## Problem

Interpreter only handles bare cardinals (`north`, `go east`). Anything
else — "walk to the lander", "head north toward the crater", "go to the
train", even "go north through the maintenance access door" — is
silently classified as `stay`. Narrator runs anyway, position never
updates, position-gated objectives never complete. Sonnet's playthrough
confirmed: 36 turns at `[1,0]`, infinite quest loop. The "movement is
broken" and "quests don't complete" reports are the same bug.

## Change

1. **Interpreter** — add a third class `move-blocked` (movement intent
   without a usable cardinal). Pure non-movement stays `stay`.
2. **Server** — on `move-blocked`, short-circuit: emit a single
   `move-blocked` message, skip narrator/archivist/TTS/image/play-log,
   stack unchanged. Move the `turn-start` send to *after* classification
   so no pending turn slot is created.
3. **UI** — render the block as a toast (reuse existing `Toast`
   component, new `kind: "blocked"` variant). Input box stays
   populated. No changes to the turn list.
4. **Provider switch** — new `INTERPRETER_PROVIDER` env (`local` |
   `gemini`), mirroring `NARRATOR_PROVIDER`. Gemini handles "go north
   through the maintenance access door" → `move-north` cleanly.
   Archivist stays local.

## Files

- `src/engine.ts` — extend enum, `InterpretedAction`, `VALID_ACTIONS`;
  update `INTERPRETER_SYSTEM` prompt with the new rule and a few
  examples.
- `src/api.ts` — add `INTERPRETER_PROVIDER` / `INTERPRETER_GEMINI_MODEL`
  constants + startup log line; add `callInterpreterStructured` (mirrors
  narrator pattern, no retry wrapper).
- `src/server.ts` — extend `ServerMessage` with `move-blocked`; reorder
  `turn-start`; add short-circuit branch after `interpreterTurn`.
- `src/web/app.tsx` — extend `ServerMessage`; toast handler in
  `onmessage` switch.
- `src/web/styles.css` — `kind: "blocked"` toast variant (slightly
  redder accent).
- `src/engine.test.ts`, `src/server.test.ts` — classification cases +
  short-circuit behaviour (no narrative, no log append).

## Toast copy

> Cardinal directions only — try `north`, `south`, `east`, or `west`.

10s auto-dismiss, matches archivist toast.

## Error handling

Interpreter throw (timeout, missing key) → existing `try/catch` in
`processInput` falls back to `{ action: "stay" }`. Deliberately not
`move-blocked` — transient failure shouldn't manifest as player-facing
input rejection.

## Out of scope

- "Return to the lander" / destination resolution — wait for the map.
- Inventory.
- Logging blocked attempts to `play-log.jsonl` — stays a record of real
  turns.
