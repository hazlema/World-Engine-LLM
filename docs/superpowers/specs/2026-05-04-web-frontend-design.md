# World Engine — Web Frontend Design

**Date:** 2026-05-04
**Status:** Approved (pending user re-read)

## Goal

Add a browser-based UI for the World Engine, alongside the existing CLI. The frontend renders each turn as a stacked block (image placeholder + narrative text), provides quick-action buttons for common commands, and uses a Neo-Noir Terminal aesthetic. Designed so a future image-generation pass can drop in without further architectural changes.

## Architecture

The existing engine is UI-agnostic — `narratorTurn` and `archivistTurn` know nothing about how their input/output is delivered. The web frontend is a new entry point that calls the same engine.

```
src/
  api.ts          (existing, unchanged)
  stack.ts        (existing, unchanged)
  engine.ts       (existing, unchanged)
  main.ts         (existing — CLI entry point, stays as parallel surface)
  server.ts       (NEW — Bun.serve hosting frontend + WebSocket)
  web/
    index.html    (NEW — single-page entry)
    app.tsx       (NEW — React frontend)
    styles.css    (NEW — Neo-Noir tokens)
```

Both `main.ts` and `server.ts` are valid entry points. `bun src/main.ts` runs the CLI; `bun src/server.ts` runs the web server.

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/server.ts` | Create | `Bun.serve` with HTML import + WebSocket handler. Holds the `WorldStack` in process memory; persists via `saveStack` after each turn. |
| `src/web/index.html` | Create | Bun HTML entry point. Imports `app.tsx` and `styles.css`. |
| `src/web/app.tsx` | Create | React app. Manages WebSocket connection, turn list state, input handling, button bar. |
| `src/web/styles.css` | Create | Neo-Noir design tokens as CSS custom properties + component styles. |
| `package.json` | Modify | Add `react`, `react-dom`, `@types/react` as dependencies. |

## WebSocket Protocol

Single connection per browser tab. JSON messages over WebSocket. The server holds the world stack in memory; messages stream events.

**Client → Server:**
```typescript
{ type: "input", text: string }      // player typed/clicked an action
{ type: "reset" }                    // wipe the world
{ type: "hello" }                    // initial connect; server sends snapshot
```

**Server → Client:**
```typescript
{ type: "snapshot", turn: number, entries: string[], threads: string[] }
{ type: "turn-start", input: string }                 // echo player input as new turn
{ type: "narrative", text: string }                   // narrator output
{ type: "stack-update", entries: string[], threads: string[] }
{ type: "error", source: "narrator" | "archivist", message: string }
```

**Future-ready** — adding `{ type: "image", turnId: number, url: string }` later requires no protocol restructuring.

The server's turn handler:
1. Receives `input`, sends `turn-start`
2. Calls `narratorTurn`, sends `narrative` (or `error` and bails)
3. Calls `archivistTurn`, sends `stack-update` (or `error` warning, keeps old stack)
4. Persists stack via `saveStack`

## UI Components

### Layout

- 800px max-width centered column on a `surface` background.
- Vertical stack of **Turn blocks**, newest at bottom (chronological).
- Sticky action bar fixed to bottom: input field + button row.
- Auto-scroll to latest turn after each `narrative` event.

### Turn Block

```
┌──────────────────────────────────────────┐
│ [Image  ]  TURN #03                      │
│ [128px  ]  > look around                 │
│ [square ]                                 │
│            The damp earth yields beneath │
│            your fingers, cool and heavy… │
└──────────────────────────────────────────┘
```

- 1px charcoal border (`outline-variant`), 0 corner radius.
- `padding: 1.5rem`, `gap: 2rem` between image and text column.
- **Image area** — 128×128px placeholder (1px charcoal border, "scanline" gradient fill or simply empty cyan-tinted void). Sized so the future image pass slots in directly.
- **Header** — `Turn #N` in cyan terminal-header style; `> player input` below in cyan terminal-code.
- **Narrative** — Newsreader 20px, line-height 1.7. Cream text on dark.

### Input + Action Bar (sticky bottom)

- Cyan `>` prompt prefix, then text input. Enter submits.
- Below input: horizontal row of buttons. Click sends that text immediately as if typed.
- Default button set: `look around`, `wait`, `inventory`, `north`, `south`, `east`, `west`. Edit list in `app.tsx`.
- Buttons are sharp 0-radius rectangles, 1px cyan border, uppercase Space Grotesk. Subtle cyan glow on hover/active.

### System Commands

These bypass the LLM and render inline as system messages in the turn stream:
- `stack` — show world entries
- `threads` — show active threads
- `reset` — wipe world (with confirm prompt in UI)
- `help` — show commands

Detected client-side; do not round-trip to the LLM.

## Design Tokens

Direct mapping from the Neo-Noir Terminal spec the user provided. Implemented as CSS custom properties on `:root`.

```css
:root {
  --surface: #131314;
  --surface-container: #201f20;
  --on-surface: #e5e2e3;
  --primary: #00f2ff;          /* neon cyan */
  --secondary: #b600f8;        /* electric violet */
  --outline: #849495;
  --outline-variant: #3a494b;
  /* ...rest of palette */
}
```

Typography:
- `--font-narrative: "Newsreader", serif;` for prose
- `--font-terminal: "Space Grotesk", sans-serif;` for chrome
- Loaded via `<link>` to Google Fonts in `index.html`

Sharp corners everywhere (`border-radius: 0`). Cyan glow via `box-shadow: 0 0 8px rgba(0, 242, 255, 0.3)` on focused/active elements.

## State Model (frontend)

```typescript
type Turn = {
  id: number;        // monotonic
  input: string;     // player input
  narrative?: string; // arrives async
  imageUrl?: string;  // arrives async (future)
  error?: string;    // narrator failure
};

type AppState = {
  connected: boolean;
  turns: Turn[];
  stack: { entries: string[]; threads: string[]; turn: number };
  pending: boolean; // currently awaiting server response
};
```

Each `turn-start` from server creates a new Turn with placeholder. Each `narrative` fills it in. Each `stack-update` updates the side state.

## Persistence & Sessions

**v1: single user.** The server process holds one `WorldStack` in memory, loaded from `world-stack.json` on startup, saved on every archivist turn. All connected browser tabs share the same world (same as if they were one player).

**v2 (future, when deploying to VPS):** session keying. Each WebSocket gets a session ID; world stack becomes a Map<sessionId, WorldStack>. Out of scope for this spec but the protocol already supports it (no message changes needed).

## Out of Scope (future work)

- Image generation (the polaroid fade-in mentioned earlier)
- Multi-user / per-session worlds
- Auth / user accounts
- Mobile-responsive layout (desktop-first for now)
- Streaming narrative tokens as they arrive (returns full text per turn)
- Virtualization for sessions with hundreds of turns

## Testing Strategy

- Unit-test `server.ts`'s message handler logic (mockable around `engine.ts`)
- Manual verification of UI in browser
- No frontend unit tests for v1 — UI is glue, verified visually
