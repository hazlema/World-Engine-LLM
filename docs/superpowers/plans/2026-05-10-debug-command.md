# /debug Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline `> debug: x:N y:N` line with a `/debug` slash command that opens a modal showing live world state and last turn's pipeline trace (interpreter classification + archivist raw output).

**Architecture:** Client intercepts `/debug` before WS send and opens a modal that reads cached snapshot, providers info, and last-turn trace. Server holds an in-memory `lastTurnTrace` updated each turn and pushes it as a new `debug-trace` WS message after each `stack-update`. Provider info is sent once on snapshot.

**Tech Stack:** TypeScript, React, Bun (`bun test`), WebSocket via `Bun.serve`.

---

## File Structure

**Create:**
- `src/web/slash.ts` — pure `parseSlashCommand(text)` parser (testable in isolation).
- `src/web/slash.test.ts` — unit tests for the parser.

**Modify:**
- `src/server.ts` — add `LastTurnTrace` / `ProviderInfo` types, capture trace in `processInput`, extend `ServerMessage` union, push `debug-trace` after each turn, include `providers` in `snapshot`.
- `src/server.test.ts` — assert `debug-trace` emission shape on normal turn and on `move-blocked`.
- `src/web/app.tsx` — add `"debug"` modal variant, `DebugModal` component, providers/lastTrace state, intercept `/debug` in `send()`, remove inline `<p className="turn-debug">` (line 901), unknown-command toast.
- `src/web/styles.css` — minor additions for the two-column debug modal layout (only if needed).

**Out of scope:** persisting traces across restarts, generic slash-command framework, state-editing tools, full-history per-turn replay.

---

## Task 1: Server — `LastTurnTrace` types and capture

**Files:**
- Modify: `src/server.ts:38-63` (extend `ServerMessage` union)
- Modify: `src/server.ts:100-214` (extend `processInput` to capture trace)
- Test: `src/server.test.ts` (new test)

- [ ] **Step 1: Write the failing test for trace emission on a normal turn**

Append to `src/server.test.ts`:

```ts
test("processInput: emits debug-trace after stack-update on normal turn", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You walk north.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["a tall pine"],
    threads: ["who carved the pine?"],
    turn: 1,
    moved: true,
    locationDescription: "A clearing under tall pines.",
    achievedObjectiveIndices: [2],
  }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "north", (m) => messages.push(m));

  const stackUpdateIdx = messages.findIndex((m) => m.type === "stack-update");
  const traceIdx = messages.findIndex((m) => m.type === "debug-trace");

  expect(stackUpdateIdx).toBeGreaterThanOrEqual(0);
  expect(traceIdx).toBeGreaterThan(stackUpdateIdx);

  const trace = messages[traceIdx];
  if (trace.type !== "debug-trace") throw new Error("type guard");
  expect(trace.trace.input).toBe("north");
  expect(trace.trace.interpreter.action).toBe("move-north");
  expect(trace.trace.archivist).toEqual({
    entries: ["a tall pine"],
    threads: ["who carved the pine?"],
    achievedObjectiveIndices: [2],
    moved: true,
    locationDescription: "A clearing under tall pines.",
  });
  expect(trace.trace.error).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server.test.ts -t "emits debug-trace"`
Expected: FAIL — `debug-trace` not in `ServerMessage` union; no such message emitted.

- [ ] **Step 3: Add types and constants to `src/server.ts`**

Insert near the top of the file, after the `appendPlayLog` function (around line 30):

```ts
export interface InterpreterTrace {
  action: string;
  provider: "local" | "gemini";
}

export interface ArchivistTrace {
  entries: string[];
  threads: string[];
  achievedObjectiveIndices: number[];
  moved: boolean;
  locationDescription: string;
}

export interface LastTurnTrace {
  ts: string;
  turn: number;
  input: string;
  interpreter: InterpreterTrace;
  archivist: ArchivistTrace | null;
  error?: { source: "narrator" | "archivist"; message: string };
}

let lastTurnTrace: LastTurnTrace | null = null;
export function getLastTurnTrace(): LastTurnTrace | null {
  return lastTurnTrace;
}

function interpreterProvider(): "local" | "gemini" {
  return process.env.INTERPRETER_PROVIDER === "gemini" ? "gemini" : "local";
}
```

- [ ] **Step 4: Add `debug-trace` to `ServerMessage` union**

In `src/server.ts`, extend the `ServerMessage` union (around line 38) to include:

```ts
  | { type: "debug-trace"; trace: LastTurnTrace }
```

- [ ] **Step 5: Capture and emit trace in `processInput`**

In `src/server.ts`, update `processInput` (around line 100-214). Add trace capture and emission after the `stack-update` send (around line 198-204):

Wrap trace assembly in try/catch so a formatting bug never breaks the turn pipeline. Replace the existing `send({ type: "stack-update", ... })` block with:

```ts
  send({
    type: "stack-update",
    entries: newStack.entries,
    threads: newStack.threads,
    objectives: newStack.objectives,
    position: newStack.position,
  });

  try {
    lastTurnTrace = {
      ts: new Date().toISOString(),
      turn: archived.turn,
      input,
      interpreter: { action: action.action, provider: interpreterProvider() },
      archivist: {
        entries: archived.entries,
        threads: archived.threads,
        achievedObjectiveIndices: archived.achievedObjectiveIndices,
        moved: archived.moved,
        locationDescription: archived.locationDescription,
      },
    };
    send({ type: "debug-trace", trace: lastTurnTrace });
  } catch (err) {
    console.error("[debug-trace] capture failed:", err);
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/server.test.ts -t "emits debug-trace"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): capture LastTurnTrace and emit debug-trace WS message"
```

---

## Task 2: Server — `move-blocked` trace emission

**Files:**
- Modify: `src/server.ts:115-118` (move-blocked short-circuit)
- Test: `src/server.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Append to `src/server.test.ts`:

```ts
test("processInput: emits debug-trace with null archivist on move-blocked", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "go through wall", (m) => messages.push(m));

  const traceMsg = messages.find((m) => m.type === "debug-trace");
  expect(traceMsg).toBeDefined();
  if (traceMsg?.type !== "debug-trace") throw new Error("type guard");
  expect(traceMsg.trace.input).toBe("go through wall");
  expect(traceMsg.trace.interpreter.action).toBe("move-blocked");
  expect(traceMsg.trace.archivist).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server.test.ts -t "null archivist on move-blocked"`
Expected: FAIL — no `debug-trace` emitted on the short-circuit path.

- [ ] **Step 3: Emit trace on the move-blocked short-circuit**

In `src/server.ts`, replace the move-blocked block (around line 115-118):

```ts
  if (action.action === "move-blocked") {
    send({ type: "move-blocked", input });
    try {
      lastTurnTrace = {
        ts: new Date().toISOString(),
        turn: stack.turn,
        input,
        interpreter: { action: action.action, provider: interpreterProvider() },
        archivist: null,
      };
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (err) {
      console.error("[debug-trace] capture failed:", err);
    }
    return stack;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server.test.ts -t "null archivist on move-blocked"`
Expected: PASS.

- [ ] **Step 5: Run the full test file to confirm no regression**

Run: `bun test src/server.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): emit debug-trace on move-blocked with null archivist"
```

---

## Task 3: Server — narrator/archivist error trace

**Files:**
- Modify: `src/server.ts:127-165` (error short-circuit branches)
- Test: `src/server.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Append to `src/server.test.ts`:

```ts
test("processInput: emits debug-trace with error when archivist throws", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "You stand still.");
  archivistSpy.mockImplementationOnce(async () => { throw new Error("boom"); });

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "wait", (m) => messages.push(m));

  const traceMsg = messages.find((m) => m.type === "debug-trace");
  expect(traceMsg).toBeDefined();
  if (traceMsg?.type !== "debug-trace") throw new Error("type guard");
  expect(traceMsg.trace.archivist).toBeNull();
  expect(traceMsg.trace.error?.source).toBe("archivist");
  expect(traceMsg.trace.error?.message).toContain("boom");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server.test.ts -t "error when archivist throws"`
Expected: FAIL — no `debug-trace` emitted on the archivist-error path.

- [ ] **Step 3: Emit trace on narrator + archivist error branches**

In `src/server.ts`, replace the narrator try/catch (around line 127-134):

```ts
  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input, briefing);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    const message = String(err);
    send({ type: "error", source: "narrator", message });
    try {
      lastTurnTrace = {
        ts: new Date().toISOString(),
        turn: stack.turn,
        input,
        interpreter: { action: action.action, provider: interpreterProvider() },
        archivist: null,
        error: { source: "narrator", message },
      };
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (e) {
      console.error("[debug-trace] capture failed:", e);
    }
    return stack;
  }
```

And replace the archivist try/catch (around line 159-165):

```ts
  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    const message = String(err);
    send({ type: "error", source: "archivist", message });
    try {
      lastTurnTrace = {
        ts: new Date().toISOString(),
        turn: stack.turn,
        input,
        interpreter: { action: action.action, provider: interpreterProvider() },
        archivist: null,
        error: { source: "archivist", message },
      };
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (e) {
      console.error("[debug-trace] capture failed:", e);
    }
    return stack;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server.test.ts -t "error when archivist throws"`
Expected: PASS.

- [ ] **Step 5: Run the full test file**

Run: `bun test src/server.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): emit debug-trace on narrator/archivist errors"
```

---

## Task 4: Server — `ProviderInfo` in snapshot

**Files:**
- Modify: `src/server.ts:38-63` (extend `snapshot` shape)
- Modify: `src/server.ts:227-238` (`snapshotMessage`)
- Test: `src/server.test.ts` (new test — snapshot test, no need to spy)

- [ ] **Step 1: Write the failing test**

Append to `src/server.test.ts` (ensure `snapshotMessage` is exported — see Step 4):

```ts
import { snapshotMessage } from "./server";

test("snapshotMessage: includes providers info", () => {
  const msg = snapshotMessage(emptyStack);
  expect(msg.type).toBe("snapshot");
  if (msg.type !== "snapshot") throw new Error("type guard");
  expect(msg.providers).toBeDefined();
  expect(msg.providers.interpreter.provider).toMatch(/^(local|gemini)$/);
  expect(typeof msg.providers.narrator.model).toBe("string");
  expect(typeof msg.providers.tts.voice).toBe("string");
  expect(typeof msg.providers.image.style).toBe("string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server.test.ts -t "includes providers info"`
Expected: FAIL — `snapshotMessage` not exported, or `providers` field missing.

- [ ] **Step 3: Add `ProviderInfo` type and provider snapshot helper to `src/server.ts`**

Insert near the other types (after `LastTurnTrace`):

```ts
export interface ProviderInfo {
  narrator: { provider: string; model: string };
  interpreter: { provider: "local" | "gemini" };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
}

function buildProviderInfo(): ProviderInfo {
  return {
    narrator: {
      provider: process.env.NARRATOR_PROVIDER || "local",
      model: process.env.NARRATOR_MODEL || "gemma-3-12b",
    },
    interpreter: { provider: interpreterProvider() },
    tts: { provider: "gemini", voice: DEFAULT_VOICE },
    image: { provider: "gemini", style: DEFAULT_IMAGE_STYLE },
  };
}
```

- [ ] **Step 4: Extend `snapshot` message and export `snapshotMessage`**

In `src/server.ts`, change the `snapshot` variant of `ServerMessage` (around line 38-48) to include `providers: ProviderInfo`:

```ts
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: [number, number];
      presetSlug: string | null;
      presets: PresetSummary[];
      providers: ProviderInfo;
    }
```

Then change `function snapshotMessage` to `export function snapshotMessage` (around line 227) and add `providers` to the returned object:

```ts
export function snapshotMessage(stack: WorldStack): ServerMessage {
  return {
    type: "snapshot",
    turn: stack.turn,
    entries: stack.entries,
    threads: stack.threads,
    objectives: stack.objectives,
    position: stack.position,
    presetSlug: stack.presetSlug,
    presets: presetSummaries(),
    providers: buildProviderInfo(),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/server.test.ts -t "includes providers info"`
Expected: PASS.

- [ ] **Step 6: Run the full test file**

Run: `bun test src/server.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): include ProviderInfo in snapshot message"
```

---

## Task 5: Client — `parseSlashCommand` parser

**Files:**
- Create: `src/web/slash.ts`
- Test: `src/web/slash.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/web/slash.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseSlashCommand } from "./slash";

test("parseSlashCommand: returns null for plain text", () => {
  expect(parseSlashCommand("look around")).toBeNull();
  expect(parseSlashCommand("")).toBeNull();
  expect(parseSlashCommand("   ")).toBeNull();
});

test("parseSlashCommand: returns null for text not starting with /", () => {
  expect(parseSlashCommand("debug")).toBeNull();
  expect(parseSlashCommand("a/b")).toBeNull();
});

test("parseSlashCommand: parses bare command", () => {
  expect(parseSlashCommand("/debug")).toEqual({ name: "debug", args: "" });
  expect(parseSlashCommand("  /debug  ")).toEqual({ name: "debug", args: "" });
});

test("parseSlashCommand: parses command with args", () => {
  expect(parseSlashCommand("/foo bar baz")).toEqual({ name: "foo", args: "bar baz" });
});

test("parseSlashCommand: lowercases command name", () => {
  expect(parseSlashCommand("/DEBUG")).toEqual({ name: "debug", args: "" });
});

test("parseSlashCommand: ignores empty slash", () => {
  expect(parseSlashCommand("/")).toBeNull();
  expect(parseSlashCommand("/   ")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/web/slash.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/web/slash.ts`:

```ts
export interface SlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (body.length === 0) return null;
  const spaceIdx = body.indexOf(" ");
  if (spaceIdx === -1) return { name: body.toLowerCase(), args: "" };
  return {
    name: body.slice(0, spaceIdx).toLowerCase(),
    args: body.slice(spaceIdx + 1).trim(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/slash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/slash.ts src/web/slash.test.ts
git commit -m "feat(web): parseSlashCommand parser for client-side intercept"
```

---

## Task 6: Client — wire WS messages, modal state, providers/lastTrace tracking

**Files:**
- Modify: `src/web/app.tsx`

- [ ] **Step 1: Extend client `ServerMessage` union and add types**

In `src/web/app.tsx`, after the existing `ServerMessage` declaration (around line 47-72), update the union to add the two new variants and add the new types above it:

```ts
type InterpreterTrace = { action: string; provider: "local" | "gemini" };
type ArchivistTrace = {
  entries: string[];
  threads: string[];
  achievedObjectiveIndices: number[];
  moved: boolean;
  locationDescription: string;
};
type LastTurnTrace = {
  ts: string;
  turn: number;
  input: string;
  interpreter: InterpreterTrace;
  archivist: ArchivistTrace | null;
  error?: { source: "narrator" | "archivist"; message: string };
};
type ProviderInfo = {
  narrator: { provider: string; model: string };
  interpreter: { provider: "local" | "gemini" };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
};
```

Then change the `snapshot` variant to include `providers: ProviderInfo` and add `debug-trace` to the union:

```ts
type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: Position;
      presetSlug: string | null;
      presets: PresetSummary[];
      providers: ProviderInfo;
    }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | {
      type: "stack-update";
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: Position;
    }
  | { type: "win" }
  | { type: "audio-start" }
  | { type: "audio-chunk"; data: string }
  | { type: "audio-end" }
  | { type: "move-blocked"; input: string }
  | { type: "error"; source: "narrator" | "archivist"; message: string }
  | { type: "debug-trace"; trace: LastTurnTrace };
```

- [ ] **Step 2: Add modal variant `"debug"`**

In `src/web/app.tsx`, change the `ModalView` declaration (around line 106):

```ts
type ModalView = null | "select" | "win" | "voice" | "image" | "inventory" | "debug";
```

- [ ] **Step 3: Add `providers` and `lastTrace` state**

Inside `App()`, alongside the other `useState` calls (around line 95-135), add:

```ts
  const [providers, setProviders] = useState<ProviderInfo | null>(null);
  const [lastTrace, setLastTrace] = useState<LastTurnTrace | null>(null);
```

- [ ] **Step 4: Handle `providers` in snapshot and the new `debug-trace` message in WS handler**

The WS handler (around `src/web/app.tsx:306-430`) uses `if (msg.type === "...") { ... return; }` early-return chains, NOT a switch.

Inside the `if (msg.type === "snapshot")` block (line 308+), add (alongside `setStack(...)` and `setPresets(...)`):

```ts
        if (msg.providers) setProviders(msg.providers);
```

After the `audio-end`/`error` blocks (anywhere before the function ends), add a new early-return:

```ts
      if (msg.type === "debug-trace") {
        setLastTrace(msg.trace);
        return;
      }
```

- [ ] **Step 5: Verify type-check passes**

Run: `bunx tsc --noEmit`
Expected: No errors related to these changes.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): track providers and lastTrace from server"
```

---

## Task 7: Client — `DebugModal` component

**Files:**
- Modify: `src/web/app.tsx` (add `DebugModal` component near other view components, around line 1180)

- [ ] **Step 1: Add the component**

Add `DebugModal` to `src/web/app.tsx` after `WinView` (around line 1198, before `ObjectivesRail`):

```tsx
function DebugModal(props: {
  stack: Stack;
  position: Position;
  placeDescription?: string;
  providers: ProviderInfo | null;
  lastTrace: LastTurnTrace | null;
  onClose: () => void;
}) {
  const { stack, position, placeDescription, providers, lastTrace, onClose } = props;
  const active = stack.objectives.filter(
    (o) => !o.position || (o.position[0] === position[0] && o.position[1] === position[1])
  );
  const distant = stack.objectives.filter(
    (o) => o.position && (o.position[0] !== position[0] || o.position[1] !== position[1])
  );
  return (
    <div className="modal-body debug-modal">
      <div className="modal-title">Debug</div>
      <div className="debug-columns">
        <section className="debug-col">
          <h4>Live state</h4>
          <p><strong>Position</strong> [{position[0]}, {position[1]}] (key: {position[0]},{position[1]})</p>
          {placeDescription && (
            <p><strong>Place</strong> {placeDescription}</p>
          )}
          <p><strong>Turn</strong> {stack.turn}</p>
          <p><strong>Preset</strong> {stack.presetSlug ?? "(free play)"}</p>

          <h5>Objectives — active here ({active.length})</h5>
          {active.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{active.map((o, i) => (
              <li key={i}>{o.achieved ? "✓" : "·"} {o.text}{o.position ? ` @ [${o.position[0]},${o.position[1]}]` : ""}</li>
            ))}</ul>
          )}

          <h5>Objectives — distant ({distant.length})</h5>
          {distant.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{distant.map((o, i) => (
              <li key={i}>{o.achieved ? "✓" : "·"} {o.text} @ [{o.position![0]},{o.position![1]}]</li>
            ))}</ul>
          )}

          <h5>Entries ({stack.entries.length})</h5>
          {stack.entries.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{stack.entries.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}

          <h5>Threads ({stack.threads.length})</h5>
          {stack.threads.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{stack.threads.map((t, i) => <li key={i}>{t}</li>)}</ul>
          )}

          <h5>Providers</h5>
          {providers ? (
            <ul>
              <li>narrator: {providers.narrator.provider} / {providers.narrator.model}</li>
              <li>interpreter: {providers.interpreter.provider}</li>
              <li>tts: {providers.tts.provider} / {providers.tts.voice}</li>
              <li>image: {providers.image.provider} / {providers.image.style}</li>
            </ul>
          ) : (
            <p className="debug-muted">(loading)</p>
          )}
        </section>

        <section className="debug-col">
          <h4>Last turn pipeline</h4>
          {!lastTrace ? (
            <p className="debug-muted">No turns yet — play a turn to see pipeline trace.</p>
          ) : (
            <>
              <p><strong>ts</strong> {lastTrace.ts}</p>
              <p><strong>turn</strong> {lastTrace.turn}</p>
              <p><strong>input</strong> {lastTrace.input}</p>

              <h5>Interpreter</h5>
              <ul>
                <li>action: {lastTrace.interpreter.action}</li>
                <li>provider: {lastTrace.interpreter.provider}</li>
              </ul>

              <h5>Archivist</h5>
              {lastTrace.archivist === null ? (
                <p className="debug-muted">(skipped — see error or move-blocked)</p>
              ) : (
                <pre className="debug-json">{JSON.stringify(lastTrace.archivist, null, 2)}</pre>
              )}

              {lastTrace.error && (
                <>
                  <h5>Error</h5>
                  <p className="debug-error">{lastTrace.error.source}: {lastTrace.error.message}</p>
                </>
              )}
            </>
          )}
        </section>
      </div>
      <button className="action-button" onClick={onClose}>close</button>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal CSS to `src/web/styles.css`**

Append to `src/web/styles.css`:

```css
.modal.debug-modal-wide,
.modal:has(.debug-modal) {
  max-width: 80vw;
  width: 80vw;
}
.debug-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  max-height: 70vh;
  overflow-y: auto;
}
.debug-col h4 {
  margin: 0 0 0.5rem 0;
  color: var(--accent);
}
.debug-col h5 {
  margin: 0.85rem 0 0.25rem 0;
  font-size: 0.88rem;
  color: var(--fg-muted);
}
.debug-col ul {
  margin: 0.25rem 0 0.5rem 1rem;
  padding: 0;
}
.debug-col li {
  font-size: 0.9rem;
}
.debug-muted { color: var(--fg-subtle); font-size: 0.9rem; }
.debug-json {
  background: rgba(0,0,0,0.25);
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 0.82rem;
  overflow-x: auto;
}
.debug-error { color: var(--negative, #d66); font-size: 0.9rem; }
```

- [ ] **Step 3: Add `position` to `Stack` state**

In `src/web/app.tsx`, the `Stack` type (around line 35-41) doesn't currently include position. Extend it:

```ts
type Stack = {
  turn: number;
  entries: string[];
  threads: string[];
  objectives: Objective[];
  presetSlug: string | null;
  position: Position;
};
```

Update the initial state (around line 97-103):

```ts
  const [stack, setStack] = useState<Stack>({
    turn: 0,
    entries: [],
    threads: [],
    objectives: [],
    presetSlug: null,
    position: [0, 0],
  });
```

In the `snapshot` handler (around line 309-315), add `position: msg.position` to the `setStack` object.

In the `stack-update` handler (around line 387-393), add `position: msg.position` to the returned object.

- [ ] **Step 4: Render `DebugModal` in the modal block**

In `src/web/app.tsx`, add to the modal block (around line 812, after `inventory`):

```tsx
            {modal === "debug" && (
              <DebugModal
                stack={stack}
                position={stack.position}
                placeDescription={lastTrace?.archivist?.locationDescription}
                providers={providers}
                lastTrace={lastTrace}
                onClose={() => setModal(null)}
              />
            )}
```

- [ ] **Step 5: Verify type-check passes**

Run: `bunx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.tsx src/web/styles.css
git commit -m "feat(web): DebugModal component with live state + last turn trace"
```

> Note: the `Stack` type now carries `position`. Existing reads (`stack.entries`, `stack.threads`, etc.) are unaffected, but the spread in the `stack-update` handler (`return { ...s, ... }`) preserves position automatically only if you include it in the `setStack` updater. Verify by `grep "setStack" src/web/app.tsx`.

---

## Task 8: Client — intercept `/debug` in `send()`, drop inline debug line, unknown-command toast

**Files:**
- Modify: `src/web/app.tsx`

- [ ] **Step 1: Import the parser**

At the top of `src/web/app.tsx`, add:

```ts
import { parseSlashCommand } from "./slash";
```

- [ ] **Step 2: Intercept `/debug` in the `send` callback**

In `src/web/app.tsx`, modify the `send` callback (around line 491-540). Insert slash-command handling BEFORE the existing `lower === "stack"` checks:

```ts
  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || pending) return;

    const slash = parseSlashCommand(trimmed);
    if (slash) {
      if (slash.name === "debug") {
        setModal("debug");
        return;
      }
      setToast({ kind: "blocked", text: `unknown command: /${slash.name}`, id: Date.now() });
      return;
    }

    const lower = trimmed.toLowerCase();
    // ... existing stack/threads/help logic unchanged ...
```

- [ ] **Step 3: Remove the inline `> debug: x:N y:N` line**

In `src/web/app.tsx`, locate `TurnBlock` (around line 901) and delete:

```tsx
        {turn.position && (
          <p className="turn-debug">&gt; debug: x:{turn.position[0]} y:{turn.position[1]}</p>
        )}
```

Also remove the now-unused `position?: Position` field from the `Turn` type (around line 12) if no other code reads it. Verify with: `grep "turn.position" src/web/app.tsx` — should only show usage that you're removing.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): /debug opens DebugModal; unknown slash commands toast; drop inline debug line"
```

---

## Task 9: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the server**

Run: `bun --hot src/server.ts`

- [ ] **Step 2: Open the browser to `http://localhost:3000`**

Verify the app loads.

- [ ] **Step 3: Verify inline debug line is gone**

Submit `look around`. Confirm no `> debug: x:0 y:0` line appears under the turn.

- [ ] **Step 4: Open `/debug` modal**

Type `/debug` in the chatbox and submit. Verify the modal opens with two columns, live state shows position [0,0], turn 0 (or current), entries, threads, providers section populated, and the right column shows "No turns yet" if no real turn has happened.

- [ ] **Step 5: Play a turn and re-open `/debug`**

Submit `north` (or any move). After the turn settles, type `/debug` again. Verify the right column now shows interpreter action, archivist raw output JSON (entries, threads, achievedObjectiveIndices, moved, locationDescription).

- [ ] **Step 6: Test move-blocked trace**

Submit something the interpreter classifies as move-blocked (e.g., `swim south` if water is involved, or any nonsensical-direction phrasing). After the toast, type `/debug`. Verify archivist column shows "(skipped — see error or move-blocked)".

- [ ] **Step 7: Test unknown command toast**

Type `/foo` and submit. Verify a toast appears reading `unknown command: /foo` and the modal does not open.

- [ ] **Step 8: Confirm modal dismiss**

Click the backdrop, the close button, and (if implemented) press Escape. Verify the modal closes in each case.

---

## Self-Review

**Spec coverage:**
- ✓ Slash-command intercept (Task 5 parser, Task 8 wiring)
- ✓ Drop inline debug line (Task 8 Step 3)
- ✓ Live state column (Task 7 component)
- ✓ Last turn pipeline trace (Task 7 component, fed by Tasks 1-3)
- ✓ Server in-memory `lastTurnTrace` (Task 1) + null on move-blocked (Task 2) + error capture (Task 3)
- ✓ `ProviderInfo` in snapshot (Task 4)
- ✓ Push-on-update wire format (Tasks 1-3 emit `debug-trace` after `stack-update`; Task 4 includes `providers` in `snapshot`)
- ✓ Trace assembly try/catch — never break turn pipeline (Tasks 1-3 each wrap)
- ✓ Modal placeholder when no trace (Task 7 component)
- ✓ Unknown command toast (Task 8)
- ✓ Tests: slash parser unit (Task 5); server trace shape (Task 1); move-blocked (Task 2); error (Task 3); providers (Task 4); manual (Task 9)

**Type consistency:**
- `LastTurnTrace`, `InterpreterTrace`, `ArchivistTrace`, `ProviderInfo` defined identically in `src/server.ts` and `src/web/app.tsx`. (Could be shared via a future `src/shared-types.ts`, but is not required and out of scope.)
- `parseSlashCommand` return shape `{ name, args } | null` consistent across Tasks 5 and 8.

**No placeholders:** every step shows the actual code or command.
