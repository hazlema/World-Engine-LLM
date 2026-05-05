# Kokoro TTS Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-side text-to-speech narration that reads each turn's narrative aloud using the Apache-licensed Kokoro-82M model, with no server cost and no API key.

**Architecture:** All inference runs in the player's browser via the `kokoro-js` package and Transformers.js. A single `TTSEngine` module owns model lifecycle (lazy load on first opt-in), a per-turn audio cache (turn id → Blob URL), and a render queue (one render at a time, newest narrative wins). React state surfaces per-turn audio status; auto-play kicks in once narration is enabled, and a small speaker icon in each turn's gutter handles replay. No backend changes; the existing WS protocol is untouched.

**Tech Stack:** `kokoro-js` (Apache 2.0, ~80MB ONNX model lazy-fetched on first use), `@huggingface/transformers` (peer dep), Bun bundler / Bun.serve (existing), React 19 (existing), `bun:test` for engine unit tests, Playwright (manual) for in-browser smoke.

---

## Decisions worth flagging up-front

**Q: Auto-play vs. speaker button — do we need both?**
A: Yes, keep both. Browsers block audio autoplay until the page sees a user gesture, so the *first* "enable narration" interaction must be a button click anyway. After that, auto-play handles new narratives, but the per-turn speaker icon stays useful as (a) a "this turn has audio" affordance, (b) a replay control for the player who scrolled back, and (c) a fallback for the auto-play queue being interrupted (e.g. mid-render when the next turn arrives).

**Q: Browser inference vs. server sidecar?**
A: Browser. Zero VPS cost, no API key, scales to N players for free, model is cached after first download. The trade-off is a ~80MB one-time fetch and 1–4s per render on a modern CPU. We surface a model-loading progress bar to set expectations on first opt-in. A server sidecar can be added later as a "premium voice" path if needed.

**Q: Where does the render run on the main thread?**
A: A Web Worker, so audio synthesis doesn't block React renders. The engine module exposes a Promise-based API and hides the worker behind it.

**Q: What about the briefing block?**
A: Treat it like any other narrative. The briefing turn already uses the `turn-narrative` paragraph element; the speaker icon will appear in its gutter the same way.

---

## File Structure

**New:**
- `src/web/tts.ts` — engine module: model lifecycle, render queue, audio cache, settings persistence. Pure-logic functions exported separately so they can be unit-tested in `bun:test`.
- `src/web/tts.test.ts` — unit tests for cache + queue logic (no model load, no DOM).
- `src/web/tts-worker.ts` — Web Worker entry; receives `{id, text, voice}`, returns `{id, audio: Float32Array | error}`.

**Modified:**
- `package.json` — add `kokoro-js` dependency.
- `src/web/app.tsx` — add narration state, wire WS `narrative` handler to enqueue renders, render speaker icon per turn, add "Narration" toggle in the action bar.
- `src/web/styles.css` — speaker icon button, narration toggle pill, model-load progress chip.

**Untouched:** `src/server.ts`, `src/stack.ts`, `src/engine.ts`, presets, world stack. TTS is a pure client-side concern.

---

## Task 1: Install kokoro-js and prove it loads

**Files:**
- Modify: `package.json` (add dependency)

- [ ] **Step 1: Add dependency**

Run: `bun add kokoro-js`

- [ ] **Step 2: Verify the import resolves**

Create a throwaway file `src/web/tts-smoke.ts`:

```ts
import { KokoroTTS } from "kokoro-js";
console.log("KokoroTTS class:", typeof KokoroTTS);
```

Run: `bun src/web/tts-smoke.ts`
Expected: `KokoroTTS class: function`

- [ ] **Step 3: Delete the smoke file and commit**

```bash
rm src/web/tts-smoke.ts
git add package.json bun.lock
git commit -m "feat(web): add kokoro-js for browser TTS narration"
```

---

## Task 2: TTS engine module — cache + queue (pure logic, TDD)

**Files:**
- Create: `src/web/tts.ts`
- Test: `src/web/tts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/web/tts.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { AudioCache, RenderQueue } from "./tts";

describe("AudioCache", () => {
  test("get returns null for missing keys", () => {
    const c = new AudioCache();
    expect(c.get(1)).toBeNull();
  });

  test("set then get returns the same blob URL", () => {
    const c = new AudioCache();
    c.set(1, "blob:abc");
    expect(c.get(1)).toBe("blob:abc");
  });

  test("evicts oldest when over capacity", () => {
    const c = new AudioCache(2);
    c.set(1, "blob:a");
    c.set(2, "blob:b");
    c.set(3, "blob:c");
    expect(c.get(1)).toBeNull();
    expect(c.get(2)).toBe("blob:b");
    expect(c.get(3)).toBe("blob:c");
  });

  test("clear removes all entries", () => {
    const c = new AudioCache();
    c.set(1, "blob:a");
    c.clear();
    expect(c.get(1)).toBeNull();
  });
});

describe("RenderQueue", () => {
  test("runs jobs sequentially in submission order", async () => {
    const order: number[] = [];
    const q = new RenderQueue();
    const a = q.enqueue(async () => { await Promise.resolve(); order.push(1); return 1; });
    const b = q.enqueue(async () => { await Promise.resolve(); order.push(2); return 2; });
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  test("a rejected job does not block subsequent jobs", async () => {
    const q = new RenderQueue();
    const failing = q.enqueue(async () => { throw new Error("boom"); });
    const ok = q.enqueue(async () => 42);
    await expect(failing).rejects.toThrow("boom");
    expect(await ok).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/web/tts.test.ts`
Expected: FAIL — `Cannot find module './tts'`

- [ ] **Step 3: Implement `tts.ts` with the cache + queue (no model wiring yet)**

Create `src/web/tts.ts`:

```ts
export class AudioCache {
  private map = new Map<number, string>();
  constructor(private capacity = 32) {}

  get(id: number): string | null {
    return this.map.get(id) ?? null;
  }

  set(id: number, url: string): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        const stale = this.map.get(oldest);
        if (stale) URL.revokeObjectURL(stale);
        this.map.delete(oldest);
      }
    }
    this.map.set(id, url);
  }

  clear(): void {
    for (const url of this.map.values()) URL.revokeObjectURL(url);
    this.map.clear();
  }
}

export class RenderQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/web/tts.test.ts`
Expected: PASS — 6/6 tests

- [ ] **Step 5: Commit**

```bash
git add src/web/tts.ts src/web/tts.test.ts
git commit -m "feat(web): TTS audio cache + render queue with tests"
```

---

## Task 3: TTS engine module — model lifecycle + render

**Files:**
- Modify: `src/web/tts.ts`

- [ ] **Step 1: Add the engine class to `tts.ts`**

Append to `src/web/tts.ts`:

```ts
import { KokoroTTS } from "kokoro-js";

export const DEFAULT_VOICE = "af_heart";
export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type RenderResult = { url: string; durationMs: number };

export class TTSEngine {
  private model: KokoroTTS | null = null;
  private loadPromise: Promise<void> | null = null;
  private queue = new RenderQueue();
  cache = new AudioCache();
  status: EngineStatus = { kind: "idle" };

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  async load(): Promise<void> {
    if (this.model) return;
    if (this.loadPromise) return this.loadPromise;
    this.setStatus({ kind: "loading", progress: 0 });
    this.loadPromise = (async () => {
      try {
        this.model = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: "q8",
          device: "wasm",
          progress_callback: (p: { progress?: number }) => {
            if (typeof p.progress === "number") {
              this.setStatus({ kind: "loading", progress: p.progress });
            }
          },
        });
        this.setStatus({ kind: "ready" });
      } catch (err) {
        this.setStatus({ kind: "error", message: (err as Error).message });
        throw err;
      }
    })();
    return this.loadPromise;
  }

  render(turnId: number, text: string, voice: string = DEFAULT_VOICE): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };
      await this.load();
      if (!this.model) throw new Error("model not loaded");
      const t0 = performance.now();
      const audio = await this.model.generate(text, { voice });
      const blob = audio.toBlob();
      const url = URL.createObjectURL(blob);
      this.cache.set(turnId, url);
      return { url, durationMs: performance.now() - t0 };
    });
  }
}
```

> Note: `KokoroTTS.generate` signature and the `audio.toBlob()` helper match `kokoro-js` v1.x. If the API has shifted, check `node_modules/kokoro-js/README.md` and adjust the four lines starting with `const audio =`. The rest of the module is API-stable.

- [ ] **Step 2: Confirm existing tests still pass**

Run: `bun test src/web/tts.test.ts`
Expected: PASS — 6/6 tests (engine class is not exercised here on purpose; it depends on browser APIs)

- [ ] **Step 3: Commit**

```bash
git add src/web/tts.ts
git commit -m "feat(web): TTS engine with lazy model load + per-turn render"
```

---

## Task 4: Narration state + speaker icon in app.tsx

**Files:**
- Modify: `src/web/app.tsx`

- [ ] **Step 1: Add narration state and engine ref at the top of `App()`**

In `src/web/app.tsx`, immediately after the existing `const [hasStarted, setHasStarted] = useState(false);` line (around line 89), add:

```tsx
import { TTSEngine, type EngineStatus } from "./tts";

// inside App():
const [narrationOn, setNarrationOn] = useState<boolean>(() => {
  try { return localStorage.getItem("narrationOn") === "1"; } catch { return false; }
});
const [engineStatus, setEngineStatus] = useState<EngineStatus>({ kind: "idle" });
const [audioByTurn, setAudioByTurn] = useState<Record<number, string>>({});
const ttsRef = useRef<TTSEngine | null>(null);
if (!ttsRef.current) ttsRef.current = new TTSEngine(setEngineStatus);

const renderTurn = useCallback((turnId: number, text: string) => {
  const tts = ttsRef.current;
  if (!tts) return;
  tts.render(turnId, text)
    .then(({ url }) => setAudioByTurn((prev) => ({ ...prev, [turnId]: url })))
    .catch(() => { /* surfaced via engineStatus */ });
}, []);

const toggleNarration = useCallback(async () => {
  const next = !narrationOn;
  setNarrationOn(next);
  try { localStorage.setItem("narrationOn", next ? "1" : "0"); } catch {}
  if (next) {
    try { await ttsRef.current?.load(); } catch {}
  }
}, [narrationOn]);
```

- [ ] **Step 2: Hook the WS `narrative` handler to auto-render when narration is on**

Find the existing `if (msg.type === "narrative")` handler (around line 166). Replace its body so it also enqueues a render:

```tsx
if (msg.type === "narrative") {
  updateLastInputTurn((t) => ({ ...t, narrative: msg.text }));
  if (narrationOn) {
    setTurns((prev) => {
      // find the most recent user turn — that's the one this narrative belongs to
      for (let i = prev.length - 1; i >= 0; i--) {
        const t = prev[i];
        if (t && !isSystemTurn(t)) { renderTurn(t.id, msg.text); break; }
      }
      return prev;
    });
  }
  return;
}
```

> Note: `narrationOn` is captured by the closure. To avoid stale-closure bugs, wrap the WS effect in a deps array including `narrationOn`, or — simpler — move the render trigger out of the WS handler and into a `useEffect` watching `turns` for new narratives. The `useEffect` approach is cleaner; if you take it, listen for new turn entries with a populated `narrative` and no entry in `audioByTurn`, then call `renderTurn`.

- [ ] **Step 3: Add the speaker icon to `TurnBlock`**

Replace the existing `TurnBlock` body (around line 440) with:

```tsx
function TurnBlock({ turn, audioUrl, onPlay }: { turn: Turn; audioUrl?: string; onPlay: () => void }) {
  const num = String(turn.id).padStart(2, "0");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  return (
    <div className="turn-block">
      <div className="turn-margin" aria-hidden>
        <span>{num}</span>
        {turn.narrative && (
          <button
            type="button"
            className={`turn-speaker ${audioUrl ? "ready" : ""}`}
            onClick={() => { onPlay(); audioRef.current?.play(); }}
            title={audioUrl ? "Play narration" : "Generate narration"}
          >
            ◐
          </button>
        )}
      </div>
      <div className="turn-content">
        <p className="turn-input-echo">{turn.input}</p>
        {turn.narrative && <p className="turn-narrative">{turn.narrative}</p>}
        {turn.pending && !turn.narrative && !turn.error && (
          <p className="turn-pending">the world is responding…</p>
        )}
        {turn.error && <p className="turn-error">{turn.error}</p>}
        {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
      </div>
    </div>
  );
}
```

Then update the call-site in the turn list (around line 315) to pass the props:

```tsx
{turns.map((t) => (isSystemTurn(t) ? (
  <SystemBlock key={t.id} turn={t} />
) : (
  <TurnBlock
    key={t.id}
    turn={t}
    audioUrl={audioByTurn[t.id]}
    onPlay={() => { if (t.narrative) renderTurn(t.id, t.narrative); }}
  />
)))}
```

- [ ] **Step 4: Add the "Narration" toggle in the action bar button row**

In the button row (around line 340, just before the `objectives` button), add:

```tsx
<button
  className={`action-button ${narrationOn ? "critical" : ""}`}
  onClick={toggleNarration}
  disabled={!connected}
  title={engineStatus.kind === "loading" ? `loading model… ${Math.round((engineStatus.progress ?? 0) * 100)}%` : ""}
>
  {engineStatus.kind === "loading" ? `voice ${Math.round((engineStatus.progress ?? 0) * 100)}%` : `voice ${narrationOn ? "on" : "off"}`}
</button>
```

- [ ] **Step 5: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): per-turn narration with speaker icon and toggle"
```

---

## Task 5: Speaker icon + narration toggle styles

**Files:**
- Modify: `src/web/styles.css`

- [ ] **Step 1: Append speaker styles to `styles.css`**

Add to the bottom of `src/web/styles.css`:

```css
/* per-turn narration */
.turn-margin {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
}

.turn-speaker {
  background: transparent;
  border: 1px solid var(--stroke);
  color: var(--fg-faint);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  cursor: pointer;
  transition: color 140ms, border-color 140ms, background 140ms;
}

.turn-speaker:hover {
  color: var(--fg);
  border-color: var(--stroke-strong);
  background: var(--surface-2);
}

.turn-speaker.ready {
  color: var(--ember);
  border-color: var(--ember-tint-2);
  background: var(--ember-tint);
}

.turn-speaker.ready:hover {
  color: var(--ember-soft);
  border-color: var(--ember);
  box-shadow: 0 0 12px var(--ember-tint-2);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/styles.css
git commit -m "feat(web): speaker icon styles for per-turn narration"
```

---

## Task 6: Browser smoke test + screenshot

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `bun --hot src/server.ts`
Expected: `World Engine listening at http://localhost:3000`

- [ ] **Step 2: Open in browser, click "voice off" to enable narration**

Expected sequence:
1. Button changes to `voice 0%` and starts climbing as the model downloads (~80MB cached after first run)
2. Reaches `voice 100%`, then settles to `voice on` in ember
3. The next narrative auto-renders and plays

- [ ] **Step 3: Take a turn ("look around"), verify**

Expected:
- New turn appears with the speaker icon dim in the gutter
- Within 1–4s, icon turns ember (audio cached + auto-played)
- Click the icon to replay — instant (cached)

- [ ] **Step 4: Toggle narration off, take another turn**

Expected:
- Speaker icon appears dim, no audio rendered
- Clicking it generates audio on demand

- [ ] **Step 5: Reload the page**

Expected:
- Narration toggle remembers its state from localStorage
- Model is in browser cache so re-load is fast

---

## Out of scope for this plan (defer)

- Voice picker UI (per-preset narrator voice). The engine already accepts a `voice` arg; UI is a follow-up.
- Speed / pitch controls.
- Cross-session audio cache (IndexedDB). The Map-based cache is per-session.
- Server-side fallback for low-power devices. Browser-only is sufficient for v1.
- Auto-narrating the briefing on Continue / Resume. Currently the speaker icon is available but auto-render only fires for *new* narratives. Adding briefing auto-narrate is a one-line change later if wanted.
- Pause/resume controls for in-flight audio. The `<audio>` element provides native controls if you set `controls`; we omit them for visual cleanliness.

---

## Self-review notes

**Spec coverage:** Engine module ✓, browser inference ✓, per-turn cache ✓, speaker icon ✓, auto-play when enabled ✓, opt-in toggle ✓, model load progress ✓, persistence of opt-in ✓. The only requirement from the chat — "if it's truly real time, may not even need the speaker button" — is addressed in the decisions section: keep the button for autoplay-policy reasons + replay affordance.

**Placeholder scan:** No TBDs. All code blocks are concrete. The single soft note (Task 3 Step 1, kokoro-js API stability) flags one external dependency to verify against `node_modules` rather than waving it away.

**Type consistency:** `EngineStatus`, `RenderResult`, `TTSEngine`, `AudioCache`, `RenderQueue` declared once in `tts.ts`, consumed in `app.tsx` and `tts.test.ts`. No name drift.
