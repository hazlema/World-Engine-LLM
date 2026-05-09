# Archivist Toast Notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small auto-dismissing toast card (bottom-right) whenever the archivist adds new world entries or threads while the WorldRail section is collapsed.

**Architecture:** Extract a pure `diffNewItems` helper (testable in isolation). Lift `entriesCollapsed`/`threadsCollapsed` state from `WorldRail` into `App`, syncing them into refs so the WebSocket message handler can read current values. In the `stack-update` handler, diff prev vs new entries/threads and call `setToast` when anything new arrived for a collapsed section. A `Toast` component renders the card and auto-dismisses after 10 seconds via `setTimeout`.

**Tech Stack:** Bun + TypeScript + React (Svelte-5-free zone — this is the React frontend). `bun test` for the test suite.

---

## File Structure

**Created:**
- `src/web/utils.ts` — `diffNewItems` pure helper (testable without DOM)
- `src/web/utils.test.ts` — tests for `diffNewItems`

**Modified:**
- `src/web/app.tsx` — import `diffNewItems`; lift collapsed state; add `ToastData` type + `toast` state + refs; trigger toast in `stack-update` handler; add `Toast` component; render `<Toast>` in `App`
- `src/web/styles.css` — add `.toast` CSS + fade/slide animation

---

### Task 1: `diffNewItems` utility + tests

**Files:**
- Create: `src/web/utils.ts`
- Create: `src/web/utils.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/web/utils.test.ts`:

```ts
import { test, expect } from "bun:test";
import { diffNewItems } from "./utils";

test("diffNewItems: empty prev returns all curr", () => {
  expect(diffNewItems([], ["a", "b"])).toEqual(["a", "b"]);
});

test("diffNewItems: no new items returns empty", () => {
  expect(diffNewItems(["a", "b"], ["a", "b"])).toEqual([]);
});

test("diffNewItems: returns only items not in prev", () => {
  expect(diffNewItems(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
});

test("diffNewItems: handles removed items gracefully (returns nothing extra)", () => {
  // archivist should never remove items, but guard against it
  expect(diffNewItems(["a", "b"], ["a"])).toEqual([]);
});

test("diffNewItems: both empty returns empty", () => {
  expect(diffNewItems([], [])).toEqual([]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/web/utils.test.ts`
Expected: FAIL — `diffNewItems` not found.

- [ ] **Step 3: Implement `diffNewItems`**

Create `src/web/utils.ts`:

```ts
export function diffNewItems(prev: string[], curr: string[]): string[] {
  const prevSet = new Set(prev);
  return curr.filter((item) => !prevSet.has(item));
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/web/utils.test.ts`
Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/utils.ts src/web/utils.test.ts
git commit -m "feat(web): add diffNewItems utility with tests"
```

---

### Task 2: Import `diffNewItems` in `app.tsx`

**Files:**
- Modify: `src/web/app.tsx:2` (imports block)

- [ ] **Step 1: Add the import**

In `src/web/app.tsx`, add on line 3 (after the existing imports):

```ts
import { diffNewItems } from "./utils";
```

- [ ] **Step 2: Verify the build**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/app-check.js && rm /tmp/app-check.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/web/app.tsx
git commit -m "chore(web): import diffNewItems into app"
```

---

### Task 3: Add `ToastData` type and lift collapsed state into `App`

**Files:**
- Modify: `src/web/app.tsx` — add `ToastData` type near other types; add collapsed state + refs in `App`; update `WorldRail` props type and body; update `<WorldRail>` JSX call

The collapsed state currently lives inside `WorldRail`. Moving it to `App` lets the WebSocket handler check whether sections are collapsed when new items arrive.

- [ ] **Step 1: Add `ToastData` type**

After the `Stack` type definition (around line 39), add:

```ts
type ToastData = {
  entries: string[];
  threads: string[];
  id: number;
};
```

- [ ] **Step 2: Add collapsed state + refs in `App`**

In the `App` function body, after the existing `useState` declarations (after line ~121), add:

```ts
const [entriesCollapsed, toggleEntries] = useCollapsed("rail.entriesCollapsed", true);
const [threadsCollapsed, toggleThreads] = useCollapsed("rail.threadsCollapsed", true);
// Refs so the WebSocket handler (set up once on mount) always reads current values.
const entriesCollapsedRef = useRef(entriesCollapsed);
const threadsCollapsedRef = useRef(threadsCollapsed);
entriesCollapsedRef.current = entriesCollapsed;
threadsCollapsedRef.current = threadsCollapsed;

const [toast, setToast] = useState<ToastData | null>(null);
```

- [ ] **Step 3: Update `WorldRail` props type**

Replace `src/web/app.tsx` — the `WorldRail` function signature (currently line ~1018):

```ts
function WorldRail(props: {
  entries: string[];
  threads: string[];
  entriesCollapsed: boolean;
  toggleEntries: () => void;
  threadsCollapsed: boolean;
  toggleThreads: () => void;
}) {
```

- [ ] **Step 4: Remove `useCollapsed` calls from `WorldRail` body**

Delete these two lines from inside `WorldRail` (they were lines ~1019-1020):

```ts
  const [entriesCollapsed, toggleEntries] = useCollapsed("rail.entriesCollapsed", true);
  const [threadsCollapsed, toggleThreads] = useCollapsed("rail.threadsCollapsed", true);
```

Then replace all uses of bare `entriesCollapsed`, `toggleEntries`, `threadsCollapsed`, `toggleThreads` inside `WorldRail` with `props.entriesCollapsed`, `props.toggleEntries`, `props.threadsCollapsed`, `props.toggleThreads`.

The full updated `WorldRail` body:

```tsx
  return (
    <div className="rail-card">
      {props.entries.length > 0 && (
        <>
          <button
            type="button"
            className="rail-eyebrow rail-eyebrow-toggle"
            onClick={props.toggleEntries}
            aria-expanded={!props.entriesCollapsed}
          >
            <span className="rail-eyebrow-caret" aria-hidden>{props.entriesCollapsed ? "▸" : "▾"}</span>
            <span>Established ({props.entries.length})</span>
          </button>
          {!props.entriesCollapsed && (
            <ul className="rail-entries">
              {props.entries.map((e, i) => (
                <li key={i} className="rail-entry">
                  <span className="rail-entry-mark" aria-hidden>·</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {props.threads.length > 0 && (
        <>
          <button
            type="button"
            className="rail-eyebrow rail-eyebrow-secondary rail-eyebrow-toggle"
            onClick={props.toggleThreads}
            aria-expanded={!props.threadsCollapsed}
          >
            <span className="rail-eyebrow-caret" aria-hidden>{props.threadsCollapsed ? "▸" : "▾"}</span>
            <span>Loose threads ({props.threads.length})</span>
          </button>
          {!props.threadsCollapsed && (
            <ul className="rail-threads">
              {props.threads.map((t, i) => (
                <li key={i} className="rail-thread">
                  <span className="rail-thread-mark" aria-hidden>→</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
```

- [ ] **Step 5: Update the `<WorldRail>` JSX call in App**

Find where `<WorldRail entries={stack.entries} threads={stack.threads} />` is rendered (around line 453) and replace with:

```tsx
<WorldRail
  entries={stack.entries}
  threads={stack.threads}
  entriesCollapsed={entriesCollapsed}
  toggleEntries={toggleEntries}
  threadsCollapsed={threadsCollapsed}
  toggleThreads={toggleThreads}
/>
```

- [ ] **Step 6: Verify the build**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/app-check.js && rm /tmp/app-check.js && echo OK`
Expected: `OK` — no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/app.tsx
git commit -m "refactor(web): lift rail collapsed state to App for toast access"
```

---

### Task 4: Trigger toast in `stack-update` handler

**Files:**
- Modify: `src/web/app.tsx` — `stack-update` handler block (around lines 256-282)

- [ ] **Step 1: Add toast trigger to the handler**

The current `stack-update` block reads:

```ts
      if (msg.type === "stack-update") {
        setStack((s) => {
          const flips = diffAchievedTexts(s.objectives, msg.objectives);
          if (flips.length > 0) {
            queueMicrotask(() => {
              for (const text of flips) {
                addTurn({
                  id: nextIdRef.current++,
                  kind: "system",
                  title: "✓ Objective complete",
                  items: [text],
                });
              }
            });
          }
          return {
            ...s,
            entries: msg.entries,
            threads: msg.threads,
            objectives: msg.objectives,
            turn: s.turn + 1,
          };
        });
        updateLastInputTurn((t) => ({ ...t, pending: false }));
        setPending(false);
        return;
      }
```

Replace it with:

```ts
      if (msg.type === "stack-update") {
        setStack((s) => {
          const flips = diffAchievedTexts(s.objectives, msg.objectives);
          if (flips.length > 0) {
            queueMicrotask(() => {
              for (const text of flips) {
                addTurn({
                  id: nextIdRef.current++,
                  kind: "system",
                  title: "✓ Objective complete",
                  items: [text],
                });
              }
            });
          }
          const newEntries = diffNewItems(s.entries, msg.entries);
          const newThreads = diffNewItems(s.threads, msg.threads);
          const toastEntries = newEntries.length > 0 && entriesCollapsedRef.current ? newEntries : [];
          const toastThreads = newThreads.length > 0 && threadsCollapsedRef.current ? newThreads : [];
          if (toastEntries.length > 0 || toastThreads.length > 0) {
            queueMicrotask(() => {
              setToast({ entries: toastEntries, threads: toastThreads, id: Date.now() });
            });
          }
          return {
            ...s,
            entries: msg.entries,
            threads: msg.threads,
            objectives: msg.objectives,
            turn: s.turn + 1,
          };
        });
        updateLastInputTurn((t) => ({ ...t, pending: false }));
        setPending(false);
        return;
      }
```

- [ ] **Step 2: Verify the build**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/app-check.js && rm /tmp/app-check.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): trigger archivist toast on new entries/threads when rail collapsed"
```

---

### Task 5: `Toast` component

**Files:**
- Modify: `src/web/app.tsx` — add `Toast` function component before `diffAchievedTexts`

- [ ] **Step 1: Add the component**

Insert the following directly before `export function diffAchievedTexts` (around line 1074):

```tsx
function Toast({ data, onDismiss }: { data: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10_000);
    return () => clearTimeout(timer);
  }, [data.id, onDismiss]);

  const allItems = [
    ...data.entries,
    ...data.threads,
  ];

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

- [ ] **Step 2: Render `<Toast>` in `App`**

In the `App` return JSX, find the closing `</div>` that wraps the entire layout (just before the final `return` closes). Add the toast after the `<div className="dashboard">` block but inside the outer wrapper. The pattern is:

```tsx
      </div> {/* end dashboard or layout root */}
      {toast && <Toast data={toast} onDismiss={() => setToast(null)} />}
    </div>
```

Concretely, find the `<div className="dashboard">` block and place `{toast && ...}` as a sibling after it, before the closing outer `</div>`.

- [ ] **Step 3: Verify the build**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/app-check.js && rm /tmp/app-check.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): add Toast component with 10s auto-dismiss"
```

---

### Task 6: Toast CSS

**Files:**
- Modify: `src/web/styles.css` — add toast rules after the rail section

- [ ] **Step 1: Add CSS**

Append after the last rail rule (after `.rail-thread-mark`):

```css
/* ---------- archivist toast ---------- */

@keyframes toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.toast {
  position: fixed;
  bottom: 6rem; /* clear the action bar */
  right: 1.5rem;
  z-index: 150;
  width: 220px;
  background: var(--surface-1);
  border: 1px solid var(--stroke-mid);
  border-left: 3px solid var(--ember);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  animation: toast-in 150ms ease both;
  overflow: hidden;
}

.toast-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem 0.35rem;
}

.toast-label {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ember);
}

.toast-items {
  padding: 0 0.75rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.toast-item {
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--fg-muted);
  padding: 0.3rem 0;
  border-top: 1px solid var(--stroke-faint, var(--stroke-mid));
}

.toast-item:first-child {
  border-top: none;
}
```

- [ ] **Step 2: Verify the build**

Run: `bun build src/web/app.tsx --target=browser --outfile=/tmp/app-check.js && rm /tmp/app-check.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/styles.css
git commit -m "feat(web): add toast CSS with fade-slide-in animation"
```

---

### Task 7: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the server**

Run: `bun src/server.ts`

- [ ] **Step 2: Open the web client and start a game**

Load the app, pick any preset, make sure the WorldRail Established and Loose threads sections are **collapsed** (default).

- [ ] **Step 3: Submit a turn**

Type any action and submit. After the archivist runs, the toast should appear bottom-right with any new entries or threads listed, separated by dividers. It should auto-dismiss after 10 seconds.

- [ ] **Step 4: Verify no toast when rail is expanded**

Expand the Established section, then submit another turn. Confirm no toast appears for entries (since the section is open). If threads section is still collapsed and new threads arrive, a toast for threads only should appear.

- [ ] **Step 5: Verify replace behavior**

Submit two turns in quick succession (before the toast auto-dismisses). The second turn's toast should replace the first (not stack), and the 10s timer resets.

- [ ] **Step 6: Push**

```bash
git push
```
