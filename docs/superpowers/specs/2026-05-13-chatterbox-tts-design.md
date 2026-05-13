# Chatterbox TTS Integration — Design Spec

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan
**Predecessors:** `2026-05-13-env-reorg-design.md` (Phase 1 of dispatcher work, merged)

## Goal

Replace Gemini Live TTS with self-hosted ResembleAI Chatterbox Turbo. Cost drops from "fractions of a penny per turn" to zero ongoing. Quality stays in the narrative-atmosphere band (Chatterbox Turbo benchmarks at 63.75% blind preference vs ElevenLabs Turbo v2.5). Apache 2.0 license — bundleable, modifiable, no token quotas.

A side benefit: Chatterbox's whole-WAV-at-once API lets us delete most of the streaming-PCM machinery built earlier in the audio refactor. Net: cheaper, simpler, better-sounding.

## Non-goals

- Multi-language TTS (Chatterbox Multilingual is a separate model; English-only Turbo is enough for now).
- Voice cloning from user-supplied audio. Curated bundled voices only.
- Streaming text input to Chatterbox (it generates per-call, not per-token).
- Web Speech API fallback. If Chatterbox isn't running, narration is just off.
- Maintaining backward compatibility with Gemini Live TTS — full replacement.

## Architecture

Two processes:

1. **Bun server** (existing) — WebSocket, game logic, LLM dispatch, image generation, frontend serving. Spawns the sidecar at boot; talks to it over HTTP.
2. **Python sidecar** (new) at `tts_sidecar/server.py` — FastAPI app. Owns the Chatterbox model in GPU memory and the bundled voice reference clips. Stateless per-request.

The two processes communicate over local HTTP. No Unix sockets, no shared memory — HTTP is debuggable with `curl`, well-supported in both languages, and the request frequency is one-per-turn so the overhead is negligible.

## Data flow

### Turn audio (initial generation)
```
WS input → narrator LLM → narrative text
                              ↓
                    Bun: compute hash = sha256(text + voice).slice(0, 16)
                              ↓
                    Bun: check media/audio/<hash>.wav exists?
                              ↓
                    no → POST /tts to sidecar (text, voice)
                              ↓
                          Chatterbox generates full WAV (~0.5-2s on consumer GPU)
                              ↓
                          Bun saves to media/audio/<hash>.wav
                              ↓
                          Bun sends WS msg {type: "audio-ready", turnId, url: "/media/audio/<hash>.wav"}
                              ↓
                    Frontend sets <audio src={url}> and plays
```

### Replay (same-session or cross-session)
```
Speaker click → frontend reuses turn's known url → <audio>.play()
                              ↓
                 Browser's HTTP cache serves /media/audio/<hash>.wav locally
                 (file on disk; same hash across sessions = same file)
```

Disk cache makes replays after server restart instant. Same narrative + same voice always produces the same hash, so cross-session reuse just works. No separate client-side blob cache needed — the browser's normal HTTP caching handles it transparently.

## Components & interfaces

### Python sidecar (`tts_sidecar/server.py`)

FastAPI app, exactly two endpoints. No state beyond the loaded model and voice-reference paths.

**`GET /health`** → `200 OK`
```json
{ "ready": true, "voices": ["noir", "warm", "crisp"] }
```
`ready` flips true after the model finishes loading. `voices` lists the slug IDs of the bundled reference clips.

**`POST /tts?voice=<slug>`**
- Body: `text/plain`, the narrative to read
- Response on success: `200 OK` with `Content-Type: audio/wav`, body = the generated WAV bytes
- Response on missing voice: `404` with text body explaining
- Response on empty text: `400`
- Response on generation failure: `500` with error text

### Bun-side, `src/tts.ts` (renamed from `gemini-tts.ts`)

- `synthesizeToFile(text: string, voice: string): Promise<string>` — computes the content hash, checks disk, calls sidecar if needed, writes the WAV to `media/audio/<hash>.wav`, returns the public URL path (e.g., `/media/audio/<hash>.wav`).
- `waitForSidecarReady(timeoutMs: number): Promise<boolean>` — polls `/health` until `ready: true` or timeout. Used during startup.
- `listSidecarVoices(): Promise<string[]>` — fetches `/health` once, returns the voice list. Used to populate the voice picker.

### Bun-side, `src/sidecar.ts` (new)

- `spawnSidecar(): ChildProcess` — runs `python3 tts_sidecar/server.py` as a child of the Bun process.
- Streams sidecar stdout/stderr to the Bun console with a `[tts-sidecar]` prefix so the user sees what's happening.
- Updates a module-level `narrationReady: boolean` flag after `/health` polling succeeds.
- Wires SIGINT/SIGTERM handlers so killing Bun also kills the Python child.

### Frontend, `src/web/playback-controller.ts` (slimmed)

The controller's responsibilities collapse to coordinating a single `<audio>` element. The state machine becomes:

- `idle` — nothing playing
- `playing` — element is actively playing audio for some turn ID

Methods:
- `play(turnId: number, url: string): void` — pause current (if any), set the element's `src`, call `.play()`
- `abortCurrent(): void` — pause the element, transition to idle
- `setEnabled(on: boolean): void` — if off, abort current; affects future `play` calls
- `setVoice(voice: string): void` — abort current (cached audio is for the old voice; new audio will need fresh generation)
- `isAudible(): boolean` — true if element is playing or about to play

No `AudioContext`. No `AudioBufferSource`. No chunk arrays. No tail bookkeeping. Volume is set directly via `audioElement.volume`.

## Bundled voice references

Three voices ship in the repo at `tts_sidecar/voices/<slug>.wav`:

| Slug | Character |
|---|---|
| `noir` | Gravelly, slower-paced, mystery/horror flavor |
| `warm` | Storyteller, friendly, mid-paced, fantasy/cozy flavor |
| `crisp` | Clear narrator, neutral, sci-fi/serious flavor |

Each reference is ~10 seconds of speech, generated using `tts_sidecar/generate_voices.py` — a one-time script committed for reproducibility but not invoked by the server. The script uses Chatterbox in its default (no-reference) mode to synthesize seed audio, then we trim/select the cleanest 10-second window for each character. WAVs are committed to the repo (small, <500KB each).

If we add voices later, regenerate via the same script and commit the new WAV.

## Process lifecycle

**Boot sequence:**

1. Bun's `main()` reads config (loadConfig already exists from env-reorg work).
2. If `useGeminiImages` or any other Gemini feature, validate `GEMINI_API_KEY`. Same as today.
3. `spawnSidecar()` starts the Python process in the background. Bun does NOT wait for the model to finish loading.
4. Bun's HTTP server starts immediately, accepts WebSocket connections, serves the game.
5. In parallel, `waitForSidecarReady(15_000)` polls `/health`. On success, flips `narrationReady=true`. On timeout, logs warning, leaves `narrationReady=false` permanently.
6. The snapshot's `providers` payload includes a `narrationReady: boolean` so the frontend can show a "warming up..." indicator on the voice toggle button if the user opens it before the model is ready.

**Shutdown:**

- Bun catches SIGINT/SIGTERM.
- Kills the Python child with SIGTERM (allowing FastAPI to shut down cleanly).
- After 3 seconds, escalates to SIGKILL if still running.

## Configuration changes

`.env-sample` changes:

- **Drop** `USE_GEMINI_NARRATION` entirely. Gemini is no longer a TTS path.
- **Add** `USE_NARRATION=true|false` (defaults to true). Single switch for the whole narration feature. When false, Bun does NOT spawn the sidecar at all — no Python required, no model load, no UI toggle. When true (the default), Bun spawns the sidecar; whether the user actually hears narration depends on the in-app voice toggle.
- `GEMINI_API_KEY` becomes images-only. README updated accordingly.

`USE_GEMINI_IMAGES` stays as-is.

## Error handling

| Failure | Behavior |
|---|---|
| `python3` not on PATH at Bun startup | Logs `[tts] python3 not found — narration unavailable. Install Python 3.11+ to enable.` Sets `narrationReady=false` permanently. UI narration toggle stays disabled. Game runs. |
| `python3` exists but `chatterbox-tts` not installed | Sidecar process exits with import error. Bun treats as previous row — log + disable. |
| Model load fails (no GPU, weights corrupt) | Sidecar logs error and exits. Bun treats as previous row. |
| Sidecar crashes after boot during a request | Bun logs the stderr, marks `narrationReady=false`, attempts ONE restart after 5 seconds. Persistent failure → narration stays off for the rest of the session. |
| `POST /tts` returns 5xx | Bun logs the error, sends `{type: "audio-error", turnId, message}` WS message to the client, no audio for that turn. Subsequent turns still try. |
| `POST /tts` times out (30s) | Same as 5xx. The narrative is still on screen; the turn isn't blocked. |
| User clicks speaker on a turn whose `media/audio/<hash>.wav` was deleted manually | Re-generates on demand via the same path as initial turn audio. |
| Disk full when writing WAV | Generate succeeds, write fails, log error, send `audio-ready` with no URL (frontend skips playback). Subsequent turns still try. |

## Testing approach

**Python sidecar:**
- `tts_sidecar/test_server.py` using FastAPI's `TestClient`. Mock `ChatterboxTurboTTS.from_pretrained` and `generate` so tests run without the actual model. Cases:
  - `/health` returns expected shape (ready false until model loaded; voice list)
  - `/tts?voice=noir` with valid text returns `audio/wav` content type
  - `/tts?voice=bogus` returns 404
  - `/tts` with empty body returns 400
  - `/tts` with mock generate that throws returns 500
- Run via `pytest tts_sidecar/test_server.py`. Adds `pytest` to `tts_sidecar/requirements.txt`.

**Bun-side:**
- `src/sidecar.test.ts` — mock `Bun.spawn` to verify startup polling, ready-flag flip, shutdown signal forwarding. Doesn't actually spawn Python.
- `src/tts.test.ts` (rewrite of the existing) — verify the hash-cache logic: same `(text, voice)` produces same path; cache hit avoids the sidecar call; cache miss writes to disk. Use temp directory for the cache root.
- `src/web/playback-controller.test.ts` — adapt to new `<audio>` element model. Most existing tests (chunk overlap, byte alignment, tail killing) get deleted because those failure modes no longer exist. New tests: play(url) calls .play() on the element, abortCurrent pauses, switching voice aborts, isAudible reads the element's paused state.
- `src/server.test.ts` — update the TTS-related test to expect the new `audio-ready` WS message shape, not `audio-start/chunk/end`.

**Manual verification matrix** (run via `bun --hot src/server.ts` after merge):

| Scenario | Expected |
|---|---|
| Boot, wait for `[tts-sidecar] ready` log | Narration toggle becomes clickable; warmup indicator disappears |
| Submit turn with narration on | Narrative renders; audio plays within a second of text appearing |
| Submit turn, audio plays, submit next turn before audio finishes | Current audio stops, next audio starts (no overlap, no chop) |
| Change voice mid-session | Current audio stops; next turn renders fresh audio in new voice |
| Toggle narration off mid-playback | Audio stops immediately |
| Click speaker on an old turn | Plays the cached file from disk, instantly |
| Click speaker on an old turn after `media/audio/` deletion | Re-generates, plays |
| Kill Python sidecar from another terminal | Bun logs the crash, attempts one restart, then disables narration if it fails again |

## File changes summary

**Created:**
- `tts_sidecar/server.py`
- `tts_sidecar/requirements.txt`
- `tts_sidecar/README.md` (Python setup instructions, GPU notes)
- `tts_sidecar/voices/noir.wav`, `tts_sidecar/voices/warm.wav`, `tts_sidecar/voices/crisp.wav`
- `tts_sidecar/generate_voices.py` (committed for reproducibility, run once)
- `tts_sidecar/test_server.py`
- `src/sidecar.ts`
- `src/sidecar.test.ts`

**Renamed / heavily modified:**
- `src/gemini-tts.ts` → `src/tts.ts` (renamed, fully rewritten — just the hash+sidecar client now)
- `src/web/playback-controller.ts` (slimmed to `<audio>` element coordination)
- `src/web/playback-controller.test.ts` (most existing tests deleted, new ones for `<audio>` model)

**Modified:**
- `src/server.ts` — spawn sidecar at startup, drop audio-chunk WS path, add audio-ready emission
- `src/web/app.tsx` — handle `audio-ready` WS message, drop audio-chunk handlers, simplified speaker click using new controller
- `src/config.ts` — add `useNarration` flag, drop `useGeminiNarration` (Gemini text path is already gone from env-reorg work)
- `src/config.test.ts` — update tests for the renamed flag
- `.env-sample` — drop `USE_GEMINI_NARRATION`, add `USE_NARRATION`
- `README.md` — Configuration section: new env vars; new section "Narration setup" with Python + Chatterbox instructions
- `.gitignore` — add `media/audio/` so generated WAVs don't pollute git

**Deleted:**
- `src/gemini-tts.ts` (replaced by `src/tts.ts`)
- `src/web/tts.ts` entirely (TTSEngine, AudioCache, RenderQueue, AudioContext, AudioBufferSource tracking, pcmToWav, all of it — browser HTTP cache replaces AudioCache; the rest was streaming-PCM scaffolding that isn't needed)
- `src/web/tts.test.ts` entirely
- `audio-start`, `audio-chunk`, `audio-end` WS message types from `src/server.ts` and `src/web/app.tsx`

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User without Python can't run narration | Sidecar boot detects this and disables narration with a clear log message. Game still works. README documents the Python install. |
| First-turn audio lag from cold model load | Eager background load on Bun boot; warmup indicator on the toggle until ready. Most users won't perceive it because they spend the first few seconds reading the title screen. |
| Generated voice quality drift between Chatterbox versions | Reference voice WAVs are committed in repo. If Chatterbox bumps versions and outputs differ, regenerate via the committed `generate_voices.py` script. |
| GPU memory contention with LM Studio | Chatterbox Turbo is 350M params (~1.5GB VRAM). On a 16GB GPU shared with Nemotron-3-Nano (~10GB at Q3_K_L), there's ~4GB headroom. Should fit. Document the constraint in `tts_sidecar/README.md`. |
| WS audio-ready URL is dead by the time client fetches it | Files are written before the WS message is sent. Filesystem write is synchronous. No window for a race. |
| Server-side disk fills up with cached WAVs over months | Document a one-line cleanup command in README. Out of scope for an automated cleanup in this work. |
| Watermarking concern (PerTh) | Chatterbox embeds an inaudible watermark on every clip — that's its responsible-AI default. Mention in README so users know. Not removable, not configurable. Not a problem for a single-player game. |

## Out of scope explicitly

- LLM dispatcher work (Phase 2 of the broader simplification — Chatterbox sidecar foreshadows the worker pattern but doesn't fully implement it).
- Multi-language TTS via Chatterbox-Multilingual.
- User-uploaded voice clones.
- Per-character voice (different speakers in dialogue get different voices) — single narrator voice for now.
- A web UI for voice management beyond the existing voice picker.
- Cleanup CLI for cached audio files.
- Bundling Python or the Chatterbox model — user installs both, README walks them through.
