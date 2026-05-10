# Move-Blocked Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player a toast when their input looks like movement but isn't a cardinal direction, and skip the turn entirely (no narrator/archivist/TTS/image/play-log spend, no position change, no turn-counter advance).

**Architecture:** Interpreter gains a third class `move-blocked`. Server short-circuits on it. UI shows a toast via the existing `Toast` component (now a discriminated union over its data type). A new `INTERPRETER_PROVIDER` env var (`local` | `gemini`, default `local`) mirrors `NARRATOR_PROVIDER` and lets the operator pick the parser model.

**Tech Stack:** Bun, TypeScript, React, `@google/genai`, LM Studio (local Gemma 3 12B), `bun:test`.

---

### Task 1: Extend interpreter classification

**Files:**
- Modify: `src/engine.ts:144-189` (prompt, schema, type union, valid-actions set)
- Test: `src/engine.test.ts` (add interpreter cases)

- [ ] **Step 1: Write failing tests for the new `move-blocked` class**

Append to `src/engine.test.ts` (after the existing `archivistTurn` tests):

```ts
test("interpreterTurn: classifies bare cardinal as move", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  const result = await interpreterTurn("north");
  expect(result).toEqual({ action: "move-north" });
});

test("interpreterTurn: classifies non-movement as stay", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  const result = await interpreterTurn("examine the door");
  expect(result).toEqual({ action: "stay" });
});

test("interpreterTurn: classifies movement-without-cardinal as move-blocked", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));
  const result = await interpreterTurn("go to the train");
  expect(result).toEqual({ action: "move-blocked" });
});

test("interpreterTurn: unknown action falls back to stay", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "fly" }));
  const result = await interpreterTurn("fly to the moon");
  expect(result).toEqual({ action: "stay" });
});
```

Note: the `interpreterTurn` import already exists in this file's import line (`narratorTurn, archivistTurn, interpreterTurn, NARRATOR_SYSTEM`). The existing `callModelStructuredSpy` (lines 7-8, 22-25) is already wired and torn down in `beforeEach`/`afterEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/engine.test.ts -t "interpreterTurn"`
Expected: the `move-blocked` test fails because the result is filtered out by `VALID_ACTIONS` and replaced with `{ action: "stay" }`. The other three should already pass against the current code.

- [ ] **Step 3: Update the interpreter enum, schema, type, and valid-actions set**

In `src/engine.ts`:

Replace the current `INTERPRETER_SYSTEM` constant (lines 144-157) with:

```ts
export const INTERPRETER_SYSTEM = `You classify a single player command in a text adventure into a structured movement intent.

Output JSON with one field, "action", whose value is exactly one of:
- "move-north" — the player intends to move northward
- "move-south" — the player intends to move southward
- "move-east"  — the player intends to move eastward
- "move-west"  — the player intends to move westward
- "stay"       — the player is doing something other than moving (looking, waiting, examining, talking)
- "move-blocked" — the player is trying to MOVE but did not name a cardinal direction

Rules:
- If a cardinal direction (north / south / east / west, or up / down / left / right meaning the same) is named anywhere in the input, classify by that direction even with surrounding words. "go north through the door" → "move-north".
- Pure observation or interaction without movement intent is "stay" (e.g. "look around", "wait", "examine the door", "talk to the woman", "pick up the satchel").
- Movement intent without a cardinal is "move-blocked" (e.g. "go to the train", "walk to the lander", "follow the path", "head toward the crater", "return to the ship", "go through the door").
- "head up the road" alone is "move-blocked"; "head north" is "move-north".
- Output only the JSON object. No prose.`;
```

Replace the `INTERPRETER_SCHEMA` enum (line 164):

```ts
      enum: ["move-north", "move-south", "move-east", "move-west", "stay", "move-blocked"],
```

Replace the `InterpretedAction` union (lines 171-176):

```ts
export type InterpretedAction =
  | { action: "move-north" }
  | { action: "move-south" }
  | { action: "move-east" }
  | { action: "move-west" }
  | { action: "stay" }
  | { action: "move-blocked" };
```

Replace `VALID_ACTIONS` (line 178):

```ts
const VALID_ACTIONS = new Set(["move-north", "move-south", "move-east", "move-west", "stay", "move-blocked"]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/engine.test.ts -t "interpreterTurn"`
Expected: all four interpreter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat(interpreter): add move-blocked classification"
```

---

### Task 2: Add `INTERPRETER_PROVIDER` env switch + Gemini path

**Files:**
- Modify: `src/api.ts` (add interpreter provider, new `callInterpreterStructured`)
- Modify: `src/engine.ts:180-189` (point `interpreterTurn` at the new function)

- [ ] **Step 1: Add the provider constants and startup log line**

In `src/api.ts`, after line 19 (the existing narrator startup log), add:

```ts
const INTERPRETER_MODEL = "google/gemma-3-12b";
const INTERPRETER_PROVIDER = (process.env.INTERPRETER_PROVIDER ?? "local").toLowerCase();
const INTERPRETER_GEMINI_MODEL = process.env.INTERPRETER_GEMINI_MODEL ?? "gemini-2.5-flash";
console.log(`[api] interpreter provider: ${INTERPRETER_PROVIDER}${INTERPRETER_PROVIDER === "gemini" ? ` (${INTERPRETER_GEMINI_MODEL})` : ` (${INTERPRETER_MODEL})`}`);
```

- [ ] **Step 2: Add the Gemini interpreter call**

In `src/api.ts`, after `callNarratorGemini` (after line 49), add:

```ts
async function callInterpreterGemini<T>(
  systemPrompt: string,
  input: string,
  schema: object
): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set (required for INTERPRETER_PROVIDER=gemini)");

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: INTERPRETER_GEMINI_MODEL,
    contents: [{ parts: [{ text: input }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0,
      maxOutputTokens: 64,
      responseMimeType: "application/json",
      responseSchema: schema,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("Empty response from Gemini interpreter");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from Gemini interpreter: ${text}`);
  }
}
```

The `temperature: 0` and `maxOutputTokens: 64` make classification deterministic and fast. `thinkingBudget: 0` avoids the empty-output trap noted in the existing narrator code.

- [ ] **Step 3: Add the public `callInterpreterStructured` switch**

In `src/api.ts`, after `callInterpreterGemini`, add:

```ts
export async function callInterpreterStructured<T>(
  systemPrompt: string,
  input: string,
  schemaName: string,
  schema: object
): Promise<T> {
  if (INTERPRETER_PROVIDER === "gemini") {
    return callInterpreterGemini<T>(systemPrompt, input, schema);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: INTERPRETER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema },
        },
        max_tokens: 64,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${rawText}`);

    let outer: CompletionsResponse;
    try {
      outer = JSON.parse(rawText);
    } catch {
      console.error("[api] raw interpreter response:", rawText);
      throw new Error("Invalid JSON from interpreter API");
    }

    const msg = outer.choices?.[0]?.message;
    const raw = (msg?.reasoning_content || msg?.content || "").trim();
    if (!raw) throw new Error("No content in interpreter response");

    try {
      return JSON.parse(raw) as T;
    } catch {
      console.error("[api] raw interpreter content:", raw);
      throw new Error("Invalid JSON in interpreter response content");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Interpreter timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

Uses `TIMEOUT_MS` (30s, line 8) — interpreter is fast, no need for the 60s archivist budget. No retry wrapper: on failure, `processInput` already falls back to `{ action: "stay" }`.

- [ ] **Step 4: Point `interpreterTurn` at the new function**

In `src/engine.ts`, replace the body of `interpreterTurn` (lines 180-189):

```ts
export async function interpreterTurn(playerInput: string): Promise<InterpretedAction> {
  const result = await api.callInterpreterStructured<{ action: string }>(
    INTERPRETER_SYSTEM,
    `PLAYER INPUT: ${playerInput}`,
    "movement_intent",
    INTERPRETER_SCHEMA
  );
  if (!VALID_ACTIONS.has(result.action)) return { action: "stay" };
  return { action: result.action } as InterpretedAction;
}
```

Only the function call changes (`callModelStructured` → `callInterpreterStructured`).

- [ ] **Step 5: Update the existing test to spy on the new function**

Edit `src/engine.test.ts`. The interpreter tests added in Task 1 mocked `callModelStructuredSpy`. Re-point them at the new spy. Near the top (lines 7-8), add a sibling:

```ts
let callInterpreterStructuredSpy: any;
```

In `beforeEach` (around line 22), add:

```ts
callInterpreterStructuredSpy = spyOn(api, "callInterpreterStructured");
```

In `afterEach` (around line 27), add:

```ts
callInterpreterStructuredSpy.mockRestore();
```

In each of the four interpreter tests added in Task 1, replace `callModelStructuredSpy.mockImplementationOnce` with `callInterpreterStructuredSpy.mockImplementationOnce`.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: all tests pass. If any narrator/archivist tests broke, revert the spy change there — the only file that should newly use `callInterpreterStructured` is the interpreter.

- [ ] **Step 7: Commit**

```bash
git add src/api.ts src/engine.ts src/engine.test.ts
git commit -m "feat(interpreter): INTERPRETER_PROVIDER env (local|gemini)"
```

---

### Task 3: Server short-circuit on `move-blocked`

**Files:**
- Modify: `src/server.ts:39-62` (extend `ServerMessage`)
- Modify: `src/server.ts:99-127` (`processInput` reorder + branch)
- Test: `src/server.test.ts` (new test for short-circuit)

- [ ] **Step 1: Write the failing test**

Append to `src/server.test.ts`:

```ts
test("processInput: move-blocked short-circuits, no narrator/archivist call, sends move-blocked message", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "go to the train", (m) => messages.push(m));

  expect(narratorSpy).not.toHaveBeenCalled();
  expect(archivistSpy).not.toHaveBeenCalled();
  expect(newStack).toBe(emptyStack);
  expect(messages).toEqual([{ type: "move-blocked", input: "go to the train" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server.test.ts -t "move-blocked"`
Expected: FAIL — currently the server falls through to the narrator/archivist on any unknown action.

- [ ] **Step 3: Extend the `ServerMessage` union**

In `src/server.ts`, in the `ServerMessage` union (lines 39-62), add a new variant before the `error` line:

```ts
  | { type: "move-blocked"; input: string }
```

- [ ] **Step 4: Reorder `turn-start` and add the short-circuit branch**

In `src/server.ts`, replace lines 107-118 (from `send({ type: "turn-start" ...` through `const narratorStack ...`) with:

```ts
  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch {
    action = { action: "stay" };
  }

  if (action.action === "move-blocked") {
    send({ type: "move-blocked", input });
    return stack;
  }

  send({ type: "turn-start", input });

  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;
  const narratorStack: WorldStack = { ...stack, position: prospective };
```

The `turn-start` send moves to *after* the short-circuit check, so a blocked move never creates a pending turn slot in the UI.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server.test.ts -t "move-blocked"`
Expected: PASS.

Then run the full server suite to confirm the reorder didn't break anything:

Run: `bun test src/server.test.ts`
Expected: all server tests pass. The existing `stay` and `move-north` tests still see `turn-start` because their actions aren't `move-blocked`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): short-circuit move-blocked, skip narrator/archivist"
```

---

### Task 4: UI toast for `move-blocked`

**Files:**
- Modify: `src/web/app.tsx:43-47` (`ToastData` becomes a union)
- Modify: `src/web/app.tsx:49-73` (`ServerMessage` union)
- Modify: `src/web/app.tsx:1299-1322` (`Toast` component branches on kind)
- Modify: `src/web/app.tsx:362-369` (existing toast call sites set `kind: "world-update"`)
- Modify: `src/web/app.tsx:333-345` (add `move-blocked` handler in `onmessage`)
- Modify: `src/web/styles.css:452-500` (add `.toast.toast-blocked` variant)

- [ ] **Step 1: Generalize `ToastData` to a discriminated union**

In `src/web/app.tsx`, replace the `ToastData` type (lines 43-47):

```ts
type ToastData =
  | { kind: "world-update"; entries: string[]; threads: string[]; id: number }
  | { kind: "blocked"; text: string; id: number };
```

- [ ] **Step 2: Update the existing toast call sites to set `kind`**

In `src/web/app.tsx`, find the existing `setToast({ entries: ..., threads: ..., id: Date.now() })` call (around line 367-368) and change it to:

```ts
setToast({ kind: "world-update", entries: toastEntries, threads: toastThreads, id: Date.now() });
```

There may be other call sites — `grep -n "setToast(" src/web/app.tsx` and add `kind: "world-update"` to each existing object literal.

- [ ] **Step 3: Branch the `Toast` component on `kind`**

In `src/web/app.tsx`, replace the `Toast` component (lines 1299-1322):

```tsx
function Toast({ data, onDismiss }: { data: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10_000);
    return () => clearTimeout(timer);
  }, [data.id]);

  if (data.kind === "blocked") {
    return (
      <div className="toast toast-blocked" role="status" aria-live="polite">
        <div className="toast-header">
          <span className="toast-label">Try a direction</span>
        </div>
        <div className="toast-items">
          <div className="toast-item">{data.text}</div>
        </div>
      </div>
    );
  }

  const allItems = [...data.entries, ...data.threads];
  return (
    <div className="toast" role="status" aria-live="polite">
      <div className="toast-header">
        <span className="toast-label">World updated</span>
      </div>
      <div className="toast-items">
        {allItems.map((item, i) => (
          <div key={i} className="toast-item">{item}</div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Extend `ServerMessage` and add the handler**

In `src/web/app.tsx`, in the `ServerMessage` union (lines 49-73), add before the `error` line:

```ts
  | { type: "move-blocked"; input: string }
```

In the WebSocket `onmessage` switch (around lines 333-345, just before the existing `if (msg.type === "turn-start")` block), add:

```ts
      if (msg.type === "move-blocked") {
        setToast({
          kind: "blocked",
          text: "Cardinal directions only — try north, south, east, or west.",
          id: Date.now(),
        });
        return;
      }
```

- [ ] **Step 5: Add the `.toast-blocked` style variant**

In `src/web/styles.css`, after the `.toast-item:first-child` rule (line 500), add:

```css
.toast.toast-blocked {
  border-left-color: #c54a4a;
}

.toast.toast-blocked .toast-label {
  color: #c54a4a;
}
```

The redder accent reads as "feedback" without going full system-error red.

- [ ] **Step 6: Type-check**

Run: `bunx tsc --noEmit`
Expected: clean. If `ToastData` consumers anywhere else still construct the old shape, the type checker will name them — fix by adding `kind: "world-update"` to those literals.

- [ ] **Step 7: Manual smoke**

Start the server:

Run: `bun --hot ./index.ts`

Open the web UI in a browser. Try inputs and watch behaviour:

| Input | Expected |
|---|---|
| `north` | normal turn, position increments by 1 on x |
| `examine the door` | normal turn, position unchanged |
| `go to the train` | toast appears, **no** turn slot, position unchanged, input box stays populated |
| `walk to the lander` | toast appears, no turn |
| `head north toward the crater` | normal turn, moves north (Gemini provider only — local Gemma may still classify as `move-blocked`) |

If on `INTERPRETER_PROVIDER=gemini`: `go north through the maintenance access door` should now move north (game 2 turn 6 fix).

- [ ] **Step 8: Commit**

```bash
git add src/web/app.tsx src/web/styles.css
git commit -m "feat(web): toast on move-blocked, leave input populated"
```

---

### Task 5: Document the new env vars

**Files:**
- Modify: `README.md` (append to the existing env-var table or section)

- [ ] **Step 1: Find the existing env-var documentation**

Run: `grep -n "NARRATOR_PROVIDER\|GEMINI_API_KEY" README.md`

If the README documents env vars, add `INTERPRETER_PROVIDER` and `INTERPRETER_GEMINI_MODEL` in the same place, with the same wording style as `NARRATOR_PROVIDER`. If there's no env-var section yet, skip this task — the startup log line already announces the configuration.

- [ ] **Step 2: Commit (if README was modified)**

```bash
git add README.md
git commit -m "docs: document INTERPRETER_PROVIDER env var"
```

---

## Self-Review

**Spec coverage:**
- Interpreter `move-blocked` enum + prompt → Task 1 ✓
- Server short-circuit (no narrator/archivist/TTS/image/play-log, stack unchanged) → Task 3 ✓
- `turn-start` reorder so no pending turn slot → Task 3 step 4 ✓
- UI toast via existing `Toast` component, new `kind: "blocked"` variant → Task 4 ✓
- Input box stays populated → Task 4 (no input clearing logic added) ✓
- `INTERPRETER_PROVIDER` env switch mirroring `NARRATOR_PROVIDER` → Task 2 ✓
- Archivist stays local → Task 2 (only `interpreterTurn` is rewired) ✓
- Error fallback to `stay`, not `move-blocked` → Task 3 step 4 (existing try/catch unchanged) ✓
- Test cases for classification + short-circuit → Tasks 1 & 3 ✓

**Type consistency:**
- `InterpretedAction` union (engine.ts) and `VALID_ACTIONS` set (engine.ts) and schema enum (engine.ts) all extended with `move-blocked` in Task 1.
- `ServerMessage` union extended in both server.ts (Task 3) and web/app.tsx (Task 4) — same shape `{ type: "move-blocked"; input: string }`.
- `ToastData` discriminated union — old call sites updated to `kind: "world-update"` in Task 4 step 2; new call site uses `kind: "blocked"` in Task 4 step 4.
- `callInterpreterStructured` signature defined in Task 2 step 3, consumed in Task 2 step 4 — same parameter list.

**No placeholders detected.**
