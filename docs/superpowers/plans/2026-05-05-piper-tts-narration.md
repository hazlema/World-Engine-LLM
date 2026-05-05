# Piper TTS Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed in-browser kokoro-js TTS with a server-side Piper-based narrator that auto-downloads its binary and voice file on first server start, exposes `POST /api/speak`, and streams back WAV audio for the client to play.

**Architecture:** A new `src/piper.ts` module owns the Piper lifecycle: on server startup it checks for the binary + voice files under `bin/`, downloads them if missing (Linux x86_64 from GitHub Releases + Hugging Face), and exposes a `synthesize(text)` function that spawns the binary as a one-shot process (text in via stdin, WAV out via stdout). The server adds one route, `POST /api/speak`, that calls `synthesize` and returns the bytes as `audio/wav`. The browser-side `src/web/tts.ts` is gutted: KokoroTTS / WebGPU / model lifecycle are removed; the `TTSEngine` becomes a thin `fetch('/api/speak')` wrapper that keeps the existing `AudioCache` + `RenderQueue` so per-turn caching and serial render order are preserved. The `app.tsx` narration UI stays — only the now-unused "loading N%" label is dropped.

**Tech Stack:** Piper (rhasspy/piper, MIT, C++ ONNX), `Bun.spawn` for subprocess invocation, `Bun.write` + `fetch` for downloads, `Bun.$` for tar extraction, existing React 19 + Bun.serve stack.

---

## Decisions baked in

**Voice:** `en_US-lessac-medium` — neutral American narrator, ~63MB total (binary + voice).

**Hosting:** auto-download to `bin/` on first start (option C from the brainstorm). Path is gitignored. README mentions the one-time download. Linux x86_64 only for now; the bootstrap fails loud on other platforms with a clear "manual install" instruction.

**Concurrency:** spawn one piper process per request. Piper is sub-second on CPU; for a hobby demo this is fine. (If we ever need it: piper has a `--http-server` mode we could switch to later — out of scope here.)

**Cache:** keep client-side `AudioCache` + `RenderQueue`. Cache hits avoid re-billing the VPS CPU when a player scrolls back; serial queue avoids spawning N piper processes from one impatient player.

**Removing kokoro-js:** yes, fully. Drop the dependency, drop `patches/kokoro-js@1.2.1.patch`, drop the WebGPU detection. Cleaner client.

---

## File Structure

**New:**
- `src/piper.ts` — Piper lifecycle: `ensurePiperReady()` (idempotent download), `synthesize(text): Promise<Uint8Array>` (spawn → WAV bytes), constants for URLs/paths.
- `src/piper.test.ts` — unit tests for path resolution, URL building, and the "skip download if files exist" branch. The actual subprocess spawn + network download are NOT unit-tested; they're verified in the browser smoke test.

**Modified:**
- `src/server.ts` — call `ensurePiperReady()` before `Bun.serve`, add `POST /api/speak` route that calls `synthesize` and returns WAV bytes.
- `src/web/tts.ts` — rewrite `TTSEngine` to use `fetch('/api/speak')`. Drop the KokoroTTS import, the `load()` model lifecycle, the WebGPU detection, the `device` field, the `EngineStatus.loading.progress` shape (loading is now instantaneous so the variant collapses to `ready`/`error`/`idle`).
- `src/web/tts.test.ts` — the AudioCache + RenderQueue tests stay verbatim. No new tests for the engine itself (network calls are integration territory).
- `src/web/app.tsx` — the toggle button label currently shows `voice N%` during model load; remove that branch, leave just `voice on` / `voice off`.
- `package.json` — remove `kokoro-js` from dependencies; remove the `patchedDependencies` block.
- `.gitignore` — add `bin/` so the auto-downloaded binary + voice files are not tracked.
- `README.md` — add a short "Narration" subsection in the Quickstart explaining the one-time download.
- `patches/kokoro-js@1.2.1.patch` — delete the file (no longer applicable).

**Untouched:** the title page, dashboard, rails, briefing block, all the existing tests for stack/engine/server/api/presets, the LM Studio integration.

---

## Task 1: Piper lifecycle module — paths, URLs, idempotency check (TDD)

**Files:**
- Create: `src/piper.ts`
- Test: `src/piper.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/piper.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piperPaths, isPiperReady } from "./piper";

describe("piperPaths", () => {
  test("derives all four paths under the given root", () => {
    const p = piperPaths("/some/root");
    expect(p.binDir).toBe("/some/root");
    expect(p.binary).toBe("/some/root/piper/piper");
    expect(p.voiceModel).toBe("/some/root/voices/en_US-lessac-medium.onnx");
    expect(p.voiceConfig).toBe("/some/root/voices/en_US-lessac-medium.onnx.json");
  });
});

describe("isPiperReady", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "piper-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns false when binary is missing", async () => {
    expect(await isPiperReady(dir)).toBe(false);
  });

  test("returns false when binary exists but voice files don't", async () => {
    mkdirSync(join(dir, "piper"), { recursive: true });
    writeFileSync(join(dir, "piper/piper"), "");
    expect(await isPiperReady(dir)).toBe(false);
  });

  test("returns true when binary, model, and config all exist", async () => {
    mkdirSync(join(dir, "piper"), { recursive: true });
    mkdirSync(join(dir, "voices"), { recursive: true });
    writeFileSync(join(dir, "piper/piper"), "");
    writeFileSync(join(dir, "voices/en_US-lessac-medium.onnx"), "");
    writeFileSync(join(dir, "voices/en_US-lessac-medium.onnx.json"), "{}");
    expect(await isPiperReady(dir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test src/piper.test.ts`
Expected: FAIL — `Cannot find module './piper'`

- [ ] **Step 3: Implement `src/piper.ts` paths + readiness check**

Create `src/piper.ts`:

```ts
import { Bun } from "bun";

export const PIPER_VERSION = "2023.11.14-2";
export const PIPER_BINARY_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz`;

export const VOICE_NAME = "en_US-lessac-medium";
export const VOICE_MODEL_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${VOICE_NAME}.onnx`;
export const VOICE_CONFIG_URL = `${VOICE_MODEL_URL}.json`;

export interface PiperPaths {
  binDir: string;
  binary: string;
  voiceModel: string;
  voiceConfig: string;
}

export function piperPaths(binDir: string): PiperPaths {
  return {
    binDir,
    binary: `${binDir}/piper/piper`,
    voiceModel: `${binDir}/voices/${VOICE_NAME}.onnx`,
    voiceConfig: `${binDir}/voices/${VOICE_NAME}.onnx.json`,
  };
}

export async function isPiperReady(binDir: string): Promise<boolean> {
  const p = piperPaths(binDir);
  const checks = await Promise.all([
    Bun.file(p.binary).exists(),
    Bun.file(p.voiceModel).exists(),
    Bun.file(p.voiceConfig).exists(),
  ]);
  return checks.every(Boolean);
}
```

> Note: the unused `import { Bun } from "bun"` line is intentional cosmetic noise — `Bun` is a global at runtime. If your linter complains, remove the import; otherwise leave it for clarity.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test src/piper.test.ts`
Expected: PASS — 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add src/piper.ts src/piper.test.ts
git commit -m "$(cat <<'EOF'
feat(piper): paths + readiness check for the bundled binary + voice

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Piper download + extract (no tests — verified by smoke test in Task 7)

**Files:**
- Modify: `src/piper.ts`

- [ ] **Step 1: Append the bootstrap function to `src/piper.ts`**

Add to the bottom of `src/piper.ts`:

```ts
import { mkdir, chmod } from "node:fs/promises";
import { $ } from "bun";

export async function ensurePiperReady(binDir: string): Promise<void> {
  if (await isPiperReady(binDir)) return;

  console.log("[piper] first run — downloading binary + voice (~63 MB) ...");
  const p = piperPaths(binDir);

  await mkdir(`${binDir}/piper`, { recursive: true });
  await mkdir(`${binDir}/voices`, { recursive: true });

  // 1. Download + extract the binary tarball
  const tarPath = `${binDir}/piper.tar.gz`;
  if (!(await Bun.file(p.binary).exists())) {
    console.log(`[piper] fetching ${PIPER_BINARY_URL}`);
    const res = await fetch(PIPER_BINARY_URL);
    if (!res.ok) throw new Error(`piper download failed: ${res.status} ${res.statusText}`);
    await Bun.write(tarPath, res);
    await $`tar -xzf ${tarPath} -C ${binDir}`.quiet();
    await chmod(p.binary, 0o755);
    await Bun.file(tarPath).delete();
    console.log(`[piper] binary ready at ${p.binary}`);
  }

  // 2. Download voice model + config
  for (const [url, dest] of [
    [VOICE_MODEL_URL, p.voiceModel],
    [VOICE_CONFIG_URL, p.voiceConfig],
  ] as const) {
    if (await Bun.file(dest).exists()) continue;
    console.log(`[piper] fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`voice download failed (${url}): ${res.status}`);
    await Bun.write(dest, res);
  }

  console.log(`[piper] voice ready at ${p.voiceModel}`);
  console.log(`[piper] ready.`);
}

export async function synthesize(binDir: string, text: string): Promise<Uint8Array> {
  const p = piperPaths(binDir);
  const proc = Bun.spawn([p.binary, "--model", p.voiceModel, "--output_file", "-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(text);
  await proc.stdin.end();
  const wav = await new Response(proc.stdout).bytes();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`piper exited ${exitCode}: ${err}`);
  }
  return wav;
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `bun test src/piper.test.ts`
Expected: PASS — 4/4 tests (the four from Task 1 still pass; nothing new is added)

- [ ] **Step 3: Commit**

```bash
git add src/piper.ts
git commit -m "$(cat <<'EOF'
feat(piper): one-time download + spawn-per-request synthesize

ensurePiperReady downloads the linux x86_64 piper binary from GitHub
Releases (~25 MB) and the en_US-lessac-medium voice from Hugging Face
(~38 MB) into bin/piper and bin/voices on first server start. Idempotent
on subsequent runs. synthesize spawns piper one-shot per request,
piping text in via stdin and reading the WAV from stdout.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire `/api/speak` route + startup hook into `src/server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Locate the changes**

The current `src/server.ts` has a startup function (around line 270) that loads presets, the world stack, and the bundled `index.html`, then calls `Bun.serve(...)`. The `Bun.serve` block has a `routes` object with just `"/"` and a `fetch` handler that handles `/ws` plus a 404 fallback. You're adding:
- An `await ensurePiperReady(...)` call BEFORE `Bun.serve`
- A `POST /api/speak` branch in the `fetch` handler that reads `{ text }` from the body, calls `synthesize`, and returns the WAV bytes.

- [ ] **Step 2: Add the import at the top of `src/server.ts`**

Find the existing imports near the top of `src/server.ts`. After the existing `import { loadAllPresets, type Preset } from "./presets";` line, add:

```ts
import { ensurePiperReady, synthesize } from "./piper";

const PIPER_BIN_DIR = new URL("../bin", import.meta.url).pathname;
```

- [ ] **Step 3: Call `ensurePiperReady` at startup**

Find the function that starts the server (around line 270). Just before the line `const server = Bun.serve({` add:

```ts
await ensurePiperReady(PIPER_BIN_DIR);
```

- [ ] **Step 4: Add the `/api/speak` branch in the fetch handler**

Find the existing `fetch(req, server)` handler in the Bun.serve block. It currently looks like:

```ts
fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === "/ws") {
    if (server.upgrade(req)) return;
    return new Response("Upgrade required", { status: 426 });
  }
  return new Response("Not found", { status: 404 });
},
```

Replace it with:

```ts
async fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === "/ws") {
    if (server.upgrade(req)) return;
    return new Response("Upgrade required", { status: 426 });
  }
  if (url.pathname === "/api/speak" && req.method === "POST") {
    try {
      const body = await req.json() as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return new Response("text required", { status: 400 });
      if (text.length > 4000) return new Response("text too long", { status: 413 });
      const wav = await synthesize(PIPER_BIN_DIR, text);
      return new Response(wav, {
        headers: {
          "Content-Type": "audio/wav",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error("[/api/speak]", err);
      return new Response("speak failed", { status: 500 });
    }
  }
  return new Response("Not found", { status: 404 });
},
```

> Note: the `fetch` keyword changes from sync to `async`. The `req.json()` parse + the `synthesize` call both need awaiting.

- [ ] **Step 5: Verify the existing test suite still passes**

Run: `bun test`
Expected: PASS — all existing tests stay green. The server tests don't exercise `/api/speak` (it's network + filesystem heavy), so coverage there is intentional.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): /api/speak route + piper bootstrap on startup

POST { text } returns audio/wav from the bundled piper voice. Bootstrap
runs once on first start; subsequent restarts are instant. Body is
length-capped at 4000 chars and validated to be a non-empty string.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `src/web/tts.ts` as a fetch-backed engine

**Files:**
- Modify: `src/web/tts.ts`

- [ ] **Step 1: Replace the engine — keep AudioCache + RenderQueue verbatim**

Open `src/web/tts.ts`. Keep the `AudioCache` and `RenderQueue` classes (and their existing exports) exactly as they are. Replace EVERYTHING from `import { KokoroTTS } from "kokoro-js";` at the top — through to the end of file (the `TTSEngine` class) — with the following.

At the very top of the file, REMOVE the line:
```ts
import { KokoroTTS } from "kokoro-js";
```

At the bottom of the file, REPLACE the entire current `TTSEngine` class plus its preceding constants (`DEFAULT_VOICE`, `MODEL_ID`, `EngineStatus`, `RenderResult`) with:

```ts
export type EngineStatus =
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type RenderResult = { url: string; durationMs: number };

export class TTSEngine {
  private queue = new RenderQueue();
  cache = new AudioCache();
  status: EngineStatus = { kind: "idle" };

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  // No model to load — engine is "ready" the moment the toggle flips on.
  // Kept as an async method so the existing call-site (`await ttsRef.current?.load()`)
  // doesn't need to change.
  async load(): Promise<void> {
    if (this.status.kind === "ready") return;
    this.setStatus({ kind: "ready" });
  }

  render(turnId: number, text: string): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };
      const t0 = performance.now();
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const message = `speak failed: ${res.status}`;
        this.setStatus({ kind: "error", message });
        throw new Error(message);
      }
      const blob = await res.blob();
      const dur = performance.now() - t0;
      console.info(`[tts] render turn ${turnId}: ${text.length} chars in ${Math.round(dur)}ms`);
      const url = URL.createObjectURL(blob);
      this.cache.set(turnId, url);
      return { url, durationMs: dur };
    });
  }
}
```

- [ ] **Step 2: Verify the existing tests still pass**

Run: `bun test src/web/tts.test.ts`
Expected: PASS — 8/8 tests (the AudioCache + RenderQueue tests are untouched; no new tests for the network-backed engine because that's verified in the smoke test).

- [ ] **Step 3: Commit**

```bash
git add src/web/tts.ts
git commit -m "$(cat <<'EOF'
feat(web): TTS engine now fetches /api/speak instead of in-browser kokoro

Drops KokoroTTS, the WebGPU dance, the model-load lifecycle. Cache
and queue stay; render becomes a simple POST + blob URL. Engine
status collapses to idle/ready/error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drop the `voice N%` loading label from the action-bar toggle

**Files:**
- Modify: `src/web/app.tsx`

- [ ] **Step 1: Find the toggle button**

In `src/web/app.tsx`, find the narration toggle in the action-bar button row. It currently looks something like:

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

- [ ] **Step 2: Replace with the simplified version**

Replace the button block with:

```tsx
<button
  className={`action-button ${narrationOn ? "critical" : ""}`}
  onClick={toggleNarration}
  disabled={!connected}
  title={engineStatus.kind === "error" ? engineStatus.message : ""}
>
  voice {narrationOn ? "on" : "off"}
</button>
```

The `title` now surfaces an error message on hover when something failed (so the user gets a hint via tooltip if `/api/speak` 500s); the label is just `voice on` / `voice off` since there's no async loading state.

- [ ] **Step 3: Verify nothing else references the old loading variant**

Run: `grep -n 'engineStatus.kind === "loading"' src/web/app.tsx`
Expected: empty output

If anything turns up, replace those branches with sensible no-loading equivalents. (There shouldn't be any — the only consumer was the button label.)

- [ ] **Step 4: Verify tests still pass**

Run: `bun test`
Expected: all tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/app.tsx
git commit -m "$(cat <<'EOF'
feat(web): narration toggle drops loading label, surfaces error in tooltip

Server-side TTS has no model-load phase, so the voice button is just
on/off. Errors from /api/speak surface as a hover tooltip.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Remove kokoro-js dependency, the patch, and add `bin/` to .gitignore

**Files:**
- Modify: `package.json`, `bun.lock` (auto), `.gitignore`
- Delete: `patches/kokoro-js@1.2.1.patch`, `patches/` (if empty after delete)

- [ ] **Step 1: Remove the dependency**

Run: `bun remove kokoro-js`
Expected: dependency removed from `package.json`, `bun.lock` updated.

- [ ] **Step 2: Manually clear the patchedDependencies block in package.json**

Open `package.json`. There's a `"patchedDependencies": { "kokoro-js@1.2.1": "patches/kokoro-js@1.2.1.patch" }` block. Delete that entire key (and the trailing comma if it leaves dangling). The file should still be valid JSON.

- [ ] **Step 3: Delete the patch file and the patches directory if empty**

Run:
```bash
rm patches/kokoro-js@1.2.1.patch
rmdir patches 2>/dev/null || true
```

- [ ] **Step 4: Add `bin/` to .gitignore**

Open `.gitignore`. At the bottom, add:

```
# piper binary + voices auto-downloaded on first server start
bin/
```

- [ ] **Step 5: Verify the bundle still builds and tests still pass**

Run: `bun test`
Expected: all tests pass.

Run: `grep -rn "kokoro" src/` 
Expected: empty (no remaining references to the removed dep).

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock .gitignore
git rm patches/kokoro-js@1.2.1.patch 2>/dev/null || true
# If patches/ became empty and was removed, that's fine; git rm above handled it
git commit -m "$(cat <<'EOF'
chore(web): drop kokoro-js dependency + its bundler patch

Server-side piper replaces in-browser kokoro entirely. Removes the
dep, the patches/ workaround for Bun's browser-field handling, and
ignores the auto-downloaded bin/ tree.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: README update + browser smoke test (verification only)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Narration subsection to README.md**

Open `README.md`. After the "Quickstart" numbered list (after the "Open http://localhost:3000" instruction), add:

```markdown
### Narration (optional)

The web app can read each turn aloud using [Piper](https://github.com/rhasspy/piper) — a small, fast, Linux-friendly TTS. On first start, the server downloads the piper binary (~25 MB) and the `en_US-lessac-medium` voice (~38 MB) into `bin/`. Subsequent starts skip the download. The download is one-time and Linux x86_64 only; on other platforms install piper manually and place the binary at `bin/piper/piper`.

Toggle narration in-app via the **voice off / voice on** button in the action bar. Audio renders are cached per turn; replays are instant. Disable any time — settings persist via `localStorage`.
```

- [ ] **Step 2: Commit the README change**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: explain piper narration in README quickstart

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Smoke test in the browser (manual)**

The browser smoke test for this plan is necessarily manual / Playwright-driven and should be done by the controller after subagent execution finishes. Verify:

1. Stop any running dev server, then run `bun --hot src/server.ts`. Expect on first run: `[piper] first run — downloading binary + voice (~63 MB) ...` followed by `[piper] ready.` Then `World Engine listening at http://localhost:3000`.
2. Open `http://localhost:3000`, click Resume (or pick a story), click **voice off** to enable narration. Button should immediately flip to **voice on** in ember (no async loading state).
3. Take a turn ("look around"). Within ~1-2 seconds the speaker icon in the turn margin should turn ember and audio should auto-play.
4. Open devtools Console. Expect: `[tts] render turn N: M chars in T ms`. T should be 500-2000ms (server-side piper), not the 30+s we had with kokoro/wasm.
5. Click an old turn's speaker icon — should replay instantly from cache.
6. Reload the page. Narration toggle remembers its state (localStorage).
7. Toggle off, take a turn — speaker icon stays dim, no audio plays. Click it manually to render on demand.

If any step fails:
- Step 1 (download): check internet, check that `bin/` is writable. The tarball URL or voice URL may have moved — verify against `https://github.com/rhasspy/piper/releases` and `https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium`.
- Step 3 (no audio): open Network tab, check the `POST /api/speak` request — it should return `audio/wav` with non-trivial body. If 500: `tail` the server log for the `[/api/speak]` error.
- Step 4 (slow render): piper running in WASM-emulation? Check `file bin/piper/piper` — should report ELF 64-bit. If on non-Linux platform without manual install, follow the README's manual-install fallback.

---

## Out of scope for this plan (defer)

- Voice picker UI (per-preset narrator). Server already takes any voice file in `bin/voices/`; UI is a follow-up.
- Multiple platforms. Linux x86_64 only for the auto-download. macOS / Windows users get a manual-install path in the README.
- Server-side audio caching. The client cache covers replay. If multiple players hit the same preset's briefing, each pays the piper CPU cost. Consider a server-side LRU later if engagement justifies it.
- Rate limiting per user / IP. Hobby demo for now; add when you go public on the VPS.
- Streaming audio. Piper produces a complete WAV; we send it whole. Browser plays as soon as the response finishes. Streaming chunks would shave perceived latency but adds plumbing.
- Long-running piper-server mode (`--http-server` flag). Skipped because spawn-per-request is < 100ms overhead for piper and adds zero state for us to manage.

---

## Self-review notes

**Spec coverage:**
- Auto-download on first start ✓ (Task 2)
- Server route ✓ (Task 3)
- Client engine swap ✓ (Task 4)
- Action bar UI cleanup ✓ (Task 5)
- Cache + queue preserved ✓ (Task 4 keeps both)
- kokoro-js fully removed ✓ (Task 6)
- README update ✓ (Task 7)

**Placeholder scan:** No TBDs. Every code block is concrete. Two soft notes (the unused `Bun` import in Task 1, the URL-stability note in Task 7) flag edge cases the implementer should be aware of.

**Type consistency:** `EngineStatus` shrinks from 4 variants to 3 (loading is gone). `TTSEngine.load()` is kept for back-compat with the existing `toggleNarration` call-site in `app.tsx`. `RenderResult` shape unchanged. `AudioCache` / `RenderQueue` shapes unchanged. `synthesize(binDir, text): Promise<Uint8Array>` consistent between Task 2 (defines it) and Task 3 (consumes it).
