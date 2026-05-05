# World Engine Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based UI for the World Engine, served by `Bun.serve` with WebSocket-streamed turns and a Neo-Noir Terminal aesthetic. Reuses existing `engine.ts` unchanged. CLI (`src/main.ts`) remains as parallel entry point.

**Architecture:** A new `src/server.ts` wraps `Bun.serve` with WebSocket handling and reuses the existing `narratorTurn` / `archivistTurn` from `engine.ts`. The frontend is a single-page React app served via Bun's HTML imports. Client and server communicate via a JSON message protocol over WebSocket. World state lives in process memory, persisted via `saveStack` after each archivist turn.

**Tech Stack:** Bun, TypeScript, React 19, `bun:test`, plain CSS with custom properties, Bun's HTML imports for bundling.

> **Note:** This project still has no git repository. Skip git steps if not initialised; otherwise commit after each task.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add `react`, `react-dom`, `@types/react`, `@types/react-dom` |
| `src/server.ts` | Create | Bun.serve + WebSocket handler. Owns the in-memory `WorldStack`. Loads on boot, saves on every archivist turn. Broadcasts updates to all connected sockets. |
| `src/server.test.ts` | Create | Unit tests for the `processInput` message handler (mocks `engine.ts`). |
| `src/web/index.html` | Create | Bun HTML entry point. Imports `app.tsx` and `styles.css`. Loads Newsreader + Space Grotesk from Google Fonts. |
| `src/web/app.tsx` | Create | React app: WebSocket client, turn list state, input handling, button bar, system command interception. |
| `src/web/styles.css` | Create | Neo-Noir design tokens (CSS custom properties) + component styles for turn blocks, action bar, buttons. |

---

## Task 1: Install React dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1.1: Install React deps via Bun**

```bash
cd /home/frosty/Dev/ai/adventure
~/.bun/bin/bun add react@latest react-dom@latest
~/.bun/bin/bun add -d @types/react@latest @types/react-dom@latest
```

Expected: `package.json` updated with the four new entries. `bun.lock` updated. No errors.

- [ ] **Step 1.2: Verify React is importable**

```bash
~/.bun/bin/bun -e 'import("react").then(r => console.log("react", r.version))'
```

Expected: `react 19.x.x` (or whatever the current major is)

- [ ] **Step 1.3: Confirm tests still pass**

```bash
~/.bun/bin/bun test src/
```

Expected: 27 tests pass (no regressions)

- [ ] **Step 1.4: Commit (skip if no git)**

```bash
git add package.json bun.lock
git commit -m "feat: add react dependencies for web frontend"
```

---

## Task 2: Server message protocol with TDD

**Files:**
- Create: `src/server.ts` (initial — only the `processInput` function and types)
- Create: `src/server.test.ts`

The server's core logic is a pure async function that takes the current stack + a player input, calls a `send` callback for each event in order (turn-start → narrative → stack-update OR error), and returns the new stack. This is the testable seam — `Bun.serve` just wires it to a WebSocket in Task 3.

- [ ] **Step 2.1: Write the failing tests**

Create `src/server.test.ts`:

```typescript
import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as engine from "./engine";
import { processInput, type ServerMessage } from "./server";

let narratorSpy: any;
let archivistSpy: any;

const emptyStack = { entries: [] as string[], threads: [] as string[], turn: 0 };

beforeEach(() => {
  narratorSpy = spyOn(engine, "narratorTurn");
  archivistSpy = spyOn(engine, "archivistTurn");
});

afterEach(() => {
  narratorSpy.mockRestore();
  archivistSpy.mockRestore();
});

test("processInput: emits turn-start, narrative, stack-update on happy path", async () => {
  narratorSpy.mockImplementationOnce(async () => "The world stirs.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["world stirred"],
    threads: ["find the cause"],
    turn: 1,
  }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages).toEqual([
    { type: "turn-start", input: "look" },
    { type: "narrative", text: "The world stirs." },
    { type: "stack-update", entries: ["world stirred"], threads: ["find the cause"] },
  ]);
  expect(newStack).toEqual({ entries: ["world stirred"], threads: ["find the cause"], turn: 1 });
});

test("processInput: on narrator failure, emits error and returns unchanged stack", async () => {
  narratorSpy.mockImplementationOnce(async () => {
    throw new Error("API timeout");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(2);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toMatchObject({ type: "error", source: "narrator" });
  expect(newStack).toBe(emptyStack);
  expect(archivistSpy).not.toHaveBeenCalled();
});

test("processInput: on archivist failure, narrative is sent but stack is unchanged", async () => {
  narratorSpy.mockImplementationOnce(async () => "Something happens.");
  archivistSpy.mockImplementationOnce(async () => {
    throw new Error("schema mismatch");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(3);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "Something happens." });
  expect(messages[2]).toMatchObject({ type: "error", source: "archivist" });
  expect(newStack).toBe(emptyStack);
});

test("processInput: passes the current stack into narrator and archivist", async () => {
  const stack = { entries: ["fact"], threads: ["thread"], turn: 5 };
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["fact"],
    threads: ["thread"],
    turn: 6,
  }));

  await processInput(stack, "go north", () => {});

  expect(narratorSpy).toHaveBeenCalledWith(stack, "go north");
  expect(archivistSpy).toHaveBeenCalledWith(stack, "ok");
});
```

- [ ] **Step 2.2: Run tests — expect failure**

```bash
~/.bun/bin/bun test src/server.test.ts
```

Expected: `Cannot find module './server'`

- [ ] **Step 2.3: Implement src/server.ts (only the handler — Bun.serve added in Task 3)**

Create `src/server.ts`:

```typescript
import { narratorTurn, archivistTurn } from "./engine";
import type { WorldStack } from "./stack";

export type ServerMessage =
  | { type: "snapshot"; turn: number; entries: string[]; threads: string[] }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | { type: "stack-update"; entries: string[]; threads: string[] }
  | { type: "error"; source: "narrator" | "archivist"; message: string };

export type ClientMessage =
  | { type: "input"; text: string }
  | { type: "reset" }
  | { type: "hello" };

export type Send = (message: ServerMessage) => void;

export async function processInput(
  stack: WorldStack,
  input: string,
  send: Send
): Promise<WorldStack> {
  send({ type: "turn-start", input });

  let narrative: string;
  try {
    narrative = await narratorTurn(stack, input);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    send({ type: "error", source: "narrator", message: String(err) });
    return stack;
  }

  try {
    const newStack = await archivistTurn(stack, narrative);
    send({
      type: "stack-update",
      entries: newStack.entries,
      threads: newStack.threads,
    });
    return newStack;
  } catch (err) {
    send({ type: "error", source: "archivist", message: String(err) });
    return stack;
  }
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```bash
~/.bun/bin/bun test src/server.test.ts
```

Expected: 4 tests pass

- [ ] **Step 2.5: Confirm full suite still passes**

```bash
~/.bun/bin/bun test src/
```

Expected: 31 tests pass (4 stack + 10 api + 9 engine + 4 new server tests + the engine count may differ slightly — confirm 0 fail)

- [ ] **Step 2.6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add server message handler with isolated narrator/archivist passes"
```

---

## Task 3: Bun.serve with WebSocket and HTML entry

**Files:**
- Modify: `src/server.ts` (add Bun.serve setup at bottom)

The server must: load the world stack on startup, accept WebSocket connections, parse client messages, call `processInput`, broadcast events to all connected sockets, and persist after each archivist turn.

- [ ] **Step 3.1: Add WebSocket and Bun.serve to src/server.ts**

Append the following to `src/server.ts`:

```typescript
import { loadStack, saveStack } from "./stack";

let currentStack: WorldStack;

async function handleClientMessage(raw: string, send: Send, broadcast: Send): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: "error", source: "narrator", message: "Invalid client message" });
    return;
  }

  if (msg.type === "hello") {
    send({
      type: "snapshot",
      turn: currentStack.turn,
      entries: currentStack.entries,
      threads: currentStack.threads,
    });
    return;
  }

  if (msg.type === "reset") {
    const fresh: WorldStack = { entries: [], threads: [], turn: 0 };
    try {
      await saveStack(fresh);
      currentStack = fresh;
      broadcast({
        type: "snapshot",
        turn: 0,
        entries: [],
        threads: [],
      });
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Reset failed: ${err}` });
    }
    return;
  }

  if (msg.type === "input") {
    const newStack = await processInput(currentStack, msg.text, broadcast);
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

async function main() {
  currentStack = await loadStack();

  const indexHtml = await import("./web/index.html");

  const server = Bun.serve({
    port: 3000,
    routes: {
      "/": indexHtml.default,
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade required", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("world");
      },
      async message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        await handleClientMessage(
          text,
          (m) => ws.send(JSON.stringify(m)),
          (m) => server.publish("world", JSON.stringify(m))
        );
      },
      close(ws) {
        ws.unsubscribe("world");
      },
    },
    development: {
      hmr: true,
      console: true,
    },
  });

  console.log(`World Engine listening at http://localhost:${server.port}`);
}

if (import.meta.main) {
  main();
}
```

- [ ] **Step 3.2: Verify server.ts still compiles and tests pass**

```bash
~/.bun/bin/bun test src/server.test.ts
```

Expected: 4 tests still pass (the `main()` function is gated behind `import.meta.main` so it doesn't run during tests).

The `import("./web/index.html")` line will only resolve at runtime when the file exists; that's Task 4. The TypeScript check should still pass because we use a dynamic import.

- [ ] **Step 3.3: Confirm full suite still passes**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire Bun.serve and WebSocket broadcast around message handler"
```

---

## Task 4: HTML entry point and Neo-Noir CSS

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/styles.css`

- [ ] **Step 4.1: Create src/web/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>World Engine</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500&family=Space+Grotesk:wght@400;600;700&display=swap"
    rel="stylesheet"
  />
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.tsx"></script>
</body>
</html>
```

- [ ] **Step 4.2: Create src/web/styles.css**

```css
:root {
  /* Neo-Noir palette */
  --surface: #131314;
  --surface-container-low: #1c1b1c;
  --surface-container: #201f20;
  --surface-container-high: #2a2a2b;
  --on-surface: #e5e2e3;
  --on-surface-variant: #b9cacb;
  --primary: #00f2ff;
  --on-primary-container: #006a71;
  --secondary: #b600f8;
  --outline: #849495;
  --outline-variant: #3a494b;

  /* Typography */
  --font-narrative: "Newsreader", Georgia, serif;
  --font-terminal: "Space Grotesk", "Helvetica Neue", sans-serif;

  /* Layout */
  --container-max: 800px;
  --gutter: 1rem;
  --turn-margin: 3rem;
  --block-padding: 1.5rem;

  /* Glow */
  --glow-cyan: 0 0 8px rgba(0, 242, 255, 0.35);
  --glow-violet: 0 0 8px rgba(182, 0, 248, 0.4);
}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  background: var(--surface);
  color: var(--on-surface);
  font-family: var(--font-narrative);
  min-height: 100vh;
}

body {
  display: flex;
  flex-direction: column;
}

#root {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.app {
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: var(--container-max);
  width: 100%;
  margin: 0 auto;
  padding: 2rem var(--gutter) 12rem var(--gutter);
}

.app-header {
  font-family: var(--font-terminal);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.2em;
  color: var(--primary);
  text-transform: uppercase;
  text-shadow: var(--glow-cyan);
  text-align: center;
  padding: 1rem 0 2rem 0;
}

.connection-status {
  font-family: var(--font-terminal);
  font-size: 12px;
  color: var(--on-surface-variant);
  text-align: center;
  letter-spacing: 0.1em;
  margin-bottom: 1rem;
}

.connection-status.connected {
  color: var(--primary);
}

.turn-list {
  display: flex;
  flex-direction: column;
  gap: var(--turn-margin);
}

.turn-block {
  border: 1px solid var(--outline-variant);
  padding: var(--block-padding);
  display: grid;
  grid-template-columns: 128px 1fr;
  gap: 2rem;
  background: var(--surface-container-low);
}

.turn-block.system {
  grid-template-columns: 1fr;
  background: transparent;
  border-style: dashed;
  border-color: var(--outline);
}

.turn-image {
  width: 128px;
  height: 128px;
  border: 1px solid var(--outline-variant);
  background: linear-gradient(
    135deg,
    var(--surface-container) 0%,
    var(--surface-container-high) 100%
  );
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-surface-variant);
  font-family: var(--font-terminal);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  position: relative;
}

.turn-image.placeholder::before {
  content: "AWAITING";
  opacity: 0.5;
}

.turn-content {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.turn-header {
  font-family: var(--font-terminal);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.1em;
  color: var(--primary);
  text-transform: uppercase;
}

.turn-input-echo {
  font-family: var(--font-terminal);
  font-size: 14px;
  color: var(--primary);
  margin: 0;
}

.turn-input-echo::before {
  content: "> ";
  color: var(--primary);
}

.turn-narrative {
  font-family: var(--font-narrative);
  font-size: 20px;
  font-weight: 400;
  line-height: 1.7;
  color: var(--on-surface);
  margin: 0;
  white-space: pre-wrap;
}

.turn-error {
  font-family: var(--font-terminal);
  font-size: 14px;
  color: #ffb4ab;
  font-style: italic;
}

.turn-pending {
  font-family: var(--font-terminal);
  font-size: 14px;
  color: var(--on-surface-variant);
  font-style: italic;
}

.system-list {
  font-family: var(--font-terminal);
  font-size: 14px;
  color: var(--on-surface-variant);
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0 0;
}

.system-list li::before {
  content: "· ";
  color: var(--primary);
}

.system-list.threads li::before {
  content: "→ ";
  color: var(--secondary);
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--surface-container);
  border-top: 1px solid var(--outline-variant);
  padding: 1rem var(--gutter);
}

.action-bar-inner {
  max-width: var(--container-max);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--outline-variant);
  padding: 0.5rem 0.75rem;
  background: var(--surface-container-low);
}

.input-row:focus-within {
  border-color: var(--primary);
  box-shadow: var(--glow-cyan);
}

.input-prompt {
  font-family: var(--font-terminal);
  color: var(--primary);
  font-size: 16px;
  font-weight: 700;
}

.input-field {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--on-surface);
  font-family: var(--font-terminal);
  font-size: 16px;
}

.input-field::placeholder {
  color: var(--on-surface-variant);
  opacity: 0.5;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.action-button {
  background: transparent;
  border: 1px solid var(--primary);
  color: var(--primary);
  font-family: var(--font-terminal);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  transition: box-shadow 120ms, color 120ms;
}

.action-button:hover {
  box-shadow: var(--glow-cyan);
}

.action-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-button.critical {
  border-color: var(--secondary);
  color: var(--secondary);
}

.action-button.critical:hover {
  box-shadow: var(--glow-violet);
}
```

- [ ] **Step 4.3: Confirm tests still pass (no regressions)**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add src/web/index.html src/web/styles.css
git commit -m "feat: add HTML entry and Neo-Noir CSS tokens"
```

---

## Task 5: React frontend

**Files:**
- Create: `src/web/app.tsx`

The frontend manages WebSocket connection, turns array, current stack, system command interception, and rendering.

- [ ] **Step 5.1: Create src/web/app.tsx**

```tsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

type Turn = {
  id: number;
  input: string;
  narrative?: string;
  error?: string;
  pending: boolean;
};

type SystemTurn = {
  id: number;
  kind: "system";
  title: string;
  items: string[];
  variant?: "threads";
};

type AnyTurn = Turn | SystemTurn;

type Stack = { turn: number; entries: string[]; threads: string[] };

type ServerMessage =
  | { type: "snapshot"; turn: number; entries: string[]; threads: string[] }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | { type: "stack-update"; entries: string[]; threads: string[] }
  | { type: "error"; source: "narrator" | "archivist"; message: string };

const QUICK_ACTIONS = [
  "look around",
  "wait",
  "inventory",
  "north",
  "south",
  "east",
  "west",
];

function isSystemTurn(t: AnyTurn): t is SystemTurn {
  return (t as SystemTurn).kind === "system";
}

function App() {
  const [connected, setConnected] = useState(false);
  const [turns, setTurns] = useState<AnyTurn[]>([]);
  const [stack, setStack] = useState<Stack>({ turn: 0, entries: [], threads: [] });
  const [pending, setPending] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const addTurn = useCallback((t: AnyTurn) => {
    setTurns((prev) => [...prev, t]);
  }, []);

  const updateLastInputTurn = useCallback((updater: (t: Turn) => Turn) => {
    setTurns((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const t = copy[i];
        if (!isSystemTurn(t)) {
          copy[i] = updater(t);
          break;
        }
      }
      return copy;
    });
  }, []);

  // WebSocket lifecycle
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "hello" }));
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setPending(false);
    });

    ws.addEventListener("message", (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      if (msg.type === "snapshot") {
        setStack({ turn: msg.turn, entries: msg.entries, threads: msg.threads });
        return;
      }
      if (msg.type === "turn-start") {
        addTurn({
          id: nextIdRef.current++,
          input: msg.input,
          pending: true,
        });
        setPending(true);
        return;
      }
      if (msg.type === "narrative") {
        updateLastInputTurn((t) => ({ ...t, narrative: msg.text }));
        return;
      }
      if (msg.type === "stack-update") {
        setStack((s) => ({ ...s, entries: msg.entries, threads: msg.threads, turn: s.turn + 1 }));
        updateLastInputTurn((t) => ({ ...t, pending: false }));
        setPending(false);
        return;
      }
      if (msg.type === "error") {
        updateLastInputTurn((t) => ({
          ...t,
          pending: false,
          error: `${msg.source} error: ${msg.message}`,
        }));
        setPending(false);
        return;
      }
    });

    return () => {
      ws.close();
    };
  }, [addTurn, updateLastInputTurn]);

  // Auto-scroll to bottom on new turn
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || pending) return;

    const lower = trimmed.toLowerCase();

    // Client-side system commands (no LLM round-trip)
    if (lower === "stack") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: `World state — turn ${stack.turn}`,
        items: stack.entries.length > 0 ? stack.entries : ["(empty)"],
      });
      return;
    }
    if (lower === "threads") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: `Active threads — turn ${stack.turn}`,
        items: stack.threads.length > 0 ? stack.threads : ["(no active threads)"],
        variant: "threads",
      });
      return;
    }
    if (lower === "help") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: "Commands",
        items: [
          "stack    show world state",
          "threads  show active threads",
          "reset    wipe the world",
          "help     this list",
          "(or type any action)",
        ],
      });
      return;
    }
    if (lower === "reset") {
      if (confirm("Wipe the world?")) {
        wsRef.current.send(JSON.stringify({ type: "reset" }));
        setTurns([]);
      }
      return;
    }

    wsRef.current.send(JSON.stringify({ type: "input", text: trimmed }));
  }, [addTurn, pending, stack]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    send(inputValue);
    setInputValue("");
  }, [send, inputValue]);

  return (
    <>
      <div className="app">
        <div className="app-header">W O R L D &nbsp;&nbsp; E N G I N E</div>
        <div className={`connection-status ${connected ? "connected" : ""}`}>
          {connected ? "■ CONNECTED" : "□ CONNECTING…"}
        </div>
        <div className="turn-list">
          {turns.map((t) => (isSystemTurn(t) ? (
            <SystemBlock key={t.id} turn={t} />
          ) : (
            <TurnBlock key={t.id} turn={t} />
          )))}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="action-bar">
        <div className="action-bar-inner">
          <form className="input-row" onSubmit={handleSubmit}>
            <span className="input-prompt">&gt;</span>
            <input
              className="input-field"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={pending ? "the world is responding…" : "what do you do?"}
              disabled={pending || !connected}
              autoFocus
            />
          </form>
          <div className="button-row">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a}
                className="action-button"
                onClick={() => send(a)}
                disabled={pending || !connected}
              >
                {a}
              </button>
            ))}
            <button
              className="action-button critical"
              onClick={() => send("reset")}
              disabled={!connected}
            >
              reset
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function TurnBlock({ turn }: { turn: Turn }) {
  return (
    <div className="turn-block">
      <div className="turn-image placeholder" />
      <div className="turn-content">
        <div className="turn-header">Turn #{turn.id}</div>
        <p className="turn-input-echo">{turn.input}</p>
        {turn.narrative && <p className="turn-narrative">{turn.narrative}</p>}
        {turn.pending && !turn.narrative && !turn.error && (
          <p className="turn-pending">the world is responding…</p>
        )}
        {turn.error && <p className="turn-error">{turn.error}</p>}
      </div>
    </div>
  );
}

function SystemBlock({ turn }: { turn: SystemTurn }) {
  return (
    <div className="turn-block system">
      <div className="turn-content">
        <div className="turn-header">{turn.title}</div>
        <ul className={`system-list ${turn.variant || ""}`}>
          {turn.items.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
```

- [ ] **Step 5.2: Verify the project still type-checks and tests pass**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass. The TypeScript check happens at runtime when Bun bundles `app.tsx`; we'll verify in Task 6.

- [ ] **Step 5.3: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat: add React frontend with WebSocket client and Neo-Noir UI"
```

---

## Task 6: End-to-end verification in browser

**Files:** None modified. Manual verification only.

- [ ] **Step 6.1: Confirm LM Studio is running**

```bash
curl -s http://localhost:1234/v1/models | head -5
```

Expected: JSON listing the loaded models. If not running, start LM Studio and load `google/gemma-4-e2b` and `nvidia/nemotron-3-nano-4b`.

- [ ] **Step 6.2: Reset world to a known state**

```bash
echo '{"entries":[],"threads":[],"turn":0}' > /home/frosty/Dev/ai/adventure/world-stack.json
```

- [ ] **Step 6.3: Start the server**

```bash
~/.bun/bin/bun src/server.ts
```

Expected output: `World Engine listening at http://localhost:3000` and no errors.

Leave the process running. It should hot-reload on changes via Bun's `hmr: true` setting.

- [ ] **Step 6.4: Open browser and verify initial render**

Open `http://localhost:3000` in a browser.

Expected:
- Header reads "W O R L D   E N G I N E" in cyan with subtle glow
- Connection status shows "■ CONNECTED" in cyan
- Turn list is empty
- Action bar at the bottom shows the input field and the quick-action buttons (look around, wait, inventory, north, south, east, west, reset)
- Layout is centered, max 800px
- Background is near-black; container blocks would be slightly lighter
- Buttons have 1px cyan borders with no rounded corners

- [ ] **Step 6.5: Type the first action**

In the input field, type `look at the stars` and press Enter.

Expected:
- A new turn block appears immediately with `Turn #1`, the input echoed as `> look at the stars`, and a placeholder image area showing "AWAITING"
- The narrative renders within ~1-3 seconds in Newsreader serif
- After narrative, the stack updates silently (turn count increments)
- Auto-scroll keeps the new turn in view

- [ ] **Step 6.6: Click a quick-action button**

Click `look around`.

Expected: same flow as Step 6.5, with `> look around` as the echo. No need to type.

- [ ] **Step 6.7: Type a system command**

Type `threads` and press Enter.

Expected: a dashed-border system block appears showing "Active threads — turn N" with the current threads (or "(no active threads)" if archivist hasn't extracted any yet). No round-trip to the LLM (instant render).

- [ ] **Step 6.8: Type `stack`**

Expected: a dashed-border block showing world entries.

- [ ] **Step 6.9: Verify reset**

Click the cyan-bordered `reset` button (it's marked critical with violet hover glow).

Expected: confirm dialog → on accept, turn list clears, `world-stack.json` resets to empty.

- [ ] **Step 6.10: Verify two-tab broadcast**

Open a second browser tab to `http://localhost:3000`.

Expected:
- Second tab connects and receives an empty snapshot.
- Type an action in tab 1 → both tabs see the new turn appear (because broadcast publishes to all sockets on the `world` topic).

If the second tab does NOT receive turn-start broadcasts, that's a known limitation: `turn-start` is sent before `processInput` completes, but only the publisher's socket gets it from `ws.send`. Confirm the broadcast path actually uses `server.publish("world", ...)` for all messages including `turn-start`. If not, this is a bug to fix.

- [ ] **Step 6.11: Verify CLI still works**

In a separate terminal:

```bash
~/.bun/bin/bun src/main.ts
```

Expected: CLI starts, shows the resumed world state from `world-stack.json`. Type a command, see narrative, quit. CLI and web share the same persistence file.

- [ ] **Step 6.12: Stop the server**

In the server terminal: Ctrl+C.

- [ ] **Step 6.13: Run the full test suite one final time**

```bash
~/.bun/bin/bun test src/
```

Expected: all tests pass.

- [ ] **Step 6.14: Final commit (if anything changed)**

```bash
git status
# if changes:
git add -A
git commit -m "chore: end-to-end verification complete"
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| `src/server.ts` with Bun.serve + WebSocket | Task 2 + 3 |
| Reuses existing `engine.ts` unchanged | Task 2 (imports from engine) |
| CLI `main.ts` stays parallel | Task 6.11 verifies |
| `src/web/index.html` with HTML imports | Task 4 |
| `src/web/app.tsx` React frontend | Task 5 |
| `src/web/styles.css` Neo-Noir tokens | Task 4 |
| `react`, `react-dom`, types added to package.json | Task 1 |
| WebSocket protocol (snapshot/turn-start/narrative/stack-update/error) | Task 2 (types) + 3 (wire) + 5 (consume) |
| Future-ready for `image` message type | Discriminated union in Task 2; trivial to extend |
| Client → server (input, reset, hello) | Task 3 (handler) + 5 (sender) |
| 800px max column, centered | Task 4 (CSS) |
| Stacked turn blocks, sticky action bar | Task 4 (CSS) + 5 (layout) |
| Image placeholder 128px | Task 4 (CSS `.turn-image`) |
| Quick-action buttons, click-to-send | Task 5 (`QUICK_ACTIONS` constant) |
| System commands client-side (stack, threads, help) | Task 5 (`send` function) |
| `reset` round-trips to server | Task 5 (`reset` branch sends `{type:"reset"}`) |
| Single-user persistence via existing world-stack.json | Task 3 (load/save in handler) |
| Pub/sub broadcast to all tabs | Task 3 (`subscribe("world")` + `server.publish`) |
| Sharp 0-radius corners | Task 4 (CSS) |
| Cyan glow on focus/hover | Task 4 (CSS `:focus-within`, `:hover`) |
| Newsreader for prose, Space Grotesk for chrome | Task 4 (CSS + Google Fonts link) |
| Auto-scroll to latest turn | Task 5 (`bottomRef.current?.scrollIntoView`) |
